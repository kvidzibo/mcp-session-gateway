#!/usr/bin/env node
import { loadConfig } from './config.js';
import { Gateway } from './gateway.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--config') {
    process.stderr.write('Usage: local-mcp-gateway --config /path/to/gateway.json\n');
    process.exitCode = args.length === 1 && args[0] === '--help' ? 0 : 1;
    return;
  }
  const gateway = new Gateway(await loadConfig(args[1]));
  let stopping = false;
  const stop = async (code = 0): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      await gateway.close();
    } catch (error) {
      process.stderr.write(`Gateway cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
      code = 1;
    }
    process.exit(code);
  };
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  process.stdin.once('end', () => { void stop(); });
  process.stdin.once('error', () => { void stop(1); });
  process.stdout.once('error', () => { void stop(1); });
  try {
    await gateway.start();
  } catch (error) {
    process.stderr.write(`Gateway startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    await stop(1);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Gateway failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
