import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// A child ignoring EOF and SIGTERM must not outlive either gateway layer.
test('startup failure and closed upstream streams await child teardown', { timeout: 25_000 }, async () => {
  const directory = await mkdtemp('/tmp/mcp-gateway-lifecycle-');
  try {
    for (const reason of ['timeout', 'eof', 'sdk', 'stderr'] as const) {
      const config = path.join(directory, `${reason}.json`);
      const pidFile = path.join(directory, 'stderr.pid');
      await writeFile(config, JSON.stringify({
        timeoutMs: reason === 'timeout' ? 1000 : 300_000,
        servers: {
          stubborn: {
            command: process.execPath,
            cwd: root,
            args: reason === 'stderr' ? ['--input-type=module', '-e', `
              import { Server } from '@modelcontextprotocol/sdk/server/index.js';
              import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
              import { writeFileSync } from 'node:fs';
              process.on('SIGTERM', () => {});
              setInterval(() => {}, 1000);
              writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
              await new Server({ name: 'stubborn', version: '1' }, { capabilities: {} }).connect(new StdioServerTransport());
            `] : ['-e', `
              process.on('SIGTERM', () => {});
              process.stdin.resume();
              setInterval(() => {}, 1000);
              console.error('fixture-pid:' + process.pid);
            `],
          },
        },
      }));
      if (reason === 'sdk') {
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: ['--import', 'tsx', path.join(root, 'src/cli.ts'), '--config', config],
          cwd: root,
          stderr: 'pipe',
        });
        let stderr = '';
        let childPid: number | undefined;
        transport.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
          const match = /fixture-pid:(\d+)/.exec(stderr);
          if (match) childPid = Number(match[1]);
        });
        try {
          await transport.start();
          while (childPid === undefined) {
            await once(transport.stderr!, 'data', { signal: AbortSignal.timeout(5000) });
          }
          await transport.close();
          for (let attempt = 0; attempt < 50 && alive(childPid); attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.equal(alive(childPid), false, `Child ${childPid} survived SDK close`);
        } finally {
          if (childPid !== undefined && alive(childPid)) process.kill(childPid, 'SIGKILL');
          await transport.close();
        }
        continue;
      }
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
        const start = Date.now();
        if (reason === 'stderr') gateway.stderr.destroy();
        else {
          while (childPid === undefined && gateway.exitCode === null) {
            await once(gateway.stderr, 'data', { signal: AbortSignal.timeout(5000) });
          }
          assert.ok(childPid, `Fixture did not start: ${stderr}`);
          if (reason === 'eof') gateway.stdin.end();
        }
        const [code] = await closed;
        if (reason === 'stderr') childPid = Number(await readFile(pidFile, 'utf8'));
        assert.ok(childPid);
        assert.equal(code, reason === 'eof' ? 0 : 1, stderr);
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
