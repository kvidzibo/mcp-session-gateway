import { randomBytes, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  McpError,
  ToolListChangedNotificationSchema,
  type Tool,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js';
import type { GatewayConfig, ServiceConfig } from './config.js';
import { ServiceTransport } from './service-transport.js';
import { writeDiagnostic } from './diagnostics.js';
import { handleElicitation, trackRequests } from './elicitation.js';
import { authorize, validToken, SETTINGS_EXTENSION, SETTINGS_GET, SETTINGS_UPDATE, OPERATOR_EXTENSION, OPERATOR_LIST, OPERATOR_GET, OPERATOR_UPDATE, OperatorListSchema, OperatorGetSchema, OperatorUpdateSchema, SettingsCapabilitySchema, SettingsDocumentSchema } from './settings.js';
import { ActionSchema, ActionResultSchema, ChangedSchema } from './native-ui.js';

const SESSION_META = 'local-stdio-mcp-gateway/sessionId';
const SERVICE_META = 'local-stdio-mcp-gateway/serviceId';

interface Service {
  config: ServiceConfig;
  client: Client;
  transport: ServiceTransport;
  tools: Tool[];
  refresh: Promise<void>;
  connected: boolean;
  settingsToken?: string;
  settingsEnabled?: boolean;
  queue: Promise<void>;
  closed: AbortController;
  active?: { id: RequestId; signal: AbortSignal; tool: string };
}

function modelVisible(tool: Tool): boolean {
  const ui = tool._meta?.ui as { visibility?: string[] } | undefined;
  return !ui?.visibility || ui.visibility.includes('model');
}

export class Gateway {
  readonly sessionId = randomUUID();
  onclose?: () => void;
  private readonly server = new Server(
    { name: 'local-stdio-mcp-gateway', version: '0.5.0' },
    { capabilities: { tools: { listChanged: true }, resources: {}, experimental: { 'native-ui-v1': {} } } },
  );
  private readonly services: Service[] = [];
  private initialized = false;
  private ready: Promise<void> = Promise.resolve();
  private resolveReady!: () => void;
  private resolveInitialized!: () => void;
  private closing?: Promise<void>;
  private requests?: ReturnType<typeof trackRequests>;

  constructor(private readonly config: GatewayConfig, private readonly operatorToken?: string) {
    if (operatorToken && !validToken(operatorToken)) throw new Error('Invalid gateway operator token');
    if (operatorToken) {
      this.server.registerCapabilities({ experimental: { [OPERATOR_EXTENSION]: { version: 1, audience: 'operator', authorization: 'token' } } });
      this.server.setRequestHandler(OperatorListSchema, async (request, extra) => this.withRequest(extra, async () => {
        authorize(request.params.token, this.operatorToken);
        await this.ready;
        return { services: this.services.filter((s) => s.connected && s.settingsEnabled).map((s) => ({ name: s.config.name })) };
      }));
      this.server.setRequestHandler(OperatorGetSchema, async (request, extra) => this.withRequest(extra, async () => {
        authorize(request.params.token, this.operatorToken);
        await this.ready;
        const service = this.settingsService(request.params.service);
        return this.withService(service, extra.signal, () => service.client.request({ method: SETTINGS_GET, params: { token: service.settingsToken } }, SettingsDocumentSchema, { signal: extra.signal, timeout: this.config.timeoutMs }));
      }));
      this.server.setRequestHandler(OperatorUpdateSchema, async (request, extra) => this.withRequest(extra, async () => {
        authorize(request.params.token, this.operatorToken);
        await this.ready;
        const service = this.settingsService(request.params.service);
        const { revision, patch } = request.params;
        return this.withService(service, extra.signal, () => service.client.request({ method: SETTINGS_UPDATE, params: { token: service.settingsToken, revision, patch } }, SettingsDocumentSchema, { signal: extra.signal, timeout: this.config.timeoutMs }));
      }));
    }
    this.server.oninitialized = () => { this.initialized = true; this.resolveInitialized?.(); };
    this.server.onclose = () => {
      this.resolveInitialized?.();
      if (!this.closing) this.onclose?.();
      void this.close().catch((error: Error) => this.log(error.message));
    };
    this.server.onerror = (error) => this.log(error.message);
    this.server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => this.withRequest(extra, async () => {
      await this.ready;
      return { tools: [
        {
          name: 'gateway__identity',
          description: 'Return the identity of this gateway run (not a persistent Pi conversation).',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
        ...this.services.filter((service) => service.connected).flatMap((service) =>
          service.tools.filter(modelVisible).map((tool) => {
            const { execution: _execution, ...definition } = tool;
            return { ...definition, name: this.toolName(service.config.name, tool.name) };
          }),
        ),
      ] };
    }));
    this.server.setRequestHandler(ListResourcesRequestSchema, async (_request, extra) => this.withRequest(extra, async () => {
      await this.ready;
      const resources = [];
      for (const service of this.services.filter((item) => item.connected && item.client.getServerCapabilities()?.resources)) {
        let cursor: string | undefined;
        const seen = new Set<string>();
        let pages = 0;
        do {
          if (++pages > 1000) throw new Error(`Too many resource pages from ${service.config.name}`);
          const page = await this.withService(service, extra.signal, () => service.client.listResources(cursor ? { cursor } : undefined, { timeout: this.config.timeoutMs, signal: extra.signal }));
          for (const resource of page.resources) resources.push({ ...resource, uri: this.resourceUri(service.config.name, resource.uri) });
          cursor = page.nextCursor;
          if (cursor !== undefined && (!cursor || seen.has(cursor))) throw new Error(`Invalid resource cursor from ${service.config.name}`);
          if (cursor) seen.add(cursor);
        } while (cursor !== undefined);
      }
      return { resources };
    }));
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => this.withRequest(extra, async () => {
      await this.ready;
      const parsed = this.parseResourceUri(request.params.uri);
      const service = this.services.find((item) => item.config.name === parsed.service && item.connected);
      if (!service) throw new McpError(ErrorCode.InvalidParams, 'Unknown or disconnected resource service');
      const { progressToken: _progress, ...meta } = request.params._meta ?? {};
      const result = await this.withService(service, extra.signal, () => service.client.readResource({ uri: parsed.uri, _meta: { ...meta, [SESSION_META]: this.sessionId, [SERVICE_META]: parsed.service } }, { timeout: this.config.timeoutMs, signal: extra.signal }));
      return { ...result, contents: result.contents.map((content) => ({ ...content, uri: this.resourceUri(parsed.service, content.uri) })) };
    }));
    this.server.setRequestHandler(ActionSchema, async (request, extra) => this.withRequest(extra, async () => {
      await this.ready;
      const parsed = this.parseResourceUri(request.params.uri);
      const service = this.services.find((item) => item.config.name === parsed.service && item.connected);
      if (!service?.client.getServerCapabilities()?.experimental?.['native-ui-v1']) throw new McpError(ErrorCode.InvalidParams, 'Service does not support native UI');
      return this.withService(service, extra.signal, () => service.client.request({
        method: 'native-ui/action', params: { ...request.params, uri: parsed.uri,
          _meta: { ...request.params._meta, [SESSION_META]: this.sessionId, [SERVICE_META]: parsed.service } },
      }, ActionResultSchema, { signal: extra.signal, timeout: this.config.timeoutMs }));
    }));
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => this.withRequest(extra, async () => {
      await this.ready;
      if (request.params.name === 'gateway__identity') {
        const identity = { sessionId: this.sessionId };
        return {
          content: [{ type: 'text', text: JSON.stringify(identity) }],
          structuredContent: identity,
        };
      }
      if (request.params.task) throw new McpError(ErrorCode.InvalidParams, 'Task execution is not supported');
      for (const service of this.services) {
        if (!service.connected) continue;
        const tool = service.tools.find((candidate) =>
          this.toolName(service.config.name, candidate.name) === request.params.name && modelVisible(candidate),
        );
        if (!tool) continue;
        const { progressToken, ...meta } = request.params._meta ?? {};
        return this.withService(service, extra.signal, async () => {
          const finished = new AbortController();
          const signal = AbortSignal.any([extra.signal, finished.signal, service.closed.signal]);
          service.active = { id: extra.requestId, signal, tool: request.params.name };
          try {
            return await service.client.callTool({
              name: tool.name,
              arguments: request.params.arguments,
              _meta: {
                ...meta,
                [SESSION_META]: this.sessionId,
                [SERVICE_META]: service.config.name,
              },
            }, undefined, {
              signal,
              timeout: this.config.timeoutMs,
              ...(progressToken !== undefined ? {
                onprogress: (progress) => {
                  void extra.sendNotification({
                    method: 'notifications/progress',
                    params: { ...progress, progressToken },
                  }).catch((error: Error) => this.log(error.message));
                },
              } : {}),
            });
          } finally {
            finished.abort();
            service.active = undefined;
          }
        });
      }
      throw new McpError(ErrorCode.InvalidParams, `Unknown or disconnected tool: ${request.params.name}`);
    }));
  }

  private settingsService(name: string): Service {
    const service = this.services.find((s) => s.config.name === name && s.connected && s.settingsEnabled);
    if (!service) throw new McpError(ErrorCode.InvalidParams, 'Settings unavailable for this service');
    return service;
  }

  private log(message: string): void {
    writeDiagnostic(`[gateway ${this.sessionId}] ${message}\n`);
  }

  private async withRequest<T>(extra: { requestId: RequestId; signal: AbortSignal }, run: () => Promise<T>): Promise<T> {
    extra.signal = this.requests?.signal(extra.requestId, extra.signal) ?? extra.signal;
    try {
      extra.signal.throwIfAborted();
      return await run();
    } finally { this.requests?.finish(extra.requestId); }
  }

  // Stdio has no wire-level parent request ID. Serializing service requests
  // lets ordinary MCP services elicit without custom correlation metadata.
  private async withService<T>(service: Service, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    const previous = service.queue;
    let release!: () => void;
    service.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    let started = false;
    try {
      signal?.throwIfAborted();
      if (!service.connected || service.closed.signal.aborted) throw new McpError(ErrorCode.ConnectionClosed, 'Service disconnected');
      started = true;
      return await run();
    } catch (error) {
      // Any cancelled request may still be running downstream. Retire before
      // releasing the queue so its late elicitation cannot attach to a tool.
      if (started && (signal?.aborted || (error instanceof McpError && error.code === ErrorCode.RequestTimeout))) {
        service.connected = false;
        service.closed.abort();
        service.tools = [];
        try { await service.client.close(); } finally { await service.transport.close(); }
      }
      throw error;
    } finally { release(); }
  }

  private resourceUri(service: string, uri: string): string {
    return `gateway-resource://${service}/${encodeURIComponent(uri)}`;
  }

  private parseResourceUri(value: string): { service: string; uri: string } {
    const match = /^gateway-resource:\/\/([a-z][a-z0-9-]*)\/(.+)$/.exec(value);
    if (!match) throw new McpError(ErrorCode.InvalidParams, 'Invalid gateway resource URI');
    let uri: string;
    try { uri = decodeURIComponent(match[2]); } catch { throw new McpError(ErrorCode.InvalidParams, 'Invalid gateway resource URI'); }
    return { service: match[1], uri };
  }

  private toolName(service: string, tool: string): string {
    const name = `${service}__${tool}`;
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) {
      throw new Error(`Server ${service} has an invalid or overlong namespaced tool name`);
    }
    return name;
  }

  private async notifyToolsChanged(): Promise<void> {
    if (this.initialized && !this.closing) await this.server.sendToolListChanged();
  }

  private async refreshTools(service: Service): Promise<void> {
    const tools: Tool[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      if (++pages > 1000) throw new Error(`Too many tool pages from ${service.config.name}`);
      const page = await this.withService(service, undefined, () => service.client.listTools(cursor ? { cursor } : undefined, { timeout: this.config.timeoutMs }));
      for (const tool of page.tools) {
        this.toolName(service.config.name, tool.name);
        if (names.has(tool.name)) throw new Error(`Server ${service.config.name} returned duplicate tools`);
        if (tool.execution?.taskSupport === 'required') continue;
        names.add(tool.name);
        tools.push(tool);
      }
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (!cursor || cursors.has(cursor)) throw new Error(`Server ${service.config.name} returned an invalid pagination cursor`);
        cursors.add(cursor);
      }
    } while (cursor !== undefined);
    if (service.connected && !this.closing) service.tools = tools;
  }

  private queueRefresh(service: Service): Promise<void> {
    service.refresh = service.refresh.catch(() => {}).then(() => this.refreshTools(service));
    return service.refresh;
  }

  private async startService(config: ServiceConfig): Promise<void> {
    const supportsForms = Boolean(this.server.getClientCapabilities()?.elicitation?.form);
    const client = new Client({ name: 'local-stdio-mcp-gateway', version: '0.5.0' }, { capabilities: supportsForms ? { elicitation: { form: {} } } : {} });
    const settingsToken = this.operatorToken && config.settings ? randomBytes(32).toString('base64url') : undefined;
    const env = { ...config.env };
    // The upstream token is never inherited by children; configured child tokens are overridden.
    delete env.MCP_GATEWAY_SETTINGS_TOKEN;
    if (config.settings) delete env[config.settings.tokenEnv];
    if (settingsToken && config.settings) env[config.settings.tokenEnv] = settingsToken;
    const transport = new ServiceTransport({
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: {
        ...env,
        MCP_GATEWAY_SESSION_ID: this.sessionId,
        MCP_GATEWAY_SERVICE_ID: config.name,
      },
    });
    const service: Service = { config, client, transport, settingsToken, tools: [], refresh: Promise.resolve(), connected: false, queue: Promise.resolve(), closed: new AbortController() };
    if (supportsForms) handleElicitation(client, transport, async (params, elicitationSignal) => {
      const active = service.active;
      if (!active || active.signal.aborted || params.mode === 'url') return { action: 'cancel' };
      try {
        const result = await this.server.elicitInput({
          mode: 'form',
          message: `[${service.config.name}] ${active.tool}: ${params.message}`,
          requestedSchema: params.requestedSchema,
          _meta: { ...params._meta, [SERVICE_META]: service.config.name, [SESSION_META]: this.sessionId },
        }, { signal: AbortSignal.any([elicitationSignal, active.signal]), relatedRequestId: active.id, timeout: this.config.timeoutMs });
        return active.signal.aborted ? { action: 'cancel' } : result;
      } catch { return { action: 'cancel' }; }
    });
    this.services.push(service);
    client.onerror = (error) => this.log(`Server ${config.name}: ${error.message}`);
    client.onclose = () => {
      service.connected = false;
      service.closed.abort();
      service.tools = [];
      void this.notifyToolsChanged().catch((error: Error) => this.log(error.message));
      if (this.initialized && !this.closing) void this.server.notification({ method: 'notifications/native-ui/invalidated', params: { service: config.name } }).catch((error: Error) => this.log(error.message));
    };
    client.setNotificationHandler(ChangedSchema, async ({ params }) => {
      if (service.connected && this.initialized && !this.closing) {
        await this.server.notification({ method: 'notifications/native-ui/changed', params: { uri: this.resourceUri(config.name, params.uri) } });
      }
    });
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      try {
        await this.queueRefresh(service);
        await this.notifyToolsChanged();
      } catch (error) {
        // A failed update cannot leave a stale catalogue of callable tools.
        service.tools = [];
        this.log(`Server ${config.name}: tool refresh failed`);
        await this.notifyToolsChanged();
      }
    });
    await client.connect(transport, { timeout: this.config.timeoutMs });
    if (this.closing) return;
    service.connected = true;
    const capabilities = client.getServerCapabilities();
    const extensions = (capabilities as { extensions?: Record<string, unknown> } | undefined)?.extensions;
    service.settingsEnabled = Boolean(settingsToken && SettingsCapabilitySchema.safeParse(extensions?.[SETTINGS_EXTENSION] ?? capabilities?.experimental?.[SETTINGS_EXTENSION]).success);
    if (client.getServerCapabilities()?.tools) await this.queueRefresh(service);
  }

  async start(input: Readable = process.stdin): Promise<void> {
    this.ready = new Promise<void>((resolve) => { this.resolveReady = resolve; });
    const initialized = new Promise<void>((resolve) => { this.resolveInitialized = resolve; });
    const transport = new StdioServerTransport(input);
    this.requests = trackRequests(transport, ['tools/list', 'tools/call', 'resources/list', 'resources/read', OPERATOR_LIST, OPERATOR_GET, OPERATOR_UPDATE, 'native-ui/action']);
    await this.server.connect(transport);
    // Learn upstream elicitation capability before children initialize.
    await initialized;
    if (this.closing) return;
    const results = await Promise.allSettled(this.config.services.map((config) => this.startService(config)));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') {
      this.resolveReady();
      await this.close();
      throw failure.reason;
    }
    this.resolveReady();
    if (this.closing) return;
    this.log(`Started with ${this.services.length} service(s)`);
  }

  close(): Promise<void> {
    this.closing ??= Promise.resolve().then(async () => {
      this.resolveReady?.();
      this.resolveInitialized?.();
      this.initialized = false;
      for (const service of this.services) service.closed.abort();
      const results = await Promise.allSettled([
        this.server.close(),
        ...this.services.map(async (service) => {
          try {
            await service.client.close();
          } finally {
            await service.transport.close();
          }
        }),
      ]);
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    });
    return this.closing;
  }
}
