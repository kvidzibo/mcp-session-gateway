import { DynamicBorder, keyText, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, ScrollView, Text, truncateToWidth, wrapTextWithAnsi, sliceByColumn, type TuiMouseEvent } from '@earendil-works/pi-tui';
import { cleanUnbounded } from '../src/native-ui.js';
import { GatewayMenu, inlineHeight } from './menu.js';
import { CallHistory, type CallStatus, type RetainedCall } from './call-history.js';
import type { Counts } from './call-counts.js';

/** Readable text previews; expansion preserves the complete retained response. */
function resultPreview(value: string): string {
  try {
    const result = JSON.parse(value);
    if (Array.isArray(result?.content)) {
      const texts = result.content.flatMap((item: { type?: string; text?: unknown } | null) => item?.type === 'text' && typeof item.text === 'string' ? [item.text] : []);
      if (texts.length) return cleanUnbounded(texts.join('\n'));
    }
  } catch { /* Retention truncation or a plain error message. */ }
  return value;
}

export async function inspectCalls(ctx: ExtensionContext, menu: GatewayMenu, history: CallHistory,
  service: string, status: CallStatus, counts: () => Counts | undefined, signal: AbortSignal): Promise<void> {
  const path = ['Gateway', 'Tool calls', service, status];
  while (!signal.aborted) {
    const calls = history.filtered(service, status);
    const total = counts()?.[status] ?? 0;
    const id = await menu.choose(path, `${calls.length} retained / ${total} session ${status} · ${Math.max(0, total - calls.length)} payloads unavailable · memory only`,
      calls.map((call) => ({ id: call.id, label: `${new Date(call.started).toLocaleTimeString()} · ${call.tool}`, description: `Parameters: ${call.parameters.replace(/\s+/g, ' ').slice(0, 100)} · Result: ${resultPreview(call.output).replace(/\s+/g, ' ').slice(0, 100)}` })),
      undefined, { shortcuts: [{ key: 'r', label: 'r refresh', id: '__refresh' }] });
    if (!id) return;
    const call = calls.find((call) => call.id === id);
    if (call) await showCall(ctx, history, call, signal);
  }
}

/** Native temporary screen, not an overlay. Each payload expands independently. */
async function showCall(ctx: ExtensionContext, history: CallHistory, call: RetainedCall, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await ctx.ui.custom<void>((tui, theme, keys, done) => {
    const expanded = [false, false];
    let selected = 0, reveal = false, usable = false, backRow = 0;
    let sectionRows: number[] = [];
    const text = new Text('', 0, 0);
    const scroll = new ScrollView(text, { scrollbar: 'hidden' });
    const border = new DynamicBorder((value) => theme.fg('border', value));
    const close = () => done();
    const toggle = () => {
      if (selected === 2) { close(); return; }
      expanded[selected] = !expanded[selected];
      reveal = true;
    };
    const unsubscribe = history.subscribe(() => tui.requestRender());
    signal.addEventListener('abort', close, { once: true });
    const component = {
      render(width: number): string[] {
        const height = inlineHeight(tui, width, component);
        usable = height >= 10 && width >= 28;
        if (!usable) return [truncateToWidth('Enlarge terminal · Esc back', width)];
        const confirm = keyText('tui.select.confirm'), cancel = keyText('tui.select.cancel');
        const sections = [call.parameters, call.output].map((value, i) => {
          const previewValue = i === 1 ? resultPreview(value) : value;
          const preview = wrapTextWithAnsi(previewValue.replace(/\s+/g, ' '), width);
          const body = expanded[i] ? value : preview.slice(0, 2).map((line, index) => index === 1 && preview.length > 2 ? `${sliceByColumn(line, 0, width - 1)}…` : line).join('\n');
          const label = i === 0 ? 'Parameters' : call.status === 'failure' ? 'Result / error' : 'Result';
          return `${theme.fg(selected === i ? 'accent' : 'muted', `${selected === i ? '›' : ' '} ${label} · ${expanded[i] ? 'expanded [Collapse]' : 'preview [Expand]'}`)}\n${body}`
            .split('\n').flatMap((line) => wrapTextWithAnsi(line, width));
        });
        sectionRows = [0, sections[0].length + 1];
        text.setText([...sections[0], '', ...sections[1]].join('\n'));
        const lines = scroll.render(width);
        const page = height - 6;
        scroll.updateLayout(lines.length, page, () => tui.requestRender());
        if (reveal && selected < 2) scroll.scrollTo(sectionRows[selected]);
        reveal = false;
        const body = lines.slice(scroll.scrollTop, scroll.scrollTop + page);
        backRow = body.length + 3;
        const hint = width < 60 ? `${cancel.split('/')[0]} back · Tab · ${confirm} toggle` : `Tab section · ${confirm} toggle · ↑↓/Pg scroll · ${cancel} back`;
        return [...border.render(width), truncateToWidth(theme.fg('accent', `${call.service} › ${call.tool.replace(/\n/g, ' ')} · ${call.status}`), width),
          ...body, '',
          truncateToWidth(theme.fg(selected === 2 ? 'accent' : 'muted', `${selected === 2 ? '›' : ' '} Back`), width),
          truncateToWidth(theme.fg('muted', hint), width), ...border.render(width)];
      },
      handleInput(data: string) {
        if (keys.matches(data, 'tui.select.cancel')) close();
        else if (!usable) return;
        else if (matchesKey(data, Key.tab)) { selected = (selected + 1) % 3; reveal = true; }
        else if (keys.matches(data, 'tui.select.confirm')) toggle();
        else if (keys.matches(data, 'tui.select.down')) scroll.scrollBy(1);
        else if (keys.matches(data, 'tui.select.up')) scroll.scrollBy(-1);
        else if (keys.matches(data, 'tui.select.pageDown')) scroll.scrollBy(scroll.viewportHeight);
        else if (keys.matches(data, 'tui.select.pageUp')) scroll.scrollBy(-scroll.viewportHeight);
        tui.requestRender();
      },
      handleMouse(event: TuiMouseEvent) {
        if (!usable) return;
        if (event.type === 'wheel') { scroll.scrollBy(event.wheelDelta ?? 0); return { handled: true, render: true }; }
        if (event.type !== 'click' || event.button !== 'left' || event.ctrl || event.alt || event.shift) return;
        const section = sectionRows.findIndex((row) => row - scroll.scrollTop + 2 === event.y);
        if (section < 0 && event.y !== backRow) return;
        selected = section < 0 ? 2 : section;
        toggle();
        return { handled: true, render: true };
      },
      invalidate() { text.invalidate(); },
      dispose() { unsubscribe(); signal.removeEventListener('abort', close); },
    };
    return component;
  });
}
