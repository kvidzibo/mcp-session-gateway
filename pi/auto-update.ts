import { randomUUID } from 'node:crypto';
import { open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';

function parse(text: string): Record<string, unknown> {
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Config must be an object');
  const config = data as Record<string, unknown>;
  if (config.autoUpdate !== undefined && typeof config.autoUpdate !== 'boolean') throw new Error('autoUpdate must be a boolean');
  return config;
}

export async function readAutoUpdate(path: string): Promise<boolean> {
  return parse(await readFile(path, 'utf8')).autoUpdate === true;
}

/** Save raw configuration, never the normalized/credential-expanded launch config. */
export async function toggleAutoUpdate(path: string, expected: boolean, signal: AbortSignal): Promise<boolean> {
  const target = await realpath(path);
  const lockPath = `${target}.auto-update.lock`;
  const lock = await open(lockPath, 'wx', 0o600).catch((error) => {
    if (error.code === 'EEXIST') throw new Error('Another session is saving Auto update; reopen the menu and retry');
    throw error;
  });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    signal.throwIfAborted();
    const original = await readFile(target, 'utf8');
    const config = parse(original);
    if ((config.autoUpdate === true) !== expected) throw new Error('Auto update changed in another session; select again to toggle the current value');
    config.autoUpdate = !expected;
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
    return !expected;
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await lock.close();
    await unlink(lockPath);
  }
}
