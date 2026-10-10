import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  ToolListChangedNotificationSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { GatewayConfig, ServiceConfig } from './config.js';
import { ServiceTransport } from './service-transport.js';

const SESSION_META = 'local-stdio-mcp-gateway/sessionId';
const SERVICE_META = 'local-stdio-mcp-gateway/serviceId';

interface Service {
  config: ServiceConfig;
  client: Client;
  transport: ServiceTransport;
  tools: Tool[];
  refresh: Promise<void>;
  connected: boolean;
}

export class Gateway {
  readonly sessionId = randomUUID();
  onclose?: () => void;
  private readonly server = new Server(
    { name: 'local-stdio-mcp-gateway', version: '0.1.0' },
    { capabilities: { tools: { listChanged: true } } },
  );
  private readonly services: Service[] = [];
  private initialized = false;
  private closing?: Promise<void>;

  constructor(private readonly config: GatewayConfig) {
    this.server.oninitialized = () => { this.initialized = true; };
    this.server.onclose = () => {
      this.onclose?.();
      void this.close().catch((error: Error) => this.log(error.message));
    };
    this.server.onerror = (error) => this.log(error.message);
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'gateway__identity',
          description: 'Return the identity of this gateway run (not a persistent Pi conversation).',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        },
        ...this.services.filter((service) => service.connected).flatMap((service) =>
          service.tools.map((tool) => {
            // Task execution is not proxied by this gateway.
            const { execution: _execution, ...definition } = tool;
            return { ...definition, name: this.toolName(service.config.name, tool.name) };
          }),
        ),
      ],
    }));
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
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
          this.toolName(service.config.name, candidate.name) === request.params.name,
        );
        if (!tool) continue;
        const { progressToken, ...meta } = request.params._meta ?? {};
        return service.client.callTool({
          name: tool.name,
          arguments: request.params.arguments,
          _meta: {
            ...meta,
            [SESSION_META]: this.sessionId,
            [SERVICE_META]: service.config.name,
          },
        }, undefined, {
          signal: extra.signal,
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
      }
      throw new McpError(ErrorCode.InvalidParams, `Unknown or disconnected tool: ${request.params.name}`);
    });
  }

  private log(message: string): void {
    process.stderr.write(`[gateway ${this.sessionId}] ${message}\n`);
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
    do {
      const page = await service.client.listTools(cursor ? { cursor } : undefined, { timeout: this.config.timeoutMs });
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
    const client = new Client({ name: 'local-stdio-mcp-gateway', version: '0.1.0' });
    const transport = new ServiceTransport({
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: {
        ...config.env,
        MCP_GATEWAY_SESSION_ID: this.sessionId,
        MCP_GATEWAY_SERVICE_ID: config.name,
      },
    });
    const service: Service = { config, client, transport, tools: [], refresh: Promise.resolve(), connected: false };
    this.services.push(service);
    client.onerror = (error) => this.log(`Server ${config.name}: ${error.message}`);
    client.onclose = () => {
      service.connected = false;
      service.tools = [];
      void this.notifyToolsChanged().catch((error: Error) => this.log(error.message));
    };
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
    if (client.getServerCapabilities()?.tools) await this.queueRefresh(service);
  }

  async start(input: Readable = process.stdin): Promise<void> {
    // Settle all starts before cleanup, including services that succeed after a peer fails.
    const results = await Promise.allSettled(this.config.services.map((config) => this.startService(config)));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') {
      await this.close();
      throw failure.reason;
    }
    if (this.closing) return;
    await this.server.connect(new StdioServerTransport(input));
    this.log(`Started with ${this.services.length} service(s)`);
  }

  close(): Promise<void> {
    this.closing ??= Promise.resolve().then(async () => {
      this.initialized = false;
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
