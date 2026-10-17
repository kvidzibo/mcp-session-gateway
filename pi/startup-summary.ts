import type { Theme } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { GatewayStatus } from '../src/status.js';
import { clean } from '../src/native-ui.js';

export type StartupSummary = GatewayStatus & { unavailable?: true };

/** Display-only startup snapshot. Rebuild colors on every render. */
export function startupSummary(data: StartupSummary, theme: Theme) {
  return {
    invalidate() {},
    render(width: number): string[] {
      if (width < 1) return [];
      const connected = data.services.filter((service) => service.state === 'connected').length;
      const tools = data.services.reduce((sum, service) => sum + service.tools, 0);
      const heading = theme.fg('accent', ' MCP Gateway');
      const summary = data.unavailable ? theme.fg('warning', 'Startup status unavailable')
        : theme.fg('muted', `Startup snapshot · ${connected}/${data.services.length} connected · ${tools} service ${tools === 1 ? 'tool' : 'tools'}`);
      const nameWidth = Math.min(18, Math.max(0, ...data.services.map((service) => service.name.length)));
      const inner = Math.min(76, width - 4);
      const rows = data.services.flatMap((service) => {
        const color = service.state === 'connected' ? 'success' : service.state === 'stopped' ? 'muted' : 'warning';
        const icon = service.state === 'connected' ? '✓' : service.state === 'stopped' ? '○' : '!';
        const name = truncateToWidth(service.name, nameWidth, '…', true);
        const detail = service.state === 'connected'
          ? `${service.tools} ${service.tools === 1 ? 'tool' : 'tools'}`
          : service.state === 'stopped' ? 'package not activated' : 'connection closed';
        const row = `${theme.fg(color, `${icon} ${name}  ${service.state}`)} ${theme.fg('muted', `· ${detail}`)}`;
        const names = service.state === 'connected' ? service.toolNames ?? [] : [];
        if (!names.length) return [row];
        const labels = names.map((name) => clean(name).replace(/\s+/g, ' ')).join(' · ');
        return [row, ...wrapTextWithAnsi(theme.fg('muted', labels), Math.max(1, inner - 4)).map((line) => `    ${line}`)];
      });
      if (!data.unavailable && !data.services.length) rows.push(theme.fg('muted', 'No services configured.'));
      const content = [heading, summary, '', ...rows, '', theme.fg('muted', '/pi-services  browse services')];
      if (inner < 4) return content.flatMap((line) => wrapTextWithAnsi(line, width)).map((line) => truncateToWidth(line, width, ''));
      const border = (text: string) => theme.fg('borderMuted', text);
      return [border(`╭${'─'.repeat(inner + 2)}╮`),
        ...content.flatMap((line) => wrapTextWithAnsi(line, inner)).map((line) => `${border('│')} ${line}${' '.repeat(Math.max(0, inner - visibleWidth(line)))} ${border('│')}`),
        border(`╰${'─'.repeat(inner + 2)}╯`)];
    },
  };
}
