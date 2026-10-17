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
  const widgets = new Map<string, any>();
  const progressFrames = new Set<string>();
  let renders = 0;
  const theme: any = { fg: (_: string, text: string) => text };
  const ctx: any = { cwd: dir, mode: 'tui', hasUI: true,
    sessionManager: { getBranch: () => entries, getSessionId: () => 'startup-test' },
    ui: { theme, setStatus() {}, notify() {},
      setWidget(key: string, factory: any) {
        widgets.get(key)?.dispose?.(); widgets.delete(key);
        if (typeof factory === 'function') {
          const panel = factory({ requestRender() {
            renders++;
            const loader = widgets.get(key);
            if (loader) progressFrames.add(loader.render(70).join('\n'));
          } }, theme);
          widgets.set(key, panel);
        }
      },
    },
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
      import {ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
      const server = new Server({name:'zero',version:'1'}, {capabilities:{tools:{}}});
      server.setRequestHandler(ListToolsRequestSchema, async () => {
        await new Promise(resolve => setTimeout(resolve, 200));
        return {tools:[{name:'app_only', inputSchema:{type:'object'}, _meta:{ui:{visibility:['app']}}}]};
      });
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
    assert.equal(widgets.size, 0, 'Startup loader is removed after success');
    assert.ok(progressFrames.size > 1, 'Loader renders changing animation frames/stages');
    assert.ok([...progressFrames].some((text) => text.includes('Starting MCP services')));
    assert.ok([...progressFrames].some((text) => text.includes('discovering tools')));
    const entry = entries[0];
    assert.equal(entry.customType, 'gateway-startup');
    assert.equal(entry.data.scope, config);
    assert.deepEqual(GatewayStatusSchema.parse(entry.data).services, [
      { name: 'demo', state: 'connected', tools: 1, toolNames: ['increment'] },
      { name: 'zero', state: 'connected', tools: 0, toolNames: [] },
      { name: 'pending', state: 'stopped', tools: 0, toolNames: [] },
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
    assert.match(text, /increment/);
    assert.doesNotMatch(text, /app_only|gateway__identity/);
    assert.match(startupSummary({ services: [{ name: 'legacy', state: 'connected', tools: 2 }] }, theme).render(100).join('\n'), /legacy\s+connected · 2 tools/);
    const longNames = startupSummary({ services: [{ name: 'wide', state: 'connected', tools: 2,
      toolNames: ['界'.repeat(50), 'unsafe\x1b[31m\nname'] }] }, theme);
    for (const width of [1, 8, 28, 48, 100]) {
      const lines = longNames.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.ok(lines.every((line) => !/[\x1b\n]/.test(line.replaceAll('\x1b[0m', ''))), 'Tool names cannot inject terminal controls');
    }
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
    assert.equal(widgets.size, 0, 'Startup loader is removed after failure');
    const afterFailure = renders;
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(renders, afterFailure, 'No animation timer survives failure');
    assert.equal(entries[0].data.unavailable, true);
    assert.match(renderers.get('gateway-startup')!(entries[0], {}, theme).render(100).join('\n'), /Startup status unavailable/);
    assert.match(startupSummary({ services: [] }, theme).render(100).join('\n'), /No services configured/);
  } finally { await stop(); await rm(dir, { recursive: true, force: true }); }
});
