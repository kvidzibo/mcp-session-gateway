import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { visibleWidth } from '@earendil-works/pi-tui';
import registerGateway from '../pi/runtime.js';
import { agentContextText, agentContextTokens } from '../pi/agent-context.js';
import { readAgentContext, saveAgentContext } from '../pi/auto-update.js';
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
        const panel = factory({ terminal, requestRender() {} }, ctx.ui.theme, {}, (value: unknown) => { answer = value; });
        const render = () => panel.render(terminal.columns - 2) as string[];
        try {
          if (render()[0].includes('Agent context › Preview')) {
            for (let i = 0; i < 100 && render().join('\n').includes('Loading…'); i++) await new Promise((resolve) => setTimeout(resolve, 10));
            terminal.rows = 10_000; terminal.columns = 30_000;
            const body = render().slice(1, -2).join('\n');
            assert.match(body, /≈[\d,]+ tokens · rough estimate/);
            previews.push(body.split('\n').slice(2).join('\n'));
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
    assert.match(previews.pop()!, /Injection is off/);
    assert.equal(await readAgentContext(config), 'off', 'Preview never changes the preference');
    const inventory = JSON.parse((await tools.get('gateway_tools').execute('', {})).content[0].text);
    inventory.push({ name: 'demo__long', description: 'x'.repeat(21_000) + '\u202etail', inputSchema: { type: 'object' } });
    t.mock.method(Client.prototype, 'listTools', async () => ({ tools: inventory }));
    for (const [mode, label] of [['summary', 'Names & descriptions'], ['full', 'Full schemas']] as const) {
      await menu(`Injection: ${mode === 'summary' ? 'Off' : 'Names & descriptions'}`, label, 'Preview injected context');
      assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), { ...original, agentContext: mode }, 'Preserve raw env and unrelated configuration');
      await before();
      assert.equal(sections.gateway_tools, agentContextText(mode, inventory));
      assert.equal(previews.pop(), sections.gateway_tools, 'Preview and injected content match exactly');
      assert.match(sections.gateway_tools, /demo__increment/);
      if (mode === 'summary') assert.doesNotMatch(sections.gateway_tools, /inputSchema/);
      else assert.match(sections.gateway_tools, /inputSchema/);
      assert.ok(agentContextTokens(sections.gateway_tools) > 0);
      const first: string = sections.gateway_tools;
      await before();
      assert.equal(sections.gateway_tools, first, 'Repeated runs replace instead of duplicating the catalog');
    }
    const appOnly: any = { name: 'private', inputSchema: { type: 'object' }, _meta: { ui: { visibility: ['app'] } } };
    assert.doesNotMatch(agentContextText('full', [appOnly]), /private/);
    await assert.rejects(saveAgentContext(config, 'off', 'summary', ctx.signal), /changed in another session/);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(saveAgentContext(config, 'full', 'off', aborted.signal));
    assert.equal(await readAgentContext(config), 'full');
    await handlers.get('session_shutdown')!({}, ctx);
    await before();
    assert.equal(sections.gateway_tools, undefined, 'Disconnect cannot leave a stale catalog');
    assert.ok(notices.some((message) => message.includes('Gateway agent context unavailable')));
    // A fresh start (including reload/resume/fork) uses the saved preference.
    await handlers.get('session_start')!({ reason: 'resume' }, ctx);
    await before();
    assert.match(sections.gateway_tools, /inputSchema/);
    await menu('Injection: Full schemas', 'Off');
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
