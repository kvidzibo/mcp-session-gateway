import { getMarkdownTheme, type Theme } from '@earendil-works/pi-coding-agent';
import { Markdown, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { clean } from '../src/native-ui.js';

/** Render appended JSON separately so an unfinished note fence cannot swallow it. */
function markdownSections(body: string): string[] {
  const separator = Math.max(body.lastIndexOf('\n\n{'), body.lastIndexOf('\n\n['));
  for (const start of separator < 0 ? [0] : [separator + 2, 0]) {
    const json = body.slice(start);
    if (!/^(?:\{|\[)/.test(json)) continue;
    let value: object;
    try { value = JSON.parse(json); }
    catch { continue; }
    return [body.slice(0, start).replace(/\n+$/g, ''),
      Object.keys(value).length ? `\`\`\`json\n${json}\n\`\`\`` : ''];
  }
  return [body];
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
  const sections = markdownSections(body).filter(Boolean).map((text) => new Markdown(text, 0, 0, getMarkdownTheme()));
  const label = clean(data.title).replace(/\s+/g, ' ');
  return {
    invalidate() { for (const section of sections) section.invalidate(); },
    render(width: number): string[] {
      if (width < 1) return [];
      const framed = width >= 8;
      const inner = framed ? width - 4 : width;
      const heading = new Text(theme.bold(theme.fg('text', title)), 0, 0).render(inner);
      const content = [...heading, ...sections.flatMap((section) => ['', ...section.render(inner)])]
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
