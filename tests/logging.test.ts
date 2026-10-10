import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'src/cli.ts');
const service = pathToFileURL(path.join(root, 'tests/service.ts')).href;

test('file diagnostics append across runs, mirror child stderr, and fail before spawning on an invalid path', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gateway-logging-'));
  const configPath = path.join(directory, 'config.json');
  const defaultLog = path.join(directory, 'gateway.log');
  const customLog = path.join(directory, 'custom.log');
  const servers = {
    fixture: {
      command: process.execPath,
      args: ['--import', 'tsx', '--input-type=module', '-e',
        `process.stderr.write('child-diagnostic\\n'); await import(${JSON.stringify(service)});`],
      cwd: root,
    },
  };
  try {
    await writeFile(defaultLog, 'existing-log\n');
    for (const logFile of [undefined, undefined, 'custom.log']) {
      await writeFile(configPath, JSON.stringify({ servers, logFile, timeoutMs: 5000 }));
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', cli, '--config', configPath],
        cwd: root,
        stderr: 'pipe',
      });
      let stderr = '';
      transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      const client = new Client({ name: 'logging-test', version: '1.0.0' });
      try {
        await client.connect(transport);
        const result = await client.callTool({ name: 'fixture__echo', arguments: { value: 'protocol-intact' } });
        assert.equal((result.structuredContent as { arguments: { value: string } }).arguments.value, 'protocol-intact');
        // Read while the gateway is still running: no exit-time buffering.
        const log = await readFile(logFile ? customLog : defaultLog, 'utf8');
        assert.match(log, /child-diagnostic\n/);
        assert.match(log, /\[gateway [^\]]+\] Started with 1 service\(s\)/);
      } finally {
        await client.close();
        await transport.close();
      }
      assert.match(stderr, /child-diagnostic\n/);
      assert.match(stderr, /Started with 1 service/);
    }
    const log = await readFile(defaultLog, 'utf8');
    assert.ok(log.startsWith('existing-log\n'));
    assert.equal(log.match(/Started with 1 service/g)?.length, 2);
    assert.equal(log.match(/child-diagnostic/g)?.length, 2);
    if (process.platform !== 'win32') assert.equal((await stat(customLog)).mode & 0o777, 0o600);

    await writeFile(configPath, JSON.stringify({ servers, logFile: directory }));
    const gateway = spawn(process.execPath, ['--import', 'tsx', cli, '--config', configPath], { cwd: root });
    let stderr = '';
    gateway.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const [code] = await once(gateway, 'close');
    assert.equal(code, 1);
    assert.match(stderr, /Gateway failed:/);
    assert.doesNotMatch(stderr, /child-diagnostic/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
