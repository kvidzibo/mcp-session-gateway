import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { watch } from 'node:fs';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

test('a fresh Pi updates dependencies before importing the adapter and starts services in the same launch', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-startup-update-'));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const remote = join(dir, 'remote'), local = join(dir, 'local'), bin = join(dir, 'bin');
  const serviceRemote = join(dir, 'service-remote'), service = join(dir, 'service');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const realNpm = execFileSync('which', ['npm'], { encoding: 'utf8' }).trim();
  const previousPath = process.env.PATH, oldCache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = join(dir, 'cache');
  const git = (cwd: string, ...args: string[]) => execFileSync(realGit,
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const handlers = new Map<string, Function[]>(), tools = new Map<string, any>();
  const notes: string[] = [];
  const config = join(dir, 'gateway.json');
  const ctx: any = { cwd: dir, mode: 'print', hasUI: false,
    sessionManager: { getSessionId: () => 'startup-update', getBranch: () => [] },
    ui: { theme: { fg: (_: string, text: string) => text }, notify: (text: string) => notes.push(text), setStatus() {}, setWidget() {} },
  };
  try {
    await mkdir(remote); await mkdir(bin);
    for (const path of ['src', 'pi', 'examples']) await cp(join(root, path), join(remote, path), { recursive: true });
    for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'tsconfig.examples-build.json', '.gitignore']) {
      await copyFile(join(root, path), join(remote, path));
    }
    const runtime = join(remote, 'pi/runtime.ts'), preferences = join(remote, 'pi/auto-update.ts');
    await writeFile(preferences, await readFile(preferences, 'utf8') + "\nexport const startupRevision = 'old';\n");
    await writeFile(runtime, "// @ts-ignore: test-only dependency replaced by the simulated npm ci\nimport version from 'fixture-dependency';\nimport { startupRevision } from './auto-update.js';\nif (version !== 'new' || startupRevision !== 'new') throw new Error('Adapter imported before source/dependency update');\n" + await readFile(runtime, 'utf8'));
    git(remote, 'init', '-b', 'main'); git(remote, 'add', '.'); git(remote, 'commit', '-m', 'initial');
    git(dir, 'clone', remote, local);
    git(local, 'remote', 'set-url', 'origin', 'git@github.com:kvidzibo/mcp-session-gateway.git');
    await writeFile(join(remote, 'revision.txt'), 'updated');
    await writeFile(join(remote, 'fixture-version'), 'new');
    await writeFile(preferences, (await readFile(preferences, 'utf8')).replace("startupRevision = 'old'", "startupRevision = 'new'"));
    git(remote, 'add', '.'); git(remote, 'commit', '-m', 'update');
    const target = git(remote, 'rev-parse', 'HEAD');
    // Runtime copies cannot retain external links into the mutable source dependencies.
    await cp(join(root, 'node_modules'), join(local, 'node_modules'), { recursive: true, verbatimSymlinks: true });
    const dependency = join(local, 'node_modules/fixture-dependency');
    await mkdir(dependency);
    await writeFile(join(dependency, 'package.json'), '{"name":"fixture-dependency","main":"index.js"}');
    await writeFile(join(dependency, 'index.js'), 'module.exports = "old";');
    await writeFile(join(bin, 'git'), `#!${process.execPath}
const urls={'https://github.com/kvidzibo/mcp-session-gateway.git':${JSON.stringify(pathToFileURL(remote).href)},'https://example.invalid/service.git':${JSON.stringify(pathToFileURL(serviceRemote).href)}};
const args=process.argv.slice(2).map(a=>urls[a]??a);
const result=require('child_process').spawnSync(${JSON.stringify(realGit)},['-c','protocol.file.allow=always',...args],{stdio:'inherit'});process.exit(result.status??1);
`);
    await writeFile(join(bin, 'npm'), `#!${process.execPath}
const fs=require('fs'),args=process.argv.slice(2);
if(args[0]==='ci') { fs.appendFileSync(${JSON.stringify(join(dir, 'installs'))},'x'); fs.writeFileSync(${JSON.stringify(join(dependency, 'index.js'))},'module.exports = '+JSON.stringify(fs.readFileSync('fixture-version','utf8'))+';'); }
else { const result=require('child_process').spawnSync(${JSON.stringify(realNpm)},args,{stdio:'inherit'}); process.exit(result.status??1); }
`);
    await chmod(join(bin, 'git'), 0o700); await chmod(join(bin, 'npm'), 0o700);
    process.env.PATH = `${bin}:${previousPath}`;
    await writeFile(config, JSON.stringify({ autoUpdate: true, mcpServers: {
      demo: { command: process.execPath, args: [join(local, 'dist/examples/demo-service.js')] },
    } }));
    const { default: register } = await import(pathToFileURL(join(local, 'pi/gateway.ts')).href);
    register({
      registerFlag() {}, getFlag: () => config, registerEntryRenderer() {}, registerCommand() {}, appendEntry() {},
      registerTool: (tool: any) => tools.set(tool.name, tool), events: { on() {} },
      on: (event: string, handler: Function) => { const list = handlers.get(event) ?? []; list.push(handler); handlers.set(event, list); },
    });
    await assert.rejects(async () => tools.get('gateway_tools').execute('', {}), /not ready/);
    for (const handler of [...handlers.get('session_start')!]) await handler({ reason: 'startup' }, ctx);
    const result = await tools.get('gateway_tools').execute('', {});
    assert.ok(JSON.parse(result.content[0].text).some((tool: any) => tool.name === 'demo__increment'));
    assert.equal(git(local, 'rev-parse', 'HEAD'), target);
    assert.equal(await readFile(join(dir, 'installs'), 'utf8'), 'x', 'Only one dependency installation is performed');
    assert.ok(notes.some((text) => /Gateway updated/.test(text)));
    assert.ok(notes.every((text) => !/Restart Pi|services were not started/.test(text)), notes.join('\n'));
    for (const handler of [...handlers.get('session_shutdown')!]) await handler({ reason: 'exit' }, ctx);
    handlers.clear();

    // No gateway remains alive; reclaim this test's first full dependency copy.
    await rm(join(dir, 'cache'), { recursive: true, force: true });

    // A later release replaces both sources and dependencies. Reload, not a new Pi, adopts it.
    await writeFile(runtime, (await readFile(runtime, 'utf8')).replace("version !== 'new'", "version !== 'next'"));
    await writeFile(join(remote, 'fixture-version'), 'next');
    git(remote, 'add', '.'); git(remote, 'commit', '-m', 'reload update');
    register({
      registerFlag() {}, getFlag: () => config, registerEntryRenderer() {}, registerCommand() {}, appendEntry() {},
      registerTool: (tool: any) => tools.set(tool.name, tool), events: { on() {} },
      on: (event: string, handler: Function) => { const list = handlers.get(event) ?? []; list.push(handler); handlers.set(event, list); },
    });
    for (const handler of [...handlers.get('session_start')!]) await handler({ reason: 'reload' }, ctx);
    assert.ok(JSON.parse((await tools.get('gateway_tools').execute('', {})).content[0].text).some((tool: any) => tool.name === 'demo__increment'));
    assert.equal(await readFile(join(dir, 'installs'), 'utf8'), 'xx');
    assert.ok(notes.every((text) => !/Restart Pi|services were not started/.test(text)), notes.join('\n'));
    for (const handler of [...handlers.get('session_shutdown')!]) await handler({ reason: 'reload' }, ctx);
    handlers.clear();

    // The bootstrap must cancel the runtime before awaiting its initial service build.
    await mkdir(serviceRemote);
    await writeFile(join(serviceRemote, '.gitignore'), 'dist/\n');
    git(serviceRemote, 'init', '-b', 'main'); git(serviceRemote, 'add', '.'); git(serviceRemote, 'commit', '-m', 'service');
    git(dir, 'clone', serviceRemote, service);
    git(service, 'remote', 'set-url', 'origin', 'https://example.invalid/service.git');
    const marker = join(dir, 'service-building');
    await writeFile(config, JSON.stringify({ autoUpdate: true,
      packages: { worker: { source: { type: 'local', path: service }, localUpdate: {
        build: [{ command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'started');process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`] }],
        validate: [{ command: process.execPath, args: ['-e', ''] }], outputs: ['dist/server.js'], timeoutMs: 30_000,
      } } },
      mcpServers: { worker: { package: 'worker', command: process.execPath, args: ['{{packageRoot}}/dist/server.js'] } },
    }));
    register({
      registerFlag() {}, getFlag: () => config, registerEntryRenderer() {}, registerCommand() {}, appendEntry() {},
      registerTool: (tool: any) => tools.set(tool.name, tool), events: { on() {} },
      on: (event: string, handler: Function) => { const list = handlers.get(event) ?? []; list.push(handler); handlers.set(event, list); },
    });
    let building!: () => void;
    const ready = new Promise<void>((resolve) => { building = resolve; });
    const watcher = watch(dir, (_event, name) => { if (name === 'service-building') building(); });
    const startup = assert.rejects(handlers.get('session_start')![0]({ reason: 'reload' }, ctx));
    try {
      await ready;
      const before = Date.now();
      for (const handler of [...handlers.get('session_shutdown')!]) await handler({ reason: 'exit' }, ctx);
      await startup;
      assert.ok(Date.now() - before < 5000, 'Shutdown must cancel, not wait for the 30-second build timeout');
      await assert.rejects(readFile(join(service, '.git/mcp-gateway-local.lock')), { code: 'ENOENT' });
      await assert.rejects(readFile(join(service, '.git/mcp-gateway-build.lock')), { code: 'ENOENT' });
      await assert.rejects(async () => tools.get('gateway_tools').execute('', {}), /disconnected/);
    } finally { watcher.close(); }
  } finally {
    for (const handler of [...handlers.get('session_shutdown') ?? []]) await handler({ reason: 'exit' }, ctx);
    process.env.PATH = previousPath;
    if (oldCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = oldCache;
    await rm(dir, { recursive: true, force: true });
  }
});
