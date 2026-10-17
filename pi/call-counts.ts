import { z } from 'zod/v4';
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { CallEvent } from '../src/call-events.js';

const CountSchema = z.object({ success: z.number().int().nonnegative(), failure: z.number().int().nonnegative(), pending: z.number().int().nonnegative() });
const SnapshotSchema = z.object({ session: z.string(), scope: z.string(), counts: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), CountSchema) });
export type Counts = z.infer<typeof CountSchema>;
const empty = (): Counts => ({ success: 0, failure: 0, pending: 0 });
export const CALL_COUNTS_ENTRY = 'gateway-call-counts';

/** Session-wide usage, not branch history. Forks must not inherit parent counts. */
export class CallCounts {
  readonly counts = new Map<string, Counts>();
  private active = new Map<string, string>();
  constructor(readonly session: string, readonly scope: string, entries: readonly unknown[]) {
    for (const entry of entries) {
      const item = entry as { type?: string; customType?: string; data?: unknown };
      if (item.type !== 'custom' || item.customType !== CALL_COUNTS_ENTRY) continue;
      const result = SnapshotSchema.safeParse(item.data);
      if (!result.success || result.data.session !== session || result.data.scope !== scope) continue;
      this.counts.clear();
      for (const [name, count] of Object.entries(result.data.counts)) this.counts.set(name, { ...count });
    }
    // A persisted unfinished dispatch has no observable result after reconnect.
    this.interrupt();
  }
  event(event: CallEvent): boolean {
    if (event.phase === 'started') {
      if (this.active.has(event.id)) return false;
      this.active.set(event.id, event.service);
      const count = this.counts.get(event.service) ?? empty();
      count.pending++;
      this.counts.set(event.service, count);
    } else {
      if (this.active.get(event.id) !== event.service) return false;
      this.active.delete(event.id);
      const count = this.counts.get(event.service)!;
      count.pending--;
      count[event.phase]++;
    }
    return true;
  }
  interrupt(): boolean {
    let changed = false;
    for (const count of this.counts.values()) {
      if (count.pending) { count.failure += count.pending; count.pending = 0; changed = true; }
    }
    this.active.clear();
    return changed;
  }
  snapshot() { return { session: this.session, scope: this.scope, counts: Object.fromEntries([...this.counts].map(([name, count]) => [name, { ...count }])) }; }
  total(): number { return [...this.counts.values()].reduce((total, c) => total + c.success + c.failure + c.pending, 0); }
}

/** Render each service as one horizontal cell; wrap whole cells before truncating. */
export function callCountLines(width: number, theme: Pick<Theme, 'fg'>, header: string, names: readonly string[], counts: ReadonlyMap<string, Counts>, disconnected: ReadonlySet<string>): string[] {
  if (width < 1) return [];
  const lines = wrapTextWithAnsi(header, width);
  let row = '';
  for (const name of [...new Set([...names, ...counts.keys()])]) {
    const c = counts.get(name) ?? empty();
    const historic = !names.includes(name) ? ' (previous)' : '';
    const cell = `${theme.fg('muted', name + historic)} ${theme.fg(c.success ? 'success' : 'muted', `✓${c.success}`)} ${theme.fg(c.failure ? 'error' : 'muted', `✗${c.failure}`)}${c.pending ? ` ${theme.fg('warning', `…${c.pending}`)}` : ''}${disconnected.has(name) ? theme.fg('warning', ' !') : ''}`;
    const separator = theme.fg('muted', '  │  ');
    if (row && visibleWidth(row + separator + cell) > width) { lines.push(row); row = ''; }
    if (visibleWidth(cell) > width) {
      if (row) { lines.push(row); row = ''; }
      lines.push(...wrapTextWithAnsi(cell, width).map((line) => truncateToWidth(line, width)));
    } else row = row ? row + separator + cell : cell;
  }
  if (row) lines.push(row);
  return lines;
}
