#!/usr/bin/env node
import { PassThrough } from 'node:stream';
import { loadConfig } from './config.js';
import { Gateway } from './gateway.js';
import { flushDiagnostics, openDiagnosticLog, silenceDiagnostics, writeDiagnostic } from './diagnostics.js';

let stopForStderrError = (): void => { process.exitCode = 1; };
process.stderr.on('error', () => {
  silenceDiagnostics();
  stopForStderrError();
});

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--config') {
    writeDiagnostic('Usage: local-mcp-gateway --config /path/to/gateway.json\n');
    process.exitCode = args.length === 1 && args[0] === '--help' ? 0 : 1;
    return;
  }
  const config = await loadConfig(args[1]);
  openDiagnosticLog(config.logFile, () => { stopForStderrError(); });
  const gateway = new Gateway(config);
  let stopping = false;
  let exitCode = 0;
  const stop = async (code = 0): Promise<void> => {
    exitCode = Math.max(exitCode, code);
    if (stopping) return;
    stopping = true;
    try {
      await gateway.close();
    } catch (error) {
      writeDiagnostic(`Gateway cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
      exitCode = 1;
    }
    await flushDiagnostics();
    process.exit(exitCode);
  };
  stopForStderrError = () => { void stop(1); };
  if (process.stderr.destroyed) {
    await stop(1);
    return;
  }
  // Drain upstream immediately so EOF is visible during child initialization.
  // Buffer the handshake until the downstream catalogue is ready; cap memory.
  const input = new PassThrough();
  const pending: Buffer[] = [];
  let pendingBytes = 0;
  let ready = false;
  gateway.onclose = () => { void stop(); };
  process.stdin.on('data', (chunk: Buffer) => {
    if (stopping) return;
    if (ready) {
      input.write(chunk);
      return;
    }
    pendingBytes += chunk.length;
    if (pendingBytes > 1024 * 1024) {
      writeDiagnostic('Gateway startup input exceeds 1 MiB\n');
      void stop(1);
      return;
    }
    pending.push(chunk);
  });
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  process.stdin.once('end', () => { void stop(); });
  process.stdin.once('error', () => { void stop(1); });
  process.stdout.once('error', () => { void stop(1); });
  try {
    await gateway.start(input);
    if (stopping) return;
    ready = true;
    for (const chunk of pending) input.write(chunk);
    pending.length = 0;
  } catch (error) {
    if (stopping) return; // Upstream EOF/signal may cancel initialization normally.
    writeDiagnostic(`Gateway startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    await stop(1);
  }
}

main().catch((error: unknown) => {
  writeDiagnostic(`Gateway failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
