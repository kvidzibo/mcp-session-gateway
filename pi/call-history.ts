import type { CallEvent } from '../src/call-events.js';
import { cleanUnbounded } from '../src/native-ui.js';

export type CallStatus = 'success' | 'failure' | 'pending';
export interface RetainedCall {
  id: string; service: string; tool: string; status: CallStatus;
  parameters: string; output: string; started: number;
}
export const HISTORY_LIMIT = 100;

/** Bounded runtime-only history; counters remain authoritative across reload/resume. */
export class CallHistory {
  readonly calls: RetainedCall[] = [];
  private listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private changed(): void { for (const listener of this.listeners) listener(); }
  event(event: CallEvent): void {
    if (event.phase === 'started') {
      if (this.calls.some((call) => call.id === event.id)) return;
      this.calls.push({ id: event.id, service: event.service, tool: cleanUnbounded(event.tool ?? '(tool unavailable)'), status: 'pending',
        parameters: cleanUnbounded(event.parameters ?? '(payload not retained)'), output: 'Waiting for result…', started: Date.now() });
      if (this.calls.length > HISTORY_LIMIT) this.calls.shift();
    } else {
      const call = this.calls.find((call) => call.id === event.id && call.service === event.service && call.status === 'pending');
      if (!call) return;
      call.status = event.phase;
      call.output = cleanUnbounded(event.output ?? '(payload not retained)');
    }
    this.changed();
  }
  interrupt(): void {
    for (const call of this.calls) if (call.status === 'pending') {
      call.status = 'failure'; call.output = 'Interrupted: connection closed; outcome unavailable.';
    }
    this.changed();
  }
  clear(): void { this.calls.length = 0; this.changed(); }
  filtered(service: string, status: CallStatus): RetainedCall[] {
    return this.calls.filter((call) => call.service === service && call.status === status).reverse();
  }
}
