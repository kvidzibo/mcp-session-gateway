import { z } from 'zod/v4';

/** Child dispatch telemetry. Bounded payloads are display-only, never logged or persisted. */
export const CALL_PAYLOAD_LIMIT = 16_384;
export function callPayload(value: unknown): string {
  const text = JSON.stringify(value, null, 2) ?? '(none)';
  return text.length > CALL_PAYLOAD_LIMIT ? `${text.slice(0, CALL_PAYLOAD_LIMIT - 32)}\n[retention limit: truncated]` : text;
}
export const CallEventSchema = z.object({
  method: z.literal('notifications/gateway/tool-call'),
  params: z.object({
    id: z.string().uuid(),
    service: z.string().regex(/^[a-z][a-z0-9-]*$/),
    phase: z.enum(['started', 'success', 'failure']),
    tool: z.string().max(256).optional(),
    parameters: z.string().max(CALL_PAYLOAD_LIMIT).optional(),
    output: z.string().max(CALL_PAYLOAD_LIMIT).optional(),
  }),
});
export type CallEvent = z.infer<typeof CallEventSchema>['params'];
