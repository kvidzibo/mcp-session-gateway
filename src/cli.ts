#!/usr/bin/env node
import { PassThrough } from 'node:stream';
import { loadConfig } from './config.js';
import { OPERATOR_ENV } from './settings.js';
import { Gateway } from './gateway.js';
import { errorMessage, flushDiagnostics, openDiagnosticLog, silenceDiagnostics, writeDiagnostic } from './diagnostics.js';

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
  const operatorToken = process.env[OPERATOR_ENV];
  delete process.env[OPERATOR_ENV];
  const gateway = new Gateway(config, operatorToken);
  let stopping = false;
  let exitCode = 0;
  const stop = async (code = 0): Promise<void> => {
    exitCode = Math.max(exitCode, code);
    if (stopping) return;
    stopping = true;
    try {
      await gateway.close();
    } catch (error) {
      writeDiagnostic(`Gateway cleanup failed: ${errorMessage(error)}\n`);
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
  // Process the upstream handshake immediately; catalogue requests wait for
  // child initialization inside the gateway. Observe EOF throughout startup.
  const input = new PassThrough();
  gateway.onclose = () => { void stop(); };
  process.stdin.pipe(input);
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  process.stdin.once('end', () => { void stop(); });
  process.stdin.once('error', () => { void stop(1); });
  process.stdout.once('error', () => { void stop(1); });
  try {
    await gateway.start(input);
  } catch (error) {
    if (stopping) return; // Upstream EOF/signal may cancel initialization normally.
    writeDiagnostic(`Gateway startup failed: ${errorMessage(error)}\n`);
    await stop(1);
  }
}

main().catch((error: unknown) => {
  writeDiagnostic(`Gateway failed: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
