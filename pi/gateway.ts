import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats, { type FormatsPlugin } from 'ajv-formats';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema, type ElicitRequestParams, type ElicitResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { Type } from 'typebox';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { gatewayIdentity } from '../src/identity.js';
import { loadConfig } from '../src/config.js';
import { NativeUI } from './native-ui.js';
import { ChangedSchema, InvalidatedSchema } from '../src/native-ui.js';
import { resolve } from 'node:path';
import { handleElicitation } from '../src/elicitation.js';
import { OPERATOR_ENV, OPERATOR_LIST, OPERATOR_GET, OPERATOR_UPDATE, OperatorServicesSchema, SettingsDocumentSchema } from '../src/settings.js';
import { clean, confirmSettings, editSettings } from './settings.js';
import { LiveJobs } from './live-jobs.js';
import { openManager } from './manager.js';
import { managePackages } from './package-actions.js';
import { GatewayMenu } from './menu.js';
const modelVisible = (tool: Tool) => {
  const ui = tool._meta?.ui as { visibility?: string[] } | undefined;
  return !ui?.visibility || ui.visibility.includes('model');
};

export default function gatewayExtension(pi: ExtensionAPI): void {
  pi.registerFlag('gateway-config', { type: 'string', description: 'Start a stdio gateway using this config file' });
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  let connected = false;
  let timeout = 30_000;
  let lifetime = new AbortController();
  let closing: Promise<void> | undefined;
  let uiBusy = false;
  let shuttingDown = false;
  let managerController: AbortController | undefined;
  let managerWork: Promise<void> | undefined;
  let launchedServices: string[] | undefined;
  let approvalQueue = Promise.resolve();
  let operatorToken: string | undefined;
  const native = new NativeUI(pi, connection, () => ({ signal: lifetime.signal, timeout }));
  let liveJobs: LiveJobs | undefined;

  async function close(preserveMenu = false): Promise<void> {
    if (!preserveMenu) managerController?.abort();
    if (closing) return closing;
    connected = false;
    liveJobs?.stop();
    liveJobs = undefined;
    lifetime.abort();
    operatorToken = undefined;
    native.stop();
    const pendingManager = managerWork;
    closing = (async () => {
      const results = await Promise.allSettled([
        pendingManager,
        (async () => { try { await client?.close(); } finally { await transport?.close(); } })(),
      ]);
      // Aborted package operations report through their own UI, but cleanup must finish.
      if (results[1].status === 'rejected') throw results[1].reason;
    })();
    return closing;
  }
  function connection(): Client {
    if (!connected || !client) throw new Error('Gateway disconnected; use --gateway-config <file> and /reload to reconnect');
    return client;
  }
  const observationOptions = () => ({ signal: lifetime.signal, timeout, resetTimeoutOnProgress: true, onprogress: () => {} });
  async function tools(signal?: AbortSignal): Promise<Tool[]> {
    const result = await connection().listTools(undefined, { signal, timeout });
    return result.tools.filter(modelVisible);
  }
  async function approve(params: ElicitRequestParams, signal: AbortSignal, ctx: ExtensionContext): Promise<ElicitResult> {
    if (!ctx.hasUI || params.mode === 'url') return { action: 'cancel' };
    const schema = params.requestedSchema;
    const keys = Object.keys(schema.properties ?? {});
    const key = keys[0];
    if (keys.length !== 1 || schema.required?.length !== 1 || schema.required[0] !== key || schema.properties[key].type !== 'boolean') return { action: 'cancel' };
    // Only boolean confirmations; unsupported constraints or fields are not forms.
    if (Object.keys(schema).some((k) => !['type', 'properties', 'required', 'additionalProperties'].includes(k)) ||
        Object.keys(schema.properties[key]).some((k) => !['type', 'title', 'description', 'default'].includes(k))) return { action: 'cancel' };
    const previous = approvalQueue;
    let release!: () => void;
    approvalQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    let acquired = false;
    try {
      if (signal.aborted || uiBusy) return { action: 'cancel' };
      uiBusy = true;
      acquired = true;
      const choice = await ctx.ui.select(clean(params.message), ['Decline', 'Allow once', 'Cancel'], { signal, timeout });
      if (signal.aborted) return { action: 'cancel' };
      if (choice === 'Allow once') return { action: 'accept', content: { [key]: true } };
      return { action: choice === 'Decline' ? 'decline' : 'cancel' };
    } catch { return { action: 'cancel' }; }
    finally { if (acquired) uiBusy = false; release(); }
  }

  async function start(ctx: ExtensionContext, preserveMenu = false): Promise<void> {
    if (shuttingDown) return;
    const configPath = pi.getFlag('gateway-config');
    if (typeof configPath !== 'string' || !configPath) return;
    if (connected) { await native.start(ctx, resolve(configPath)); return; }
    closing = undefined;
    lifetime = new AbortController();
    timeout = (await loadConfig(configPath)).timeoutMs;
    if (shuttingDown) return;
    const current = new Client({ name: 'pi-gateway-adapter', version: gatewayIdentity.version }, { capabilities: ctx.hasUI ? { elicitation: { form: {} } } : {} });
    client = current;
    current.onclose = () => { if (client === current) { connected = false; liveJobs?.disconnect(); lifetime.abort(); native.stop(); } };
    current.setNotificationHandler(ChangedSchema, async ({ params }) => { await native.refresh(params.uri); });
    current.setNotificationHandler(InvalidatedSchema, ({ params }) => { native.invalidate(params.service); });
    operatorToken = ctx.mode === 'tui' && ctx.hasUI ? randomBytes(32).toString('base64url') : undefined;
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    delete env[OPERATOR_ENV];
    if (operatorToken) env[OPERATOR_ENV] = operatorToken;
    transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), '--config', configPath], cwd: ctx.cwd, env, stderr: 'pipe' });
    if (ctx.hasUI) handleElicitation(current, transport, (params, signal) => approve(params, AbortSignal.any([signal, lifetime.signal]), ctx));
    // Gateway already owns a diagnostic file. Drain its stderr without feeding it to the model.
    transport.stderr?.on('data', () => {});
    try {
      await current.connect(transport, { timeout, signal: lifetime.signal });
      const inventory = current.getServerCapabilities()?.experimental?.['gateway-services-v1'] as { names?: unknown } | undefined;
      launchedServices = Array.isArray(inventory?.names) && inventory.names.every((name) => typeof name === 'string' && /^[a-z][a-z0-9-]*$/.test(name)) ? inventory.names : undefined;
      connected = true;
      await tools(lifetime.signal); // Wait for child startup before declaring success.
      await native.start(ctx, resolve(configPath));
      if (ctx.mode === 'tui' && ctx.hasUI) {
        liveJobs = new LiveJobs(current, ctx, timeout);
        await liveJobs.start();
      }
    } catch (error) { await close(preserveMenu); throw error; }
  }
  pi.on('session_start', async (_event, ctx) => { shuttingDown = false; await start(ctx); });
  pi.on('session_shutdown', async () => { shuttingDown = true; await close(); });
  pi.on('session_tree', async (_event, ctx) => {
    if (connected) await native.start(ctx, resolve(String(pi.getFlag('gateway-config'))));
  });
  pi.registerCommand('gateway', {
    description: 'Open gateway services, packages and connection menus. No model turn.',
    handler: async (_args, ctx) => {
      if (!ctx.hasUI || ctx.mode !== 'tui') { ctx.ui.notify('Gateway menus require TUI mode', 'warning'); return; }
      if (uiBusy) { ctx.ui.notify('Finish the current gateway dialog first', 'warning'); return; }
      const configPath = pi.getFlag('gateway-config');
      if (typeof configPath !== 'string' || !configPath) { ctx.ui.notify('Use --gateway-config <file> to select a configuration', 'warning'); return; }
      uiBusy = true;
      const controller = new AbortController();
      managerController = controller;
      const signal = controller.signal;
      const menu = new GatewayMenu(ctx, signal);
      try {
        while (!signal.aborted) {
          const action = await menu.choose(['Gateway'], connected ? 'Connected · one gateway for this Pi session' : 'Disconnected · packages and recovery are still available', [
            { id: 'services', label: 'Services', description: 'Choose a service to open its app, edit settings or read resources.', disabled: !connected },
            { id: 'packages', label: 'Packages', description: 'Inspect versions, prepare updates, activate or roll back. Running services stay unchanged.' },
            { id: 'connection', label: 'Connection', description: 'Inspect connection details and explicitly restart all services in this session.' },
          ]);
          if (!action) break;
          try {
            if (action === 'services') {
              while (!signal.aborted && connected) {
                const config = await loadConfig(configPath);
                const names = [...new Set([...config.services.map((s) => s.name), ...(launchedServices ?? [])])];
                const service = await menu.choose(['Gateway', 'Services'], 'Choose a service · listed does not mean running',
                  names.map((name) => ({ id: name, label: name, description: 'Open this service’s app, settings and resources. Listed does not mean running.' })));
                if (!service) break;
                while (!signal.aborted && connected) {
                  const options = { signal: lifetime.signal, timeout };
                  let editable = false, settingsError = '';
                  try {
                    const settings = operatorToken ? await connection().request({ method: OPERATOR_LIST, params: { token: operatorToken } }, OperatorServicesSchema, options) : { services: [] };
                    editable = settings.services.some((s) => s.name === service);
                  } catch (error) { settingsError = clean(`Settings discovery failed: ${String(error)}`); }
                  const app = native.has(service);
                  const selected = await menu.choose(['Gateway', 'Services', service], 'Available service features', [
                    { id: 'app', label: 'Open app', description: app ? 'Open the service-provided interactive menu.' : 'This service has no available native app.', disabled: !app },
                    { id: 'settings', label: 'Settings', description: editable ? 'Edit a draft; review and confirm before saving.' : settingsError || 'Settings are not enabled or advertised by this service.', disabled: !editable },
                    { id: 'resources', label: 'Resources', description: 'Browse read-only service data privately, without sending it to the model.' },
                  ]);
                  if (!selected) break;
                  if (selected === 'app') await native.open(service, ctx);
                  if (selected === 'settings') await openSettings(service, ctx);
                  if (selected === 'resources') {
                    while (!signal.aborted && connected) {
                      try {
                        // Discover lazily: an unrelated child's resource failure must
                        // never prevent opening this service's app or settings.
                        const available = (await connection().listResources(undefined, observationOptions())).resources.filter((r) => new URL(r.uri).hostname === service);
                        const uri = await menu.choose(['Gateway', 'Services', service, 'Resources'], available.length ? 'Read-only · contents are not added to the conversation' : 'No resources advertised by this service',
                          available.map((r) => ({ id: r.uri, label: r.name, description: r.uri })));
                        if (!uri) break;
                        await openResource(uri, ctx, signal);
                      } catch (error) {
                        if (!signal.aborted) ctx.ui.notify(clean(`Resources unavailable: ${String(error)}`), 'error');
                        break;
                      }
                    }
                  }
                }
              }
            } else if (action === 'packages') {
              while (!signal.aborted) {
                const config = await loadConfig(configPath);
                const selected = await menu.choose(['Gateway', 'Packages'], 'Preparation → activation → restart are separate decisions', [
                  { id: 'status', label: 'Installed versions', description: 'Read local package metadata only. Versions describe installations, not running processes.' },
                  { id: 'check', label: 'Check for updates', description: 'Contact public package sources to compare versions. Nothing is installed.', disabled: !config.packages.length },
                  { id: 'manage', label: 'Manage releases', description: 'Choose a managed package to prepare, activate, roll back or view its build log.', disabled: !config.packages.some((pkg) => pkg.managed) },
                ]);
                if (!selected) break;
                if (selected === 'manage') {
                  const work = managePackages(ctx, config, signal, menu);
                  managerWork = work;
                  try { await work; } finally { if (managerWork === work) managerWork = undefined; }
                } else await openManager(ctx, config, signal, selected === 'check');
              }
            } else {
              while (!signal.aborted) {
                const selected = await menu.choose(['Gateway', 'Connection'], connected ? 'Connected · restart affects this session only' : 'Disconnected · no automatic retry', [
                  { id: 'details', label: 'Connection details', description: 'Show the configuration path and the previous launch’s service names.' },
                  { id: 'restart', label: 'Restart gateway services…', description: 'Stops ALL services here and cancels their active/queued jobs. Requires a separate confirmation.' },
                ]);
                if (!selected) break;
                if (selected === 'details') {
                  await menu.info(['Gateway', 'Connection', 'Details'],
                    `${connected ? 'Connected' : 'Disconnected'}\n\nConfiguration\n${configPath}\n\nLast launch (not a health check)\n${launchedServices?.join('\n') || 'No runtime inventory available.'}\n\nPackage activation changes future launches. Restarting here affects only this Pi session.`);
                } else {
                  const config = await loadConfig(configPath);
                  if (connected && !launchedServices) { ctx.ui.notify('Runtime service inventory unavailable; build/reload the matching gateway before using managed restart', 'warning'); continue; }
                  if (!ctx.isIdle()) { ctx.ui.notify('Wait for the current agent turn to finish before restarting', 'warning'); continue; }
                  const preview = `Stop ALL services from this gateway's launch snapshot (some may already be stopped):\n${(launchedServices ?? []).map((name) => `- ${name}`).join('\n') || '(none known)'}\n\nConfigured for NEW launches (unactivated packages stay stopped):\n${config.services.map((service) => `- ${service.name}`).join('\n')}\n\nThis CANCELS any active or queued background jobs. Job count is unknown; finish work first or decline.\n\nOther Pi sessions are not restarted. New processes use the active package versions/configuration at startup; another session may change activation. The gateway run ID changes; saved conversation selection is restored.\n\nA startup failure leaves this gateway disconnected. Roll back and retry explicitly; there is no automatic restart or fallback.`;
                  if (!await confirmSettings(ctx, preview, { signal, timeout: 300_000, title: 'Restart gateway services?', actionLabel: 'stop and restart' }) || signal.aborted) continue;
                  if (!ctx.isIdle()) { ctx.ui.notify('Agent became busy; restart was cancelled', 'warning'); continue; }
                  await close(true);
                  if (!shuttingDown) { await start(ctx, true); ctx.ui.notify('Gateway services restarted', 'info'); }
                }
              }
            }
          } catch (error) { if (!signal.aborted) ctx.ui.notify(clean(`Gateway: ${String(error)}`), 'error'); }
        }
      } finally { if (managerController === controller) managerController = undefined; uiBusy = false; }
    },
  });

  pi.registerTool({
    name: 'gateway_tools', label: 'Gateway tools', description: 'Discover local gateway tools and their input schemas.', parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      const list = (await tools(signal)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
      return { content: [{ type: 'text', text: JSON.stringify(list) }], details: undefined };
    },
  });
  pi.registerTool({
    name: 'gateway_call', label: 'Gateway call', description: 'Call a local gateway tool; use gateway_tools to discover names and schemas. Required confirmations go directly to the user.',
    parameters: Type.Object({ name: Type.String(), arguments: Type.Record(Type.String(), Type.Unknown()) }),
    async execute(_id, params, signal) {
      const tool = (await tools(signal)).find(({ name }) => name === params.name);
      if (!tool) throw new Error(`Unknown or app-only gateway tool: ${params.name}`);
      // Fresh validator avoids stale/colliding $id registrations after discovery.
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      (addFormats as unknown as FormatsPlugin)(ajv);
      const valid = ajv.compile(tool.inputSchema);
      if (!valid(params.arguments)) throw new Error(`Invalid arguments: ${ajv.errorsText(valid.errors)}`);
      const service = params.name.split('__')[0];
      const result = CallToolResultSchema.parse(await connection().callTool({ name: params.name, arguments: params.arguments, _meta: native.meta(service) }, undefined, { signal, timeout }));
      await native.refreshService(service);
      const content = result.content.map((item) => item.type === 'text' || item.type === 'image' ? item : { type: 'text' as const, text: JSON.stringify(item) });
      if (!content.length && result.structuredContent) content.push({ type: 'text', text: JSON.stringify(result.structuredContent) });
      return { content, details: undefined, isError: Boolean(result.isError) };
    },
  });

  async function openSettings(service: string, ctx: ExtensionContext): Promise<void> {
    const current = connection();
    const token = operatorToken;
    if (!token) { ctx.ui.notify('Settings unavailable; reconnect the gateway', 'warning'); return; }
    const signal = lifetime.signal;
    const options = { signal, timeout };
    const document = await current.request({ method: OPERATOR_GET, params: { token, service } }, SettingsDocumentSchema, options);
    await editSettings(ctx, document, (revision, patch) =>
      current.request({ method: OPERATOR_UPDATE, params: { token, service, revision, patch } }, SettingsDocumentSchema, options), signal, timeout);
  }

  async function openResource(uri: string, ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await ctx.ui.custom<void>((tui, theme, _keys, done) => {
      let controller = new AbortController();
      let content = '';
      let error = '';
      let loading = true;
      let offset = 0;
      let maxOffset = 0;
      let disposed = false;
      const refresh = () => {
        controller.abort();
        controller = new AbortController();
        const current = controller;
        loading = true; error = ''; offset = 0;
        tui.requestRender();
        void connection().readResource({ uri }, { ...observationOptions(), signal: AbortSignal.any([current.signal, lifetime.signal]) }).then((result) => {
          if (!current.signal.aborted && !disposed) content = clean(result.contents.map((item) => 'text' in item ? item.text : '[non-text resource]').join('\n'));
        }).catch((cause: unknown) => {
          if (!current.signal.aborted && !disposed) error = clean(String(cause));
        }).finally(() => {
          if (!current.signal.aborted && !disposed) { loading = false; tui.requestRender(); }
        });
      };
      const disconnect = () => { controller.abort(); error = 'Gateway disconnected'; loading = false; tui.requestRender(); };
      const back = () => done();
      signal.addEventListener('abort', back, { once: true });
      lifetime.signal.addEventListener('abort', disconnect, { once: true });
      refresh();
      return {
        render(width: number) {
          const safeWidth = Math.max(1, width);
          const body = (loading ? 'Loading…' : error ? `Error: ${error}` : content || '(empty resource)').split('\n').flatMap((line) => wrapTextWithAnsi(line, safeWidth));
          const height = Math.max(1, Math.min(20, tui.terminal.rows - 8));
          maxOffset = Math.max(0, body.length - height);
          offset = Math.min(offset, maxOffset);
          return [theme.fg('accent', `Gateway resource: ${clean(uri)}`), ...body.slice(offset, offset + height), '', theme.fg('muted', '↑/↓ scroll   r refresh   Esc back')].map((line) => truncateToWidth(line, safeWidth));
        },
        handleInput(data: string) {
          if (matchesKey(data, Key.escape)) { controller.abort(); done(); }
          else if (data.toLowerCase() === 'r' && connected) refresh();
          else if (matchesKey(data, Key.up)) offset = Math.max(0, offset - 1);
          else if (matchesKey(data, Key.down)) offset = Math.min(maxOffset, offset + 1);
          tui.requestRender();
        },
        invalidate() {},
        dispose() { disposed = true; controller.abort(); signal.removeEventListener('abort', back); lifetime.signal.removeEventListener('abort', disconnect); },
      };
    }, { overlay: true, overlayOptions: { width: '100%', anchor: 'center', margin: 0 } });
  }
}
