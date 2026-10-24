import { randomUUID } from 'node:crypto';
import { open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';

import { parseAgentContext, type AgentContextMode } from '../src/config.js';

export type Display = 'minimal' | 'full';

function parse(text: string): Record<string, unknown> {
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Config must be an object');
  const config = data as Record<string, unknown>;
  if (config.autoUpdate !== undefined && typeof config.autoUpdate !== 'boolean') throw new Error('autoUpdate must be a boolean');
  if (config.display !== undefined && config.display !== 'minimal' && config.display !== 'full') throw new Error('display must be minimal or full');
  parseAgentContext(config.agentContext);
  return config;
}

export async function readAgentContext(path: string): Promise<AgentContextMode> {
  return parseAgentContext(parse(await readFile(path, 'utf8')).agentContext);
}

export async function saveAgentContext(path: string, expected: AgentContextMode, next: AgentContextMode, signal: AbortSignal): Promise<void> {
  parseAgentContext(next);
  await savePreference(path, 'agentContext', expected, next, signal);
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

async function savePreference(path: string, key: 'autoUpdate' | 'display' | 'agentContext', expected: boolean | Display | AgentContextMode, next: boolean | Display | AgentContextMode, signal: AbortSignal): Promise<void> {
  await saveConfig(path, signal, (config) => {
    const current = config[key] ?? (key === 'display' ? 'minimal' : key === 'agentContext' ? 'off' : false);
    if (current !== expected) throw new Error(`${key === 'autoUpdate' ? 'Auto update' : key === 'display' ? 'Display' : 'Agent context'} changed in another session; reopen the menu and retry`);
    config[key] = next;
  });
}

export async function toggleServiceEnabled(path: string, name: string, expected: boolean, signal: AbortSignal): Promise<boolean> {
  await saveConfig(path, signal, (config) => {
    if ('mcpServers' in config && 'servers' in config) throw new Error('Use mcpServers or servers, not both');
    const servers = config.mcpServers ?? config.servers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('Missing server configuration');
    const service = (servers as Record<string, unknown>)[name];
    if (!service || typeof service !== 'object' || Array.isArray(service)) throw new Error('Service no longer configured');
    const entry = service as Record<string, unknown>;
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') throw new Error('enabled must be a boolean');
    if ((entry.enabled !== false) !== expected) throw new Error('Service changed in another session; reopen the menu and retry');
    entry.enabled = !expected;
  });
  return !expected;
}

async function saveConfig(path: string, signal: AbortSignal, change: (config: Record<string, unknown>) => void): Promise<void> {
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
    change(config);
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
