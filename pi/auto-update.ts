import { randomUUID } from 'node:crypto';
import { open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';

export type Display = 'minimal' | 'full';

function parse(text: string): Record<string, unknown> {
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Config must be an object');
  const config = data as Record<string, unknown>;
  if (config.autoUpdate !== undefined && typeof config.autoUpdate !== 'boolean') throw new Error('autoUpdate must be a boolean');
  if (config.display !== undefined && config.display !== 'minimal' && config.display !== 'full') throw new Error('display must be minimal or full');
  return config;
}

export async function readDisplay(path: string): Promise<Display> {
  return parse(await readFile(path, 'utf8')).display === 'full' ? 'full' : 'minimal';
}

export async function toggleDisplay(path: string, expected: Display, signal: AbortSignal): Promise<Display> {
  const next = expected === 'minimal' ? 'full' : 'minimal';
  await savePreference(path, 'display', expected, next, signal);
  return next;
}

export async function readAutoUpdate(path: string): Promise<boolean> {
  return parse(await readFile(path, 'utf8')).autoUpdate === true;
}

/** Save raw configuration, never the normalized/credential-expanded launch config. */
export async function toggleAutoUpdate(path: string, expected: boolean, signal: AbortSignal): Promise<boolean> {
  await savePreference(path, 'autoUpdate', expected, !expected, signal);
  return !expected;
}

async function savePreference(path: string, key: 'autoUpdate' | 'display', expected: boolean | Display, next: boolean | Display, signal: AbortSignal): Promise<void> {
  const label = key === 'autoUpdate' ? 'Auto update' : 'Display';
  const target = await realpath(path);
  const lockPath = `${target}.auto-update.lock`;
  const lock = await open(lockPath, 'wx', 0o600).catch((error) => {
    if (error.code === 'EEXIST') throw new Error('Another session is saving gateway preferences; reopen the menu and retry');
    throw error;
  });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    signal.throwIfAborted();
    const original = await readFile(target, 'utf8');
    const config = parse(original);
    const current = config[key] ?? (key === 'display' ? 'minimal' : false);
    if (current !== expected) throw new Error(`${label} changed in another session; select again to toggle the current value`);
    config[key] = next;
    const mode = (await stat(target)).mode & 0o777;
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(config, null, 2)}\n`);
      await file.chmod(mode);
      await file.sync();
    } finally { await file.close(); }
    signal.throwIfAborted();
    if (await readFile(target, 'utf8') !== original) throw new Error('Configuration changed while saving; reopen the menu and retry');
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await lock.close();
    await unlink(lockPath);
  }
}
