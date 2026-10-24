import { readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { dirname, resolve } from 'node:path';
import { parsePackages, type PackageConfig } from './packages.js';

export type AgentContextMode = 'off' | 'summary' | 'full';

export function parseAgentContext(value: unknown): AgentContextMode {
  if (value === undefined) return 'off';
  if (value !== 'off' && value !== 'summary' && value !== 'full') throw new Error('agentContext must be off, summary or full');
  return value;
}

export interface ServiceConfig {
  name: string;
  enabled?: boolean;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  settings?: { tokenEnv: string };
  package?: string;
}

export interface GatewayConfig {
  services: ServiceConfig[];
  packages: PackageConfig[];
  packageStore: string;
  autoUpdate: boolean;
  autoUpdateConcurrency: number;
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

export async function loadConfig(path: string, options: { expandEnvironment?: boolean } = {}): Promise<GatewayConfig> {
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
  if (data.display !== undefined && data.display !== 'minimal' && data.display !== 'full') throw new Error('display must be minimal or full');
  parseAgentContext(data.agentContext);
  const autoUpdate = data.autoUpdate === undefined ? false : data.autoUpdate;
  if (typeof autoUpdate !== 'boolean') throw new Error('autoUpdate must be a boolean');
  const autoUpdateConcurrency = data.autoUpdateConcurrency === undefined
    ? Math.min(4, Math.max(1, Math.floor(availableParallelism() / 2))) : data.autoUpdateConcurrency;
  if (typeof autoUpdateConcurrency !== 'number' || !Number.isInteger(autoUpdateConcurrency) || autoUpdateConcurrency < 1 || autoUpdateConcurrency > 128) {
    throw new Error('autoUpdateConcurrency must be an integer between 1 and 128');
  }
  const packages = parsePackages(data.packages, dirname(absolute));
  const packageStore = data.packageStore ?? '.gateway-packages';
  if (typeof packageStore !== 'string' || !packageStore.trim()) throw new Error('packageStore must be a non-empty path');
  const services = Object.entries(servers).map(([name, value]): ServiceConfig => {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || name === 'gateway') {
      throw new Error(`Invalid or reserved server name: ${name}`);
    }
    if (!object(value) || typeof value.command !== 'string' || value.command.trim() === '') {
      throw new Error(`Server ${name} requires an executable command`);
    }
    if (value.package !== undefined && (typeof value.package !== 'string' || !packages.some((pkg) => pkg.name === value.package))) {
      throw new Error(`Server ${name}: package must reference a configured package`);
    }
    if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error(`Server ${name}: enabled must be a boolean`);
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
    const pkg = packages.find((pkg) => pkg.name === value.package);
    const managed = pkg?.managed || pkg?.localUpdate;
    const hasRoot = [value.command, ...args, ...Object.values(env), value.cwd ?? ''].some((text) => String(text).includes('{{packageRoot}}'));
    if (hasRoot && !managed) throw new Error(`Server ${name}: packageRoot requires a managed or localUpdate package`);
    if (managed && !hasRoot) throw new Error(`Server ${name}: managed/localUpdate launch must reference {{packageRoot}}`);
    const settings = value.settings;
    if (settings !== undefined && (!object(settings) || Object.keys(settings).some((key) => key !== 'tokenEnv') ||
        typeof settings.tokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(settings.tokenEnv) ||
        ['MCP_GATEWAY_SETTINGS_TOKEN', 'MCP_GATEWAY_SESSION_ID', 'MCP_GATEWAY_SERVICE_ID', 'MCP_GATEWAY_WORKSPACE'].includes(settings.tokenEnv))) {
      throw new Error(`Server ${name}: settings requires a non-reserved tokenEnv variable name`);
    }
    return {
      name,
      ...(value.enabled !== undefined ? { enabled: value.enabled } : {}),
      ...(value.package ? { package: value.package as string } : {}),
      ...(settings ? { settings: settings as { tokenEnv: string } } : {}),
      command: value.command,
      args: args as string[],
      env: Object.fromEntries(Object.entries(env).map(([key, entry]) => [key, value.enabled === false || options.expandEnvironment === false ? entry as string : expand(entry as string)])),
      cwd: value.cwd?.includes('{{packageRoot}}') ? value.cwd : resolve(dirname(absolute), value.cwd ?? '.'),
    };
  });
  return { services, packages, autoUpdate, autoUpdateConcurrency, packageStore: resolve(dirname(absolute), packageStore), timeoutMs, logFile: resolve(dirname(absolute), logFile) };
}
