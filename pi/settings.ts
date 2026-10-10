import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats, { type FormatsPlugin } from 'ajv-formats';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Input, Key, matchesKey, SelectList, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { SettingsDocument } from '../src/settings.js';
import { safeKey } from '../src/settings.js';

export const clean = (text: string) => text
  .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
  .slice(0, 20_000);
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => typeof value === 'object' && value !== null && !Array.isArray(value);
interface Field { path: string[]; schema: ObjectValue; readonly: boolean }
function fields(schema: ObjectValue, path: string[] = [], readonly = false): Field[] {
  if (path.length > 16) throw new Error('Settings schema is too deeply nested');
  readonly ||= schema.readOnly === true || schema.writeOnly === true || schema.format === 'password' ||
    ['$ref', 'allOf', 'anyOf', 'if'].some((key) => Object.hasOwn(schema, key)) ||
    (Array.isArray(schema.oneOf) && !schema.oneOf.every((entry) => object(entry) && Object.hasOwn(entry, 'const')));
  if ((schema.type === 'object' || schema.type === undefined) && object(schema.properties)) {
    return Object.entries(schema.properties).flatMap(([key, child]) => {
      if (!safeKey(key) || !object(child)) throw new Error('Unsupported settings schema property');
      return fields(child, [...path, key], readonly);
    });
  }
  return [{ path, schema, readonly }];
}
function at(value: ObjectValue, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) current = object(current) && Object.hasOwn(current, key) ? current[key] : undefined;
  return current;
}
function put(value: ObjectValue, path: string[], next: unknown): void {
  let parent = value;
  for (const key of path.slice(0, -1)) {
    if (!object(parent[key])) parent[key] = {};
    parent = parent[key] as ObjectValue;
  }
  parent[path[path.length - 1]] = next;
}
const display = (value: unknown) => (JSON.stringify(value) ?? '(unset)')
  .replace(/[^\x21-\x7e]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
const pathLabel = (path: string[]) => display(path.map((key) => key.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')).slice(1, -1);

const primitive = (value: unknown) => ['string', 'number', 'boolean'].includes(typeof value);
function supported(schema: ObjectValue): boolean {
  if (Object.hasOwn(schema, 'const')) return false;
  if (Array.isArray(schema.enum)) return schema.enum.length > 0 && schema.enum.every(primitive);
  if (Array.isArray(schema.oneOf)) return schema.oneOf.length > 0 && schema.oneOf.every((entry) => object(entry) && primitive(entry.const));
  return ['string', 'number', 'integer', 'boolean'].includes(String(schema.type));
}
type DialogOptions = { signal: AbortSignal; timeout?: number; title?: string; actionLabel?: string };
const overlay = { overlay: true, overlayOptions: { width: '100%' as const, anchor: 'center' as const, margin: 1 } };

// Isolated overlays own their full height: editor widgets/footers cannot hide
// controls. Native SelectList keeps options on single rows and follows selection.
export async function selectSettingsOption(ctx: ExtensionContext, title: string, choices: string[], options: DialogOptions): Promise<string | undefined> {
  if (options.signal.aborted || !choices.length) return undefined;
  return ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
    let list: SelectList | undefined;
    let geometry = '';
    let usable = false;
    const cancel = () => done(undefined);
    const timer = options.timeout === undefined ? undefined : setTimeout(cancel, options.timeout);
    options.signal.addEventListener('abort', cancel, { once: true });
    return {
      render(width: number) {
        geometry = `${tui.terminal.rows}:${tui.terminal.columns}`;
        const height = Math.max(1, tui.terminal.rows - 2);
        usable = height >= 8 && width >= 20;
        if (!usable) return [truncateToWidth('Enlarge terminal; Esc cancels', width)];
        const heading = title.split('\n').flatMap((line) => wrapTextWithAnsi(line, width)).slice(0, Math.min(3, height - 7));
        const selected = Number(list?.getSelectedItem()?.value ?? 0);
        list = new SelectList(choices.map((label, i) => ({ value: String(i), label: label.replace(/\n/g, ' ') })), Math.max(1, height - heading.length - 6), {
          selectedPrefix: (s) => theme.fg('accent', s), selectedText: (s) => theme.fg('accent', s),
          description: (s) => theme.fg('muted', s), scrollInfo: (s) => theme.fg('dim', s), noMatch: (s) => s,
        });
        list.setSelectedIndex(selected);
        list.onSelect = (item) => { if (!options.signal.aborted) done(choices[Number(item.value)]); };
        list.onCancel = cancel;
        const border = theme.fg('accent', '─'.repeat(width));
        return [border, ...heading.map((s) => theme.fg('accent', s)), '', ...list.render(width), '', theme.fg('muted', '↑/↓ navigate  Enter select  Esc back'), border].map((line) => truncateToWidth(line, width));
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) cancel();
        else if (usable && geometry === `${tui.terminal.rows}:${tui.terminal.columns}`) list?.handleInput(data);
        tui.requestRender();
      },
      invalidate() {},
      dispose() { clearTimeout(timer); options.signal.removeEventListener('abort', cancel); },
    };
  }, overlay);
}

export async function confirmSettings(ctx: ExtensionContext, text: string, options: DialogOptions): Promise<boolean> {
  if (options.signal.aborted) return false;
  return ctx.ui.custom<boolean>((tui, theme, _keys, done) => {
    let offset = 0, maxOffset = 0, page = 1;
    let geometry = '', usable = false, complete = false;
    let seen = new Set<number>();
    const cancel = () => done(false);
    const timer = options.timeout === undefined ? undefined : setTimeout(cancel, options.timeout);
    options.signal.addEventListener('abort', cancel, { once: true });
    return {
      render(width: number) {
        const current = `${width}:${tui.terminal.rows}:${tui.terminal.columns}`;
        if (current !== geometry) { seen = new Set(); complete = false; }
        geometry = current;
        const height = Math.max(1, tui.terminal.rows - 2);
        usable = height >= 8 && width >= 20;
        if (!usable) return [truncateToWidth('Enlarge terminal; Esc cancels', width)];
        const lines = text.split('\n').flatMap((line) => wrapTextWithAnsi(line, width));
        page = height - 6;
        maxOffset = Math.max(0, lines.length - page);
        offset = Math.min(offset, maxOffset);
        for (let i = offset; i < Math.min(lines.length, offset + page); i++) seen.add(i);
        complete = seen.size === lines.length;
        const border = theme.fg('accent', '─'.repeat(width));
        return [border, theme.fg('accent', clean(options.title ?? 'Save child-server settings?')), '', ...lines.slice(offset, offset + page), '',
          theme.fg(complete ? 'success' : 'warning', complete ? `Enter ${options.actionLabel ?? 'save'}  Esc cancel` : '↑/↓ PgUp/PgDn review ALL changes before Enter confirms'), border].map((line) => truncateToWidth(line, width));
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) cancel();
        else if (usable && geometry.endsWith(`:${tui.terminal.rows}:${tui.terminal.columns}`)) {
          if (matchesKey(data, Key.enter) && complete && !options.signal.aborted) done(true);
          else if (matchesKey(data, Key.down)) offset = Math.min(maxOffset, offset + 1);
          else if (matchesKey(data, Key.up)) offset = Math.max(0, offset - 1);
          else if (matchesKey(data, Key.pageDown)) offset = Math.min(maxOffset, offset + page);
          else if (matchesKey(data, Key.pageUp)) offset = Math.max(0, offset - page);
        }
        tui.requestRender();
      },
      invalidate() {},
      dispose() { clearTimeout(timer); options.signal.removeEventListener('abort', cancel); },
    };
  }, overlay);
}

export async function inputSettings(ctx: ExtensionContext, title: string, value: string, options: { signal: AbortSignal; timeout?: number }): Promise<string | undefined> {
  if (options.signal.aborted) return undefined;
  return ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
    const input = new Input();
    input.setValue(value);
    let geometry = '', usable = false;
    const cancel = () => done(undefined);
    input.onEscape = cancel;
    input.onSubmit = (text) => { if (usable && !options.signal.aborted) done(text); };
    const timer = options.timeout === undefined ? undefined : setTimeout(cancel, options.timeout);
    options.signal.addEventListener('abort', cancel, { once: true });
    return {
      get focused() { return input.focused; },
      set focused(value: boolean) { input.focused = value; },
      render(width: number) {
        geometry = `${tui.terminal.rows}:${tui.terminal.columns}`;
        const height = Math.max(1, tui.terminal.rows - 2);
        usable = height >= 8 && width >= 20;
        if (!usable) return [truncateToWidth('Enlarge terminal; Esc cancels', width)];
        const heading = title.split('\n').flatMap((line) => wrapTextWithAnsi(line, width)).slice(0, 2);
        const border = theme.fg('accent', '─'.repeat(width));
        return [border, ...heading.map((s) => theme.fg('accent', s)), '', ...input.render(width), '',
          truncateToWidth(theme.fg('muted', 'JSON value  Enter stage  Esc back'), width), border];
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) cancel();
        else if (usable && geometry === `${tui.terminal.rows}:${tui.terminal.columns}`) input.handleInput(data);
        tui.requestRender();
      },
      invalidate() { input.invalidate(); },
      dispose() { clearTimeout(timer); options.signal.removeEventListener('abort', cancel); },
    };
  }, overlay);
}

/** Schema-driven operator editor; no parent model catalogue, tool calls or model messages. */
export async function editSettings(ctx: ExtensionContext, initial: SettingsDocument,
  update: (revision: string, patch: ObjectValue) => Promise<SettingsDocument>, signal: AbortSignal, timeout: number): Promise<void> {
  let document = initial;
  // Human navigation has no RPC deadline; shutdown still cancels the draft.
  const options = { signal };
  let feedback = '';
  while (!signal.aborted) {
    const leaves = fields(document.schema);
    if (leaves.length > 500 || leaves.some((f) => !f.path.length)) throw new Error('Unsupported settings schema');
    const draft = structuredClone(document.values);
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    (addFormats as unknown as FormatsPlugin)(ajv);
    const valid = ajv.compile(document.schema);
    // Only inline primitive controls are editable. Full schema validation still applies on save.
    const editable = (field: Field) => document.writable && !document.conflict && !field.readonly &&
      supported(field.schema);
    while (!signal.aborted) {
      const changes = leaves.filter((f) => JSON.stringify(at(draft, f.path)) !== JSON.stringify(at(document.values, f.path)));
      const labels = leaves.map((f, i) => `${i + 1}. ${pathLabel(f.path)}: ${clean(display(at(draft, f.path)))}${editable(f) ? '' : ' [read-only]'}`);
      const save = `Save changes (${changes.length})`;
      const choice = await selectSettingsOption(ctx, clean([document.title, feedback, document.warning,
        document.applyTo ? `Applies to: ${document.applyTo}` : '', !document.writable ? 'Read-only' : ''].filter(Boolean).join('\n')), [...labels, save, 'Back'], options);
      if (!choice || choice === 'Back' || signal.aborted) return;
      if (choice === save) {
        if (!changes.length || !document.writable || document.conflict) continue;
        if (!valid(draft)) { ctx.ui.notify(clean(ajv.errorsText(valid.errors)), 'error'); continue; }
        const patch: ObjectValue = {};
        for (const field of changes) put(patch, field.path, at(draft, field.path));
        const preview = changes.map((f) => `${pathLabel(f.path)}: ${display(at(document.values, f.path))} → ${display(at(draft, f.path))}`).join('\n');
        const confirmation = `${preview}\n\nApplies to: ${clean(document.applyTo ?? 'server-defined')}`;
        if (!await confirmSettings(ctx, confirmation, options) || signal.aborted) continue;
        try {
          document = await update(document.revision, patch);
          feedback = 'Settings saved';
          break;
        } catch {
          // Uncertain writes and conflicts require a fresh get, never an automatic replay.
          ctx.ui.notify('Settings save failed or conflicted. Reopen /gateway → Services → Settings to read current values; do not replay blindly.', 'error');
          return;
        }
      }
      const field = leaves[labels.indexOf(choice)];
      if (!field || !editable(field)) continue;
      const key = field.path[field.path.length - 1];
      const siblingModel = at(draft, [...field.path.slice(0, -1), 'model']);
      const model = document.models?.find((m) => m.id === siblingModel);
      let choices: { value: unknown; label: string }[] | undefined;
      if (key === 'model' && document.models) choices = document.models.filter((m) => m.available).map((m) => ({ value: m.id, label: `${m.label} — ${m.id}` }));
      else if (key === 'thinking' && document.models) choices = (model?.available ? model.thinking : []).map((level) => ({ value: level, label: level }));
      else if (Array.isArray(field.schema.enum)) choices = field.schema.enum.map((value) => ({ value, label: display(value) }));
      else if (Array.isArray(field.schema.oneOf) && field.schema.oneOf.every((entry) => object(entry) && Object.hasOwn(entry, 'const'))) {
        choices = field.schema.oneOf.map((entry) => ({ value: entry.const, label: String(entry.title ?? display(entry.const)) }));
      } else if (field.schema.type === 'boolean') choices = [{ value: true, label: 'true' }, { value: false, label: 'false' }];
      const title = clean(`${pathLabel(field.path)}${field.schema.description ? `\n${field.schema.description}` : ''}`);
      let next: unknown;
      if (choices) {
        if (!choices.length) { ctx.ui.notify('No available choices for this field', 'warning'); continue; }
        const labels = choices.map((c, i) => `${i + 1}. ${clean(c.label)}`);
        const selected = await selectSettingsOption(ctx, title, labels, options);
        if (!selected || signal.aborted) continue;
        next = choices[labels.indexOf(selected)].value;
      } else {
        const text = await inputSettings(ctx, title, display(at(draft, field.path) ?? (field.schema.type === 'string' ? '' : 0)), options);
        if (text === undefined || signal.aborted) continue;
        try { next = JSON.parse(text); } catch { ctx.ui.notify('Enter a valid JSON value (quote strings)', 'error'); continue; }
        if (field.schema.type === 'string' ? typeof next !== 'string' : typeof next !== 'number' || !Number.isFinite(next)) {
          ctx.ui.notify('Enter a JSON string or finite number matching this field', 'error'); continue;
        }
      }
      // Model changes must stage supported reasoning in the same confirmed patch.
      if (key === 'model' && document.models && next !== siblingModel) {
        const thinkingPath = [...field.path.slice(0, -1), 'thinking'];
        const thinkingField = leaves.find((f) => JSON.stringify(f.path) === JSON.stringify(thinkingPath));
        if (thinkingField && editable(thinkingField)) {
          const levels = document.models.find((m) => m.id === next)?.thinking ?? [];
          if (!levels.length) continue;
          const thinking = await selectSettingsOption(ctx, 'Reasoning for selected model', levels.map(clean), options);
          if (!thinking || signal.aborted) continue;
          put(draft, thinkingPath, levels[levels.map(clean).indexOf(thinking)]);
        }
      }
      put(draft, field.path, next);
    }
  }
}
