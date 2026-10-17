import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { GatewayConfig } from '../src/config.js';
import { PackageManager, updateManagedPackages } from '../src/package-manager.js';
import { confirmSettings } from './settings.js';
import { clean, literal } from '../src/native-ui.js';
import { GatewayMenu } from './menu.js';
import { showText } from './text-panel.js';

const overlay = { overlay: true, overlayOptions: { width: '100%' as const, anchor: 'center' as const, margin: 0 } };

async function progress(ctx: ExtensionContext, title: string, signal: AbortSignal,
  run: (signal: AbortSignal, output: (text: string) => void) => Promise<void>): Promise<void> {
  let failure: unknown, work: Promise<void> | undefined;
  await ctx.ui.custom<void>((tui, theme, _keys, done) => {
    const controller = new AbortController();
    const operation = AbortSignal.any([signal, controller.signal]);
    let text = '', disposed = false;
    work = run(operation, (chunk) => {
      text = (text + clean(chunk)).slice(-16_000);
      if (!disposed) tui.requestRender();
    }).catch((error: unknown) => { failure = error; }).finally(() => { if (!disposed) done(); });
    return {
      render(width: number) {
        width = Math.max(1, width);
        const height = Math.max(1, tui.terminal.rows - 2);
        const lines = text.split('\n').flatMap((line) => wrapTextWithAnsi(line, width));
        return [theme.fg('accent', title), ...lines.slice(-Math.max(1, height - 3)), '',
          theme.fg('muted', operation.aborted ? 'Cancelling; waiting for cleanup…' : 'Esc cancel (running commands will be terminated)')]
          .slice(-height).map((line) => truncateToWidth(line, width));
      },
      handleInput(data: string) { if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) { controller.abort(); tui.requestRender(); } },
      invalidate() {},
      dispose() { disposed = true; controller.abort(); },
    };
  }, overlay);
  await work;
  if (failure) throw failure;
}

async function viewLog(ctx: ExtensionContext, path: string, signal: AbortSignal): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  let text: string;
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Log is not a regular file');
    const buffer = Buffer.alloc(Math.min(64_000, info.size));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, info.size - buffer.length));
    text = clean(buffer.subarray(0, bytesRead).toString('utf8').slice(-20_000));
  } finally { await file.close(); }
  await showText(ctx, 'Package log · recent tail', text, signal);
}

/** One-shot permission, independent of the persistent startup-update toggle. */
export async function updateAllPackages(ctx: ExtensionContext, config: GatewayConfig, signal: AbortSignal): Promise<void> {
  const packages = config.packages.filter((pkg) => pkg.managed || pkg.localUpdate);
  if (!packages.length) {
    ctx.ui.notify('No update-enabled packages. Configure managed or localUpdate; external folders are never adopted automatically.', 'info');
    return;
  }
  const preview = [
    'Check ALL configured update-enabled packages, including those not linked to services.',
    'Resolve the latest configured source after confirmation, then build, validate and activate changed managed releases.',
    'Inactive managed packages are skipped; use Packages → Manage releases for first installation. Other external packages are skipped.',
    'Auto update is NOT changed. This authorizes one update run only.',
    `Store: ${literal(config.packageStore)}`,
    ...packages.map((pkg) => `\n${pkg.name}\nSource: ${literal(pkg.source)}\nCommands and limits: ${literal(pkg.localUpdate ?? pkg.managed)}`),
    '\nThese trusted commands execute with your OS permissions and network access, NOT in a sandbox. Builds use a minimal environment, not service credentials.',
    'Managed activation affects future launches in ALL sessions sharing the store. Local Git updates modify shared checkout files, dependencies and build output IN PLACE; running services may read changed files immediately.',
    'Finish background jobs in every affected session before continuing; their count is unknown.',
    'No services are stopped or restarted. To use new versions here, separately choose Connection → Restart gateway services.',
    'Failures/cancellation do not roll back completed updates. Incomplete local builds block future launches until a successful retry; inspect package logs.',
  ].join('\n\n');
  if (!await confirmSettings(ctx, preview, { signal, timeout: 300_000, title: 'Update all packages?', actionLabel: 'update all' }) || signal.aborted) return;
  if (!ctx.isIdle()) { ctx.ui.notify('Agent became busy; package update was cancelled', 'warning'); return; }
  const failures: string[] = [];
  let updates: Awaited<ReturnType<typeof updateManagedPackages>> = [];
  await progress(ctx, 'Updating all packages', signal, async (operation, output) => {
    updates = await updateManagedPackages(config, operation,
      (name, error) => { failures.push(clean(`${name}: ${String(error)}`)); output(`Failed: ${name}\n`); },
      (name, stage) => output(`${stage === 'checking' ? 'Checking' : 'Updating'} ${name}\n`), 'manual');
  });
  if (signal.aborted) return;
  const summary = [
    updates.length ? updates.map(({ name, from, version }) => `${name}: ${from} → ${version}`).join('\n') :
      'No version changes. Packages may already be current or inactive; local builds can complete without a version change.',
    ...(failures.length ? ['Failed packages:', ...failures] : []),
    'Services were not restarted. Auto update is unchanged.',
  ].join('\n\n');
  await showText(ctx, 'Package update results', summary, signal);
}

/** All writes require a complete, scroll-reviewed operator confirmation. */
export async function managePackages(ctx: ExtensionContext, config: GatewayConfig, signal: AbortSignal, menu = new GatewayMenu(ctx, signal)): Promise<void> {
  const manager = new PackageManager(config.packageStore);
  const packages = config.packages.filter((pkg) => pkg.managed);
  if (!packages.length) { ctx.ui.notify('No managed packages. Configure managed.build/validate; local and installedPath folders are never adopted automatically.', 'info'); return; }
  const options = { signal, timeout: 300_000 };
  while (!signal.aborted) {
    const selected = await menu.choose(['Gateway', 'Packages', 'Releases'], 'Choose a managed package',
      packages.map((pkg) => ({ id: pkg.name, label: pkg.name, description: 'Prepare, activate or roll back a release; running processes stay unchanged.' })));
    const pkg = packages.find((pkg) => pkg.name === selected);
    if (!pkg || signal.aborted) return;
    while (!signal.aborted) {
      const state = await manager.state(pkg, signal);
      const choices = ['Check source and prepare install/update', ...(state.prepared ? ['Activate prepared version'] : []),
        ...(state.previous ? ['Roll back activation'] : []), ...(state.log ? ['View last preparation log'] : [])];
      const action = await menu.choose(['Gateway', 'Packages', 'Releases', pkg.name],
        clean(`Active: ${state.active?.version ?? 'None'}\nPrepared: ${state.prepared?.version ?? 'None'}`),
        choices.map((label) => ({ id: label, label, description: label.startsWith('View') ? 'Read the most recent preparation log.' :
          label.startsWith('Check') ? 'Check the source, then review the exact target and commands before any download or build.' :
          'Changes future launches in all sessions sharing this store. Separate confirmation required; no restart.' })));
      if (!action || signal.aborted) break;
      try {
        if (action.startsWith('Check')) {
          let plan!: Awaited<ReturnType<PackageManager['plan']>>;
          await progress(ctx, `Checking ${pkg.name}`, signal, async (signal) => { plan = await manager.plan(pkg, signal); });
          const commands = [...pkg.managed!.build.map((step) => ['Build', step] as const), ...pkg.managed!.validate.map((step) => ['Validate', step] as const)]
            .map(([phase, step]) => `${phase} in ${literal(step.cwd)}: ${literal([step.command, ...step.args])}`).join('\n');
          const preview = `${pkg.name}\nSource: ${literal(pkg.source)}\nCurrent active: ${plan.from ?? 'None'}\nPinned target: ${plan.version}\nStore: ${literal(config.packageStore)}\n\nDownload into a NEW release directory. Existing installations and running services stay unchanged.\n${pkg.source.type === 'npm' ? 'Npm installation disables automatic lifecycle scripts.' : 'Git clone suppresses hooks; declared build commands may run lifecycle scripts.'}\n\n${commands}\n\nThese trusted commands execute with your OS permissions, can access files/network, and are NOT sandboxed. Minimal environment and private build home; no service credentials are inherited.\nTimeout per command: ${pkg.managed!.timeoutMs / 1000}s\n\nActivation and restart require separate confirmations.`;
          if (!await confirmSettings(ctx, preview, { ...options, title: 'Prepare package?', actionLabel: 'prepare' }) || signal.aborted) continue;
          await progress(ctx, `Preparing ${pkg.name}`, signal, (signal, output) => manager.prepare(pkg, plan, signal, output));
          ctx.ui.notify('Prepared and validated; not activated or restarted', 'info');
        } else if (action.startsWith('View')) await viewLog(ctx, manager.logPath(pkg, state.log!), signal);
        else {
          const rollback = action.startsWith('Roll');
          const target = rollback ? state.previous! : state.prepared!;
          const services = config.services.filter((service) => service.package === pkg.name).map((service) => service.name).join(', ') || '(none linked)';
          const preview = `${pkg.name}: ${state.active?.version ?? 'None'} → ${target.version}\nServices: ${services}\n\nChange the active version for FUTURE launches in ALL sessions sharing ${literal(config.packageStore)}.\nExisting processes keep their old directories and are NOT restarted. Previous versions are retained.\n${rollback ? 'Any prepared candidate is discarded because its upgrade base changes; its files are retained.\n' : ''}\nTo apply it here, separately choose Restart gateway services.`;
          if (!await confirmSettings(ctx, preview, { ...options, title: rollback ? 'Roll back activation?' : 'Activate prepared version?', actionLabel: rollback ? 'roll back' : 'activate' }) || signal.aborted) continue;
          await manager.activate(pkg, state.revision, rollback, signal);
          ctx.ui.notify('Activation changed for future launches only; current services were not restarted', 'info');
        }
      } catch (error) {
        if (signal.aborted) return;
        ctx.ui.notify(clean(`${String(error)}\nRe-read state before retrying; no write is automatically replayed. Preparation logs are retained under ${config.packageStore}/${pkg.name}/logs.`), 'error');
      }
    }
  }
}
