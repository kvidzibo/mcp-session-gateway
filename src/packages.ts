import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import semver from 'semver';
import { z } from 'zod';

const pathSchema = z.string().min(1).max(4096).refine((value) => value.trim().length > 0);
const branchSchema = z.string().min(1).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine((value) => !value.includes('..') && value.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock')));
const httpsURL = z.string().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}, 'Use an HTTPS repository URL without credentials, query or fragment');
const sourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('npm'), name: z.string().max(214).regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/), tag: z.string().max(100).regex(/^[a-zA-Z][a-zA-Z0-9._-]*$/).default('latest') }).strict(),
  z.object({ type: z.literal('git'), url: httpsURL, branch: branchSchema }).strict(),
  z.object({ type: z.literal('local'), path: pathSchema }).strict(),
]);
const packageSchema = z.object({ source: sourceSchema, installedPath: pathSchema.optional() }).strict()
  .refine((value) => value.source.type !== 'local' || value.installedPath === undefined, 'Local sources use source.path, not installedPath');
export type PackageConfig = z.infer<typeof packageSchema> & { name: string };

export function parsePackages(value: unknown, directory: string): PackageConfig[] {
  if (value === undefined) return [];
  const entries = z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), packageSchema).parse(value);
  if (Object.keys(entries).length > 128) throw new Error('At most 128 packages may be configured');
  return Object.entries(entries).map(([name, entry]) => ({
    ...entry, name,
    ...(entry.installedPath ? { installedPath: resolve(directory, entry.installedPath) } : {}),
    source: entry.source.type === 'local' ? { ...entry.source, path: resolve(directory, entry.source.path) } : entry.source,
  }));
}

export interface PackageStatus {
  name: string;
  installed?: string;
  available?: string;
  status: string;
  notes: string[];
  checkedAt?: string;
}
const exec = promisify(execFile);
async function git(args: string[], cwd: string, signal: AbortSignal): Promise<string> {
  // Metadata only: no fetch, index refresh, hooks, prompts, or credential helpers.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  // The CLI flag fails closed on older Git; an unknown environment variable would not.
  const { stdout } = await exec('git', ['--no-lazy-fetch', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${devNull}`,
    '-c', 'core.askPass=', '-c', 'credential.helper=', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', ...args], {
    cwd, signal, timeout: 10_000, maxBuffer: 256_000,
    env: {
      ...env,
      // libcurl reads netrc independently of Git credential helpers/askpass.
      // A non-directory home also prevents fallback to the user's home files.
      HOME: devNull, USERPROFILE: devNull, CURL_HOME: devNull, NETRC: devNull,
      GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull,
    },
  });
  return stdout.trim();
}
async function hasGitFilters(directory: string, signal: AbortSignal): Promise<boolean> {
  try {
    // Query all active config scopes/includes under the same isolated Git environment.
    return Boolean(await git(['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process)$'], directory, signal));
  } catch (error) {
    if ((error as { code?: number }).code === 1) return false; // No matching keys.
    throw error;
  }
}
async function manifest(directory: string, signal: AbortSignal): Promise<{ name?: string; version?: string }> {
  const file = join(directory, 'package.json');
  const limit = 256_000;
  signal.throwIfAborted();
  const before = await lstat(file);
  if (!before.isFile() || before.size > limit) throw new Error('Manifest must be a bounded regular file');
  // Reject symlinks and avoid blocking on a FIFO swapped in between lstat/open.
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error('Manifest must be a bounded regular file');
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size <= limit) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, size, Math.min(64_000, buffer.length - size), size);
      signal.throwIfAborted();
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > limit) throw new Error('Package manifest too large');
    return z.object({ name: z.string().optional(), version: z.string().max(128).optional() })
      .parse(JSON.parse(buffer.subarray(0, size).toString('utf8')));
  } finally { await handle.close(); }
}
async function npmVersion(name: string, tag: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), redirect: 'error',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Registry request failed'); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1_000_000) throw new Error('Registry response too large');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const result = z.object({ name: z.literal(name), version: z.string() }).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  if (!semver.valid(result.version)) throw new Error('Invalid registry version');
  return result.version;
}

/** Read declared installation metadata, never infer a running executable's version. */
export async function inspectPackage(pkg: PackageConfig, checkRemote: boolean, signal: AbortSignal): Promise<PackageStatus> {
  const result: PackageStatus = { name: pkg.name, status: 'Not checked', notes: [] };
  const source = pkg.source;
  const directory = source.type === 'local' ? source.path : pkg.installedPath;
  if (directory) {
    try {
      signal.throwIfAborted();
      if (!(await stat(directory)).isDirectory()) throw new Error('Not a directory');
      if (source.type === 'git') {
        const root = await git(['rev-parse', '--show-toplevel'], directory, signal);
        if (await realpath(root) !== await realpath(directory)) throw new Error('Not a repository root');
        result.installed = await git(['rev-parse', '--verify', 'HEAD'], directory, signal);
        if (!/^[a-f0-9]{40,64}$/.test(result.installed)) throw new Error('Invalid commit');
        if (await hasGitFilters(directory, signal)) result.notes.push('Dirty state unavailable: executable Git filters configured.');
        else if (await git(['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=all'], directory, signal)) {
          result.notes.push('Dirty checkout; updates would require a clean tree.');
        }
      } else {
        try {
          const data = await manifest(directory, signal);
          if (source.type === 'npm' && (data.name !== source.name || !data.version || !semver.valid(data.version))) throw new Error('Package identity/version mismatch');
          result.installed = data.version;
        } catch (error) {
          if (source.type !== 'local' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (source.type === 'local' && !result.installed) result.notes.push('Folder exists; no package version declared.');
      }
    } catch {
      signal.throwIfAborted();
      result.installed = undefined;
      result.notes.push('Cannot verify installed metadata; check the declared path and package identity.');
    }
  } else result.notes.push('No installedPath declared; installed version is unknown.');
  if (source.type === 'local') { result.status = 'Externally managed'; return result; }
  if (!checkRemote) return result;
  try {
    signal.throwIfAborted();
    if (source.type === 'npm') result.available = await npmVersion(source.name, source.tag, signal);
    else {
      const ref = `refs/heads/${source.branch}`;
      const output = await git(['ls-remote', '--exit-code', '--heads', '--', source.url, ref], tmpdir(), signal);
      const entry = output.split('\n').map((line) => line.split(/\s+/)).find((line) => line[1] === ref);
      if (!entry || !/^[a-f0-9]{40,64}$/.test(entry[0])) throw new Error('Branch unavailable');
      result.available = entry[0];
    }
    result.checkedAt = new Date().toISOString();
    result.status = !result.installed ? 'Installed version unknown' : result.installed === result.available ? 'Matches source' :
      source.type === 'git' ? 'Remote differs (ancestry unknown)' : semver.gt(result.available, result.installed) ? 'Update available' :
      semver.eq(result.available, result.installed) ? 'Matches source' : 'Installed newer than target';
  } catch {
    signal.throwIfAborted();
    result.status = 'Check failed';
    result.notes.push('Remote metadata unavailable; check network, package/tag or repository/branch.');
  }
  return result;
}
