import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { NativeUI } from '../pi/native-ui.js';
import { getKeybindings, visibleWidth } from '@earendil-works/pi-tui';
import { inputSettings } from '../pi/settings.js';
import { ActionResultSchema, clean, editorText, footerText, InvalidatedSchema, ViewSchema } from '../src/native-ui.js';

test('native apps reuse inline Pi menus with live refresh, native bindings, and resize guards', async () => {
  const keys = getKeybindings(), original = keys.getUserBindings();
  const controller = new AbortController();
  const terminal = { rows: 30, columns: 100 };
  const uri = 'gateway-resource://demo/test%3A%2F%2Froot';
  const view = { version: 1, title: 'Pinote · Tasks', revision: 'r1', state: {},
    body: 'Selected task\n\nDetails '.repeat(30), controls: Array.from({ length: 24 }, (_, index) => ({
      id: index === 0 ? '__back' : index === 1 ? 'refresh' : String(index), kind: 'action',
      label: `Task ${index + 1}: ${'long title '.repeat(10)}`, description: `Description ${index + 1}: ${'Useful explanation. '.repeat(5)}`,
    })),
  };
  let phase = 0, actions = 0;
  const client: any = {
    listResources: async () => ({ resources: [{ uri, mimeType: 'application/vnd.mcp-native-ui+json' }] }),
    readResource: async () => ({ contents: [{ uri, mimeType: 'application/vnd.mcp-native-ui+json', text: JSON.stringify(view) }] }),
    request: async (request: any) => { actions++; assert.equal(request.params.action, 'refresh', 'Service IDs must not collide with host navigation'); return { view }; },
  };
  const ctx: any = { mode: 'tui', ui: { setStatus() {}, notify: (message: string) => assert.fail(message),
    custom: async (factory: Function, options: unknown) => {
      assert.equal(options, undefined, 'Apps use the normal inline area, never an overlay');
      let answer: unknown, finished = false;
      const panel = factory({ terminal, requestRender() {} }, { fg: (_: string, text: string) => text }, {}, (value: unknown) => { answer = value; finished = true; });
      const render = () => {
        const lines: string[] = panel.render(terminal.columns - 2).map(clean);
        assert.ok(lines.length <= Math.max(1, terminal.rows - 6), 'Menu leaves room for Pi’s footer and service widgets');
        assert.ok(lines.every((line) => visibleWidth(line) <= terminal.columns - 2));
        return lines;
      };
      try {
        const lines = render();
        assert.match(lines[0], /^─+$/);
        assert.equal(lines[1], 'Gateway › Services › demo › Pinote · Tasks');
        assert.match(lines.at(-1)!, /^─+$/);
        assert.match(lines.join('\n'), /ctrl\+p\/ctrl\+n.*ctrl\+y.*ctrl\+x/);
        assert.ok(lines.some((line) => /Selected task.*\.\.\.$/.test(line)), 'Long bodies have a visibly truncated summary');
        assert.ok(lines.filter((line) => /^(→ |  )Task/.test(line)).every((line) => !line.includes('Description')), 'Descriptions appear below the list, not in squeezed columns');
        if (phase++ === 0) {
          panel.handleInput('\x0e');
          assert.match(render().join('\n'), /→ Task 2:.*\n[\s\S]*Description 2:/);
          for (const [rows, columns] of [[16, 40], [24, 80], [30, 100]]) {
            terminal.rows = rows; terminal.columns = columns;
            panel.handleInput('\x19');
            assert.equal(finished, false, 'A resize must render before selection can act');
            assert.ok(render().some((line) => line.startsWith('→ Task 2:')));
          }
          terminal.rows = 8; terminal.columns = 16;
          render(); panel.handleInput('\x19');
          assert.equal(finished, false, 'Hidden actions cannot run in a tiny terminal');
          terminal.rows = 30; terminal.columns = 100;
          render();
          await host.refresh(uri);
          assert.equal(finished, true, 'View updates close the old menu before reopening');
        } else if (phase === 2) {
          assert.ok(lines.some((line) => line.startsWith('→ Task 2:')), 'Live updates preserve focus');
          panel.handleInput('\x12');
        } else if (phase === 3) {
          assert.ok(lines.some((line) => line.startsWith('→ Task 2:')), 'Manual refresh preserves focus');
          panel.handleInput('\x19');
        } else if (phase === 4) panel.handleInput('\x18');
        else controller.abort();
        assert.ok(finished, 'Cancel, refresh, selection, and shutdown complete their menu');
        return answer;
      } finally { panel.dispose(); }
    },
  } };
  const host = new NativeUI({ appendEntry() {} } as any, () => client, () => ({ signal: controller.signal, timeout: 5000 }));
  try {
    keys.setUserBindings({ ...original, 'tui.select.up': 'ctrl+p', 'tui.select.down': 'ctrl+n',
      'tui.select.confirm': 'ctrl+y', 'tui.select.cancel': 'ctrl+x' });
    await host.start(ctx, '/test/gateway.json');
    await host.open('demo', ctx, { settings: async () => assert.fail('No settings requested') });
    assert.equal(actions, 1);
    await host.open('demo', ctx, { settings: async () => assert.fail('No settings requested') });
    assert.equal(phase, 5);
  } finally { keys.setUserBindings(original); await host.stop(); }
});

// One fixture covers the transport plus the actual generic renderer/action loop.
test('native UI routes privately, renders safely, persists host state, and rejects malformed views', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'native-ui-'));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const config = path.join(dir, 'gateway.json');
  const fixture = `
    import {Server} from '@modelcontextprotocol/sdk/server/index.js';
    import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
    import {ListResourcesRequestSchema,ReadResourceRequestSchema,ListToolsRequestSchema,McpError} from '@modelcontextprotocol/sdk/types.js';
    import {z} from 'zod';
    const server = new Server({name:'ui-test',version:'1'}, {capabilities:{tools:{},resources:{},experimental:{'native-ui-v1':{}}}});
    const view = (state={},scoped=false) => ({version:1,title:'Remote settings',revision:'r1',state,controls:[{id:'save',kind:'text',label:'Label',value:state.label??'Original',confirm:'Save label?',...(scoped?{revision:'action1'}:{})}],footer:[{text:'Remote footer'}]});
    server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[]}));
    server.setRequestHandler(ListResourcesRequestSchema,async()=>({resources:[{uri:'test://root',name:'Remote',mimeType:'application/vnd.mcp-native-ui+json'}]}));
    server.setRequestHandler(ReadResourceRequestSchema,async r=>({contents:[{uri:'test://root',mimeType:'application/vnd.mcp-native-ui+json',text:JSON.stringify(view(r.params._meta?.['native-ui/context']?.state,r.params._meta?.['native-ui/features']?.actionRevisions===true))}]}));
    server.setRequestHandler(z.object({method:z.literal('native-ui/action'),params:z.any()}),async r=>{
      if(r.params.action==='disconnect') process.exit(0);
      if(r.params.uri!=='test://root'||r.params.action!=='save') throw Error('Wrong routing');
      const scoped=r.params._meta?.['native-ui/features']?.actionRevisions===true;
      if(r.params.revision!==(scoped?'action1':'r1')) throw Error('Stale revision');
      if(r.params.value==='stale') throw new McpError(-33003,'View changed; refresh before acting',{'native-ui/action':{status:'not-applied',reason:'stale-view'}});
      if(r.params.value==='unknown') throw Error('View changed; refresh before acting');
      if(r.params.value==='malformed') throw new McpError(-33003,'View changed; refresh before acting',{'native-ui/action':{status:'not-applied',reason:'other'}});
      if(r.params._meta['local-stdio-mcp-gateway/serviceId']!=='demo') throw Error('Missing service identity');
      if(r.params._meta['native-ui/context'].conversationId!=='conversation') throw Error('Wrong conversation');
      return {view:view({label:r.params.value},scoped)};
    });
    await server.connect(new StdioServerTransport());
  `;
  await writeFile(config, JSON.stringify({ servers: { demo: { command: process.execPath, args: ['--input-type=module', '-e', fixture], cwd: root } } }));
  const client = new Client({ name: 'native-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist/cli.js'), '--config', config], stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const entries: any[] = [];
  const statuses = new Map();
  let rounds = 0, confirms = 0;
  const updated = ' \tUpdated\n ' + ' '.repeat(80) + 'tail';
  let inputValue: string | undefined = JSON.stringify(updated);
  let onInput: () => void | Promise<void> = () => {};
  const ctx: any = { mode: 'tui', hasUI: true, sessionManager: { getSessionId: () => 'conversation', getBranch: () => entries }, ui: {
    setStatus: (key: string, value: string) => statuses.set(key, value), notify: (message: string) => assert.fail(message),
    confirm: async () => assert.fail('Native action confirmations must use the scrollable review'),
    custom: async (factory: Function) => {
      let result;
      const component = factory({ terminal: { rows: 24 }, requestRender() {} }, { fg: (_: string, text: string) => text }, {}, (value: unknown) => { result = value; });
      const rendered = component.render(80).join('\n');
      if (rendered.includes('JSON value')) {
        await onInput();
        if (inputValue !== undefined) { component.handleInput('\x01'); component.handleInput('\x0b'); component.handleInput(inputValue); }
        component.handleInput('\r');
      } else if (rendered.includes('Save label?')) {
        confirms++;
        const disclosed = rendered.replace(/\n/g, '');
        if (inputValue === JSON.stringify(updated)) assert.ok(disclosed.includes('\\u0020'.repeat(80)), 'Every significant space must remain explicit across wrapping');
        assert.match(rendered, /Enter confirm/);
        component.handleInput('\r');
        assert.equal(result, true);
      } else {
        assert.match(rendered, /Remote settings/);
        assert.match(component.render(54).join('\n'), /escape.*close/);
        assert.ok(component.render(8).every((line: string) => [...clean(line)].length <= 8));
        component.render(80);
        component.handleInput(rounds++ === 0 ? '\r' : '\x1b');
      }
      component.dispose();
      return result;
    },
  } };
  const pi: any = { appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data }) };
  const host = new NativeUI(pi, () => client, () => ({ signal: new AbortController().signal, timeout: 5000 }));
  try {
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ['gateway__identity']);
    await host.start(ctx, config);
    assert.equal(statuses.get('gateway-ui:demo'), 'Remote footer');
    const wireRequest = client.request.bind(client), wireRead = client.readResource.bind(client);
    let newer = false;
    client.readResource = async (...args) => {
      const result = await wireRead(...args);
      const item = result.contents[0];
      if (newer && 'text' in item) item.text = JSON.stringify({ ...JSON.parse(item.text), footer: [{ text: 'Newest task data' }] });
      return result;
    };
    client.request = (async (request: any, ...args: any[]) => {
      const result = await (wireRequest as any)(request, ...args);
      if (request.method === 'native-ui/action') { newer = true; await host.refresh('gateway-resource://demo/test%3A%2F%2Froot'); }
      return result;
    }) as typeof client.request;
    await host.open('demo', ctx);
    assert.equal(confirms, 1);
    assert.equal((host.meta('demo')['native-ui/context'] as any).state.label, updated);
    assert.equal(statuses.get('gateway-ui:demo'), 'Newest task data', 'Action snapshot must not overwrite a newer notification read');
    client.request = wireRequest; client.readResource = wireRead;
    rounds = 0; inputValue = undefined;
    await host.open('demo', ctx);
    assert.equal((host.meta('demo')['native-ui/context'] as any).state.label, updated, 'No-op edit through real Input preserves tabs and boundary whitespace');
    host.stop(); await host.start(ctx, config);
    assert.equal((host.meta('demo')['native-ui/context'] as any).state.label, updated);
    const uri = 'gateway-resource://demo/test%3A%2F%2Froot';
    const originalRead = client.readResource.bind(client);
    // Exercise actual proxy errors and edits held across unrelated/relevant updates.
    const notices: string[] = [];
    const originalNotify = ctx.ui.notify;
    ctx.ui.notify = (message: string) => notices.push(message);
    let generation = 0, scopedRevision: string | undefined = 'action1', scopedActions = 0;
    client.readResource = async (...args) => {
      const result = await originalRead(...args);
      const item = result.contents[0];
      if ('text' in item) {
        const next = JSON.parse(item.text);
        next.revision = `view-${generation}`;
        next.controls[0].revision = scopedRevision;
        item.text = JSON.stringify(next);
      }
      return result;
    };
    client.request = ((request: any, ...args: any[]) => {
      if (request.method === 'native-ui/action') scopedActions++;
      return (wireRequest as any)(request, ...args);
    }) as typeof client.request;
    onInput = async () => { generation++; await host.refresh(uri); };
    rounds = 0; inputValue = JSON.stringify('Scoped save');
    await host.open('demo', ctx);
    assert.equal(scopedActions, 1, 'Unrelated full-view changes must not reject an unchanged control revision');
    assert.equal(notices.length, 0);
    const capabilities = client.getServerCapabilities.bind(client);
    client.getServerCapabilities = () => ({ ...capabilities(), experimental: { 'native-ui-v1': {} } });
    assert.equal(host.meta('demo')['native-ui/features'], undefined, 'An older gateway must not negotiate unsupported response fields');
    scopedRevision = undefined;
    rounds = 0; scopedActions = 0;
    await host.open('demo', ctx);
    assert.equal(scopedActions, 0, 'Legacy controls retain the full-view guard');
    assert.ok(notices.pop()?.includes('Action not applied.'));
    client.getServerCapabilities = capabilities;
    scopedRevision = 'action1';
    onInput = async () => { scopedRevision = 'changed'; await host.refresh(uri); };
    rounds = 0;
    await host.open('demo', ctx);
    assert.equal(scopedActions, 0, 'Relevant control changes are rejected before dispatch');
    assert.ok(!notices.pop()?.includes('may have committed'));
    onInput = () => {}; scopedRevision = 'action1';
    for (const value of ['stale', 'unknown', 'malformed']) {
      rounds = 0; scopedActions = 0; inputValue = JSON.stringify(value);
      await host.open('demo', ctx);
      assert.equal(scopedActions, 1, 'Failed actions must never be replayed');
      const notice = notices.pop()!;
      assert.equal(notice.includes('may have committed'), value !== 'stale', 'Only structured pre-write conflicts are definitely rejected');
      if (value === 'stale') assert.match(notice, /Action not applied: view changed/);
    }
    ctx.ui.notify = originalNotify;
    client.request = wireRequest; client.readResource = originalRead;
    onInput = () => {}; inputValue = undefined;
    let release!: () => void, started!: () => void, reads = 0;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const reading = new Promise<void>((resolve) => { started = resolve; });
    client.readResource = async (...args) => {
      const result = await originalRead(...args);
      const count = ++reads;
      if (count === 1) { started(); await held; }
      const item = result.contents[0];
      if ('text' in item) item.text = JSON.stringify({ ...JSON.parse(item.text), footer: [{ text: `Read ${count}` }] });
      return result;
    };
    const pending = host.refresh(uri);
    await reading;
    const changed = host.refresh(uri); release();
    await Promise.all([pending, changed]);
    assert.equal(reads, 2, 'An update arriving after a snapshot needs another read');
    assert.equal(statuses.get('gateway-ui:demo'), 'Read 2');
    const notify = ctx.ui.notify;
    ctx.ui.notify = () => {};
    client.readResource = async () => { throw new Error('Temporary view read failure'); };
    await host.refresh(uri);
    assert.equal(host.has('demo'), true, 'An advertised app stays selectable so a failed view can be retried');
    client.readResource = originalRead;
    await host.open('demo', ctx);
    assert.equal(statuses.get('gateway-ui:demo'), 'Remote footer');
    ctx.ui.notify = notify;
    rounds = 0;
    const originalRequest = client.request.bind(client);
    let actions = 0;
    client.request = ((request: any, ...args: any[]) => { if (request.method === 'native-ui/action') actions++; return (originalRequest as any)(request, ...args); }) as typeof client.request;
    onInput = () => { host.invalidate('demo'); };
    ctx.ui.notify = () => {};
    await host.open('demo', ctx);
    assert.equal(actions, 0, 'Invalidation during input must prevent dispatch');
    assert.equal(host.has('demo'), false, 'Disconnected app is no longer advertised');
    assert.equal(statuses.get('gateway-ui:demo'), undefined);
    await host.start(ctx, config);
    let invalidated!: () => void;
    const gone = new Promise<void>((resolve) => { invalidated = resolve; });
    client.setNotificationHandler(InvalidatedSchema, ({ params }) => { host.invalidate(params.service); invalidated(); });
    await assert.rejects(client.request({ method: 'native-ui/action', params: { uri, action: 'disconnect', revision: 'r1' } }, ActionResultSchema));
    await gone;
    assert.equal(statuses.get('gateway-ui:demo'), undefined, 'Child exit clears the native footer');
    assert.throws(() => editorText('\x1b]52;c;payload\x07'), /terminal controls/);
    await assert.rejects(client.request({ method: 'native-ui/action', params: { uri: 'gateway-resource://unknown/x', action: 'save', revision: 'r1' } }, ActionResultSchema));
    const base = { version: 1, title: 'Test', revision: '1', state: {}, controls: [] };
    assert.throws(() => ViewSchema.parse({ ...base, version: 2 }));
    assert.throws(() => ViewSchema.parse({ ...base, controls: [{ id: 'a', label: 'A', kind: 'action' }, { id: 'a', label: 'B', kind: 'action' }] }));
    assert.equal(footerText(ViewSchema.parse({ ...base, footer: [{ text: '\x1b[31mUnsafe', url: 'javascript:alert(1)' }] })), 'Unsafe');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let input: any, completed = false;
      const controller = new AbortController();
      const pendingInput = inputSettings({ ui: { custom: async (factory: Function) => new Promise((resolve) => {
        input = factory({ terminal: { rows: 24, columns: 80 }, requestRender() {} }, { fg: (_: string, s: string) => s }, {}, (value: unknown) => { completed = true; resolve(value); });
        input.render(80);
      }) } } as any, 'Long edit', JSON.stringify(updated), { signal: controller.signal });
      t.mock.timers.tick(60_000);
      assert.equal(completed, false, 'RPC timeouts must not discard an interactive edit');
      input.handleInput('\r');
      assert.equal(JSON.parse((await pendingInput)!), updated);
      input.dispose();
    } finally { t.mock.timers.reset(); }
  } finally { host.stop(); await client.close(); await transport.close(); await rm(dir, { recursive: true, force: true }); }
});
