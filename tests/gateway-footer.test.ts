import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import registerGateway from '../pi/runtime.js';
import { LiveJobs } from '../pi/live-jobs.js';

// Service/UI tests must never fetch or install into the checkout hosting this test.
const gatewayExtension = (pi: Parameters<typeof registerGateway>[0]) => registerGateway(pi, async () => {});
const { click } = createRequire(import.meta.url)('../pi/footer-click.cjs');

test('gateway footer counts configuration, opens Services repeatedly, and keeps recovery clickable after disconnect', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-footer-'));
  const config = join(dir, 'gateway.json'), pids = join(dir, 'pids');
  const handlers = new Map<string, Function>();
  const statuses = new Map<string, string | undefined>();
  const screens: string[] = [], notices: string[] = [];
  const theme = { fg: (_: string, text: string) => text };
  let statusChanged = () => {};
  let releaseMenu: (() => void) | undefined;
  let menuStarted: (() => void) | undefined;
  const ctx: any = { cwd: dir, mode: 'tui', hasUI: true,
    sessionManager: { getBranch: () => [], getSessionId: () => 'footer-test' },
    ui: { theme, notify: (text: string) => notices.push(text), setWidget() {},
      setStatus: (key: string, value: string | undefined) => { statuses.set(key, value); statusChanged(); },
      custom: async (factory: Function) => {
        let answer: unknown;
        const panel = factory({ terminal: { rows: 30, columns: 100 }, requestRender() {} }, theme, {}, (value: unknown) => { answer = value; });
        try {
          screens.push(panel.render(98)[1]);
          if (releaseMenu) await new Promise<void>((resolve) => { releaseMenu = resolve; menuStarted?.(); });
          panel.handleInput('\x1b');
          return answer;
        } finally { panel.dispose(); }
      },
    },
  };
  gatewayExtension({
    registerFlag() {}, getFlag: () => config, registerEntryRenderer() {}, events: { on() {} }, registerTool() {}, registerCommand() {}, appendEntry() {},
    on: (event: string, handler: Function) => handlers.set(event, handler),
  } as any);
  const link = () => statuses.get('gateway')!.match(/pi-gateway-action:[^\x1b\x07]+/)![0];
  const text = () => statuses.get('gateway')!.replace(/\x1b\]8;;[^\x07]*\x07/g, '');
  const waitFor = async (expected: RegExp) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Missing footer ${expected}: ${text()}`)), 5000);
      statusChanged = () => { if (expected.test(text())) { clearTimeout(timer); statusChanged = () => {}; resolve(); } };
      statusChanged();
    });
  };
  try {
    await assert.rejects(handlers.get('session_start')!({}, ctx), /ENOENT/);
    assert.equal(text(), ' MCP ? services · off', 'Unknown configuration is not zero services');
    const demo = new URL('../dist/examples/demo-service.js', import.meta.url).href;
    const script = `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid,process.ppid])); await import(${JSON.stringify(demo)});`;
    await writeFile(config, JSON.stringify({ mcpServers: {
      alpha: { command: process.execPath, args: ['--input-type=module', '-e', script] },
      beta: { command: process.execPath, args: [new URL(demo).pathname] },
    } }));
    await handlers.get('session_start')!({}, ctx);
    assert.equal(text(), ' MCP 2 services');
    for (let i = 0; i < 2; i++) {
      const old = link();
      await click(old);
      assert.deepEqual(screens.splice(0), ['Gateway › Services', 'Gateway']);
      await assert.rejects(click(old), /Action unavailable/);
    }
    releaseMenu = () => {};
    const ready = new Promise<void>((resolve) => { menuStarted = resolve; });
    const pending = click(link());
    await ready;
    await click(link());
    assert.deepEqual(notices, ['Finish the current gateway dialog first']);
    const release = releaseMenu!; releaseMenu = undefined; release();
    await pending;
    assert.deepEqual(screens.splice(0), ['Gateway › Services', 'Gateway']);

    const [child, gateway] = JSON.parse(await readFile(pids, 'utf8')) as number[];
    process.kill(child, 'SIGTERM');
    await waitFor(/!1$/);
    assert.equal(text(), ' MCP 2 services · !1', 'A stopped service remains configured');
    const beforeDisconnect = link();
    process.kill(gateway, 'SIGTERM');
    await waitFor(/off$/);
    await assert.rejects(click(beforeDisconnect), /Action unavailable/);
    await click(link());
    assert.deepEqual(screens.splice(0), ['Gateway'], 'Disconnected footer opens recovery instead');
    assert.equal(text(), ' MCP 2 services · off');

    // The second resource discovery belongs to LiveJobs, which catches read
    // failures. Its return must not overwrite the gateway's off state with up.
    const race = `
      import {Server} from '@modelcontextprotocol/sdk/server/index.js';
      import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
      import {ListResourcesRequestSchema} from '@modelcontextprotocol/sdk/types.js';
      const server = new Server({name:'race',version:'1'}, {capabilities:{resources:{}}});
      let reads = 0;
      server.setRequestHandler(ListResourcesRequestSchema, async () => {
        if (++reads === 2) process.kill(process.ppid, 'SIGTERM');
        return {resources:[]};
      });
      await server.connect(new StdioServerTransport());
    `;
    await writeFile(config, JSON.stringify({ mcpServers: { race: {
      command: process.execPath, args: ['--input-type=module', '-e', race], cwd: new URL('../', import.meta.url).pathname,
    } } }));
    // Force disconnect before the launch callback returns, rather than letting
    // the build helper's post-launch cancellation check race the transport close.
    const startJobs = LiveJobs.prototype.start;
    const discovery = t.mock.method(LiveJobs.prototype, 'start', async function (this: LiveJobs) {
      await startJobs.call(this);
      await waitFor(/off$/);
    });
    try { await handlers.get('session_start')!({ reason: 'reload' }, ctx); }
    finally { discovery.mock.restore(); }
    await waitFor(/off$/);
    assert.equal(text(), ' MCP 1 service · off');
    await click(link());
    assert.deepEqual(screens.splice(0), ['Gateway'], 'Startup disconnect preserves the recovery menu');
    const beforeShutdown = link();
    await handlers.get('session_shutdown')!({}, ctx);
    assert.equal(statuses.get('gateway'), undefined);
    await assert.rejects(click(beforeShutdown));
  } finally {
    await handlers.get('session_shutdown')!({}, ctx);
    await rm(dir, { recursive: true, force: true });
  }
});

test('note preview preserves full counter rows through double-click completion, but dialogs still compact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-footer-layout-'));
  const config = join(dir, 'gateway.json');
  const fixture = `
    import {Server} from '@modelcontextprotocol/sdk/server/index.js';
    import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
    import {ListResourcesRequestSchema,ReadResourceRequestSchema} from '@modelcontextprotocol/sdk/types.js';
    import {z} from 'zod';
    const server = new Server({name:'footer',version:'1'}, {capabilities:{resources:{},experimental:{'native-ui-v1':{}}}});
    const view = (state={}, native=false) => ({version:1,title:'Tasks',revision:'r1',state,
      controls:['preview','done'].map(id => ({id,kind:'action',label:id,revision:id})),
      footer:[...(native ? [{text:'▤ ',openApp:true}] : []),
        {text:state.done ? 'No task' : 'Task title',...(state.done ? {} : {action:'preview',doubleAction:'done'})}]});
    const current = r => view(r.params._meta['native-ui/context'].state,
      r.params._meta['native-ui/features']?.footerNativeActions);
    server.setRequestHandler(ListResourcesRequestSchema,async()=>({resources:[{uri:'test://root',name:'Tasks',mimeType:'application/vnd.mcp-native-ui+json'}]}));
    server.setRequestHandler(ReadResourceRequestSchema,async r=>({contents:[{uri:'test://root',mimeType:'application/vnd.mcp-native-ui+json',text:JSON.stringify(current(r))}]}));
    server.setRequestHandler(z.object({method:z.literal('native-ui/action'),params:z.any()}),async r=>{
      const result = current(r);
      if(r.params.action==='done') result.state = {done:true};
      return {view:result,...(r.params.action==='preview' ? {preview:'Task details'} : {})};
    });
    await server.connect(new StdioServerTransport());
  `;
  await writeFile(config, JSON.stringify({ display: 'full', mcpServers: {
    demo: { command: process.execPath, args: ['--input-type=module', '-e', fixture], cwd: new URL('../', import.meta.url).pathname },
  } }));
  try {
    for (const mode of ['regular', 'fullscreen']) {
      const handlers = new Map<string, Function>(), commands = new Map<string, any>();
      const widgets = new Map<string, any>(), statuses = new Map<string, string>();
      const previews: number[][] = [], dialogs: number[] = [], notices: string[] = [];
      const theme = { fg: (_: string, text: string) => text };
      const heights = () => [24, 140].map(width => widgets.get('gateway-call-counts').render(width).length);
      const ctx: any = { cwd: dir, mode: 'tui', hasUI: true,
        sessionManager: { getBranch: () => [], getSessionId: () => mode },
        ui: { theme, notify: (message: string) => notices.push(message),
          setStatus: (key: string, value: string) => statuses.set(key, value),
          setWidget: (key: string, factory: any) => widgets.set(key, factory?.({ mode, requestRender() {} }, theme)),
          custom: async (factory: Function) => {
            dialogs.push(heights()[1]);
            let answer: unknown;
            const panel = factory({ terminal: { rows: 30, columns: 140 }, requestRender() {} }, theme, {}, (value: unknown) => { answer = value; });
            try { panel.render(138); panel.handleInput('\x1b'); return answer; }
            finally { panel.dispose(); }
          },
        },
      };
      gatewayExtension({
        registerFlag() {}, getFlag: () => config, registerEntryRenderer() {}, registerTool() {}, events: { on() {} },
        registerCommand: (name: string, command: any) => commands.set(name, command),
        appendEntry: (type: string) => { if (type === 'gateway-native-preview') previews.push(heights()); },
        on: (event: string, handler: Function) => handlers.set(event, handler),
      } as any);
      try {
        await handlers.get('session_start')!({}, ctx);
        const before = heights();
        assert.ok(before.every(height => height > 1));
        const native = widgets.get('gateway-native-footers');
        const act = async (count: number) => {
          if (mode === 'fullscreen') {
            const text = native.render(140).join('\n');
            const event = { type: 'click', button: 'left', x: text.indexOf('Task title'), y: 0 };
            if (count === 2) native.handleMouse({ ...event, clickCount: 1 });
            native.handleMouse({ ...event, clickCount: count });
            if (count === 1) await new Promise(resolve => setTimeout(resolve, 510));
            await native.queue;
          } else {
            const url = statuses.get('gateway-ui:demo')!.match(/pi-gateway-action:[^\x1b\x07]+/)![0];
            await click(url, count === 2 ? 'double' : false);
          }
        };
        await act(1);
        assert.deepEqual(previews, [before], `${mode}: even transient preview renders must keep the title in place`);
        assert.deepEqual(heights(), before);
        await act(2);
        assert.deepEqual(previews, [before], `${mode}: completion does not print another preview`);
        assert.match(mode === 'fullscreen' ? native.render(140).join('') : statuses.get('gateway-ui:demo')!, /No task/);
        if (mode === 'fullscreen') {
          native.handleMouse({ type: 'click', button: 'left', x: 0, y: 0, clickCount: 1 });
          await native.queue;
        } else await commands.get('gateway').handler('', ctx);
        assert.ok(dialogs.length && dialogs.every(height => height === 1), 'Actual menus still reserve room for controls');
        assert.deepEqual(heights(), before);
        assert.deepEqual(notices, []);
      } finally { await handlers.get('session_shutdown')!({}, ctx); }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
