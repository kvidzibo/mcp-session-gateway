import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { clean } from '../src/native-ui.js';

/** Read-only text, never an approval dialog. Async reads are replaced on refresh. */
export async function showText(ctx: ExtensionContext, title: string,
  source: string | ((signal: AbortSignal, publish: (text: string) => void) => Promise<string>), signal: AbortSignal, connection?: AbortSignal, lineLimit = 20_000): Promise<void> {
  if (signal.aborted) return;
  await ctx.ui.custom<void>((tui, theme, _keys, done) => {
    let controller = new AbortController();
    let text = typeof source === 'string' ? source : 'Loading…';
    let offset = 0, max = 0, page = 1, disposed = false;
    const refresh = () => {
      if (typeof source !== 'function' || connection?.aborted || disposed) return;
      controller.abort();
      controller = new AbortController();
      const current = controller;
      const operation = AbortSignal.any([signal, current.signal, ...(connection ? [connection] : [])]);
      text = 'Loading…'; offset = 0;
      tui.requestRender();
      const publish = (value: string) => { if (!operation.aborted && !disposed) { text = value; tui.requestRender(); } };
      void Promise.resolve().then(() => { operation.throwIfAborted(); return source(operation, publish); }).then(
        (result) => { if (!operation.aborted && !disposed) text = result || '(empty resource)'; },
        (error: unknown) => { if (!operation.aborted && !disposed) text = `Error: ${clean(String(error))}`; },
      ).finally(() => { if (!operation.aborted && !disposed) tui.requestRender(); });
    };
    const close = () => { controller.abort(); done(); };
    const disconnect = () => { controller.abort(); text = 'Gateway disconnected'; tui.requestRender(); };
    signal.addEventListener('abort', close, { once: true });
    connection?.addEventListener('abort', disconnect, { once: true });
    if (connection?.aborted) disconnect(); else refresh();
    return {
      render(width: number) {
        width = Math.max(1, width);
        const height = Math.max(1, tui.terminal.rows - 2);
        if (height < 6 || width < 20) return [truncateToWidth('Enlarge terminal · Esc back', width)];
        const body = text.split('\n').flatMap((line) => wrapTextWithAnsi(clean(line, lineLimit), width));
        page = height - 3;
        max = Math.max(0, body.length - page); offset = Math.min(offset, max);
        const refreshHint = typeof source === 'function' && !connection?.aborted ? 'r refresh · ' : '';
        return [theme.fg('accent', clean(title).replace(/\n/g, ' ')), ...body.slice(offset, offset + page), '',
          theme.fg('muted', width < 60 ? `↑↓ Pg · ${refreshHint ? 'r · ' : ''}Esc back` : `↑↓/PgUp/PgDn scroll · ${refreshHint}Esc back`)]
          .map((line) => truncateToWidth(line, width));
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) close();
        else if (data.toLowerCase() === 'r') refresh();
        else if (matchesKey(data, Key.down)) offset = Math.min(max, offset + 1);
        else if (matchesKey(data, Key.up)) offset = Math.max(0, offset - 1);
        else if (matchesKey(data, Key.pageDown)) offset = Math.min(max, offset + page);
        else if (matchesKey(data, Key.pageUp)) offset = Math.max(0, offset - page);
        tui.requestRender();
      },
      invalidate() {},
      dispose() {
        disposed = true; controller.abort();
        signal.removeEventListener('abort', close); connection?.removeEventListener('abort', disconnect);
      },
    };
  }, { overlay: true, overlayOptions: { width: '100%', anchor: 'center', margin: 0 } });
}
