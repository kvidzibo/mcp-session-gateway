import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { PackageManager, updateManagedPackages } from '../src/package-manager.js';
import type { PackageConfig } from '../src/packages.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

test('startup update concurrency follows CPU/config limits, preserves order, and drains on cancellation or fatal local failure', { timeout: 15_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-concurrency-'));
  try {
    const file = join(dir, 'gateway.json');
    const declaration = {
      autoUpdate: true,
      packages: Object.fromEntries(['a', 'b', 'c', 'd', 'inactive', 'unlinked'].map((name) => [name, {
        source: { type: 'npm', name }, managed: { validate: [{ command: process.execPath, args: ['-e', ''] }] },
      }])),
      mcpServers: Object.fromEntries(['a', 'b', 'c', 'd', 'inactive'].map((name) => [name, {
        package: name, command: process.execPath, args: ['{{packageRoot}}/server.js'],
      }])),
    };
    await writeFile(file, JSON.stringify(declaration));
    const config = await loadConfig(file);
    assert.equal(config.autoUpdateConcurrency, Math.min(4, Math.max(1, Math.floor(availableParallelism() / 2))));
    for (const value of [null, true, 0, -1, 1.5, 129, '2']) {
      await writeFile(file, JSON.stringify({ ...declaration, autoUpdateConcurrency: value }));
      await assert.rejects(loadConfig(file), /autoUpdateConcurrency must be an integer between 1 and 128/);
    }
    for (const value of [1, 2, 8, 128]) {
      await writeFile(file, JSON.stringify({ ...declaration, autoUpdateConcurrency: value }));
      assert.equal((await loadConfig(file)).autoUpdateConcurrency, value);
    }

    const started: string[] = [], completed: string[] = [], warnings: string[] = [];
    let active = 0, peak = 0;
    let prepare: (pkg: PackageConfig, signal: AbortSignal) => Promise<void> = async () => {};
    t.mock.method(PackageManager.prototype, 'update', async (pkg: PackageConfig, signal: AbortSignal) => {
      if (pkg.name === 'inactive') return;
      started.push(pkg.name); active++; peak = Math.max(peak, active);
      try { await prepare(pkg, signal); completed.push(pkg.name); return { name: pkg.name, from: '1.0.0', version: '2.0.0' }; }
      finally { active--; }
    });
    const run = (limit: number, signal = new AbortController().signal, current = config) => updateManagedPackages(
      { ...current, autoUpdateConcurrency: limit }, signal, (name) => warnings.push(name),
    );
    const reset = () => { started.length = completed.length = warnings.length = 0; peak = 0; };
    const expected = ['a', 'b', 'c', 'd'].map((name) => ({ name, from: '1.0.0', version: '2.0.0' }));
    assert.deepEqual(await run(2, undefined, { ...config, autoUpdate: false }), []);
    assert.deepEqual(started, []);
    for (const limit of [1, 2, 8]) {
      reset();
      const full = deferred(), release = deferred();
      prepare = async () => { if (active === Math.min(limit, 4)) full.resolve(); await release.promise; };
      const updating = run(limit);
      await full.promise;
      assert.equal(peak, Math.min(limit, 4));
      release.resolve();
      assert.deepEqual(await updating, expected);
      assert.equal(peak, Math.min(limit, 4), 'Never exceed the configured limit');
      assert.deepEqual(started, ['a', 'b', 'c', 'd'], 'Unlinked/inactive packages do not prepare');
    }
    reset();
    const first = deferred();
    prepare = async (pkg) => { if (pkg.name === 'a') await first.promise; if (pkg.name === 'd') first.resolve(); };
    assert.deepEqual(await run(2), expected, 'Summary order is independent of completion order');
    assert.equal(completed[0], 'b');

    reset();
    prepare = async (pkg) => { if (pkg.name === 'b') throw new Error('validation failed'); };
    assert.deepEqual(await run(2), expected.filter(({ name }) => name !== 'b'));
    assert.deepEqual(warnings, ['b'], 'Managed failures warn without stopping unrelated updates');

    for (const fatalLocal of [false, true]) {
      reset();
      const controller = new AbortController(), cleaning = deferred(), releaseCleanup = deferred(), full = deferred();
      prepare = async (_pkg, signal) => {
        if (active === (fatalLocal ? 1 : 2)) full.resolve();
        if (!signal.aborted) await once(signal, 'abort');
        cleaning.resolve();
        await releaseCleanup.promise;
        signal.throwIfAborted();
      };
      const current = structuredClone(config);
      if (fatalLocal) {
        // A missing local root is startup-blocking, unlike a managed validation failure.
        current.packages.splice(1, 0, {
          name: 'broken', source: { type: 'local', path: join(dir, 'missing') },
          localUpdate: { build: [], validate: [{ command: process.execPath, args: [], cwd: '.' }], outputs: [], timeoutMs: 5000 },
        });
        current.services.push({ name: 'broken', package: 'broken', command: process.execPath, args: ['{{packageRoot}}/server.js'], env: {}, cwd: dir });
      }
      const reason = new Error('shutdown');
      let settled = false;
      const updating = assert.rejects(run(2, controller.signal, current), fatalLocal ? /ENOENT/ : reason).then(() => { settled = true; });
      await full.promise;
      if (!fatalLocal) controller.abort(reason);
      await cleaning.promise;
      assert.equal(settled, false, 'Do not return before active operations finish cleanup');
      assert.equal(active > 0, true);
      assert.deepEqual(started, fatalLocal ? ['a'] : ['a', 'b'], 'Never dispatch queued packages after stopping');
      releaseCleanup.resolve();
      await updating;
      assert.equal(active, 0);
      assert.deepEqual(completed, []);
      assert.deepEqual(warnings, fatalLocal ? ['broken'] : []);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
