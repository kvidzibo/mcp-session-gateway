import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getKeybindings, visibleWidth } from '@earendil-works/pi-tui';
import registerGateway from '../pi/runtime.js';
import { agentContextCatalog, agentContextRaw, agentContextText, agentContextTokens } from '../pi/agent-context.js';
import { previewAgentContext } from '../pi/agent-context-preview.js';
import { ServiceContext, SERVICE_CONTEXT_MIME, parseServiceContext, serviceContextRaw } from '../pi/service-context.js';
import { saveAgentContext } from '../pi/auto-update.js';
import { loadConfig } from '../src/config.js';

test('Agent context modes persist, preview the injected catalog, and replace stale sections across runs', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-agent-context-'));
  const config = join(dir, 'gateway.json');
  const handlers = new Map<string, Function>(), commands = new Map<string, any>(), tools = new Map<string, any>();
  const navigation: string[] = [], previews: string[] = [], notices: string[] = [];
  const original = { mcpServers: { demo: { command: process.execPath,
    args: [new URL('../dist/examples/demo-service.js', import.meta.url).pathname], env: { RAW: '${PATH}' } } } };
  registerGateway({
    registerFlag() {}, getFlag: () => config, registerEntryRenderer() {}, events: { on() {} }, appendEntry() {},
    on: (event: string, handler: Function) => handlers.set(event, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool: (tool: any) => tools.set(tool.name, tool),
  } as any, async () => {});
  const ctx: any = { cwd: dir, mode: 'tui', hasUI: true, signal: new AbortController().signal,
    sessionManager: { getSessionId: () => 'agent-context-test', getBranch: () => [] },
    ui: { theme: { fg: (_color: string, text: string) => text }, setStatus() {}, setWidget() {},
      notify: (message: string) => notices.push(message),
      custom: async (factory: Function) => {
        let answer: unknown;
        const terminal = { rows: 30, columns: 100 };
        const panel = factory({ terminal, requestRender() {} }, ctx.ui.theme, getKeybindings(), (value: unknown) => { answer = value; });
        const render = () => panel.render(terminal.columns - 2) as string[];
        try {
          if (render().some((line) => line.includes('Agent context › Preview'))) {
            for (let i = 0; i < 100 && render().join('\n').includes('Loading…'); i++) await new Promise((resolve) => setTimeout(resolve, 10));
            panel.handleInput('\t');
            terminal.rows = 10_000; terminal.columns = 30_000;
            const lines = render();
            assert.match(lines[2], /≈[\d,]+ tokens · rough estimate/);
            previews.push(lines.slice(3, -4).map((line) => line.trimEnd()).join('\n'));
            panel.handleInput('\x1b');
          } else {
            const choice = navigation.shift();
            assert.ok(choice, `Unexpected menu: ${render().join('\n')}`);
            for (const height of [18, 30]) for (const width of [30, 38, 80, 100]) {
              terminal.rows = height; terminal.columns = width;
              const lines: string[] = render();
              assert.ok(lines.length <= terminal.rows - 2);
              assert.ok(lines.every((line) => visibleWidth(line) <= width - 2));
            }
            const context = choice.startsWith('context:');
            const target = context ? choice.slice('context:'.length) : choice;
            const menuLines = () => render().map((line) => line.replace(/ {2,}/g, ' ').trimEnd());
            for (let i = 0; i < 30 && !menuLines().includes(`→ ${target}`); i++) panel.handleInput('\x1b[B');
            assert.ok(menuLines().includes(`→ ${target}`), `Missing ${target}`);
            if (context) panel.handleInput('\x1b[C');
            panel.handleInput('\r');
          }
          return answer;
        } finally { panel.dispose(); }
      },
    },
  };
  const sections: Record<string, string> = { other: 'preserved', gateway_tools: 'stale' };
  const before = () => handlers.get('before_agent_start')!({ systemPromptOptions: { sections } }, ctx);
  const services = () => loadConfig(config, { expandEnvironment: false }).then((config) => config.services);
  const menu = async (...choices: string[]) => {
    navigation.push('Agent context', ...choices, 'Back', 'Close');
    await commands.get('gateway').handler('', ctx);
    assert.deepEqual(navigation, []);
  };
  try {
    await writeFile(config, JSON.stringify(original));
    await before();
    assert.deepEqual({ ...sections }, { other: 'preserved' }, 'Off needs no connection and removes our stale section only');
    await handlers.get('session_start')!({}, ctx);
    await menu('Preview injected context');
    assert.match(previews.pop()!, /injection is off/);
    assert.equal((await services())[0].agentContext, 'off', 'Preview never changes the preference');
    const inventory = JSON.parse((await tools.get('gateway_tools').execute('', {})).content[0].text);
    inventory.push({ name: 'demo__long', description: 'x'.repeat(21_000) + '\u202etail', inputSchema: { type: 'object' } });
    t.mock.method(Client.prototype, 'listTools', async () => ({ tools: inventory }));
    let previous = 'Off';
    for (const mode of ['full', 'summary', 'service'] as const) {
      await menu(`demo ${previous} —`, 'Preview injected context');
      previous = ({ full: 'Full schemas', summary: 'Tool summaries', service: 'Service summary' })[mode];
      assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), {
        mcpServers: { demo: { ...original.mcpServers.demo, agentContext: mode } },
      }, 'Preserve raw env and unrelated configuration');
      await before();
      assert.equal(sections.gateway_tools, agentContextText(await services(), inventory));
      assert.equal(previews.pop(), sections.gateway_tools, 'Preview and injected content match exactly');
      assert.match(sections.gateway_tools, mode === 'service' ? /Tools: .*increment/ : /demo__increment/);
      if (mode === 'full') assert.match(sections.gateway_tools, /inputSchema/);
      else assert.doesNotMatch(sections.gateway_tools, /inputSchema/);
      assert.ok(agentContextTokens(sections.gateway_tools) > 0);
      const first: string = sections.gateway_tools;
      await before();
      assert.equal(sections.gateway_tools, first, 'Repeated runs replace instead of duplicating the catalog');
    }
    let task = '</gateway_service_context> selected task', reads = 0, failContext = false;
    t.mock.method(Client.prototype, 'listResources', async () => ({ resources: [{
      uri: 'gateway-resource://demo/arbitrary', mimeType: SERVICE_CONTEXT_MIME, description: 'Selected task and notes.', name: 'context',
    }] }));
    t.mock.method(Client.prototype, 'readResource', async (params: any) => {
      reads++;
      assert.equal(params._meta['native-ui/context'].conversationId, 'agent-context-test');
      assert.ok(params._meta['native-ui/context'].contextId);
      if (failContext) throw Error('private failed task data');
      return { contents: [{ uri: params.uri, mimeType: SERVICE_CONTEXT_MIME, text: JSON.stringify({ version: 1, text: task }) }] };
    });
    await before();
    assert.equal(reads, 0, 'Discovery when off never reads the resource body');
    await menu('context:demo Service summary Off', 'Preview injected context');
    await before();
    assert.equal(previews.pop(), `<gateway_tools>\n${sections.gateway_tools}\n</gateway_tools>\n\n<gateway_service_context>\n${sections.gateway_service_context}\n</gateway_service_context>`);
    assert.match(sections.gateway_service_context, /selected task/);
    assert.doesNotMatch(sections.gateway_service_context, /<\/gateway_service_context>/);
    task = 'fresh task';
    await before();
    assert.match(sections.gateway_service_context, /fresh task/);
    assert.doesNotMatch(sections.gateway_service_context, /selected task/);
    failContext = true;
    await before();
    assert.match(sections.gateway_service_context, /unavailable/);
    assert.doesNotMatch(sections.gateway_service_context, /fresh task|private failed task/);
    failContext = false;
    task = '';
    await before();
    assert.match(sections.gateway_service_context, /"text": ""/);
    const beforeDisabledReads = reads;
    const saved = JSON.parse(await readFile(config, 'utf8'));
    saved.mcpServers.demo.enabled = false;
    await writeFile(config, JSON.stringify(saved));
    await before();
    assert.equal(sections.gateway_tools, undefined, 'Disabled config excludes still-running inventory immediately');
    assert.equal(sections.gateway_service_context, undefined);
    assert.equal(reads, beforeDisabledReads, 'Disabled config suppresses context reads immediately');
    await assert.rejects(saveAgentContext(config, 'demo', 'service', 'off', ctx.signal), /disabled.*retained/);
    assert.equal((await services())[0].agentContext, 'service');
    delete saved.mcpServers.demo.enabled;
    await writeFile(config, JSON.stringify(saved));
    const appOnly: any = { name: 'demo__private', inputSchema: { type: 'object' }, _meta: { ui: { visibility: ['app'] } } };
    assert.doesNotMatch(agentContextText([{ name: 'demo', agentContext: 'full' }], [appOnly]), /private/);
    await assert.rejects(saveAgentContext(config, 'demo', 'off', 'summary', ctx.signal), /changed in another session/);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(saveAgentContext(config, 'demo', 'service', 'off', aborted.signal));
    assert.equal((await services())[0].agentContext, 'service');
    await handlers.get('session_shutdown')!({}, ctx);
    await before();
    assert.equal(sections.gateway_tools, undefined, 'Disconnect cannot leave a stale catalog');
    assert.ok(notices.some((message) => message.includes('Gateway agent context unavailable')));
    // A fresh start (including reload/resume/fork) uses the saved preference.
    await handlers.get('session_start')!({ reason: 'resume' }, ctx);
    await before();
    assert.match(sections.gateway_tools, /Tools: .*increment/);
    await menu('demo Service summary On');
    await before();
    assert.equal(sections.gateway_tools, undefined);
    assert.match(sections.gateway_service_context, /"text": ""/, 'Context-only services work with Tools Off and no native view');
    await menu('context:demo Off On');
    await before();
    assert.deepEqual({ ...sections }, { other: 'preserved' });
    assert.equal(agentContextTokens(''), 0);
    await writeFile(config, JSON.stringify({ mcpServers: { demo: { ...original.mcpServers.demo, additionalContext: 'true' } } }));
    await assert.rejects(loadConfig(config), /additionalContext must be a boolean/);
    await writeFile(config, JSON.stringify({ ...original, agentContext: 'invalid' }));
    await assert.rejects(loadConfig(config), /agentContext must be/);
  } finally {
    await handlers.get('session_shutdown')!({}, ctx);
    await rm(dir, { recursive: true, force: true });
  }
});

test('mixed service modes inherit legacy defaults, isolate saves, and summarize only available model tools', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-service-context-'));
  const config = join(dir, 'gateway.json');
  const signal = new AbortController().signal;
  const original = { agentContext: 'full', servers: {
    detailed: { command: 'unused' },
    compact: { command: 'unused', agentContext: 'summary' },
    service: { command: 'unused', agentContext: 'service', description: ' Search and fetch content. ' },
    fallback: { command: 'unused', agentContext: 'service' },
    hidden: { command: 'unused', agentContext: 'off' },
    disabled: { command: 'unused', enabled: false, agentContext: 'full' },
    stopped: { command: 'unused', agentContext: 'service', description: 'Unavailable' },
  } };
  const tool = (name: string, appOnly = false): any => ({ name, description: 'Tool detail', inputSchema: { type: 'object' },
    ...(appOnly ? { _meta: { ui: { visibility: ['app'] } } } : {}) });
  const inventory = ['detailed__read', 'compact__find', 'service__search', 'fallback__z', 'fallback__a', 'hidden__secret',
    'gateway__identity', 'removed__old', 'disabled__stale'].map((name) => tool(name));
  inventory.push(tool('fallback__private', true), tool('stopped__private', true));
  try {
    await writeFile(config, JSON.stringify(original));
    const services = (await loadConfig(config)).services;
    const text = agentContextText(services, inventory);
    const catalog = JSON.parse(text.split('\n\n').at(-1)!);
    assert.deepEqual(catalog.map((entry: any) => entry.name), ['compact', 'detailed', 'fallback', 'service']);
    assert.equal(catalog.find((entry: any) => entry.name === 'service').description, 'Search and fetch content.');
    assert.deepEqual(catalog.find((entry: any) => entry.name === 'fallback'), { name: 'fallback', description: 'Tools: a, z.' });
    assert.ok(catalog.find((entry: any) => entry.name === 'detailed').tools[0].inputSchema);
    assert.equal(catalog.find((entry: any) => entry.name === 'compact').tools[0].inputSchema, undefined);
    assert.doesNotMatch(text, /secret|private|gateway__identity|removed__old|Unavailable|disabled__stale/);
    assert.equal(agentContextText(services, []), '', 'Removed/disconnected tools leave no service advertisement');
    assert.equal(agentContextTokens(agentContextText([services.find((service) => service.name === 'disabled')!], inventory)), 0);
    await assert.rejects(saveAgentContext(config, 'disabled', 'full', 'off', signal), /disabled.*retained/);
    await saveAgentContext(config, 'compact', 'summary', 'off', signal);
    await saveAgentContext(config, 'detailed', 'full', 'service', signal);
    assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), { ...original, servers: {
      ...original.servers, compact: { ...original.servers.compact, agentContext: 'off' },
      detailed: { ...original.servers.detailed, agentContext: 'service' },
    } });
    await assert.rejects(saveAgentContext(config, 'missing', 'full', 'off', signal), /no longer configured/);
    for (const invalid of [{ description: '' }, { description: 3 }, { agentContext: 'invalid' }]) {
      await writeFile(config, JSON.stringify({ mcpServers: { bad: { command: 'unused', ...invalid } } }));
      await assert.rejects(loadConfig(config), /description must be|agentContext must be/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('inline agent context tree expands only injected schemas, toggles exact raw, and ignores cancelled refreshes', async () => {
  const services: any[] = [
    { name: 'full', agentContext: 'full', description: 'Full service' },
    { name: 'service', agentContext: 'service', description: 'Service summary' },
    { name: 'summary', agentContext: 'summary' },
    { name: 'aaa', agentContext: 'full', enabled: false },
    { name: 'zzz', agentContext: 'full', enabled: false },
    { name: 'z-off', agentContext: 'off' },
    { name: 'z-stopped', agentContext: 'full' },
  ];
  const inventory: any[] = services.filter(({ name }) => name !== 'z-stopped').map(({ name }) => ({ name: `${name}__read`, description: `${name} tool description`,
    inputSchema: { type: 'object', description: 'schema tail ' + 'detail '.repeat(1000) } }));
  const catalog = agentContextCatalog(services, inventory);
  let panel: any, completed = false;
  const pending: { signal: AbortSignal; resolve: (value: any) => void }[] = [];
  const abort = new AbortController(), connection = new AbortController();
  const terminal = { rows: 24, columns: 80 };
  const tui: any = { terminal, requestRender() {}, mode: 'regular' };
  const theme = { fg: (_: string, text: string) => text };
  // Non-default selection bindings must work, too.
  const bindings = { matches: (data: string, action: string) => data === ({
    'tui.select.up': 'k', 'tui.select.down': 'j', 'tui.select.confirm': 'x',
    'tui.select.cancel': 'q', 'tui.select.pageDown': 'd', 'tui.select.pageUp': 'u',
  } as Record<string, string>)[action] };
  const ctx: any = { ui: { custom: async (factory: Function, options: unknown) => {
    assert.equal(options, undefined, 'Native inline screen, not overlay');
    panel = factory(tui, theme, bindings, () => { completed = true; });
  } } };
  await previewAgentContext(ctx, (signal) => new Promise((resolve) => pending.push({ signal, resolve })), abort.signal, connection.signal);
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const render = () => panel.render(terminal.columns) as string[];
  const body = () => render().join('\n');
  try {
    assert.match(body(), /Loading…/);
    await tick(); pending[0].resolve({ services, catalog }); await tick();
    assert.match(body(), /› ▸ full/, 'First service is selected after a slow initial read');
    assert.match(body(), /Full service/);
    assert.doesNotMatch(body(), /full tool description|schema tail/, 'Services start collapsed');
    panel.handleInput('x');
    const full = catalog.find((entry) => entry.name === 'full')!;
    const fullTokens = Math.ceil(JSON.stringify(full.tools![0], null, 2).length / 4).toLocaleString('en-US');
    assert.ok(body().includes(`full__read · ≈${fullTokens} tokens`));
    panel.handleInput('j'); panel.handleInput('x');
    assert.match(body(), /schema tail/);
    const top = body(); panel.handleInput('d');
    assert.notEqual(body(), top, 'Page keys scroll long expanded schemas without changing selection');
    panel.handleInput('k'); render(); panel.handleInput('x'); render();
    panel.handleInput('j');
    assert.match(body(), /Service-only entry/);
    panel.handleInput('x');
    assert.doesNotMatch(body(), /service__read/, 'Service-only entries never invent tools');
    panel.handleInput('j'); render(); panel.handleInput('x'); render();
    panel.handleInput('j'); render(); panel.handleInput('x');
    const summary = catalog.find((entry) => entry.name === 'summary')!;
    const summaryTokens = Math.ceil(JSON.stringify(summary.tools![0], null, 2).length / 4).toLocaleString('en-US');
    assert.ok(body().includes(`summary__read · ≈${summaryTokens} tokens · schema not injected`));
    assert.doesNotMatch(body(), /schema tail/, 'Summary tools never reveal an omitted schema');
    panel.handleInput('\t');
    terminal.rows = 10_000; terminal.columns = 30_000;
    assert.equal(render().slice(3, -4).map((line) => line.trimEnd()).join('\n'), agentContextRaw(catalog));
    panel.handleInput('\t');
    assert.match(body(), /Service-only entry/);
    const tree = body();
    for (const service of services) {
      const entry = catalog.find((entry) => entry.name === service.name);
      const tokens = agentContextTokens(agentContextRaw(entry ? [entry] : [])).toLocaleString('en-US');
      assert.ok(tree.split('\n').some((line) => line.includes(`${service.name} · `) && line.includes(` · ≈${tokens} tokens`)));
    }
    const order = ['full', 'service', 'summary', 'z-off', 'z-stopped', 'aaa', 'zzz'];
    assert.deepEqual([...tree.matchAll(/[▸▾·] ([\w-]+) · Tools · (?:Full schemas|Off|Service name|Tool names)/g)].map((match) => match[1]), order);
    assert.match(tree, /aaa · Tools · Full schemas · ≈0 tokens · disabled \(locked\)/);
    assert.match(tree, /z-(?:off|stopped) · Tools · (?:Off|Full schemas) · ≈0 tokens/);
    assert.doesNotMatch(tree, /aaa__read|zzz__read|z-off__read|z-stopped__read/);
    for (const mode of ['regular', 'fullscreen']) for (const width of [20, 28, 38, 80]) for (const height of [9, 18, 30]) {
      tui.mode = mode; terminal.columns = width; terminal.rows = height;
      const lines = render();
      assert.ok(lines.length <= height - 2, `${mode} ${width}x${height}`);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
    }
    terminal.rows = 24; terminal.columns = 80; render();
    panel.handleInput('r'); await tick();
    panel.handleInput('r'); await tick();
    assert.equal(pending[1].signal.aborted, true);
    pending[2].resolve({ services: [], catalog: [] }); await tick();
    pending[1].resolve({ services, catalog }); await tick();
    assert.doesNotMatch(body(), /Full service/, 'Stale refresh cannot overwrite the newest snapshot');
    panel.handleInput('r'); await tick(); connection.abort();
    pending[3].resolve({ services, catalog }); await tick();
    assert.match(body(), /Gateway disconnected/);
    panel.handleInput('q'); assert.equal(completed, true);
  } finally { panel.dispose(); }
});


test('service context isolates failed services, bounds strict payloads, and rejects cancelled reads', async () => {
  const response = (value: unknown) => ({ contents: [{ mimeType: SERVICE_CONTEXT_MIME, text: JSON.stringify(value) }] });
  for (const value of [{ version: 2, text: '' }, { version: 1, text: '', extra: true }, { version: 1, text: 'x'.repeat(64_001) }]) {
    assert.throws(() => parseServiceContext(response(value)), /Invalid/);
  }
  assert.equal(parseServiceContext(response({ version: 1, text: 'x'.repeat(64_000) } )).length, 64_000);
  assert.throws(() => parseServiceContext({ contents: [], padding: 'x'.repeat(512_000) }), /Oversized/);
  const calls: string[] = [], warnings: string[] = [];
  const client = { readResource: async ({ uri }: any) => {
    calls.push(uri);
    if (uri === 'bad') throw Error('private task');
    return response({ version: 1, text: '<data> current task' });
  } };
  const host = new ServiceContext(() => client as any, () => ({ 'native-ui/context': { conversationId: 'conversation', contextId: 'context', state: {} } }));
  host.resources.set('good', { uri: 'good' }); host.resources.set('bad', { uri: 'bad' });
  const services = ['good', 'bad', 'off', 'disabled'].map((name) => ({ name, additionalContext: name !== 'off', enabled: name !== 'disabled' } as any));
  const signal = new AbortController();
  const entries = await host.read(services, signal.signal, 100, (name) => warnings.push(name));
  assert.deepEqual(calls.sort(), ['bad', 'good']);
  assert.deepEqual(warnings, ['bad']);
  assert.deepEqual(entries[0], { service: 'bad', status: 'unavailable' });
  assert.doesNotMatch(serviceContextRaw(entries), /<data>|private task/);
  signal.abort();
  await assert.rejects(host.read(services, signal.signal, 100, () => assert.fail()));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pendingSignal = new AbortController();
  client.readResource = async () => { await gate; return response({ version: 1, text: 'late private task' }); };
  const pending = host.read([services[0]], pendingSignal.signal, 100, () => assert.fail());
  pendingSignal.abort(); release();
  await assert.rejects(pending, 'Cancellation discards an already-started late read');

  let panel: any;
  const terminal = { rows: 30, columns: 100 };
  const preview: any = { ui: { custom: async (factory: Function) => {
    panel = factory({ terminal, requestRender() {} }, { fg: (_: string, text: string) => text }, getKeybindings(), () => {});
  } } };
  await previewAgentContext(preview, async () => ({ services: [services[0]], catalog: [], additional: [{ service: 'good', text: 'Current task details' }] }), new AbortController().signal);
  await new Promise((resolve) => setImmediate(resolve));
  try {
    const body = () => panel.render(terminal.columns).join('\n');
    assert.match(body(), /Additional context · gateway_service_context/);
    assert.doesNotMatch(body(), /Current task details/, 'Additional content starts collapsed');
    panel.handleInput('\x1b[B'); body(); panel.handleInput('\r');
    assert.match(body(), /Current task details/);
    panel.handleInput('\t');
    assert.match(body(), /<gateway_service_context>/, 'Raw view retains the exact injected section');
  } finally { panel.dispose(); }
});
