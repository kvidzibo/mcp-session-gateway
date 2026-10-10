import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { NativeUI } from '../pi/native-ui.js';
import { ViewSchema } from '../src/native-ui.js';
const { click } = createRequire(import.meta.url)('../pi/footer-click.cjs');

test('generic footer actions, tool state and /new retention stay scoped, serialized and replay-safe', async () => {
  const statuses = new Map<string, string>();
  let entries: any[] = [{ type: 'custom', customType: 'gateway-native-ui-v1', data: { scope: '/config', service: 'beta', state: {} } }], session = 'first', file = '/tmp/footer-session-first';
  let busy = false, actions = 0, failSave = false;
  const ctx: any = { mode: 'tui', sessionManager: { getBranch: () => entries, getSessionId: () => session, getSessionFile: () => file }, ui: {
    setStatus: (key: string, value: string) => statuses.set(key, value), notify() {}, confirm: async () => true,
  } };
  const pi: any = { appendEntry: (customType: string, data: any) => {
    if (failSave) throw new Error('Persistence failed');
    entries.push({ type: 'custom', customType, data });
  } };
  const view = (service: string, state: any) => ({ version: 1, title: service, revision: JSON.stringify(state), state, retainOnNew: service === 'alpha',
    controls: [{ id: 'increment', label: 'Increment', kind: 'action' }], footer: [{ text: `${service} +`, action: 'increment' }] });
  const uri = (service: string) => `gateway-resource://${service}/root`;
  const client: any = {
    listResources: async () => ({ resources: ['alpha', 'beta'].map((service) => ({ uri: uri(service), mimeType: 'application/vnd.mcp-native-ui+json' })) }),
    readResource: async (args: any) => ({ contents: [{ mimeType: 'application/vnd.mcp-native-ui+json', text: JSON.stringify(view(new URL(args.uri).hostname, args._meta['native-ui/context'].state)) }] }),
    request: async (args: any) => {
      actions++;
      const state = args.params._meta['native-ui/context'].state;
      return { view: view(new URL(args.params.uri).hostname, { count: (state.count ?? 0) + 1 }), preview: 'Private preview' };
    },
  };
  const host = new NativeUI(pi, () => client, () => ({ signal: new AbortController().signal, timeout: 1000 }), async (run) => {
    if (busy) return false;
    busy = true; try { return await run(); } finally { busy = false; }
  });
  const state = (service: string) => (host.meta(service)['native-ui/context'] as any).state;
  const link = (service: string) => statuses.get(`gateway-ui:${service}`)!.match(/pi-gateway-action:[^\x1b]+/)![0];
  try {
    await host.start(ctx, '/config');
    const sameContext = host.current();
    const legacyContext = (host.meta('beta')['native-ui/context'] as any).contextId;
    await host.start(ctx, '/config', 'reload');
    assert.equal(sameContext(), false);
    assert.equal((host.meta('beta')['native-ui/context'] as any).contextId, legacyContext, 'Legacy entries acquire a durable service context');
    const original = link('alpha'), beta = link('beta');
    await click(original);
    assert.equal(state('alpha').count, 1);
    assert.equal(state('beta').count, undefined);
    assert.ok(entries.some((entry) => entry.customType === 'gateway-native-preview'));
    await assert.rejects(click(original));
    await click(beta);
    assert.equal(state('beta').count, 1);
    const double = link('alpha');
    const results = await Promise.allSettled([click(double), click(double)]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(state('alpha').count, 2);
    assert.equal(actions, 3);
    const stale = link('alpha');
    await host.callTool('alpha', async (meta) => {
      assert.equal((meta['native-ui/context'] as any).state.count, 2);
      // Notifications before the tool result cannot overwrite its new opaque state.
      await host.refresh(uri('alpha'));
      return { content: [], _meta: { 'native-ui/state': { count: 10 } } };
    });
    assert.equal(state('alpha').count, 10);
    await Promise.all([
      host.callTool('alpha', async () => ({ content: [], _meta: { 'native-ui/state': { count: 10, sequence: true } } })),
      host.callTool('alpha', async (meta) => {
        assert.equal((meta['native-ui/context'] as any).state.sequence, true, 'Queued tools read state after the previous result');
        return { content: [], _meta: { 'native-ui/state': { count: 10 } } };
      }),
    ]);
    await assert.rejects(click(stale));
    await host.callTool('alpha', async () => ({ isError: true, content: [], _meta: { 'native-ui/state': { count: 99 } } }));
    assert.equal(state('alpha').count, 10);
    await assert.rejects(host.callTool('alpha', async () => ({ content: [], _meta: { 'native-ui/state': { text: 'x'.repeat(9000) } } })));
    const contextId = (host.meta('alpha')['native-ui/context'] as any).contextId;
    host.transfer('/tmp/footer-session-next');
    await host.stop();
    entries = []; session = 'next'; file = '/tmp/footer-session-next';
    failSave = true;
    await assert.rejects(host.start(ctx, '/config', 'new'), /Persistence failed/);
    failSave = false;
    await host.start(ctx, '/config', 'reload');
    assert.equal(state('alpha').count, 10, 'Failed /new transfer persists on the next start of its exact destination');
    assert.deepEqual(state('beta'), {});
    assert.equal((host.meta('alpha')['native-ui/context'] as any).contextId, contextId);
    await host.start(ctx, '/config', 'reload');
    assert.equal(state('alpha').count, 10);
    const beforeShutdown = link('alpha');
    await host.stop();
    await assert.rejects(click(beforeShutdown));
    entries = []; session = 'unrelated'; file = '/tmp/footer-unrelated';
    await host.start(ctx, '/config', 'startup');
    assert.deepEqual(state('alpha'), {});
    let release!: () => void;
    const pending = host.callTool('alpha', async () => { await new Promise<void>((resolve) => { release = resolve; }); return { content: [], _meta: { 'native-ui/state': { leaked: true } } }; });
    await new Promise((resolve) => setImmediate(resolve));
    await host.start(ctx, '/config');
    release(); await assert.rejects(pending, /context changed/);
    assert.equal(state('alpha').leaked, undefined);
    const base = view('alpha', {});
    assert.throws(() => ViewSchema.parse({ ...base, footer: [{ text: 'Bad', action: 'missing' }] }));
    assert.throws(() => ViewSchema.parse({ ...base, footer: [{ text: 'Bad', action: 'increment', url: 'https://example.com' }] }));
  } finally { await host.stop(); }
});
