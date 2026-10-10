import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ElicitRequestSchema, isJSONRPCRequest, type ElicitRequestParams, type ElicitResult, type RequestId } from '@modelcontextprotocol/sdk/types.js';

/** Observe public transport messages before SDK promise dispatch. SDK 1.32.1
 * ignores cancellation ID 0; synchronous tracking also covers request+cancel
 * arriving together, without overriding SDK notification handling.
 */
export function trackRequests(transport: Transport, methods: string[]) {
  const pending = new Map<RequestId, AbortController>();
  const onmessage = transport.onmessage;
  const onclose = transport.onclose;
  transport.onmessage = (message, extra) => {
    if (isJSONRPCRequest(message) && methods.includes(message.method)) pending.set(message.id, new AbortController());
    else if ('method' in message && message.method === 'notifications/cancelled') {
      const id = message.params?.requestId;
      if (typeof id === 'string' || typeof id === 'number') pending.get(id)?.abort();
    }
    onmessage?.(message, extra);
  };
  transport.onclose = () => {
    for (const controller of pending.values()) controller.abort();
    pending.clear();
    onclose?.();
  };
  return {
    signal: (id: RequestId, original: AbortSignal) => {
      const controller = pending.get(id);
      return controller ? AbortSignal.any([original, controller.signal]) : original;
    },
    finish: (id: RequestId) => { pending.delete(id); },
  };
}

export function handleElicitation(client: Client, transport: Transport, handler: (params: ElicitRequestParams, signal: AbortSignal) => Promise<ElicitResult>): void {
  const tracker = trackRequests(transport, ['elicitation/create']);
  client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
    try { return await handler(request.params, tracker.signal(extra.requestId, extra.signal)); }
    finally { tracker.finish(extra.requestId); }
  });
}
