import { constants } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { checkoutIdentity } from '../src/checkout-lock.js';

/** Called under the checkout lock. Running adapters never import replaceable checkout files. */
export async function snapshotInstallation(root: string, signal: AbortSignal): Promise<string> {
  const identity = await checkoutIdentity(root, signal);
  const store = join(root, '.gateway-runtimes');
  await mkdir(store, { recursive: true, mode: 0o700 });
  if (!(await lstat(store)).isDirectory()) throw new Error('Gateway runtime store must not be a symlink');
  const destination = join(store, identity);
  try {
    if (!(await lstat(destination)).isDirectory() || await readFile(join(destination, '.ready'), 'utf8') !== identity) {
      throw new Error(`Invalid gateway runtime copy: ${destination}`);
    }
    return destination;
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const staging = await mkdtemp(join(store, '.preparing-'));
  try {
    // Never hard-link: npm and checkout updates may overwrite files in place.
    for (const path of ['src', 'pi', 'examples', 'node_modules', 'dist', 'package.json', 'package-lock.json',
      'tsconfig.json', 'tsconfig.build.json', 'tsconfig.examples-build.json']) {
      signal.throwIfAborted();
      try { await lstat(join(root, path)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !['node_modules', 'dist', 'examples'].includes(path)) throw error;
        if (path !== 'node_modules') await mkdir(join(staging, path), { recursive: true });
        continue;
      }
      await cp(join(root, path), join(staging, path), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE,
        filter: (source) => { signal.throwIfAborted(); return source !== join(root, 'dist/.gateway-build.lock'); } });
    }
    // Preserve internal .bin links, but never retain links into the mutable installation.
    const canonical = await realpath(root);
    const links = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        signal.throwIfAborted();
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await links(path);
        else if (entry.isSymbolicLink()) {
          const source = join(root, relative(staging, path));
          const target = await realpath(source);
          const inside = relative(canonical, target);
          if (inside === '..' || inside.startsWith('../') || isAbsolute(inside)) {
            throw new Error(`Gateway runtime refuses an external symlink: ${source}`);
          }
          const copied = join(staging, inside);
          await lstat(copied);
          await rm(path);
          await symlink(relative(dirname(path), copied), path);
        }
      }
    };
    await links(staging);
    signal.throwIfAborted();
    if (identity !== await checkoutIdentity(root, signal)) throw new Error('Gateway installation changed while copying; retry reload');
    await writeFile(join(staging, '.ready'), identity, { mode: 0o600 });
    await rename(staging, destination);
    return destination;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
