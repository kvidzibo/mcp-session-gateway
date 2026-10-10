import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { NativeUI } from '../pi/native-ui.js';
import { ActionResultSchema, clean, footerText, ViewSchema } from '../src/native-ui.js';

// One fixture covers the transport plus the actual generic renderer/action loop.
test('native UI routes privately, renders safely, persists host state, and rejects malformed views', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'native-ui-'));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const config = path.join(dir, 'gateway.json');
  const fixture = `
    import {Server} from '@modelcontextprotocol/sdk/server/index.js';
    import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
    import {ListResourcesRequestSchema,ReadResourceRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
    import {z} from 'zod';
    const server = new Server({name:'ui-test',version:'1'}, {capabilities:{tools:{},resources:{},experimental:{'native-ui-v1':{}}}});
    const view = (state={}) => ({version:1,title:'Remote settings',revision:'r1',state,controls:[{id:'save',kind:'text',label:'Label',value:state.label??'Original',confirm:'Save label?'}],footer:[{text:'Remote footer'}]});
    server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[]}));
    server.setRequestHandler(ListResourcesRequestSchema,async()=>({resources:[{uri:'test://root',name:'Remote',mimeType:'application/vnd.mcp-native-ui+json'}]}));
    server.setRequestHandler(ReadResourceRequestSchema,async r=>({contents:[{uri:'test://root',mimeType:'application/vnd.mcp-native-ui+json',text:JSON.stringify(view(r.params._meta?.['native-ui/context']?.state))}]}));
    server.setRequestHandler(z.object({method:z.literal('native-ui/action'),params:z.any()}),async r=>{
      if(r.params.uri!=='test://root'||r.params.action!=='save') throw Error('Wrong routing');
      if(r.params.revision!=='r1') throw Error('Stale revision');
      if(r.params._meta['local-stdio-mcp-gateway/serviceId']!=='demo') throw Error('Missing service identity');
      if(r.params._meta['native-ui/context'].conversationId!=='conversation') throw Error('Wrong conversation');
      return {view:view({label:r.params.value})};
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
  const ctx: any = { mode: 'tui', hasUI: true, sessionManager: { getSessionId: () => 'conversation', getBranch: () => entries }, ui: {
    setStatus: (key: string, value: string) => statuses.set(key, value), notify: (message: string) => assert.fail(message),
    input: async () => 'Updated', confirm: async () => { confirms++; return true; },
    custom: async (factory: Function) => {
      let result;
      const component = factory({ terminal: { rows: 24 }, requestRender() {} }, { fg: (_: string, text: string) => text }, {}, (value: unknown) => { result = value; });
      assert.match(component.render(80).join('\n'), /Remote settings/);
      assert.ok(component.render(8).every((line: string) => [...clean(line)].length <= 8));
      component.handleInput(rounds++ === 0 ? '\r' : '\x1b'); component.dispose();
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
    await host.open('demo', ctx);
    assert.equal(confirms, 1);
    assert.equal((host.meta('demo')['native-ui/context'] as any).state.label, 'Updated');
    host.stop(); await host.start(ctx, config);
    assert.equal((host.meta('demo')['native-ui/context'] as any).state.label, 'Updated');
    await assert.rejects(client.request({ method: 'native-ui/action', params: { uri: 'gateway-resource://unknown/x', action: 'save', revision: 'r1' } }, ActionResultSchema));
    const base = { version: 1, title: 'Test', revision: '1', state: {}, controls: [] };
    assert.throws(() => ViewSchema.parse({ ...base, version: 2 }));
    assert.throws(() => ViewSchema.parse({ ...base, controls: [{ id: 'a', label: 'A', kind: 'action' }, { id: 'a', label: 'B', kind: 'action' }] }));
    assert.equal(footerText(ViewSchema.parse({ ...base, footer: [{ text: '\x1b[31mUnsafe', url: 'javascript:alert(1)' }] })), 'Unsafe');
  } finally { host.stop(); await client.close(); await transport.close(); await rm(dir, { recursive: true, force: true }); }
});
