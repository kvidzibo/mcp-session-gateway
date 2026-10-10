import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { GatewayConfig } from '../src/config.js';
import { inspectPackage, type PackageStatus } from '../src/packages.js';
import { clean } from './settings.js';
import { PackageManager } from '../src/package-manager.js';

/** Operator-only local inventory. Opening/refreshing never contacts update sources. */
export async function openManager(ctx: ExtensionContext, config: GatewayConfig, signal: AbortSignal): Promise<'manage' | 'restart' | undefined> {
  if (signal.aborted) return;
  const manager = new PackageManager(config.packageStore);
  return ctx.ui.custom<'manage' | 'restart' | undefined>((tui, theme, _keys, done) => {
    let controller = new AbortController();
    let statuses = new Map<string, PackageStatus>();
    let busy = false, disposed = false, offset = 0, maxOffset = 0, page = 1;
    const refresh = (remote: boolean) => {
      controller.abort();
      controller = new AbortController();
      const current = controller;
      const operation = AbortSignal.any([signal, current.signal]);
      statuses = new Map();
      busy = true;
      tui.requestRender();
      let next = 0;
      void Promise.all(Array.from({ length: Math.min(4, config.packages.length) }, async () => {
        while (!operation.aborted) {
          const pkg = config.packages[next++];
          if (!pkg) return;
          let status: PackageStatus;
          try {
            status = await inspectPackage(await manager.installed(pkg, operation), remote, operation);
            if (pkg.managed) {
              const state = await manager.state(pkg, operation);
              status.notes = status.notes.filter((note) => !note.startsWith('No installedPath'));
              status.notes.push(`Managed · active: ${state.active?.version ?? 'None'} · prepared: ${state.prepared?.version ?? 'None'}`);
            }
          } catch (error) { status = { name: pkg.name, status: 'Unavailable', notes: [String(error)] }; }
          if (operation.aborted || disposed) return;
          statuses.set(pkg.name, status);
          tui.requestRender();
        }
      })).catch(() => {
        if (!operation.aborted && !disposed) ctx.ui.notify('Package inspection failed', 'error');
      }).finally(() => {
        if (!operation.aborted && !disposed) { busy = false; tui.requestRender(true); }
      });
    };
    const close = (action?: 'manage' | 'restart') => { controller.abort(); done(action); };
    const cancel = () => close();
    signal.addEventListener('abort', cancel, { once: true });
    refresh(false);
    return {
      render(width: number) {
        width = Math.max(1, width);
        const height = Math.max(1, tui.terminal.rows - 2);
        if (height < 12 || width < 30) return [truncateToWidth('Enlarge terminal; Esc closes', width)];
        const lines: string[] = [];
        for (const pkg of config.packages) {
          const status = statuses.get(pkg.name);
          const source = pkg.source;
          const description = source.type === 'npm' ? `npm:${source.name}@${source.tag}` : source.type === 'git' ? `${source.url} #${source.branch}` : source.path;
          const services = config.services.filter((service) => service.package === pkg.name).map((service) => service.name);
          const short = (value?: string) => value ? source.type === 'git' ? value.slice(0, 12) : value : 'Unknown';
          lines.push(`${pkg.name} — ${status?.status ?? (busy ? 'Reading…' : 'Unavailable')}`,
            `  Source: ${description}`,
            `  Installed: ${short(status?.installed)} | Target: ${source.type === 'local' ? 'Not applicable' : short(status?.available)}`,
            `  Services: ${services.join(', ') || '(none linked)'}`);
          if (status?.checkedAt) lines.push(`  Checked: ${status.checkedAt}`);
          for (const note of status?.notes ?? []) lines.push(`  ${note}`);
          lines.push('');
        }
        for (const service of config.services.filter((service) => !service.package)) {
          lines.push(`${service.name} — Externally managed (no package source)`, '');
        }
        if (!config.packages.length) lines.unshift('No package sources configured. See docs/packages.md.', '');
        const body = lines.flatMap((line) => wrapTextWithAnsi(clean(line).replace(/\n/g, ' '), width));
        page = height - 9;
        maxOffset = Math.max(0, body.length - page);
        offset = Math.min(offset, maxOffset);
        const border = theme.fg('accent', '─'.repeat(width));
        return [border, theme.fg('accent', 'Gateway manager · package status'),
          theme.fg('muted', 'Declared installs, not running versions.'), '',
          ...body.slice(offset, offset + page), '',
          theme.fg('muted', busy ? 'Reading…  r restart local read' : 'c check sources  r local read'),
          theme.fg('muted', 'p manage  s restart services'),
          theme.fg('muted', '↑↓/PgUp/PgDn scroll  Esc close'),
          border].map((line) => truncateToWidth(line, width));
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) close();
        else if (data === 'p') close('manage');
        else if (data === 's') close('restart');
        else if (data === 'c' && !busy) refresh(true);
        else if (data === 'r') refresh(false);
        else if (matchesKey(data, Key.up)) offset = Math.max(0, offset - 1);
        else if (matchesKey(data, Key.down)) offset = Math.min(maxOffset, offset + 1);
        else if (matchesKey(data, Key.pageUp)) offset = Math.max(0, offset - page);
        else if (matchesKey(data, Key.pageDown)) offset = Math.min(maxOffset, offset + page);
        tui.requestRender();
      },
      invalidate() {},
      dispose() { disposed = true; controller.abort(); signal.removeEventListener('abort', cancel); },
    };
  }, { overlay: true, overlayOptions: { width: '100%', anchor: 'center', margin: 1 } });
}
