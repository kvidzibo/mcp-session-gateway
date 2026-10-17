import assert from 'node:assert/strict';
import test from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getKeybindings, visibleWidth } from '@earendil-works/pi-tui';
import { editSettings, selectSettingsOption, settingsValidationSchema } from '../pi/settings.js';

const theme = { fg: (_color: string, text: string) => text };

test('settings search filters immediately, preserves original choice identity and fits after resize', async () => {
  const choices = Array.from({ length: 1500 }, (_, i) => `${i + 1}. Model ${i} — provider/model-${i}`);
  choices[1400] = '1401. Grok fast — xai/grok-fast';
  choices[1450] = '1451. Grok reasoning — xai/grok-reasoning';
  const controller = new AbortController();
  let nextKey = '\u001b[B', confirmKey = '\r';
  const ctx = { ui: { custom: async (factory: Function, options?: unknown) => {
    assert.equal(options, undefined, 'Settings stay inline rather than opening an overlay');
    let answer: unknown, completed = false;
    const terminal = { rows: 80, columns: 80 };
    const panel = factory({ terminal, requestRender() {} }, theme, {}, (value: unknown) => { answer = value; completed = true; });
    const render = () => {
      const lines: string[] = panel.render(terminal.columns);
      assert.ok(lines.length <= terminal.rows - 6, 'Leave room for footer and service counters');
      assert.ok(lines.every((line) => visibleWidth(line) <= terminal.columns));
      assert.ok(lines.some((line) => line.includes('Enter') && line.includes('Esc')), 'Selection and Back hints remain visible');
      return lines.join('\n');
    };
    try {
      panel.focused = true;
      assert.equal(panel.focused, true);
      assert.ok(render().split('\n').length <= 19, 'Large catalogues remain compact on tall terminals');
      panel.handleInput('XAI GROK');
      assert.match(render(), /1401\. Grok fast/);
      assert.doesNotMatch(render(), /provider\/model-/);
      panel.handleInput(nextKey);
      terminal.rows = 14; terminal.columns = 28;
      assert.match(render(), /→ 1451\. Grok reasoning/);
      panel.handleInput('nomatch');
      assert.match(render(), /No matching choices/);
      panel.handleInput(confirmKey);
      assert.equal(completed, false, 'Enter cannot select a hidden stale result');
      panel.handleInput('\u0001'); panel.handleInput('\u000b');
      assert.match(render(), /→ 1\. Model 0/);
      terminal.rows = 10;
      assert.match(panel.render(terminal.columns).join('\n'), /Enlarge terminal/);
      panel.handleInput(confirmKey);
      assert.equal(completed, false, 'Undersized inline settings cannot select');
      terminal.rows = 14;
      render();
      panel.handleInput('grok reasoningX'); panel.handleInput('\u007f');
      // Input and Enter can arrive before the scheduled repaint.
      panel.handleInput(confirmKey);
      assert.equal(completed, true);
      return answer;
    } finally { panel.dispose(); }
  } } } as unknown as ExtensionContext;
  assert.equal(await selectSettingsOption(ctx, 'Model', choices, { signal: controller.signal }), choices[1450]);
  const keys = getKeybindings(), original = keys.getUserBindings();
  try {
    keys.setUserBindings({ ...original, 'tui.select.down': 'ctrl+n', 'tui.select.confirm': 'tab' });
    nextKey = '\u000e'; confirmKey = '\t';
    assert.equal(await selectSettingsOption(ctx, 'Model', choices, { signal: controller.signal }), choices[1450]);
  } finally { keys.setUserBindings(original); }
});

test('large settings catalogues open without compilation and compact only equivalent constant unions', async (t) => {
  const choices = Array.from({ length: 1500 }, (_, i) => ({ const: `model-${i}`, title: `Model ${i}` }));
  const schema = { type: 'object', properties: {
    model: { type: 'string', oneOf: choices },
    duplicate: { oneOf: [{ const: 1 }, { const: 1 }, { const: 2 }] },
    constrained: { oneOf: [{ const: 'ok', minLength: 3 }, { const: 'long' }] },
    intersected: { enum: ['a'], oneOf: [{ const: 'a' }, { const: 'b' }] },
  } };
  const before = structuredClone(schema);
  const compact = settingsValidationSchema(schema) as typeof schema;
  assert.deepEqual(schema, before, 'UI titles and original service schema remain intact');
  assert.equal(compact.properties.model.oneOf, undefined);
  assert.deepEqual(compact.properties.duplicate, schema.properties.duplicate);
  assert.deepEqual(compact.properties.constrained, schema.properties.constrained);
  assert.deepEqual(compact.properties.intersected, schema.properties.intersected);
  const validate = new Ajv2020({ strict: false }).compile(compact);
  assert.equal(validate({ model: 'model-1499', duplicate: 2, constrained: 'long', intersected: 'a' }), true);
  for (const value of [{ model: 'missing' }, { duplicate: 1 }, { constrained: 'ok' }, { intersected: 'b' }]) assert.equal(validate(value), false);
  const referenced = { ...schema, $defs: { alias: { $ref: '#/properties/model/oneOf/0' } } };
  assert.deepEqual(settingsValidationSchema(referenced), referenced, 'References keep their original target paths');
  const compile = t.mock.method(Ajv2020.prototype, 'compile');
  const ctx = { ui: { custom: async (factory: Function) => {
    assert.equal(compile.mock.callCount(), 0, 'Opening settings does not compile schemas');
    const panel = factory({ terminal: { rows: 24, columns: 80 }, requestRender() {} }, theme, {}, () => {});
    try { panel.render(80); panel.handleInput('\u001b'); } finally { panel.dispose(); }
    return undefined;
  } } } as unknown as ExtensionContext;
  await editSettings(ctx, { schemaVersion: 1, title: 'Large catalogue', revision: 'one', schema, writable: true, values: { model: 'model-0' } },
    async () => assert.fail('Browsing cannot write settings'), new AbortController().signal);
  assert.equal(compile.mock.callCount(), 0);
});
