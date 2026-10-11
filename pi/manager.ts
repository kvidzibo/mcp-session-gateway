import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { GatewayConfig } from '../src/config.js';
import { inspectPackage, type PackageStatus } from '../src/packages.js';
import { clean } from '../src/native-ui.js';
import { PackageManager } from '../src/package-manager.js';
import { showText } from './text-panel.js';

/** Operator-only local inventory. Opening/refreshing never contacts update sources. */
export async function openManager(ctx: ExtensionContext, config: GatewayConfig, signal: AbortSignal, remote = false): Promise<void> {
  const manager = new PackageManager(config.packageStore);
  await showText(ctx, 'Gateway › Packages › Versions', async (operation, publish) => {
    const checkRemote = remote;
    remote = false; // Only the explicitly requested first read may contact sources.
    const statuses = new Map<string, PackageStatus>();
    let busy = true, next = 0;
    const format = () => {
      const lines = ['Declared installs, not running versions. Refresh reads locally.', ''];
      if (!config.packages.length) lines.push('No package sources configured. See docs/packages.md.', '');
      for (const pkg of config.packages) {
        const status = statuses.get(pkg.name), source = pkg.source;
        const description = source.type === 'npm' ? `npm:${source.name}@${source.tag}` : source.type === 'git' ? `${source.url} #${source.branch}` : source.path;
        const services = config.services.filter((service) => service.package === pkg.name).map((service) => service.name);
        const short = (value?: string) => value ? source.type === 'git' ? value.slice(0, 12) : value : 'Unknown';
        lines.push(`${pkg.name} — ${status?.status ?? (busy ? 'Reading…' : 'Unavailable')}`, `  Source: ${description}`,
          `  Installed: ${short(status?.installed)} | Target: ${source.type === 'local' ? 'Not applicable' : short(status?.available)}`,
          `  Services: ${services.join(', ') || '(none linked)'}`);
        if (status?.checkedAt) lines.push(`  Checked: ${status.checkedAt}`);
        for (const note of status?.notes ?? []) lines.push(`  ${note}`);
        lines.push('');
      }
      for (const service of config.services.filter((service) => !service.package)) lines.push(`${service.name} — Externally managed (no package source)`, '');
      return lines.map((line) => clean(line).replace(/\n/g, ' ')).join('\n');
    };
    publish(format());
    await Promise.all(Array.from({ length: Math.min(4, config.packages.length) }, async () => {
      while (!operation.aborted) {
        const pkg = config.packages[next++];
        if (!pkg) return;
        let status: PackageStatus;
        try {
          status = await inspectPackage(await manager.installed(pkg, operation), checkRemote, operation);
          if (pkg.managed) {
            const state = await manager.state(pkg, operation);
            status.notes = status.notes.filter((note) => !note.startsWith('No installedPath'));
            status.notes.push(`Managed · active: ${state.active?.version ?? 'None'} · prepared: ${state.prepared?.version ?? 'None'}`);
          }
        } catch (error) { status = { name: pkg.name, status: 'Unavailable', notes: [String(error)] }; }
        if (operation.aborted) return;
        statuses.set(pkg.name, status);
        publish(format());
      }
    }));
    busy = false;
    return format();
  }, signal);
}
