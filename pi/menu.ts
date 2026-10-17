import { DynamicBorder, keyText, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Container, getKeybindings, Key, matchesKey, SelectList, Spacer, Text, truncateToWidth, wrapTextWithAnsi, type KeyId } from '@earendil-works/pi-tui';
import { clean } from '../src/native-ui.js';
import { showText } from './text-panel.js';

export interface MenuItem { id: string; label: string; description: string; disabled?: boolean }
interface MenuOptions {
  signal?: AbortSignal;
  shortcuts?: { key: KeyId; label: string; id: string }[];
}
const oneLine = (text: string) => clean(text).replace(/\n/g, ' ');

/** One navigation session: selection survives Back, never persisted as model context. */
export class GatewayMenu {
  private selected = new Map<string, string>();

  constructor(private ctx: ExtensionContext, private signal: AbortSignal) {}

  async choose(path: string[], summary: string, items: MenuItem[], tab?: { label: string; action: (id: string) => Promise<void> }, options: MenuOptions = {}): Promise<string | undefined> {
    const signal = options.signal ? AbortSignal.any([this.signal, options.signal]) : this.signal;
    if (signal.aborted) return;
    const shortcuts = options.shortcuts ?? [];
    const hints = [...(tab ? [`Tab ${oneLine(tab.label)}`] : []), ...shortcuts.map((shortcut) => oneLine(shortcut.label))];
    const key = path.join('/');
    const exit = path.length === 1 ? 'Close' : 'Back';
    const choices = [...items, { id: '__back', label: exit, description: path.length === 1 ? 'Return to Pi.' : `Return to ${path.at(-2)}.` }];
    const choose = () => this.ctx.ui.custom<string | { tab: string } | undefined>((tui, theme, _keys, done) => {
      let list: SelectList | undefined, geometry = '', usable = false;
      const remembered = choices.findIndex((item) => item.id === this.selected.get(key));
      let selected = remembered >= 0 ? remembered : choices.findIndex((item) => !item.disabled);
      const cancel = () => done(undefined);
      signal.addEventListener('abort', cancel, { once: true });
      return {
        render(width: number) {
          const height = Math.max(1, tui.terminal.rows - 6); // Leave room for Pi's footer and service widgets.
          geometry = `${width}:${tui.terminal.rows}:${tui.terminal.columns}`;
          usable = height >= 10 && width >= 28;
          if (!usable) return [truncateToWidth('Enlarge terminal · Esc back', width)];
          selected = list ? choices.findIndex((item) => item.id === list!.getSelectedItem()?.value) : selected;
          const detail = choices[Math.max(0, selected)];
          const compact = height < 13;
          const description = wrapTextWithAnsi(oneLine(detail.description), width).slice(0, compact ? 1 : 2);
          const summaryLines = summary && !compact ? [truncateToWidth(oneLine(summary), width)] : [];
          const showHints = hints.length > 0 && !compact;
          const rows = Math.max(1, Math.min(10, height - description.length - summaryLines.length - 8 - (showHints ? 1 : 0)));
          list = new SelectList(choices.map((item) => ({ value: item.id, label: `${oneLine(item.label)}${item.disabled ? ' (unavailable)' : ''}` })), rows, {
            selectedPrefix: (s) => theme.fg('accent', s), selectedText: (s) => theme.fg(detail.disabled ? 'dim' : 'accent', s),
            description: (s) => theme.fg('muted', s), scrollInfo: (s) => theme.fg('dim', s), noMatch: (s) => s,
          });
          list.setSelectedIndex(Math.max(0, selected));
          list.onSelect = (item) => {
            if (!signal.aborted && !choices.find((choice) => choice.id === item.value)?.disabled) done(item.value);
          };
          list.onCancel = cancel;
          const container = new Container();
          const border = new DynamicBorder((text) => theme.fg('border', text));
          const text = (value: string, color: 'accent' | 'muted' = 'muted') => new Text(theme.fg(color, value.split('\n').map((line) => truncateToWidth(line, width)).join('\n')), 0, 0);
          container.addChild(border);
          container.addChild(text((width < 60 ? path.slice(-2) : path).map(oneLine).join(' › '), 'accent'));
          container.addChild(text(summaryLines.join('\n')));
          container.addChild(new Spacer(1));
          container.addChild(list);
          container.addChild(new Spacer(1));
          container.addChild(text(description.join('\n')));
          container.addChild(new Spacer(1));
          if (showHints) container.addChild(text(hints.join(' · ')));
          const up = keyText('tui.select.up'), down = keyText('tui.select.down');
          const confirm = keyText('tui.select.confirm'), cancelKeys = keyText('tui.select.cancel');
          container.addChild(text(width < 60
            ? `${up}/${down} · ${confirm} · ${cancelKeys.split('/')[0]}${width < 36 ? '' : ` ${exit.toLowerCase()}`}`
            : `${up}/${down} navigate · ${confirm} select · ${cancelKeys} ${exit.toLowerCase()}`));
          container.addChild(border);
          return container.render(width).map((line) => line.trimEnd());
        },
        handleInput: (data: string) => {
          if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c')) || getKeybindings().matches(data, 'tui.select.cancel')) cancel();
          else if (usable && geometry.endsWith(`:${tui.terminal.rows}:${tui.terminal.columns}`)) {
            const id = list?.getSelectedItem()?.value;
            const shortcut = shortcuts.find((shortcut) => matchesKey(data, shortcut.key));
            if (shortcut) done(shortcut.id);
            else if (tab && matchesKey(data, Key.tab)) {
              if (id && id !== '__back' && !choices.find((item) => item.id === id)?.disabled) done({ tab: id });
            } else list?.handleInput(data);
          }
          const id = list?.getSelectedItem()?.value;
          if (id && id !== '__back') this.selected.set(key, id);
          tui.requestRender();
        },
        invalidate() { list?.invalidate(); },
        dispose: () => signal.removeEventListener('abort', cancel),
      };
    });
    while (!signal.aborted) {
      const picked = await choose();
      if (picked && typeof picked === 'object') {
        if (!signal.aborted) await tab!.action(picked.tab);
      } else return picked === '__back' ? undefined : picked;
    }
  }

  info(path: string[], text: string): Promise<void> {
    return showText(this.ctx, path.join(' › '), clean(text), this.signal);
  }
}
