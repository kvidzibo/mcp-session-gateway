import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { randomBytes } from 'node:crypto';
import { OPERATOR_ENV, OPERATOR_LIST, OPERATOR_GET, OPERATOR_UPDATE, OperatorServicesSchema, SettingsDocumentSchema } from '../src/settings.js';

const root = resolve(import.meta.dirname, '..');
test('operator settings stay private, route by service, and require confirmed schema-valid revisioned saves', { timeout: 30_000 }, async () => {
  const dir = await mkdtemp('/tmp/gateway-settings-');
  const config = join(dir, 'gateway.json');
  const service = `
    import { Server } from '@modelcontextprotocol/sdk/server/index.js';
    import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
    import { z } from 'zod/v4';
    import { McpError } from '@modelcontextprotocol/sdk/types.js';
    const token = process.env.SERVICE_SETTINGS_TOKEN;
    if(process.env.MCP_GATEWAY_SETTINGS_TOKEN) throw new Error('Upstream token leaked');
    delete process.env.SERVICE_SETTINGS_TOKEN;
    const server = new Server({name:'settings-fixture',version:'1'}, {capabilities:{experimental:{'com.kvidzibo/settings':{
      version:1,getMethod:'kvidzibo/settings/get',updateMethod:'kvidzibo/settings/update',authorization:'token',audience:'operator'
    }}}});
    let revision = 0;
    let values = { worker:{ model:'test/old', thinking:'high' }, enabled:false, count:1, note:'original', fixed:'locked' };
    const describe = () => ({schemaVersion:1,title:'Reusable service settings',revision:String(revision),writable:true,applyTo:'future-jobs',
      values,models:[{id:'test/old',label:'Old model',available:true,thinking:['high']},{id:'test/new',label:'New model',available:true,thinking:['off']},{id:'test/missing',label:'Missing',available:false,thinking:['high']}],
      schema:{type:'object',additionalProperties:false,properties:{worker:{type:'object',properties:{model:{type:'string'},thinking:{type:'string'}},required:['model','thinking']},enabled:{type:'boolean'},count:{type:'integer',minimum:1},note:{type:'string'},fixed:{type:'string',readOnly:true}}}});
    const auth = (actual) => { if(!token || actual !== token) throw new McpError(-33001,'Unauthorized'); };
    server.setRequestHandler(z.object({method:z.literal('kvidzibo/settings/get'),params:z.object({token:z.string()})}), async request => {auth(request.params.token);return describe();});
    server.setRequestHandler(z.object({method:z.literal('kvidzibo/settings/update'),params:z.object({token:z.string(),revision:z.string(),patch:z.record(z.string(),z.unknown())})}), async request => {
      auth(request.params.token);
      if(request.params.revision !== String(revision)) throw new McpError(-33002,'Revision conflict');
      const patch = request.params.patch;
      if(patch.worker) values.worker = {...values.worker,...patch.worker};
      for(const key of ['enabled','count','note']) if(key in patch) values[key] = patch[key];
      if(values.worker.model === 'test/new' && values.worker.thinking !== 'off') throw new McpError(-32602,'Unsupported reasoning');
      revision++; return describe();
    });
    await server.connect(new StdioServerTransport());
  `;
  await writeFile(config, JSON.stringify({ servers: {
    alpha: { command: process.execPath, args: ['--input-type=module', '-e', service], cwd: root, settings: { tokenEnv: 'SERVICE_SETTINGS_TOKEN' } },
    beta: { command: process.execPath, args: ['--input-type=module', '-e', service], cwd: root, settings: { tokenEnv: 'SERVICE_SETTINGS_TOKEN' } },
    disabled: { command: process.execPath, args: ['--input-type=module', '-e', service], cwd: root },
  } }));
  const token = randomBytes(32).toString('base64url');
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'dist/cli.js'), '--config', config], env: { [OPERATOR_ENV]: token }, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'settings-test', version: '1' });
  const get = (service: string) => client.request({ method: OPERATOR_GET, params: { token, service } }, SettingsDocumentSchema);
  try {
    await client.connect(transport);
    await assert.rejects(client.request({ method: OPERATOR_LIST, params: { token: 'wrong' } }, OperatorServicesSchema));
    assert.deepEqual((await client.request({ method: OPERATOR_LIST, params: { token } }, OperatorServicesSchema)).services.map((s) => s.name).sort(), ['alpha', 'beta']);
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ['gateway__identity']);
    await assert.rejects(client.callTool({ name: 'gateway/settings/get', arguments: { token, service: 'alpha' } }));
    await assert.rejects(get('disabled'));
    const before = await get('alpha');
    await client.request({ method: OPERATOR_UPDATE, params: { token, service: 'alpha', revision: before.revision, patch: { enabled: true } } }, SettingsDocumentSchema);
    await assert.rejects(client.request({ method: OPERATOR_UPDATE, params: { token, service: 'alpha', revision: before.revision, patch: { enabled: false } } }, SettingsDocumentSchema));
    assert.equal((await get('beta')).values.enabled, false);
    assert.ok(!JSON.stringify(await get('alpha')).includes(token));

    const { loadExtensions } = await import(pathToFileURL(join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js')).href);
    const loaded = await loadExtensions([join(root, 'pi/gateway.ts')], root);
    assert.deepEqual(loaded.errors, []);
    loaded.runtime.flagValues.set('gateway-config', config);
    const ext = loaded.extensions[0];
    assert.deepEqual([...ext.tools.keys()].sort(), ['gateway_call', 'gateway_tools']);
    let step = 0;
    let confirmations = 0;
    const notices: string[] = [];
    const ctx = { cwd: root, hasUI: true, mode: 'tui', ui: {
      select: async (title: string, choices: string[]) => {
        switch (step++) {
          case 0: assert.equal(title, 'MCP child-server settings'); return choices.find((s) => s.includes('alpha'));
          case 1: return choices.find((s) => s.includes('worker/model'));
          case 2: assert.ok(!choices.some((s) => s.includes('Missing'))); return choices.find((s) => s.includes('New model'));
          case 3: assert.deepEqual(choices, ['off']); return 'off';
          case 4: return choices.find((s) => s.includes('enabled:'));
          case 5: return choices.find((s) => s.endsWith('true'));
          case 6: return choices.find((s) => s.includes('count:'));
          case 7: return choices.find((s) => s.startsWith('Save changes'));
          case 8: return choices.find((s) => s.includes('count:'));
          case 9: return choices.find((s) => s.startsWith('Save changes'));
          case 10: return choices.find((s) => s.startsWith('Save changes'));
          default: assert.match(title, /Settings saved/); assert.ok(choices.some((s) => /fixed.*read-only/.test(s))); return 'Back';
        }
      },
      input: async () => step === 7 ? '0' : '2',
      confirm: async (_title: string, preview: string) => {
        assert.match(preview, /worker\/model: "test\/old" → "test\/new"/);
        assert.match(preview, /worker\/thinking: "high" → "off"/);
        assert.match(preview, /enabled: false → true/);
        assert.match(preview, /count: 1 → 2/);
        return ++confirmations > 1; // First decline must not write.
      },
      notify: (text: string) => { notices.push(text); },
    } };
    const dispatch = async (event: string) => { for (const handler of ext.handlers.get(event) ?? []) await handler({ type: event }, ctx); };
    try {
      await dispatch('session_start');
      await ext.commands.get('mcp-settings').handler('', ctx);
      assert.equal(confirmations, 2);
      assert.ok(notices.some((s) => s.includes('must be >= 1')));
      // Close/reload creates new fixture state, so inspect the returned menu above for saved feedback.
    } finally { await dispatch('session_shutdown'); }
    // A client without the private operator environment gets no settings API.
    const ordinary = new Client({ name: 'no-operator', version: '1' });
    const wire = new StdioClientTransport({ command: process.execPath, args: [join(root, 'dist/cli.js'), '--config', config], stderr: 'pipe' });
    wire.stderr?.on('data', () => {});
    try {
      await ordinary.connect(wire);
      await assert.rejects(ordinary.request({ method: OPERATOR_LIST, params: { token } }, OperatorServicesSchema));
    } finally { await ordinary.close(); await wire.close(); }
  } finally { await client.close(); await transport.close(); await rm(dir, { recursive: true, force: true }); }
});
