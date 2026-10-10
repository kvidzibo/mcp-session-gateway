import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { GatewayMenu } from '../pi/menu.js';
import gatewayExtension from '../pi/gateway.js';

const down = '\x1b[B', escape = '\x1b';
const theme = { fg: (_color: string, text: string) => text };

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
  assert.deepEqual([...commands.keys()], ['gateway']);
  let queryReply: any;
  events.get('gateway:query-service-tool')!({ service: 'pinote', tool: 'get_current', respond: (value: unknown) => { queryReply = value; } });
  assert.equal(queryReply.handled, true, 'Unknown startup ownership must not fall through to an unrelated cwd selection');
  assert.match(queryReply.error, /not ready/);
  const ctx: any = { cwd: dir, mode: 'tui', hasUI: true, isIdle: () => true,
    sessionManager: { getBranch: () => [], getSessionId: () => 'menu-test' },
    ui: {
      notify: (text: string) => notices.push(text), setStatus() {}, setWidget() {},
      custom: async (factory: Function) => {
        let answer: unknown;
        const panel = factory({ terminal: { rows: 30, columns: 100 }, requestRender() {} }, theme, {}, (value: unknown) => { answer = value; });
        const render = () => panel.render(98) as string[];
        try {
          const lines = render();
          if (lines[0] === 'Healthy app') { appsOpened++; panel.handleInput(escape); }
          else if (lines[1] === 'Restart gateway services?') {
            restartAttempts++;
            if (restartAttempts === 2) {
              await writeFile(config, JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: [new URL('../dist/examples/demo-service.js', import.meta.url).pathname] } } }));
            }
            for (let i = 0; i < 100 && !render().join('\n').includes('Enter stop and restart'); i++) panel.handleInput('\x1b[6~');
            assert.match(render().join('\n'), /Enter stop and restart/);
            panel.handleInput('\r');
          } else if (lines[1]?.includes('Packages › Versions')) panel.handleInput(escape);
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
    await handlers.get('session_start')!({}, ctx);
    navigation.push('Services', 'alpha', 'Resources', 'Back', 'Resources', 'Open app', 'Back', 'Back', 'Close');
    await commands.get('gateway').handler('', ctx);
    assert.deepEqual(navigation, [], 'Slow aggregate listing must reach Resources without retiring healthy children');
    assert.ok(notices.some((text) => text.includes('Resources unavailable:') && text.includes('Unrelated service discovery failed')));
    assert.equal(appsOpened, 1, 'An unrelated resource-list error cannot block a healthy service app');
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
