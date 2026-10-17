import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withCheckoutLock } from '../src/checkout-lock.js';

export async function updateBeforeLoad(root: string, signal: AbortSignal,
  progress: (stage: string) => void,
  notify: (text: string, level: 'info' | 'warning') => void): Promise<void> {
  try { await lstat(join(root, '.git')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  let finished: Promise<void> | undefined;
  let cancel: (() => void) | undefined;
  try {
    await withCheckoutLock(root, signal, async () => {
      signal.throwIfAborted();
      // Resolve, but do not import, the replaceable TypeScript loader in Pi.
      const loader = createRequire(join(root, 'package.json')).resolve('tsx');
      const child = fork(join(root, 'pi/update-worker.ts'), [root], {
        execArgv: ['--import', pathToFileURL(loader).href], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      let failure = '', ready!: () => void, failed!: (error: Error) => void;
      const imported = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
      let output = '';
      child.stderr!.on('data', (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-8000); });
      const abort = () => { if (child.connected) child.send('abort'); };
      cancel = abort;
      signal.addEventListener('abort', abort, { once: true });
      finished = new Promise<void>((resolve, reject) => {
        child.on('message', (message: unknown) => {
          if (message === 'ready') { ready(); return; }
          if (!message || typeof message !== 'object') return;
          const event = message as { stage?: string; text?: string; level?: string; error?: string };
          if (event.stage) progress(event.stage === 'updating' ? 'Updating gateway' : 'Checking gateway updates');
          if (event.text) notify(event.text, event.level === 'warning' ? 'warning' : 'info');
          if (event.error) failure = event.error;
        });
        child.once('error', (error) => { failed(error); reject(error); });
        child.once('close', (code) => {
          signal.removeEventListener('abort', abort);
          const error = new Error(failure || `Gateway startup updater exited (${code}). ${output}`);
          failed(error);
          if (signal.aborted) reject(signal.reason);
          else if (code !== 0) reject(error);
          else resolve();
        });
      });
      // Observe early errors while waiting for imports under the lock.
      void finished.catch(() => {});
      await imported;
      signal.throwIfAborted();
      child.send('start');
    });
    await finished;
  } catch (error) {
    cancel?.();
    await finished?.catch(() => {});
    throw error;
  }
}
