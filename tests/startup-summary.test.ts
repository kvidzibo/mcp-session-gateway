import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import registerGateway from '../pi/runtime.js';

// Service/UI tests must never fetch or install into the checkout hosting this test.
const gatewayExtension = (pi: Parameters<typeof registerGateway>[0]) => registerGateway(pi, async () => {});
import { GatewayStatusSchema } from '../src/status.js';
import { startupSummary, StartupSummarySchema } from '../pi/startup-summary.js';
import { agentContextTokens } from '../pi/agent-context.js';

test('startup snapshot reports observed connections including zero-tool and stopped services, stays display-only and avoids duplicate cards', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-startup-'));
  const config = join(dir, 'gateway.json');
  const handlers = new Map<string, Function>(), renderers = new Map<string, Function>();
  let entries: any[] = [];
  let snapshots = 0;
  const widgets = new Map<string, any>();
  const statuses = new Map<string, string | undefined>();
  const footer = () => statuses.get('gateway')?.replace(/\x1b\]8;;[^\x07]*\x07/g, '');
  const progressFrames = new Set<string>();
  let renders = 0;
  const theme: any = { fg: (_: string, text: string) => text };
  const ctx: any = { cwd: dir, mode: 'tui', hasUI: true,
    sessionManager: { getBranch: () => entries, getSessionId: () => 'startup-test' },
    ui: { theme, setStatus: (key: string, value: string | undefined) => statuses.set(key, value), notify() {},
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
        demo: { agentContext: 'full', command: process.execPath, args: [new URL('../dist/examples/demo-service.js', import.meta.url).pathname] },
        zero: { command: process.execPath, args: ['--input-type=module', '-e', zero], cwd: new URL('../', import.meta.url).pathname },
        pending: { package: 'pending', command: process.execPath, args: ['{{packageRoot}}/server.mjs'] },
        disabled: { enabled: false, command: '/not-launched' },
      },
    }));
    await start('startup');
    assert.equal(snapshots, 1);
    assert.equal(footer(), ' MCP 2 services', 'Disabled and unactivated services are excluded from the footer count');
    assert.equal(widgets.size, 0, 'Startup loader is removed after success');
    assert.ok(progressFrames.size > 1, 'Loader renders changing animation frames/stages');
    assert.ok([...progressFrames].some((text) => text.includes('Starting Gateway')));
    assert.ok([...progressFrames].some((text) => text.includes('discovering tools')));
    const entry = entries[0];
    assert.equal(entry.customType, 'gateway-startup');
    assert.equal(entry.data.scope, config);
    assert.deepEqual(GatewayStatusSchema.parse(entry.data).services, [
      { name: 'demo', state: 'connected', tools: 1, toolNames: ['increment'] },
      { name: 'zero', state: 'connected', tools: 0, toolNames: [] },
      { name: 'pending', state: 'stopped', tools: 0, toolNames: [] },
      { name: 'disabled', state: 'stopped', tools: 0, toolNames: [] },
    ]);
    const contextEvent: any = { systemPromptOptions: { sections: {} } };
    await handlers.get('before_agent_start')!(contextEvent, ctx);
    const expectedTokens = agentContextTokens(contextEvent.systemPromptOptions.sections.gateway_tools);
    assert.ok(expectedTokens > 0);
    assert.deepEqual(StartupSummarySchema.parse(entry.data).contextTokens, {
      demo: expectedTokens, zero: 0, pending: 0, disabled: 0,
    });
    const renderer = renderers.get('gateway-startup')!(entry, {}, theme);
    for (const width of [8, 28, 48, 100]) {
      const lines: string[] = renderer.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width), `Overflows width ${width}`);
    }
    const text = renderer.render(100).join('\n');
    assert.match(text, /Startup snapshot · 2\/4 connected · 1 service tool/);
    assert.match(text, new RegExp(`demo\\s+connected · 1 tool · ≈${expectedTokens} tool-only tokens`));
    assert.match(text, /zero\s+connected · 0 tools · ≈0 tool-only tokens/);
    assert.match(text, /pending\s+disabled\s*│/);
    assert.match(text, /disabled\s+disabled\s*│/);
    assert.doesNotMatch(text, /stopped|package not activated/);
    assert.match(text, /increment/);
    assert.doesNotMatch(text, /app_only|gateway__identity/);
    const legacy = renderers.get('gateway-startup')!({ data: { services: [{ name: 'legacy', state: 'connected', tools: 2 }] } }, {}, theme).render(100).join('\n');
    assert.match(legacy, /legacy\s+connected · 2 tools/);
    assert.doesNotMatch(legacy, /tokens/);
    assert.match(startupSummary({ services: [{ name: 'large', state: 'connected', tools: 3 }],
      contextTokens: { large: 1234 } }, theme).render(100).join('\n'), /3 tools · ≈1\.2k tool-only tokens/);
    const longNames = startupSummary({ services: [{ name: 'wide', state: 'connected', tools: 2,
      toolNames: ['界'.repeat(50), 'unsafe\x1b[31m\nname'] }] }, theme);
    for (const width of [1, 8, 28, 48, 100]) {
      const lines = longNames.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.ok(lines.every((line) => !/[\x1b\n]/.test(line.replaceAll('\x1b[0m', ''))), 'Tool names cannot inject terminal controls');
    }
    entries.push({ type: 'custom', customType: 'gateway-call-counts', data: {
      session: 'startup-test', scope: config, counts: { pending: { success: 1, failure: 0, pending: 0 } },
    } });
    for (const reason of ['reload', 'resume', 'fork', 'startup']) {
      await stop();
      const saved = JSON.parse(await readFile(config, 'utf8'));
      saved.display = reason === 'reload' ? 'full' : 'minimal';
      await writeFile(config, JSON.stringify(saved));
      await start(reason);
      assert.equal(snapshots, 1, `No duplicate on ${reason}`);
      if (reason === 'reload') {
        assert.equal(footer(), undefined);
        for (const width of [28, 100]) {
          const lines: string[] = widgets.get('gateway-call-counts').render(width);
          assert.ok(lines.every((line) => visibleWidth(line) <= width));
          const rendered = lines.join('\n').replace(/\x1b\]8;;[^\x07]*\x07/g, '');
          assert.match(rendered, / MCP 2 services · 1 tool\s+calls/);
          assert.match(rendered, /demo/);
          assert.match(rendered, /zero/);
          assert.doesNotMatch(rendered, /pending|disabled|previous/);
        }
        assert.equal(entries[1].data.counts.pending.success, 1, 'Hiding a service must not erase saved usage');
      } else assert.equal(footer(), ' MCP 2 services', `Hidden services stay excluded on ${reason}`);
    }
    for (const [index, mode] of ['off', 'service', 'summary', 'full'].entries()) {
      await stop(); entries = [];
      const saved = JSON.parse(await readFile(config, 'utf8'));
      saved.mcpServers.demo.agentContext = mode;
      await writeFile(config, JSON.stringify(saved));
      await start('new');
      assert.equal(snapshots, index + 2, '/new gets its own snapshot');
      const event: any = { systemPromptOptions: { sections: {} } };
      await handlers.get('before_agent_start')!(event, ctx);
      const tokens = agentContextTokens(event.systemPromptOptions.sections.gateway_tools ?? '');
      assert.equal(entries[0].data.contextTokens.demo, tokens, `${mode}: estimates the actual injected context`);
      assert.equal(tokens === 0, mode === 'off');
      assert.match(renderers.get('gateway-startup')!(entries[0], {}, theme).render(100).join('\n'),
        new RegExp(`1 tool · ≈${tokens} tool-only tokens`));
    }
    await stop(); entries = [];
    await rm(config);
    await assert.rejects(start('new'), /ENOENT/);
    assert.equal(snapshots, 6);
    assert.equal(widgets.size, 0, 'Startup loader is removed after failure');
    const afterFailure = renders;
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(renders, afterFailure, 'No animation timer survives failure');
    assert.equal(entries[0].data.unavailable, true);
    assert.match(renderers.get('gateway-startup')!(entries[0], {}, theme).render(100).join('\n'), /Startup status unavailable/);
    assert.match(startupSummary({ services: [] }, theme).render(100).join('\n'), /No services configured/);
  } finally { await stop(); await rm(dir, { recursive: true, force: true }); }
});
