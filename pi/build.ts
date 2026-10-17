import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runPackageCommand } from '../src/package-manager.js';

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

async function sources(root: string, directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sources(root, path));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
  return files.sort();
}

async function fingerprint(root: string, paths: string[]): Promise<string> {
  const hash = createHash('sha256');
  for (const path of paths) {
    hash.update(JSON.stringify(path));
    hash.update(await readFile(join(root, path)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Check/build only at launch, never at extension load or while a gateway is running. */
export async function ensureGatewayBuild(root: string, signal: AbortSignal): Promise<void> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(300_000)]);
  bounded.throwIfAborted();
  await mkdir(join(root, 'dist'), { recursive: true });
  const lockPath = join(root, 'dist/.gateway-build.lock');
  const stampPath = join(root, 'dist/.gateway-build.json');
  let lock;
  while (!lock) {
    bounded.throwIfAborted();
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try { await delay(100, undefined, { signal: bounded }); }
      catch { throw new Error(`Gateway build lock wait cancelled or timed out: ${lockPath}. Remove only a verified stale lock.`); }
    }
  }
  try {
    await lock.writeFile(`pid=${process.pid}\n`);
    const inputs = [...await sources(root, 'src'), ...await sources(root, 'examples'),
      'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'tsconfig.examples-build.json'];
    const outputs = inputs.filter((path) => path.endsWith('.ts')).flatMap((path) => {
      const base = path.startsWith('src/') ? path.slice(4, -3) : path.slice(0, -3);
      return [`dist/${base}.js`, `dist/${base}.d.ts`];
    });
    const input = await fingerprint(root, inputs);
    try {
      const stamp = JSON.parse(await readFile(stampPath, 'utf8'));
      if (stamp?.input === input && stamp.output === await fingerprint(root, outputs)) {
        bounded.throwIfAborted();
        return;
      }
    } catch (error) {
      if (!missing(error) && !(error instanceof SyntaxError)) throw error;
    }
    // Failed/aborted compilers can leave partial output. Never accept it next time.
    await rm(stampPath, { force: true });
    let output = '';
    try {
      await runPackageCommand('npm', ['run', 'build'], root, process.env, bounded, 300_000,
        (chunk) => { output = (output + chunk).slice(-8000); });
      bounded.throwIfAborted();
      const currentInputs = [...await sources(root, 'src'), ...await sources(root, 'examples'), ...inputs.filter((path) => !path.endsWith('.ts'))];
      if (await fingerprint(root, currentInputs) !== input) throw new Error('Build inputs changed during compilation; retry startup');
      await writeFile(stampPath, JSON.stringify({ input, output: await fingerprint(root, outputs) }), { mode: 0o600 });
    } catch (error) {
      throw new Error(`Gateway build failed; no gateway was launched. Run npm ci && npm run build in ${root} if dependencies are missing.\n${String(error)}\n${output}`);
    }
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
