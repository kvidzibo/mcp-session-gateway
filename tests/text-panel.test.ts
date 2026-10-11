import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { showText } from '../pi/text-panel.js';

test('text panels ignore superseded reads and stop publishing after disconnect or disposal', async () => {
  const lifetime = new AbortController(), connection = new AbortController();
  const reads: { signal: AbortSignal; publish: (text: string) => void; finish: (text: string) => void }[] = [];
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  await showText({ ui: { custom: async (factory: Function) => {
    let closed = false, renders = 0;
    const terminal = { rows: 12, columns: 40 };
    const panel = factory({ terminal, requestRender: () => { renders++; } }, { fg: (_: string, text: string) => text }, {}, () => { closed = true; });
    const text = () => panel.render(terminal.columns).join('\n');
    try {
      await tick();
      reads[0].publish('initial');
      assert.match(text(), /initial/);
      panel.handleInput('r'); await tick();
      assert.equal(reads[0].signal.aborted, true);
      reads[0].publish('stale'); reads[0].finish('stale');
      reads[1].finish(Array.from({ length: 30 }, (_, i) => `Line ${i} 字`).join('\n')); await tick();
      assert.doesNotMatch(text(), /stale/);
      panel.handleInput('\x1b[6~');
      assert.doesNotMatch(text(), /Line 0 /);
      for (const columns of [1, 20, 40, 80]) {
        terminal.columns = columns;
        const lines = panel.render(columns);
        assert.ok(lines.length <= terminal.rows - 2);
        assert.ok(lines.every((line: string) => visibleWidth(line) <= columns));
        if (columns >= 20) assert.match(lines.at(-1), /Esc/);
      }
      connection.abort();
      assert.match(text(), /Gateway disconnected/);
      panel.handleInput('r'); await tick();
      assert.equal(reads.length, 2);
      lifetime.abort(); assert.equal(closed, true);
    } finally { panel.dispose(); }
    const before = renders;
    reads[1].publish('disposed'); await tick();
    assert.equal(renders, before);
  } } } as any, 'Read-only data', (signal, publish) => new Promise((finish) => reads.push({ signal, publish, finish })), lifetime.signal, connection.signal);
});
