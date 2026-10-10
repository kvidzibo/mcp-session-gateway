import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ResourceListChangedNotificationSchema, ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { z } from 'zod';
import { clean } from './settings.js';

export const JOBS_MIME = 'application/vnd.pi-delegate.jobs+json';
const activity = z.object({ name: z.string().max(80), args: z.string().max(240).optional() });
const timestamp = z.number().finite().nonnegative();
const boardSchema = z.object({
  schemaVersion: z.literal(1), instanceId: z.string().max(128),
  jobs: z.array(z.object({
    jobId: z.string().max(128), kind: z.string().max(32), model: z.string().max(256),
    reasoning: z.string().max(32).optional(), task: z.string().max(240),
    status: z.enum(['queued', 'running', 'done', 'failed']),
    queuedAt: timestamp.optional(), startedAt: timestamp.optional(), finishedAt: timestamp.optional(), durationMs: timestamp.optional(),
    queueReason: z.string().max(80).optional(), cancellationRequested: z.boolean().optional(), wrapped: z.boolean().optional(),
    phase: z.string().max(80).optional(), stopReason: z.string().max(80).optional(),
    current: activity.optional(), activity: z.array(activity).max(3),
  })).max(256),
});
type Board = z.infer<typeof boardSchema>;
type Job = Board['jobs'][number];
type Source = { uri: string; present: boolean; board?: Board; error?: string; busy: boolean; dirty: boolean; timer?: ReturnType<typeof setTimeout>; frozenAt?: number };
const active = (job: Job) => job.status === 'queued' || job.status === 'running';
const singleLine = (text: string) => clean(text).replace(/\s+/g, ' ').trim();
const duration = (ms: number) => {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

/** UI-only consumer on the adapter's existing connection; never calls Pi tools or sends messages. */
export class LiveJobs {
  private readonly sources = new Map<string, Source>();
  private readonly lifetime = new AbortController();
  private discovering = false;
  private discoverAgain = false;
  private stopped = false;
  private disconnected = false;
  private mounted = false;
  private uiFailed = false;
  private repaint?: () => void;
  private clock?: ReturnType<typeof setInterval>;

  constructor(private readonly client: Client, private readonly ctx: ExtensionContext, private readonly timeout: number) {}

  async start(): Promise<void> {
    this.client.setNotificationHandler(ResourceUpdatedNotificationSchema, notification => {
      const source = this.sources.get(notification.params.uri);
      if (source) this.schedule(source);
    });
    this.client.setNotificationHandler(ResourceListChangedNotificationSchema, () => { void this.discover(); });
    await this.discover();
  }

  private options() {
    // Gateway progress accounts for per-service queue time and multi-page discovery.
    // A UI refresh must not cancel healthy workers merely because the aggregate is slow.
    return { signal: this.lifetime.signal, timeout: this.timeout, resetTimeoutOnProgress: true, onprogress: () => {} };
  }

  private async discover(): Promise<void> {
    if (this.stopped || this.disconnected) return;
    if (this.discovering) { this.discoverAgain = true; return; }
    this.discovering = true;
    try {
      do {
        this.discoverAgain = false;
        const result = await this.client.listResources(undefined, this.options());
        if (this.stopped || this.disconnected) return;
        const uris = new Set(result.resources.filter(resource => resource.mimeType === JOBS_MIME).map(resource => resource.uri));
        for (const [uri, source] of this.sources) {
          if (uris.has(uri)) continue;
          // Never label a lost worker as finished or advance its last-known clock.
          source.present = false;
          source.dirty = false;
          source.error = 'Service disconnected or resource removed';
          source.frozenAt ??= Date.now();
          if (source.timer) clearTimeout(source.timer);
          source.timer = undefined;
        }
        for (const uri of [...uris].slice(0, 32)) {
          const existing = this.sources.get(uri);
          if (existing && !existing.error) continue;
          if (!existing && this.sources.size >= 32) continue;
          const source: Source = existing ?? { uri, present: true, busy: false, dirty: false };
          source.present = true;
          this.sources.set(uri, source);
          try {
            // Subscribe before reading so changes during the initial read cannot be lost.
            await this.client.subscribeResource({ uri }, this.options());
            this.schedule(source);
          } catch { source.error = 'Live subscription unavailable'; source.frozenAt ??= Date.now(); }
        }
        this.paint();
      } while (this.discoverAgain && !this.stopped);
    } catch {
      for (const source of this.sources.values()) { source.error = 'Resource discovery unavailable'; source.frozenAt ??= Date.now(); }
      this.paint();
    } finally {
      this.discovering = false;
      if (this.discoverAgain && !this.stopped && !this.disconnected) void this.discover();
    }
  }

  private schedule(source: Source): void {
    if (this.stopped || this.disconnected || !source.present) return;
    source.dirty = true;
    if (source.busy || source.timer) return;
    source.timer = setTimeout(() => { source.timer = undefined; void this.read(source); }, 100);
    source.timer.unref();
  }

  private async read(source: Source): Promise<void> {
    if (this.stopped || this.disconnected) return;
    source.busy = true;
    source.dirty = false;
    try {
      const result = await this.client.readResource({ uri: source.uri }, this.options());
      if (this.stopped || this.disconnected || !source.present) return;
      const content = result.contents.find(item => item.uri === source.uri && item.mimeType === JOBS_MIME && 'text' in item);
      if (!content || !('text' in content) || content.text.length > 1_000_000) throw new Error('Invalid job resource');
      source.board = boardSchema.parse(JSON.parse(content.text));
      source.error = undefined;
      source.frozenAt = undefined;
    } catch {
      if (!this.stopped && !this.disconnected && source.present) { source.error = 'Job status unavailable'; source.frozenAt ??= Date.now(); }
    } finally {
      source.busy = false;
      this.paint();
      if (source.dirty) this.schedule(source);
    }
  }

  private entries(now: number): { source: Source; job?: Job }[] {
    return [...this.sources.values()].flatMap<{ source: Source; job?: Job }>(source => {
      const jobs = source.board?.jobs.filter(job => active(job) || now - (job.finishedAt ?? 0) < 8000) ?? [];
      return jobs.length ? jobs.map(job => ({ source, job })) : source.error ? [{ source }] : [];
    }).sort((a, b) => Number(Boolean(b.job && active(b.job))) - Number(Boolean(a.job && active(a.job))));
  }

  private paint(): void {
    if (this.stopped || this.uiFailed) return;
    try { this.paintWidget(); }
    catch {
      this.uiFailed = true;
      if (this.clock) clearInterval(this.clock);
      this.clock = undefined;
      this.repaint = undefined;
      // A broken/dead UI cannot escape into a timer or connection ownership.
    }
  }

  private paintWidget(): void {
    const entries = this.entries(Date.now());
    if (!this.mounted && entries.length) {
      this.ctx.ui.setWidget('gateway-live-jobs', (tui, theme) => {
        this.repaint = () => tui.requestRender();
        return {
          render: width => {
            try { return this.render(width, Math.max(0, Math.min(12, Math.floor(tui.terminal.rows / 2))), theme); }
            catch { return []; }
          },
          invalidate() {},
        };
      }, { placement: 'aboveEditor' });
      this.mounted = true;
    }
    this.repaint?.();
    if (entries.length && !this.disconnected && !this.clock) {
      this.clock = setInterval(() => this.paint(), 1000);
      this.clock.unref();
    } else if ((!entries.length || this.disconnected) && this.clock) {
      clearInterval(this.clock); this.clock = undefined;
    }
  }

  render(width: number, maxRows: number, theme: Pick<Theme, 'fg' | 'bg' | 'bold'>, now = Date.now()): string[] {
    if (width < 1 || maxRows < 1) return [];
    const entries = this.entries(now);
    if (!entries.length) return [];
    const lines: string[] = [];
    const row = (text: string, color: Parameters<Theme['fg']>[0] = 'muted') => {
      const fitted = truncateToWidth(text, width);
      return theme.bg('toolPendingBg', theme.fg(color, fitted + ' '.repeat(Math.max(0, width - visibleWidth(fitted)))));
    };
    lines.push(row('Delegate · live via MCP', 'accent'));
    const capacity = Math.max(0, Math.floor((maxRows - 2) / 3));
    for (const { source, job } of entries.slice(0, capacity)) {
      if (!job) { lines.push(row(source.error ?? 'Unavailable', 'warning'), row(singleLine(source.uri)), row('')); continue; }
      const status = source.error ? `stale · ${source.error}` : job.cancellationRequested ? 'cancelling' : job.status === 'done'
        ? 'finished · unverified' : job.stopReason === 'aborted' ? 'cancelled' : job.status;
      const elapsed = job.durationMs ?? Math.max(0, (source.frozenAt ?? now) - (job.startedAt ?? job.queuedAt ?? now));
      lines.push(row(`${singleLine(job.kind)} · ${status} · ${duration(elapsed)} · ${singleLine(job.model)}${job.reasoning ? ` · ${singleLine(job.reasoning)}` : ''}`, job.status === 'failed' && job.stopReason !== 'aborted' ? 'error' : source.error ? 'warning' : 'accent'));
      lines.push(row(singleLine(job.task), 'text'));
      const tool = job.current ?? job.activity.at(-1);
      const activity = source.error ? 'Last known state; worker outcome unknown' : job.status === 'queued' ? `Waiting: ${job.queueReason ?? 'slot'}`
        : !active(job) ? 'Worker stopped; collect the result to inspect it' : job.phase === 'thinking' ? 'Thinking'
        : tool ? `${tool.name}${tool.args ? ` ${tool.args}` : ''}` : 'Working';
      lines.push(row(`${singleLine(job.jobId).slice(0, 8)} · ${singleLine(activity)}${job.wrapped && active(job) ? ' · wrap requested' : ''}`));
    }
    if (entries.length > capacity) lines.push(row(`${entries.length - capacity} more · /gateway-panel for full job data`));
    return lines.slice(0, maxRows);
  }

  disconnect(): void {
    this.disconnected = true;
    for (const source of this.sources.values()) {
      source.error = 'Gateway disconnected'; source.frozenAt ??= Date.now();
      if (source.timer) clearTimeout(source.timer);
    }
    this.paint();
  }

  stop(): void {
    this.stopped = true;
    this.lifetime.abort();
    if (this.clock) clearInterval(this.clock);
    for (const source of this.sources.values()) if (source.timer) clearTimeout(source.timer);
    this.client.removeNotificationHandler('notifications/resources/updated');
    this.client.removeNotificationHandler('notifications/resources/list_changed');
    this.sources.clear();
    try { if (this.mounted || this.uiFailed) this.ctx.ui.setWidget('gateway-live-jobs', undefined); }
    catch { /* Connection teardown must continue even when its UI is already gone. */ }
  }
}
