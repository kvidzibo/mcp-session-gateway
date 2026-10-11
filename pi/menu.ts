import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, SelectList, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { clean } from '../src/native-ui.js';
import { showText } from './text-panel.js';

export interface MenuItem { id: string; label: string; description: string; disabled?: boolean }
const oneLine = (text: string) => clean(text).replace(/\n/g, ' ');

/** One navigation session: selection survives Back, never persisted as model context. */
export class GatewayMenu {
  private selected = new Map<string, string>();

  constructor(private ctx: ExtensionContext, private signal: AbortSignal) {}

  async choose(path: string[], summary: string, items: MenuItem[]): Promise<string | undefined> {
    if (this.signal.aborted) return;
    const key = path.join('/');
    const exit = path.length === 1 ? 'Close' : 'Back';
    const choices = [...items, { id: '__back', label: exit, description: path.length === 1 ? 'Return to Pi.' : `Return to ${path.at(-2)}.` }];
    const picked = await this.ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
      const signal = this.signal;
      let list: SelectList | undefined, geometry = '', usable = false;
      const remembered = choices.findIndex((item) => item.id === this.selected.get(key));
      let selected = remembered >= 0 ? remembered : choices.findIndex((item) => !item.disabled);
      const cancel = () => done(undefined);
      this.signal.addEventListener('abort', cancel, { once: true });
      return {
        render(width: number) {
          const height = Math.max(1, tui.terminal.rows - 2);
          geometry = `${width}:${tui.terminal.rows}:${tui.terminal.columns}`;
          usable = height >= 13 && width >= 28;
          if (!usable) return [truncateToWidth('Enlarge terminal · Esc back', width)];
          selected = list ? choices.findIndex((item) => item.id === list!.getSelectedItem()?.value) : selected;
          const detail = choices[Math.max(0, selected)];
          const description = wrapTextWithAnsi(oneLine(detail.description), width).slice(0, 3);
          while (description.length < 3) description.push('');
          const summaryLines = clean(summary).split('\n').flatMap((line) => wrapTextWithAnsi(line, width)).slice(0, Math.min(3, height - 12));
          const rows = Math.max(1, Math.min(12, height - description.length - summaryLines.length - 8));
          list = new SelectList(choices.map((item) => ({ value: item.id, label: `${oneLine(item.label)}${item.disabled ? ' (unavailable)' : ''}` })), rows, {
            selectedPrefix: (s) => theme.fg('accent', s), selectedText: (s) => theme.fg(detail.disabled ? 'dim' : 'accent', s),
            description: (s) => theme.fg('muted', s), scrollInfo: (s) => theme.fg('dim', s), noMatch: (s) => s,
          });
          list.setSelectedIndex(Math.max(0, selected));
          list.onSelect = (item) => {
            if (!signal.aborted && !choices.find((choice) => choice.id === item.value)?.disabled) done(item.value);
          };
          list.onCancel = cancel;
          const border = theme.fg('accent', '─'.repeat(width));
          return [border, theme.fg('accent', (width < 60 ? path.slice(-2) : path).map(oneLine).join(' › ')), ...summaryLines.map((line) => theme.fg('muted', line)), '',
            ...list.render(width), '', ...description.map((line) => theme.fg('muted', line)), '',
            theme.fg('muted', width < 50 ? `↑↓ choose · Enter · Esc ${exit.toLowerCase()}` : `↑/↓ choose · Enter open · Esc ${exit.toLowerCase()}`), border]
            .map((line) => truncateToWidth(line, width));
        },
        handleInput: (data: string) => {
          if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) cancel();
          else if (usable && geometry.endsWith(`:${tui.terminal.rows}:${tui.terminal.columns}`)) list?.handleInput(data);
          const id = list?.getSelectedItem()?.value;
          if (id && id !== '__back') this.selected.set(key, id);
          tui.requestRender();
        },
        invalidate() { list?.invalidate(); },
        dispose: () => this.signal.removeEventListener('abort', cancel),
      };
    }, { overlay: true, overlayOptions: { width: '100%', anchor: 'center', margin: 0 } });
    return picked === '__back' ? undefined : picked;
  }

  info(path: string[], text: string): Promise<void> {
    return showText(this.ctx, path.join(' › '), clean(text), this.signal);
  }
}
