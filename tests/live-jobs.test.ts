import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ResourceUpdatedNotificationSchema, ResourceListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { visibleWidth } from '@earendil-works/pi-tui';
import { LiveJobs, JOBS_MIME } from '../pi/live-jobs.js';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

const root = fileURLToPath(new URL('../', import.meta.url));
const uri = (service: string) => `gateway-resource://${service}/delegate%3A%2F%2Fjobs`;
const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text };
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) assert.fail('Live panel condition did not arrive');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('failed discovery honors queued changes and UI exceptions cannot escape observers or cleanup', async () => {
  for (const failure of ['mount', 'render', 'repaint', 'remove'] as const) {
    const handlers = new Map<string, Function>();
    let discovery = 0;
    let reads = 0;
    let rejectFirst!: (error: Error) => void;
    const first = new Promise<never>((_resolve, reject) => { rejectFirst = reject; });
    const resource = { uri: uri('alpha'), mimeType: JOBS_MIME, name: 'Jobs' };
    const fake = {
      setNotificationHandler: (schema: any, handler: Function) => handlers.set(schema.shape.method.value, handler),
      removeNotificationHandler: (method: string) => handlers.delete(method),
      listResources: async () => ++discovery === 1 ? first : { resources: [resource] },
      subscribeResource: async () => ({}),
      readResource: async () => {
        reads++;
        return { contents: [{ ...resource, text: JSON.stringify({ schemaVersion: 1, instanceId: 'test', jobs: [
          { jobId: 'one', kind: 'review', model: 'test/model', task: 'Observe', status: 'running', activity: [] },
        ] }) }] };
      },
    };
    let mounted = false;
    let rendered: string[] | undefined;
    const ctx = { ui: { setWidget: (_key: string, factory?: Function) => {
      if (failure === 'mount' || (!factory && failure === 'remove')) throw new Error('UI unavailable');
      if (factory) {
        mounted = true;
        const component = factory({ terminal: { rows: 24 }, requestRender() { if (failure === 'repaint') throw new Error('Dead TUI'); } },
          failure === 'render' ? { ...theme, fg() { throw new Error('Dead theme'); } } : theme);
        rendered = component.render(80);
      }
    } } } as unknown as ExtensionContext;
    const observer = new LiveJobs(fake as unknown as Client, ctx, 1000);
    try {
      const starting = observer.start();
      // A list-change arriving during a failed read still requires another discovery.
      handlers.get('notifications/resources/list_changed')!({});
      rejectFirst(new Error('A service disconnected during listing'));
      await starting;
      await until(() => reads === 1);
      assert.equal(discovery, 2);
      if (failure !== 'mount') assert.ok(mounted);
      if (failure === 'render') assert.deepEqual(rendered, []);
      handlers.get('notifications/resources/updated')!({ params: { uri: resource.uri } });
      await until(() => reads === 2);
      assert.doesNotThrow(() => observer.disconnect());
      assert.doesNotThrow(() => observer.stop());
      assert.equal(handlers.size, 0);
    } finally { observer.stop(); }
  }
});

test('subscriptions route by service and live Pi widget follows jobs without transcript traffic', { timeout: 20_000 }, async () => {
  const dir = await mkdtemp('/tmp/gateway-live-jobs-');
  const config = path.join(dir, 'gateway.json');
  // One focused wire fixture deliberately sends unsolicited updates to test filtering.
  const service = `
    import { Server } from '@modelcontextprotocol/sdk/server/index.js';
    import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
    import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
    const uri='delegate://jobs', mimeType='application/vnd.pi-delegate.jobs+json';
    const server=new Server({name:'jobs',version:'1'}, {capabilities:{tools:{},resources:{subscribe:true,listChanged:true}}});
    let jobs=[], reads=0, subscriptions=0, listed=true;
    server.setRequestHandler(ListResourcesRequestSchema, async()=>{
      await new Promise(resolve=>setTimeout(resolve,400));
      return {resources:listed?[{uri,name:'Jobs',mimeType}]:[]};
    });
    server.setRequestHandler(SubscribeRequestSchema, async()=>{subscriptions++;return {}});
    server.setRequestHandler(UnsubscribeRequestSchema, async()=>{subscriptions--;return {}});
    server.setRequestHandler(ReadResourceRequestSchema, async()=>{reads++;return {contents:[{uri,mimeType,text:JSON.stringify({schemaVersion:1,instanceId:process.env.MCP_GATEWAY_SERVICE_ID,jobs})}]}});
    server.setRequestHandler(ListToolsRequestSchema, async()=>({tools:[{name:'state',inputSchema:{type:'object'}}]}));
    server.setRequestHandler(CallToolRequestSchema, async request=>{
      const input=request.params.arguments;
      if(input.jobs) {jobs=input.jobs;for(let i=0;i<10;i++) await server.sendResourceUpdated({uri});}
      if(input.listed!==undefined) {listed=input.listed;await server.sendResourceListChanged();}
      if(input.exit) setTimeout(()=>process.exit(0),30);
      return {content:[{type:'text',text:JSON.stringify({reads,subscriptions})}]};
    });
    await server.connect(new StdioServerTransport());
  `;
  await writeFile(config, JSON.stringify({ timeoutMs: 1000, mcpServers: Object.fromEntries(['alpha', 'beta', 'gamma'].map(name => [name, {
    command: process.execPath, args: ['--input-type=module', '-e', service], cwd: root,
  }])) }));
  const client = new Client({ name: 'live-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist/cli.js'), '--config', config], stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const notifications: string[] = [];
  let lists = 0;
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, update => { notifications.push(update.params.uri); });
  client.setNotificationHandler(ResourceListChangedNotificationSchema, () => { lists++; });
  const job = (status: string, extra = {}) => ({ jobId: '12345678-test', kind: 'review', model: 'test/model', reasoning: 'high', task: 'Inspect live panel lifecycle', status,
    queuedAt: Date.now() - 10000, startedAt: Date.now() - 5000, activity: [], ...extra });
  try {
    await client.connect(transport);
    assert.equal(client.getServerCapabilities()?.resources?.subscribe, true);
    assert.equal((await client.listResources()).resources.length, 3);
    await client.callTool({ name: 'alpha__state', arguments: { jobs: [job('running')] } });
    assert.deepEqual(notifications, [], 'Unsubscribed changes are not forwarded');
    await client.subscribeResource({ uri: uri('alpha') });
    await client.subscribeResource({ uri: uri('alpha') });
    const probe = await client.callTool({ name: 'alpha__state', arguments: { jobs: [job('queued')] } });
    assert.equal(JSON.parse((probe.content as { text: string }[])[0].text).subscriptions, 1);
    await until(() => notifications.length === 10);
    await client.callTool({ name: 'beta__state', arguments: { jobs: [job('running')] } });
    assert.ok(notifications.every(item => item === uri('alpha')));
    assert.equal((await client.readResource({ uri: uri('alpha') })).contents[0].uri, uri('alpha'));
    await client.unsubscribeResource({ uri: uri('alpha') });
    await client.callTool({ name: 'alpha__state', arguments: { jobs: [job('done')] } });
    assert.equal(notifications.length, 10);
    await assert.rejects(client.subscribeResource({ uri: uri('missing') }));
    await client.callTool({ name: 'alpha__state', arguments: { exit: true } });
    await until(() => lists > 0);
    assert.equal((await client.listResources()).resources.length, 2);
    await client.close();

    const { loadExtensions } = await import(pathToFileURL(path.join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js')).href);
    const loaded = await loadExtensions([path.join(root, 'pi/gateway.ts')], root);
    assert.deepEqual(loaded.errors, []);
    loaded.runtime.flagValues.set('gateway-config', config);
    loaded.runtime.appendEntry = (customType: string) => assert.ok(['gateway-startup', 'gateway-call-counts'].includes(customType));
    const ext = loaded.extensions[0];
    let widget: { render: (width: number) => string[] } | undefined;
    let mounts = 0;
    let rows = 24;
    const ctx = { cwd: dir, hasUI: true, mode: 'tui', sessionManager: { getSessionId: () => 'jobs-test', getBranch: () => [] }, ui: {
      theme, setStatus() {},
      setWidget: (key: string, factory: Function | undefined) => {
        if (key !== 'gateway-live-jobs') return; // Observe only the live-jobs widget.
        if (factory) { mounts++; widget = factory({ terminal: { get rows() { return rows; } }, requestRender() {} }, theme); }
        else widget = undefined;
      },
      notify() {},
    } };
    const dispatch = async (event: string) => { for (const handler of ext.handlers.get(event) ?? []) await handler({ type: event }, ctx); };
    const state = async (arguments_: Record<string, unknown>, name = 'alpha') => ext.tools.get('gateway_call').definition.execute('test', { name: `${name}__state`, arguments: arguments_ }, undefined, undefined, ctx);
    const text = () => widget?.render(100).join('\n') ?? '';
    try {
      await dispatch('session_start');
      const available = await ext.tools.get('gateway_tools').definition.execute('list', {}, undefined, undefined, ctx);
      assert.equal(JSON.parse(available.content[0].text).length, 4, 'Aggregate discovery exceeding 1s must not retire a healthy service');
      await state({ jobs: [job('running', { current: { name: 'read', args: 'src/gateway.ts' } })] });
      await until(() => text().includes('src/gateway.ts'));
      assert.match(text(), /test\/model · high/);
      assert.match(text(), /Inspect live panel lifecycle/);
      const before = JSON.parse((await state({})).content[0].text).reads;
      await new Promise(resolve => setTimeout(resolve, 1100));
      const after = JSON.parse((await state({})).content[0].text).reads;
      assert.equal(after, before, 'Local elapsed clock does not poll MCP');
      await state({ jobs: [job('queued', { queueReason: 'resource', jobId: '\u001b[2J\nunsafe-id', task: '\u001b[31mUnicode 界界界\nnot another row' })] });
      await until(() => text().includes('Waiting: resource'));
      assert.ok(!text().includes('\u001b'), 'Resource text is terminal-sanitized');
      for (const width of [18, 50, 100]) {
        assert.ok(widget!.render(width).every(line => visibleWidth(line) <= width));
      }
      rows = 10;
      assert.ok(widget!.render(30).length <= 5);
      rows = 24;
      await state({ jobs: [job('running', { cancellationRequested: true })] });
      await until(() => text().includes('cancelling'));
      await state({ jobs: [job('done', { finishedAt: Date.now(), durationMs: 5432 })] });
      await until(() => text().includes('finished · unverified · 5s'));
      await state({ jobs: [job('done', { finishedAt: Date.now() - 9000, durationMs: 5432 })] });
      await until(() => text() === '');
      await state({ jobs: [job('running')] });
      await until(() => text().includes('running'));
      await state({ exit: true });
      await until(() => text().includes('Service disconnected'));
      assert.match(text(), /outcome unknown/);
      assert.equal(mounts, 1, 'Updates do not remove/reinsert the widget');
      assert.deepEqual([...ext.tools.keys()].sort(), ['gateway_call', 'gateway_tools'], 'No model-facing panel tools');
    } finally { await dispatch('session_shutdown'); }
    assert.equal(widget, undefined);
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
