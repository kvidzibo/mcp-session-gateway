import { compileSchema } from '../src/validation.js';
import { clean, literal as display } from '../src/native-ui.js';
import { DynamicBorder, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Editor, getKeybindings, Input, Key, matchesKey, SelectList, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { SettingsDocument } from '../src/settings.js';
import { safeKey } from '../src/settings.js';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => typeof value === 'object' && value !== null && !Array.isArray(value);
interface Field { path: string[]; schema: ObjectValue; readonly: boolean }
const restricted = (schema: ObjectValue): boolean => schema.readOnly === true || schema.writeOnly === true || schema.format === 'password' ||
  ['$ref', 'allOf', 'anyOf', 'if'].some((key) => Object.hasOwn(schema, key)) ||
  (Array.isArray(schema.oneOf) && !schema.oneOf.every((entry) => object(entry) && Object.hasOwn(entry, 'const')));
function fields(schema: ObjectValue, path: string[] = [], readonly = false, values?: unknown): Field[] {
  if (path.length > 16) throw new Error('Settings schema is too deeply nested');
  readonly ||= restricted(schema);
  if ((schema.type === 'object' || schema.type === undefined) && object(schema.properties)) {
    const properties = { ...schema.properties };
    if (object(schema.additionalProperties) && object(values)) {
      for (const key of Object.keys(values)) {
        if (!safeKey(key)) throw new Error('Unsupported settings schema property');
        if (!Object.hasOwn(properties, key)) properties[key] = schema.additionalProperties;
      }
    }
    return Object.entries(properties).flatMap(([key, child]) => {
      if (!safeKey(key) || !object(child)) throw new Error('Unsupported settings schema property');
      return fields(child, [...path, key], readonly, object(values) ? values[key] : undefined);
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
const pathLabel = (path: string[]) => display(path.map((key) => key.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')).slice(1, -1);

const primitive = (value: unknown) => ['string', 'number', 'boolean'].includes(typeof value);
function supported(schema: ObjectValue): boolean {
  if (Object.hasOwn(schema, 'const')) return false;
  if (Array.isArray(schema.enum)) return schema.enum.length > 0 && schema.enum.every(primitive);
  if (Array.isArray(schema.oneOf)) return schema.oneOf.length > 0 && schema.oneOf.every((entry) => object(entry) && primitive(entry.const));
  if (schema.type === 'array') return schema.uniqueItems === true && object(schema.items) &&
    Array.isArray(schema.items.enum) && schema.items.enum.every(primitive);
  return ['string', 'number', 'integer', 'boolean'].includes(String(schema.type));
}
type DialogOptions = { signal: AbortSignal; timeout?: number; title?: string; actionLabel?: string };
const overlay = { overlay: true, overlayOptions: { width: '100%' as const, anchor: 'center' as const, margin: 0 } };

// Browsing/editing stays in Pi's compact inline area; confirmations remain
// isolated so editor widgets/footers cannot hide required review controls.
const inlineHeight = (rows: number) => Math.max(1, rows - 6); // Leave room for Pi's footer and service counters.
export async function selectSettingsOption(ctx: ExtensionContext, title: string, choices: string[], options: DialogOptions): Promise<string | undefined> {
  if (options.signal.aborted || !choices.length) return undefined;
  return ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
    const input = new Input();
    const items = choices.map((label, i) => ({ value: String(i), label: label.replace(/\n/g, ' ') }));
    let filtered = items;
    let query = '', capacity = 1;
    let list: SelectList | undefined;
    let geometry = '';
    let usable = false;
    const rebuild = (preserve = false) => {
      const selected = preserve ? list?.getSelectedItem()?.value : undefined;
      list = new SelectList(filtered, capacity, {
        selectedPrefix: (s) => theme.fg('accent', s), selectedText: (s) => theme.fg('accent', s),
        description: (s) => theme.fg('muted', s), scrollInfo: (s) => theme.fg('dim', s), noMatch: (s) => s,
      });
      list.setSelectedIndex(Math.max(0, filtered.findIndex((item) => item.value === selected)));
      list.onSelect = (item) => { if (!options.signal.aborted) done(choices[Number(item.value)]); };
    };
    const cancel = () => done(undefined);
    const timer = options.timeout === undefined ? undefined : setTimeout(cancel, options.timeout);
    options.signal.addEventListener('abort', cancel, { once: true });
    return {
      get focused() { return input.focused; },
      set focused(value: boolean) { input.focused = value; },
      render(width: number) {
        geometry = `${tui.terminal.rows}:${tui.terminal.columns}`;
        const height = inlineHeight(tui.terminal.rows);
        usable = height >= 8 && width >= 20;
        if (!usable) return [truncateToWidth('Enlarge terminal; Esc cancels', width)];
        const heading = title.split('\n').flatMap((line) => wrapTextWithAnsi(line, width)).slice(0, Math.min(3, height - 7));
        const nextCapacity = Math.max(1, Math.min(10, height - heading.length - 6));
        if (!list || capacity !== nextCapacity) { capacity = nextCapacity; rebuild(true); }
        const [border] = new DynamicBorder((text) => theme.fg('border', text)).render(width);
        const results = filtered.length ? list!.render(width) : [theme.fg('muted', 'No matching choices')];
        return [border, ...heading.map((s) => theme.fg('accent', s)),
          ...input.render(width - 8).map((line) => `${theme.fg('muted', 'Search: ')}${line}`),
          ...results, '', theme.fg('muted', width < 60 ? '↑↓ Enter Esc' : 'Type to filter  ↑/↓ navigate  Enter select  Esc back'), border].map((line) => truncateToWidth(line, width));
      },
      handleInput(data: string) {
        const keys = getKeybindings();
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c')) || keys.matches(data, 'tui.select.cancel')) cancel();
        else if (usable && geometry === `${tui.terminal.rows}:${tui.terminal.columns}`) {
          if (keys.matches(data, 'tui.select.up') || keys.matches(data, 'tui.select.down') || keys.matches(data, 'tui.select.confirm')) list?.handleInput(data);
          else {
            input.handleInput(data);
            if (query !== input.getValue()) {
              query = input.getValue();
              const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
              filtered = items.filter((item) => terms.every((term) => item.label.toLowerCase().includes(term)));
              rebuild();
            }
          }
        }
        tui.requestRender();
      },
      invalidate() { input.invalidate(); list?.invalidate(); },
      dispose() { clearTimeout(timer); options.signal.removeEventListener('abort', cancel); },
    };
  });
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
          theme.fg(complete ? 'success' : 'warning', complete ? `Enter ${options.actionLabel ?? 'save'}  Esc cancel` : width < 60 ? '↑↓/PgUp/PgDn review · Esc cancel' : '↑/↓ PgUp/PgDn review ALL changes before Enter confirms'), border].map((line) => truncateToWidth(line, width));
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

export async function inputSettings(ctx: ExtensionContext, title: string, value: string, options: { signal: AbortSignal; timeout?: number; multiline?: boolean; raw?: boolean }): Promise<string | undefined> {
  if (options.signal.aborted) return undefined;
  return ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
    const input = options.multiline ? new Editor(tui, {
      borderColor: (s) => theme.fg('border', s),
      selectList: { selectedPrefix: (s) => s, selectedText: (s) => s, description: (s) => s, scrollInfo: (s) => s, noMatch: (s) => s },
    }) : new Input();
    if (input instanceof Editor) input.setText(value);
    else input.setValue(value);
    let geometry = '', usable = false;
    const cancel = () => done(undefined);
    input.onSubmit = (text) => { if (usable && !options.signal.aborted) done(text); };
    const timer = options.timeout === undefined ? undefined : setTimeout(cancel, options.timeout);
    options.signal.addEventListener('abort', cancel, { once: true });
    return {
      get focused() { return input.focused; },
      set focused(value: boolean) { input.focused = value; },
      render(width: number) {
        geometry = `${tui.terminal.rows}:${tui.terminal.columns}`;
        const height = inlineHeight(tui.terminal.rows);
        usable = height >= (options.multiline ? 14 : 8) && width >= 20;
        if (!usable) return [truncateToWidth('Enlarge terminal; Esc cancels', width)];
        const heading = title.split('\n').flatMap((line) => wrapTextWithAnsi(line, width)).slice(0, 2);
        const [border] = new DynamicBorder((text) => theme.fg('border', text)).render(width);
        return [border, ...heading.map((s) => theme.fg('accent', s)), '', ...input.render(width), '',
          truncateToWidth(theme.fg('muted', options.multiline ? 'Shift+Enter newline · Enter submit · Esc cancel' : options.raw ? 'Enter submit · Esc back' : width < 40 ? 'Enter submit · Esc' : 'JSON value  Enter submit  Esc cancel'), width), border];
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) cancel();
        else if (usable && geometry === `${tui.terminal.rows}:${tui.terminal.columns}`) input.handleInput(data);
        tui.requestRender();
      },
      invalidate() { input.invalidate(); },
      dispose() { clearTimeout(timer); options.signal.removeEventListener('abort', cancel); },
    };
  });
}

/** Compact pure, distinct constant alternatives without changing validation semantics.
 * Keep the original schema for titles/UI; constrained or duplicate branches stay oneOf.
 */
export function settingsValidationSchema(schema: ObjectValue): ObjectValue {
  // A reference may target a oneOf branch by JSON Pointer: never remove its path.
  if (/"\$(?:ref|dynamicRef)":/.test(JSON.stringify(schema))) return schema;
  const copy = structuredClone(schema);
  const schemas = (node: ObjectValue): ObjectValue[] => [node,
    ...Object.values(object(node.properties) ? node.properties : {}).flatMap((child) => object(child) ? schemas(child) : []),
    ...['additionalProperties', 'items'].flatMap((key) => object(node[key]) ? schemas(node[key]) : []),
  ];
  for (const leaf of schemas(copy)) {
    if (Object.hasOwn(leaf, 'enum') || !Array.isArray(leaf.oneOf) || !leaf.oneOf.length) continue;
    if (!leaf.oneOf.every((entry) => object(entry) && primitive(entry.const) &&
      Object.keys(entry).every((key) => key === 'const' ||
        (['title', 'description'].includes(key) && typeof entry[key] === 'string')))) continue;
    const values = leaf.oneOf.map((entry) => (entry as ObjectValue).const);
    if (new Set(values).size !== values.length) continue;
    leaf.enum = values;
    delete leaf.oneOf;
  }
  return copy;
}

/** Schema-driven operator editor; no parent model catalogue, tool calls or model messages. */
export async function editSettings(ctx: ExtensionContext, initial: SettingsDocument,
  update: (revision: string, patch: ObjectValue) => Promise<SettingsDocument>, signal: AbortSignal): Promise<void> {
  let document = initial;
  // Human navigation has no RPC deadline; shutdown still cancels the draft.
  const options = { signal };
  let feedback = '';
  let selectedEntry: string | undefined;
  while (!signal.aborted) {
    let draft = structuredClone(document.values);
    const rootProperties = object(document.schema.properties) ? Object.entries(document.schema.properties) : [];
    // A service can expose a named collection with a schema for newly added entries.
    const collection = rootProperties.length === 1 && object(rootProperties[0][1]) &&
      object(rootProperties[0][1].additionalProperties) && object(rootProperties[0][1].additionalProperties.properties)
      ? { key: rootProperties[0][0], schema: rootProperties[0][1], entry: rootProperties[0][1].additionalProperties } : undefined;
    let newEntry: string | undefined;
    // Browsing/cancelling must not compile a potentially huge service schema.
    let validate: ReturnType<typeof compileSchema> | undefined;
    // Only inline primitive controls are editable. Full schema validation still applies on save.
    const editable = (field: Field) => document.writable && !document.conflict && !field.readonly &&
      supported(field.schema);
    const saveDraft = async (): Promise<boolean> => {
      const leaves = fields(document.schema, [], false, draft);
      if (leaves.length > 500 || leaves.some((f) => !f.path.length)) throw new Error('Unsupported settings schema');
      const changes = leaves.filter((f) =>
        JSON.stringify(at(draft, f.path)) !== JSON.stringify(at(document.values, f.path)));
      if (!changes.length || signal.aborted) return true;
      const patch: ObjectValue = {};
      for (const changed of changes) put(patch, changed.path, at(draft, changed.path));
      try {
        document = await update(document.revision, patch);
        feedback = 'Settings saved automatically';
        return true;
      } catch {
        // Uncertain writes and conflicts require a fresh get, never an automatic replay.
        ctx.ui.notify('Settings save failed or conflicted. Reopen /gateway → Services → Settings to read current values; do not replay blindly.', 'error');
        return false;
      }
    };
    while (!signal.aborted) {
      const leaves = fields(document.schema, [], false, draft);
      if (leaves.length > 500 || leaves.some((f) => !f.path.length)) throw new Error('Unsupported settings schema');
      const visible = collection ? leaves.filter((f) => f.path[0] === collection.key && f.path[1] === selectedEntry) : leaves;
      const collectionValue = collection ? draft[collection.key] : undefined;
      const entries = object(collectionValue) ? Object.keys(collectionValue) : [];
      const summary = (field: Field) => {
        const value = at(draft, field.path);
        return field.schema['x-multiline'] === true && typeof value === 'string' && value.length
          ? `${value.split('\n').length} lines (≈${Math.ceil(value.length / 4)} tokens)` : clean(display(value));
      };
      const labels = collection && selectedEntry === undefined ? entries.map((key) => {
        const model = at(draft, [collection.key, key, 'model']);
        const thinking = at(draft, [collection.key, key, 'thinking']);
        return clean(key) + (typeof model === 'string' && model ? ` — ${display(model).slice(1, -1)}` : '') +
          (typeof thinking === 'string' && thinking ? ` · reasoning: ${display(thinking).slice(1, -1)}` : '');
      }) : visible.map((f, i) =>
        `${i + 1}. ${collection ? clean(String(f.schema.title ?? f.path.at(-1))) : pathLabel(f.path)}: ${summary(f)}${editable(f) ? '' : ' [read-only]'}`);
      const canAdd = collection && editable({ path: [collection.key], schema: { type: 'string' }, readonly:
        [document.schema, collection.schema, collection.entry].some(restricted) });
      const add = `Add ${String(collection?.entry.title ?? 'entry').toLowerCase()}`;
      const choice = await selectSettingsOption(ctx, clean([selectedEntry !== undefined ? `${document.title} › ${selectedEntry}${selectedEntry === newEntry ? ' [new draft — not saved; Back cancels]' : ''}` : document.title,
        feedback || (document.writable && !document.conflict ? 'Valid edits save automatically' : ''), document.warning,
        document.applyTo ? `Applies to: ${document.applyTo}` : '', !document.writable ? 'Read-only' : ''].filter(Boolean).join('\n')),
        [...labels, ...(canAdd && selectedEntry === undefined ? [add] : []), 'Back'], options);
      if (signal.aborted) return;
      if (!choice || choice === 'Back') {
        if (selectedEntry !== undefined) {
          if (newEntry !== undefined && collection && object(draft[collection.key])) {
            delete (draft[collection.key] as ObjectValue)[newEntry];
            newEntry = undefined;
            feedback = '';
          }
          selectedEntry = undefined;
          continue;
        }
        return;
      }
      if (collection && choice === add && canAdd) {
        const name = await inputSettings(ctx, `${add}: name`, '', { ...options, raw: true });
        if (name === undefined || signal.aborted) continue;
        const validateName = compileSchema(object(collection.schema.propertyNames) ? collection.schema.propertyNames : { type: 'string', minLength: 1 });
        if (!safeKey(name) || validateName(name) || entries.includes(name)) {
          ctx.ui.notify('Enter a valid, unused name', 'error'); continue;
        }
        const entry: ObjectValue = {};
        for (const [key, schema] of Object.entries(collection.entry.properties as ObjectValue)) {
          if (!safeKey(key) || !object(schema)) throw new Error('Unsupported settings schema property');
          if (Object.hasOwn(schema, 'default')) entry[key] = structuredClone(schema.default);
          else if (schema.type === 'string') entry[key] = '';
        }
        put(draft, [collection.key, name], entry);
        selectedEntry = newEntry = name;
        validate ??= compileSchema(settingsValidationSchema(document.schema));
        const error = validate(draft);
        if (!error) {
          if (!await saveDraft()) return;
          break;
        }
        feedback = `Draft invalid — not saved: ${clean(error)}`;
        continue;
      }
      if (collection && selectedEntry === undefined && labels.includes(choice)) { selectedEntry = entries[labels.indexOf(choice)]; continue; }
      const field = visible[labels.indexOf(choice)];
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
      if (field.schema.type === 'array' && object(field.schema.items) && Array.isArray(field.schema.items.enum)) {
        const values = field.schema.items.enum;
        let selected = Array.isArray(at(draft, field.path)) ? [...at(draft, field.path) as unknown[]] : [];
        const wildcard = key === 'tools' && values.includes('*');
        while (!signal.aborted) {
          const all = wildcard && selected.includes('*');
          const labels = values.map((value) => `[${all || selected.includes(value) ? 'x' : ' '}] ${display(value)}`);
          const choice = await selectSettingsOption(ctx, title, [...labels, 'Done'], options);
          if (!choice || signal.aborted) break;
          if (choice === 'Done') { next = selected; break; }
          const value = values[labels.indexOf(choice)];
          if (wildcard && value === '*') selected = all ? [] : ['*'];
          else if (all) selected = values.filter((item) => item !== '*' && item !== value);
          else selected = selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value];
        }
        if (next === undefined) continue;
      } else if (field.schema['x-multiline'] === true && field.schema.type === 'string') {
        next = await inputSettings(ctx, title, String(at(draft, field.path) ?? ''), { ...options, multiline: true });
        if (next === undefined || signal.aborted) continue;
      } else if (choices) {
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
      const before = structuredClone(draft);
      // Model and supported reasoning are one atomic edit, including cancellation.
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
      if (signal.aborted) return;
      validate ??= compileSchema(settingsValidationSchema(document.schema));
      const error = validate(draft);
      if (error) {
        if (newEntry !== undefined) feedback = `Draft invalid — not saved: ${clean(error)}`;
        else {
          draft = before;
          ctx.ui.notify(`Edit not saved; previous value restored: ${clean(error)}`, 'error');
        }
        continue;
      }
      if (!await saveDraft()) return;
      break;
    }
  }
}
