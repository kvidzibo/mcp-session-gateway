import { getMarkdownTheme, type Theme } from '@earendil-works/pi-coding-agent';
import { Markdown, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { clean } from '../src/native-ui.js';

/** Recognize the raw JSON handoff appended by services without changing its contents. */
function withJsonFence(body: string): string {
  const separator = Math.max(body.lastIndexOf('\n\n{'), body.lastIndexOf('\n\n['));
  const start = /^(?:\{|\[)/.test(body) ? 0 : separator < 0 ? -1 : separator + 2;
  if (start < 0) return body;
  try { JSON.parse(body.slice(start)); }
  catch { return body; }
  return `${body.slice(0, start)}\`\`\`json\n${body.slice(start)}\n\`\`\``;
}

/** Markdown must not turn service text into executable terminal action links. */
function safeLinks(line: string): string {
  return line.replace(/\x1b\]8;;([^\x07\x1b]*)(?:\x07|\x1b\\)/g, (sequence, url: string) => {
    if (!url) return sequence;
    try {
      const target = new URL(url);
      if (['http:', 'https:'].includes(target.protocol) && !target.username && !target.password) return sequence;
    } catch { /* Invalid destinations stay plain text. */ }
    return '';
  });
}

/** Display-only, always-expanded preview using Pi's native Markdown and theme. */
export function nativePreview(data: { title: string; text: string }, theme: Theme) {
  const [title, ...rest] = clean(data.text).split('\n');
  const body = rest.join('\n').replace(/^\n+|\n+$/g, '');
  const markdown = new Markdown(withJsonFence(body), 0, 0, getMarkdownTheme());
  const label = `${clean(data.title).replace(/\s+/g, ' ')} · display only · not sent to model`;
  return {
    invalidate() { markdown.invalidate(); },
    render(width: number): string[] {
      if (width < 1) return [];
      const framed = width >= 8;
      const inner = framed ? width - 4 : width;
      const heading = new Text(theme.bold(theme.fg('text', title)), 0, 0).render(inner);
      const content = [...heading, ...(body ? ['', ...markdown.render(inner)] : [])]
        .flatMap((line) => wrapTextWithAnsi(safeLinks(line), inner))
        .map((line) => truncateToWidth(line, inner, ''));
      const header = theme.fg('muted', label);
      if (!framed) return [...wrapTextWithAnsi(header, width), '', ...content]
        .map((line) => truncateToWidth(line, width, ''));
      const border = (text: string) => theme.fg('borderMuted', text);
      const fitsHeader = visibleWidth(label) <= width - 6;
      const top = fitsHeader
        ? `${border('╭─ ')}${header}${border(` ${'─'.repeat(width - visibleWidth(label) - 5)}╮`)}`
        : border(`╭${'─'.repeat(width - 2)}╮`);
      const rows = [...(fitsHeader ? [] : [...wrapTextWithAnsi(header, inner), '']), '', ...content, ''];
      return [top, ...rows.map((line) => `${border('│')} ${line}${' '.repeat(Math.max(0, inner - visibleWidth(line)))} ${border('│')}`),
        border(`╰${'─'.repeat(width - 2)}╯`)];
    },
  };
}
