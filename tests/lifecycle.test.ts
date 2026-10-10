import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Exercise both review findings against a child that ignores EOF and SIGTERM.
test('startup timeout and upstream EOF await child teardown', { timeout: 25_000 }, async () => {
  const directory = await mkdtemp('/tmp/mcp-gateway-lifecycle-');
  try {
    for (const reason of ['timeout', 'eof'] as const) {
      const config = path.join(directory, `${reason}.json`);
      await writeFile(config, JSON.stringify({
        timeoutMs: reason === 'timeout' ? 1000 : 300_000,
        servers: {
          stubborn: {
            command: process.execPath,
            args: ['-e', `
              process.on('SIGTERM', () => {});
              process.stdin.resume();
              setInterval(() => {}, 1000);
              console.error('fixture-pid:' + process.pid);
            `],
          },
        },
      }));
      const gateway = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'src/cli.ts'), '--config', config], {
        cwd: root,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const closed = once(gateway, 'close', { signal: AbortSignal.timeout(9000) });
      // Attach rejection handling immediately while waiting for the PID marker.
      void closed.catch(() => {});
      let stderr = '';
      let childPid: number | undefined;
      gateway.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        const match = /fixture-pid:(\d+)/.exec(stderr);
        if (match) childPid = Number(match[1]);
      });
      try {
        while (childPid === undefined && gateway.exitCode === null) {
          await once(gateway.stderr, 'data', { signal: AbortSignal.timeout(5000) });
        }
        assert.ok(childPid, `Fixture did not start: ${stderr}`);
        const start = Date.now();
        if (reason === 'eof') gateway.stdin.end();
        const [code] = await closed;
        assert.equal(code, reason === 'timeout' ? 1 : 0, stderr);
        assert.ok(Date.now() - start < 8000, `Shutdown did not react promptly: ${stderr}`);
        // SIGKILL delivery and OS reaping may finish just after the SDK returns.
        for (let attempt = 0; attempt < 50 && alive(childPid); attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(alive(childPid), false, `Child ${childPid} survived ${reason}`);
      } finally {
        gateway.kill('SIGKILL');
        if (childPid !== undefined && alive(childPid)) process.kill(childPid, 'SIGKILL');
        await closed.catch(() => {});
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
