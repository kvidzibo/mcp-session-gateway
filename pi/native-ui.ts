import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { FooterActions } from './footer-actions.js';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, SelectList, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { inputSettings } from './settings.js';
import { ActionResultSchema, clean, editorText, ContextSchema, StateSchema, footerText, UI_CONTEXT, UI_STATE, UI_MIME, ViewSchema, type NativeControl, type NativeView } from '../src/native-ui.js';

type Entry = { scope: string; service: string; state: Record<string, unknown>; contextId?: string; retainOnNew?: boolean };
const transferKey = Symbol.for('gateway.native-ui.new-session');
const transfers = ((globalThis as any)[transferKey] ??= new Map<string, Entry[]>()) as Map<string, Entry[]>;
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
  private contexts = new Map<string, string>();
  private retained = new Set<string>();
  private operations = new Map<string, Promise<unknown>>();
  private blocked = new Set<string>();
  private bridge?: FooterActions;
  private changed = () => {};

  constructor(private pi: ExtensionAPI, private client: () => Client, private options: () => { signal: AbortSignal; timeout: number }, private interact: (run: () => Promise<boolean>) => Promise<boolean> = (run) => run()) {}

  transfer(target?: string): void {
    if (!target) return;
    if (transfers.size >= 32) transfers.delete(transfers.keys().next().value!);
    transfers.set(target, [...this.retained].map((service) => this.entry(service)));
  }

  private entry(service: string): Entry {
    return { scope: this.scope, service, state: this.states.get(service) ?? {}, contextId: this.contexts.get(service), retainOnNew: this.retained.has(service) };
  }

  private save(service: string): void { this.pi.appendEntry(entryType, this.entry(service)); }

  private async serial<T>(service: string, run: () => Promise<T>): Promise<T> {
    const epoch = this.epoch;
    const work = (this.operations.get(service) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (epoch !== this.epoch) throw new Error('Gateway context changed');
      this.blocked.add(service);
      try { await this.pending.get(this.resources.get(service) ?? ''); return await run(); }
      finally { if (epoch === this.epoch) this.blocked.delete(service); }
    });
    this.operations.set(service, work);
    try { return await work; }
    finally { if (this.operations.get(service) === work) this.operations.delete(service); }
  }

  async callTool(service: string, run: (meta: Record<string, unknown>) => Promise<CallToolResult>): Promise<CallToolResult> {
    const epoch = this.epoch;
    return this.serial(service, async () => {
      const result = await run(this.meta(service));
      if (epoch !== this.epoch) throw new Error('Gateway context changed during tool call');
      if (!result.isError && result._meta && UI_STATE in result._meta) {
        if (!this.resources.has(service)) throw new Error('Tool state requires an advertised native UI');
        this.states.set(service, StateSchema.parse(result._meta[UI_STATE]));
        this.save(service);
      }
      return result;
    }).finally(async () => { if (epoch === this.epoch) await this.refreshService(service); });
  }

  private observationOptions() {
    // Listing aggregates services; reads can queue behind tools. Gateway progress
    // excludes that waiting from observer deadlines without extending child RPCs.
    return { ...this.options(), resetTimeoutOnProgress: true, onprogress: () => {} };
  }

  async start(ctx: ExtensionContext, scope: string, reason?: string): Promise<void> {
    await this.stop();
    this.ctx = ctx; this.scope = scope; this.states.clear(); this.contexts.clear(); this.retained.clear();
    for (const entry of ctx.sessionManager?.getBranch() ?? []) {
      if (entry.type !== 'custom' || entry.customType !== entryType) continue;
      const data = entry.data as Entry;
      if (data?.scope === scope && typeof data.service === 'string' && StateSchema.safeParse(data.state).success) {
        this.states.set(data.service, data.state);
        if (typeof data.contextId === 'string') this.contexts.set(data.service, data.contextId);
        if (data.retainOnNew) this.retained.add(data.service); else this.retained.delete(data.service);
      }
    }
    const file = ctx.sessionManager?.getSessionFile?.();
    const carried = file ? transfers.get(file) : undefined;
    if (file) transfers.delete(file);
    if (reason === 'new') for (const data of carried ?? []) {
      if (data.scope !== scope) continue;
      this.states.set(data.service, data.state);
      if (data.contextId) this.contexts.set(data.service, data.contextId);
      this.retained.add(data.service); this.save(data.service);
    }
    const epoch = this.epoch;
    if (ctx.mode === 'tui') {
      const bridge = new FooterActions(); this.bridge = bridge;
      try { await bridge.start(); }
      catch { await bridge.stop(); if (this.bridge === bridge) this.bridge = undefined; ctx.ui.notify('Footer clicks unavailable; use /gateway → Services → Open app', 'warning'); }
    }
    if (epoch !== this.epoch) return;
    const result = await this.client().listResources(undefined, this.observationOptions());
    if (epoch !== this.epoch) return;
    for (const resource of result.resources) {
      if (resource.mimeType !== UI_MIME) continue;
      const service = serviceOf(resource.uri);
      if (this.resources.has(service)) throw new Error(`Native UI v1 permits one root per service: ${service}`);
      this.resources.set(service, resource.uri);
    }
    await Promise.all([...this.resources.values()].map((uri) => this.refresh(uri)));
  }

  stop(): Promise<void> {
    this.epoch++;
    const bridge = this.bridge; this.bridge = undefined;
    for (const service of this.resources.keys()) this.ctx?.ui.setStatus(`gateway-ui:${service}`, undefined);
    this.resources.clear(); this.views.clear(); this.pending.clear(); this.dirty.clear(); this.operations.clear(); this.blocked.clear(); this.changed();
    return bridge?.stop() ?? Promise.resolve();
  }

  invalidate(service: string): void {
    const uri = this.resources.get(service);
    if (uri) { this.resources.delete(service); this.views.delete(uri); this.dirty.delete(uri); }
    this.bridge?.clear(service);
    this.ctx?.ui.setStatus(`gateway-ui:${service}`, undefined);
    this.changed();
  }

  // An advertised app can be reopened after a transient view-read failure.
  has(service: string): boolean { return this.resources.has(service); }

  meta(service: string): Record<string, unknown> {
    if (!this.contexts.has(service)) this.contexts.set(service, randomUUID());
    return { [UI_CONTEXT]: ContextSchema.parse({
      conversationId: this.ctx?.sessionManager?.getSessionId() ?? this.ephemeralId,
      contextId: this.contexts.get(service),
      state: this.states.get(service) ?? {},
    }) };
  }

  private apply(uri: string, view: NativeView): void {
    const service = serviceOf(uri);
    const changed = JSON.stringify(this.states.get(service)) !== JSON.stringify(view.state) || this.retained.has(service) !== Boolean(view.retainOnNew);
    this.states.set(service, view.state);
    if (view.retainOnNew) this.retained.add(service); else this.retained.delete(service);
    if (changed) this.save(service);
    this.views.set(uri, view);
    this.renderFooter(uri, view);
    this.changed();
  }

  private renderFooter(uri: string, view: NativeView): void {
    const ctx = this.ctx, service = serviceOf(uri), epoch = this.epoch;
    this.bridge?.clear(service);
    if (ctx?.mode !== 'tui') return;
    ctx.ui.setStatus(`gateway-ui:${service}`, footerText(view, truncateToWidth, (action) => this.bridge?.link(service, () => this.interact(async () => {
      if (epoch !== this.epoch || this.views.get(uri)?.revision !== view.revision) return false;
      try {
        const control = view.controls.find((c) => c.id === action && c.kind === 'action');
        if (!control) return false;
        if (control.confirm && !await ctx.ui.confirm(oneLine(control.label), clean(control.confirm), { signal: this.options().signal })) return false;
        return await this.dispatch(uri, view, control, undefined, ctx, epoch);
      } finally { if (epoch === this.epoch && this.views.get(uri)) this.renderFooter(uri, this.views.get(uri)!); }
    }))));
  }

  async refresh(uri: string): Promise<void> {
    if (![...this.resources.values()].includes(uri)) return;
    if (this.blocked.has(serviceOf(uri))) { this.dirty.add(uri); return; }
    // A notification can arrive after the pending read took its snapshot.
    this.dirty.add(uri);
    const existing = this.pending.get(uri);
    if (existing) return existing;
    const epoch = this.epoch;
    const work = (async () => {
      do {
        this.dirty.delete(uri);
        try {
          const result = await this.client().readResource({ uri, _meta: this.meta(serviceOf(uri)) }, this.observationOptions());
          if (epoch !== this.epoch || this.resources.get(serviceOf(uri)) !== uri) return;
          const content = result.contents.find((item) => item.mimeType === UI_MIME && 'text' in item);
          if (!content || !('text' in content) || content.text.length > 256_000) throw new Error('Invalid or oversized native UI resource');
          this.apply(uri, ViewSchema.parse(JSON.parse(content.text)));
        } catch (error) {
          if (epoch === this.epoch && this.resources.get(serviceOf(uri)) === uri) {
            this.views.delete(uri);
            this.bridge?.clear(serviceOf(uri));
            this.ctx?.ui.setStatus(`gateway-ui:${serviceOf(uri)}`, undefined);
            this.ctx?.ui.notify(clean(String(error)), 'error');
            this.changed();
          }
        }
      } while (epoch === this.epoch && !this.blocked.has(serviceOf(uri)) && this.resources.get(serviceOf(uri)) === uri && this.dirty.has(uri));
    })();
    this.pending.set(uri, work);
    try { await work; } finally { if (this.pending.get(uri) === work) this.pending.delete(uri); }
  }

  async refreshService(service: string): Promise<void> {
    const uri = this.resources.get(service);
    if (uri) await this.refresh(uri);
  }

  private async dispatch(uri: string, view: NativeView, picked: NativeControl, value: NativeControl['value'], ctx: ExtensionContext, epoch: number): Promise<boolean> {
    const service = serviceOf(uri);
    try {
      const result = await this.serial(service, async () => {
        if (epoch !== this.epoch || this.resources.get(service) !== uri || this.views.get(uri)?.revision !== view.revision) throw new Error('View changed or disconnected; refresh before acting');
        if (typeof value === 'string') editorText(value);
        const result = await this.client().request({ method: 'native-ui/action', params: {
          uri, action: picked.id, revision: view.revision, ...(value === undefined ? {} : { value }), _meta: this.meta(service),
        } }, ActionResultSchema, this.options());
        if (epoch !== this.epoch || this.resources.get(service) !== uri) throw new Error('Gateway context changed during action');
        this.apply(uri, result.view);
        return result;
      });
      await this.refresh(uri);
      if (epoch !== this.epoch || !this.views.has(uri)) return false;
      if (result.preview) this.pi.appendEntry('gateway-native-preview', { title: oneLine(view.title), text: clean(result.preview) });
      if (result.draft && await ctx.ui.confirm('Insert draft?', clean(result.draft), { signal: this.options().signal }) && epoch === this.epoch) {
        if (ctx.ui.getEditorText().trim()) ctx.ui.notify('Draft preserved; clear the editor before inserting a server draft', 'warning');
        else ctx.ui.setEditorText(editorText(result.draft));
      }
      return true;
    } catch (error) {
      if (epoch === this.epoch) {
        ctx.ui.notify(`${clean(String(error))}\nThe action may have committed. Refresh before retrying.`, 'error');
        await this.refresh(uri);
      }
      return false;
    }
  }

  async open(service: string, ctx: ExtensionContext): Promise<void> {
    // Human interaction has no RPC deadline; shutdown still cancels dialogs.
    const dialogOptions = { signal: this.options().signal };
    if (ctx.mode !== 'tui') throw new Error('Native UI requires TUI mode');
    const epoch = this.epoch;
    if (!service) service = await ctx.ui.select('Gateway apps', [...this.resources.keys()], dialogOptions) ?? '';
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
      let value = picked.value;
      const title = oneLine(picked.label);
      if (picked.kind === 'text' || picked.kind === 'number') {
        // Pi's multiline editor trims and expands tabs. JSON input preserves
        // exact strings while making whitespace and terminal controls explicit.
        const encoded = JSON.stringify(value ?? (picked.kind === 'number' ? 0 : '')).replace(/[^\x20-\x7e]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
        const entered = await inputSettings(ctx, title, encoded, dialogOptions);
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
        const choice = await ctx.ui.select(title, labels, dialogOptions);
        if (!choice) continue;
        value = options[labels.indexOf(choice)].value;
      }
      if (epoch !== this.epoch) return;
      if (picked.confirm && !await ctx.ui.confirm(title, clean(picked.confirm + (picked.kind === 'action' ? '' : `\n${String(value)}`)), dialogOptions)) continue;
      if (epoch !== this.epoch) return;
      await this.dispatch(uri, view, picked, value, ctx, epoch);
    }
  }
}
