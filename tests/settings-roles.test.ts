import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { editSettings } from '../pi/settings.js';
import type { SettingsDocument } from '../src/settings.js';

test('role drafts support nested fields, toggles, multiline prompts and safe creation only after review', async () => {
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
    ['Roles › writer', ['Save changes', '\r']],
    ['Save child-server settings?', ['\u001b']],
    ['Roles › writer', ['Save changes', '\r']],
    ['Save child-server settings?', ['REVIEW']],
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
      if (step[0] === 'Roles › writer' && step[1][0] === '1. Model') {
        assert.match(render(), /Tools: \[\]/);
        assert.match(render(), /Extensions: false/);
        assert.match(render(), /Prompt: ""/);
      }
      for (const key of step[1]) {
        if (key === 'REVIEW') {
          assert.equal(saves, 0);
          for (let i = 0; i < 100 && !render().includes('Enter save'); i++) { panel.handleInput('\u001b[6~'); render(); }
          assert.match(render(), /Enter save/);
          panel.handleInput('\r');
        } else panel.handleInput(key);
        render();
      }
      assert.ok(complete, `Dialog completed: ${step[0]}`);
      return answer;
    } finally { panel.dispose(); }
  } } } as unknown as ExtensionContext;
  await editSettings(ctx, document, async (revision, patch) => {
    saves++;
    assert.equal(revision, 'one');
    assert.deepEqual(patch, { agents: {
      recon: { model: 'test/after', thinking: 'high', tools: ['bash', 'read'], extensions: true, prompt: 'Inspect only.\nReport evidence.' },
      writer: { model: 'test/after', thinking: 'off', tools: [], extensions: false, prompt: 'Write documentation.', enabled: true },
    } });
    return { ...document, revision: 'two', values: { agents: { recon: { ...original, ...(patch.agents as any).recon }, writer: (patch.agents as any).writer } } };
  }, new AbortController().signal);
  assert.equal(saves, 1);
  assert.equal(steps.length, 0);
  assert.deepEqual(notices, ['Enter a valid, unused name', 'Enter a valid, unused name']);
  assert.deepEqual(document.values, { agents: { recon: original } }, 'No mutation of the source settings');
});
