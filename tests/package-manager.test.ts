import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';
import { bindManagedService, PackageManager, runPackageCommand } from '../src/package-manager.js';
import { parsePackages } from '../src/packages.js';
import { managePackages } from '../pi/package-actions.js';
import registerGateway from '../pi/runtime.js';

// Service/UI tests must never fetch or install into the checkout hosting this test.
const gatewayExtension = (pi: Parameters<typeof registerGateway>[0]) => registerGateway(pi, async () => {});

test('managed releases prepare, validate, activate and roll back independently of running services, with safe failure/cancellation', { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-managed-'));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const originalPath = process.env.PATH;
  const connections: { client: Client; transport: StdioClientTransport }[] = [];
  const signal = new AbortController().signal;
  let shutdownExtension: (() => Promise<void>) | undefined;
  try {
    const repo = join(dir, 'remote'), bin = join(dir, 'bin');
    await mkdir(repo); await mkdir(bin);
    const git = (...args: string[]) => execFileSync(realGit, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-b', 'main');
    const sdk = (path: string) => pathToFileURL(join(root, 'node_modules/@modelcontextprotocol/sdk/dist/esm', path)).href;
    const server = (version: string) => `import {Server} from ${JSON.stringify(sdk('server/index.js'))};
import {StdioServerTransport} from ${JSON.stringify(sdk('server/stdio.js'))};
import {ListToolsRequestSchema,CallToolRequestSchema} from ${JSON.stringify(sdk('types.js'))};
const server=new Server({name:'fixture',version:'1'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'version',inputSchema:{type:'object'}}]}));
server.setRequestHandler(CallToolRequestSchema,async()=>({content:[{type:'text',text:${JSON.stringify(version)}}]}));
await server.connect(new StdioServerTransport());\n`;
    await writeFile(join(repo, 'server.mjs'), server('one'));
    await writeFile(join(repo, '.gitignore'), 'built.txt\n');
    git('add', '.'); git('commit', '-m', 'one');
    const first = git('rev-parse', 'HEAD');
    // Public URLs are mapped to an isolated local repository only at the test subprocess boundary.
    await writeFile(join(bin, 'git'), `#!${process.execPath}\nconst args=process.argv.slice(2).map(a=>a==='https://example.invalid/repo.git'?${JSON.stringify(pathToFileURL(repo).href)}:a);
args.unshift('-c','protocol.file.allow=always');
const child=require('child_process').spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(child.status??1);\n`);
    await chmod(join(bin, 'git'), 0o700);
    await writeFile(join(bin, 'npm'), `#!${process.execPath}\nconst fs=require('fs'),path=require('path'),args=process.argv.slice(2);
if(!args.includes('--ignore-scripts')||!args.includes('--registry=https://registry.npmjs.org')) process.exit(10);
const spec=args.at(-1),at=spec.lastIndexOf('@'),name=spec.slice(0,at),version=spec.slice(at+1),prefix=args[args.indexOf('--prefix')+1];
const root=path.join(prefix,'node_modules',name);fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name,version}));\n`);
    await chmod(join(bin, 'npm'), 0o700);
    process.env.PATH = `${bin}:${originalPath}`;
    const declaration = {
      packages: { worker: { source: { type: 'git', url: 'https://example.invalid/repo.git' }, managed: {
        build: [{ command: process.execPath, args: ['-e', "require('fs').writeFileSync('built.txt','built')"] }],
        validate: [{ command: process.execPath, args: ['--check', 'server.mjs'] }], timeoutMs: 5000,
      } } },
      mcpServers: { worker: { package: 'worker', command: process.execPath, args: ['{{packageRoot}}/server.mjs'], cwd: '{{packageRoot}}' } },
    };
    const file = join(dir, 'gateway.json');
    await writeFile(file, JSON.stringify(declaration));
    const config = await loadConfig(file), pkg = config.packages[0];
    assert.deepEqual(pkg.source, { type: 'git', url: 'https://example.invalid/repo.git', branch: 'main' });
    assert.throws(() => parsePackages({ bad: { source: { type: 'local', path: '.' }, managed: { validate: [] } } }, dir));
    assert.throws(() => parsePackages({ bad: { ...declaration.packages.worker, installedPath: repo } }, dir));
    const manager = new PackageManager(config.packageStore);
    assert.equal((await manager.state(pkg, signal)).revision, 'none');
    assert.equal(await bindManagedService(config, config.services[0]), undefined);
    await assert.rejects(access(config.packageStore), { code: 'ENOENT' }, 'Inventory/startup must not create the store');
    const connect = async () => {
      const client = new Client({ name: 'manager-test', version: '1' });
      const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'dist/cli.js'), '--config', file], stderr: 'pipe' });
      transport.stderr?.on('data', () => {});
      connections.push({ client, transport });
      await client.connect(transport);
      await client.listTools();
      return client;
    };
    const stopped = await connect();
    assert.deepEqual((await stopped.listTools()).tools.map((tool) => tool.name), ['gateway__identity']);
    const plan = await manager.plan(pkg, signal);
    assert.equal(plan.version, first);
    await manager.prepare(pkg, plan, signal, () => {});
    let state = await manager.state(pkg, signal);
    assert.equal(state.active, undefined);
    assert.equal(state.prepared?.version, first);
    const firstPath = manager.releasePath(pkg, state.prepared!);
    assert.equal(await readFile(join(firstPath, 'built.txt'), 'utf8'), 'built');
    await assert.rejects(manager.activate(pkg, 'none', false, signal), /changed since preview/);
    await manager.activate(pkg, state.revision, false, signal);
    assert.deepEqual((await stopped.listTools()).tools.map((tool) => tool.name), ['gateway__identity'], 'Activation never starts stopped services');
    const one = await connect();
    assert.deepEqual(one.getServerCapabilities()?.experimental?.['gateway-services-v1'], { names: ['worker'] });
    const version = async (client: Client) => (await client.callTool({ name: 'worker__version', arguments: {} })).content;
    assert.deepEqual(await version(one), [{ type: 'text', text: 'one' }]);
    const bound = await bindManagedService(config, config.services[0]);
    assert.equal(bound?.cwd, firstPath);
    assert.deepEqual(bound?.args, [join(firstPath, 'server.mjs')]);

    await writeFile(join(repo, 'server.mjs'), server('two'));
    git('commit', '-am', 'two');
    const second = git('rev-parse', 'HEAD');
    await manager.prepare(pkg, await manager.plan(pkg, signal), signal, () => {});
    state = await manager.state(pkg, signal);
    const secondPath = manager.releasePath(pkg, state.prepared!);
    assert.equal(state.prepared?.version, second);
    assert.deepEqual(await version(one), [{ type: 'text', text: 'one' }]);
    await manager.activate(pkg, state.revision, false, signal);
    assert.deepEqual(await version(one), [{ type: 'text', text: 'one' }], 'A running process retains its release after activation');
    const two = await connect();
    assert.deepEqual(await version(two), [{ type: 'text', text: 'two' }]);
    state = await manager.state(pkg, signal);
    await manager.activate(pkg, state.revision, true, signal);
    assert.deepEqual(await version(two), [{ type: 'text', text: 'two' }], 'Rollback also affects only future launches');
    const rolled = await connect();
    assert.deepEqual(await version(rolled), [{ type: 'text', text: 'one' }]);
    await access(firstPath); await access(secondPath);

    await t.test('startup auto-update is opt-in, activates before launch, reports only changes, and preserves activation on failure', async () => {
      const handlers = new Map<string, Function>(), tools = new Map<string, any>();
      const entries: { type: string; data: any }[] = [], warnings: string[] = [];
      gatewayExtension({
        registerFlag() {}, getFlag: () => file, registerEntryRenderer() {}, events: { on() {} },
        registerCommand() {}, registerTool: (tool: any) => tools.set(tool.name, tool),
        on: (event: string, handler: Function) => handlers.set(event, handler),
        appendEntry: (type: string, data: unknown) => { if (type !== 'gateway-call-counts') entries.push({ type, data }); },
      } as any);
      const widgets = new Map<string, any>(), progressFrames: string[] = [];
      const theme = { fg: (_: string, text: string) => text };
      const ctx: any = { cwd: dir, mode: 'tui', hasUI: true, sessionManager: { getSessionId: () => 'packages-test', getBranch: () => [] }, ui: {
        theme, setStatus() {}, notify: (text: string) => warnings.push(text),
        setWidget(key: string, factory: any) {
          widgets.get(key)?.dispose?.(); widgets.delete(key);
          if (typeof factory !== 'function') return;
          const panel = factory({ requestRender() {
            const loader = widgets.get(key);
            if (loader) progressFrames.push(loader.render(100).join('\n'));
          } }, theme);
          widgets.set(key, panel);
        },
      } };
      const stop = () => handlers.get('session_shutdown')!({}, ctx);
      const start = () => handlers.get('session_start')!({ reason: 'reload' }, ctx);
      const runningVersion = async () => (await tools.get('gateway_call').execute('version', { name: 'worker__version', arguments: {} })).content;
      try {
        assert.equal(config.autoUpdate, false);
        await start();
        assert.deepEqual(await runningVersion(), [{ type: 'text', text: 'one' }]);
        assert.deepEqual(entries, [], 'Disabled startup neither updates nor posts');
        assert.ok(!progressFrames.some((text) => text.includes('Updating service')));
        await stop();
        await writeFile(file, JSON.stringify({ ...declaration, autoUpdate: 'true' }));
        await assert.rejects(loadConfig(file), /autoUpdate must be a boolean/);
        await writeFile(file, JSON.stringify({ ...declaration, autoUpdate: true }));
        await start();
        assert.deepEqual(await runningVersion(), [{ type: 'text', text: 'two' }], 'New servers must use the updated release immediately');
        const checking = progressFrames.findIndex((text) => text.includes('Checking service worker'));
        const updating = progressFrames.findIndex((text) => text.includes('Updating service worker'));
        const connecting = progressFrames.findIndex((text, i) => i > updating && text.includes('connecting services'));
        assert.ok(checking >= 0 && updating > checking && connecting > updating, 'Named update loader precedes service startup');
        assert.equal(widgets.size, 0, 'Startup removes the loader after success');
        assert.deepEqual(entries, [{ type: 'gateway-package-updates', data: {
          text: `MCP servers were updated:\n- worker: ${first} → ${second}`,
        } }]);
        await stop();
        const prepared = (await manager.state(pkg, signal)).log;
        progressFrames.length = 0;
        await start();
        assert.ok(progressFrames.some((text) => text.includes('Checking service worker')));
        assert.ok(!progressFrames.some((text) => text.includes('Updating service')));
        assert.equal(entries.length, 1, 'An up-to-date startup is quiet');
        assert.equal((await manager.state(pkg, signal)).log, prepared, 'No redundant preparation');
        await stop();

        git('commit', '--allow-empty', '-m', 'three');
        const failedDeclaration = { ...declaration, autoUpdate: true, packages: {
          worker: { ...declaration.packages.worker, managed: { ...declaration.packages.worker.managed,
            validate: [{ command: process.execPath, args: ['-e', 'process.exit(9)'] }],
          } },
        } };
        await writeFile(file, JSON.stringify(failedDeclaration));
        await start();
        assert.deepEqual(await runningVersion(), [{ type: 'text', text: 'two' }], 'A failed update still launches the existing activation');
        assert.equal((await manager.state(pkg, signal)).active?.version, second);
        assert.equal(entries.length, 1, 'Failure must not claim an update');
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /MCP auto-update failed for worker/);
        await stop();

        let buildStarted!: () => void;
        const building = new Promise<void>((resolve) => { buildStarted = resolve; });
        const prepare = PackageManager.prototype.prepare;
        const wrapped = t.mock.method(PackageManager.prototype, 'prepare', function (this: PackageManager, ...[pkg, plan, signal]: Parameters<typeof prepare>) {
          return prepare.call(this, pkg, plan, signal, (text) => { if (text.includes('BUILD_WAITING')) buildStarted(); });
        });
        try {
          await writeFile(file, JSON.stringify({ ...declaration, autoUpdate: true, packages: {
            worker: { ...declaration.packages.worker, managed: { ...declaration.packages.worker.managed,
              build: [{ command: process.execPath, args: ['-e', "process.on('SIGTERM',()=>{});console.log('BUILD_WAITING');setInterval(()=>{},1000)"] }],
            } },
          } }));
          const starting = assert.rejects(start());
          await building;
          await stop();
          await starting;
          await assert.rejects(access(join(config.packageStore, pkg.name, '.lock')), { code: 'ENOENT' });
          assert.equal((await manager.state(pkg, signal)).active?.version, second);
          assert.equal(entries.length, 1, 'Cancelled startup must not post or start servers');
          assert.equal(widgets.size, 0, 'Cancellation removes the startup loader');
          await assert.rejects(tools.get('gateway_tools').execute(), /disconnected/);
        } finally { wrapped.mock.restore(); }
      } finally {
        await stop();
        git('reset', '--hard', second);
        await writeFile(file, JSON.stringify(declaration));
        await manager.activate(pkg, (await manager.state(pkg, signal)).revision, true, signal);
      }
    });

    await writeFile(join(firstPath, 'server.mjs'), '// dirty');
    await assert.rejects(manager.prepare(pkg, await manager.plan(pkg, signal), signal, () => {}), /Dirty checkout/);
    await writeFile(join(firstPath, 'server.mjs'), server('one'));
    git('checkout', '--orphan', 'unrelated');
    git('add', '.'); git('commit', '-m', 'unrelated'); git('branch', '-f', 'main', 'HEAD');
    await assert.rejects(manager.prepare(pkg, await manager.plan(pkg, signal), signal, () => {}));
    assert.equal((await manager.state(pkg, signal)).active?.version, first, 'Divergence never replaces the active release');
    git('checkout', 'main'); git('reset', '--hard', second);

    const badValidation = { ...pkg, managed: { ...pkg.managed!, validate: [{ command: process.execPath, args: ['-e', 'process.exit(9)'], cwd: '.' }] } };
    await assert.rejects(manager.prepare(badValidation, await manager.plan(badValidation, signal), signal, () => {}), /Command failed/);
    state = await manager.state(pkg, signal);
    assert.equal(state.active?.version, first);
    assert.match(await readFile(manager.logPath(pkg, state.log!), 'utf8'), /Failed or cancelled/);
    await assert.rejects(access(join(config.packageStore, pkg.name, 'releases', state.log!)), { code: 'ENOENT' });
    const changed = { ...pkg, managed: { ...pkg.managed!, timeoutMs: 6000 } };
    await assert.rejects(manager.prepare(changed, await manager.plan(pkg, signal), signal, () => {}), /definition changed/);
    const lock = join(config.packageStore, pkg.name, '.lock');
    await writeFile(lock, 'another owner');
    await assert.rejects(manager.activate(pkg, state.revision, true, signal), /locked/);
    assert.equal(await readFile(lock, 'utf8'), 'another owner');
    await rm(lock);

    const gateMarker = join(dir, 'must-not-run');
    await assert.rejects(runPackageCommand(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(gateMarker)}, 'ran')`],
      dir, process.env, signal, 5000, () => {}, async () => { throw new Error('journal unavailable'); }), /journal unavailable/);
    await assert.rejects(access(gateMarker), { code: 'ENOENT' }, 'An unjournaled command must never execute');
    let childPid = 0;
    const controller = new AbortController();
    await assert.rejects(runPackageCommand(process.execPath, ['-e', `
      process.on('SIGTERM',()=>{});
      const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      console.log(child.pid);setInterval(()=>{},1000);`], dir, process.env, controller.signal, 5000, (text) => { childPid = Number(text.trim()); controller.abort(); }));
    assert.ok(childPid > 0);
    try {
      const stat = await readFile(`/proc/${childPid}/stat`, 'utf8');
      assert.match(stat, /\) Z /, 'A helper must be terminated, not left running');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

    const npm = parsePackages({ npm: { source: { type: 'npm', name: '@vendor/example' }, managed: {
      validate: [{ command: process.execPath, args: ['-e', "JSON.parse(require('fs').readFileSync('package.json'))"] }],
    } } }, dir)[0];
    let npmVersion = '1.0.0';
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ name: '@vendor/example', version: npmVersion })));
    await manager.prepare(npm, await manager.plan(npm, signal), signal, () => {});
    let npmState = await manager.state(npm, signal);
    await manager.activate(npm, npmState.revision, false, signal);
    npmVersion = '2.0.0';
    await manager.prepare(npm, await manager.plan(npm, signal), signal, () => {});
    npmState = await manager.state(npm, signal);
    await manager.activate(npm, npmState.revision, false, signal);
    npmVersion = '1.0.0';
    await assert.rejects(manager.plan(npm, signal), /older version/);
    npmState = await manager.state(npm, signal);
    await manager.activate(npm, npmState.revision, true, signal);
    assert.equal((await manager.state(npm, signal)).active?.version, '1.0.0');
    npmVersion = '1.5.0';
    await manager.prepare(npm, await manager.plan(npm, signal), signal, () => {});
    npmState = await manager.state(npm, signal);
    assert.equal(npmState.prepared?.version, '1.5.0');
    await manager.activate(npm, npmState.revision, true, signal);
    npmState = await manager.state(npm, signal);
    assert.equal(npmState.active?.version, '2.0.0');
    assert.equal(npmState.prepared, undefined, 'Rollback invalidates a candidate checked against the old active base');
    await assert.rejects(manager.activate(npm, npmState.revision, false, signal), /No prepared version/);

    // EOF/close during asynchronous package binding must not create an unowned child.
    const activeState = await manager.state(pkg, signal);
    let releaseBinding!: () => void, enteredBinding!: () => void;
    const heldBinding = new Promise<void>((resolve) => { releaseBinding = resolve; });
    const bindingStarted = new Promise<void>((resolve) => { enteredBinding = resolve; });
    const stateMock = t.mock.method(PackageManager.prototype, 'state', async () => { enteredBinding(); await heldBinding; return activeState; });
    const closingGateway = new Gateway(config) as any;
    try {
      const binding = closingGateway.startService(config.services[0]);
      await bindingStarted;
      await closingGateway.close();
      releaseBinding();
      await binding;
      assert.equal(closingGateway.services.length, 0, 'No service may register/spawn after close has snapshotted children');
    } finally {
      releaseBinding(); stateMock.mock.restore();
      await Promise.allSettled(closingGateway.services.map(async (service: any) => { await service.client.close(); await service.transport.close(); }));
    }

    // A real extension shutdown waits for a SIGTERM-resistant preparation process,
    // log drain, staging cleanup and lock release, without starting a model/session.
    const blockedFile = join(dir, 'blocked.json');
    await writeFile(blockedFile, JSON.stringify({ ...declaration, packages: { worker: { ...declaration.packages.worker, managed: {
      ...declaration.packages.worker.managed,
      build: [{ command: process.execPath, args: ['-e', "process.on('SIGTERM',()=>{});console.log('BUILD_WAITING:'+process.pid);setInterval(()=>{},1000)"] }],
    } } } }));
    const { loadExtensions } = await import(pathToFileURL(join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js')).href);
    const loaded = await loadExtensions([join(root, 'pi/gateway.ts')], root);
    assert.deepEqual(loaded.errors, []);
    loaded.runtime.flagValues.set('gateway-config', blockedFile);
    const extension = loaded.extensions[0];
    let buildStarted!: () => void, buildPid = 0;
    const navigation = ['Packages', 'Manage releases', 'worker', 'Check source and prepare install/update'];
    const buildWaiting = new Promise<void>((resolve) => { buildStarted = resolve; });
    const commandCtx: any = { cwd: dir, mode: 'tui', hasUI: true, isIdle: () => true, ui: {
      notify() {},
      custom: async (factory: Function) => new Promise((resolve) => {
        let component: any;
        const done = (value: unknown) => queueMicrotask(() => { component.dispose(); resolve(value); });
        const requestRender = () => queueMicrotask(() => {
          const rendered = component?.render(80).join('\n') ?? '';
          const match = /(?:^|\n)BUILD_WAITING:(\d+)(?:\n|$)/.exec(rendered);
          if (rendered.startsWith('Preparing worker') && match) { buildPid = Number(match[1]); buildStarted(); }
        });
        component = factory({ terminal: { rows: 24, columns: 80 }, requestRender }, { fg: (_: string, value: string) => value }, {}, done);
        const text = () => component.render(80).join('\n');
        const rendered = text();
        if (component.render(80)[1]?.startsWith('Gateway')) {
          const target = navigation.shift();
          assert.ok(target);
          for (let i = 0; i < 20 && !component.render(80).includes(`→ ${target}`); i++) component.handleInput('\u001b[B');
          assert.ok(component.render(80).includes(`→ ${target}`));
          component.handleInput('\r');
        }
        else if (rendered.includes('Prepare package?')) {
          for (let i = 0; i < 100 && !text().includes('Enter prepare'); i++) component.handleInput('\x1b[6~');
          component.handleInput('\r');
        }
      }),
    } };
    shutdownExtension = async () => { for (const handler of extension.handlers.get('session_shutdown') ?? []) await handler({}, commandCtx); };
    const managerCommand = extension.commands.get('gateway').handler('', commandCtx);
    await buildWaiting;
    const journal = (await readFile(lock, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(journal[0].kind, 'owner');
    assert.equal(journal[0].pid, process.pid);
    const receipt = journal.at(-1);
    assert.equal(receipt.kind, 'command');
    assert.equal(receipt.pid, receipt.pgid);
    const buildStat = await readFile(`/proc/${buildPid}/stat`, 'utf8');
    assert.equal(Number(buildStat.slice(buildStat.lastIndexOf(') ') + 2).split(' ')[2]), receipt.pgid,
      'Running build group must be recorded durably before code is allowed to execute');
    await shutdownExtension();
    await managerCommand;
    shutdownExtension = undefined;
    await assert.rejects(access(lock), { code: 'ENOENT' }, 'Shutdown must await release of the preparation lock');
    const afterShutdown = await manager.state(pkg, signal);
    await assert.rejects(access(join(config.packageStore, pkg.name, 'releases', afterShutdown.log!)), { code: 'ENOENT' });

    // Exercise the real operator menus: no preparation is dispatched on decline,
    // and confirmation cannot proceed until every preview line has been reviewed.
    let preparations = 0;
    t.mock.method(PackageManager.prototype, 'prepare', async () => { preparations++; });
    for (const allow of [false, true]) {
      let menuVisits = 0, packageVisits = 0, confirmations = 0;
      const ctx: any = { ui: {
        notify() {},
        custom: async (factory: Function) => new Promise((resolve) => {
          let component: any;
          const done = (value: unknown) => queueMicrotask(() => { component.dispose(); resolve(value); });
          component = factory({ terminal: { rows: 24, columns: 80 }, requestRender() {} }, { fg: (_: string, value: string) => value }, {}, done);
          const text = () => component.render(80).join('\n');
          const rendered = text();
          if (rendered.includes('Prepare package?')) {
            confirmations++;
            if (!allow) component.handleInput('\x1b');
            else {
              assert.ok(!rendered.includes('Enter prepare'), 'Long preview is not initially approved');
              for (let i = 0; i < 100 && !text().includes('Enter prepare'); i++) component.handleInput('\x1b[6~');
              assert.match(text(), /Enter prepare/);
              component.handleInput('\r');
            }
          } else if (rendered.includes('Choose a managed package')) component.handleInput(packageVisits++ === 0 ? '\r' : '\x1b');
          else if (rendered.includes('Active:')) component.handleInput(menuVisits++ === 0 ? '\r' : '\x1b');
          // Progress views complete through their own async operation/done callback.
        }),
      } };
      await managePackages(ctx, config, signal);
      assert.equal(confirmations, 1);
      assert.equal(preparations, allow ? 1 : 0);
    }
  } finally {
    await shutdownExtension?.();
    await Promise.allSettled(connections.map(async ({ client, transport }) => { try { await client.close(); } finally { await transport.close(); } }));
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    await rm(dir, { recursive: true, force: true });
  }
});
