import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import gatewayExtension from '../pi/gateway.js';

test('restart-required Gateway skips service configuration, startup and summary across reloads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-preflight-'));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const key = Symbol.for('local-stdio-mcp-gateway.restart-required');
  const state = process as NodeJS.Process & { [key]?: Set<string> };
  const previous = state[key];
  state[key] = new Set([...previous ?? [], root.replace(/\/$/, '')]);
  const notices: string[] = [], entries: string[] = [], progress: unknown[] = [];
  const ctx: any = { cwd: dir, mode: 'tui', hasUI: true,
    sessionManager: { getSessionId: () => 'preflight', getBranch: () => [] },
    ui: {
      theme: { fg: (_: string, text: string) => text },
      notify: (text: string) => notices.push(text),
      setStatus() {},
      setWidget: (key: string, value: unknown) => { if (key === 'gateway-startup-progress' && value) progress.push(value); },
    },
  };
  try {
    // The initial guard must not even read the service config. A reload must
    // retain it, including when enabled services have unresolved credentials.
    for (const reload of [false, true]) {
      const config = join(dir, 'gateway.json');
      if (reload) await writeFile(config, JSON.stringify({ mcpServers: {
        demo: { command: 'must-not-run', env: { TOKEN: '${GATEWAY_PREFLIGHT_MISSING_TOKEN}' } },
      } }));
      const handlers = new Map<string, Function>(), tools = new Map<string, any>();
      gatewayExtension({
        registerFlag() {}, getFlag: () => config, registerEntryRenderer() {}, registerCommand() {},
        registerTool: (tool: any) => tools.set(tool.name, tool),
        events: { on() {} },
        appendEntry: (type: string) => entries.push(type),
        on: (event: string, handler: Function) => handlers.set(event, handler),
      } as any);
      try {
        await handlers.get('session_start')!({ reason: reload ? 'reload' : 'startup' }, ctx);
        await assert.rejects(tools.get('gateway_tools').execute('', {}), /Gateway disconnected/);
      } finally { await handlers.get('session_shutdown')!({}, ctx); }
    }
    assert.equal(notices.length, 2);
    for (const notice of notices) assert.match(notice, /Restart Pi.*services were not started/);
    assert.deepEqual(progress, [], 'No service startup progress is displayed');
    assert.deepEqual(entries, [], 'Do not persist a misleading service-unavailable startup summary');
  } finally {
    if (previous) state[key] = previous; else delete state[key];
    await rm(dir, { recursive: true, force: true });
  }
});
