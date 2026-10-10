import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats, { type FormatsPlugin } from 'ajv-formats';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema, type ElicitRequestParams, type ElicitResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { Type } from 'typebox';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { loadConfig } from '../src/config.js';
import { handleElicitation } from '../src/elicitation.js';

// Server data is untrusted terminal text, never terminal instructions.
const clean = (text: string) => text
  .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
  .slice(0, 20_000);
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
  let approvalQueue = Promise.resolve();

  async function close(): Promise<void> {
    if (closing) return closing;
    connected = false;
    lifetime.abort();
    closing = (async () => {
      try { await client?.close(); } finally { await transport?.close(); }
    })();
    return closing;
  }
  function connection(): Client {
    if (!connected || !client) throw new Error('Gateway disconnected; use --gateway-config <file> and /reload to reconnect');
    return client;
  }
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
    try {
      if (signal.aborted || uiBusy) return { action: 'cancel' };
      uiBusy = true;
      const choice = await ctx.ui.select(clean(params.message), ['Decline', 'Allow once', 'Cancel'], { signal, timeout });
      if (signal.aborted) return { action: 'cancel' };
      if (choice === 'Allow once') return { action: 'accept', content: { [key]: true } };
      return { action: choice === 'Decline' ? 'decline' : 'cancel' };
    } catch { return { action: 'cancel' }; }
    finally { uiBusy = false; release(); }
  }

  pi.on('session_start', async (_event, ctx) => {
    const configPath = pi.getFlag('gateway-config');
    if (typeof configPath !== 'string' || !configPath) return;
    if (connected) return;
    closing = undefined;
    lifetime = new AbortController();
    timeout = (await loadConfig(configPath)).timeoutMs;
    const current = new Client({ name: 'pi-gateway-adapter', version: '0.3.0' }, { capabilities: ctx.hasUI ? { elicitation: { form: {} } } : {} });
    client = current;
    current.onclose = () => { connected = false; lifetime.abort(); };
    if (ctx.hasUI) handleElicitation(current, (params, signal) => approve(params, AbortSignal.any([signal, lifetime.signal]), ctx));
    transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), '--config', configPath], cwd: ctx.cwd, env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), stderr: 'pipe' });
    // Gateway already owns a diagnostic file. Drain its stderr without feeding it to the model.
    transport.stderr?.on('data', () => {});
    try {
      await current.connect(transport, { timeout, signal: lifetime.signal });
      connected = true;
      await tools(lifetime.signal); // Wait for child startup before declaring success.
    } catch (error) { await close(); throw error; }
  });
  pi.on('session_shutdown', close);

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
      const result = CallToolResultSchema.parse(await connection().callTool({ name: params.name, arguments: params.arguments }, undefined, { signal, timeout }));
      const content = result.content.map((item) => item.type === 'text' || item.type === 'image' ? item : { type: 'text' as const, text: JSON.stringify(item) });
      if (!content.length && result.structuredContent) content.push({ type: 'text', text: JSON.stringify(result.structuredContent) });
      return { content, details: undefined, isError: Boolean(result.isError) };
    },
  });

  pi.registerCommand('gateway-panel', {
    description: 'Read a gateway resource privately; r refreshes, arrows scroll, Escape closes.',
    handler: async (args, ctx) => {
      if (ctx.mode !== 'tui') { ctx.ui.notify('The gateway panel requires TUI mode', 'error'); return; }
      if (uiBusy) { ctx.ui.notify('Finish the current gateway dialog first', 'warning'); return; }
      connection();
      uiBusy = true;
      try {
        let uri = args.trim();
        if (!uri) {
          const resources = await connection().listResources(undefined, { signal: lifetime.signal, timeout });
          if (!resources.resources.length) { ctx.ui.notify('No gateway resources', 'info'); return; }
          const labels = resources.resources.map((r, i) => `${i + 1}. ${clean(r.name)} — ${clean(r.uri)}`);
          const selected = await ctx.ui.select('Gateway resource', labels, { signal: lifetime.signal, timeout });
          if (!selected) return;
          uri = resources.resources[labels.indexOf(selected)]?.uri ?? '';
        }
        if (!uri) return;
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
            void connection().readResource({ uri }, { signal: AbortSignal.any([current.signal, lifetime.signal]), timeout }).then((result) => {
              if (!current.signal.aborted && !disposed) content = clean(result.contents.map((item) => 'text' in item ? item.text : '[non-text resource]').join('\n'));
            }).catch((cause: unknown) => {
              if (!current.signal.aborted && !disposed) error = clean(String(cause));
            }).finally(() => {
              if (!current.signal.aborted && !disposed) { loading = false; tui.requestRender(); }
            });
          };
          const disconnect = () => { controller.abort(); error = 'Gateway disconnected'; loading = false; tui.requestRender(); };
          lifetime.signal.addEventListener('abort', disconnect, { once: true });
          refresh();
          return {
            render(width: number) {
              const safeWidth = Math.max(1, width);
              const body = (loading ? 'Loading…' : error ? `Error: ${error}` : content || '(empty resource)').split('\n').flatMap((line) => wrapTextWithAnsi(line, safeWidth));
              const height = Math.max(1, Math.min(20, tui.terminal.rows - 8));
              maxOffset = Math.max(0, body.length - height);
              offset = Math.min(offset, maxOffset);
              return [theme.fg('accent', `Gateway resource: ${clean(uri)}`), ...body.slice(offset, offset + height), '', theme.fg('muted', '↑/↓ scroll   r refresh   Esc close')].map((line) => truncateToWidth(line, safeWidth));
            },
            handleInput(data: string) {
              if (matchesKey(data, Key.escape)) { controller.abort(); done(); }
              else if (data.toLowerCase() === 'r' && connected) refresh();
              else if (matchesKey(data, Key.up)) offset = Math.max(0, offset - 1);
              else if (matchesKey(data, Key.down)) offset = Math.min(maxOffset, offset + 1);
              tui.requestRender();
            },
            invalidate() {},
            dispose() { disposed = true; controller.abort(); lifetime.signal.removeEventListener('abort', disconnect); },
          };
        });
      } finally { uiBusy = false; }
    },
  });
}
