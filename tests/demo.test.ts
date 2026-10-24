import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { handleElicitation } from '../src/elicitation.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uri = 'gateway-resource://demo/demo%3A%2F%2Fcounter';

test('approvals fail closed, resource refresh stays in UI, and the adapter loads through Pi', { timeout: 30_000 }, async () => {
  const dir = await mkdtemp('/tmp/gateway-demo-');
  const config = path.join(dir, 'config.json');
  const oldEnv = process.env.MCP_PANEL_TEST_ENV;
  process.env.MCP_PANEL_TEST_ENV = 'interpolation-works';
  const checks = `
    import { Server } from '@modelcontextprotocol/sdk/server/index.js';
    import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
    import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
    const server = new Server({name:'checks',version:'1'}, {capabilities:{tools:{},resources:{}}});
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({resources:[{uri:'checks://slow',name:'Slow resource'}]}));
    server.setRequestHandler(ReadResourceRequestSchema, async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
      await server.elicitInput({message:'Late approval',requestedSchema:{type:'object',properties:{confirm:{type:'boolean'}},required:['confirm']}});
      return {contents:[{uri:'checks://slow',text:'Read finished'}]};
    });
    const schema = {$schema:'https://json-schema.org/draft/2020-12/schema',$id:'urn:test:input',type:'object',allOf:[{properties:{value:{type:'integer'}}}],required:['value'],unevaluatedProperties:false};
    server.setRequestHandler(ListToolsRequestSchema, async () => ({tools:[
      {name:'structured',inputSchema:schema,_meta:{ui:{visibility:['model','app']}}},
      {name:'app',inputSchema:{type:'object'},_meta:{ui:{visibility:['app']}}},
      {name:'slow',inputSchema:{type:'object'}}
    ]}));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      if(request.params.name === 'slow') {
        // Deliberately ignore cancellation and elicit late, as a poorly behaved service could.
        await new Promise(resolve => setTimeout(resolve, 300));
        await server.elicitInput({message:'Late approval',requestedSchema:{type:'object',properties:{confirm:{type:'boolean'}},required:['confirm']}});
      }
      return {content:[],structuredContent:{value:request.params.arguments?.value,env:process.env.PROBE},_meta:{secret:'private-meta'}};
    });
    await server.connect(new StdioServerTransport());
  `;
  await writeFile(config, JSON.stringify({ timeoutMs: 5000, servers: {
    demo: { command: process.execPath, args: [path.join(root, 'dist/examples/demo-service.js')] },
    checks: { command: process.execPath, args: ['--input-type=module', '-e', checks], cwd: root, env: { PROBE: '${MCP_PANEL_TEST_ENV}' } },
    readchecks: { command: process.execPath, args: ['--input-type=module', '-e', checks], cwd: root, env: { PROBE: '${MCP_PANEL_TEST_ENV}' } },
    zerochecks: { command: process.execPath, args: ['--input-type=module', '-e', checks], cwd: root, env: { PROBE: '${MCP_PANEL_TEST_ENV}' } },
  } }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist/cli.js'), '--config', config], env: { MCP_PANEL_TEST_ENV: process.env.MCP_PANEL_TEST_ENV }, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'demo-test', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  let decision: 'accept' | 'decline' | 'cancel' = 'accept';
  let pending: (() => void) | undefined;
  let cancelledPrompt: Promise<void> | undefined;
  let latePrompts = 0;
  client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
    if (request.params.message.includes('Late approval')) {
      latePrompts++;
      return { action: 'accept', content: { confirm: true } };
    }
    assert.match(request.params.message, /^\[demo\] demo__increment:/);
    assert.equal(request.params._meta?.['local-stdio-mcp-gateway/serviceId'], 'demo');
    if (pending) {
      cancelledPrompt = new Promise<void>((resolve) => extra.signal.addEventListener('abort', () => resolve(), { once: true }));
      pending();
      await cancelledPrompt;
      return { action: 'cancel' };
    }
    return decision === 'accept' ? { action: 'accept', content: { confirm: true } } : { action: decision };
  });
  try {
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ['checks__slow', 'checks__structured', 'demo__increment', 'gateway__identity', 'readchecks__slow', 'readchecks__structured', 'zerochecks__slow', 'zerochecks__structured']);
    await assert.rejects(client.callTool({ name: 'checks__app', arguments: {} }));
    // Reuse completed initialization ID 0 in a valid raw upstream call.
    client.onerror = () => {}; // Its raw response has no SDK response waiter.
    await transport.send({ jsonrpc: '2.0', id: 0, method: 'tools/call', params: { name: 'zerochecks__slow', arguments: {} } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await transport.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 0 } });
    await assert.rejects(client.callTool({ name: 'zerochecks__slow', arguments: {} }));
    assert.ok(!(await client.listTools()).tools.some(({ name }) => name.startsWith('zerochecks__')));
    assert.equal(latePrompts, 0);
    const delayedAbort = new AbortController();
    const late = client.callTool({ name: 'checks__slow', arguments: {} }, undefined, { signal: delayedAbort.signal });
    const lateFailed = assert.rejects(late);
    // Queue another request immediately after cancelling; it must not inherit late prompts.
    await new Promise((resolve) => setTimeout(resolve, 50));
    delayedAbort.abort();
    const followingFailed = assert.rejects(client.callTool({ name: 'checks__slow', arguments: {} }));
    await lateFailed;
    await followingFailed;
    assert.ok(!(await client.listTools()).tools.some(({ name }) => name.startsWith('checks__')));
    assert.equal(latePrompts, 0);
    const readAbort = new AbortController();
    const cancelledRead = assert.rejects(client.readResource({ uri: 'gateway-resource://readchecks/checks%3A%2F%2Fslow' }, { signal: readAbort.signal }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    readAbort.abort();
    const afterReadFailed = assert.rejects(client.callTool({ name: 'readchecks__slow', arguments: {} }));
    await cancelledRead;
    await afterReadFailed;
    assert.ok(!(await client.listTools()).tools.some(({ name }) => name.startsWith('readchecks__')));
    assert.equal(latePrompts, 0);
    assert.equal((await client.listResources()).resources[0].uri, uri);
    assert.equal((await client.callTool({ name: 'demo__increment', arguments: {} })).isError, undefined);
    for (decision of ['decline', 'cancel'] as const) assert.equal((await client.callTool({ name: 'demo__increment', arguments: {} })).isError, true);
    const stateBeforeCancel = (await client.readResource({ uri })).contents[0];
    assert.ok('text' in stateBeforeCancel);
    assert.match(stateBeforeCancel.text, /Counter: 1/);
    const abort = new AbortController();
    const promptStarted = new Promise<void>((resolve) => { pending = resolve; });
    const interrupted = client.callTool({ name: 'demo__increment', arguments: {} }, undefined, { signal: abort.signal });
    const failed = assert.rejects(interrupted);
    await promptStarted;
    abort.abort();
    await failed;
    await cancelledPrompt;
    await assert.rejects(client.readResource({ uri }));
    assert.ok(!(await client.listTools()).tools.some(({ name }) => name.startsWith('demo__')));
    await assert.rejects(client.readResource({ uri: 'gateway-resource://missing/x' }));
    await client.close();

    // Deliver request 0 and its cancellation in the same synchronous batch.
    const [hostWire, serviceWire] = InMemoryTransport.createLinkedPair();
    const host = new Client({ name: 'immediate-cancel', version: '1' }, { capabilities: { elicitation: { form: {} } } });
    const service = new Server({ name: 'immediate-cancel', version: '1' }, { capabilities: {} });
    let sawCancellation!: (aborted: boolean) => void;
    const observed = new Promise<boolean>((resolve) => { sawCancellation = resolve; });
    handleElicitation(host, hostWire, async (_params, signal) => { sawCancellation(signal.aborted); return { action: 'cancel' }; });
    try {
      await service.connect(serviceWire);
      await host.connect(hostWire);
      const cancel = new AbortController();
      const request = service.elicitInput({ message: 'Immediate cancellation', requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] } }, { signal: cancel.signal });
      const rejected = assert.rejects(request);
      cancel.abort();
      await rejected;
      assert.equal(await observed, true);
    } finally { await host.close(); await service.close(); }

    // Load the actual extension through Pi's jiti loader; never invoke a model.
    const { loadExtensions } = await import(pathToFileURL(path.join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js')).href);
    const loaded = await loadExtensions([path.join(root, 'pi/gateway.ts')], root);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    loaded.runtime.flagValues.set('gateway-config', config);
    loaded.runtime.appendEntry = (customType: string) => assert.ok(['gateway-startup', 'gateway-call-counts'].includes(customType));
    const ext = loaded.extensions[0];
    assert.deepEqual([...ext.tools.keys()].sort(), ['gateway_call', 'gateway_tools']);
    let choice = 'Allow once';
    let waitForCancel = false;
    let promptReady: (() => void) | undefined;
    let promptCancelled: (() => void) | undefined;
    const navigation = ['Services', 'demo', 'Resources', 'Demo counter'];
    const ctx = {
      cwd: root, mode: 'tui', hasUI: true,
      sessionManager: { getSessionId: () => 'demo-test', getBranch: () => [] },
      ui: {
        theme: { fg: (_color: string, text: string) => text }, setStatus() {}, setWidget() {},
        select: async (_title: string, _options: string[], opts: { signal: AbortSignal }) => {
          if (!waitForCancel) return choice;
          promptReady?.();
          await new Promise<void>((resolve) => opts.signal.addEventListener('abort', () => resolve(), { once: true }));
          promptCancelled?.();
          return undefined;
        },
        notify: () => {},
        custom: async (factory: Function) => {
          let renderChanged!: () => void;
          let changed = new Promise<void>((resolve) => { renderChanged = resolve; });
          let answer: unknown;
          const panel = factory({ terminal: { rows: 24, columns: 80 }, requestRender: () => renderChanged() }, { fg: (_color: string, text: string) => text }, {}, (value: unknown) => { answer = value; });
          if (panel.render(78)[1] === 'Allow this service request?') {
            assert.ok(panel.render(78).some((line: string) => line.includes('Enter allow once')));
            panel.handleInput('\r');
            assert.equal(answer, true);
            panel.dispose();
            return answer;
          }
          if (panel.render(78)[1]?.startsWith('Gateway')) {
            const target = navigation.shift();
            if (!target) panel.handleInput('\u001b');
            else {
              for (let i = 0; i < 20 && !panel.render(78).includes(`→ ${target}`); i++) panel.handleInput('\u001b[B');
              assert.ok(panel.render(78).includes(`→ ${target}`));
              panel.handleInput('\r');
            }
            panel.dispose();
            return answer;
          }
          await changed;
          // The initial render starts loading; let the async read finish.
          while (panel.render(50).some((line: string) => line.includes('Loading'))) {
            changed = new Promise<void>((resolve) => { renderChanged = resolve; });
            await changed;
          }
          assert.ok(panel.render(50).some((line: string) => line.includes('Counter: 1')));
          choice = 'Allow once';
          const call = ext.tools.get('gateway_call').definition;
          for (let attempt = 0; attempt < 2; attempt++) {
            const result = await call.execute('panel-confirmation', { name: 'demo__increment', arguments: {} }, undefined, undefined, ctx);
            assert.equal(result.isError, true, 'Repeated confirmations must not unlock an open panel');
          }
          changed = new Promise<void>((resolve) => { renderChanged = resolve; });
          panel.handleInput('r');
          await changed;
          while (panel.render(20).some((line: string) => line.includes('Loading'))) {
            changed = new Promise<void>((resolve) => { renderChanged = resolve; });
            await changed;
          }
          assert.ok(panel.render(50).some((line: string) => line.includes('Counter: 1')));
          panel.handleInput('\u001b');
          panel.dispose();
        },
      },
    };
    const dispatch = async (event: string) => {
      for (const handler of ext.handlers.get(event) ?? []) await handler({ type: event }, ctx);
    };
    try {
      await dispatch('session_start');
      const tool = ext.tools.get('gateway_call').definition;
      const renderArgs = { name: 'checks__structured', arguments: { value: 42 } };
      const renderContext = { args: renderArgs, expanded: false, isPartial: false, executionStarted: true, argsComplete: true, showImages: false, isError: false };
      const renderTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
      assert.match(tool.renderCall(renderArgs, renderTheme, renderContext).render(80).join('\n'), /checks › structured/);
      const invoke = (signal?: AbortSignal) => tool.execute('test', { name: 'demo__increment', arguments: {} }, signal, undefined, ctx);
      // Cancel the first incoming elicitation: its SDK request ID is exactly 0.
      waitForCancel = true;
      const firstReady = new Promise<void>((resolve) => { promptReady = resolve; });
      const firstCancelled = new Promise<void>((resolve) => { promptCancelled = resolve; });
      const firstAbort = new AbortController();
      const firstFailure = assert.rejects(invoke(firstAbort.signal));
      await firstReady;
      firstAbort.abort();
      await firstFailure;
      await firstCancelled;
      waitForCancel = false;
      await dispatch('session_shutdown');
      await dispatch('session_start');
      assert.equal((await invoke()).isError, false);
      for (let round = 0; round < 2; round++) {
        const result = await tool.execute('schema', { name: 'checks__structured', arguments: { value: 42 } }, undefined, undefined, ctx);
        assert.deepEqual(JSON.parse(result.content[0].text), { value: 42, env: 'interpolation-works' });
        assert.match(tool.renderResult(result, { expanded: true, isPartial: false }, renderTheme, renderContext).render(80).join('\n'), /"value": 42/);
        assert.ok(!JSON.stringify(result).includes('private-meta'));
      }
      await assert.rejects(tool.execute('schema', { name: 'checks__structured', arguments: { value: 42, unexpected: true } }, undefined, undefined, ctx), /Invalid arguments/);
      await assert.rejects(tool.execute('app', { name: 'checks__app', arguments: {} }, undefined, undefined, ctx), /app-only/);
      for (choice of ['Decline', 'Cancel']) assert.equal((await invoke()).isError, true);
      await assert.rejects(tool.execute('test', { name: 'demo__increment', arguments: { extra: 1 } }, undefined, undefined, ctx), /Invalid arguments/);
      await ext.commands.get('gateway').handler('', ctx);
      waitForCancel = true;
      const ready = new Promise<void>((resolve) => { promptReady = resolve; });
      const controller = new AbortController();
      const failure = assert.rejects(invoke(controller.signal));
      await ready;
      controller.abort();
      await failure;
      waitForCancel = false;
      await assert.rejects(invoke(), /Unknown|disconnected/);
      await dispatch('session_shutdown');
      ctx.hasUI = false;
      await dispatch('session_start');
      assert.equal((await invoke()).isError, true);
    } finally { await dispatch('session_shutdown'); }
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    if (oldEnv === undefined) delete process.env.MCP_PANEL_TEST_ENV;
    else process.env.MCP_PANEL_TEST_ENV = oldEnv;
    await rm(dir, { recursive: true, force: true });
  }
});
