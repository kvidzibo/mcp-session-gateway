import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import registerGateway from '../pi/runtime.js';

// Service/UI tests must never fetch or install into the checkout hosting this test.
const gatewayExtension = (pi: Parameters<typeof registerGateway>[0]) => registerGateway(pi, async () => {});
import { toggleServiceEnabled } from '../pi/auto-update.js';
import { loadConfig } from '../src/config.js';

test('service controls persist enable/disable safely and only change launches after confirmed restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-enabled-'));
  const config = join(dir, 'gateway.json'), target = join(dir, 'actual.json');
  const commands = new Map<string, any>(), handlers = new Map<string, Function>(), tools = new Map<string, any>();
  const navigation: string[] = [], notices: string[] = [];
  let approve = false, confirmations = 0;
  gatewayExtension({
    registerFlag() {}, getFlag: () => config, registerEntryRenderer() {}, events: { on() {} }, appendEntry() {},
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (event: string, handler: Function) => handlers.set(event, handler),
  } as any);
  const ctx: any = { cwd: dir, mode: 'tui', hasUI: true, isIdle: () => true,
    sessionManager: { getBranch: () => [], getSessionId: () => 'enabled-test' },
    ui: { theme: { fg: (_color: string, text: string) => text }, setStatus() {}, setWidget() {},
      notify: (text: string) => notices.push(text),
      custom: async (factory: Function) => {
        let answer: unknown;
        const terminal = { rows: 30, columns: 100 };
        const panel = factory({ terminal, requestRender() {} }, ctx.ui.theme, {}, (value: unknown) => { answer = value; });
        const render = () => panel.render(98) as string[];
        try {
          if (render()[1] === 'Restart gateway services?') {
            confirmations++;
            if (approve) {
              for (let i = 0; i < 100 && !render().join('\n').includes('Enter stop and restart'); i++) panel.handleInput('\x1b[6~');
              assert.match(render().join('\n'), /Enter stop and restart/);
            }
            panel.handleInput(approve ? '\r' : '\x1b');
          } else {
            const choice = navigation.shift();
            assert.ok(choice, `Unexpected menu: ${render().join('\n')}`);
            for (const width of [38, 80, 100]) {
              terminal.columns = width;
              const lines: string[] = panel.render(width - 2);
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
  const inventory = async () => JSON.parse((await tools.get('gateway_tools').execute('test', {})).content[0].text).map((tool: any) => tool.name);
  const menu = async (...choices: string[]) => {
    navigation.push(...choices);
    await commands.get('gateway').handler('', ctx);
    assert.deepEqual(navigation, []);
  };
  try {
    await symlink(target, config);
    for (const key of ['mcpServers', 'servers']) {
      const demo = { enabled: false, command: process.execPath, args: [new URL('../dist/examples/demo-service.js', import.meta.url).pathname], env: { RAW: '${PATH}' } };
      await writeFile(target, JSON.stringify({ [key]: { demo, unused: { enabled: false, command: '/missing', env: { SECRET: '${GATEWAY_ENABLED_TEST_UNSET}' } } }, display: 'minimal' }));
      await chmod(target, 0o640);
      await handlers.get('session_start')!({}, ctx);
      assert.deepEqual(await inventory(), ['gateway__identity'], 'All-disabled configurations still connect; disabled env is not expanded');
      await menu('Services', 'demo (disabled)', 'Enable service', 'Back', 'Back', 'Close');
      const raw = JSON.parse(await readFile(target, 'utf8'));
      assert.equal(raw[key].demo.enabled, true);
      assert.deepEqual(raw[key].demo.env, demo.env, 'Never save expanded credentials');
      assert.equal(raw.display, 'minimal');
      assert.equal((await lstat(config)).isSymbolicLink(), true);
      assert.equal((await stat(target)).mode & 0o777, 0o640);
      await assert.rejects(toggleServiceEnabled(config, 'demo', false, new AbortController().signal), /changed in another session/);
      assert.deepEqual(await inventory(), ['gateway__identity'], 'Saving does not launch a service');
      await menu('Services', 'demo', 'Connection / restart…', 'Restart gateway services…', 'Back', 'Close');
      assert.deepEqual(await inventory(), ['gateway__identity'], 'Declining restart does not apply the saved choice');
      approve = true;
      await menu('Connection', 'Restart gateway services…', 'Back', 'Close');
      assert.ok((await inventory()).includes('demo__increment'));
      await menu('Services', 'unused (disabled)', 'Enable service', 'Connection / restart…', 'Restart gateway services…', 'Close');
      assert.ok(notices.some((text) => text.includes('Missing environment variable')));
      assert.ok((await inventory()).includes('demo__increment'), 'Invalid enabled-service environment must not stop healthy running services');
      await menu('Services', 'unused', 'Disable service', 'Back', 'Back', 'Close');
      await menu('Services', 'demo', 'Disable service', 'Back', 'Back', 'Close');
      assert.ok((await inventory()).includes('demo__increment'), 'Disabling does not interrupt a running service');
      await menu('Connection', 'Restart gateway services…', 'Back', 'Close');
      assert.deepEqual(await inventory(), ['gateway__identity']);
      await handlers.get('session_shutdown')!({}, ctx);
      // Configuration controls remain available even without a connection.
      await menu('Services', 'demo (disabled)', 'Enable service', 'Back', 'Back', 'Close');
      assert.equal((await loadConfig(config)).services[0].enabled, true);
      await menu('Services', 'unused (disabled)', 'Enable service', 'Back', 'Back', 'Close');
      await assert.rejects(loadConfig(config), /Missing environment variable/);
      await menu('Services', 'unused', 'Disable service', 'Back', 'Back', 'Close');
      assert.equal((await loadConfig(config)).services[1].enabled, false, 'Missing launch credentials must not block recovery controls');
      const before = await readFile(target, 'utf8');
      const cancelled = new AbortController(); cancelled.abort();
      await assert.rejects(toggleServiceEnabled(config, 'demo', true, cancelled.signal));
      assert.equal(await readFile(target, 'utf8'), before);
      approve = false;
    }
    assert.equal(confirmations, 8);
    assert.ok(notices.some((text) => text.includes('running services unchanged')));
    await writeFile(target, JSON.stringify({ mcpServers: { bad: { command: 'node', enabled: 'false' } } }));
    await assert.rejects(loadConfig(config), /enabled must be a boolean/);
  } finally {
    await handlers.get('session_shutdown')!({}, ctx);
    await rm(dir, { recursive: true, force: true });
  }
});
