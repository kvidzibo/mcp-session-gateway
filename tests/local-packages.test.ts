import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { watch } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { bindManagedService, updateManagedPackages } from '../src/package-manager.js';
import { inspectPackage, parsePackages } from '../src/packages.js';

test('local Git startup updates fast-forward, rebuild only when needed, and block stale launches after failure/cancellation', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-local-'));
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const path = process.env.PATH;
  const signal = new AbortController().signal;
  const git = (cwd: string, ...args: string[]) => execFileSync(realGit, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    const remote = join(dir, 'remote'), local = join(dir, 'local'), bin = join(dir, 'bin');
    await mkdir(remote); await mkdir(bin);
    git(remote, 'init', '-b', 'main');
    await writeFile(join(remote, 'source.txt'), 'one');
    await writeFile(join(remote, '.gitignore'), 'built.txt\ncount.txt\n');
    git(remote, 'add', '.'); git(remote, 'commit', '-m', 'one');
    const first = git(remote, 'rev-parse', 'HEAD');
    git(dir, 'clone', remote, local);
    git(local, 'remote', 'set-url', 'origin', 'git@github.com:example/local.git');
    // Test-only subprocess boundary: no production file-protocol escape hatch.
    await writeFile(join(bin, 'git'), `#!${process.execPath}\nconst args=process.argv.slice(2).map(a=>a==='https://github.com/example/local.git'?${JSON.stringify(pathToFileURL(remote).href)}:a);
args.unshift('-c','protocol.file.allow=always');
if(args.includes('merge')&&!args.includes('--no-autostash'))process.exit(20);
if(args.includes('fetch')&&!args.includes('--no-auto-maintenance'))process.exit(21);
const child=require('child_process').spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(child.status??1);\n`);
    await chmod(join(bin, 'git'), 0o700);
    process.env.PATH = `${bin}:${path}`;
    const build = { command: process.execPath, args: ['-e', `const fs=require('fs');if(process.env.GATEWAY_TEST_SECRET)process.exit(8);fs.copyFileSync('source.txt','built.txt');let n=0;try{n=+fs.readFileSync('count.txt','utf8')}catch{}fs.writeFileSync('count.txt',String(n+1));`] };
    const validate = { command: process.execPath, args: ['-e', "const fs=require('fs');if(fs.readFileSync('source.txt','utf8')!==fs.readFileSync('built.txt','utf8'))process.exit(1)"] };
    const declaration = {
      autoUpdate: true,
      packages: {
        worker: { source: { type: 'local', path: './local' }, localUpdate: { build: [build], validate: [validate], outputs: ['built.txt'], timeoutMs: 5000 } },
        external: { source: { type: 'local', path: './does-not-exist' } },
        unlinked: { source: { type: 'local', path: './also-missing' }, localUpdate: { validate: [validate] } },
      },
      mcpServers: { worker: { package: 'worker', command: process.execPath, args: ['{{packageRoot}}/built.txt'], cwd: '{{packageRoot}}' } },
    };
    const file = join(dir, 'gateway.json');
    await writeFile(file, JSON.stringify(declaration));
    const config = await loadConfig(file), pkg = config.packages[0];
    assert.equal(pkg.source.type === 'local' && pkg.source.path, local);
    assert.throws(() => parsePackages({ bad: { source: { type: 'git', url: 'https://example.invalid/r.git' }, localUpdate: { validate: [validate] } } }, dir));
    assert.throws(() => parsePackages({ bad: { source: { type: 'local', path: local }, localUpdate: { validate: [] } } }, dir));
    const warnings: string[] = [], stages: string[] = [];
    const run = (current = config, operation = signal) => updateManagedPackages(current, operation,
      (_name, error) => warnings.push(String(error)), (name, stage) => stages.push(`${name}:${stage}`));
    assert.deepEqual(await run({ ...config, autoUpdate: false }), []);
    await assert.rejects(access(join(local, 'built.txt')), { code: 'ENOENT' });
    await assert.rejects(bindManagedService(config, config.services[0]), /successful startup build/, 'Missing outputs block even the first manual launch');
    await writeFile(join(local, 'built.txt'), 'prebuilt');
    assert.equal((await bindManagedService(config, config.services[0]))?.cwd, local, 'Existing local output can launch manually before opting into startup updates');
    await rm(join(local, 'built.txt'));
    process.env.GATEWAY_TEST_SECRET = 'must-not-inherit';
    assert.deepEqual(await run(), [], 'Initial validation/build is not a version update');
    delete process.env.GATEWAY_TEST_SECRET;
    assert.equal(await readFile(join(local, 'count.txt'), 'utf8'), '1');
    stages.length = 0;
    assert.deepEqual(await run(), []);
    assert.deepEqual(stages, ['worker:checking']);
    assert.equal(await readFile(join(local, 'count.txt'), 'utf8'), '1');
    await rm(join(local, 'built.txt'));
    await assert.rejects(bindManagedService(config, config.services[0]), /successful startup build/);
    await run();
    assert.equal(await readFile(join(local, 'count.txt'), 'utf8'), '2', 'Missing declared output triggers rebuild');
    const changed = structuredClone(config);
    changed.packages[0].localUpdate!.build.push({ command: process.execPath, args: ['-e', ''], cwd: '.' });
    await run(changed);
    assert.equal(await readFile(join(local, 'count.txt'), 'utf8'), '3', 'Changed commands trigger rebuild');
    await run();

    await writeFile(join(remote, 'source.txt'), 'two'); git(remote, 'commit', '-am', 'two');
    const second = git(remote, 'rev-parse', 'HEAD');
    const status = await inspectPackage(pkg, true, signal);
    assert.equal(status.installed, first); assert.equal(status.available, second);
    stages.length = 0;
    git(local, 'config', 'remote.origin.uploadpack', 'touch should-not-run');
    git(local, 'config', 'merge.autoStash', 'true');
    await writeFile(join(local, '.git/hooks/post-merge'), '#!/bin/sh\ntouch should-not-run\n');
    await chmod(join(local, '.git/hooks/post-merge'), 0o700);
    assert.deepEqual(await run(), [{ name: 'worker', from: first, version: second }]);
    await assert.rejects(access(join(local, 'should-not-run')), { code: 'ENOENT' });
    assert.deepEqual(stages, ['worker:checking', 'worker:updating']);
    assert.equal(git(local, 'rev-parse', 'HEAD'), second);
    assert.equal(await readFile(join(local, 'built.txt'), 'utf8'), 'two');
    assert.equal(git(local, 'symbolic-ref', '--short', 'HEAD'), 'main');
    assert.equal((await bindManagedService(config, config.services[0]))?.args[0], join(local, 'built.txt'));
    await writeFile(join(local, 'untracked.txt'), 'do not delete');
    assert.deepEqual(await run(), []);
    assert.match(warnings.pop()!, /Dirty local checkout/);
    await rm(join(local, 'untracked.txt'));
    git(local, 'checkout', '-b', 'feature');
    assert.deepEqual(await run(), []);
    assert.match(warnings.pop()!, /main\/master/);
    git(local, 'checkout', 'main');
    git(local, 'config', 'filter.untrusted.smudge', 'touch should-not-run');
    assert.deepEqual(await run(), []);
    assert.match(warnings.pop()!, /executable Git filters/);
    await assert.rejects(access(join(local, 'should-not-run')), { code: 'ENOENT' });
    git(local, 'config', '--remove-section', 'filter.untrusted');
    const lock = join(local, '.git', 'mcp-gateway-local.lock');
    await writeFile(lock, 'existing operation');
    await assert.rejects(run(), /locked/);
    assert.equal(await readFile(lock, 'utf8'), 'existing operation');
    await rm(lock);

    await writeFile(join(remote, 'source.txt'), 'three'); git(remote, 'commit', '-am', 'three');
    const third = git(remote, 'rev-parse', 'HEAD');
    const broken = structuredClone(config);
    broken.packages[0].localUpdate!.validate = [{ command: process.execPath, args: ['-e', 'process.exit(9)'], cwd: '.' }];
    await assert.rejects(run(broken), /successful startup build/);
    assert.equal(git(local, 'rev-parse', 'HEAD'), third, 'Failure never resets developer checkout');
    await assert.rejects(bindManagedService({ ...config, autoUpdate: false }, config.services[0]), /successful startup build/);
    assert.match(await readFile(join(local, '.git', 'mcp-gateway-local.log'), 'utf8'), /Validate/);
    assert.deepEqual(await run(), [], 'Pending validation retries even with unchanged upstream');
    await bindManagedService(config, config.services[0]);
    await assert.rejects(access(lock), { code: 'ENOENT' });

    const waiting = structuredClone(config);
    waiting.packages[0].localUpdate!.build = [{ command: process.execPath, args: ['-e', "const fs=require('fs');process.on('SIGTERM',()=>{});fs.writeFileSync('count.txt',String(+fs.readFileSync('count.txt','utf8')+1));setInterval(()=>{},1000)"], cwd: '.' }];
    const controller = new AbortController();
    const countBeforeCancel = +await readFile(join(local, 'count.txt'), 'utf8');
    const started = watch(join(local, 'count.txt'), () => controller.abort());
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try { await assert.rejects(run(waiting, controller.signal)); }
    finally { started.close(); clearTimeout(timeout); }
    assert.equal(+await readFile(join(local, 'count.txt'), 'utf8'), countBeforeCancel + 1, 'Cancellation occurs after the actual build starts');
    await assert.rejects(access(lock), { code: 'ENOENT' });
    await assert.rejects(bindManagedService(config, config.services[0]), /successful startup build/);
    await run();
    assert.equal(git(local, 'status', '--porcelain'), '');
    git(local, 'commit', '--allow-empty', '-m', 'local-only');
    const ahead = git(local, 'rev-parse', 'HEAD');
    await assert.rejects(run(), /successful startup build/);
    assert.match(warnings.pop()!, /ahead\/diverged/);
    assert.equal(git(local, 'rev-parse', 'HEAD'), ahead);
    await writeFile(join(remote, 'source.txt'), 'four'); git(remote, 'commit', '-am', 'four');
    await assert.rejects(run(), /successful startup build/);
    assert.match(warnings.pop()!, /ahead\/diverged/);
    assert.equal(git(local, 'rev-parse', 'HEAD'), ahead, 'Divergence never resets local history');
    assert.equal(git(local, 'status', '--porcelain'), '');
  } finally {
    process.env.PATH = path;
    delete process.env.GATEWAY_TEST_SECRET;
    await rm(dir, { recursive: true, force: true });
  }
});
