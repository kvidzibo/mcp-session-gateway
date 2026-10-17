import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, readlink, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Resolve Git's shared directory without importing dependencies that npm may be replacing. */
async function gitDirectories(root: string): Promise<{ gitDir: string; common: string } | undefined> {
  let gitDir = join(root, '.git');
  try {
    const value = await readFile(gitDir, 'utf8');
    if (!value.startsWith('gitdir: ')) throw new Error(`Invalid Git directory file: ${gitDir}`);
    gitDir = resolve(root, value.slice(8).trim());
  } catch (error) {
    if (missing(error)) return; // Archive, not a checkout.
    if ((error as NodeJS.ErrnoException).code !== 'EISDIR') throw error;
  }
  let common = gitDir;
  try { common = resolve(gitDir, (await readFile(join(gitDir, 'commondir'), 'utf8')).trim()); }
  catch (error) { if (!missing(error)) throw error; }
  return { gitDir, common: await realpath(common) };
}

async function lockPath(root: string): Promise<string> {
  const git = await gitDirectories(root);
  if (git) return join(git.common, 'mcp-gateway-build.lock');
  await mkdir(join(root, 'dist'), { recursive: true });
  return join(root, 'dist/.gateway-build.lock');
}

/** Fingerprint runtime inputs while holding the mutex; lockfiles alone cannot detect repaired dependencies. */
export async function checkoutIdentity(root: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const file = async (path: string, link = false) => {
    signal?.throwIfAborted();
    hash.update(JSON.stringify([path, link]));
    try {
      hash.update(String((await lstat(path)).mode & 0o777));
      hash.update(link ? await readlink(path) : await readFile(path));
    }
    catch (error) { if (!missing(error)) throw error; hash.update('missing'); }
    hash.update('\0');
  };
  const tree = async (path: string): Promise<void> => {
    signal?.throwIfAborted();
    let entries;
    try {
      hash.update(JSON.stringify([path, (await lstat(path)).mode & 0o777]));
      entries = await readdir(path, { withFileTypes: true });
    }
    catch (error) { if (missing(error)) return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (join(path, entry.name) === join(root, 'dist/.gateway-build.lock')) continue;
      if (entry.isDirectory()) await tree(join(path, entry.name));
      else if (entry.isFile() || entry.isSymbolicLink()) await file(join(path, entry.name), entry.isSymbolicLink());
    }
  };
  for (const path of ['src', 'pi', 'examples', 'node_modules', 'dist']) await tree(join(root, path));
  for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'tsconfig.examples-build.json']) await file(join(root, path));
  const git = await gitDirectories(root);
  if (git) await file(join(git.gitDir, 'mcp-gateway-local.json'));
  return hash.digest('hex');
}

/** Serialize installs, dependency imports and builds. Never remove stale locks automatically. */
export async function withCheckoutLock<T>(root: string, signal: AbortSignal,
  run: (recordGroup: (pid: number, command: string, cwd: string) => Promise<void>) => Promise<T>): Promise<T> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(300_000)]);
  bounded.throwIfAborted();
  const path = await lockPath(root);
  let lock;
  while (!lock) {
    bounded.throwIfAborted();
    try { lock = await open(path, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try { await delay(100, undefined, { signal: bounded }); }
      catch { throw new Error(`Gateway checkout lock wait cancelled or timed out: ${path}. Remove only a verified stale lock.`, { cause: bounded.reason }); }
    }
  }
  try {
    const record = async (entry: Record<string, unknown>) => {
      await lock.writeFile(`${JSON.stringify(entry)}\n`);
      await lock.sync();
    };
    await record({ kind: 'owner', pid: process.pid, started: new Date().toISOString() });
    bounded.throwIfAborted();
    return await run((pid, command, cwd) => record({ kind: 'command', pid, pgid: pid, command, cwd, started: new Date().toISOString() }));
  } finally {
    await lock.close();
    await rm(path);
  }
}
