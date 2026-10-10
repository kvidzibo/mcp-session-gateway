let enabled = true;

export function silenceDiagnostics(): void {
  enabled = false;
}

export function writeDiagnostic(message: string): void {
  if (enabled && !process.stderr.destroyed) process.stderr.write(message);
}
