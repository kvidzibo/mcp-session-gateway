import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { loadConfig } from '../src/config.js';
import { inspectPackage, parsePackages } from '../src/packages.js';
import { openManager } from '../pi/manager.js';

test('package inventory is explicit, read-only, failure-isolated, and cancellable in the operator UI', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-packages-'));
  const signal = new AbortController().signal;
  const configFile = join(dir, 'gateway.json');
  try {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const { loadExtensions } = await import(pathToFileURL(join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js')).href);
    const loaded = await loadExtensions([join(root, 'pi/gateway.ts')], root);
    assert.deepEqual(loaded.errors, []);
    assert.ok(loaded.extensions[0].commands.has('gateway-manager'));
    assert.deepEqual([...loaded.extensions[0].tools.keys()], ['gateway_tools', 'gateway_call']);
    await mkdir(join(dir, 'installed'));
    await mkdir(join(dir, 'local'));
    await writeFile(join(dir, 'installed/package.json'), JSON.stringify({ name: '@vendor/service', version: '1.2.0' }));
    const declaration = { packages: {
      service: { source: { type: 'npm', name: '@vendor/service' }, installedPath: './installed' },
      local: { source: { type: 'local', path: './local' } },
    }, mcpServers: { service: { command: 'never-executed', package: 'service' }, external: { command: 'never-executed' } } };
    await writeFile(configFile, JSON.stringify(declaration));
    const config = await loadConfig(configFile);
    assert.equal(config.packages[0].installedPath, join(dir, 'installed'));
    assert.deepEqual(config.packages[0].source, { type: 'npm', name: '@vendor/service', tag: 'latest' });
    assert.equal(config.services[0].package, 'service');
    await writeFile(configFile, JSON.stringify({ ...declaration, mcpServers: { bad: { command: 'unused', package: 'missing' } } }));
    await assert.rejects(loadConfig(configFile), /must reference/);
    for (const source of [{ type: 'unknown' }, { type: 'npm', name: 'package;command' },
      { type: 'git', url: 'ext::command', branch: 'main' }, { type: 'git', url: 'https://example.com/repo', branch: '../main' }]) {
      assert.throws(() => parsePackages({ bad: { source } }, dir));
    }
    assert.throws(() => parsePackages({ bad: { source: { type: 'local', path: '.' }, installedPath: '.' } }, dir));
    assert.throws(() => parsePackages({ bad: { source: { type: 'npm', name: 'valid' }, unexpected: true } }, dir));
    let requests = 0, version = '1.3.0', fail = false;
    t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
      requests++;
      assert.equal(url, 'https://registry.npmjs.org/%40vendor%2Fservice/latest');
      assert.equal(options.redirect, 'error');
      if (fail) throw new Error('private diagnostic must not escape');
      return new Response(JSON.stringify({ name: '@vendor/service', version }));
    });
    const pkg = config.packages[0];
    assert.equal((await inspectPackage(pkg, false, signal)).status, 'Not checked');
    assert.equal(requests, 0);
    assert.equal((await inspectPackage(pkg, true, signal)).status, 'Update available');
    version = '1.1.0';
    assert.equal((await inspectPackage(pkg, true, signal)).status, 'Installed newer than target');
    version = '1.2.0';
    assert.equal((await inspectPackage(pkg, true, signal)).status, 'Matches source');
    assert.equal((await inspectPackage({ ...pkg, installedPath: undefined }, true, signal)).status, 'Installed version unknown');
    await writeFile(join(dir, 'installed/package.json'), JSON.stringify({ name: 'wrong-package', version: '1.2.0' }));
    const mismatch = await inspectPackage(pkg, true, signal);
    assert.equal(mismatch.installed, undefined);
    assert.equal(mismatch.status, 'Installed version unknown');
    await writeFile(join(dir, 'installed/package.json'), JSON.stringify({ name: '@vendor/service', version: '1.2.0' }));
    fail = true;
    const failed = await inspectPackage(pkg, true, signal);
    assert.equal(failed.installed, '1.2.0');
    assert.equal(failed.status, 'Check failed');
    assert.ok(!JSON.stringify(failed).includes('private diagnostic'));
    fail = false;
    const beforeLocal = requests;
    const local = await inspectPackage(config.packages[1], true, signal);
    assert.equal(local.status, 'Externally managed');
    assert.match(local.notes.join(), /Folder exists/);
    assert.equal(requests, beforeLocal);
    const unusualManifest = join(dir, 'local/package.json');
    execFileSync('mkfifo', [unusualManifest]);
    assert.match((await inspectPackage(config.packages[1], false, signal)).notes.join(), /Cannot verify/);
    await rm(unusualManifest);
    await symlink('/dev/zero', unusualManifest);
    assert.match((await inspectPackage(config.packages[1], false, signal)).notes.join(), /Cannot verify/);
    await rm(unusualManifest);
    await writeFile(unusualManifest, ' '.repeat(256_001));
    assert.match((await inspectPackage(config.packages[1], false, signal)).notes.join(), /Cannot verify/);
    await rm(unusualManifest);

    const repo = join(dir, 'repo');
    await mkdir(repo);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-b', 'main');
    await writeFile(join(repo, 'file'), 'original');
    git('add', '.'); git('commit', '-m', 'initial');
    const commit = git('rev-parse', 'HEAD');
    await writeFile(join(repo, 'file'), 'dirty');
    const gitPkg = parsePackages({ git: { source: { type: 'git', url: 'https://example.com/repo.git', branch: 'main' }, installedPath: repo } }, dir)[0];
    const index = await readFile(join(repo, '.git/index'));
    const gitStatus = await inspectPackage(gitPkg, false, signal);
    assert.equal(gitStatus.installed, commit);
    assert.match(gitStatus.notes.join(), /Dirty checkout/);
    assert.deepEqual(await readFile(join(repo, '.git/index')), index);
    assert.equal(await readFile(join(repo, 'file'), 'utf8'), 'dirty');
    const marker = join(dir, 'filter-executed');
    await writeFile(join(repo, '.gitattributes'), 'file filter=marker\n');
    const filterCode = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); process.stdin.pipe(process.stdout)`;
    git('config', 'filter.marker.clean', `${JSON.stringify(process.execPath)} -e ${JSON.stringify(filterCode)}`);
    const filtered = await inspectPackage(gitPkg, false, signal);
    assert.equal(filtered.installed, commit);
    assert.match(filtered.notes.join(), /Dirty state unavailable: executable Git filters/);
    await assert.rejects(readFile(marker), { code: 'ENOENT' }, 'Inspection must never execute a repository clean filter');
    await mkdir(join(repo, 'nested'));
    assert.equal((await inspectPackage({ ...gitPkg, installedPath: join(repo, 'nested') }, false, signal)).installed, undefined);

    const cancelled = new AbortController(); cancelled.abort();
    const beforeCancel = requests;
    await assert.rejects(inspectPackage(pkg, true, cancelled.signal));
    assert.equal(requests, beforeCancel);

    // Actual renderer/input loop; no service is launched and no model API exists.
    const uiRequests = requests;
    const uiController = new AbortController();
    await openManager({ ui: { custom: async (factory: Function) => {
      let component: any, finished = false;
      let ready: (() => void) | undefined;
      let condition: (() => boolean) | undefined;
      const terminal = { rows: 30, columns: 80 };
      const rendered = () => component.render(terminal.columns).join('\n');
      const idleWith = (text: string) => rendered().includes(text) && rendered().includes('c check sources');
      const requestRender = () => queueMicrotask(() => { if (component && condition?.()) { const resolve = ready; condition = undefined; ready = undefined; resolve?.(); } });
      const wait = (predicate: () => boolean) => new Promise<void>((resolve) => { ready = resolve; condition = predicate; requestRender(); });
      component = factory({ terminal, requestRender }, { fg: (_: string, value: string) => value }, {}, () => { finished = true; });
      try {
        await wait(() => idleWith('service — Not checked'));
        assert.equal(requests, uiRequests, 'Opening must not contact remote sources');
        assert.match(rendered(), /external — Externally managed/);
        for (const width of [1, 29, 30, 48, 80]) {
          terminal.columns = width;
          assert.ok(component.render(width).every((line: string) => visibleWidth(line) <= width));
          assert.ok(component.render(width).length <= terminal.rows - 2);
        }
        terminal.columns = 80;
        component.handleInput('c');
        await wait(() => idleWith('service — Matches source'));
        assert.equal(requests, uiRequests + 1);
        component.handleInput('r');
        await wait(() => idleWith('service — Not checked'));
        assert.equal(requests, uiRequests + 1, 'Local refresh must not contact remote sources');
        uiController.abort();
        assert.equal(finished, true, 'Session shutdown must close the screen');
      } finally { component.dispose(); }
    }, notify: (message: string) => assert.fail(message) } } as any, config, uiController.signal);
    const pendingController = new AbortController();
    let started!: () => void;
    const startedRequest = new Promise<void>((resolve) => { started = resolve; });
    t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
      started();
      return new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true }));
    });
    const pending = inspectPackage(pkg, true, pendingController.signal);
    await startedRequest;
    pendingController.abort();
    await assert.rejects(pending);

    // Observe the actual subprocess boundary, including unsupported-Git failure.
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const bin = join(dir, 'bin'), calls = join(dir, 'git-calls');
    await mkdir(bin);
    const proxy = join(bin, 'git');
    await writeFile(proxy, `#!${process.execPath}\nconst fs = require('fs');
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args:process.argv.slice(2), askpass:process.env.GIT_ASKPASS, sshAskpass:process.env.SSH_ASKPASS})+'\\n');
if (fs.existsSync(${JSON.stringify(join(dir, 'old-git'))})) process.exit(129);
const result = require('child_process').spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), {stdio:'inherit'});
process.exit(result.status ?? 1);\n`);
    await chmod(proxy, 0o700);
    const originalPath = process.env.PATH, originalAskpass = process.env.SSH_ASKPASS;
    try {
      process.env.PATH = `${bin}:${originalPath}`;
      process.env.SSH_ASKPASS = '/must-not-execute';
      assert.equal((await inspectPackage(gitPkg, false, signal)).installed, commit);
      const observed = (await readFile(calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      assert.ok(observed.length > 0);
      for (const call of observed) {
        assert.equal(call.args[0], '--no-lazy-fetch');
        assert.ok(call.args.includes('core.askPass='));
        assert.equal(call.askpass, '');
        assert.equal(call.sshAskpass, '');
      }
      await writeFile(join(dir, 'old-git'), 'unsupported');
      const unsupported = await inspectPackage(gitPkg, false, signal);
      assert.equal(unsupported.installed, undefined);
      assert.match(unsupported.notes.join(), /Cannot verify/);
      assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, observed.length + 1, 'Never retry without the safety flag');
    } finally {
      if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
      if (originalAskpass === undefined) delete process.env.SSH_ASKPASS; else process.env.SSH_ASKPASS = originalAskpass;
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
