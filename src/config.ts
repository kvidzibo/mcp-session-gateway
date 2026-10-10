import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface ServiceConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  settings?: { tokenEnv: string };
}

export interface GatewayConfig {
  services: ServiceConfig[];
  timeoutMs: number;
  logFile: string;
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
  if (!object(data)) throw new Error('Config must be an object');
  if ('mcpServers' in data && 'servers' in data) {
    throw new Error('Use "mcpServers" or legacy "servers", not both');
  }
  const servers = 'mcpServers' in data ? data.mcpServers : data.servers;
  if (!object(servers) || Object.keys(servers).length === 0) {
    throw new Error('Config must contain a non-empty "mcpServers" object (legacy "servers" is also accepted)');
  }
  const timeoutMs = data.timeoutMs ?? 30_000;
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) {
    throw new Error('timeoutMs must be an integer between 100 and 300000');
  }
  const logFile = data.logFile ?? 'gateway.log';
  if (typeof logFile !== 'string' || logFile.trim() === '') {
    throw new Error('logFile must be a non-empty path string');
  }
  const services = Object.entries(servers).map(([name, value]): ServiceConfig => {
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
    const settings = value.settings;
    if (settings !== undefined && (!object(settings) || Object.keys(settings).some((key) => key !== 'tokenEnv') ||
        typeof settings.tokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(settings.tokenEnv) ||
        ['MCP_GATEWAY_SETTINGS_TOKEN', 'MCP_GATEWAY_SESSION_ID', 'MCP_GATEWAY_SERVICE_ID'].includes(settings.tokenEnv))) {
      throw new Error(`Server ${name}: settings requires a non-reserved tokenEnv variable name`);
    }
    return {
      name,
      ...(settings ? { settings: settings as { tokenEnv: string } } : {}),
      command: value.command,
      args: args as string[],
      env: Object.fromEntries(Object.entries(env).map(([key, entry]) => [key, expand(entry as string)])),
      cwd: resolve(dirname(absolute), value.cwd ?? '.'),
    };
  });
  return { services, timeoutMs, logFile: resolve(dirname(absolute), logFile) };
}
