import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { editSettings } from '../pi/settings.js';
import type { SettingsDocument } from '../src/settings.js';

test('roles autosave nested fields, toggles and multiline prompts while incomplete new roles stay drafts', async () => {
  const role = { type: 'object', title: 'Role', additionalProperties: false, properties: {
    model: { type: 'string', title: 'Model', enum: ['test/before', 'test/after'] },
    thinking: { type: 'string', title: 'Thinking', enum: ['off', 'high'], default: 'off' },
    tools: { type: 'array', title: 'Tools', uniqueItems: true, items: { type: 'string', enum: ['*', 'read', 'bash'] }, default: [] },
    extensions: { type: 'boolean', title: 'Extensions', default: false },
    prompt: { type: 'string', title: 'Prompt', minLength: 1, pattern: '\\S', 'x-multiline': true, default: '' },
    enabled: { type: 'boolean', title: 'Enabled', default: true },
  }, required: ['model', 'thinking', 'tools', 'extensions', 'prompt', 'enabled'] };
  const original = { model: 'test/before', thinking: 'off', tools: ['read'], extensions: false, prompt: 'Original', enabled: true };
  const document: SettingsDocument = { schemaVersion: 1, title: 'Roles', revision: 'one', writable: true,
    applyTo: 'future-jobs', models: [
      { id: 'test/before', label: 'Before', available: true, thinking: ['off'] },
      { id: 'test/after', label: 'After', available: true, thinking: ['off', 'high'] },
    ], schema: { type: 'object', additionalProperties: false, properties: { agents: {
      type: 'object', properties: { recon: role }, required: ['recon'], additionalProperties: role,
      propertyNames: { pattern: '^[a-z][a-z0-9_-]{0,63}$' },
    } }, required: ['agents'] }, values: { agents: { recon: original } } };
  // Each step drives a real native component, not a mocked selection result.
  const steps: [string, string[]][] = [
    ['Roles', ['recon', '\r']],
    ['Roles › recon', ['1. Model', '\r']],
    ['agents/recon/model', ['After', '\r']],
    ['Reasoning for selected model', ['high', '\r']],
    ['Roles › recon', ['1. Model', '\r']],
    ['agents/recon/model', ['Before', '\r']],
    ['Reasoning for selected model', ['\u001b']],
    ['Roles › recon', ['5. Prompt', '\r']],
    ['agents/recon/prompt', ['\u0001', '\u000b', '\r']],
    ['Roles › recon', ['3. Tools', '\r']],
    ['agents/recon/tools', ['bash', '\r']],
    ['agents/recon/tools', ['\u001b']],
    ['Roles › recon', ['3. Tools', '\r']],
    ['agents/recon/tools', ['"*"', '\r']],
    ['agents/recon/tools', ['read', '\r']],
    ['agents/recon/tools', ['read', '\r']],
    ['agents/recon/tools', ['Done', '\r']],
    ['Roles › recon', ['4. Extensions', '\r']],
    ['agents/recon/extensions', ['true', '\r']],
    ['Roles › recon', ['5. Prompt', '\r']],
    ['agents/recon/prompt', ['\u0001', '\u000b', '\u001b[200~Inspect only.\nReport evidence.\u001b[201~', '\r']],
    ['Roles › recon', ['\u001b']],
    ['Roles', ['Add role', '\r']],
    ['Add role: name', ['constructor', '\r']],
    ['Roles', ['Add role', '\r']],
    ['Add role: name', ['recon', '\r']],
    ['Roles', ['Add role', '\r']],
    ['Add role: name', ['writer', '\r']],
    ['Roles › writer', ['1. Model', '\r']],
    ['agents/writer/model', ['After', '\r']],
    ['Reasoning for selected model', ['off', '\r']],
    ['Roles › writer', ['5. Prompt', '\r']],
    ['agents/writer/prompt', ['Write documentation.', '\r']],
    ['Roles › writer', ['\u001b']],
    ['Roles', ['Add role', '\r']],
    ['Add role: name', ['discarded', '\r']],
    ['Roles › discarded', ['1. Model', '\r']],
    ['agents/discarded/model', ['After', '\r']],
    ['Reasoning for selected model', ['off', '\r']],
    ['Roles › discarded', ['5. Prompt', '\r']],
    ['agents/discarded/prompt', ['Incomplete', '\u001b']],
    ['Roles › discarded', ['Back', '\r']],
    ['Roles', ['recon', '\r']],
    ['Roles › recon', ['6. Enabled', '\r']],
    ['agents/recon/enabled', ['false', '\r']],
    ['Roles › recon', ['\u001b']],
    ['Roles', ['\u001b']],
  ];
  let saves = 0;
  const notices: string[] = [];
  const ctx = { ui: { notify: (message: string) => notices.push(message), custom: async (factory: Function, options?: { overlay?: boolean }) => {
    const step = steps.shift();
    assert.ok(step, 'No unexpected dialogs');
    let answer: unknown, complete = false;
    const terminal = { rows: 30, columns: 90 };
    const panel = factory({ terminal, requestRender() {} }, { fg: (_: string, text: string) => text }, {}, (value: unknown) => { answer = value; complete = true; });
    const render = () => {
      const lines: string[] = panel.render(terminal.columns);
      assert.ok(lines.length <= terminal.rows - (options?.overlay ? 2 : 6));
      assert.ok(lines.every((line) => visibleWidth(line) <= terminal.columns));
      return lines.join('\n');
    };
    try {
      panel.focused = true;
      assert.equal(panel.focused, true);
      assert.ok(render().includes(step[0]), `Expected ${step[0]} in ${render()}`);
      if (step[0] === 'Roles') {
        assert.match(render(), saves ? /recon — test\/after · reasoning: high/ : /recon — test\/before · reasoning: off/);
        if (saves >= 5) assert.match(render(), /writer — test\/after · reasoning: off/);
      }
      if (step[0] === 'Roles › writer' && step[1][0] === '1. Model') {
        assert.match(render(), /Tools: \[\]/);
        assert.match(render(), /Extensions: false/);
        assert.match(render(), /Prompt: ""/);
      }
      if (step[0] === 'Roles › recon' && step[1][0] === '\u001b') assert.match(render(), /Prompt: 2 lines \(≈8 tokens\)/);
      if (step[0] === 'Roles › discarded') {
        assert.match(render(), /new draft/);
        assert.match(render(), /Draft invalid — not saved/);
      }
      for (const key of step[1]) { panel.handleInput(key); render(); }
      assert.ok(complete, `Dialog completed: ${step[0]}`);
      return answer;
    } finally { panel.dispose(); }
  } } } as unknown as ExtensionContext;
  const expected: Record<string, object>[] = [
    { recon: { model: 'test/after', thinking: 'high' } },
    { recon: { tools: ['bash', 'read'] } },
    { recon: { extensions: true } },
    { recon: { prompt: 'Inspect only.\nReport evidence.' } },
    { writer: { model: 'test/after', thinking: 'off', tools: [], extensions: false, prompt: 'Write documentation.', enabled: true } },
    { recon: { enabled: false } },
  ];
  let current = structuredClone(document);
  await editSettings(ctx, document, async (revision, patch) => {
    assert.equal(revision, current.revision);
    assert.deepEqual(patch, { agents: expected[saves++] });
    const agents = current.values.agents as Record<string, object>;
    for (const [name, value] of Object.entries(patch.agents as Record<string, object>)) agents[name] = { ...agents[name], ...value };
    current = { ...current, revision: String(saves) };
    return structuredClone(current);
  }, new AbortController().signal);
  assert.equal(saves, expected.length);
  assert.equal(steps.length, 0);
  assert.match(notices[0], /Edit not saved; previous value restored/);
  assert.deepEqual(notices.slice(1), ['Enter a valid, unused name', 'Enter a valid, unused name']);
  assert.deepEqual(document.values, { agents: { recon: original } }, 'No mutation of the source settings');
});

test('role summaries use configured values without a catalogue and filtering opens the matching role', async () => {
  const role = { type: 'object', properties: {
    model: { type: 'string' }, thinking: { type: 'string' },
  } };
  let dialogs = 0;
  const ctx = { ui: { custom: async (factory: Function) => {
    let answer: unknown;
    const panel = factory({ terminal: { rows: 30, columns: 90 }, requestRender() {} },
      { fg: (_: string, text: string) => text }, {}, (value: unknown) => { answer = value; });
    try {
      const render = () => panel.render(90).join('\n');
      if (dialogs++ === 0) {
        assert.match(render(), /recon — missing\/model · reasoning: off/);
        assert.match(render(), /review — provider\/review · reasoning: high/);
        assert.match(render(), /plain\n/, 'Unrelated collection entries retain their plain names');
        panel.handleInput('PROVIDER/REVIEW HIGH');
        assert.match(render(), /→ review — provider\/review · reasoning: high/);
        assert.doesNotMatch(render(), /recon —/);
        panel.handleInput('\r');
      } else {
        assert.match(render(), /Roles › review/);
        assert.match(render(), /model: "provider\/review"/);
        controller.abort();
      }
      return answer;
    } finally { panel.dispose(); }
  } } } as unknown as ExtensionContext;
  const controller = new AbortController();
  await editSettings(ctx, { schemaVersion: 1, title: 'Roles', revision: 'one', writable: false,
    schema: { type: 'object', properties: { agents: { type: 'object', properties: {}, additionalProperties: role } } },
    values: { agents: {
      recon: { model: 'missing/model', thinking: 'off' },
      review: { model: 'provider/review', thinking: 'high' }, plain: {},
    } } }, async () => assert.fail('Browsing cannot write settings'), controller.signal);
  assert.equal(dialogs, 2);
});

test('failed autosave stops editing without retrying an uncertain or conflicting write', async () => {
  for (const failure of ['revision conflict', 'uncertain write']) {
    let dialogs = 0, updates = 0;
    const notices: string[] = [];
    const ctx = { ui: {
      notify: (text: string) => notices.push(text),
      custom: async (factory: Function) => {
        assert.ok(++dialogs <= 2, 'No editing after the failed update');
        let answer: unknown;
        const panel = factory({ terminal: { rows: 30, columns: 90 }, requestRender() {} },
          { fg: (_: string, text: string) => text }, {}, (value: unknown) => { answer = value; });
        try {
          panel.render(90);
          panel.handleInput('\r');
          return answer;
        } finally { panel.dispose(); }
      },
    } } as unknown as ExtensionContext;
    await editSettings(ctx, { schemaVersion: 1, title: 'Settings', revision: 'one', writable: true,
      schema: { type: 'object', properties: { enabled: { type: 'boolean' } } }, values: { enabled: false } },
    async (revision, patch) => {
      updates++;
      assert.equal(revision, 'one');
      assert.deepEqual(patch, { enabled: true });
      throw new Error(failure);
    }, new AbortController().signal);
    assert.equal(updates, 1);
    assert.equal(dialogs, 2);
    assert.match(notices[0], /Reopen.*do not replay blindly/);
  }
});
