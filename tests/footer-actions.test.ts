import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { FooterActions } from '../pi/footer-actions.js';
import { NativeUI } from '../pi/native-ui.js';
import { visibleWidth } from '@earendil-works/pi-tui';
import { ViewSchema } from '../src/native-ui.js';
const { click } = createRequire(import.meta.url)('../pi/footer-click.cjs');

test('generic footer actions, tool state and /new retention stay scoped, serialized and replay-safe', async () => {
  const statuses = new Map<string, string>();
  let entries: any[] = [{ type: 'custom', customType: 'gateway-native-ui-v1', data: { scope: '/config', service: 'beta', state: {} } }], session = 'first', file = '/tmp/footer-session-first';
  let busy = false, actions = 0, failSave = false, approve = false;
  const ctx: any = { mode: 'tui', sessionManager: { getBranch: () => entries, getSessionId: () => session, getSessionFile: () => file }, ui: {
    setStatus: (key: string, value: string) => statuses.set(key, value), notify() {},
    confirm: async () => assert.fail('Footer actions must use the full scrollable review'),
    custom: async (factory: Function) => {
      let result: boolean | undefined;
      const panel = factory({ terminal: { rows: 24, columns: 54 }, requestRender() {} }, { fg: (_: string, text: string) => text }, {}, (value: boolean) => { result = value; });
      try {
        panel.render(54); panel.handleInput('\r');
        assert.equal(result, undefined, 'Unseen disclosure lines cannot be approved');
        if (!approve) panel.handleInput('\x1b');
        else {
          for (let i = 0; i < 10 && !panel.render(54).join('\n').includes('Enter confirm'); i++) panel.handleInput('\x1b[6~');
          assert.match(panel.render(54).join('\n'), /Enter confirm/);
          panel.handleInput('\r');
        }
        return result;
      } finally { panel.dispose(); }
    },
  } };
  const pi: any = { appendEntry: (customType: string, data: any) => {
    if (failSave) throw new Error('Persistence failed');
    entries.push({ type: 'custom', customType, data });
  } };
  const view = (service: string, state: any) => ({ version: 1, title: service, revision: JSON.stringify(state), state, retainOnNew: service === 'alpha',
    controls: [{ id: 'increment', label: 'Increment', kind: 'action', confirm: Array.from({ length: 40 }, (_, i) => `Disclosure line ${i + 1}`).join('\n') }], footer: [{ text: `${service} +`, action: 'increment' }] });
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
    await assert.rejects(click(link('alpha')));
    assert.equal(actions, 0, 'Cancelled footer approval must not dispatch');
    approve = true;
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
    assert.throws(() => ViewSchema.parse({ ...base, footer: [{ text: 'Bad', secondaryAction: 'increment' }] }));
    assert.throws(() => ViewSchema.parse({ ...base, footer: [{ text: 'Bad', action: 'increment', secondaryAction: 'missing' }] }));
  } finally { await host.stop(); }
});

test('right-click dispatches only the alternate control and shares single-use consent with left-click', async () => {
  const statuses = new Map<string, string>(), actions: string[] = [];
  let approve = false, confirmations = 0;
  const ctx: any = { mode: 'tui', sessionManager: { getBranch: () => [], getSessionId: () => 'secondary', getSessionFile: () => undefined },
    ui: { setStatus: (key: string, value: string) => statuses.set(key, value), notify() {},
      custom: async (factory: Function) => {
        let result: boolean | undefined;
        const panel = factory({ terminal: { rows: 24, columns: 80 }, requestRender() {} }, { fg: (_: string, text: string) => text }, {}, (value: boolean) => { result = value; });
        try {
          assert.match(panel.render(80).join('\n'), /Dismiss this suggestion\?/);
          confirmations++;
          panel.handleInput(approve ? '\r' : '\x1b');
          return result;
        } finally { panel.dispose(); }
      } } };
  const view = { version: 1, title: 'Suggestion', revision: 'r1', state: {},
    controls: [{ id: 'accept', kind: 'action', label: 'Accept', revision: 'accept-r1' }, { id: 'dismiss', kind: 'action', label: 'Dismiss', revision: 'dismiss-r1', confirm: 'Dismiss this suggestion?' }],
    footer: [{ text: '+', action: 'accept', secondaryAction: 'dismiss' }] };
  const client: any = {
    getServerCapabilities: () => ({ experimental: { 'native-ui-v1': { footerSecondaryActions: true } } }),
    listResources: async () => ({ resources: [{ uri: 'gateway-resource://demo/root', mimeType: 'application/vnd.mcp-native-ui+json' }] }),
    readResource: async () => ({ contents: [{ mimeType: 'application/vnd.mcp-native-ui+json', text: JSON.stringify(view) }] }),
    request: async (request: any) => {
      assert.equal(request.params.revision, `${request.params.action}-r1`, 'Use the chosen control revision, not its sibling or view revision');
      actions.push(request.params.action); return { view };
    },
  };
  const host = new NativeUI({ appendEntry() {} } as any, () => client, () => ({ signal: new AbortController().signal, timeout: 1000 }), async (run) => run());
  const link = () => statuses.get('gateway-ui:demo')!.match(/pi-gateway-action:[^\x1b]+/)![0];
  const bridge = new FooterActions();
  try {
    await host.start(ctx, '/secondary-config');
    assert.deepEqual(host.meta('demo')['native-ui/features'], { footerSecondaryActions: true }, 'Features negotiate independently');
    await assert.rejects(click(link(), true));
    assert.deepEqual(actions, [], 'Cancelling the secondary confirmation cannot accept');
    approve = true;
    const original = link();
    await click(original, true);
    assert.deepEqual(actions, ['dismiss'], 'Right-click must never accept');
    await assert.rejects(click(original));
    await click(link());
    assert.deepEqual(actions, ['dismiss', 'accept']);
    assert.equal(confirmations, 2, 'Primary must not use the secondary confirmation');
    const race = link();
    const results = await Promise.allSettled([click(race), click(race, true)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(actions.length, 3);
    const stale = link();
    await host.refresh('gateway-resource://demo/root');
    await assert.rejects(click(stale, true));
    await bridge.start();
    let primary = 0;
    const primaryOnly = bridge.link('test', async () => { primary++; return true; })!;
    await assert.rejects(click(primaryOnly, true));
    assert.equal(primary, 0, 'A right-click without an alternate must not invoke primary');
    await click(primaryOnly);
    assert.equal(primary, 1);
  } finally { await host.stop(); await bridge.stop(); }
});

test('styled double-click titles accept then complete only on fresh capabilities', async () => {
  const statuses = new Map<string, string>(), actions: string[] = [];
  let selected = false, completed = false, busy = false;
  const ctx: any = { mode: 'tui', sessionManager: { getBranch: () => [], getSessionId: () => 'double' },
    ui: { setStatus: (key: string, value: string) => statuses.set(key, value), notify() {},
      theme: { fg: (_: string, text: string) => `\x1b[36m${text}\x1b[39m`, italic: (text: string) => `\x1b[3m${text}\x1b[23m` } } };
  const view = () => ({ version: 1, title: 'Tasks', revision: selected ? 'active' : 'suggested', state: { selected },
    controls: ['accept', 'preview', 'done'].map((id) => ({ id, label: id, kind: 'action', revision: id + (selected ? '-active' : '-suggested') })),
    footer: completed ? [] : [{ text: '\x1b[31mTask 日本語', width: 30,
      ...(selected ? { action: 'preview', doubleAction: 'done' } : { doubleAction: 'accept', style: { italic: true, color: 'accent' } }) }] });
  const client: any = {
    getServerCapabilities: () => ({ experimental: { 'native-ui-v1': { footerStyles: true, footerDoubleActions: true } } }),
    listResources: async () => ({ resources: [{ uri: 'gateway-resource://demo/root', mimeType: 'application/vnd.mcp-native-ui+json' }] }),
    readResource: async () => ({ contents: [{ mimeType: 'application/vnd.mcp-native-ui+json', text: JSON.stringify(view()) }] }),
    request: async (request: any) => {
      const { action, revision } = request.params;
      assert.equal(revision, action + (selected ? '-active' : '-suggested'));
      actions.push(action);
      if (action === 'accept') selected = true;
      if (action === 'done') completed = true;
      return { view: view() };
    },
  };
  const host = new NativeUI({ appendEntry() {} } as any, () => client, () => ({ signal: new AbortController().signal, timeout: 1000 }), async (run) => !busy && run());
  const link = () => statuses.get('gateway-ui:demo')!.match(/pi-gateway-action:[^\x1b]+/)![0];
  const bridge = new FooterActions();
  try {
    await host.start(ctx, '/double-config');
    assert.deepEqual(host.meta('demo')['native-ui/features'], { footerStyles: true, footerDoubleActions: true });
    assert.match(statuses.get('gateway-ui:demo')!, /\x1b\[3m\x1b\[36mTask 日本語/);
    assert.ok(!statuses.get('gateway-ui:demo')!.includes('\x1b[31m'), 'Service escapes are removed before trusted styling');
    const suggestion = link();
    await assert.rejects(click(suggestion), 'A single click cannot accept');
    await click(suggestion, 'double');
    assert.deepEqual(actions, ['accept']);
    await assert.rejects(click(suggestion, 'double'), 'The accepting gesture cannot complete');
    assert.equal(completed, false);
    assert.ok(!statuses.get('gateway-ui:demo')!.includes('\x1b[3m'));
    await click(link());
    assert.deepEqual(actions, ['accept', 'preview'], 'Single-click active title still previews');
    busy = true;
    await assert.rejects(click(link(), 'double'));
    assert.equal(completed, false);
    busy = false;
    const stale = link();
    await host.refresh('gateway-resource://demo/root');
    await assert.rejects(click(stale, 'double'));
    await click(link(), 'double');
    assert.deepEqual(actions, ['accept', 'preview', 'done']);
    await bridge.start();
    let writes = 0;
    const race = bridge.link('race', async () => { writes++; return true; }, undefined, async () => { writes++; return true; })!;
    const results = await Promise.allSettled([click(race), click(race, 'double')]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(writes, 1);
    const primary = bridge.link('primary', async () => true)!;
    await assert.rejects(click(primary, 'double'));
    await click(primary);
    const base = view();
    assert.throws(() => ViewSchema.parse({ ...base, footer: [{ text: 'Bad', doubleAction: 'missing' }] }));
    assert.throws(() => ViewSchema.parse({ ...base, footer: [{ text: 'Bad', doubleAction: 'done', url: 'https://example.com' }] }));
    assert.throws(() => ViewSchema.parse({ ...base, footer: [{ text: 'Bad', style: { color: 'red' } }] }));
    const stopped = bridge.link('stopped', undefined, undefined, async () => true)!;
    await bridge.stop();
    await assert.rejects(click(stopped, 'double'));
  } finally { await host.stop(); await bridge.stop(); }
});

test('fullscreen native footer keeps double-clicks state-bound and never captures editor focus', async () => {
  const statuses = new Map<string, string>(), actions: string[] = [], notices: string[] = [];
  const draft = 'Keep this draft 日本語';
  let selected = false, completed = false, widget: any, mode = 'fullscreen', menus = 0;
  let releasePreview: (() => void) | undefined;
  const preview = new Promise<void>((resolve) => { releasePreview = resolve; });
  const theme: any = { fg: (_: string, text: string) => `\x1b[36m${text}\x1b[39m`, italic: (text: string) => `\x1b[3m${text}\x1b[23m` };
  const ctx: any = { mode: 'tui', sessionManager: { getBranch: () => [], getSessionId: () => 'native' },
    ui: { theme, setStatus: (key: string, value: string) => statuses.set(key, value),
      getEditorText: () => draft, setEditorText: () => assert.fail('Native actions must not rewrite a draft'),
      notify: (message: string) => notices.push(message),
      setWidget: (_key: string, factory: any) => {
        widget?.dispose?.();
        widget = factory?.({ mode, requestRender() {} }, theme);
      },
      custom: async (factory: any) => new Promise((resolve) => {
        const menu = factory({ terminal: { rows: 24 }, requestRender() {} }, theme, {}, resolve);
        assert.match(menu.render(80).join('\n'), /Pinote/); menus++;
        menu.handleInput('\x1b'); menu.dispose?.();
      }),
    } };
  const view = () => ({ version: 1, title: 'Pinote · Tasks', revision: completed ? 'done' : selected ? 'active' : 'proposal', state: { selected },
    controls: ['accept', 'preview', 'done'].map((id) => ({ id, label: id, kind: 'action', revision: id + (selected ? '-active' : '-proposal') })),
    footer: [{ text: '▤ ', openApp: true }, { text: completed ? 'Pinote · No task' : 'Task 日本語', width: 20,
      ...(!completed ? selected ? { action: 'preview', doubleAction: 'done' } : { doubleAction: 'accept', style: { italic: true, color: 'accent' } } : {}) }] });
  const client: any = {
    getServerCapabilities: () => ({ experimental: { 'native-ui-v1': { actionRevisions: true, footerStyles: true, footerDoubleActions: true, footerNativeActions: true } } }),
    listResources: async () => ({ resources: [{ uri: 'gateway-resource://demo/root', mimeType: 'application/vnd.mcp-native-ui+json' }] }),
    readResource: async () => ({ contents: [{ mimeType: 'application/vnd.mcp-native-ui+json', text: JSON.stringify(view()) }] }),
    request: async (request: any) => {
      const action = request.params.action;
      actions.push(action);
      if (action === 'accept') selected = true;
      if (action === 'preview') await preview;
      if (action === 'done') completed = true;
      return { view: view(), ...(action === 'preview' ? { preview: 'Full task' } : {}) };
    },
  };
  const host = new NativeUI({ appendEntry() {} } as any, () => client, () => ({ signal: new AbortController().signal, timeout: 1000 }));
  const mouse = (x: number, count = 1, type = 'click') => widget.handleMouse({ type, button: 'left', x, y: 0, clickCount: count });
  const settle = () => widget.queue;
  try {
    await host.start(ctx, '/native-config');
    assert.equal((host.meta('demo')['native-ui/features'] as any).footerNativeActions, true);
    const lines = widget.render(100).join('\n');
    assert.ok(!lines.includes('\x1b]8;') && !lines.includes('\x1b]22;'), 'No action hyperlink or pointer-shape escape');
    assert.equal(statuses.get('gateway-ui:demo'), undefined, 'The status string does not duplicate the native widget');
    assert.equal(mouse(3, 1, 'press').focus, undefined, 'Press does not move keyboard focus');
    mouse(3); await settle();
    assert.deepEqual(actions, [], 'A single click cannot accept');
    mouse(3, 2); await settle();
    assert.deepEqual(actions, ['accept']);
    widget.render(100);
    mouse(3, 2); mouse(3, 3); await settle();
    assert.deepEqual(actions, ['accept'], 'Replayed double/triple click cannot complete the newly accepted task');
    mouse(3, 1, 'move');
    assert.match(widget.render(100).join('\n'), /Double-click: done/, 'Hover hint names the action');
    mouse(3); mouse(3, 2);
    releasePreview!(); await settle();
    assert.deepEqual(actions, ['accept', 'preview', 'done'], 'A fast double-click waits for its preview');
    widget.render(100);
    mouse(0); await settle();
    assert.equal(menus, 1, 'Launcher opens the app, not a service write');
    assert.equal(ctx.ui.getEditorText(), draft);
    for (const width of [1, 8, 18, 100]) {
      assert.ok(widget.render(width).every((row: string) => visibleWidth(row) <= width));
    }
    const base = view();
    assert.throws(() => ViewSchema.parse({ ...base, footer: [{ text: 'Bad', openApp: true, doubleAction: 'done' }] }));
    assert.throws(() => ViewSchema.parse({ ...base, footer: [{ text: 'Bad', openApp: true, url: '' }] }));
    await host.stop();
    mode = 'regular';
    await host.start(ctx, '/regular-config');
    assert.equal((host.meta('demo')['native-ui/features'] as any).footerNativeActions, undefined, 'Regular mode never negotiates native-only fields');
    assert.equal(widget, undefined, 'Regular mode leaves no empty native widget');
    assert.deepEqual(notices, []);
  } finally { releasePreview?.(); await host.stop(); }
});
