import { getMarkdownTheme, keyHint, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Container, Markdown, Text, getCapabilities, imageFallback, truncateToWidth, type Component } from '@earendil-works/pi-tui';
import { cleanUnbounded } from '../src/native-ui.js';
import type { gatewayTools } from './definitions.js';

const safe = (text: string) => cleanUnbounded(text.replace(/\t/g, '    '));
const literal = (value: unknown) => safe(String(value)).replace(/\n/g, ' ');
const json = (value: unknown, pretty = true) => JSON.stringify(value, null, pretty ? 2 : undefined) ?? '';
function parsed(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
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

function envelope(text: string) {
  // Only a whole JSON document or the known delegate prefix followed by one document.
  const newline = text.indexOf('\n');
  const prefix = newline < 0 ? '' : text.slice(0, newline + 1);
  const header = /^(?:Job (\S+): [^\r\n]*\.|(?:Started|Reused) job (\S+) \([^\r\n]*\)\.)\r?\n$/.exec(prefix);
  const value = parsed(header ? text.slice(newline + 1) : text);
  if (!record(value) || !record(value.job) ||
      typeof value.job.status !== 'string' || !['queued', 'pending', 'running', 'done', 'failed', 'error', 'cancelled', 'completed'].includes(value.job.status) ||
      (value.job.answer !== undefined && typeof value.job.answer !== 'string')) return undefined;
  const jobId = value.job.jobId ?? value.jobId;
  if (typeof jobId !== 'string' || header && (header[1] ?? header[2]) !== jobId) return undefined;
  return { value, job: value.job, jobId, prefix: header ? prefix : '' };
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
    const delegate = ['delegate__delegate_status', 'delegate__delegate_start'].includes(context.args?.name);
    for (const item of result.content) {
      if (item.type === 'image') {
        // The native shell owns actual images; only supply its text fallback when hidden.
        if (!context.showImages || !getCapabilities().images) body.addChild(new Text(safe(imageFallback(item.mimeType)), 0, 0));
        continue;
      }
      if (item.type !== 'text') continue;
      const data = delegate ? envelope(item.text) : undefined;
      if (data) {
        const { job, value, jobId } = data;
        const fields = [`Job status: ${literal(job.status)}${['done', 'completed'].includes(String(job.status)) ? ' (unverified)' : ''}`];
        for (const key of ['role', 'kind', 'model', 'reasoning']) if (typeof job[key] === 'string') fields.push(`${key}: ${literal(job[key])}`);
        fields.push(`jobId: ${literal(expanded ? jobId : jobId.slice(0, 8))}`);
        const cwd = job.cwd ?? value.cwd, jobDuration = job.durationMs ?? value.durationMs;
        if (expanded && typeof cwd === 'string') fields.push(`cwd: ${literal(cwd)}`);
        if (typeof jobDuration === 'number') fields.push(`job duration: ${duration(jobDuration)}`);
        body.addChild(new Text(theme.fg('muted', fields.join(' · ')), 0, 0));
        if (typeof job.answer === 'string') body.addChild(new Markdown(safe(job.answer), 0, 0, getMarkdownTheme()));
        if (expanded) {
          body.addChild(new Text(theme.fg('muted', 'Raw result'), 0, 0));
          body.addChild(new Text(theme.fg('toolOutput', safe(data.prefix + json(value))), 0, 0));
        }
      } else {
        const value = parsed(item.text);
        body.addChild(value !== undefined
          ? new Text(theme.fg('toolOutput', safe(json(value))), 0, 0)
          : new Markdown(safe(item.text), 0, 0, getMarkdownTheme()));
      }
    }
    return preview(body, expanded, 12, true);
  },
};
