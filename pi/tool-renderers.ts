import { keyHint, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Container, Text, getCapabilities, imageFallback, truncateToWidth, type Component } from '@earendil-works/pi-tui';
import { cleanUnbounded } from '../src/native-ui.js';
import type { gatewayTools } from './definitions.js';

const safe = (text: string) => cleanUnbounded(text.replace(/\t/g, '    '));
const literal = (value: unknown) => safe(String(value)).replace(/\n/g, ' ');
const json = (value: unknown, pretty = true) => JSON.stringify(value, null, pretty ? 2 : undefined) ?? '';
function parsed(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}
const duration = (ms: number) => ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round(ms % 60_000 / 1000)}s`;

// Limit terminal rows after native layout, not source lines (long Markdown paragraphs wrap).
function preview(component: Component, expanded: boolean, rows: number, hint = false): Component {
  return {
    render(width) {
      if (width < 1) return [];
      const lines = component.render(width).map((line) => truncateToWidth(line, width));
      if (expanded) return lines;
      const clipped = lines.length > rows;
      const output = lines.slice(0, rows);
      if (clipped || hint) output.push(truncateToWidth(keyHint('app.tools.expand', 'for full arguments and raw result'), width));
      return output;
    },
    invalidate() { component.invalidate(); },
  };
}

export const gatewayCallRenderers: Pick<ToolDefinition<typeof gatewayTools.call.parameters>, 'renderCall' | 'renderResult'> = {
  renderCall(args, theme, context) {
    const name = typeof args?.name === 'string' ? safe(args.name) : 'gateway_call';
    const split = name.indexOf('__');
    const title = split < 0 ? name : `${name.slice(0, split)} › ${name.slice(split + 2)}`;
    const body = new Container();
    body.addChild(new Text(theme.fg('toolTitle', theme.bold(literal(title))), 0, 0));
    const argumentsText = json(args?.arguments, context.expanded);
    if (argumentsText) body.addChild(new Text(theme.fg('muted', safe(argumentsText)), 0, 0));
    if (context.isPartial) body.addChild(new Text(theme.fg('muted', context.executionStarted ? 'Running…' : context.argsComplete ? 'Pending' : 'Receiving arguments…'), 0, 0));
    return preview(body, context.expanded, 3);
  },
  renderResult(result, { expanded, isPartial }, theme, context) {
    const body = new Container();
    const status = context.isError ? 'Error' : isPartial ? 'Running…' : 'Returned';
    const elapsed = typeof context.durationMs === 'number' ? ` · ${duration(context.durationMs)}` : '';
    body.addChild(new Text(theme.fg(context.isError ? 'error' : 'muted', status + elapsed), 0, 0));
    for (const item of result.content) {
      if (item.type === 'image') {
        // The native shell owns actual images; only supply its text fallback when hidden.
        if (!context.showImages || !getCapabilities().images) body.addChild(new Text(safe(imageFallback(item.mimeType)), 0, 0));
        continue;
      }
      if (item.type !== 'text') continue;
      const value = parsed(item.text);
      body.addChild(value !== undefined
        ? new Text(theme.fg('toolOutput', safe(json(value))), 0, 0)
        : new Text(theme.fg('toolOutput', safe(item.text)), 0, 0));
    }
    return preview(body, expanded, 12, true);
  },
};
