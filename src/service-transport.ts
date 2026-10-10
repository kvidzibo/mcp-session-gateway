import { spawn, type ChildProcess } from 'node:child_process';
import { writeDiagnostic } from './diagnostics.js';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

interface ProcessConfig {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

async function waitUntil(exit: Promise<void>, milliseconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([exit, new Promise<void>((resolve) => { timer = setTimeout(resolve, milliseconds); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** SDK framing with a child shutdown budget shorter than the upstream SDK's. */
export class ServiceTransport implements Transport {
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  onmessage?: Transport['onmessage'];
  private child?: ChildProcess;
  private readonly buffer = new ReadBuffer();
  private closing?: Promise<void>;
  private exit: Promise<void> = Promise.resolve();
  private exited = false;
  private notified = false;

  constructor(private readonly config: ProcessConfig) {}

  private notifyClose(): void {
    if (this.notified) return;
    this.notified = true;
    this.onclose?.();
  }

  async start(): Promise<void> {
    if (this.child || this.closing) throw new Error('Service transport already started or closed');
    const child = spawn(this.config.command, this.config.args, {
      cwd: this.config.cwd,
      env: { ...getDefaultEnvironment(), ...this.config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    this.child = child;
    let resolveExit!: () => void;
    this.exit = new Promise<void>((resolve) => { resolveExit = resolve; });
    child.once('exit', () => { this.exited = true; resolveExit(); });
    child.once('close', () => { this.notifyClose(); });
    child.stdin?.on('error', (error) => { this.onerror?.(error); });
    child.stdout?.on('error', (error) => { this.onerror?.(error); });
    child.stderr?.on('error', (error) => { this.onerror?.(error); });
    child.stderr?.on('data', (chunk: Buffer) => { writeDiagnostic(chunk); });
    child.stdout?.on('data', (chunk: Buffer) => {
      try {
        this.buffer.append(chunk);
        let message: JSONRPCMessage | null;
        while ((message = this.buffer.readMessage()) !== null) this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        void this.close().catch((failure: Error) => { this.onerror?.(failure); });
      }
    });
    await new Promise<void>((resolve, reject) => {
      let spawned = false;
      child.once('spawn', () => { spawned = true; resolve(); });
      child.on('error', (error) => {
        if (!spawned) { this.exited = true; resolveExit(); reject(error); }
        this.onerror?.(error);
      });
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const input = this.child?.stdin;
    if (!input || this.exited || this.closing) throw new Error('Service is not connected');
    await new Promise<void>((resolve, reject) => {
      input.write(serializeMessage(message), (error) => { if (error) reject(error); else resolve(); });
    });
  }

  close(): Promise<void> {
    this.closing ??= Promise.resolve().then(async () => {
      const child = this.child;
      if (child) {
        child.stdin?.end();
        await waitUntil(this.exit, 500);
        if (!this.exited) {
          child.kill('SIGTERM');
          await waitUntil(this.exit, 500);
        }
        if (!this.exited) {
          child.kill('SIGKILL');
          await waitUntil(this.exit, 1000);
        }
        // Don't wait on descriptors inherited by unmanaged descendants.
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (!this.exited) throw new Error('Service process did not exit after SIGKILL');
      }
      this.buffer.clear();
      this.notifyClose();
    });
    return this.closing;
  }
}
