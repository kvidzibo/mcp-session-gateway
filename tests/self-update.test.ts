import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { watch } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { checkGatewayUpdate } from '../pi/self-update.js';

test('Pi gateway self-update checks read-only, safely updates, and guards failed builds', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-self-update-'));
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const oldPath = process.env.PATH;
  const git = (cwd: string, ...args: string[]) => execFileSync(realGit,
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const remote = join(dir, 'remote'), local = join(dir, 'local'), bin = join(dir, 'bin');
  const commands = join(dir, 'commands'), network = join(dir, 'network');
  const fail = join(dir, 'fail'), wait = join(dir, 'wait'), started = join(dir, 'started');
  const notes: { text: string; level: string }[] = [], stages: string[] = [];
  const signal = new AbortController().signal;
  const run = (auto = false, operation = signal, root = local) => checkGatewayUpdate(root, auto, operation,
    (stage) => stages.push(stage), (text, level) => notes.push({ text, level }));
  const advance = async (text: string) => {
    await writeFile(join(remote, 'source.txt'), text);
    git(remote, 'commit', '-am', text);
    return git(remote, 'rev-parse', 'HEAD');
  };
  try {
    await mkdir(remote); await mkdir(bin);
    git(remote, 'init', '-b', 'main');
    await writeFile(join(remote, 'source.txt'), 'one');
    await writeFile(join(remote, '.gitignore'), 'dist/\nnode_modules/\n');
    git(remote, 'add', '.'); git(remote, 'commit', '-m', 'one');
    git(dir, 'clone', remote, local);
    git(local, 'remote', 'set-url', 'origin', 'git@github.com:kvidzibo/mcp-session-gateway.git');
    // Only the test subprocess boundary maps public HTTPS to a temporary file remote.
    await writeFile(join(bin, 'git'), `#!${process.execPath}
const fs=require('fs');
const args=process.argv.slice(2).map(a=>a==='https://github.com/kvidzibo/mcp-session-gateway.git'?${JSON.stringify(pathToFileURL(remote).href)}:a);
if(args.includes('ls-remote')||args.includes('fetch'))fs.appendFileSync(${JSON.stringify(network)},args.includes('fetch')?'fetch\\n':'ls-remote\\n');
if(args.includes('ls-remote')&&fs.existsSync(${JSON.stringify(join(dir, 'offline'))}))process.exit(1);
args.unshift('-c','protocol.file.allow=always');
const child=require('child_process').spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(child.status??1);
`);
    // Never invoke real npm: in particular npm ci must not touch shared worktree dependencies.
    await writeFile(join(bin, 'npm'), `#!${process.execPath}
const fs=require('fs'),args=process.argv.slice(2).join(' ');
fs.appendFileSync(${JSON.stringify(commands)},args+'\\n');
if(args==='run build'){
 if(fs.existsSync(${JSON.stringify(fail)}))process.exit(7);
 if(fs.existsSync(${JSON.stringify(wait)})){fs.writeFileSync(${JSON.stringify(started)},'yes');setInterval(()=>{},1000);}
 else {fs.mkdirSync('dist',{recursive:true});fs.copyFileSync('source.txt','dist/cli.js');}
}
if(args==='run check'&&fs.readFileSync('dist/cli.js','utf8')!==fs.readFileSync('source.txt','utf8'))process.exit(8);
`);
    await chmod(join(bin, 'git'), 0o700); await chmod(join(bin, 'npm'), 0o700);
    process.env.PATH = `${bin}:${oldPath}`;

    const archive = join(dir, 'archive'); await mkdir(archive);
    await run(true, signal, archive);
    assert.equal(notes.length, 0); assert.equal(stages.length, 0);
    const first = git(local, 'rev-parse', 'HEAD');
    const second = await advance('two');
    await run(); // Missing initial dist is allowed for the subsequent launch builder.
    assert.equal(git(local, 'rev-parse', 'HEAD'), first);
    assert.equal(git(local, 'status', '--porcelain'), '');
    await assert.rejects(access(commands), { code: 'ENOENT' });
    await assert.rejects(access(join(local, 'dist')), { code: 'ENOENT' });
    await assert.rejects(access(join(local, '.git/mcp-gateway-local.json')), { code: 'ENOENT' });
    assert.equal(git(local, 'rev-parse', '--verify', 'origin/main'), first);
    assert.match(notes.at(-1)!.text, /remote differs .*ancestry unknown/);
    assert.equal(await readFile(network, 'utf8'), 'ls-remote\n');

    await writeFile(join(dir, 'offline'), '');
    await run();
    assert.match(notes.at(-1)!.text, /check failed/); assert.equal(notes.at(-1)!.level, 'warning');
    await rm(join(dir, 'offline'));
    await run(true);
    assert.equal(git(local, 'rev-parse', 'HEAD'), second);
    assert.equal(await readFile(join(local, 'dist/cli.js'), 'utf8'), 'two');
    const steps = 'ci --include=dev\nrun build\nrun check\n';
    assert.equal(await readFile(commands, 'utf8'), steps);
    const receipt = join(local, '.git/mcp-gateway-local.json');
    assert.equal(JSON.parse(await readFile(receipt, 'utf8')).ready, true);
    assert.match(notes.at(-1)!.text, /Gateway updated/);
    stages.length = 0;
    await run(true);
    assert.deepEqual(stages, ['checking']);
    assert.equal(await readFile(commands, 'utf8'), steps, 'No redundant build');

    await writeFile(join(local, 'dirty.txt'), 'keep');
    const beforeDirty = await readFile(network, 'utf8');
    await run();
    assert.equal(await readFile(network, 'utf8'), `${beforeDirty}ls-remote\n`, 'Dirty trees still receive read-only update checks');
    const checkedDirty = await readFile(network, 'utf8');
    await run(true);
    assert.match(notes.at(-1)!.text, /Dirty local checkout/);
    assert.equal(await readFile(network, 'utf8'), checkedDirty);
    assert.equal(await readFile(join(local, 'dirty.txt'), 'utf8'), 'keep');
    await rm(join(local, 'dirty.txt'));
    for (const branch of ['feature', 'detached', 'unsupported']) {
      if (branch === 'feature') git(local, 'checkout', '-b', 'feature');
      if (branch === 'detached') git(local, 'checkout', '--detach');
      if (branch === 'unsupported') {
        git(local, 'checkout', 'main');
        git(local, 'remote', 'set-url', 'origin', '/unsupported/local/path');
      }
      const before = await readFile(network, 'utf8');
      await run(); await run(true);
      assert.equal(await readFile(network, 'utf8'), before, `${branch} opts out of network`);
    }
    git(local, 'remote', 'set-url', 'origin', 'git@github.com:kvidzibo/mcp-session-gateway.git');
    await mkdir(join(dir, 'shared'));
    await symlink(join(dir, 'shared'), join(local, 'node_modules'));
    await assert.rejects(run(true), /refuses shared node_modules/);
    assert.equal(await readFile(commands, 'utf8'), steps, 'Shared dependencies are rejected before npm runs');
    await rm(join(local, 'node_modules'));
    git(local, 'remote', 'set-url', 'origin', 'https://github.com/other/repository.git');
    const trustedNetwork = await readFile(network, 'utf8');
    await run(true);
    assert.equal(await readFile(network, 'utf8'), trustedNetwork, 'Only the gateway repository is trusted');
    git(local, 'remote', 'set-url', 'origin', 'git@github.com:kvidzibo/mcp-session-gateway.git');
    git(local, 'commit', '--allow-empty', '-m', 'local');
    const diverged = git(local, 'rev-parse', 'HEAD');
    await advance('three');
    await assert.rejects(run(true), /successful startup build/);
    assert.match(notes.at(-1)!.text, /ahead\/diverged/);
    assert.equal(git(local, 'rev-parse', 'HEAD'), diverged);
    assert.equal(await readFile(commands, 'utf8'), steps);
    git(local, 'checkout', '-B', 'main', second);

    await writeFile(fail, '');
    await assert.rejects(run(true), /successful startup build/);
    assert.equal(JSON.parse(await readFile(receipt, 'utf8')).ready, false);
    await assert.rejects(run(), /successful startup build/, 'autoUpdate off cannot launch a failed build');
    git(local, 'checkout', '-b', 'repair-feature');
    await assert.rejects(run(), /successful startup build/, 'Developer opt-out still enforces pending receipt');
    git(local, 'checkout', 'main');
    await rm(fail);
    await run(true); // Guard must run after repair, not before it.
    await run();

    const lock = join(local, '.git/mcp-gateway-local.lock');
    await writeFile(lock, 'inflight');
    await assert.rejects(run(), /locked/);
    await rm(lock);
    await rm(join(local, 'dist/cli.js'));
    await assert.rejects(run(), /successful startup build/, 'Existing receipts cannot allow missing outputs');
    await writeFile(wait, '');
    const controller = new AbortController();
    const watcher = watch(dir, (_event, name) => { if (name === 'started') controller.abort(); });
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try { await assert.rejects(run(true, controller.signal), (error) => error === controller.signal.reason); }
    finally { watcher.close(); clearTimeout(timeout); }
    await access(started);
    await assert.rejects(run(), /successful startup build/);
    await assert.rejects(access(lock), { code: 'ENOENT' });
    await rm(wait);
    await run(true);
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(run(false, cancelled.signal), (error) => error === cancelled.signal.reason);
  } finally {
    process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  }
});
