import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats, { type FormatsPlugin } from 'ajv-formats';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { wrapTextWithAnsi } from '@earendil-works/pi-tui';
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
  if (schema.type === 'object' && object(schema.properties)) {
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
  .replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
const pathLabel = (path: string[]) => display(path.map((key) => key.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')).slice(1, -1);

/** Schema-driven operator editor; no parent model catalogue, tool calls or model messages. */
export async function editSettings(ctx: ExtensionContext, initial: SettingsDocument,
  update: (revision: string, patch: ObjectValue) => Promise<SettingsDocument>, signal: AbortSignal, timeout: number): Promise<void> {
  let document = initial;
  const options = { signal, timeout };
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
      !Object.hasOwn(field.schema, 'const') && ['string', 'number', 'integer', 'boolean'].includes(String(field.schema.type));
    while (!signal.aborted) {
      const changes = leaves.filter((f) => JSON.stringify(at(draft, f.path)) !== JSON.stringify(at(document.values, f.path)));
      const labels = leaves.map((f, i) => `${i + 1}. ${pathLabel(f.path)}: ${clean(display(at(draft, f.path)))}${editable(f) ? '' : ' [read-only]'}`);
      const save = `Save changes (${changes.length})`;
      const choice = await ctx.ui.select(clean([document.title, feedback, document.warning,
        document.applyTo ? `Applies to: ${document.applyTo}` : '', !document.writable ? 'Read-only' : ''].filter(Boolean).join('\n')), [...labels, save, 'Back'], options);
      if (!choice || choice === 'Back' || signal.aborted) return;
      if (choice === save) {
        if (!changes.length || !document.writable || document.conflict) continue;
        if (!valid(draft)) { ctx.ui.notify(clean(ajv.errorsText(valid.errors)), 'error'); continue; }
        const patch: ObjectValue = {};
        for (const field of changes) put(patch, field.path, at(draft, field.path));
        const preview = changes.map((f) => `${pathLabel(f.path)}: ${display(at(document.values, f.path))} → ${display(at(draft, f.path))}`).join('\n');
        // Native confirmations cannot scroll; never approve a truncated/hidden diff.
        const confirmation = `${preview}\n\nApplies to: ${clean(document.applyTo ?? 'server-defined')}`;
        const maxRows = Math.max(1, (process.stdout.rows || 24) - 12);
        const columns = Math.max(20, (process.stdout.columns || 80) - 6);
        const rows = confirmation.split('\n').reduce((sum, line) => sum + wrapTextWithAnsi(line, columns).length, 0);
        if (confirmation.length > 10_000 || rows > maxRows) {
          ctx.ui.notify('Change preview is too large for this dialog. Save fewer/smaller changes or enlarge the terminal.', 'warning');
          continue;
        }
        if (!await ctx.ui.confirm('Save child-server settings?', confirmation, options) || signal.aborted) continue;
        try {
          document = await update(document.revision, patch);
          feedback = 'Settings saved';
          break;
        } catch {
          // Uncertain writes and conflicts require a fresh get, never an automatic replay.
          ctx.ui.notify('Settings save failed or conflicted. Reopen /mcp-settings to read current values; do not replay blindly.', 'error');
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
        const selected = await ctx.ui.select(title, labels, options);
        if (!selected || signal.aborted) continue;
        next = choices[labels.indexOf(selected)].value;
      } else {
        const text = await ctx.ui.input(title, String(at(draft, field.path) ?? ''), options);
        if (text === undefined || signal.aborted) continue;
        next = field.schema.type === 'string' ? text : text.trim() ? Number(text) : NaN;
        if (typeof next === 'number' && !Number.isFinite(next)) { ctx.ui.notify('Enter a finite number', 'error'); continue; }
      }
      // Model changes must stage supported reasoning in the same confirmed patch.
      if (key === 'model' && document.models && next !== siblingModel) {
        const thinkingPath = [...field.path.slice(0, -1), 'thinking'];
        const thinkingField = leaves.find((f) => JSON.stringify(f.path) === JSON.stringify(thinkingPath));
        if (thinkingField && editable(thinkingField)) {
          const levels = document.models.find((m) => m.id === next)?.thinking ?? [];
          if (!levels.length) continue;
          const thinking = await ctx.ui.select('Reasoning for selected model', levels.map(clean), options);
          if (!thinking || signal.aborted) continue;
          put(draft, thinkingPath, levels[levels.map(clean).indexOf(thinking)]);
        }
      }
      put(draft, field.path, next);
    }
  }
}
