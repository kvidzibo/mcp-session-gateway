import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { withCheckoutLock } from '../src/checkout-lock.js';

test('the dependency-light bootstrap waits for an install in a linked checkout before importing dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-import-lock-'));
  const signal = new AbortController().signal;
  let loading: Promise<any> | undefined;
  try {
    await mkdir(join(root, 'pi')); await mkdir(join(root, 'src'));
    await mkdir(join(root, 'common/worktrees/linked'), { recursive: true });
    await writeFile(join(root, '.git'), 'gitdir: common/worktrees/linked\n');
    await writeFile(join(root, 'common/worktrees/linked/commondir'), '../..\n');
    for (const path of ['pi/gateway.ts', 'src/checkout-lock.ts']) {
      await copyFile(new URL('../' + path, import.meta.url), join(root, path));
    }
    await writeFile(join(root, 'pi/runtime.ts'), `import command from 'fixture-dependency';
export default function(pi) { pi.registerCommand(command, { handler() {} }); }`);
    const { loadExtensions } = await import(new URL('../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js', import.meta.url).href);
    await withCheckoutLock(root, signal, async () => {
      const journal = await readFile(join(root, 'common/mcp-gateway-build.lock'), 'utf8');
      assert.equal(JSON.parse(journal).kind, 'owner');
      loading = loadExtensions([join(root, 'pi/gateway.ts')], root);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const dependency = join(root, 'node_modules/fixture-dependency');
      await mkdir(dependency, { recursive: true });
      await writeFile(join(dependency, 'package.json'), '{"name":"fixture-dependency","main":"index.js"}');
      await writeFile(join(dependency, 'index.js'), 'module.exports = "installed";');
    });
    const result = await loading;
    assert.deepEqual(result.errors, []);
    assert.ok(result.extensions[0].commands.has('installed'));
    const cancelled = new AbortController();
    await withCheckoutLock(root, signal, async () => {
      const pending = withCheckoutLock(root, cancelled.signal, async () => assert.fail('Cancelled waiter acquired the lock'));
      cancelled.abort();
      await assert.rejects(pending);
      await readFile(join(root, 'common/mcp-gateway-build.lock'));
    });
  } finally {
    await loading?.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
