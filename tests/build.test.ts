import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ensureGatewayBuild } from '../pi/build.js';
import { awaitTransportExit } from '../pi/transport.js';
import { checkoutIdentity, withCheckoutLock } from '../src/checkout-lock.js';

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
    execFileSync('git', ['init', root], { stdio: 'ignore' });
    await writeFile(source, 'three');
    await withCheckoutLock(root, signal, async () => {
      pending = build();
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(await count(), 7, 'A launch compiler waits for the checkout update lock');
      assert.ok(pending);
    });
    await pending;
    assert.equal(await count(), 8);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const handshake = new Promise<void>((resolve) => { release = resolve; });
    const launching = ensureGatewayBuild(root, signal, { launch: async () => { enter(); await handshake; } });
    await entered;
    let installing = false;
    const installer = withCheckoutLock(root, signal, async () => { installing = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(installing, false, 'Dependency replacement must wait for the child handshake');
    } finally { release(); await Promise.all([launching, installer]); }
    assert.equal(installing, true);
    // Exercise SDK connect()'s fire-and-forget close with a real slow-exiting child.
    for (const stubborn of [false, true]) {
      const client = new Client({ name: 'timeout-fixture', version: '1' });
      const transport = new StdioClientTransport({ command: process.execPath, args: ['-e',
        stubborn
          ? "process.stdin.resume(); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);"
          : "process.stdin.resume(); process.stdin.on('end',()=>setTimeout(()=>process.exit(0),350));"], stderr: 'pipe' });
      awaitTransportExit(transport);
      let exited = false;
      const onclose = transport.onclose;
      transport.onclose = () => { exited = true; onclose?.(); };
      let timedOut!: () => void;
      const timeout = new Promise<void>((resolve) => { timedOut = resolve; });
      const failing = assert.rejects(ensureGatewayBuild(root, signal, {
        launch: async () => {
          try { await client.connect(transport, { timeout: 1000 }); }
          catch (error) { timedOut(); throw error; }
        },
        dispose: () => transport.close(),
      }), /timed out/);
      await timeout;
      const afterFailure = withCheckoutLock(root, signal, async () => {
        assert.equal(exited, true, 'The installer must wait for SDK-initiated teardown and actual child exit');
      });
      try { await Promise.all([failing, afterFailure]); }
      finally { await transport.close(); }
    }

    // Even a launch callback that absorbs cancellation must dispose under lock.
    const shutdown = new AbortController();
    const slow = new StdioClientTransport({ command: process.execPath, args: ['-e',
      "process.stdin.resume(); process.stdin.on('end',()=>setTimeout(()=>process.exit(0),350));"], stderr: 'pipe' });
    awaitTransportExit(slow);
    let childExited = false;
    const closed = slow.onclose;
    slow.onclose = () => { childExited = true; closed?.(); };
    let discovering!: () => void;
    const discovery = new Promise<void>((resolve) => { discovering = resolve; });
    const cancelledStartup = assert.rejects(ensureGatewayBuild(root, shutdown.signal, {
      launch: async () => {
        await slow.start();
        await new Promise<void>((resolve) => {
          shutdown.signal.addEventListener('abort', () => resolve(), { once: true });
          discovering();
        });
      },
      dispose: () => slow.close(),
    }), (error) => error === shutdown.signal.reason);
    await discovery;
    shutdown.abort();
    const stopping = slow.close();
    const afterShutdown = withCheckoutLock(root, signal, async () => {
      assert.equal(childExited, true, 'Absorbed startup cancellation cannot release the lock before child exit');
    });
    try { await Promise.all([cancelledStartup, stopping, afterShutdown]); }
    finally { await slow.close(); }

    const identity = await checkoutIdentity(root);
    await withCheckoutLock(root, signal, async () => {
      pending = ensureGatewayBuild(root, signal, { launch: async () => assert.fail('An outdated adapter launched'), identity });
      await writeFile(source, 'four');
    });
    await assert.rejects(pending!, /reload/, 'Direct launches cannot mix an outdated adapter with changed installation files');
    assert.equal(await count(), 8);
    await withCheckoutLock(root, signal, async () => {
      pending = build();
      await writeFile(join(root, '.git/mcp-gateway-local.json'),
        JSON.stringify({ ready: false, head: 'failed-update', definition: 'failed-update' }));
    });
    await assert.rejects(pending!, /successful startup build/, 'A queued launch must reread a failed update receipt, even with fresh output');
    assert.equal(await count(), 8, 'Never compile or reuse output after another updater fails');
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(ensureGatewayBuild(root, cancelled.signal), { name: 'AbortError' });
  } finally {
    await pending?.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
