import assert from 'node:assert/strict';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { getCapabilities, setCapabilities, visibleWidth } from '@earendil-works/pi-tui';
import registerGateway from '../pi/runtime.js';

test('native previews render titled Markdown cards with expanded raw JSON, safe links and width-aware reflow', () => {
  initTheme('dark', false);
  const capabilities = getCapabilities();
  setCapabilities({ ...capabilities, hyperlinks: true });
  const renderers = new Map<string, Function>();
  const theme: any = { fg: (_: string, value: string) => value, bold: (value: string) => `\x1b[1m${value}\x1b[22m` };
  registerGateway({
    registerFlag() {}, getFlag() {}, events: { on() {} }, registerCommand() {}, registerTool() {}, on() {},
    registerEntryRenderer: (name: string, renderer: Function) => renderers.set(name, renderer),
    sendMessage: () => assert.fail('Previews must remain outside model context'),
    sendUserMessage: () => assert.fail('Previews must not start a model turn'),
  } as any, async () => {});
  const render = (text: string) => renderers.get('gateway-native-preview')!({ data: { title: 'Sample · Tasks', text } }, {}, theme);
  const json = JSON.stringify({ PR: 'https://github.com/kvidzibo/mcp-session-gateway/pull/53',
    Worktree: '/tmp/mcp-settings-autosave · feat/settings-autosave-tokens' }, null, 2);
  try {
    const card = render(`Autosave service settings and show estimated prompt tokens\n\nWorktree: /tmp/mcp-settings-autosave\nBranch: feat/settings-autosave-tokens\n\n${json}`);
    const raw = card.render(140).join('\n');
    const plain = stripVTControlCharacters(raw);
    assert.match(plain, /Sample · Tasks/);
    assert.doesNotMatch(plain, /display only|not sent to model/);
    assert.match(raw, /\x1b\[1mAutosave service settings and show estimated prompt tokens/);
    assert.match(plain, /Worktree: \/tmp\/mcp-settings-autosave/);
    assert.match(plain, /Branch: feat\/settings-autosave-tokens/);
    assert.match(plain, /```json/);
    for (const line of json.split('\n')) assert.ok(plain.includes(line), `JSON remains expanded: ${line}`);
    assert.match(plain, /╭.*╮/);
    assert.match(plain, /╰─+╯/);
    for (const prefix of ['{starts with brace}\nmore', '[plain note]', '```js\nunclosed']) {
      const separate = stripVTControlCharacters(render(`Title\n\n${prefix}\n\n${json}`).render(140).join('\n'));
      assert.match(separate, /```json/);
      for (const line of json.split('\n')) assert.ok(separate.includes(line));
    }
    assert.match(stripVTControlCharacters(render('Title\n\n[1,\n\n{"value": 2}\n]').render(60).join('\n')), /```json/);
    for (const width of [0, 1, 2, 7, 8, 20, 60, 100, 140]) {
      assert.ok(card.render(width).every((line: string) => visibleWidth(line) <= width), `Overflow at ${width}`);
    }
    assert.equal(stripVTControlCharacters(card.render(140).join('\n')), plain, 'Resizing back restores all content');
    initTheme('light', false); card.invalidate();
    assert.notEqual(card.render(140).join('\n'), raw, 'Theme invalidation recolors Markdown');
    const markdown = render('Safe title\x1b[31m\n\n**Bold**\n\n- [x] Complete\n- [ ] Pending\n\n[PR](https://example.com/pr) [Action](pi-gateway-action://unsafe) [File](file:///tmp/unsafe) [Credentials](https://user:pass@example.com/)');
    const linked = markdown.render(140).join('\n');
    assert.match(linked, /\x1b\]8;;https:\/\/example.com\/pr/);
    assert.doesNotMatch(linked, /\x1b\]8;;(?:pi-gateway-action:|file:|https:\/\/user:pass)/);
    assert.doesNotMatch(linked, /\x1b\[31m/);
    assert.match(stripVTControlCharacters(linked), /Complete/);
    assert.match(stripVTControlCharacters(linked), /Pending/);
    assert.match(stripVTControlCharacters(linked), /Action/);
    setCapabilities({ ...capabilities, hyperlinks: false });
    const fallback = render('Title\n\n[Action](pi-gateway-action://unsafe) [File](file:///tmp/unsafe) [Credentials](https://user:pass@example.com/)').render(140).join('\n');
    assert.doesNotMatch(fallback, /\x1b\]8;;/);
    assert.match(stripVTControlCharacters(fallback), /file:\/\/\/tmp\/unsafe/, 'Literal destinations remain visible, as in the old text preview');
    const invalid = stripVTControlCharacters(render('Title\n\n{not JSON}').render(60).join('\n'));
    assert.match(invalid, /\{not JSON\}/);
    assert.doesNotMatch(invalid, /```json/);
    assert.match(stripVTControlCharacters(render('Title\n\n[1, 2]').render(60).join('\n')), /```json/);
    assert.doesNotMatch(stripVTControlCharacters(render('Only a title').render(60).join('\n')), /```json/);
    for (const empty of ['{}', '{\n}', '[]', '[\n]']) {
      const text = stripVTControlCharacters(render(`Title\n\nBody\n\n${empty}`).render(60).join('\n'));
      assert.match(text, /Body/);
      assert.doesNotMatch(text, /```json|[{}\[\]]/);
      assert.doesNotMatch(stripVTControlCharacters(render(`Title\n\n${empty}`).render(60).join('\n')), /```json/);
    }
    const wide = render('界'.repeat(80) + '\n\n' + 'Long body '.repeat(50));
    for (const width of [1, 8, 28, 100]) assert.ok(wide.render(width).every((line: string) => visibleWidth(line) <= width));
    assert.equal(renderers.get('gateway-native-preview')!({ data: { text: 'Missing title' } }, {}, theme), undefined);
  } finally {
    setCapabilities(capabilities);
  }
});
