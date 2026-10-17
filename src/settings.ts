import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod/v4';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

export const SETTINGS_EXTENSION = 'com.kvidzibo/settings';
export const SETTINGS_GET = 'kvidzibo/settings/get';
export const SETTINGS_UPDATE = 'kvidzibo/settings/update';
export const OPERATOR_ENV = 'MCP_GATEWAY_SETTINGS_TOKEN';
export const OPERATOR_EXTENSION = 'com.kvidzibo/gateway-settings';
export const OPERATOR_LIST = 'gateway/settings/list';
export const OPERATOR_GET = 'gateway/settings/get';
export const OPERATOR_UPDATE = 'gateway/settings/update';
const object = z.record(z.string(), z.unknown());
export const SettingsDocumentSchema = z.object({
  schemaVersion: z.literal(1), title: z.string(), revision: z.string().min(1),
  schema: object, values: object, writable: z.boolean(),
  conflict: z.boolean().optional(), warning: z.string().optional(), applyTo: z.string().optional(),
  models: z.array(z.object({ id: z.string(), label: z.string(), available: z.boolean(), thinking: z.array(z.string()) })).optional(),
});
export type SettingsDocument = z.infer<typeof SettingsDocumentSchema>;
export const OperatorListSchema = z.object({ method: z.literal(OPERATOR_LIST), params: z.object({ token: z.string() }).strict() });
export const OperatorGetSchema = z.object({ method: z.literal(OPERATOR_GET), params: z.object({ token: z.string(), service: z.string() }).strict() });
export const OperatorUpdateSchema = z.object({ method: z.literal(OPERATOR_UPDATE), params: z.object({ token: z.string(), service: z.string(), revision: z.string(), patch: object }).strict() });
export const OperatorServicesSchema = z.object({ services: z.array(z.object({ name: z.string(), title: z.string().optional() })) });
export const SettingsCapabilitySchema = z.object({
  version: z.literal(1), getMethod: z.literal(SETTINGS_GET), updateMethod: z.literal(SETTINGS_UPDATE),
  authorization: z.literal('token'), audience: z.literal('operator'), title: z.string().optional(),
});

export function authorize(actual: string, expected: string | undefined): void {
  const hash = (text: string) => createHash('sha256').update(text).digest();
  if (!expected || !timingSafeEqual(hash(actual), hash(expected))) throw new McpError(-33001, 'Settings authorization required');
}

export function validToken(token: string): boolean { return /^[A-Za-z0-9_-]{32,256}$/.test(token); }

// Prevent ambiguous/prototype paths in schema-driven editors and merge patches.
export function safeKey(key: string): boolean { return !['__proto__', 'constructor', 'prototype'].includes(key); }
