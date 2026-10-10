import { createRequire } from 'node:module';

const { name, version } = createRequire(import.meta.url)('../package.json') as { name: string; version: string };

export const gatewayIdentity = { name, version };
