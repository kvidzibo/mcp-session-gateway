import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { localPackageRoot, updateLocalPackage } from '../src/local-packages.js';
import { inspectPackage, localGitSource, type PackageConfig } from '../src/packages.js';

function gatewayPackage(root: string): PackageConfig {
  const step = (...args: string[]) => ({ command: 'npm', args, cwd: '.' });
  return {
    name: 'gateway', source: { type: 'local', path: root },
    localUpdate: {
      build: [step('ci', '--include=dev'), step('run', 'build')],
      validate: [step('run', 'check')], outputs: ['dist/cli.js'], timeoutMs: 300_000,
    },
  };
}

/** Call under the build mutex as well: an update may have failed after startup preflight. */
export async function assertGatewayReady(root: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  try { await lstat(join(root, '.git')); }
  catch (error) {
    signal.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await localPackageRoot(gatewayPackage(root), signal, { allowUnbuilt: true });
}

/** Pi launch only: update the explicit gateway checkout, never inferred child packages. */
export async function checkGatewayUpdate(root: string, autoUpdate: boolean, signal: AbortSignal,
  progress: (stage: 'checking' | 'updating') => void,
  notify: (text: string, level: 'info' | 'warning') => void): Promise<void> {
  signal.throwIfAborted();
  try { await lstat(join(root, '.git')); }
  catch (error) {
    signal.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; // Archive, not a checkout.
    throw error;
  }
  const pkg = gatewayPackage(root);
  // Unsupported/development checkouts opt out without noisy warnings on every launch.
  let supported = false;
  try {
    const { url } = await localGitSource(root, signal);
    supported = /^https:\/\/github\.com\/kvidzibo\/mcp-session-gateway(?:\.git)?\/?$/i.test(url);
  } catch { signal.throwIfAborted(); }
  if (supported) {
    if (autoUpdate) {
      // npm/tsc must not replace dependencies or outputs shared with another installation.
      const canonical = await realpath(root);
      for (const directory of ['node_modules', 'dist']) {
        try {
          const inside = relative(canonical, await realpath(join(root, directory)));
          if (inside === '..' || inside.startsWith('../') || isAbsolute(inside)) {
            throw new Error(`Gateway auto-update refuses shared ${directory}; use a dependency-isolated checkout or turn autoUpdate off`);
          }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }
    try {
      if (autoUpdate) {
        const updated = await updateLocalPackage(pkg, signal, progress);
        if (updated) notify(`Gateway updated to ${updated.version.slice(0, 12)}.`, 'info');
      } else {
        progress('checking');
        const status = await inspectPackage(pkg, true, signal);
        if (status.status === 'Check failed') notify('Gateway update check failed; continuing with existing local files.', 'warning');
        else if (status.available && status.installed && status.available !== status.installed) {
          notify(`Gateway remote differs (${status.installed.slice(0, 12)} → ${status.available.slice(0, 12)}; ancestry unknown). Enable Auto update to attempt a safe fast-forward.`, 'info');
        }
      }
    } catch (error) {
      signal.throwIfAborted();
      notify(`Gateway update skipped or failed: ${String(error)}`, 'warning');
    }
  }
  signal.throwIfAborted();
  // After the attempt so autoUpdate can repair a pending build. Initial missing dist
  // is left to ensureGatewayBuild; existing failed/in-flight/stale receipts still block.
  await assertGatewayReady(root, signal);
  signal.throwIfAborted();
}
