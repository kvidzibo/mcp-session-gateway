import { z } from 'zod/v4';

/** Operator telemetry: only child tools/call dispatches, never arguments/results. */
export const CallEventSchema = z.object({
  method: z.literal('notifications/gateway/tool-call'),
  params: z.object({
    id: z.string().uuid(),
    service: z.string().regex(/^[a-z][a-z0-9-]*$/),
    phase: z.enum(['started', 'success', 'failure']),
  }),
});
export type CallEvent = z.infer<typeof CallEventSchema>['params'];
