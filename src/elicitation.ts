import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CancelledNotificationSchema, ElicitRequestSchema, type ElicitRequestParams, type ElicitResult, type RequestId } from '@modelcontextprotocol/sdk/types.js';

/** Handle the only asynchronous server-origin request supported by this gateway.
 * SDK 1.32.1's cancellation handler ignores request ID 0; track our own signals
 * rather than relying on its truthiness check. Ping requires no cancellation.
 */
export function handleElicitation(client: Client, handler: (params: ElicitRequestParams, signal: AbortSignal) => Promise<ElicitResult>): void {
  const pending = new Map<RequestId, AbortController>();
  client.setNotificationHandler(CancelledNotificationSchema, ({ params }) => {
    if (params.requestId !== undefined) pending.get(params.requestId)?.abort();
  });
  client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
    const controller = new AbortController();
    pending.set(extra.requestId, controller);
    try { return await handler(request.params, AbortSignal.any([extra.signal, controller.signal])); }
    finally { pending.delete(extra.requestId); }
  });
}
