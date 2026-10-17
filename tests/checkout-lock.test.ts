import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { withCheckoutLock } from '../src/checkout-lock.js';
import { snapshotInstallation } from '../pi/installation.js';

test('the dependency-light bootstrap waits for an install in a linked checkout before importing dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-import-lock-'));
  const signal = new AbortController().signal;
  let starting: Promise<void> | undefined;
  try {
    await mkdir(join(root, 'pi')); await mkdir(join(root, 'src'));
    await mkdir(join(root, 'common/worktrees/linked'), { recursive: true });
    await writeFile(join(root, '.git'), 'gitdir: common/worktrees/linked\n');
    await writeFile(join(root, 'common/worktrees/linked/commondir'), '../..\n');
    for (const path of ['pi/gateway.ts', 'pi/definitions.ts', 'pi/startup-update.ts', 'pi/installation.ts', 'src/checkout-lock.ts']) {
      await copyFile(new URL('../' + path, import.meta.url), join(root, path));
    }
    for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'tsconfig.examples-build.json']) await writeFile(join(root, path), '{}');
    await writeFile(join(root, 'pi/self-update.ts'), 'export async function assertGatewayReady() {}');
    await writeFile(join(root, 'pi/runtime.ts'), `import command from 'fixture-dependency';
export default function(pi, _check, _identity, lifecycle) {
  pi.registerCommand('gateway', { handler(_args, ctx) { ctx.ui.notify(command); } });
  lifecycle.start = (_event, ctx) => ctx.ui.notify('started');
}`);
    const { loadExtensions } = await import(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js', import.meta.url).href);
    const result = await loadExtensions([join(root, 'pi/gateway.ts')], root);
    assert.deepEqual(result.errors, [], 'The factory must not import runtime dependencies');
    const notes: string[] = [];
    const ctx: any = { ui: { notify: (text: string) => notes.push(text) } };
    let command: Promise<void> | undefined;
    await withCheckoutLock(root, signal, async () => {
      const journal = await readFile(join(root, 'common/mcp-gateway-build.lock'), 'utf8');
      assert.equal(JSON.parse(journal).kind, 'owner');
      command = result.extensions[0].commands.get('gateway').handler('', ctx);
      starting = result.extensions[0].handlers.get('session_start')[0]({ reason: 'startup' }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const dependency = join(root, 'node_modules/fixture-dependency');
      await mkdir(dependency, { recursive: true });
      await writeFile(join(dependency, 'package.json'), '{"name":"fixture-dependency","main":"index.js"}');
      await writeFile(join(dependency, 'index.js'), 'module.exports = "installed";');
    });
    await Promise.all([starting, command]);
    assert.deepEqual(notes.sort(), ['installed', 'started'], 'A concurrent command cannot swallow the snapshotted startup event');
    await writeFile(join(root, 'node_modules/fixture-dependency/index.js'), 'module.exports = "updated";');
    await writeFile(join(root, 'package-lock.json'), '{"version":"new"}');
    const reloaded = await loadExtensions([join(root, 'pi/gateway.ts')], root);
    assert.deepEqual(reloaded.errors, []);
    await reloaded.extensions[0].handlers.get('session_start')[0]({ reason: 'reload' }, ctx);
    await reloaded.extensions[0].commands.get('gateway').handler('', ctx);
    assert.equal(notes.at(-1), 'updated', 'Reload imports fresh dependency paths, not Node cached modules');
    await result.extensions[0].commands.get('gateway').handler('', ctx);
    assert.equal(notes.at(-1), 'installed', 'An earlier session remains pinned to its original dependency copy');
    const cancelled = new AbortController();
    await withCheckoutLock(root, signal, async () => {
      const pending = withCheckoutLock(root, cancelled.signal, async () => assert.fail('Cancelled waiter acquired the lock'));
      cancelled.abort();
      await assert.rejects(pending);
      await readFile(join(root, 'common/mcp-gateway-build.lock'));
    });
    await rm(join(root, '.git'));
    await withCheckoutLock(root, signal, async () => {
      const copy = await snapshotInstallation(root, signal);
      await assert.rejects(readFile(join(copy, 'dist/.gateway-build.lock')), { code: 'ENOENT' }, 'Archive copies must not inherit the held source lock');
    });
  } finally {
    await starting?.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
