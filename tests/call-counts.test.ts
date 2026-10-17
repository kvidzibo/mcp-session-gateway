import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import registerGateway from '../pi/runtime.js';

// Service/UI tests must never fetch or install into the checkout hosting this test.
const gatewayExtension = (pi: Parameters<typeof registerGateway>[0]) => registerGateway(pi, async () => {});
import { CALL_COUNTS_ENTRY, CallCounts, callCountLines } from '../pi/call-counts.js';
import { readDisplay, toggleDisplay } from '../pi/auto-update.js';

test('Full display counts child outcomes, persists session totals, and wraps colored cells', { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-counts-'));
  const config = join(dir, 'gateway.json');
  const root = new URL('../', import.meta.url).pathname;
  const handlers = new Map<string, Function>(), tools = new Map<string, any>();
  const widgets = new Map<string, any>(), statuses = new Map<string, string>();
  const entries: any[] = [];
  const theme = { fg: (color: string, text: string) => `\x1b[${({ success: 32, error: 31, warning: 33, muted: 90 } as any)[color] ?? 37}m${text}\x1b[0m` };
  const ctx: any = { cwd: dir, mode: 'tui', hasUI: true,
    sessionManager: { getSessionId: () => 'session-one', getEntries: () => entries, getBranch: () => [] },
    ui: { theme, notify() {}, select: async () => 'Decline',
      setStatus: (key: string, value: string) => statuses.set(key, value),
      setWidget: (key: string, factory: any, options: any) => {
        if (key === CALL_COUNTS_ENTRY && factory) assert.equal(options.placement, 'belowEditor');
        widgets.set(key, typeof factory === 'function' ? factory({ requestRender() {} }, theme) : factory);
      },
    },
  };
  const strip = (text: string) => text.replace(/\x1b\]8;;[^\x07]*\x07/g, '').replace(/\x1b\[[0-9;]*m/g, '');
  const render = (width = 140): string[] => widgets.get(CALL_COUNTS_ENTRY).render(width);
  const latest = () => entries.filter((entry) => entry.customType === CALL_COUNTS_ENTRY).at(-1).data;
  gatewayExtension({
    registerFlag() {}, getFlag: () => config, registerEntryRenderer() {}, registerCommand() {}, events: { on() {} },
    registerTool: (tool: any) => tools.set(tool.name, tool),
    appendEntry: (customType: string, data: any) => entries.push({ type: 'custom', customType, data }),
    on: (event: string, handler: Function) => handlers.set(event, handler),
  } as any);
  try {
    await writeFile(config, JSON.stringify({ display: 'full', mcpServers: {
      alpha: { command: process.execPath, args: ['--import', 'tsx', root + 'tests/service.ts'], cwd: root },
      beta: { command: process.execPath, args: [root + 'dist/examples/demo-service.js'] },
    } }));
    await handlers.get('session_start')!({ reason: 'new' }, ctx);
    const invoke = (name: string, args = {}) => tools.get('gateway_call').execute('call', { name, arguments: args });
    await tools.get('gateway_tools').execute();
    await invoke('gateway__identity');
    await assert.rejects(invoke('alpha__echo'), /Invalid arguments/);
    await invoke('alpha__identity');
    assert.equal((await invoke('beta__increment')).isError, true);
    assert.deepEqual(latest().counts, { alpha: { success: 1, failure: 0, pending: 0 }, beta: { success: 0, failure: 1, pending: 0 } });
    assert.equal(statuses.get('gateway'), undefined);
    assert.match(strip(render().join('\n')), /2 tool calls\nalpha ✓1 ✗0  │  beta ✓0 ✗1/);
    assert.match(render()[1], /\x1b\[32m✓1/);
    assert.match(render()[1], /\x1b\[31m✗1/);
    for (const width of [1, 12, 24, 80, 140]) assert.ok(render(width).every((line) => visibleWidth(line) <= width));
    const counts = new CallCounts('session-one', config, entries);
    assert.equal(counts.total(), 2);
    assert.equal(new CallCounts('fork-id', config, entries).total(), 0);
    assert.equal(new CallCounts('session-one', config + '-other', entries).total(), 0);
    counts.event({ id: 'pending', service: 'alpha', phase: 'started' });
    const saved = counts.snapshot();
    assert.match(callCountLines(140, theme as any, 'header', ['alpha'], counts.counts, new Set()).join(''), /\x1b\[33m…1/);
    assert.equal(counts.interrupt(), true);
    assert.equal(saved.counts.alpha.pending, 1, 'Saved snapshots are immutable');
    assert.equal(counts.event({ id: 'pending', service: 'alpha', phase: 'success' }), false, 'Late completions cannot alter interrupted totals');
    const interrupted = new CallCounts('session-one', config, [{ type: 'custom', customType: CALL_COUNTS_ENTRY, data: saved }]);
    assert.deepEqual(interrupted.counts.get('alpha'), { success: 1, failure: 1, pending: 0 });
    await handlers.get('session_shutdown')!({ reason: 'reload' }, ctx);
    assert.equal(await toggleDisplay(config, 'full', new AbortController().signal), 'minimal');
    await handlers.get('session_start')!({ reason: 'reload' }, ctx);
    assert.match(strip(statuses.get('gateway')!), /MCP 2 services$/);
    await invoke('alpha__identity');
    assert.equal(latest().counts.alpha.success, 2, 'Minimal continues tracking across restart');
    await assert.rejects(toggleDisplay(config, 'full', new AbortController().signal), /changed in another session/);
    assert.equal(await readDisplay(config), 'minimal');
  } finally {
    await handlers.get('session_shutdown')!({}, ctx);
    await rm(dir, { recursive: true, force: true });
  }
});
