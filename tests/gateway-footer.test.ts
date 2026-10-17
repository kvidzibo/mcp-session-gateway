import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import gatewayExtension from '../pi/gateway.js';
const { click } = createRequire(import.meta.url)('../pi/footer-click.cjs');

test('gateway footer counts configuration, opens Services repeatedly, and keeps recovery clickable after disconnect', async () => {
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
    await handlers.get('session_start')!({ reason: 'reload' }, ctx);
    await waitFor(/off$/);
    assert.equal(text(), ' MCP 1 service · off');
    const beforeShutdown = link();
    await handlers.get('session_shutdown')!({}, ctx);
    assert.equal(statuses.get('gateway'), undefined);
    await assert.rejects(click(beforeShutdown));
  } finally {
    await handlers.get('session_shutdown')!({}, ctx);
    await rm(dir, { recursive: true, force: true });
  }
});
