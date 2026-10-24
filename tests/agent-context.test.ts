import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getKeybindings, visibleWidth } from '@earendil-works/pi-tui';
import registerGateway from '../pi/runtime.js';
import { agentContextCatalog, agentContextRaw, agentContextText, agentContextTokens, agentContextLabels } from '../pi/agent-context.js';
import { previewAgentContext } from '../pi/agent-context-preview.js';
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
            for (const width of [30, 38, 80, 100]) {
              terminal.columns = width;
              const lines: string[] = render();
              assert.ok(lines.length <= terminal.rows - 2);
              assert.ok(lines.every((line) => visibleWidth(line) <= width - 2));
            }
            for (let i = 0; i < 30 && !render().includes(`→ ${choice}`); i++) panel.handleInput('\x1b[B');
            assert.ok(render().includes(`→ ${choice}`), `Missing ${choice}`);
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
      await menu(`demo: ${previous}`, 'Preview injected context');
      previous = agentContextLabels[mode];
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
    const saved = JSON.parse(await readFile(config, 'utf8'));
    saved.mcpServers.demo.enabled = false;
    await writeFile(config, JSON.stringify(saved));
    await before();
    assert.equal(sections.gateway_tools, undefined, 'Disabled config excludes still-running inventory immediately');
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
    await menu('demo: Service name & description');
    await before();
    assert.deepEqual({ ...sections }, { other: 'preserved' });
    assert.equal(agentContextTokens(''), 0);
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
    assert.deepEqual([...tree.matchAll(/[▸▾·] ([\w-]+) · (?:Full schemas|Off|Service name|Tool names)/g)].map((match) => match[1]), order);
    assert.match(tree, /aaa · Full schemas · ≈0 tokens · disabled \(locked\)/);
    assert.match(tree, /z-(?:off|stopped) · (?:Off|Full schemas) · ≈0 tokens/);
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
