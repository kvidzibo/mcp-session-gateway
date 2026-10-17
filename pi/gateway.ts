import { fileURLToPath } from 'node:url';
import type { EntryRenderer, ExtensionAPI, ExtensionContext, SessionStartEvent, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { checkoutIdentity, withCheckoutLock } from '../src/checkout-lock.js';
import { gatewayCommands, gatewayEntries, gatewayTools } from './definitions.js';
import { readStartupAutoUpdate, updateBeforeLoad } from './startup-update.js';
import type { GatewayLifecycle } from './runtime.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const identityKey = Symbol.for('local-stdio-mcp-gateway.loaded-installations');
const state = process as NodeJS.Process & { [identityKey]?: Map<string, string> };

/** Register only dependency-free forwarding interfaces until the session actually starts. */
export default function gatewayExtension(pi: ExtensionAPI): void {
  pi.registerFlag('gateway-config', { type: 'string', description: 'Start a stdio gateway using this config file' });
  const tools = new Map<string, ToolDefinition['execute']>();
  const commands = new Map<string, Parameters<ExtensionAPI['registerCommand']>[1]>();
  const renderers = new Map<string, EntryRenderer>();
  for (const type of gatewayEntries) pi.registerEntryRenderer(type, (entry, options, theme) => ({
    render: (width) => renderers.get(type)?.(entry, options, theme)?.render(width) ?? [],
    invalidate() {}, // Recreate the real component on each render, including after lazy loading.
  }));
  for (const definition of Object.values(gatewayTools)) pi.registerTool({
    ...definition,
    execute: (...args) => {
      const tool = tools.get(definition.name);
      if (!tool) throw new Error('Gateway is not ready; check its startup error and restart Pi');
      return tool(...args);
    },
  });
  for (const [name, description] of Object.entries(gatewayCommands)) pi.registerCommand(name, {
    description,
    handler: async (args, ctx) => {
      await load(ctx);
      const command = commands.get(name);
      if (!command) { ctx.ui.notify('Gateway is not ready; check its startup error and restart Pi', 'warning'); return; }
      await command.handler(args, ctx);
    },
  });
  let initialized = false;
  let controller = new AbortController();
  let pending: Promise<void> | undefined;
  let starting: Promise<unknown> | undefined;
  const lifecycle: GatewayLifecycle = {};
  pi.on('session_start', async (event, ctx) => {
    if (controller.signal.aborted) controller = new AbortController();
    await load(ctx, event);
    if (controller.signal.aborted) return;
    const work = Promise.resolve(lifecycle.start?.(event, ctx));
    starting = work;
    try { await work; }
    finally { if (starting === work) starting = undefined; }
  });
  async function load(ctx: ExtensionContext, event?: SessionStartEvent): Promise<void> {
    if (initialized) return;
    if (pending) return pending;
    controller = new AbortController();
    const work = initialize(ctx, event);
    pending = work;
    try { await work; }
    finally { if (pending === work) pending = undefined; }
  }
  pi.on('session_shutdown', async (event, ctx) => {
    controller.abort();
    const stop = lifecycle.shutdown;
    // Cancel the runtime's own lifetime before awaiting its startup work.
    await stop?.(event, ctx);
    await Promise.allSettled([pending, starting]);
    if (!stop) await lifecycle.shutdown?.(event, ctx);
  });

  async function initialize(ctx: ExtensionContext, event?: SessionStartEvent): Promise<void> {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]);
    const config = pi.getFlag('gateway-config');
    let checked = false;
    let updateFailure: unknown;
    // A fresh process can update in a disposable worker before importing any runtime dependencies.
    // Reloads keep the old behavior: already-imported code must never adopt a new installation.
    if (event && !state[identityKey]?.has(root) && typeof config === 'string' && config) {
      try {
        if (await readStartupAutoUpdate(config)) {
          await updateBeforeLoad(root, signal, (stage) => ctx.ui.setStatus('gateway', `MCP · ${stage}`),
            (text, level) => ctx.ui.notify(text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' '), level));
          checked = true;
        }
      } catch (error) {
        signal.throwIfAborted();
        updateFailure = error;
        checked = true;
      } finally { ctx.ui.setStatus('gateway', undefined); }
    }
    await withCheckoutLock(root, signal, async () => {
      try {
        const identity = await checkoutIdentity(root);
        const loaded = state[identityKey]?.get(root);
        if (loaded !== undefined && loaded !== identity) throw new Error('Gateway installation changed. Restart Pi; /reload cannot replace already-loaded dependencies.');
        (state[identityKey] ??= new Map()).set(root, identity);
        const { default: register } = await import('./runtime.js');
        const checkUpdate: typeof import('./self-update.js').checkGatewayUpdate | undefined = checked ? async (...args) => {
          if (checked) { checked = false; if (updateFailure) throw updateFailure; return; }
          const { checkGatewayUpdate } = await import('./self-update.js');
          return checkGatewayUpdate(...args);
        } : undefined;
        const runtimePi: ExtensionAPI = {
          ...pi,
          registerFlag() {},
          registerTool: (tool) => { tools.set(tool.name, tool.execute as ToolDefinition['execute']); },
          registerCommand: (name, command) => { commands.set(name, command); },
          registerEntryRenderer: (type, renderer) => { renderers.set(type, renderer as EntryRenderer); },
        };
        signal.throwIfAborted();
        register(runtimePi, checkUpdate, identity, lifecycle);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'MODULE_NOT_FOUND' && code !== 'ERR_MODULE_NOT_FOUND') throw error;
        throw new Error(`Gateway dependencies are missing after an interrupted installation. After all gateway updates/builds finish, run npm ci --include=dev in ${root}, then start a fresh Pi with Auto update on to rebuild and validate. ${String(error)}`, { cause: error });
      }
    });
    signal.throwIfAborted();
    initialized = true;
  }
}
