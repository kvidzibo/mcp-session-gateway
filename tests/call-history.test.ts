import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { CallHistory, HISTORY_LIMIT } from '../pi/call-history.js';
import { callPayload, CALL_PAYLOAD_LIMIT } from '../src/call-events.js';
import { inspectCalls } from '../pi/call-inspector.js';
import { GatewayMenu } from '../pi/menu.js';
import { getKeybindings, visibleWidth } from '@earendil-works/pi-tui';

test('filtered inspector trims and independently expands sanitized payloads, retaining bounded interrupted history', async () => {
  const history = new CallHistory();
  const id = randomUUID();
  const parameters = callPayload({ input: 'p'.repeat(400) });
  history.event({ id, service: 'alpha', phase: 'started', tool: 'child_echo', parameters });
  history.event({ id, service: 'alpha', phase: 'success', output: callPayload({ content: [{ type: 'text', text: 'Readable result ' + '\x1b[31m' + 'r'.repeat(400) + '\x07' }] }) });
  history.event({ id: randomUUID(), service: 'beta', phase: 'started', tool: 'other' });
  const controller = new AbortController();
  let screens = 0;
  const theme = { fg: (_color: string, value: string) => value };
  const ctx: any = { ui: { custom: async (factory: Function, options: unknown) => {
    assert.equal(options, undefined, 'Inspector must use native screens, not overlays');
    let done = false;
    const component = factory({ terminal: { rows: 40, columns: 100 }, requestRender() {} }, theme, getKeybindings(), () => { done = true; });
    try {
      const render = (): string => component.render(100).join('\n');
      if (screens++ === 0) {
        assert.match(render(), /1 retained \/ 3 session success · 2 payloads unavailable/);
        assert.match(render(), /child_echo/);
        assert.doesNotMatch(render(), /other/);
        component.handleInput('\r');
      } else if (screens === 2) {
        const preview = render().split('\n');
        assert.match(preview.join('\n'), /Parameters · preview/);
        assert.match(preview.join('\n'), /Result · preview/);
        assert.match(preview.join('\n'), /Readable result/);
        const resultRow = preview.findIndex((line) => line.includes('Result · preview'));
        assert.ok(resultRow <= 6, 'Parameter previews occupy at most two visible lines');
        assert.ok(preview.indexOf('', resultRow) - resultRow <= 3, 'Result previews occupy at most two visible lines');
        assert.doesNotMatch(preview.join('\n'), /\x1b|\x07/);
        assert.equal(component.handleMouse({ type: 'click', button: 'left', x: 1, y: 2 }).handled, true);
        assert.match(render(), /Parameters · expanded/);
        assert.match(render(), /Result · preview/);
        component.handleInput('\t');
        component.handleInput('\r');
        const expanded = render();
        assert.match(expanded, /Parameters · expanded/);
        assert.match(expanded, /Result · expanded/);
        assert.doesNotMatch(expanded, /\x1b|\x07/);
        const resultHeading = expanded.split('\n').findIndex((line) => line.includes('Result · expanded'));
        component.handleMouse({ type: 'click', button: 'left', x: 1, y: resultHeading });
        assert.match(render(), /Parameters · expanded/);
        assert.match(render(), /Result · preview/);
        const narrow = component.render(32);
        assert.ok(narrow.every((line: string) => visibleWidth(line) <= 32));
        assert.match(narrow.join('\n'), /escape back/);
        component.handleInput('\x1b');
      } else component.handleInput('\x1b');
      assert.ok(done);
    } finally { component.dispose?.(); }
    return screens === 1 ? id : undefined;
  } } };
  await inspectCalls(ctx, new GatewayMenu(ctx, controller.signal), history, 'alpha', 'success', () => ({ success: 3, failure: 0, pending: 0 }), controller.signal);
  assert.equal(screens, 3);
  history.interrupt();
  const interrupted = history.filtered('beta', 'failure')[0];
  history.event({ id: interrupted.id, service: 'beta', phase: 'success', output: 'late' });
  assert.match(interrupted.output, /Interrupted/);
  for (let n = 0; n < HISTORY_LIMIT; n++) history.event({ id: randomUUID(), service: 'alpha', phase: 'started', parameters: callPayload('x'.repeat(CALL_PAYLOAD_LIMIT * 2)) });
  assert.equal(history.calls.length, HISTORY_LIMIT);
  assert.equal(history.filtered('alpha', 'success').length, 0, 'Old payloads are evicted, not reconstructed');
  assert.ok(history.calls.every((call) => call.parameters.length <= CALL_PAYLOAD_LIMIT));
  history.clear();
  assert.equal(history.calls.length, 0);
});
