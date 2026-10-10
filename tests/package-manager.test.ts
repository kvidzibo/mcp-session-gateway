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
import { bindManagedService, PackageManager, runPackageCommand } from '../src/package-manager.js';
import { parsePackages } from '../src/packages.js';
import { managePackages } from '../pi/package-actions.js';

test('managed releases prepare, validate, activate and roll back independently of running services, with safe failure/cancellation', { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-managed-'));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const originalPath = process.env.PATH;
  const connections: { client: Client; transport: StdioClientTransport }[] = [];
  const signal = new AbortController().signal;
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

    // Exercise the real operator menus: no preparation is dispatched on decline,
    // and confirmation cannot proceed until every preview line has been reviewed.
    let preparations = 0;
    t.mock.method(PackageManager.prototype, 'prepare', async () => { preparations++; });
    for (const allow of [false, true]) {
      let menuVisits = 0, confirmations = 0;
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
          } else if (rendered.includes('Managed package')) component.handleInput('\r');
          else if (rendered.includes('Active:')) component.handleInput(menuVisits++ === 0 ? '\r' : '\x1b');
          // Progress views complete through their own async operation/done callback.
        }),
      } };
      await managePackages(ctx, config, signal);
      assert.equal(confirmations, 1);
      assert.equal(preparations, allow ? 1 : 0);
    }
  } finally {
    await Promise.allSettled(connections.map(async ({ client, transport }) => { try { await client.close(); } finally { await transport.close(); } }));
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    await rm(dir, { recursive: true, force: true });
  }
});
