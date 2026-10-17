import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import registerGateway from '../pi/runtime.js';

// Service/UI tests must never fetch or install into the checkout hosting this test.
const gatewayExtension = (pi: Parameters<typeof registerGateway>[0]) => registerGateway(pi, async () => { throw new Error('Gateway build incomplete'); });

test('incomplete Gateway builds skip service configuration and startup across reloads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-preflight-'));
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
      await writeFile(config, JSON.stringify({ mcpServers: {
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
        await assert.rejects(handlers.get('session_start')!({ reason: reload ? 'reload' : 'startup' }, ctx), /Gateway build incomplete/);
        await assert.rejects(tools.get('gateway_tools').execute('', {}), /Gateway disconnected/);
      } finally { await handlers.get('session_shutdown')!({}, ctx); }
    }
    assert.deepEqual(notices, []);
    assert.deepEqual(progress, [], 'No service startup progress is displayed');
    assert.deepEqual(entries, ['gateway-startup'], 'Only the initial failed startup gets an unavailable summary; reload does not duplicate it');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
