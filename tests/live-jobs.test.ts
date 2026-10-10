import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ResourceUpdatedNotificationSchema, ResourceListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { visibleWidth } from '@earendil-works/pi-tui';

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
    server.setRequestHandler(ListResourcesRequestSchema, async()=>({resources:listed?[{uri,name:'Jobs',mimeType}]:[]}));
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
  await writeFile(config, JSON.stringify({ timeoutMs: 5000, servers: Object.fromEntries(['alpha', 'beta'].map(name => [name, {
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
    assert.equal((await client.listResources()).resources.length, 2);
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
    assert.equal((await client.listResources()).resources.length, 1);
    await client.close();

    const { loadExtensions } = await import(pathToFileURL(path.join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js')).href);
    const loaded = await loadExtensions([path.join(root, 'pi/gateway.ts')], root);
    assert.deepEqual(loaded.errors, []);
    loaded.runtime.flagValues.set('gateway-config', config);
    const ext = loaded.extensions[0];
    let widget: { render: (width: number) => string[] } | undefined;
    let mounts = 0;
    let rows = 24;
    const ctx = { cwd: dir, hasUI: true, mode: 'tui', ui: {
      setWidget: (_key: string, factory: Function | undefined) => {
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
      await state({ jobs: [job('running', { current: { name: 'read', args: 'src/gateway.ts' } })] });
      await until(() => text().includes('src/gateway.ts'));
      assert.match(text(), /test\/model · high/);
      assert.match(text(), /Inspect live panel lifecycle/);
      const before = JSON.parse((await state({})).content[0].text).reads;
      await new Promise(resolve => setTimeout(resolve, 1100));
      const after = JSON.parse((await state({})).content[0].text).reads;
      assert.equal(after, before, 'Local elapsed clock does not poll MCP');
      await state({ jobs: [job('queued', { queueReason: 'resource', task: '\u001b[31mUnicode 界界界\nnot another row' })] });
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
