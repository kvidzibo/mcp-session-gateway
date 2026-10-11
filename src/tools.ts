import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export function modelVisible(tool: Tool): boolean {
  const ui = tool._meta?.ui as { visibility?: string[] } | undefined;
  return !ui?.visibility || ui.visibility.includes('model');
}
