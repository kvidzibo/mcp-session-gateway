import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureGatewayBuild } from '../pi/build.js';
import { withCheckoutLock } from '../src/checkout-lock.js';

test('launch builds missing/stale output once, detects content changes, and never accepts a failed build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-build-'));
  const signal = new AbortController().signal;
  let pending: Promise<void> | undefined;
  const build = () => ensureGatewayBuild(root, signal);
  const count = async () => (await readFile(join(root, 'builds'), 'utf8')).length;
  try {
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'examples'));
    const command = `const fs=require('node:fs');
      fs.appendFileSync('builds','x');
      const source=fs.readFileSync('src/cli.ts','utf8');
      fs.writeFileSync('dist/cli.js', source);
      if(source==='FAIL') throw new Error('intentional compiler failure');
      fs.writeFileSync('dist/cli.d.ts','declaration');`.replace(/\s*\n\s*/g, ' ');
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { build: `node -e ${JSON.stringify(command)}` } }));
    for (const path of ['package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'tsconfig.examples-build.json']) {
      await writeFile(join(root, path), '{}');
    }
    const source = join(root, 'src/cli.ts');
    await writeFile(source, 'one');
    await Promise.all([build(), build()]);
    assert.equal(await count(), 1, 'Concurrent launches share the completed build');
    await build();
    assert.equal(await count(), 1, 'Fresh output is not rebuilt');
    const original = await stat(source);
    await writeFile(source, 'two');
    await utimes(source, original.atime, original.mtime);
    await build();
    assert.equal(await count(), 2, 'Content, not timestamps, determines freshness');
    assert.equal(await readFile(join(root, 'dist/cli.js'), 'utf8'), 'two');
    await rm(join(root, 'dist/cli.d.ts'));
    await build();
    assert.equal(await count(), 3, 'Missing output triggers rebuild');
    await writeFile(join(root, 'dist/cli.js'), 'corrupt');
    await build();
    assert.equal(await count(), 4, 'Modified output triggers rebuild');
    await writeFile(join(root, 'package-lock.json'), '{"changed":true}');
    await build();
    assert.equal(await count(), 5, 'Dependency lock changes invalidate output');
    await writeFile(source, 'FAIL');
    await assert.rejects(build(), /Gateway build failed[\s\S]*intentional compiler failure/);
    await assert.rejects(readFile(join(root, 'dist/.gateway-build.json')), { code: 'ENOENT' });
    await writeFile(source, 'two');
    await build();
    assert.equal(await count(), 7, 'Failure cannot reuse the earlier successful stamp');
    // The updater and compiler must not race npm ci against tsc.
    await mkdir(join(root, '.git'));
    await writeFile(source, 'three');
    await withCheckoutLock(root, signal, async () => {
      pending = build();
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(await count(), 7, 'A launch compiler waits for the checkout update lock');
      assert.ok(pending);
    });
    await pending;
    assert.equal(await count(), 8);
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(ensureGatewayBuild(root, cancelled.signal), { name: 'AbortError' });
  } finally {
    await pending?.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
