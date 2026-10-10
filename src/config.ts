import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface ServiceConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

export interface GatewayConfig {
  services: ServiceConfig[];
  timeoutMs: number;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expand(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = process.env[name];
    if (resolved === undefined) throw new Error(`Missing environment variable: ${name}`);
    return resolved;
  });
}

export async function loadConfig(path: string): Promise<GatewayConfig> {
  const absolute = resolve(path);
  const data: unknown = JSON.parse(await readFile(absolute, 'utf8'));
  if (!object(data) || !object(data.servers) || Object.keys(data.servers).length === 0) {
    throw new Error('Config must contain a non-empty "servers" object');
  }
  const timeoutMs = data.timeoutMs ?? 30_000;
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) {
    throw new Error('timeoutMs must be an integer between 100 and 300000');
  }
  const services = Object.entries(data.servers).map(([name, value]): ServiceConfig => {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || name === 'gateway') {
      throw new Error(`Invalid or reserved server name: ${name}`);
    }
    if (!object(value) || typeof value.command !== 'string' || value.command.trim() === '') {
      throw new Error(`Server ${name} requires an executable command`);
    }
    const args = value.args ?? [];
    const env = value.env ?? {};
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      throw new Error(`Server ${name}: args must be an array of strings`);
    }
    if (!object(env) || Object.values(env).some((entry) => typeof entry !== 'string')) {
      throw new Error(`Server ${name}: env must contain string values`);
    }
    if (value.cwd !== undefined && typeof value.cwd !== 'string') {
      throw new Error(`Server ${name}: cwd must be a string`);
    }
    return {
      name,
      command: value.command,
      args: args as string[],
      env: Object.fromEntries(Object.entries(env).map(([key, entry]) => [key, expand(entry as string)])),
      cwd: resolve(dirname(absolute), value.cwd ?? '.'),
    };
  });
  return { services, timeoutMs };
}
