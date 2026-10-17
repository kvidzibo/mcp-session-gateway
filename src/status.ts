import { z } from 'zod/v4';

/** Private, read-only connection snapshot; connected is not a health check. */
export const GATEWAY_STATUS = 'gateway/status';
export const GatewayStatusRequestSchema = z.object({ method: z.literal(GATEWAY_STATUS) });
export const GatewayStatusSchema = z.object({
  services: z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    state: z.enum(['connected', 'stopped', 'disconnected']),
    tools: z.number().int().nonnegative(),
    toolNames: z.array(z.string()).optional(), // Optional for saved snapshots from older gateways.
  })),
});
export type GatewayStatus = z.infer<typeof GatewayStatusSchema>;
