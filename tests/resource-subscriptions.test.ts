import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ResourceUpdatedNotificationSchema, ResourceListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const uri = (service: string) => `gateway-resource://${service}/test%3A%2F%2Fstate`;
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) assert.fail('Resource notification did not arrive');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

// Retained wire coverage from the removed service-specific live-panel test.
test('resource subscriptions route by owner, deduplicate, filter updates and report disconnects', { timeout: 20_000 }, async () => {
  const dir = await mkdtemp('/tmp/gateway-resource-subscriptions-');
  const config = path.join(dir, 'gateway.json');
  const service = `
    import { Server } from '@modelcontextprotocol/sdk/server/index.js';
    import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
    import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
    const uri='test://state', mimeType='application/json';
    const server=new Server({name:'state',version:'1'}, {capabilities:{tools:{},resources:{subscribe:true,listChanged:true}}});
    let values=[], reads=0, subscriptions=0;
    server.setRequestHandler(ListResourcesRequestSchema, async()=>{
      await new Promise(resolve=>setTimeout(resolve,400));
      return {resources:[{uri,name:'State',mimeType}]};
    });
    server.setRequestHandler(SubscribeRequestSchema, async()=>{subscriptions++;return {}});
    server.setRequestHandler(UnsubscribeRequestSchema, async()=>{subscriptions--;return {}});
    server.setRequestHandler(ReadResourceRequestSchema, async()=>{reads++;return {contents:[{uri,mimeType,text:JSON.stringify(values)}]}});
    server.setRequestHandler(ListToolsRequestSchema, async()=>({tools:[{name:'state',inputSchema:{type:'object'}}]}));
    server.setRequestHandler(CallToolRequestSchema, async request=>{
      const input=request.params.arguments;
      if(input.values) {values=input.values;for(let i=0;i<10;i++) await server.sendResourceUpdated({uri});}
      if(input.exit) setTimeout(()=>process.exit(0),30);
      return {content:[{type:'text',text:JSON.stringify({reads,subscriptions})}]};
    });
    await server.connect(new StdioServerTransport());
  `;
  await writeFile(config, JSON.stringify({ timeoutMs: 1000, mcpServers: Object.fromEntries(['alpha', 'beta', 'gamma'].map(name => [name, {
    command: process.execPath, args: ['--input-type=module', '-e', service], cwd: root,
  }])) }));
  const client = new Client({ name: 'subscription-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist/cli.js'), '--config', config], stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const notifications: string[] = [];
  let lists = 0;
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, update => { notifications.push(update.params.uri); });
  client.setNotificationHandler(ResourceListChangedNotificationSchema, () => { lists++; });
  try {
    await client.connect(transport);
    assert.equal(client.getServerCapabilities()?.resources?.subscribe, true);
    assert.equal((await client.listResources()).resources.length, 3);
    await client.callTool({ name: 'alpha__state', arguments: { values: ['first'] } });
    assert.deepEqual(notifications, [], 'Unsubscribed changes are not forwarded');
    await client.subscribeResource({ uri: uri('alpha') });
    await client.subscribeResource({ uri: uri('alpha') });
    const probe = await client.callTool({ name: 'alpha__state', arguments: { values: ['second'] } });
    assert.equal(JSON.parse((probe.content as { text: string }[])[0].text).subscriptions, 1);
    await until(() => notifications.length === 10);
    await client.callTool({ name: 'beta__state', arguments: { values: ['other'] } });
    assert.ok(notifications.every(item => item === uri('alpha')));
    assert.equal((await client.readResource({ uri: uri('alpha') })).contents[0].uri, uri('alpha'));
    await client.unsubscribeResource({ uri: uri('alpha') });
    const unsubscribed = await client.callTool({ name: 'alpha__state', arguments: { values: ['last'] } });
    assert.equal(JSON.parse((unsubscribed.content as { text: string }[])[0].text).subscriptions, 0);
    assert.equal(notifications.length, 10);
    await assert.rejects(client.subscribeResource({ uri: uri('missing') }));
    await client.callTool({ name: 'alpha__state', arguments: { exit: true } });
    await until(() => lists > 0);
    assert.equal((await client.listResources()).resources.length, 2);
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
