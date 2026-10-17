import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import semver from 'semver';
import { z } from 'zod';
import type { GatewayConfig, ServiceConfig } from './config.js';
import { localPackageRoot, updateLocalPackage } from './local-packages.js';
import { git, gitEnvironment, hasGitFilters, inspectPackage, readMetadata, safeGitArgs, type PackageConfig } from './packages.js';

const releaseSchema = z.object({ id: z.uuid(), version: z.string().min(1).max(128) }).strict();
const stateSchema = z.object({
  version: z.literal(1), source: z.string(), revision: z.string(),
  active: releaseSchema.optional(), previous: releaseSchema.optional(), prepared: releaseSchema.optional(),
  log: z.uuid().optional(),
}).strict();
export type PackageState = z.infer<typeof stateSchema>;
export interface PackagePlan { version: string; from?: string; revision: string; definition: string }
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Trusted commands only; process-group cleanup also covers npm/uv grandchildren on POSIX. */
export async function runPackageCommand(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
  signal: AbortSignal, timeout: number, output: (chunk: string) => void, recordGroup?: (pid: number) => Promise<void>): Promise<void> {
  signal.throwIfAborted();
  if (process.platform === 'win32') throw new Error('Managed builds currently require POSIX process-group cleanup');
  await new Promise<void>((resolve, reject) => {
    // A journaled command cannot run until its group receipt is durable. If the
    // parent dies before the gate opens, stdin EOF exits this wrapper without spawning it.
    const gate = `const {spawn}=require('node:child_process');let input='',started=false;
process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{input+=chunk;
if(!started&&input==='start\\n'){started=true;process.stdin.destroy();
const child=spawn(process.argv[1],process.argv.slice(2),{stdio:['ignore','inherit','inherit']});
child.on('error',()=>process.exit(127));child.on('exit',code=>{process.exitCode=code??1;});}});
process.stdin.on('end',()=>{if(!started)process.exit(1);});`;
    const child = recordGroup
      ? spawn(process.execPath, ['-e', gate, '--', command, ...args], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let killTimer: NodeJS.Timeout | undefined, stopped = false;
    let dispatch = Promise.resolve(), dispatchFailure: unknown;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      const kill = (signal: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, signal); } catch {} } };
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 1000);
    };
    const timer = setTimeout(stop, timeout);
    signal.addEventListener('abort', stop, { once: true });
    const cleanup = () => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); signal.removeEventListener('abort', stop); };
    child.stdout!.on('data', (data: Buffer) => output(data.toString('utf8')));
    child.stderr!.on('data', (data: Buffer) => output(data.toString('utf8')));
    child.stdin?.on('error', () => stop());
    if (recordGroup) child.once('spawn', () => {
      dispatch = (async () => {
        await recordGroup(child.pid!);
        if (!stopped && !signal.aborted) child.stdin!.end('start\n');
        else child.stdin!.destroy();
      })().catch((error: unknown) => { dispatchFailure = error; stop(); });
    });
    child.on('error', (error) => { cleanup(); reject(error); });
    child.on('close', async (code) => {
      await dispatch;
      // Kill lingering same-group helpers even if their parent already exited.
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      cleanup();
      if (signal.aborted) reject(signal.reason);
      else if (dispatchFailure) reject(dispatchFailure);
      else if (stopped || code !== 0) reject(new Error(stopped ? 'Command timed out' : `Command failed (exit ${code})`));
      else resolve();
    });
    if (signal.aborted) stop();
  });
}

/** Package sources/configuration and downloaded code are trusted; this is not a sandbox. */
export class PackageManager {
  constructor(readonly root: string) {}
  private directory(pkg: PackageConfig) { return join(this.root, pkg.name); }
  releasePath(pkg: PackageConfig, release: z.infer<typeof releaseSchema>): string {
    releaseSchema.parse(release);
    const root = join(this.directory(pkg), 'releases', release.id);
    return pkg.source.type === 'npm' ? join(root, 'install', 'node_modules', pkg.source.name) : join(root, 'source');
  }
  logPath(pkg: PackageConfig, id: string) { return join(this.directory(pkg), 'logs', `${z.uuid().parse(id)}.log`); }
  async state(pkg: PackageConfig, signal: AbortSignal): Promise<PackageState> {
    if (!pkg.managed || pkg.source.type === 'local') throw new Error('This package is externally managed');
    let state: PackageState;
    try { state = stateSchema.parse(await readMetadata(join(this.directory(pkg), 'state.json'), signal)); }
    catch (error) {
      if (!missing(error)) throw error;
      return { version: 1, source: fingerprint(pkg.source), revision: 'none' };
    }
    if (state.source !== fingerprint(pkg.source)) throw new Error('Package source changed; use a new package ID instead of adopting an unrelated installation');
    for (const release of [state.active, state.previous, state.prepared]) {
      if (release && (pkg.source.type === 'git' ? !/^[a-f0-9]{40,64}$/.test(release.version) : !semver.valid(release.version))) {
        throw new Error('Invalid release version in package state');
      }
    }
    return state;
  }
  async installed(pkg: PackageConfig, signal: AbortSignal): Promise<PackageConfig> {
    if (!pkg.managed) return pkg;
    const state = await this.state(pkg, signal);
    return { ...pkg, installedPath: state.active ? this.releasePath(pkg, state.active) : undefined };
  }
  async plan(pkg: PackageConfig, signal: AbortSignal): Promise<PackagePlan> {
    const state = await this.state(pkg, signal);
    const status = await inspectPackage(await this.installed(pkg, signal), true, signal);
    if (!status.available) throw new Error('Cannot resolve update source; no installation was changed');
    if (pkg.source.type === 'npm' && state.active && semver.lt(status.available, state.active.version)) {
      throw new Error('Source points to an older version; use explicit rollback instead');
    }
    return { version: status.available, from: state.active?.version, revision: state.revision, definition: fingerprint(pkg) };
  }
  private async directorySafe(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Package store directories must not be symlinks');
  }
  private async lock<T>(pkg: PackageConfig, revision: string, signal: AbortSignal,
    run: (state: PackageState, record: (entry: Record<string, unknown>) => Promise<void>) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    await this.directorySafe(this.root);
    const marker = join(this.root, 'store.json');
    try {
      const value = await readMetadata(marker, signal);
      if (JSON.stringify(value) !== '{"version":1}') throw new Error('Unrecognized package store');
    } catch (error) {
      if (!missing(error)) throw error;
      if ((await readdir(this.root)).length) throw new Error('Refusing to adopt a nonempty directory as a package store');
      try { await writeFile(marker, '{"version":1}', { flag: 'wx', mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const dir = this.directory(pkg);
    await this.directorySafe(dir);
    const lockPath = join(dir, '.lock');
    let lock;
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch { throw new Error('Package is locked by another operation. Stale locks require manual recovery; never delete a live lock.'); }
    try {
      const record = async (entry: Record<string, unknown>) => { await lock.writeFile(`${JSON.stringify(entry)}\n`); await lock.sync(); };
      await record({ kind: 'owner', pid: process.pid, started: new Date().toISOString() });
      const state = await this.state(pkg, signal);
      if (state.revision !== revision) throw new Error('Package changed since preview; reopen and confirm again');
      signal.throwIfAborted();
      return await run(state, record);
    } finally { await lock.close(); await rm(lockPath); }
  }
  private async save(pkg: PackageConfig, state: PackageState, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const destination = join(this.directory(pkg), 'state.json');
    const temporary = `${destination}.${randomUUID()}`;
    try {
      await writeFile(temporary, JSON.stringify({ ...state, revision: randomUUID() }), { flag: 'wx', mode: 0o600 });
      signal.throwIfAborted();
      await rename(temporary, destination);
    } finally { await rm(temporary, { force: true }); }
  }
  private async cleanGit(path: string, version: string, signal: AbortSignal): Promise<void> {
    if (await git(['rev-parse', '--verify', 'HEAD'], path, signal) !== version) throw new Error('Checkout HEAD changed; refusing update/activation');
    if (await hasGitFilters(path, signal)) throw new Error('Cannot verify cleanliness with executable Git filters configured');
    if (await git(['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=all'], path, signal)) {
      throw new Error('Dirty checkout; commit/revert changes before update/activation');
    }
  }
  private async verify(pkg: PackageConfig, release: z.infer<typeof releaseSchema>, signal: AbortSignal): Promise<void> {
    const root = this.releasePath(pkg, release);
    const canonical = await realpath(root);
    const relativePath = relative(await realpath(join(this.directory(pkg), 'releases')), canonical);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) throw new Error('Release path escapes package store');
    if (pkg.source.type === 'git') await this.cleanGit(root, release.version, signal);
    else {
      const status = await inspectPackage({ ...pkg, installedPath: root }, false, signal);
      if (status.installed !== release.version) throw new Error('Installed package identity/version changed');
    }
  }
  async prepare(pkg: PackageConfig, plan: PackagePlan, signal: AbortSignal, output: (text: string) => void): Promise<void> {
    if (!pkg.managed || fingerprint(pkg) !== plan.definition) throw new Error('Package definition changed since preview');
    if (pkg.source.type === 'local') throw new Error('Local sources are externally managed');
    const source = pkg.source, managed = pkg.managed;
    if (source.type === 'npm' ? !semver.valid(plan.version) : !/^[a-f0-9]{40,64}$/.test(plan.version)) throw new Error('Invalid pinned version');
    await this.lock(pkg, plan.revision, signal, async (state, record) => {
      if (state.active) await this.verify(pkg, state.active, signal);
      const release = { id: randomUUID(), version: plan.version };
      await this.directorySafe(join(this.directory(pkg), 'releases'));
      await this.directorySafe(join(this.directory(pkg), 'logs'));
      const staging = join(this.directory(pkg), 'releases', release.id);
      await mkdir(staging, { mode: 0o700 });
      const log = this.logPath(pkg, release.id);
      await writeFile(log, '', { flag: 'wx', mode: 0o600 });
      let logBytes = 0, writing = Promise.resolve(), logFailure: unknown;
      const report = (text: string) => {
        const remaining = Math.max(0, 8_000_000 - logBytes);
        const chunk = Buffer.from(text).subarray(0, remaining);
        logBytes += chunk.length;
        if (chunk.length) writing = writing.then(() => appendFile(log, chunk)).catch((error: unknown) => { logFailure = error; });
        try { output(text.slice(-8000)); } catch {}
      };
      report(`Pinned target: ${plan.version}\nLog: ${log}\n`);
      let committed = false;
      try {
        // Retain a pointer to failed/cancelled logs without changing activation/prepared releases.
        await this.save(pkg, { ...state, log: release.id }, signal);
        const home = join(staging, 'home');
        await mkdir(home);
        await writeFile(join(home, 'user.npmrc'), '');
        await writeFile(join(home, 'global.npmrc'), '');
        const env: NodeJS.ProcessEnv = {
          PATH: process.env.PATH, LANG: process.env.LANG ?? 'C.UTF-8', HOME: home, USERPROFILE: home,
          NETRC: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_TERMINAL_PROMPT: '0',
          NPM_CONFIG_USERCONFIG: join(home, 'user.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(home, 'global.npmrc'),
          NPM_CONFIG_CACHE: join(home, 'cache'), NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org', CI: '1',
        };
        const run = (command: string, args: string[], cwd: string, environment = env) => runPackageCommand(
          command, args, cwd, environment, signal, managed.timeoutMs, report,
          (pid) => record({ kind: 'command', pid, pgid: pid, command, cwd, started: new Date().toISOString() }),
        );
        const root = this.releasePath(pkg, release);
        if (source.type === 'git') {
          await run('git', [...safeGitArgs, 'clone', '--no-checkout', '--single-branch', '--branch', source.branch, '--', source.url, root], staging, gitEnvironment());
          // The branch may have advanced since approval. Never silently choose its new HEAD.
          if (await git(['rev-parse', 'HEAD'], root, signal) !== plan.version) throw new Error('Remote branch moved since preview; check and confirm again');
          if (state.active) await git(['merge-base', '--is-ancestor', state.active.version, plan.version], root, signal);
          await run('git', [...safeGitArgs, 'checkout', '--detach', plan.version], root, gitEnvironment());
        } else {
          const prefix = join(staging, 'install');
          await mkdir(prefix);
          await run('npm', ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', '--registry=https://registry.npmjs.org', '--', `${source.name}@${plan.version}`], staging);
        }
        for (const [phase, steps] of [['Build', managed.build], ['Validate', managed.validate]] as const) {
          for (const step of steps) {
            const cwd = await realpath(resolve(root, step.cwd));
            const inside = relative(await realpath(root), cwd);
            if (inside.startsWith('..') || isAbsolute(inside)) throw new Error('Step cwd escapes package root');
            report(`\n${phase}: ${JSON.stringify([step.command, ...step.args])}\n`);
            await run(step.command, step.args, cwd);
          }
        }
        await this.verify(pkg, release, signal);
        if (state.active) await this.verify(pkg, state.active, signal);
        await writing;
        if (logFailure) throw new Error('Cannot persist package operation log');
        await this.save(pkg, { ...state, prepared: release, log: release.id }, signal);
        committed = true;
        report('\nPrepared and validated. Activation and restart are separate actions.\n');
      } catch (error) {
        report(`\nFailed or cancelled. Re-read state before retrying. Log: ${log}\n`);
        throw error;
      } finally {
        await writing;
        if (!committed) await rm(staging, { recursive: true, force: true });
      }
    });
  }
  async activate(pkg: PackageConfig, revision: string, rollback: boolean, signal: AbortSignal): Promise<void> {
    await this.lock(pkg, revision, signal, async (state) => {
      const next = rollback ? state.previous : state.prepared;
      if (!next) throw new Error(rollback ? 'No previous version to roll back to' : 'No prepared version to activate');
      await this.verify(pkg, next, signal);
      // A candidate was checked against the old active base; never keep it across rollback.
      await this.save(pkg, { ...state, active: next, previous: state.active, prepared: undefined }, signal);
    });
  }
}

/** Explicit config opt-in authorizes release updates and declared local checkout writes. */
export async function updateManagedPackages(config: GatewayConfig, signal: AbortSignal,
  failed: (name: string, error: unknown) => void,
  progress: (name: string, stage: 'checking' | 'updating') => void = () => {}): Promise<{ name: string; from: string; version: string }[]> {
  if (!config.autoUpdate) return [];
  const packages = config.packages.filter((pkg) => (pkg.managed || pkg.localUpdate) && config.services.some((service) => service.package === pkg.name));
  const updates: ({ name: string; from: string; version: string } | undefined)[] = new Array(packages.length);
  const manager = new PackageManager(config.packageStore);
  const stopped = new AbortController();
  const operation = AbortSignal.any([signal, stopped.signal]);
  const update = async (pkg: PackageConfig, index: number) => {
    try {
      if (pkg.localUpdate) {
        updates[index] = await updateLocalPackage(pkg, operation, (stage) => progress(pkg.name, stage));
        return;
      }
      if (!(await manager.state(pkg, operation)).active) return;
      progress(pkg.name, 'checking');
      const plan = await manager.plan(pkg, operation);
      if (!plan.from || plan.version === plan.from) return;
      progress(pkg.name, 'updating');
      await manager.prepare(pkg, plan, operation, () => {});
      const state = await manager.state(pkg, operation);
      if (state.active?.version !== plan.from || state.prepared?.version !== plan.version) {
        throw new Error('Package changed during startup update; inspect releases before retrying');
      }
      await manager.activate(pkg, state.revision, false, operation);
      updates[index] = { name: pkg.name, from: plan.from, version: plan.version };
    } catch (error) {
      operation.throwIfAborted();
      failed(pkg.name, error);
      // A skipped local check may retain a known-good checkout. Once mutation/build
      // started, its durable marker blocks all launch paths until a successful retry.
      if (pkg.localUpdate) await localPackageRoot(pkg, operation);
    }
  };
  let next = 0;
  const worker = async () => {
    try {
      while (next < packages.length) {
        operation.throwIfAborted();
        const index = next++;
        await update(packages[index], index);
      }
    } catch (error) { stopped.abort(error); }
  };
  // Await every worker's process/lock cleanup before startup can fail or continue.
  await Promise.all(Array.from({ length: Math.min(config.autoUpdateConcurrency, packages.length) }, worker));
  operation.throwIfAborted();
  return updates.filter((entry) => entry !== undefined);
}

/** Called only at gateway startup. Missing activation leaves a managed service stopped. */
export async function bindManagedService(config: GatewayConfig, service: ServiceConfig): Promise<ServiceConfig | undefined> {
  const pkg = config.packages.find((pkg) => pkg.name === service.package);
  if (!pkg?.managed && !pkg?.localUpdate) return service;
  let root: string;
  if (pkg.localUpdate) root = await localPackageRoot(pkg, new AbortController().signal);
  else {
    const manager = new PackageManager(config.packageStore);
    const state = await manager.state(pkg, new AbortController().signal);
    if (!state.active) return undefined;
    root = manager.releasePath(pkg, state.active);
  }
  await realpath(root); // Fail closed on a missing release; never launch an unresolved placeholder.
  const bind = (text: string) => text.replaceAll('{{packageRoot}}', root);
  return { ...service, command: bind(service.command), args: service.args.map(bind), cwd: resolve(bind(service.cwd)),
    env: Object.fromEntries(Object.entries(service.env).map(([key, value]) => [key, bind(value)])) };
}
