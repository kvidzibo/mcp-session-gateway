import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { basename, join } from 'node:path';

/** Local capability transport only. No service names, task data, or executable actions on the wire. */
export class FooterActions {
  private server?: Server;
  private file?: string;
  private closed = false;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private clients = new Set<Socket>();
  private actions = new Map<string, { scope: string; invoke: () => Promise<boolean> }>();

  start(): Promise<void> {
    return this.starting ??= this.listen();
  }
  private async listen(): Promise<void> {
    const uid = process.getuid?.();
    if (uid === undefined || this.closed) throw new Error('Footer actions unavailable');
    const dir = `/tmp/pi-gateway-actions-${uid}`;
    await fs.mkdir(dir, { mode: 0o700, recursive: true });
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700 || this.closed) throw new Error('Unsafe footer action directory');
    this.file = join(dir, `${process.pid}-${randomBytes(4).toString('hex')}.sock`);
    const server = createServer((client) => {
      if (this.closed || this.clients.size >= 32) { client.destroy(); return; }
      this.clients.add(client);
      client.on('error', () => client.destroy());
      client.on('close', () => this.clients.delete(client));
      client.setTimeout(5000, () => client.destroy());
      let input = '', dispatched = false;
      client.on('data', (chunk: Buffer) => {
        if (dispatched || this.closed) return;
        input += chunk.toString('utf8');
        if (Buffer.byteLength(input) > 33) { client.destroy(); return; }
        if (!input.includes('\n')) return;
        dispatched = true;
        const token = input.slice(0, -1);
        const entry = /^[0-9a-f]{32}\n$/.test(input) ? this.actions.get(token) : undefined;
        if (!entry) { client.end('rejected\n'); return; }
        // Consume before dispatch: parallel clicks cannot duplicate a write.
        this.actions.delete(token);
        client.setTimeout(0); // Human confirmations have no inactivity deadline.
        void Promise.resolve().then(() => this.closed ? false : entry.invoke()).then(
          (accepted) => { if (!client.destroyed) client.end(accepted ? 'accepted\n' : 'rejected\n'); },
          () => { if (!client.destroyed) client.end('rejected\n'); },
        ); // Accepted operations drain even when a helper disconnects.
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.file!, resolve); });
    await fs.chmod(this.file, 0o600);
    server.on('error', () => { void this.stop(); });
    server.unref();
  }
  clear(scope?: string): void {
    for (const [token, entry] of this.actions) if (scope === undefined || entry.scope === scope) this.actions.delete(token);
  }
  link(scope: string, invoke: () => Promise<boolean>): string | undefined {
    if (this.closed || !this.file || !this.server?.listening || this.actions.size >= 4096) return;
    const token = randomBytes(16).toString('hex');
    this.actions.set(token, { scope, invoke });
    return `pi-gateway-action://${basename(this.file, '.sock')}/${token}`;
  }
  stop(): Promise<void> {
    this.closed = true;
    this.clear();
    return this.stopping ??= (async () => {
      await this.starting?.catch(() => {});
      for (const client of this.clients) client.destroy();
      if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      if (this.file) await fs.unlink(this.file).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    })();
  }
}
