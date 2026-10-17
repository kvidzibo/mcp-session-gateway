import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { visibleWidth } from '@earendil-works/pi-tui';
const { click } = createRequire(import.meta.url)('../pi/footer-click.cjs');
import { confirmSettings, editSettings, inputSettings, selectSettingsOption } from '../pi/settings.js';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { OPERATOR_ENV, OPERATOR_LIST, OPERATOR_GET, OPERATOR_UPDATE, OperatorServicesSchema, SettingsDocumentSchema } from '../src/settings.js';

const root = resolve(import.meta.dirname, '..');
test('operator settings stay private, route by service, and require confirmed schema-valid revisioned saves', { timeout: 30_000 }, async (t) => {
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
  await writeFile(config, JSON.stringify({ display: 'full', servers: {
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
    loaded.runtime.appendEntry = (customType: string) => assert.equal(customType, 'gateway-startup');
    const ext = loaded.extensions[0];
    assert.deepEqual([...ext.tools.keys()].sort(), ['gateway_call', 'gateway_tools']);
    let step = 1;
    const navigation = ['Services', 'alpha', 'Settings'];
    let confirmations = 0;
    const notices: string[] = [];
    let countsWidget: { render(width: number): string[] } | undefined;
    const ctx = { cwd: root, hasUI: true, mode: 'tui', sessionManager: { getSessionId: () => 'settings-test', getBranch: () => [] }, ui: {
      theme: { fg: (_color: string, text: string) => text }, setStatus() {},
      setWidget(key: string, factory: any) {
        if (key === 'gateway-call-counts') countsWidget = factory?.({}, this.theme);
      },
      select: async (title: string, choices: string[]) => {
        switch (step++) {
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
      custom: async (factory: Function, options: {overlay:boolean}) => {
        assert.equal(options.overlay, true);
        let result: unknown;
        const panel = factory({terminal:{rows:30,columns:100},requestRender(){}}, {fg: (_color: string, text: string) => text}, {}, (value: unknown) => { result = value; });
        try {
          const lines: string[] = panel.render(98);
          if (lines[1]?.startsWith('Gateway')) {
            const target = navigation.shift();
            if (!target) panel.handleInput('\u001b');
            else {
              for (let i = 0; i < 20 && !panel.render(98).includes(`→ ${target}`); i++) panel.handleInput('\u001b[B');
              assert.ok(panel.render(98).includes(`→ ${target}`));
              panel.handleInput('\r');
            }
          } else if (lines.some((line) => line.includes('JSON value'))) {
            const text = await ctx.ui.input();
            panel.handleInput('\u0001'); panel.handleInput('\u000b'); panel.handleInput(text); panel.handleInput('\r');
          } else if (lines[1] === 'Save child-server settings?') {
            const approved = await ctx.ui.confirm(lines[1], lines.slice(3, -3).join('\n'));
            panel.handleInput(approved ? '\r' : '\u001b');
          } else {
            const choices = lines.filter((line) => /^(→ |  )/.test(line)).map((line) => line.slice(2));
            const choice = await ctx.ui.select(lines[1], choices);
            if (!choice) panel.handleInput('\u001b');
            else { for (let i = 0; i < choices.indexOf(choice); i++) panel.handleInput('\u001b[B'); panel.handleInput('\r'); }
          }
          return result;
        } finally { panel.dispose(); }
      },
    } };
    const dispatch = async (event: string) => { for (const handler of ext.handlers.get(event) ?? []) await handler({ type: event }, ctx); };
    try {
      await dispatch('session_start');
      await ext.commands.get('gateway').handler('', ctx);
      assert.equal(confirmations, 2);
      assert.ok(notices.some((s) => s.includes('must be >= 1')));
      await t.test('Full-display service clicks open only their settings, renew links, and reject busy dialogs', async () => {
        const link = (name: string) => [...countsWidget!.render(140).join('\n').matchAll(/\x1b\]8;;(pi-gateway-action:[^\x07]+)\x07([^\x1b]+)/g)]
          .find((match) => match[2].startsWith(name + ' '))![1];
        const screens: string[] = [];
        let release: (() => void) | undefined;
        let opened: (() => void) | undefined;
        ctx.ui.custom = async (factory: Function) => {
          let answer: unknown;
          const panel = factory({ terminal: { rows: 30, columns: 100 }, requestRender() {} }, ctx.ui.theme, {}, (value: unknown) => { answer = value; });
          try {
            const lines: string[] = panel.render(98);
            assert.ok(lines.some((line) => line.includes('Reusable service settings')));
            assert.ok(!lines.some((line) => line.startsWith('Gateway')));
            screens.push(lines.join('\n'));
            if (opened) await new Promise<void>((resolve) => { release = resolve; opened!(); });
            panel.handleInput('\x1b');
            return answer;
          } finally { panel.dispose(); }
        };
        for (const width of [1, 12, 24, 80, 140]) assert.ok(countsWidget!.render(width).every((line) => visibleWidth(line) <= width));
        for (const name of ['alpha', 'beta', 'alpha']) {
          const old = link(name);
          await click(old);
          assert.match(screens.at(-1)!, new RegExp(`enabled: ${name === 'alpha' ? 'true' : 'false'}`));
          await assert.rejects(click(old), /Action unavailable/);
        }
        const ready = new Promise<void>((resolve) => { opened = resolve; });
        const pending = click(link('alpha'));
        await ready;
        await click(link('beta'));
        assert.equal(notices.at(-1), 'Finish the current gateway dialog first');
        opened = undefined; release!(); await pending;
        const before = screens.length;
        await click(link('disabled'));
        assert.equal(screens.length, before);
        assert.match(notices.at(-1)!, /Settings unavailable/);
        await click(link('beta'));
        assert.equal(screens.length, before + 1, 'Failure releases dialog ownership');
        const stale = link('alpha');
        await dispatch('session_shutdown');
        assert.equal(countsWidget, undefined);
        await assert.rejects(click(stale));
      });
      // Close/reload creates new fixture state, so inspect the returned menu above for saved feedback.
    } finally { await dispatch('session_shutdown'); }
    // Exercise large lists and valid choice schemas without explicit types, plus
    // a resize after approval; none may create an unseen or premature write.
    const dialog = { signal: new AbortController().signal, timeout: 1000 };
    const selected = await selectSettingsOption({ui:{custom: async (factory: Function, options: {overlay:boolean}) => {
      assert.equal(options.overlay, true);
      let answer: unknown;
      const terminal = {rows:18,columns:80};
      const panel = factory({terminal,requestRender(){}}, {fg: (_color: string, text: string) => text}, {}, (value: unknown) => {answer=value;});
      try {
        for (let i=0;i<20;i++) { assert.ok(panel.render(78).length <= terminal.rows-2); panel.handleInput('\u001b[B'); }
        assert.ok(panel.render(78).some((line: string) => line.includes('service-20')));
        terminal.rows=10;
        assert.ok(panel.render(78).length <= 8, 'Tiny selectors fit their entire chrome');
        panel.handleInput('\r'); return answer;
      } finally {panel.dispose();}
    }}} as unknown as ExtensionContext, 'Many services', Array.from({length:35}, (_, i) => `service-${i} ${'wrapped label '.repeat(30)}`), dialog);
    assert.ok(selected?.startsWith('service-20'));
    const approved = await confirmSettings({ui:{custom: async (factory: Function, options: {overlay:boolean}) => {
      assert.equal(options.overlay, true);
      let answer: unknown;
      const terminal = {rows:18,columns:80};
      const panel = factory({terminal,requestRender(){}}, {fg: (_color: string, text: string) => text}, {}, (value: unknown) => {answer=value;});
      try {
        panel.render(78); panel.handleInput('\r'); assert.equal(answer, undefined, 'Unseen changes cannot be approved');
        for(let i=0;i<4;i++) {panel.handleInput('\u001b[6~'); panel.render(78);}
        terminal.rows=10;
        panel.handleInput('\r'); assert.equal(answer, undefined, 'Resize cannot approve stale visibility');
        assert.ok(panel.render(78).length <= 8); panel.handleInput('\r'); assert.equal(answer, undefined);
        for(let i=0;i<32;i++) {panel.handleInput('\u001b[5~'); panel.render(78);}
        for(let i=0;i<32;i++) {panel.handleInput('\u001b[6~'); panel.render(78);}
        panel.handleInput('\r'); return answer;
      } finally {panel.dispose();}
    }}} as unknown as ExtensionContext, Array.from({length:24}, (_,i) => `field-${i}: old → new`).join('\n'), dialog);
    assert.equal(approved, true);
    const inputValue = await inputSettings({ui:{custom: async (factory: Function, options: {overlay:boolean}) => {
      assert.equal(options.overlay,true);
      let answer: unknown;
      const terminal = {rows:10,columns:80};
      const panel = factory({terminal,requestRender(){}}, {fg: (_color: string, text: string) => text}, {}, (value: unknown) => {answer=value;});
      try {
        panel.focused=true;
        assert.equal(panel.focused,true);
        assert.ok(panel.render(78).length <= 8, 'Input fits independently of footer/widgets');
        panel.handleInput('\u0001'); panel.handleInput('\u000b'); panel.handleInput('"edited"'); panel.handleInput('\r');
        return answer;
      } finally {panel.dispose();}
    }}} as unknown as ExtensionContext, 'Primitive string', '"original"', dialog);
    assert.equal(inputValue, '"edited"');
    {
      let selection = 0, updates = 0;
      const choiceContext = { ui: {
        select: async (_title: string, choices: string[]) => {
          switch (selection++) {
            case 0: return choices.find((s) => s.includes('size:'));
            case 1: return choices.find((s) => s.includes('large'));
            case 2: return choices.find((s) => s.includes('active:'));
            case 3: return choices.find((s) => s.endsWith('true'));
            case 4: return choices.find((s) => s.includes('note:'));
            case 5: return choices.find((s) => s.startsWith('Save changes'));
            default: return 'Back';
          }
        },
        custom: ctx.ui.custom,
        confirm: async () => true,
        notify: (text: string) => assert.fail(text),
      } };
      const doc = SettingsDocumentSchema.parse({schemaVersion:1,title:'Choice schemas',revision:'one',writable:true,
        schema:{properties:{size:{enum:['small','large']},active:{oneOf:[{const:false},{const:true}]},note:{type:'string'}}},values:{size:'small',active:false,note:'old'}});
      // Reuse the overlay driver with this editor's scripted choice callbacks.
      choiceContext.ui.custom = async (factory: Function, options: {overlay:boolean}) => {
        let result: unknown, completed = false;
        const panel = factory({terminal:{rows:30,columns:100},requestRender(){}}, {fg: (_color: string, text: string) => text}, {}, (value: unknown) => {result=value;completed=true;});
        try {
          assert.equal(options.overlay,true);
          const lines: string[] = panel.render(98);
          t.mock.timers.tick(30_001);
          assert.equal(completed, false, 'Taking time to review settings must not discard the draft');
          if(lines[1] === 'Save child-server settings?') {
            let preview = '';
            for(let i=0;i<8;i++) {
              preview += panel.render(98).slice(3,-3).join('');
              panel.handleInput('\u001b[6~');
            }
            assert.ok(preview.includes('\\u0020'.repeat(80)), 'Significant spaces survive wrapping');
            assert.ok(preview.includes('\\u200b\\u200e\\u200f'), 'Invisible characters remain explicit');
            panel.handleInput('\r');
          } else if (lines.some((line) => line.includes('JSON value'))) {
            panel.handleInput('\u0001'); panel.handleInput('\u000b'); panel.handleInput(JSON.stringify('a'+' '.repeat(80)+'b\u200b\u200e\u200f')); panel.handleInput('\r');
          }
          else {
            const choices=lines.filter((line)=>/^(→ |  )/.test(line)).map((line)=>line.slice(2));
            const picked = await choiceContext.ui.select(lines[1], choices);
            for(let i=0;i<choices.indexOf(picked!);i++) panel.handleInput('\u001b[B');
            panel.handleInput('\r');
          }
          return result;
        } finally {panel.dispose();}
      };
      t.mock.timers.enable({ apis: ['setTimeout'] });
      try {
        await editSettings(choiceContext as unknown as ExtensionContext, doc, async (revision, patch) => {
          assert.equal(revision, 'one'); assert.deepEqual(patch, {size:'large',active:true,note:'a'+' '.repeat(80)+'b\u200b\u200e\u200f'}); updates++;
          return {...doc,revision:'two',values:{size:'large',active:true,note:'a'+' '.repeat(80)+'b\u200b\u200e\u200f'}};
        }, new AbortController().signal, 1000);
      } finally { t.mock.timers.reset(); }
      assert.equal(updates, 1);
    }
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
