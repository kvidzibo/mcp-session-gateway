import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { withCheckoutLock } from '../src/checkout-lock.js';

const root = fileURLToPath(new URL('../', import.meta.url));

/** npm ci removes dependencies first: wait for the updater before importing the runtime. */
export default async function gatewayExtension(pi: ExtensionAPI): Promise<void> {
  await withCheckoutLock(root, new AbortController().signal, async () => {
    try {
      const { default: register } = await import('./runtime.js');
      register(pi);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'MODULE_NOT_FOUND' && code !== 'ERR_MODULE_NOT_FOUND') throw error;
      throw new Error(`Gateway dependencies are missing after an interrupted installation. After all gateway updates/builds finish, run npm ci --include=dev in ${root}, then start a fresh Pi with Auto update on to rebuild and validate. ${String(error)}`, { cause: error });
    }
  });
}
