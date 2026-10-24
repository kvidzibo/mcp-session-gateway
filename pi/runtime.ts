import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { compileSchema } from '../src/validation.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema, type ElicitRequestParams, type ElicitResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { gatewayCommands, gatewayTools } from './definitions.js';
import { gatewayCallRenderers } from './tool-renderers.js';
import type { ExtensionAPI, ExtensionContext, ExtensionHandler, SessionStartEvent, SessionShutdownEvent } from '@earendil-works/pi-coding-agent';
import { Loader, Text, truncateToWidth, getOsc8LinkAtColumn, type TuiMouseEvent } from '@earendil-works/pi-tui';
import { gatewayIdentity } from '../src/identity.js';
import { modelVisible } from '../src/tools.js';
import { loadConfig } from '../src/config.js';
import { saveAgentContext, readAutoUpdate, toggleAutoUpdate, readDisplay, toggleDisplay, toggleServiceEnabled, type Display } from './auto-update.js';
import { CallEventSchema } from '../src/call-events.js';
import { CALL_COUNTS_ENTRY, CallCounts, callCountLines } from './call-counts.js';
import { CallHistory, type CallStatus } from './call-history.js';
import { inspectCalls } from './call-inspector.js';
import { updateManagedPackages } from '../src/package-manager.js';
import { NativeUI } from './native-ui.js';
import { FooterActions } from './footer-actions.js';
import { GATEWAY_STATUS, GatewayStatusSchema } from '../src/status.js';
import { startupSummary, StartupSummarySchema, type StartupSummary } from './startup-summary.js';
import { nativePreview } from './preview.js';
import { ensureGatewayBuild } from './build.js';
import { awaitTransportExit } from './transport.js';
import { checkGatewayUpdate } from './self-update.js';
import { ChangedSchema, InvalidatedSchema, clean } from '../src/native-ui.js';
import { resolve } from 'node:path';
import { handleElicitation } from '../src/elicitation.js';
import { OPERATOR_ENV, OPERATOR_LIST, OPERATOR_GET, OPERATOR_UPDATE, OperatorServicesSchema, SettingsDocumentSchema } from '../src/settings.js';
import { confirmSettings, editSettings } from './settings.js';
import { LiveJobs } from './live-jobs.js';
import { openManager } from './manager.js';
import { managePackages, updateAllPackages } from './package-actions.js';
import { GatewayMenu } from './menu.js';
import { showText } from './text-panel.js';
import { previewAgentContext } from './agent-context-preview.js';
import { agentContextCatalog, agentContextRaw, agentContextLabels, agentContextText, agentContextTokens, nextAgentContextMode } from './agent-context.js';
const gatewayRoot = fileURLToPath(new URL('../', import.meta.url));

export interface GatewayLifecycle {
  start?: ExtensionHandler<SessionStartEvent>;
  shutdown?: ExtensionHandler<SessionShutdownEvent>;
}

export default function gatewayExtension(pi: ExtensionAPI, checkUpdate = checkGatewayUpdate, identity?: string,
  lifecycle?: GatewayLifecycle): void {
  pi.registerFlag('gateway-config', { type: 'string', description: 'Start a stdio gateway using this config file' });
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  let connected = false;
  const connectionLost = new Error('Gateway connection closed');
  let timeout = 30_000;
  let lifetime = new AbortController();
  let closing: Promise<void> | undefined;
  let connectionClosing: Promise<void> | undefined;
  let uiBusy: false | 'action' | 'dialog' = false;
  let shuttingDown = false;
  let managerController: AbortController | undefined;
  let managerWork: Promise<void> | undefined;
  let startupWork: ReturnType<typeof updateManagedPackages> | undefined;
  let startupBuild: Promise<void> | undefined;
  let selfUpdateWork: Promise<void> | undefined;
  let launchedServices: string[] | undefined;
  let configuredServices: string[] = [];
  let configurationLoaded = false;
  let footerContext: ExtensionContext | undefined;
  let display: Display = 'minimal';
  let callCounts: CallCounts | undefined;
  const callHistory = new CallHistory();
  let countsSaveWarning = false;
  function saveCounts(): void {
    if (!callCounts) return;
    try { pi.appendEntry(CALL_COUNTS_ENTRY, callCounts.snapshot()); }
    catch {
      if (!countsSaveWarning) footerContext?.ui.notify('MCP call counts could not be saved; resume totals may be incomplete', 'warning');
      countsSaveWarning = true;
    }
  }
  function interruptCalls(): void { callHistory.interrupt(); if (callCounts?.interrupt()) saveCounts(); }
  let footerBridge: FooterActions | undefined;
  const disabledServices = new Set<string>();
  let startupStatus: StartupSummary = { services: [], unavailable: true };
  let footerCount: number | undefined;
  let footerState: 'starting' | 'up' | 'off' = 'starting';
  let startupLoader: Loader | undefined;
  function startupProgress(ctx: ExtensionContext, stage?: string): void {
    if (ctx.mode !== 'tui' || !ctx.hasUI) return;
    if (!stage) {
      startupLoader?.stop(); startupLoader = undefined;
      ctx.ui.setWidget('gateway-startup-progress', undefined);
    } else if (startupLoader) {
      startupLoader.setMessage(`Starting Gateway · ${stage}`);
    } else {
      ctx.ui.setWidget('gateway-startup-progress', (tui, theme) => {
        const loader = new Loader(tui, (text) => theme.fg('accent', text), (text) => theme.fg('muted', text), `Starting Gateway · ${stage}`);
        startupLoader = loader;
        return Object.assign(loader, { dispose: () => loader.stop() });
      });
    }
  }
  const disconnectedServices = new Set<string>();
  function renderFooter(state = footerState): void {
    footerState = state;
    const ctx = footerContext;
    if (!ctx || shuttingDown) return;
    footerBridge?.clear();
    const footerServices = configuredServices.filter((name) => !disabledServices.has(name));
    const suffix = state === 'off' ? ' · off' : state === 'starting' ? ' · starting' : disconnectedServices.size ? ` · !${disconnectedServices.size}` : '';
    const text = ` MCP ${footerCount ?? '?'} ${footerCount === 1 ? 'service' : 'services'}${suffix}`;
    const styled = ctx.ui.theme.fg(state === 'off' ? 'error' : disconnectedServices.size ? 'warning' : 'muted', text);
    const openServices = async () => {
      // Links are single-use. Refresh even after a busy-dialog rejection.
      renderFooter();
      if (footerContext !== ctx || shuttingDown) return false;
      try { await gatewayCommand('services').handler('', ctx); return true; }
      finally { renderFooter(); }
    };
    const url = footerBridge?.link('gateway', openServices);
    const linked = (text: string) => url ? `\x1b]8;;${url}\x07${text}\x1b]8;;\x07` : text;
    if (display === 'full') {
      const serviceLinks = new Map<string, string>();
      const countLinks = new Map<string, string>();
      const clicks = new Map<string, () => Promise<boolean>>();
      if (url) clicks.set(url, openServices);
      for (const service of new Set([...footerServices, ...callCounts?.counts.keys() ?? []])) {
        for (const status of ['success', 'failure', 'pending'] as const) {
          const invoke = async () => {
            renderFooter();
            if (footerContext !== ctx || shuttingDown) return false;
            try { await gatewayCommand({ service, status }).handler('', ctx); return true; }
            finally { renderFooter(); }
          };
          const link = footerBridge?.link(`${service}:${status}`, invoke);
          if (link) { countLinks.set(`${service}:${status}`, link); clicks.set(link, invoke); }
        }
      }
      if (connected && state === 'up') for (const service of footerServices) {
        if (disconnectedServices.has(service)) continue;
        const invoke = async () => {
          renderFooter();
          if (footerContext !== ctx || shuttingDown) return false;
          try { await gatewayCommand({ service }).handler('', ctx); return true; }
          finally { renderFooter(); }
        };
        const link = footerBridge?.link(service, invoke);
        if (link) { serviceLinks.set(service, link); clicks.set(link, invoke); }
      }
      ctx.ui.setStatus('gateway', undefined);
      ctx.ui.setWidget('gateway-call-counts', (tui, theme) => {
        let linkedLines: string[] = [];
        return {
          render: (width: number) => {
            linkedLines = [];
            const header = `${linked(theme.fg(state === 'off' ? 'error' : disconnectedServices.size ? 'warning' : 'muted', text))} · ${callCounts?.total() ?? 0} tool calls`;
            // Wrapped counters must not push an active dialog's controls offscreen.
            const lines = uiBusy === 'dialog' ? [truncateToWidth(header, width)] : callCountLines(width, theme, header,
              footerServices, new Map([...callCounts?.counts ?? []].filter(([name]) => !disabledServices.has(name))), disconnectedServices, serviceLinks, countLinks);
            if (tui.mode !== 'fullscreen') return lines;
            linkedLines = lines;
            // Native fullscreen clicks stay inside Pi rather than launching the terminal helper.
            return lines.map((line) => line.replace(/\x1b\]8;[^;]*;[^\x07\x1b]*(?:\x07|\x1b\\)/g, ''));
          },
          handleMouse(event: TuiMouseEvent) {
            if (event.type !== 'click' || event.button !== 'left' || event.ctrl || event.alt || event.shift) return;
            const link = getOsc8LinkAtColumn(linkedLines[event.y] ?? '', event.x);
            const invoke = link ? clicks.get(link) : undefined;
            if (!invoke) return;
            void invoke().catch(() => {});
            return { handled: true, render: true };
          },
          invalidate() { linkedLines = []; },
        };
      }, { placement: 'belowEditor' });
    } else {
      ctx.ui.setWidget('gateway-call-counts', undefined);
      ctx.ui.setStatus('gateway', linked(styled));
    }
  }
  async function startFooter(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== 'tui' || !ctx.hasUI) return;
    footerContext = ctx;
    if (!footerBridge) {
      const bridge = new FooterActions(); footerBridge = bridge;
      try { await bridge.start(); }
      catch {
        await bridge.stop(); footerBridge = undefined;
        ctx.ui.notify('Gateway footer clicks unavailable; use /pi-services', 'warning');
      }
    }
    renderFooter();
  }
  let approvalQueue = Promise.resolve();
  let operatorToken: string | undefined;
  const native = new NativeUI(pi, connection, () => ({ signal: lifetime.signal, timeout }), async (run) => {
    if (uiBusy || !connected || shuttingDown) return false;
    uiBusy = 'action';
    try { return await run(() => { uiBusy = 'dialog'; renderFooter(); }); }
    finally { uiBusy = false; renderFooter(); }
  });
  pi.registerEntryRenderer<{ title: string; text: string }>('gateway-native-preview', (entry, _options, theme) => {
    if (typeof entry.data?.title !== 'string' || typeof entry.data?.text !== 'string') return;
    return nativePreview(entry.data, theme);
  });
  pi.registerEntryRenderer<{ text: string }>('gateway-package-updates', (entry, _options, theme) => {
    if (typeof entry.data?.text !== 'string') return;
    return new Text(theme.fg('success', clean(entry.data.text)), 0, 0);
  });
  pi.registerEntryRenderer<StartupSummary>('gateway-startup', (entry, _options, theme) => {
    const parsed = StartupSummarySchema.safeParse(entry.data);
    if (parsed.success) return startupSummary(parsed.data, theme);
  });
  let liveJobs: LiveJobs | undefined;

  async function showStartup(ctx: ExtensionContext, reason?: string): Promise<void> {
    if (ctx.mode !== 'tui' || !ctx.hasUI || !pi.getFlag('gateway-config') || shuttingDown || ['reload', 'resume', 'fork'].includes(reason ?? '')) return;
    const scope = resolve(String(pi.getFlag('gateway-config')));
    if (ctx.sessionManager?.getBranch().some((entry) => entry.type === 'custom' && entry.customType === 'gateway-startup' && (entry.data as { scope?: string })?.scope === scope)) return;
    const data = connected && !lifetime.signal.aborted ? startupStatus : { services: [], unavailable: true };
    pi.appendEntry('gateway-startup', { scope, ...data });
  }

  function closeConnection(): Promise<void> {
    if (!connectionClosing) {
      const stoppingNative = native.stop();
      connectionClosing = (async () => {
        try { await client?.close(); }
        finally { try { await transport?.close(); } finally { await stoppingNative; } }
      })();
    }
    return connectionClosing;
  }
  async function close(preserveMenu = false): Promise<void> {
    if (!preserveMenu) managerController?.abort();
    if (closing) return closing;
    connected = false;
    interruptCalls();
    if (footerContext) startupProgress(footerContext);
    renderFooter('off');
    configurationLoaded = false;
    liveJobs?.stop();
    liveJobs = undefined;
    lifetime.abort();
    operatorToken = undefined;
    const stoppingConnection = closeConnection();
    const pendingManager = Promise.allSettled([managerWork, startupWork, startupBuild, selfUpdateWork]);
    closing = (async () => {
      const results = await Promise.allSettled([
        pendingManager,
        stoppingConnection,
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
      uiBusy = 'dialog';
      acquired = true;
      const choice = await ctx.ui.select(ctx.mode === 'tui' ? 'Service requests approval — Allow once opens the full review' : clean(params.message), ['Decline', 'Allow once', 'Cancel'], { signal, timeout });
      if (signal.aborted) return { action: 'cancel' };
      if (choice === 'Allow once') {
        // Long browser origin/cookie disclosures must never be clipped into a
        // select title. Require every line to be visible before TUI acceptance.
        if (params.message.length > 20_000) return { action: 'cancel' };
        if (ctx.mode === 'tui' && !await confirmSettings(ctx, clean(params.message), { signal, timeout, title: 'Allow this service request?', actionLabel: 'allow once' })) return { action: 'cancel' };
        if (signal.aborted) return { action: 'cancel' };
        return { action: 'accept', content: { [key]: true } };
      }
      return { action: choice === 'Decline' ? 'decline' : 'cancel' };
    } catch { return { action: 'cancel' }; }
    finally { if (acquired) { uiBusy = false; renderFooter(); } release(); }
  }

  async function start(ctx: ExtensionContext, preserveMenu = false, reason?: string, update = false): Promise<void> {
    try { await startGateway(ctx, preserveMenu, reason, update); }
    finally { startupProgress(ctx); }
  }
  async function startGateway(ctx: ExtensionContext, preserveMenu: boolean, reason: string | undefined, update: boolean): Promise<void> {
    if (shuttingDown) return;
    const configPath = pi.getFlag('gateway-config');
    if (typeof configPath !== 'string' || !configPath) return;
    await startFooter(ctx);
    if (connected) { await native.start(ctx, resolve(configPath), reason); return; }
    disconnectedServices.clear();
    disabledServices.clear();
    startupStatus = { services: [], unavailable: true };
    renderFooter('starting');
    closing = undefined;
    connectionClosing = undefined;
    lifetime = new AbortController();
    configurationLoaded = false;
    {
      // Loaded runtimes never replace their own dependencies; bootstrap owns self-updates.
      const work = checkUpdate(gatewayRoot, false, lifetime.signal,
        (stage) => startupProgress(ctx, stage === 'updating' ? 'Updating gateway' : 'Checking gateway updates'),
        (text, level) => ctx.ui.notify(clean(text), level));
      selfUpdateWork = work;
      try { await work; }
      catch (error) { renderFooter('off'); throw error; }
      finally { if (selfUpdateWork === work) selfUpdateWork = undefined; }
      if (shuttingDown || lifetime.signal.aborted) return;
    }
    startupProgress(ctx, 'reading service configuration');
    const config = await loadConfig(configPath).catch((error) => { renderFooter('off'); throw error; });
    display = await readDisplay(configPath);
    timeout = config.timeoutMs;
    configuredServices = config.services.map((service) => service.name);
    for (const service of config.services) if (service.enabled === false) disabledServices.add(service.name);
    footerCount = configuredServices.length - disabledServices.size;
    renderFooter();
    configurationLoaded = true;
    if (shuttingDown || lifetime.signal.aborted) return;
    if (update && config.autoUpdate) {
      startupProgress(ctx, 'checking for service updates');
      const work = updateManagedPackages(config, lifetime.signal, (name, error) =>
        ctx.ui.notify(clean(`MCP auto-update failed for ${name}: ${String(error)}. Inspect package configuration and logs; incomplete local builds block startup.`), 'warning'),
      (name, stage) => {
        const services = config.services.filter((service) => service.package === name).map((service) => service.name);
        startupProgress(ctx, `${stage === 'updating' ? 'Updating' : 'Checking'} service ${services.join(', ')}`);
      });
      startupWork = work;
      try {
        const updates = await work.catch((error) => { renderFooter('off'); throw error; });
        if (shuttingDown || lifetime.signal.aborted) return;
        if (updates.length) pi.appendEntry('gateway-package-updates', {
          text: `MCP servers were updated:\n${updates.map(({ name, from, version }) => `- ${name}: ${from} → ${version}`).join('\n')}`,
        });
      } finally { if (startupWork === work) startupWork = undefined; }
    }
    startupProgress(ctx, 'checking gateway build');
    const startupSignal = lifetime.signal;
    const build = ensureGatewayBuild(gatewayRoot, startupSignal, {
      identity, launch: () => connectGateway(ctx, configPath, reason),
      dispose: async () => { lifetime.abort(); await closeConnection(); },
    });
    startupBuild = build;
    try { await build; }
    catch (error) {
      if (startupBuild === build) startupBuild = undefined;
      renderFooter('off');
      await close(preserveMenu);
      // A ready gateway lost during optional UI discovery is already shown as
      // disconnected. Keep recovery available, but propagate real startup/cancel errors.
      if (startupSignal.reason !== connectionLost) throw error;
    } finally { if (startupBuild === build) startupBuild = undefined; }
  }

  async function connectGateway(ctx: ExtensionContext, configPath: string, reason?: string): Promise<void> {
    if (shuttingDown || lifetime.signal.aborted) return;
    const current = new Client({ name: 'pi-gateway-adapter', version: gatewayIdentity.version }, { capabilities: ctx.hasUI ? { elicitation: { form: {} } } : {} });
    client = current;
    const countsOwner = callCounts, callLifetime = lifetime;
    let servicesReady = false;
    current.onclose = () => { if (client === current) { connected = false; interruptCalls(); renderFooter('off'); liveJobs?.disconnect(); callLifetime.abort(servicesReady ? connectionLost : undefined); void native.stop(); } };
    current.setNotificationHandler(CallEventSchema, ({ params }) => {
      if (client !== current || callLifetime.signal.aborted || callCounts !== countsOwner || shuttingDown || !configuredServices.includes(params.service)) return;
      if (callCounts?.event(params)) { callHistory.event(params); saveCounts(); renderFooter(); }
    });
    current.setNotificationHandler(ChangedSchema, async ({ params }) => { await native.refresh(params.uri); });
    current.setNotificationHandler(InvalidatedSchema, ({ params }) => {
      if (client !== current) return;
      disconnectedServices.add(params.service); renderFooter();
      native.invalidate(params.service);
    });
    operatorToken = ctx.mode === 'tui' && ctx.hasUI ? randomBytes(32).toString('base64url') : undefined;
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    delete env[OPERATOR_ENV];
    if (operatorToken) env[OPERATOR_ENV] = operatorToken;
    transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), '--config', configPath], cwd: ctx.cwd, env, stderr: 'pipe' });
    awaitTransportExit(transport);
    if (ctx.hasUI) handleElicitation(current, transport, (params, signal) => approve(params, AbortSignal.any([signal, lifetime.signal]), ctx));
    // Gateway already owns a diagnostic file. Drain its stderr without feeding it to the model.
    transport.stderr?.on('data', () => {});
    startupProgress(ctx, 'connecting services');
    await current.connect(transport, { timeout, signal: lifetime.signal });
    const inventory = current.getServerCapabilities()?.experimental?.['gateway-services-v1'] as { names?: unknown } | undefined;
    launchedServices = Array.isArray(inventory?.names) && inventory.names.every((name) => typeof name === 'string' && /^[a-z][a-z0-9-]*$/.test(name)) ? inventory.names : undefined;
    connected = true;
    startupProgress(ctx, 'discovering tools');
    const discoveredTools = await tools(lifetime.signal); // Wait for child startup before declaring success.
    servicesReady = true;
    if (ctx.mode === 'tui' && ctx.hasUI && current.getServerCapabilities()?.experimental?.['gateway-status-v1']) {
      try {
        startupStatus = await current.request({ method: GATEWAY_STATUS }, GatewayStatusSchema, { signal: lifetime.signal, timeout });
        for (const service of startupStatus.services) {
          if (service.state === 'stopped') disabledServices.add(service.name);
          if (service.state === 'disconnected') disconnectedServices.add(service.name);
        }
        footerCount = configuredServices.filter((name) => !disabledServices.has(name)).length;
        const { services } = await loadConfig(configPath, { expandEnvironment: false });
        startupStatus.contextTokens = Object.fromEntries(services.map((service) => [
          service.name, agentContextTokens(agentContextText([service], discoveredTools)),
        ]));
      } catch { /* Status is display-only; keep working connections on read failure. */ }
    }
    startupProgress(ctx, 'loading service apps');
    await native.start(ctx, resolve(configPath), reason);
    if (ctx.mode === 'tui' && ctx.hasUI) {
      startupProgress(ctx, 'loading live panels');
      liveJobs = new LiveJobs(current, ctx, timeout);
      await liveJobs.start();
    }
    if (client === current && connected && !lifetime.signal.aborted && !shuttingDown) renderFooter('up');
  }
  const onStart: ExtensionHandler<SessionStartEvent> = async (event, ctx) => {
    shuttingDown = false;
    countsSaveWarning = false;
    callHistory.clear();
    const scope = resolve(String(pi.getFlag('gateway-config') ?? ''));
    callCounts = new CallCounts(ctx.sessionManager.getSessionId(), scope, ctx.sessionManager.getEntries?.() ?? ctx.sessionManager.getBranch());
    try { await start(ctx, false, event.reason, true); }
    finally { await showStartup(ctx, event.reason); }
  };
  if (lifecycle) lifecycle.start = onStart;
  else pi.on('session_start', onStart);
  const onShutdown: ExtensionHandler<SessionShutdownEvent> = async (event) => {
    if (event.reason === 'new') native.transfer(event.targetSessionFile);
    shuttingDown = true;
    if (footerContext) startupProgress(footerContext);
    const bridge = footerBridge; footerBridge = undefined;
    footerContext?.ui.setStatus('gateway', undefined);
    footerContext?.ui.setWidget('gateway-call-counts', undefined); footerContext = undefined;
    try { await close(); } finally { callHistory.clear(); await bridge?.stop(); }
  };
  if (lifecycle) lifecycle.shutdown = onShutdown;
  else pi.on('session_shutdown', onShutdown);
  pi.on('session_tree', async (_event, ctx) => {
    if (footerContext) { footerContext = ctx; renderFooter(); }
    if (connected) await native.start(ctx, resolve(String(pi.getFlag('gateway-config'))));
  });
  async function contextSnapshot(signal?: AbortSignal) {
    const path = pi.getFlag('gateway-config');
    if (typeof path !== 'string' || !path) return { services: [], catalog: [] };
    const { services } = await loadConfig(path, { expandEnvironment: false });
    const inventory = services.every((service) => service.enabled === false || service.agentContext === 'off') ? [] : await tools(signal);
    signal?.throwIfAborted();
    return { services, catalog: agentContextCatalog(services, inventory) };
  }
  async function contextText(signal?: AbortSignal): Promise<string> {
    return agentContextRaw((await contextSnapshot(signal)).catalog);
  }
  pi.on('before_agent_start', async (event, ctx) => {
    // Replace our section each run, including resume/fork and preference/inventory changes.
    delete event.systemPromptOptions.sections.gateway_tools;
    try {
      const text = await contextText(ctx.signal);
      if (text) event.systemPromptOptions.sections.gateway_tools = text;
    } catch (error) {
      ctx.ui.notify(clean(`Gateway agent context unavailable: ${String(error)}`), 'warning');
    }
  });
  const gatewayCommand = (initialAction?: 'services' | { service: string; status?: CallStatus }) => ({
    description: gatewayCommands[initialAction ? 'pi-services' : 'gateway'],
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!ctx.hasUI || ctx.mode !== 'tui') { ctx.ui.notify('Gateway menus require TUI mode', 'warning'); return; }
      if (uiBusy) { ctx.ui.notify('Finish the current gateway dialog first', 'warning'); return; }
      const configPath = pi.getFlag('gateway-config');
      if (typeof configPath !== 'string' || !configPath) { ctx.ui.notify('Use --gateway-config <file> to select a configuration', 'warning'); return; }
      uiBusy = 'dialog';
      const controller = new AbortController();
      managerController = controller;
      const signal = controller.signal;
      const menu = new GatewayMenu(ctx, signal);
      const serviceSettings = async (service: string) => {
        try { await openSettings(service, ctx); }
        catch (error) { if (!signal.aborted) ctx.ui.notify(clean(`Settings unavailable: ${String(error)}`), 'error'); }
      };
      let nextAction = connected && initialAction ? 'services' : undefined;
      let directService = typeof initialAction === 'object' ? initialAction.service : undefined;
      try {
        if (typeof initialAction === 'object' && initialAction.status) {
          await inspectCalls(ctx, menu, callHistory, initialAction.service, initialAction.status, () => callCounts?.counts.get(initialAction.service), signal);
          return;
        }
        while (!signal.aborted) {
          let autoUpdate: boolean | undefined, autoUpdateError = '';
          let menuDisplay: Display | undefined, displayError = '';
          try { menuDisplay = await readDisplay(configPath); }
          catch (error) { displayError = clean(String(error)); }
          try { autoUpdate = await readAutoUpdate(configPath); }
          catch (error) { autoUpdateError = clean(String(error)); }
          const action = nextAction ?? await menu.choose(['Gateway'], connected ? 'Connected · one gateway for this Pi session' : 'Disconnected · packages and recovery are still available', [
            { id: 'agent-context', label: 'Agent context', description: 'Cycle context detail for each service: full schemas, tool summaries, service summary or off. Preview the exact catalog.' },
            { id: 'services', label: 'Services', description: 'Enable/disable services, open apps, edit settings or read resources.' },
            { id: 'calls', label: 'Tool call history', description: 'Inspect retained parameters and results privately. Session totals may include calls whose payloads are unavailable.' },
            { id: 'packages', label: 'Packages', description: 'Inspect versions, prepare updates, activate or roll back. Running services stay unchanged.' },
            { id: 'auto-update', label: `Auto update: ${autoUpdate === undefined ? 'Unavailable' : autoUpdate ? 'On' : 'Off'}`, disabled: autoUpdate === undefined,
              description: autoUpdateError || 'Enter toggles and saves. On permits gateway + service updates and trusted builds at startup/reload, without prompts. Gateway updates need a Pi restart. Code runs with OS permissions.' },
            { id: 'display', label: `Display: ${menuDisplay === undefined ? 'Unavailable' : menuDisplay === 'full' ? 'Full' : 'Minimal'}`, disabled: menuDisplay === undefined,
              description: displayError || 'Enter toggles and saves immediately. Full shows per-service success (green), failure (red), and running (amber) tool calls.' },
            { id: 'connection', label: 'Connection', description: 'Inspect connection details and explicitly restart all services in this session.' },
          ]);
          nextAction = undefined;
          if (!action) break;
          try {
            if (action === 'calls') {
              while (!signal.aborted) {
                const service = await menu.choose(['Gateway', 'Tool calls'], 'Memory-only recent child dispatches · no payloads saved', [...new Set([...configuredServices, ...callCounts?.counts.keys() ?? []])].map((name) => ({ id: name, label: name, description: 'Choose a status filter.' })));
                if (!service) break;
                while (!signal.aborted) {
                  const status = await menu.choose(['Gateway', 'Tool calls', service], 'Session totals include payloads no longer retained', (['success', 'failure', 'pending'] as const).map((status) => ({ id: status, label: `${status} (${callCounts?.counts.get(service)?.[status] ?? 0})`, description: 'Open filtered retained calls.' })));
                  if (!status) break;
                  await inspectCalls(ctx, menu, callHistory, service, status as CallStatus, () => callCounts?.counts.get(service), signal);
                }
              }
            } else if (action === 'display' && menuDisplay !== undefined) {
              display = await toggleDisplay(configPath, menuDisplay, signal);
              renderFooter();
            } else if (action === 'auto-update' && autoUpdate !== undefined) {
              const enabled = await toggleAutoUpdate(configPath, autoUpdate, signal);
              ctx.ui.notify(`Auto update ${enabled ? 'on' : 'off'} · saved for next startup/reload`, 'info');
            } else if (action === 'agent-context') {
              while (!signal.aborted) {
                const { services } = await loadConfig(configPath, { expandEnvironment: false });
                let inventory: Tool[] | undefined;
                let cost = 'Token estimate unavailable';
                try {
                  inventory = services.every((service) => service.enabled === false || service.agentContext === 'off') ? [] : await tools(signal);
                  cost = `≈${agentContextTokens(agentContextText(services, inventory)).toLocaleString('en-US')} tokens total (rough estimate)`;
                } catch { /* Keep preferences/recovery accessible while disconnected. */ }
                const selected = await menu.choose(['Gateway', 'Agent context'], `${cost} · next agent run`, [
                  ...services.map((service) => ({
                    id: `service:${service.name}`,
                    label: `${service.name}: ${service.enabled === false ? 'Disabled (locked) · saved: ' : ''}${agentContextLabels[service.agentContext ?? 'off']}`,
                    disabled: service.enabled === false,
                    description: service.enabled === false ? 'Disabled (locked) · 0 tokens. Saved preference retained; enable the service to change it.' : `${inventory ? `≈${agentContextTokens(agentContextText([service], inventory)).toLocaleString('en-US')} tokens (with shared header). ` : ''}Enter cycles this service's mode; tools stay callable.`,
                  })),
                  { id: 'preview', label: 'Preview injected context', description: 'View the exact current catalog privately. Does not send it to the agent or change the injection setting.' },
                ]);
                if (!selected) break;
                if (selected === 'preview') {
                  await previewAgentContext(ctx, contextSnapshot, signal, connected ? lifetime.signal : undefined);
                } else if (selected.startsWith('service:')) {
                  const service = services.find((service) => service.name === selected.slice('service:'.length))!;
                  if (service.enabled === false) continue;
                  const mode = service.agentContext ?? 'off';
                  const next = nextAgentContextMode(mode);
                  await saveAgentContext(configPath, service.name, mode, next, signal);
                  ctx.ui.notify(`${service.name} context: ${agentContextLabels[next]} · saved for the next agent run`, 'info');
                }
              }
            } else if (action === 'services') {
              while (!signal.aborted) {
                const config = await loadConfig(configPath, { expandEnvironment: false });
                const names = [...new Set([...config.services.map((s) => s.name), ...(launchedServices ?? [])])];
                const service = directService ?? await menu.choose(['Gateway', 'Services'], 'Choose a service · listed does not mean running',
                  names.map((name) => ({ id: name, label: `${name}${config.services.find((s) => s.name === name)?.enabled === false ? ' (disabled)' : ''}`, description: 'Enter opens service controls; Tab opens settings. Enable/disable applies on restart/reload, not immediately.' })),
                  { label: 'settings', action: serviceSettings });
                directService = undefined;
                if (!service) break;
                let openApp = false;
                while (!signal.aborted) {
                  const current = (await loadConfig(configPath, { expandEnvironment: false })).services.find((s) => s.name === service);
                  const enabled = current?.enabled !== false;
                  if (openApp) {
                    openApp = false;
                    if (await native.open(service, ctx, { settings: () => serviceSettings(service) }) !== 'features') break;
                    if (signal.aborted || !connected) break;
                  }
                  const options = { signal: lifetime.signal, timeout };
                  let editable = false, settingsError = '', settingsTitle = 'Settings';
                  try {
                    const settings = connected && operatorToken ? await connection().request({ method: OPERATOR_LIST, params: { token: operatorToken } }, OperatorServicesSchema, options) : { services: [] };
                    const entry = settings.services.find((s) => s.name === service);
                    editable = Boolean(entry);
                    settingsTitle = clean(entry?.title || 'Settings');
                  } catch (error) { settingsError = clean(`Settings discovery failed: ${String(error)}`); }
                  const app = connected && native.has(service);
                  const selected = await menu.choose(['Gateway', 'Services', service], settingsError || `Next launch: ${enabled ? 'enabled' : 'disabled'} · saved changes do not stop/start running services`, [
                    { id: 'app', label: 'Open app', description: 'Open the service-provided interactive menu.', disabled: !app },
                    { id: 'settings', label: settingsTitle, description: 'Edit a draft; review and confirm before saving.', disabled: !editable },
                    { id: 'resources', label: 'Resources', description: 'Browse read-only service data privately, without sending it to the model.', disabled: !connected },
                    { id: 'restart', label: 'Connection / restart…', description: 'Apply saved choices using a separately confirmed restart of ALL gateway services in this session. Active/queued jobs will be cancelled.' },
                    { id: 'toggle-enabled', label: enabled ? 'Disable service' : 'Enable service', disabled: !current,
                      description: 'Save for future launches in all sessions sharing this config. Running services stay unchanged; use Connection to confirm a restart here.' },
                  ].filter((item) => !item.disabled));
                  if (!selected) break;
                  if (selected === 'toggle-enabled') {
                    const next = await toggleServiceEnabled(configPath, service, enabled, signal);
                    ctx.ui.notify(`${service}: ${next ? 'enabled' : 'disabled'} for next startup/reload · running services unchanged`, 'info');
                  }
                  if (selected === 'restart') { nextAction = 'connection'; break; }
                  if (selected === 'app') openApp = true;
                  if (selected === 'settings') await serviceSettings(service);
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
                if (nextAction) break;
                // A counter opens one service, not the parent menus on close.
                if (typeof initialAction === 'object') return;
              }
            } else if (action === 'packages') {
              while (!signal.aborted) {
                const config = await loadConfig(configPath, { expandEnvironment: false });
                const selected = await menu.choose(['Gateway', 'Packages'], 'Preparation → activation → restart are separate decisions', [
                  { id: 'status', label: 'Installed versions', description: 'Read local package metadata only. Versions describe installations, not running processes.' },
                  { id: 'check', label: 'Check for updates', description: 'Contact public package sources to compare versions. Nothing is installed.', disabled: !config.packages.length },
                  { id: 'update-all', label: 'Update all packages', description: 'Run a one-time update of managed releases and opted-in local checkouts. Review and confirm; no restart.' },
                  { id: 'manage', label: 'Manage releases', description: 'Choose a managed package to prepare, activate, roll back or view its build log.', disabled: !config.packages.some((pkg) => pkg.managed) },
                ]);
                if (!selected) break;
                if (selected === 'update-all') {
                  if (!ctx.isIdle()) { ctx.ui.notify('Wait for the current agent turn to finish before updating packages', 'warning'); continue; }
                  const work = updateAllPackages(ctx, config, signal);
                  managerWork = work;
                  try { await work; } finally { if (managerWork === work) managerWork = undefined; }
                } else if (selected === 'manage') {
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
                  const config = await loadConfig(configPath, { expandEnvironment: false });
                  if (connected && !launchedServices) { ctx.ui.notify('Runtime service inventory unavailable; build/reload the matching gateway before using managed restart', 'warning'); continue; }
                  if (!ctx.isIdle()) { ctx.ui.notify('Wait for the current agent turn to finish before restarting', 'warning'); continue; }
                  const preview = `Stop ALL services from this gateway's launch snapshot (some may already be stopped):\n${(launchedServices ?? []).map((name) => `- ${name}`).join('\n') || '(none known)'}\n\nConfigured for NEW launches (unactivated packages stay stopped):\n${config.services.filter((service) => service.enabled !== false).map((service) => `- ${service.name}`).join('\n') || '(none enabled)'}\n\nThis CANCELS any active or queued background jobs. Job count is unknown; finish work first or decline.\n\nOther Pi sessions are not restarted. New processes use the active package versions/configuration at startup; another session may change activation. The gateway run ID changes; saved conversation selection is restored.\n\nA startup failure leaves this gateway disconnected. Roll back and retry explicitly; there is no automatic restart or fallback.`;
                  if (!await confirmSettings(ctx, preview, { signal, timeout: 300_000, title: 'Restart gateway services?', actionLabel: 'stop and restart' }) || signal.aborted) continue;
                  if (!ctx.isIdle()) { ctx.ui.notify('Agent became busy; restart was cancelled', 'warning'); continue; }
                  // Validate enabled-service environment variables before stopping healthy children.
                  await loadConfig(configPath);
                  await close(true);
                  if (!shuttingDown) { await start(ctx, true); if (connected) ctx.ui.notify('Gateway services restarted', 'info'); }
                }
              }
            }
          } catch (error) { if (!signal.aborted) ctx.ui.notify(clean(`Gateway: ${String(error)}`), 'error'); }
        }
      } finally { if (managerController === controller) managerController = undefined; uiBusy = false; renderFooter(); }
    },
  });
  pi.registerCommand('gateway', gatewayCommand());
  pi.registerCommand('pi-services', gatewayCommand('services'));

  pi.registerTool({
    ...gatewayTools.discover,
    async execute(_id, _params, signal) {
      const list = (await tools(signal)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
      return { content: [{ type: 'text', text: JSON.stringify(list) }], details: undefined };
    },
  });
  pi.registerTool({
    ...gatewayTools.call,
    ...gatewayCallRenderers,
    async execute(_id, params, signal) {
      const result = await invokeTool(params.name, params.arguments, signal);
      const content = result.content.map((item) => item.type === 'text' || item.type === 'image' ? item : { type: 'text' as const, text: JSON.stringify(item) });
      if (!content.length && result.structuredContent) content.push({ type: 'text', text: JSON.stringify(result.structuredContent) });
      return { content, details: undefined, isError: Boolean(result.isError) };
    },
  });

  async function invokeTool(name: string, args: Record<string, unknown>, signal?: AbortSignal, readOnly = false) {
    const current = connection(), active = lifetime, sameContext = native.current();
    const tool = (await tools(signal)).find((tool) => tool.name === name);
    if (!tool || readOnly && tool.annotations?.readOnlyHint !== true) throw new Error('Unknown, app-only, or non-read-only tool');
    const error = compileSchema(tool.inputSchema)(args);
    if (error) throw new Error(`Invalid arguments: ${error}`);
    if (active !== lifetime || active.signal.aborted || !sameContext()) throw new Error('Gateway context changed');
    return native.callTool(name.split('__')[0], (meta) => current.callTool({ name, arguments: args, _meta: meta }, undefined,
      { signal: signal ? AbortSignal.any([signal, active.signal]) : active.signal, timeout }).then((result) => CallToolResultSchema.parse(result)));
  }

  // Synchronous ownership acknowledgement; the value is a bounded asynchronous read.
  pi.events.on('gateway:query-service-tool', (request: unknown) => {
    const query = request as { service?: string; tool?: string; arguments?: Record<string, unknown>; respond?: (reply: unknown) => void };
    if (!query || typeof query.respond !== 'function') return;
    if (!configurationLoaded && pi.getFlag('gateway-config')) {
      query.respond({ handled: true, error: 'Gateway configuration is not ready' }); return;
    }
    if (typeof query.service !== 'string' || !configuredServices.includes(query.service)) { query.respond({ handled: false }); return; }
    if (typeof query.tool !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(query.tool)) { query.respond({ handled: true, error: 'Invalid tool name' }); return; }
    // A failed/disconnected owned service must never fall back to unrelated cwd selection.
    const result = invokeTool(`${query.service}__${query.tool}`, query.arguments ?? {}, undefined, true);
    void result.catch(() => {}); // Event callers may disappear during session teardown.
    query.respond({ handled: true, result });
  });

  async function openSettings(service: string, ctx: ExtensionContext): Promise<void> {
    const current = connection();
    const token = operatorToken;
    if (!token) { ctx.ui.notify('Settings unavailable; reconnect the gateway', 'warning'); return; }
    const signal = lifetime.signal;
    const options = { signal, timeout };
    const document = await current.request({ method: OPERATOR_GET, params: { token, service } }, SettingsDocumentSchema, options);
    await editSettings(ctx, document, (revision, patch) =>
      current.request({ method: OPERATOR_UPDATE, params: { token, service, revision, patch } }, SettingsDocumentSchema, options), signal);
  }

  async function openResource(uri: string, ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
    const current = connection(), lifetimeSignal = lifetime.signal;
    await showText(ctx, `Gateway resource: ${uri}`, async (signal) => {
      const result = await current.readResource({ uri }, { ...observationOptions(), signal });
      return clean(result.contents.map((item) => 'text' in item ? item.text : '[non-text resource]').join('\n'));
    }, signal, lifetimeSignal);
  }
}
