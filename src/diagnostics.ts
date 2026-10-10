import { appendFileSync, closeSync, openSync } from 'node:fs';

let enabled = true;
let logFile: string | undefined;
let onLogError: (() => void) | undefined;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function openDiagnosticLog(path: string, onError: () => void): void {
  // Validate before starting children; never truncate existing logs.
  closeSync(openSync(path, 'a', 0o600));
  logFile = path;
  onLogError = onError;
}

export async function flushDiagnostics(): Promise<void> {
  if (!enabled || process.stderr.destroyed) return;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      process.stderr.off('error', finish);
      resolve();
    };
    const timer = setTimeout(finish, 100);
    process.stderr.once('error', finish);
    // This callback follows earlier writes, even below the high-water mark.
    process.stderr.write('', finish);
  });
}

export function silenceDiagnostics(): void {
  enabled = false;
}

export function writeDiagnostic(message: string | Buffer): boolean {
  if (logFile !== undefined) {
    try {
      // Synchronous appends are immediately visible to tail, including on exit.
      // Reopen each time so external log rotation can replace the file.
      appendFileSync(logFile, message, { flag: 'a', mode: 0o600 });
    } catch (error) {
      logFile = undefined;
      if (enabled && !process.stderr.destroyed) {
        process.stderr.write(`Gateway log write failed: ${errorMessage(error)}\n`);
      }
      onLogError?.();
    }
  }
  if (enabled && !process.stderr.destroyed) return process.stderr.write(message);
  return true;
}
