import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { FooterActions } from './footer-actions.js';
import { NativeFooter } from './native-footer.js';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key, truncateToWidth } from '@earendil-works/pi-tui';
import { GatewayMenu } from './menu.js';
import { confirmSettings, inputSettings } from './settings.js';
import { ActionResultSchema, clean, literal, editorText, ContextSchema, StateSchema, footerText, UI_CONTEXT, UI_STATE, UI_FEATURES, UI_STALE_ACTION, StaleActionDataSchema, ActionRevisionFeaturesSchema, FooterSecondaryFeaturesSchema, FooterStylesFeaturesSchema, FooterDoubleFeaturesSchema, FooterNativeFeaturesSchema, UI_MIME, ViewSchema, type NativeControl, type NativeView } from '../src/native-ui.js';

type Interaction = (showDialog: () => void) => Promise<boolean>;
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
  private savedContexts = new Set<string>();
  private retained = new Set<string>();
  private operations = new Map<string, Promise<unknown>>();
  private blocked = new Set<string>();
  private bridge?: FooterActions;
  private changed = () => {};
  private fullscreen = false;
  private repaint = () => {};

  constructor(private pi: ExtensionAPI, private client: () => Client, private options: () => { signal: AbortSignal; timeout: number }, private interact: (run: Interaction) => Promise<boolean> = (run) => run(() => {})) {}

  current(): () => boolean {
    const epoch = this.epoch;
    return () => epoch === this.epoch;
  }

  transfer(target?: string): void {
    if (!target) return;
    if (transfers.size >= 32) transfers.delete(transfers.keys().next().value!);
    transfers.set(target, [...this.retained].map((service) => this.entry(service)));
  }

  private entry(service: string): Entry {
    return { scope: this.scope, service, state: this.states.get(service) ?? {}, contextId: this.contexts.get(service), retainOnNew: this.retained.has(service) };
  }

  private save(service: string): void { this.pi.appendEntry(entryType, this.entry(service)); this.savedContexts.add(service); }

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
    this.ctx = ctx; this.scope = scope; this.states.clear(); this.contexts.clear(); this.savedContexts.clear(); this.retained.clear();
    for (const entry of ctx.sessionManager?.getBranch() ?? []) {
      if (entry.type !== 'custom' || entry.customType !== entryType) continue;
      const data = entry.data as Entry;
      if (data?.scope === scope && typeof data.service === 'string' && StateSchema.safeParse(data.state).success) {
        this.states.set(data.service, data.state);
        if (typeof data.contextId === 'string') { this.contexts.set(data.service, data.contextId); this.savedContexts.add(data.service); }
        if (data.retainOnNew) this.retained.add(data.service); else this.retained.delete(data.service);
      }
    }
    const file = ctx.sessionManager?.getSessionFile?.();
    const carried = file ? transfers.get(file) : undefined;
    // Shutdown creates transfers only for accepted /new destinations. A failed
    // gateway launch may reach this same file later via /reload or Restart.
    for (const data of carried ?? []) {
      if (data.scope !== scope) continue;
      this.states.set(data.service, data.state);
      if (data.contextId) this.contexts.set(data.service, data.contextId);
      this.retained.add(data.service); this.save(data.service);
    }
    // Do not consume the transfer before persistence: appendEntry can fail.
    if (file && carried) {
      const remaining = carried.filter((data) => data.scope !== scope);
      if (remaining.length) transfers.set(file, remaining); else transfers.delete(file);
    }
    const epoch = this.epoch;
    if (ctx.mode === 'tui') {
      ctx.ui.setWidget?.('gateway-native-footers', (tui, theme) => {
        this.fullscreen = tui.mode === 'fullscreen';
        if (!this.fullscreen) return { render: () => [], invalidate() {} };
        this.repaint = () => tui.requestRender();
        return new NativeFooter(() => [...this.views].map(([uri, view]) => ({ uri, view })), theme,
          async ({ uri, view }, item, action) => {
            if (epoch !== this.epoch || !this.resources.has(serviceOf(uri))) return false;
            if (item.openApp) return this.interact(async (showDialog) => { showDialog(); await this.open(serviceOf(uri), ctx); return true; });
            return action ? this.footerAction(uri, view, action, epoch) : false;
          }, this.repaint);
      }, { placement: 'belowEditor' });
      if (!this.fullscreen) {
        ctx.ui.setWidget?.('gateway-native-footers', undefined);
        const bridge = new FooterActions(); this.bridge = bridge;
        try { await bridge.start(); }
        catch { await bridge.stop(); if (this.bridge === bridge) this.bridge = undefined; ctx.ui.notify('Footer clicks unavailable; select the service in /pi-services', 'warning'); }
      }
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
    this.ctx?.ui.setWidget?.('gateway-native-footers', undefined);
    this.fullscreen = false; this.repaint = () => {};
    this.resources.clear(); this.views.clear(); this.pending.clear(); this.dirty.clear(); this.operations.clear(); this.blocked.clear(); this.changed();
    return bridge?.stop() ?? Promise.resolve();
  }

  invalidate(service: string): void {
    const uri = this.resources.get(service);
    if (uri) { this.resources.delete(service); this.views.delete(uri); this.dirty.delete(uri); }
    this.bridge?.clear(service);
    this.ctx?.ui.setStatus(`gateway-ui:${service}`, undefined);
    this.repaint(); this.changed();
  }

  // An advertised app can be reopened after a transient view-read failure.
  has(service: string): boolean { return this.resources.has(service); }

  meta(service: string): Record<string, unknown> {
    if (!this.contexts.has(service)) this.contexts.set(service, randomUUID());
    const scoped = ActionRevisionFeaturesSchema.safeParse(this.client().getServerCapabilities?.()?.experimental?.['native-ui-v1']).success;
    const secondary = FooterSecondaryFeaturesSchema.safeParse(this.client().getServerCapabilities?.()?.experimental?.['native-ui-v1']).success;
    const styles = FooterStylesFeaturesSchema.safeParse(this.client().getServerCapabilities?.()?.experimental?.['native-ui-v1']).success;
    const double = FooterDoubleFeaturesSchema.safeParse(this.client().getServerCapabilities?.()?.experimental?.['native-ui-v1']).success;
    const native = this.fullscreen && FooterNativeFeaturesSchema.safeParse(this.client().getServerCapabilities?.()?.experimental?.['native-ui-v1']).success;
    return { ...(scoped || secondary || styles || double || native ? { [UI_FEATURES]: { ...(scoped ? { actionRevisions: true } : {}), ...(secondary ? { footerSecondaryActions: true } : {}), ...(styles ? { footerStyles: true } : {}), ...(double ? { footerDoubleActions: true } : {}), ...(native ? { footerNativeActions: true } : {}) } } : {}), [UI_CONTEXT]: ContextSchema.parse({
      conversationId: this.ctx?.sessionManager?.getSessionId() ?? this.ephemeralId,
      contextId: this.contexts.get(service),
      state: this.states.get(service) ?? {},
    }) };
  }

  private apply(uri: string, view: NativeView): void {
    const service = serviceOf(uri);
    const changed = !this.savedContexts.has(service) || JSON.stringify(this.states.get(service)) !== JSON.stringify(view.state) || this.retained.has(service) !== Boolean(view.retainOnNew);
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
    if (this.fullscreen) {
      ctx.ui.setStatus(`gateway-ui:${service}`, undefined);
      this.repaint();
      return;
    }
    const invoke = (action: string) => () => this.footerAction(uri, view, action, epoch);
    ctx.ui.setStatus(`gateway-ui:${service}`, footerText(view, truncateToWidth,
      (action, secondary, double) => this.bridge?.link(service, action ? invoke(action) : undefined, secondary ? invoke(secondary) : undefined, double ? invoke(double) : undefined),
      (text, style) => { const colored = style.color ? ctx.ui.theme.fg(style.color, text) : text; return style.italic ? ctx.ui.theme.italic(colored) : colored; }));
  }

  private footerAction(uri: string, view: NativeView, action: string, epoch: number): Promise<boolean> {
    return this.interact(async (showDialog) => {
      const ctx = this.ctx;
      if (!ctx || epoch !== this.epoch || this.resources.get(serviceOf(uri)) !== uri) return false;
      try {
        const control = view.controls.find((c) => c.id === action && c.kind === 'action');
        if (!control) return false;
        if (control.confirm) {
          showDialog();
          if (!await confirmSettings(ctx, clean(control.confirm), { signal: this.options().signal, title: oneLine(control.label), actionLabel: 'confirm' })) return false;
        }
        return await this.dispatch(uri, view, control, undefined, ctx, epoch, showDialog);
      } finally { if (epoch === this.epoch && this.views.get(uri)) this.renderFooter(uri, this.views.get(uri)!); }
    });
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
            this.repaint();
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

  private actionCurrent(uri: string, view: NativeView, picked: NativeControl): boolean {
    const current = this.views.get(uri);
    const control = current?.controls.find((item) => item.id === picked.id && item.kind === picked.kind);
    if (!current || !control) return false;
    return picked.revision !== undefined && control.revision !== undefined
      ? picked.revision === control.revision
      : picked.revision === control.revision && current.revision === view.revision;
  }

  private async dispatch(uri: string, view: NativeView, picked: NativeControl, value: NativeControl['value'], ctx: ExtensionContext, epoch: number, showDialog = () => {}): Promise<boolean> {
    const service = serviceOf(uri);
    let attempted = false;
    try {
      const result = await this.serial(service, async () => {
        if (epoch !== this.epoch || this.resources.get(service) !== uri || !this.actionCurrent(uri, view, picked)) throw new Error('View changed or disconnected; refresh before acting');
        if (typeof value === 'string') editorText(value);
        attempted = true;
        const result = await this.client().request({ method: 'native-ui/action', params: {
          uri, action: picked.id, revision: picked.revision ?? view.revision, ...(value === undefined ? {} : { value }), _meta: this.meta(service),
        } }, ActionResultSchema, this.options());
        if (epoch !== this.epoch || this.resources.get(service) !== uri) throw new Error('Gateway context changed during action');
        this.apply(uri, result.view);
        return result;
      });
      await this.refresh(uri);
      if (epoch !== this.epoch || !this.views.has(uri)) return false;
      if (result.preview) this.pi.appendEntry('gateway-native-preview', { title: oneLine(view.title), text: clean(result.preview) });
      if (result.draft) showDialog();
      if (result.draft && await ctx.ui.confirm('Insert draft?', clean(result.draft), { signal: this.options().signal }) && epoch === this.epoch) {
        if (ctx.ui.getEditorText().trim()) ctx.ui.notify('Draft preserved; clear the editor before inserting a server draft', 'warning');
        else ctx.ui.setEditorText(editorText(result.draft));
      }
      return true;
    } catch (error) {
      if (epoch === this.epoch) {
        const stale = error instanceof McpError && error.code === UI_STALE_ACTION && StaleActionDataSchema.safeParse(error.data).success;
        ctx.ui.notify(stale
          ? 'Action not applied: view changed. Refresh and review before retrying.'
          : `${clean(String(error))}\n${attempted ? 'The action may have committed.' : 'Action not applied.'} Refresh before retrying.`, stale || !attempted ? 'warning' : 'error');
        await this.refresh(uri);
      }
      return false;
    }
  }

  async open(service: string, ctx: ExtensionContext, navigation?: { settings: () => Promise<void> }): Promise<'features' | void> {
    // Human interaction has no RPC deadline; shutdown still cancels dialogs.
    const dialogOptions = { signal: this.options().signal };
    if (ctx.mode !== 'tui') throw new Error('Native UI requires TUI mode');
    const epoch = this.epoch;
    if (!service) service = await ctx.ui.select('Gateway apps', [...this.resources.keys()], dialogOptions) ?? '';
    const uri = this.resources.get(service);
    if (!uri) return navigation ? 'features' : undefined;
    await this.refresh(uri);
    const menu = new GatewayMenu(ctx, dialogOptions.signal);
    while (epoch === this.epoch && !dialogOptions.signal.aborted) {
      const view = this.views.get(uri);
      if (!view) return navigation ? 'features' : undefined;
      const refresh = new AbortController();
      const changed = () => refresh.abort();
      this.changed = changed;
      let choice: string | undefined;
      try {
        choice = await menu.choose(navigation ? ['Gateway', 'Services', service, view.title] : [view.title], view.body ?? '',
          view.controls.map((control) => ({
            id: `control:${control.id}`,
            label: `${control.icon ? `${oneLine(control.icon)} ` : ''}${oneLine(control.label)}${control.kind !== 'action' ? `: ${oneLine(String(control.value ?? ''))}` : ''}`,
            description: control.description ?? '',
          })), undefined, { signal: refresh.signal, shortcuts: [
            ...(navigation ? [{ key: Key.tab, label: 'Tab settings', id: 'settings' }, { key: Key.ctrl('o'), label: 'Ctrl+O features', id: 'features' }] : []),
            { key: Key.ctrl('r'), label: 'Ctrl+R refresh', id: 'refresh' },
          ] });
      } finally { if (this.changed === changed) this.changed = () => {}; }
      if (epoch !== this.epoch || dialogOptions.signal.aborted) return;
      if (refresh.signal.aborted || choice === 'refresh') { await this.refresh(uri); continue; }
      if (!choice) return;
      if (choice === 'features') return 'features';
      if (choice === 'settings') { await navigation!.settings(); await this.refresh(uri); continue; }
      const picked = view.controls.find((control) => `control:${control.id}` === choice)!;
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
      if (picked.confirm) {
        const disclosure = clean(picked.confirm) + (picked.kind === 'action' ? '' : `\n${literal(value)}`);
        if (!await confirmSettings(ctx, disclosure, { ...dialogOptions, title, actionLabel: 'confirm' })) continue;
      }
      if (epoch !== this.epoch) return;
      await this.dispatch(uri, view, picked, value, ctx, epoch);
    }
  }
}
