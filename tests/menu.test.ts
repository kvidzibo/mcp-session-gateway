import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getKeybindings, visibleWidth } from '@earendil-works/pi-tui';
import { GatewayMenu } from '../pi/menu.js';
import registerGateway from '../pi/runtime.js';

// Service/UI tests must never fetch or install into the checkout hosting this test.
const gatewayExtension = (pi: Parameters<typeof registerGateway>[0]) => registerGateway(pi, async () => {});
import { PackageManager } from '../src/package-manager.js';

const down = '\x1b[B', escape = '\x1b';
const theme = { fg: (_color: string, text: string) => text };

test('/pi-services opens Services directly, preserves Back navigation, and falls back to recovery when disconnected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-services-'));
  const config = join(dir, 'gateway.json');
  const commands = new Map<string, any>(), handlers = new Map<string, Function>();
  const screens: string[] = [], notices: string[] = [];
  const navigation: string[] = [];
  gatewayExtension({
    registerFlag() {}, getFlag: () => config, registerEntryRenderer() {}, events: { on() {} }, registerTool() {},
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (event: string, handler: Function) => handlers.set(event, handler), appendEntry() {},
  } as any);
  const ctx: any = { cwd: dir, mode: 'tui', hasUI: true,
    sessionManager: { getBranch: () => [], getSessionId: () => 'services-test' },
    ui: { theme, notify: (text: string) => notices.push(text), setStatus() {}, setWidget() {},
      custom: async (factory: Function) => {
        let answer: unknown;
        const panel = factory({ terminal: { rows: 30, columns: 100 }, requestRender() {} }, theme, {}, (value: unknown) => { answer = value; });
        try {
          const render = () => panel.render(98) as string[];
          screens.push(render()[1]);
          if (render()[1] === 'Gateway › Services › demo') {
            const actions = render().filter((line) => /^(→ |  )\S/.test(line)).map((line) => line.slice(2));
            assert.deepEqual(actions, [
              ...(screens[0] === 'Gateway › Services' ? ['Resources'] : []),
              'Connection / restart…', 'Disable service', 'Back',
            ], 'Unavailable actions are hidden; recovery precedes enable/disable');
          }
          const target = navigation.shift();
          assert.ok(target, 'No unexpected dialog');
          for (let i = 0; i < 20 && !render().includes(`→ ${target}`); i++) panel.handleInput(down);
          assert.ok(render().includes(`→ ${target}`), `Missing ${target}`);
          panel.handleInput('\r');
          return answer;
        } finally { panel.dispose(); }
      },
    },
  };
  try {
    await writeFile(config, JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: [new URL('../dist/examples/demo-service.js', import.meta.url).pathname] } } }));
    await handlers.get('session_start')!({}, ctx);
    for (let visit = 0; visit < 2; visit++) {
      screens.length = 0;
      navigation.push('demo', 'Back', 'Back', 'Close');
      await commands.get('pi-services').handler('', ctx);
      assert.deepEqual(screens, ['Gateway › Services', 'Gateway › Services › demo', 'Gateway › Services', 'Gateway']);
      assert.deepEqual(navigation, []);
    }
    await handlers.get('session_shutdown')!({}, ctx);
    screens.length = 0;
    navigation.push('Services', 'demo', 'Back', 'Back', 'Close');
    await commands.get('pi-services').handler('', ctx);
    assert.deepEqual(screens, ['Gateway', 'Gateway › Services', 'Gateway › Services › demo', 'Gateway › Services', 'Gateway'],
      'Disconnected shortcut keeps service and recovery navigation available');
    await commands.get('pi-services').handler('', { ...ctx, mode: 'rpc' });
    assert.deepEqual(notices, ['Gateway menus require TUI mode']);
  } finally {
    await handlers.get('session_shutdown')!({}, ctx);
    await rm(dir, { recursive: true, force: true });
  }
});

test('Update all packages confirms once, updates unlinked active packages with Auto update off, and reports failures without restarting', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-update-all-'));
  const config = join(dir, 'gateway.json');
  const commands = new Map<string, any>(), notices: string[] = [], prepared: string[] = [], activated: string[] = [];
  let approve = false, idle = true, opened = false, previews = '', results = '', cancel = false;
  let cancelReady!: () => void;
  const cancellationReady = new Promise<void>((resolve) => { cancelReady = resolve; });
  const source = JSON.stringify({ autoUpdate: false, autoUpdateConcurrency: 1,
    packages: { 'missing-local': { source: { type: 'local', path: join(dir, 'missing') },
      localUpdate: { validate: [{ command: 'node', args: ['--version'] }] } },
      ...Object.fromEntries(['alpha', 'broken', 'inactive'].map((name) => [name, {
        source: { type: 'npm', name }, managed: { validate: [{ command: 'node', args: ['--version'] }] },
      }])) }, mcpServers: { demo: { command: 'unused' } },
  });
  t.mock.method(PackageManager.prototype, 'state', async (pkg: any) => ({
    version: 1, source: '', revision: 'test',
    ...(pkg.name === 'inactive' ? {} : { active: { id: 'old', version: '1.0.0' } }),
    ...(prepared.includes(pkg.name) ? { prepared: { id: 'new', version: '2.0.0' } } : {}),
  }));
  t.mock.method(PackageManager.prototype, 'plan', async () => ({ version: '2.0.0', from: '1.0.0', revision: 'test', definition: '' }));
  t.mock.method(PackageManager.prototype, 'prepare', async (pkg: any, _plan: unknown, signal: AbortSignal) => {
    if (pkg.name === 'broken') {
      if (cancel) { cancelReady(); if (!signal.aborted) await once(signal, 'abort'); signal.throwIfAborted(); }
      throw new Error('validation failed');
    }
    prepared.push(pkg.name);
  });
  t.mock.method(PackageManager.prototype, 'activate', async (pkg: any) => { activated.push(pkg.name); });
  gatewayExtension({
    registerFlag() {}, getFlag: () => config, registerEntryRenderer() {}, events: { on() {} }, registerTool() {}, on() {},
    registerCommand: (name: string, command: any) => commands.set(name, command),
    appendEntry() { assert.fail('Manual updates must not send model/session entries'); },
  } as any);
  const ctx: any = { cwd: dir, mode: 'tui', hasUI: true, isIdle: () => idle,
    ui: { theme, notify: (text: string) => notices.push(text), custom: async (factory: Function) => {
      let done!: (value: unknown) => void, settled = false;
      const answer = new Promise((resolve) => { done = (value) => { settled = true; resolve(value); }; });
      const panel = factory({ terminal: { rows: 24, columns: 80 }, requestRender() {} }, theme, {}, done);
      const render = () => panel.render(78) as string[];
      try {
        const lines = render();
        if (lines.includes('Gateway')) {
          const target = opened ? 'Close' : 'Update all packages'; opened = true;
          for (let i = 0; i < 20 && !render().includes(`→ ${target}`); i++) panel.handleInput(down);
          assert.ok(render().includes(`→ ${target}`)); panel.handleInput('\r');
        } else if (lines.includes('Update all packages?')) {
          panel.handleInput('\r');
          assert.equal(settled, false, 'Must review every disclosure before confirming');
          for (let i = 0; i < 100; i++) {
            const page = render(); previews += page.join('\n');
            if (page.includes('Enter update all  Esc cancel')) break;
            panel.handleInput('\x1b[6~');
          }
          assert.ok(render().includes('Enter update all  Esc cancel'));
          panel.handleInput(approve ? '\r' : escape);
        } else if (lines[0] === 'Package update results') {
          results = lines.join('\n'); panel.handleInput(escape);
        } else {
          assert.equal(lines[0], 'Updating all packages');
          if (cancel) { await cancellationReady; panel.handleInput(escape); }
        }
        return await answer;
      } finally { panel.dispose(); }
    } },
  };
  try {
    await writeFile(config, source);
    await commands.get('gateway').handler('', ctx);
    assert.deepEqual(prepared, [], 'Decline performs no updates');
    assert.match(previews, /IN PLACE/); assert.match(previews, /Commands and limits/);
    approve = true; opened = false;
    await commands.get('gateway').handler('', ctx);
    assert.deepEqual(prepared, ['alpha']); assert.deepEqual(activated, ['alpha']);
    assert.match(results, /alpha: 1.0.0 → 2.0.0/); assert.match(results, /broken: Error: validation failed/);
    assert.match(results, /Services were not restarted/); assert.match(results, /missing-local: Error:/);
    assert.equal(await readFile(config, 'utf8'), source, 'Auto update and raw config stay unchanged');
    cancel = true; opened = false;
    await commands.get('gateway').handler('', ctx);
    assert.match(results, /Update run stopped:/); assert.match(results, /alpha: 1.0.0 → 2.0.0/);
    assert.deepEqual(activated, ['alpha', 'alpha'], 'Completed activation survives cancellation of the later package');
    idle = false; opened = false;
    await commands.get('gateway').handler('', ctx);
    assert.deepEqual(notices, ['Wait for the current agent turn to finish before updating packages']);
    assert.deepEqual(activated, ['alpha', 'alpha']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Auto update toggles and saves from the root, preserves raw config, and refuses failed or stale saves', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-auto-update-'));
  const target = join(dir, 'actual.json'), config = join(dir, 'gateway.json');
  const lock = `${target}.auto-update.lock`;
  const commands = new Map<string, any>();
  const notices: string[] = [];
  let visit = 0;
  gatewayExtension({
    registerFlag() {}, getFlag: () => config, registerEntryRenderer() {}, events: { on() {} }, registerTool() {}, on() {},
    registerCommand: (name: string, command: any) => commands.set(name, command),
    appendEntry() { assert.fail('Toggling must not add model/session entries'); },
  } as any);
  const original = { mcpServers: { demo: { command: 'unused', env: { SECRET: '${KEEP_THIS_REFERENCE}' } } }, extra: { untouched: true } };
  const read = async () => JSON.parse(await readFile(target, 'utf8'));
  const ctx: any = { cwd: dir, mode: 'tui', hasUI: true, ui: { theme,
    notify: (text: string) => notices.push(text),
    custom: async (factory: Function) => {
      let answer: unknown;
      const terminal = { rows: 24, columns: 80 };
      const panel = factory({ terminal, requestRender() {} }, theme, {}, (value: unknown) => { answer = value; });
      const render = () => panel.render(terminal.columns - 2) as string[];
      try {
        const current = visit++;
        const label = `Auto update: ${[1, 4].includes(current) ? 'On' : current === 7 ? 'Unavailable' : 'Off'}`;
        assert.ok(render().includes('Gateway'), 'No confirmation or settings subdialog');
        assert.match(render().join('\n'), /Disconnected/);
        for (let i = 0; i < 8 && !render().includes(`→ ${label}${current === 7 ? ' (unavailable)' : ''}`); i++) panel.handleInput(down);
        assert.ok(render().some((line) => line.includes(`→ ${label}`)));
        if (current === 1) assert.equal((await read()).autoUpdate, true);
        if ([2, 3, 5, 6].includes(current)) assert.equal((await read()).autoUpdate, false);
        for (const columns of [38, 80]) {
          terminal.columns = columns;
          const lines = render();
          assert.ok(lines.length <= terminal.rows - 2);
          assert.ok(lines.every((line) => visibleWidth(line) <= columns - 2));
        }
        if (current === 0) await writeFile(target, JSON.stringify({ ...original, concurrentField: 'preserved' }));
        if (current === 2) await writeFile(lock, 'busy');
        if (current === 3) {
          await rm(lock);
          await writeFile(target, JSON.stringify({ ...await read(), autoUpdate: true }));
        }
        panel.handleInput(current >= 5 ? escape : '\r');
        if (current === 7) assert.equal(await readFile(target, 'utf8'), '{invalid');
        return answer;
      } finally { panel.dispose(); }
    },
  } };
  try {
    await writeFile(target, JSON.stringify(original), { mode: 0o640 });
    await symlink(target, config);
    await commands.get('gateway').handler('', ctx);
    await commands.get('gateway').handler('', ctx);
    assert.equal(visit, 7, 'Reopening reads the persisted value');
    assert.deepEqual(await read(), { ...original, concurrentField: 'preserved', autoUpdate: false });
    assert.equal((await stat(target)).mode & 0o777, 0o640);
    assert.equal((await readFile(config, 'utf8')), await readFile(target, 'utf8'), 'Symlink target was updated');
    assert.equal(notices.filter((text) => text.includes('saved for next startup/reload')).length, 3);
    assert.ok(notices.some((text) => text.includes('Another session is saving')));
    assert.ok(notices.some((text) => text.includes('changed in another session')));
    await writeFile(target, '{invalid');
    await commands.get('gateway').handler('', ctx);
    assert.equal(visit, 8);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('service controls open apps; Tab opens private settings and returns to the caller', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-app-tab-'));
  const config = join(dir, 'gateway.json');
  const commands = new Map<string, any>(), handlers = new Map<string, Function>();
  const screens: string[] = [], notices: string[] = [];
  const steps = [
    ['Gateway › Services', '\t'], ['Service settings', escape],
    ['Gateway › Services', '\r'], ['Gateway › Services › demo', 'open-app'],
    ['Service app', '\t'], ['Service settings', escape],
    ['Service app', '\x0f'], ['Gateway › Services › demo', escape],
    ['Gateway › Services', '\r'], ['Gateway › Services › demo', '\r'], ['Service app', escape],
    ['Gateway › Services', escape], ['Gateway', escape],
  ];
  const fixture = `
    import {Server} from '@modelcontextprotocol/sdk/server/index.js';
    import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
    import {ListToolsRequestSchema,ListResourcesRequestSchema,ReadResourceRequestSchema} from '@modelcontextprotocol/sdk/types.js';
    import {z} from 'zod';
    const contract = {version:1,getMethod:'kvidzibo/settings/get',updateMethod:'kvidzibo/settings/update',authorization:'token',audience:'operator',title:'Roles'};
    const token = process.env.SERVICE_SETTINGS_TOKEN;
    delete process.env.SERVICE_SETTINGS_TOKEN;
    const server = new Server({name:'demo',version:'1'}, {capabilities:{tools:{},resources:{},experimental:{'native-ui-v1':{},'com.kvidzibo/settings':contract}}});
    server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[]}));
    server.setRequestHandler(ListResourcesRequestSchema,async()=>({resources:[{uri:'test://app',name:'App',mimeType:'application/vnd.mcp-native-ui+json'}]}));
    server.setRequestHandler(ReadResourceRequestSchema,async()=>({contents:[{uri:'test://app',mimeType:'application/vnd.mcp-native-ui+json',text:JSON.stringify({version:1,title:'Service app',revision:'r1',state:{},controls:[]})}]}));
    server.setRequestHandler(z.object({method:z.literal('kvidzibo/settings/get'),params:z.object({token:z.string()})}),async r=>{
      if(r.params.token!==token) throw Error('Unauthorized');
      return {schemaVersion:1,title:'Service settings',revision:'r1',writable:true,schema:{type:'object',properties:{enabled:{type:'boolean'}}},values:{enabled:true}};
    });
    await server.connect(new StdioServerTransport());
  `;
  gatewayExtension({
    registerFlag() {}, getFlag: () => config, registerEntryRenderer() {}, events: { on() {} }, registerTool() {},
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (event: string, handler: Function) => handlers.set(event, handler), appendEntry() {},
  } as any);
  const ctx: any = { cwd: dir, mode: 'tui', hasUI: true,
    sessionManager: { getBranch: () => [], getSessionId: () => 'app-tab-test' },
    ui: { theme, notify: (text: string) => notices.push(text), setStatus() {}, setWidget() {},
      custom: async (factory: Function) => {
        let answer: unknown, finished = false;
        const terminal = { rows: 30, columns: 100 };
        const panel = factory({ terminal, requestRender() {} }, theme, {}, (value: unknown) => { answer = value; finished = true; });
        try {
          const lines: string[] = panel.render(98);
          const step = steps.shift();
          assert.ok(step, `Unexpected dialog: ${lines.join('\n')}`);
          assert.ok(lines.includes(step[0]), `Expected ${step[0]}: ${lines.join('\n')}`);
          screens.push(step[0]);
          for (const columns of [38, 80, 100]) {
            terminal.columns = columns;
            const rendered: string[] = panel.render(columns - 2);
            assert.ok(rendered.length <= terminal.rows - 2);
            assert.ok(rendered.every((line) => visibleWidth(line) <= columns - 2));
            if (step[0] === 'Gateway › Services' || step[0] === 'Service app') assert.match(rendered.join('\n'), /Tab settings/);
            if (step[0] === 'Gateway › Services › demo') assert.match(rendered.join('\n'), /Roles/);
          }
          if (step[1] === 'open-app') {
            for (let i = 0; i < 10 && !panel.render(98).includes('→ Open app'); i++) panel.handleInput(down);
            assert.ok(panel.render(98).includes('→ Open app'));
            panel.handleInput('\r');
          } else panel.handleInput(step[1]);
          assert.ok(finished, 'Shortcut must complete the current overlay before opening another');
          return answer;
        } finally { panel.dispose(); }
      },
    },
  };
  try {
    await writeFile(config, JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: ['--input-type=module', '-e', fixture], cwd: new URL('../', import.meta.url).pathname, settings: { tokenEnv: 'SERVICE_SETTINGS_TOKEN' } } } }));
    await handlers.get('session_start')!({}, ctx);
    await commands.get('pi-services').handler('', ctx);
    assert.deepEqual(steps, []);
    assert.equal(screens.filter((screen) => screen === 'Service settings').length, 2);
    assert.deepEqual(notices, [], 'Navigation does not issue writes, actions, or model turns');
  } finally {
    await handlers.get('session_shutdown')!({}, ctx);
    await rm(dir, { recursive: true, force: true });
  }
});

test('gateway navigation is compact and inline, with native selection bindings and unavailable explanations', async () => {
  const keys = getKeybindings(), original = keys.getUserBindings();
  const terminal = { rows: 30, columns: 100 };
  let visit = 0;
  try {
    keys.setUserBindings({ ...original, 'tui.select.up': 'ctrl+p', 'tui.select.down': 'ctrl+n',
      'tui.select.confirm': 'ctrl+y', 'tui.select.cancel': 'ctrl+x' });
    const menu = new GatewayMenu({ ui: { custom: async (factory: Function, options: unknown) => {
      assert.equal(options, undefined, 'Use Pi’s normal inline area, not an overlay');
      let answer: unknown, finished = false;
      const panel = factory({ terminal, requestRender() {} }, theme, {}, (value: unknown) => { answer = value; finished = true; });
      try {
        const render = () => panel.render(98) as string[];
        assert.ok(render().length <= 12, 'Short menus do not reserve empty description rows');
        assert.match(render().join('\n'), /ctrl\+p\/ctrl\+n.*ctrl\+y.*ctrl\+x/);
        if (visit++ === 0) {
          panel.handleInput('\x10');
          assert.ok(render().includes('Connect first.'));
          panel.handleInput('\x19');
          assert.equal(finished, false, 'Unavailable actions cannot run');
          panel.handleInput('\x0e');
          panel.handleInput('\x19');
        } else {
          terminal.rows = 8; terminal.columns = 16;
          panel.render(14);
          panel.handleInput('\x18');
        }
        assert.ok(finished);
        return answer;
      } finally { panel.dispose(); }
    } } } as any, new AbortController().signal);
    const items = [{ id: 'app', label: 'Open app', description: 'Connect first.', disabled: true },
      { id: 'services', label: 'Services', description: 'Choose a service.' }];
    assert.equal(await menu.choose(['Gateway'], 'Disconnected', items), 'services');
    assert.equal(await menu.choose(['Gateway'], 'Disconnected', items), undefined);
  } finally { keys.setUserBindings(original); }
});

test('one gateway menu preserves navigation, bounds rendering, and recovers after failed and successful restarts', async () => {
  const controller = new AbortController();
  const terminal = { rows: 24, columns: 80 };
  let visit = 0;
  const menu = new GatewayMenu({ ui: { custom: async (factory: Function) => {
    let answer: unknown, finished = false;
    const panel = factory({ terminal, requestRender() {} }, theme, {}, (value: unknown) => { answer = value; finished = true; });
    const render = () => {
      const lines: string[] = panel.render(terminal.columns - 2);
      assert.ok(lines.length <= terminal.rows - 2);
      assert.ok(lines.every((line) => visibleWidth(line) <= terminal.columns - 2));
      return lines;
    };
    try {
      render();
      if (visit++ === 0) {
        assert.ok(render().includes('→ Service 1'), 'Default focus starts on an available action');
        panel.handleInput('\x1b[A');
        panel.handleInput('\r');
        assert.equal(finished, false, 'Disabled actions explain availability but cannot run');
        for (let i = 0; i < 21; i++) { panel.handleInput(down); render(); }
        assert.ok(render().includes('→ Service 21'));
        terminal.rows = 16; terminal.columns = 40;
        panel.handleInput('\r');
        assert.equal(finished, false, 'Resize invalidates the old geometry before selection');
        assert.ok(render().includes('→ Service 21'));
        panel.handleInput('\r');
        assert.equal(answer, '21');
      } else {
        assert.ok(render().includes('→ Service 21'), 'Back restores the selected item');
        terminal.rows = 8; terminal.columns = 16;
        render(); panel.handleInput('\r');
        assert.equal(finished, false, 'Tiny terminal cannot dispatch hidden actions');
        controller.abort(); assert.equal(finished, true, 'Shutdown closes navigation');
      }
      return answer;
    } finally { panel.dispose(); }
  } } } as any, controller.signal);
  const items = Array.from({ length: 30 }, (_, i) => ({ id: String(i), label: `Service ${i}`, description: 'Wide 字 and long descriptions remain bounded. '.repeat(4), disabled: i === 0 }));
  assert.equal(await menu.choose(['Gateway', 'Services'], 'Configured services', items), '21');
  assert.equal(await menu.choose(['Gateway', 'Services'], 'Configured services', items), undefined);

  const dir = await mkdtemp(join(tmpdir(), 'gateway-menu-'));
  const config = join(dir, 'gateway.json');
  const commands = new Map<string, any>(), handlers = new Map<string, Function>(), events = new Map<string, Function>();
  const notices: string[] = [];
  const navigation = ['Connection', 'Restart gateway services…', 'Connection', 'Restart gateway services…', 'Back', 'Packages', 'Installed versions', 'Back', 'Close'];
  let restartAttempts = 0, rootVisits = 0, appsOpened = 0;
  gatewayExtension({
    registerFlag() {}, getFlag: () => config, registerEntryRenderer() {}, events: { on: (name: string, handler: Function) => events.set(name, handler) },
    registerTool() {}, registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (event: string, handler: Function) => handlers.set(event, handler), appendEntry() {},
  } as any);
  assert.deepEqual([...commands.keys()], ['gateway', 'pi-services']);
  let queryReply: any;
  events.get('gateway:query-service-tool')!({ service: 'pinote', tool: 'get_current', respond: (value: unknown) => { queryReply = value; } });
  assert.equal(queryReply.handled, true, 'Unknown startup ownership must not fall through to an unrelated cwd selection');
  assert.match(queryReply.error, /not ready/);
  const ctx: any = { cwd: dir, mode: 'tui', hasUI: true, isIdle: () => true,
    sessionManager: { getBranch: () => [], getSessionId: () => 'menu-test' },
    ui: {
      theme, notify: (text: string) => notices.push(text), setStatus() {}, setWidget() {},
      custom: async (factory: Function) => {
        let answer: unknown;
        const panel = factory({ terminal: { rows: 30, columns: 100 }, requestRender() {} }, theme, {}, (value: unknown) => { answer = value; });
        const render = () => panel.render(98) as string[];
        try {
          const lines = render();
          if (lines[1] === 'Gateway › Services › alpha') {
            assert.deepEqual(lines.filter((line) => /^(→ |  )\S/.test(line)).map((line) => line.slice(2)),
              ['Open app', 'Resources', 'Connection / restart…', 'Disable service', 'Back']);
          }
          if (lines[0] === 'Healthy app') { appsOpened++; panel.handleInput('\x0f'); }
          else if (lines[1] === 'Restart gateway services?') {
            restartAttempts++;
            if (restartAttempts === 2) {
              await writeFile(config, JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: [new URL('../dist/examples/demo-service.js', import.meta.url).pathname] } } }));
            }
            for (let i = 0; i < 100 && !render().join('\n').includes('Enter stop and restart'); i++) panel.handleInput('\x1b[6~');
            assert.match(render().join('\n'), /Enter stop and restart/);
            panel.handleInput('\r');
          } else if (lines[0]?.includes('Packages › Versions')) panel.handleInput(escape);
          else {
            if (lines[1] === 'Gateway') {
              rootVisits++;
              if (restartAttempts === 1) assert.match(lines[2], /Disconnected/, 'A startup failure returns to recovery navigation');
            }
            const target = navigation.shift();
            assert.ok(target, `Unexpected screen: ${lines.join('\n')}`);
            for (let i = 0; i < 30 && !render().includes(`→ ${target}`); i++) panel.handleInput(down);
            assert.ok(render().includes(`→ ${target}`), `Missing ${target}`);
            panel.handleInput('\r');
          }
          return answer;
        } finally { panel.dispose(); }
      },
    },
  };
  try {
    await writeFile(config, JSON.stringify({ mcpServers: { demo: { command: join(dir, 'missing-executable') } } }));
    await commands.get('gateway').handler('', ctx);
    assert.equal(restartAttempts, 2);
    assert.ok(rootVisits >= 3);
    assert.ok(notices.some((text) => text.startsWith('Gateway:')), 'Failed startup reports an error');
    assert.ok(notices.includes('Gateway services restarted'));
    assert.equal(navigation.length, 0);
    await handlers.get('session_shutdown')!({}, ctx);

    // Two individually healthy listings exceed one adapter deadline in aggregate.
    // Later beta fails discovery; alpha's independent app must remain usable.
    const fixture = `
      import {Server} from '@modelcontextprotocol/sdk/server/index.js';
      import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
      import {ListToolsRequestSchema,ListResourcesRequestSchema,ReadResourceRequestSchema} from '@modelcontextprotocol/sdk/types.js';
      const name = process.env.MCP_GATEWAY_SERVICE_ID;
      const mime = 'application/vnd.mcp-native-ui+json';
      const server = new Server({name,version:'1'}, {capabilities:{tools:{},resources:{},experimental:{'native-ui-v1':{}}}});
      let listings = 0;
      server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[]}));
      server.setRequestHandler(ListResourcesRequestSchema,async()=>{
        await new Promise(resolve=>setTimeout(resolve,600));
        if(name==='beta' && ++listings>3) throw Error('Unrelated service discovery failed');
        return {resources:[{uri:'test://data',name:'Slow resource'},...(name==='alpha'?[{uri:'test://app',name:'App',mimeType:mime}]:[])]};
      });
      server.setRequestHandler(ReadResourceRequestSchema,async request=>({contents:[request.params.uri==='test://app' ?
        {uri:'test://app',mimeType:mime,text:JSON.stringify({version:1,title:'Healthy app',revision:'r1',state:{},controls:[]})} :
        {uri:'test://data',text:'Healthy data'}]}));
      await server.connect(new StdioServerTransport());
    `;
    const service = { command: process.execPath, args: ['--input-type=module', '-e', fixture], cwd: new URL('../', import.meta.url).pathname };
    await writeFile(config, JSON.stringify({ timeoutMs: 1000, mcpServers: { alpha: service, beta: service } }));
    const launching = handlers.get('session_start')!({}, ctx);
    events.get('gateway:query-service-tool')!({ service: 'alpha', tool: 'get_current', respond: (value: unknown) => { queryReply = value; } });
    assert.equal(queryReply.handled, true, 'Changed configuration must not reuse ownership from the previous launch');
    assert.match(queryReply.error, /not ready/);
    await launching;
    navigation.push('Services', 'alpha', 'Open app', 'Resources', 'Back', 'Resources', 'Open app', 'Back', 'Back', 'Close');
    await commands.get('gateway').handler('', ctx);
    assert.deepEqual(navigation, [], 'Slow aggregate listing must reach Resources without retiring healthy children');
    assert.ok(notices.some((text) => text.includes('Resources unavailable:') && text.includes('Unrelated service discovery failed')));
    assert.equal(appsOpened, 2, 'Controls open the app, and unrelated resource-list errors cannot block reopening it');
    await handlers.get('session_shutdown')!({}, ctx);
    const count = notices.length;
    await commands.get('gateway').handler('', { ...ctx, mode: 'rpc' });
    assert.equal(notices.length, count + 1);
    assert.match(notices.at(-1)!, /TUI mode/);
  } finally {
    await handlers.get('session_shutdown')!({}, ctx);
    await rm(dir, { recursive: true, force: true });
  }
});
