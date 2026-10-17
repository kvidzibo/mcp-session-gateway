import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import gatewayExtension from '../pi/gateway.js';
import { GatewayStatusSchema } from '../src/status.js';
import { startupSummary } from '../pi/startup-summary.js';

test('startup snapshot reports observed connections including zero-tool and stopped services, stays display-only and avoids duplicate cards', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-startup-'));
  const config = join(dir, 'gateway.json');
  const handlers = new Map<string, Function>(), renderers = new Map<string, Function>();
  let entries: any[] = [];
  let snapshots = 0;
  const theme: any = { fg: (_: string, text: string) => text };
  const ctx: any = { cwd: dir, mode: 'tui', hasUI: true,
    sessionManager: { getBranch: () => entries, getSessionId: () => 'startup-test' },
    ui: { theme, setStatus() {}, setWidget() {}, notify() {} },
  };
  gatewayExtension({
    registerFlag() {}, getFlag: () => config, events: { on() {} }, registerCommand() {}, registerTool() {},
    registerEntryRenderer: (name: string, renderer: Function) => renderers.set(name, renderer),
    on: (name: string, handler: Function) => handlers.set(name, handler),
    appendEntry: (customType: string, data: unknown) => { entries.push({ type: 'custom', customType, data }); snapshots++; },
    sendMessage: () => assert.fail('Startup status must not enter model context'),
    sendUserMessage: () => assert.fail('Startup status must not start a model turn'),
  } as any);
  const start = (reason: string) => handlers.get('session_start')!({ reason }, ctx);
  const stop = () => handlers.get('session_shutdown')!({}, ctx);
  try {
    const zero = `
      import {Server} from '@modelcontextprotocol/sdk/server/index.js';
      import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
      const server = new Server({name:'zero',version:'1'}, {capabilities:{}});
      await server.connect(new StdioServerTransport());
    `;
    await writeFile(config, JSON.stringify({
      packages: { pending: { source: { type: 'git', url: 'https://example.invalid/not-fetched.git' }, managed: {
        validate: [{ command: process.execPath, args: ['--version'] }],
      } } },
      mcpServers: {
        demo: { command: process.execPath, args: [new URL('../dist/examples/demo-service.js', import.meta.url).pathname] },
        zero: { command: process.execPath, args: ['--input-type=module', '-e', zero], cwd: new URL('../', import.meta.url).pathname },
        pending: { package: 'pending', command: process.execPath, args: ['{{packageRoot}}/server.mjs'] },
      },
    }));
    await start('startup');
    assert.equal(snapshots, 1);
    const entry = entries[0];
    assert.equal(entry.customType, 'gateway-startup');
    assert.equal(entry.data.scope, config);
    assert.deepEqual(GatewayStatusSchema.parse(entry.data).services, [
      { name: 'demo', state: 'connected', tools: 1 },
      { name: 'zero', state: 'connected', tools: 0 },
      { name: 'pending', state: 'stopped', tools: 0 },
    ]);
    const renderer = renderers.get('gateway-startup')!(entry, {}, theme);
    for (const width of [8, 28, 48, 100]) {
      const lines: string[] = renderer.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width), `Overflows width ${width}`);
    }
    const text = renderer.render(100).join('\n');
    assert.match(text, /Startup snapshot · 2\/3 connected · 1 service tool/);
    assert.match(text, /zero\s+connected · 0 tools/);
    assert.match(text, /pending\s+stopped · package not activated/);
    for (const reason of ['reload', 'resume', 'fork', 'startup']) {
      await stop(); await start(reason);
      assert.equal(snapshots, 1, `No duplicate on ${reason}`);
    }
    await stop(); entries = [];
    await start('new');
    assert.equal(snapshots, 2, '/new gets its own snapshot');
    await stop(); entries = [];
    await rm(config);
    await assert.rejects(start('new'), /ENOENT/);
    assert.equal(snapshots, 3);
    assert.equal(entries[0].data.unavailable, true);
    assert.match(renderers.get('gateway-startup')!(entries[0], {}, theme).render(100).join('\n'), /Startup status unavailable/);
    assert.match(startupSummary({ services: [] }, theme).render(100).join('\n'), /No services configured/);
  } finally { await stop(); await rm(dir, { recursive: true, force: true }); }
});
