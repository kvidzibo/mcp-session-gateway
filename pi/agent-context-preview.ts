import { DynamicBorder, keyText, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, ScrollView, Text, truncateToWidth, wrapTextWithAnsi, type TuiMouseEvent } from '@earendil-works/pi-tui';
import type { ServiceConfig } from '../src/config.js';
import { cleanUnbounded } from '../src/native-ui.js';
import { agentContextLabels, agentContextRaw, agentContextTokens, type AgentContextCatalog } from './agent-context.js';
import { inlineHeight } from './menu.js';

export interface ContextSnapshot {
  services: ServiceConfig[];
  catalog: AgentContextCatalog;
}

/** Private, temporary native inline screen. No model messages or session entries. */
export async function previewAgentContext(ctx: ExtensionContext, source: (signal: AbortSignal) => Promise<ContextSnapshot>,
  signal: AbortSignal, connection?: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await ctx.ui.custom<void>((tui, theme, keys, done) => {
    let controller = new AbortController(), disposed = false, closed = false;
    let snapshot: ContextSnapshot | undefined, status = 'Loading…', raw = false;
    let selected = '', reveal = false, usable = false, backRow = 0;
    const expanded = new Set<string>();
    let rows: { id: string; row: number; expandable: boolean }[] = [];
    const text = new Text('', 0, 0);
    const scroll = new ScrollView(text, { scrollbar: 'hidden' });
    const border = new DynamicBorder((value) => theme.fg('border', value));
    const close = () => { if (closed) return; closed = true; controller.abort(); done(); };
    const disconnect = () => { controller.abort(); snapshot = undefined; status = 'Gateway disconnected'; tui.requestRender(); };
    const refresh = () => {
      if (disposed || closed || signal.aborted || connection?.aborted) return;
      controller.abort(); controller = new AbortController();
      const operation = AbortSignal.any([signal, controller.signal, ...(connection ? [connection] : [])]);
      snapshot = undefined; status = 'Loading…'; scroll.scrollToStart();
      tui.requestRender();
      void Promise.resolve().then(() => { operation.throwIfAborted(); return source(operation); }).then((value) => {
        if (disposed || closed || operation.aborted) return;
        snapshot = value; status = ''; reveal = true; tui.requestRender();
      }, (error: unknown) => {
        if (disposed || closed || operation.aborted) return;
        status = `Error: ${cleanUnbounded(String(error))}`; tui.requestRender();
      });
    };
    const toggle = () => {
      if (raw || selected === '__back') { close(); return; }
      if (!rows.find((row) => row.id === selected)?.expandable) return;
      if (expanded.has(selected)) expanded.delete(selected); else expanded.add(selected);
      reveal = true;
    };
    signal.addEventListener('abort', close, { once: true });
    connection?.addEventListener('abort', disconnect, { once: true });
    if (connection?.aborted) disconnect(); else refresh();
    const component = {
      render(width: number): string[] {
        const height = inlineHeight(tui, width, component);
        usable = height >= 10 && width >= 28;
        if (!usable) return [truncateToWidth('Enlarge terminal · Esc back', width)];
        const lines: string[] = [];
        rows = [];
        const add = (value: string, indent = 0) => lines.push(...cleanUnbounded(value).split('\n')
          .flatMap((line) => wrapTextWithAnsi(line, width - indent).map((line) => `${' '.repeat(indent)}${line}`)));
        const row = (id: string, label: string, expandable: boolean, indent = 0, disabled = false) => {
          rows.push({ id, row: lines.length, expandable });
          const marker = expandable ? expanded.has(id) ? '▾' : '▸' : '·';
          lines.push(...wrapTextWithAnsi(theme.fg(disabled ? 'dim' : selected === id ? 'accent' : 'muted', `${selected === id ? '›' : ' '} ${' '.repeat(indent)}${marker} ${cleanUnbounded(label)}`), width));
        };
        const injected = snapshot ? agentContextRaw(snapshot.catalog) : '';
        if (status) add(status);
        else if (raw) add(injected || 'No gateway catalog will be added: injection is off or selected services have no available model-visible tools.');
        else if (snapshot) {
          for (const service of [...snapshot.services].sort((a, b) =>
            Number(a.enabled === false) - Number(b.enabled === false) || a.name.localeCompare(b.name))) {
            const entry = snapshot.catalog.find((entry) => entry.name === service.name);
            const id = `service:${service.name}`;
            if (!selected) selected = id;
            const tokens = agentContextTokens(agentContextRaw(entry ? [entry] : []));
            row(id, `${service.name} · ${agentContextLabels[service.agentContext ?? 'off']} · ≈${tokens.toLocaleString('en-US')} tokens${service.enabled === false ? ' · disabled (locked)' : ''}`, !!entry?.tools?.length, 0, service.enabled === false);
            if (entry?.description) add(entry.description, 4);
            else if (service.description) add(service.description, 4);
            if (!entry) add(service.enabled === false ? 'Saved preference retained; enable the service to change it.' : 'Not injected: off or no available model-visible tools.', 4);
            else if (!entry.tools) add('Service-only entry · no tool details or schemas injected.', 4);
            if (expanded.has(id)) for (const tool of entry?.tools ?? []) {
              const toolId = `tool:${tool.name}`;
              const tokens = Math.ceil(JSON.stringify(tool, null, 2).length / 4);
              row(toolId, `${tool.name} · ≈${tokens.toLocaleString('en-US')} tokens${tool.inputSchema ? '' : ' · schema not injected'}`, !!tool.inputSchema, 2);
              if (tool.description) add(tool.description, 6);
              if (expanded.has(toolId) && tool.inputSchema) {
                add('Input schema', 6);
                add(JSON.stringify(tool.inputSchema, null, 2), 6);
              }
            }
            add('');
          }
          if (!snapshot.catalog.length) add('No gateway catalog will be added: injection is off or selected services have no available model-visible tools.');
        }
        rows.push({ id: '__back', row: lines.length, expandable: false });
        if (!raw && !status && !rows.some((row) => row.id === selected)) selected = rows[0].id;
        text.setText(lines.join('\n'));
        const rendered = scroll.render(width);
        const page = height - (width < 60 ? 8 : 7);
        scroll.updateLayout(rendered.length, page, () => tui.requestRender());
        if (reveal && !raw && selected !== '__back') scroll.scrollTo(rows.find((row) => row.id === selected)?.row ?? 0);
        reveal = false;
        const body = rendered.slice(scroll.scrollTop, scroll.scrollTop + page);
        backRow = body.length + 4;
        const up = keyText('tui.select.up'), down = keyText('tui.select.down');
        const confirm = keyText('tui.select.confirm'), cancel = keyText('tui.select.cancel');
        const action = raw ? 'back' : 'toggle';
        const hints = width < 60
          ? [`${up}/${down} ${raw ? 'scroll' : 'select'} · ${confirm} ${action}`, `Tab ${raw ? 'tree' : 'raw'} · Pg · r · ${cancel.split('/')[0]}`]
          : [`Tab ${raw ? 'tree' : 'raw'} · ${up}/${down} ${raw ? 'scroll' : 'select'} · ${confirm} ${action} · ${keyText('tui.select.pageUp')}/${keyText('tui.select.pageDown')} scroll · r refresh · ${cancel} back`];
        return [...border.render(width), truncateToWidth(theme.fg('accent', `Gateway › Agent context › Preview · ${raw ? 'Raw' : 'Tree'}`), width),
          truncateToWidth(theme.fg('muted', `≈${agentContextTokens(injected).toLocaleString('en-US')} tokens · rough estimate · display only`), width),
          ...body, '', theme.fg(raw || selected === '__back' ? 'accent' : 'muted', `${raw || selected === '__back' ? '›' : ' '} Back`),
          ...hints.map((hint) => truncateToWidth(theme.fg('muted', hint), width)), ...border.render(width)];
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.escape) || keys.matches(data, 'tui.select.cancel')) close();
        else if (!usable) return;
        else if (matchesKey(data, Key.tab)) { raw = !raw; scroll.scrollToStart(); reveal = !raw; }
        else if (keys.matches(data, 'tui.select.confirm')) toggle();
        else if (keys.matches(data, 'tui.select.down') || keys.matches(data, 'tui.select.up')) {
          const direction = keys.matches(data, 'tui.select.down') ? 1 : -1;
          if (raw) scroll.scrollBy(direction);
          else { selected = rows[Math.max(0, Math.min(rows.length - 1, rows.findIndex((row) => row.id === selected) + direction))].id; reveal = true; }
        } else if (keys.matches(data, 'tui.select.pageDown')) scroll.scrollBy(scroll.viewportHeight);
        else if (keys.matches(data, 'tui.select.pageUp')) scroll.scrollBy(-scroll.viewportHeight);
        else if (matchesKey(data, Key.home)) scroll.scrollToStart();
        else if (matchesKey(data, Key.end)) scroll.scrollToEnd();
        else if (data === 'r') refresh();
        tui.requestRender();
      },
      handleMouse(event: TuiMouseEvent) {
        if (!usable) return;
        if (event.type === 'wheel') { scroll.scrollBy(event.wheelDelta ?? 0); return { handled: true, render: true }; }
        if (event.type !== 'click' || event.button !== 'left' || event.ctrl || event.alt || event.shift) return;
        const target = event.y === backRow ? '__back' : !raw && event.y >= 3 && event.y < backRow - 1
          ? rows.find((row) => row.id !== '__back' && row.row - scroll.scrollTop + 3 === event.y)?.id : undefined;
        if (!target) return;
        selected = target; toggle(); return { handled: true, render: true };
      },
      invalidate() { text.invalidate(); },
      dispose() {
        disposed = true; controller.abort(); signal.removeEventListener('abort', close);
        connection?.removeEventListener('abort', disconnect);
      },
    };
    return component;
  });
}
