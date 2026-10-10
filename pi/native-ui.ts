import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, SelectList, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { inputSettings } from './settings.js';
import { ActionResultSchema, clean, editorText, ContextSchema, footerText, UI_CONTEXT, UI_MIME, ViewSchema, type NativeControl, type NativeView } from '../src/native-ui.js';

type Entry = { scope: string; service: string; state: Record<string, unknown> };
const entryType = 'gateway-native-ui-v1';
const serviceOf = (uri: string) => new URL(uri).hostname;
const oneLine = (text: string) => clean(text).replace(/\n/g, ' ');

/** Generic host: only protocol primitives, no service-specific screens or actions. */
export class NativeUI {
  private ctx?: ExtensionContext;
  private scope = '';
  private epoch = 0;
  private states = new Map<string, Record<string, unknown>>();
  private resources = new Map<string, string>();
  private views = new Map<string, NativeView>();
  private pending = new Map<string, Promise<void>>();
  private dirty = new Set<string>();
  private ephemeralId = randomUUID();
  private changed = () => {};

  constructor(private pi: ExtensionAPI, private client: () => Client, private options: () => { signal: AbortSignal; timeout: number }) {}

  async start(ctx: ExtensionContext, scope: string): Promise<void> {
    this.stop();
    this.ctx = ctx; this.scope = scope; this.states.clear();
    for (const entry of ctx.sessionManager?.getBranch() ?? []) {
      if (entry.type !== 'custom' || entry.customType !== entryType) continue;
      const data = entry.data as Entry;
      if (data?.scope === scope && typeof data.service === 'string' && data.state && typeof data.state === 'object') this.states.set(data.service, data.state);
    }
    const epoch = this.epoch;
    const result = await this.client().listResources(undefined, this.options());
    if (epoch !== this.epoch) return;
    for (const resource of result.resources) {
      if (resource.mimeType !== UI_MIME) continue;
      const service = serviceOf(resource.uri);
      if (this.resources.has(service)) throw new Error(`Native UI v1 permits one root per service: ${service}`);
      this.resources.set(service, resource.uri);
    }
    await Promise.all([...this.resources.values()].map((uri) => this.refresh(uri)));
  }

  stop(): void {
    this.epoch++;
    for (const service of this.resources.keys()) this.ctx?.ui.setStatus(`gateway-ui:${service}`, undefined);
    this.resources.clear(); this.views.clear(); this.pending.clear(); this.dirty.clear(); this.changed();
  }

  invalidate(service: string): void {
    const uri = this.resources.get(service);
    if (uri) { this.resources.delete(service); this.views.delete(uri); this.dirty.delete(uri); }
    this.ctx?.ui.setStatus(`gateway-ui:${service}`, undefined);
    this.changed();
  }

  meta(service: string): Record<string, unknown> {
    return { [UI_CONTEXT]: ContextSchema.parse({
      conversationId: this.ctx?.sessionManager?.getSessionId() ?? this.ephemeralId,
      state: this.states.get(service) ?? {},
    }) };
  }

  private apply(uri: string, view: NativeView): void {
    const service = serviceOf(uri);
    if (JSON.stringify(this.states.get(service)) !== JSON.stringify(view.state)) {
      this.states.set(service, view.state);
      this.pi.appendEntry(entryType, { scope: this.scope, service, state: view.state });
    }
    this.views.set(uri, view);
    if (this.ctx?.mode === 'tui') this.ctx.ui.setStatus(`gateway-ui:${service}`, footerText(view, truncateToWidth));
    this.changed();
  }

  async refresh(uri: string): Promise<void> {
    if (![...this.resources.values()].includes(uri)) return;
    // A notification can arrive after the pending read took its snapshot.
    this.dirty.add(uri);
    const existing = this.pending.get(uri);
    if (existing) return existing;
    const epoch = this.epoch;
    const work = (async () => {
      do {
        this.dirty.delete(uri);
        try {
          const result = await this.client().readResource({ uri, _meta: this.meta(serviceOf(uri)) }, this.options());
          if (epoch !== this.epoch || this.resources.get(serviceOf(uri)) !== uri) return;
          const content = result.contents.find((item) => item.mimeType === UI_MIME && 'text' in item);
          if (!content || !('text' in content) || content.text.length > 256_000) throw new Error('Invalid or oversized native UI resource');
          this.apply(uri, ViewSchema.parse(JSON.parse(content.text)));
        } catch (error) {
          if (epoch === this.epoch && this.resources.get(serviceOf(uri)) === uri) {
            this.views.delete(uri);
            this.ctx?.ui.setStatus(`gateway-ui:${serviceOf(uri)}`, undefined);
            this.ctx?.ui.notify(clean(String(error)), 'error');
            this.changed();
          }
        }
      } while (epoch === this.epoch && this.resources.get(serviceOf(uri)) === uri && this.dirty.has(uri));
    })();
    this.pending.set(uri, work);
    try { await work; } finally { if (this.pending.get(uri) === work) this.pending.delete(uri); }
  }

  async refreshService(service: string): Promise<void> {
    const uri = this.resources.get(service);
    if (uri) await this.refresh(uri);
  }

  private async preview(text: string, ctx: ExtensionContext): Promise<void> {
    await ctx.ui.custom<void>((tui, theme, _keys, done) => {
      let offset = 0, max = 0;
      const changed = () => done();
      this.changed = changed;
      return {
        render(width: number) {
          const w = Math.max(1, width), height = Math.max(1, tui.terminal.rows - 6);
          const lines = clean(text).split('\n').flatMap((line) => wrapTextWithAnsi(line, w));
          max = Math.max(0, lines.length - height); offset = Math.min(offset, max);
          return [...lines.slice(offset, offset + height), theme.fg('muted', 'Display only · ↑/↓ scroll · Esc close')].map((line) => truncateToWidth(line, w));
        },
        handleInput(data: string) {
          if (matchesKey(data, Key.escape)) done();
          else if (matchesKey(data, Key.up)) offset = Math.max(0, offset - 1);
          else if (matchesKey(data, Key.down)) offset = Math.min(max, offset + 1);
          tui.requestRender();
        },
        invalidate() {},
        dispose: () => { if (this.changed === changed) this.changed = () => {}; },
      };
    }, { overlay: true, overlayOptions: { width: '100%', anchor: 'center', margin: 1 } });
  }

  async open(service: string, ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== 'tui') throw new Error('Native UI requires TUI mode');
    const epoch = this.epoch;
    if (!service) service = await ctx.ui.select('Gateway apps', [...this.resources.keys()], this.options()) ?? '';
    const uri = this.resources.get(service);
    if (!uri) return;
    await this.refresh(uri);
    while (epoch === this.epoch) {
      const view = this.views.get(uri);
      if (!view) return;
      const picked = await ctx.ui.custom<NativeControl | 'refresh' | undefined>((tui, theme, _keys, done) => {
        let list: SelectList | undefined;
        let visibleRows = 0;
        const makeList = (rows: number) => {
          const selected = view.controls.findIndex((control) => control.id === list?.getSelectedItem()?.value);
          list = new SelectList(view.controls.map((control) => ({
          value: control.id,
          label: `${control.icon ? `${oneLine(control.icon)} ` : ''}${oneLine(control.label)}${control.kind !== 'action' ? `: ${oneLine(String(control.value ?? ''))}` : ''}`,
          description: oneLine(control.description ?? ''),
        })), rows, {
          selectedPrefix: (s) => theme.fg('accent', s), selectedText: (s) => theme.fg('accent', s),
          description: (s) => theme.fg('muted', s), scrollInfo: (s) => theme.fg('dim', s), noMatch: (s) => theme.fg('warning', s),
        }, { minPrimaryColumnWidth: 20, maxPrimaryColumnWidth: 80,
          truncatePrimary: ({ text, maxWidth }) => truncateToWidth(text, maxWidth),
        });
        list.onSelect = (item) => done(view.controls.find((c) => c.id === item.value));
          list.onCancel = () => done(undefined);
          list.setSelectedIndex(Math.max(0, selected));
          visibleRows = rows;
        };
        const changed = () => done('refresh');
        this.changed = changed;
        return {
          render(width: number) {
            const w = Math.max(1, width);
            const body = clean(view.body ?? '').split('\n').flatMap((line) => wrapTextWithAnsi(line, w)).slice(0, Math.max(0, Math.min(6, tui.terminal.rows - 18)));
            if (tui.terminal.rows < 8) return [truncateToWidth('Enlarge terminal · Esc close', w)];
            const rows = Math.max(1, Math.min(12, tui.terminal.rows - body.length - 8));
            if (!list || rows !== visibleRows) makeList(rows);
            return [theme.fg('accent', oneLine(view.title)), ...body, '', ...list!.render(w), '', theme.fg('muted', '↑/↓ select · Enter open/edit · Ctrl+R refresh · Esc close')].map((line) => truncateToWidth(line, w));
          },
          handleInput(data: string) {
            if (matchesKey(data, Key.escape)) done(undefined);
            else if (matchesKey(data, Key.ctrl('r'))) done('refresh');
            else if (tui.terminal.rows >= 8) list?.handleInput(data);
            tui.requestRender();
          },
          invalidate() { list?.invalidate(); },
          dispose: () => { if (this.changed === changed) this.changed = () => {}; },
        };
      }, { overlay: true, overlayOptions: { width: '100%', anchor: 'center', margin: 1 } });
      if (epoch !== this.epoch || !picked) return;
      if (picked === 'refresh') { await this.refresh(uri); continue; }
      const valid = () => epoch === this.epoch && this.resources.get(service) === uri && this.views.get(uri)?.revision === view.revision;
      let value = picked.value;
      const title = oneLine(picked.label);
      if (picked.kind === 'text' || picked.kind === 'number') {
        // Pi's multiline editor trims and expands tabs. JSON input preserves
        // exact strings while making whitespace and terminal controls explicit.
        const encoded = JSON.stringify(value ?? (picked.kind === 'number' ? 0 : '')).replace(/[^\x20-\x7e]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
        const entered = await inputSettings(ctx, title, encoded, this.options());
        if (entered === undefined) continue;
        try { value = JSON.parse(entered); }
        catch { ctx.ui.notify('Enter a JSON value (quote strings)', 'error'); continue; }
        if (picked.kind === 'number' ? typeof value !== 'number' || !Number.isFinite(value) : typeof value !== 'string') {
          ctx.ui.notify('Enter a JSON string or finite number matching this field', 'error'); continue;
        }
      } else if (picked.kind === 'toggle') value = !value;
      else if (picked.kind === 'select') {
        const options = picked.options ?? [];
        const labels = options.map((o, i) => `${i + 1}. ${oneLine(o.label)}`);
        const choice = await ctx.ui.select(title, labels, this.options());
        if (!choice) continue;
        value = options[labels.indexOf(choice)].value;
      }
      if (epoch !== this.epoch) return;
      if (picked.confirm && !await ctx.ui.confirm(title, clean(picked.confirm + (picked.kind === 'action' ? '' : `\n${String(value)}`)), this.options())) continue;
      if (epoch !== this.epoch) return;
      try {
        // Drain in-flight notification reads before acting; never replay a failed write.
        await this.pending.get(uri);
        if (epoch !== this.epoch) return;
        if (!valid()) { ctx.ui.notify('View changed or disconnected; refresh before acting', 'warning'); continue; }
        if (typeof value === 'string') editorText(value);
        const result = await this.client().request({ method: 'native-ui/action', params: {
          uri, action: picked.id, revision: view.revision, ...(value === undefined ? {} : { value }), _meta: this.meta(service),
        } }, ActionResultSchema, this.options());
        if (epoch !== this.epoch) return;
        await this.pending.get(uri);
        if (epoch !== this.epoch || this.resources.get(service) !== uri) return;
        this.apply(uri, result.view);
        // Notification reads may be newer than the action snapshot, but used
        // its previous selection. Reread with the returned state before display.
        await this.refresh(uri);
        if (epoch !== this.epoch || !this.views.has(uri)) return;
        if (result.preview) await this.preview(result.preview, ctx);
        if (result.draft && await ctx.ui.confirm('Insert draft?', clean(result.draft), this.options()) && epoch === this.epoch) {
          if (ctx.ui.getEditorText().trim()) ctx.ui.notify('Draft preserved; clear the editor before inserting a server draft', 'warning');
          else ctx.ui.setEditorText(editorText(result.draft));
        }
      } catch (error) {
        if (epoch !== this.epoch) return;
        ctx.ui.notify(`${clean(String(error))}\nThe action may have committed. Refresh before retrying.`, 'error');
        await this.refresh(uri);
      }
    }
  }
}
