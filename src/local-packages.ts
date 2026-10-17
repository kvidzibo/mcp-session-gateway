import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { git, gitEnvironment, localGitSource, readMetadata, safeGitArgs, type PackageConfig } from './packages.js';
import { runPackageCommand } from './package-manager.js';

const receiptSchema = z.object({ ready: z.boolean(), head: z.string(), definition: z.string() }).strict();
const definition = (pkg: PackageConfig) => createHash('sha256').update(JSON.stringify(pkg.localUpdate)).digest('hex');
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const hash = (value: string) => /^[a-f0-9]{40,64}$/.test(value);
const localGitArgs = [...safeGitArgs, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0'];

async function checkout(pkg: PackageConfig, signal: AbortSignal) {
  if (pkg.source.type !== 'local' || !pkg.localUpdate) throw new Error('Not an update-enabled local package');
  const root = await realpath(pkg.source.path);
  if (await realpath(await git(['rev-parse', '--show-toplevel'], root, signal)) !== root) throw new Error('Local source must be a Git repository root');
  const gitDir = await realpath(await git(['rev-parse', '--absolute-git-dir'], root, signal));
  const common = await realpath(resolve(root, await git(['rev-parse', '--git-common-dir'], root, signal)));
  return { root, receipt: join(gitDir, 'mcp-gateway-local.json'), lock: join(common, 'mcp-gateway-local.lock'), log: join(gitDir, 'mcp-gateway-local.log') };
}
async function receipt(path: string, signal: AbortSignal) {
  try { return receiptSchema.parse(await readMetadata(path, signal)); }
  catch (error) { if (absent(error)) return undefined; throw error; }
}
async function exists(path: string) {
  try { await lstat(path); return true; } catch (error) { if (absent(error)) return false; throw error; }
}
async function save(path: string, value: z.infer<typeof receiptSchema>) {
  const temp = `${path}.${randomUUID()}`;
  try {
    await writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}

async function outputsExist(pkg: PackageConfig, root: string): Promise<boolean> {
  for (const output of pkg.localUpdate!.outputs) {
    const path = resolve(root, output), inside = relative(root, path);
    if (inside === '..' || inside.startsWith('../') || isAbsolute(inside)) throw new Error('Output path escapes local package root');
    if (!await exists(path)) return false;
    const canonical = relative(root, await realpath(path));
    if (canonical === '..' || canonical.startsWith('../') || isAbsolute(canonical)) throw new Error('Output symlink escapes local package root');
  }
  return true;
}

/** Also used on standalone/manual launches: failed or in-flight builds never launch stale output. */
export async function localPackageRoot(pkg: PackageConfig, signal: AbortSignal): Promise<string> {
  const paths = await checkout(pkg, signal);
  if (await exists(paths.lock)) throw new Error(`Local package ${pkg.name} is locked; inspect ${paths.lock} before recovery`);
  const state = await receipt(paths.receipt, signal);
  if ((state && (!state.ready || state.head !== await git(['rev-parse', 'HEAD'], paths.root, signal) || state.definition !== definition(pkg))) || !await outputsExist(pkg, paths.root)) {
    throw new Error(`Local package ${pkg.name} needs a successful startup build/validation; enable autoUpdate and reload. Log: ${paths.log}`);
  }
  return paths.root;
}

/** Existing checkouts are opt-in, in-place updates, never managed-release installations. */
export async function updateLocalPackage(pkg: PackageConfig, signal: AbortSignal,
  progress: (stage: 'checking' | 'updating') => void): Promise<{ name: string; from: string; version: string } | undefined> {
  progress('checking');
  const paths = await checkout(pkg, signal), commands = pkg.localUpdate!;
  let lock;
  try { lock = await open(paths.lock, 'wx', 0o600); }
  catch { throw new Error(`Local checkout is locked; never delete a live lock: ${paths.lock}`); }
  let home: string | undefined, log: Awaited<ReturnType<typeof open>> | undefined;
  let writing = Promise.resolve(), bytes = 0, logFailure: unknown;
  try {
    const record = async (entry: Record<string, unknown>) => { await lock.writeFile(`${JSON.stringify(entry)}\n`); await lock.sync(); };
    await record({ kind: 'owner', pid: process.pid, started: new Date().toISOString() });
    const before = await git(['rev-parse', '--verify', 'HEAD'], paths.root, signal);
    if (!hash(before)) throw new Error('Invalid checkout HEAD');
    // Do not execute filters to inspect a developer's working tree or during checkout.
    let filters = '';
    try { filters = await git(['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process)$'], paths.root, signal); }
    catch (error) { if ((error as { code?: number }).code !== 1) throw error; }
    if (filters) throw new Error('Local updates do not support executable Git filters');
    if (await exists(join(paths.root, '.gitmodules')) || /(^|\n)160000 /.test(await git(['ls-files', '--stage'], paths.root, signal))) throw new Error('Local updates do not support submodules');
    const { url, branch } = await localGitSource(paths.root, signal);
    const clean = async () => {
      if (await git(['rev-parse', 'HEAD'], paths.root, signal) !== before || await git(['symbolic-ref', '--short', 'HEAD'], paths.root, signal) !== branch) throw new Error('Local checkout changed during update');
      if (await git(['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none'], paths.root, signal)) throw new Error('Dirty local checkout; commit/revert changes before auto-update');
    };
    await clean();
    log = await open(paths.log, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    if (!(await log.stat()).isFile()) throw new Error('Local log must be a regular file');
    await log.chmod(0o600);
    const report = (text: string) => {
      const chunk = Buffer.from(text).subarray(0, Math.max(0, 8_000_000 - bytes));
      bytes += chunk.length;
      if (chunk.length) writing = writing.then(async () => { await log!.writeFile(chunk); }).catch((error: unknown) => { logFailure = error; });
    };
    const run = (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => runPackageCommand(command, args, cwd, env, signal,
      commands.timeoutMs, report, (pid) => record({ kind: 'command', pid, pgid: pid, command, cwd, started: new Date().toISOString() }));
    // Explicit URL/refspec bypass remote helpers, configured refspecs, and upload-pack overrides.
    // FETCH_HEAD is shared with developer Git commands: use a private ref and delete it afterward.
    const ref = `refs/mcp-gateway/${randomUUID()}`;
    let target: string;
    try {
      await run('git', [...localGitArgs, '-c', 'fetch.recurseSubmodules=false', 'fetch', '--no-auto-maintenance', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--', url, `refs/heads/${branch}:${ref}`], paths.root, gitEnvironment());
      target = await git(['rev-parse', '--verify', ref], paths.root, signal);
    } finally {
      // Cleanup must work after cancellation; no checkout or upstream ref is changed.
      await git(['update-ref', '-d', ref], paths.root, new AbortController().signal);
    }
    if (!hash(target)) throw new Error('Invalid fetched commit');
    try { await git(['merge-base', '--is-ancestor', before, target], paths.root, signal); }
    catch (error) {
      signal.throwIfAborted();
      if ((error as { code?: number }).code === 1) throw new Error('Local checkout is ahead/diverged; refusing non-fast-forward update');
      throw error;
    }
    if (/(^|\n)160000 commit /.test(await git(['ls-tree', '-r', target], paths.root, signal))) throw new Error('Local updates do not support submodules');
    const previous = await receipt(paths.receipt, signal);
    const next = { head: target, definition: definition(pkg) };
    if (target === before && previous?.ready && previous.head === target && previous.definition === next.definition && await outputsExist(pkg, paths.root)) return;
    await clean();
    progress('updating');
    // Durable failure marker precedes any checkout/build mutation. No silent rollback on failure.
    await save(paths.receipt, { ...next, ready: false });
    if (target !== before) await run('git', [...localGitArgs, '-c', 'submodule.recurse=false', 'merge', '--ff-only', '--no-autostash', '--no-edit', target], paths.root, gitEnvironment());
    home = await mkdtemp(join(tmpdir(), 'gateway-local-build-'));
    await writeFile(join(home, 'user.npmrc'), '');
    await writeFile(join(home, 'global.npmrc'), '');
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, LANG: process.env.LANG ?? 'C.UTF-8', HOME: home, USERPROFILE: home,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', NETRC: devNull,
      NPM_CONFIG_USERCONFIG: join(home, 'user.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(home, 'global.npmrc'),
      NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org', NPM_CONFIG_CACHE: join(home, 'cache'), CI: '1',
    };
    for (const [phase, steps] of [['Build', commands.build], ['Validate', commands.validate]] as const) {
      for (const step of steps) {
        const cwd = await realpath(resolve(paths.root, step.cwd)), inside = relative(paths.root, cwd);
        if (inside === '..' || inside.startsWith('../') || isAbsolute(inside)) throw new Error('Step cwd escapes local package root');
        report(`\n${phase}: ${JSON.stringify([step.command, ...step.args])}\n`);
        await run(step.command, step.args, cwd, env);
      }
    }
    signal.throwIfAborted();
    if (await git(['rev-parse', 'HEAD'], paths.root, signal) !== target || await git(['symbolic-ref', '--short', 'HEAD'], paths.root, signal) !== branch ||
        await git(['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none'], paths.root, signal)) throw new Error('Local build changed checkout source; outputs must be Git-ignored');
    if (!await outputsExist(pkg, paths.root)) throw new Error('Local build did not produce declared outputs');
    await writing;
    if (logFailure) throw new Error('Cannot persist local package log');
    await save(paths.receipt, { ...next, ready: true });
    return target !== before ? { name: pkg.name, from: before, version: target } : undefined;
  } finally {
    await writing;
    // Preserve the lock if cleanup itself fails: recovery must inspect its journal.
    await log?.close();
    if (home) await rm(home, { recursive: true, force: true });
    await lock.close();
    await rm(paths.lock);
  }
}
