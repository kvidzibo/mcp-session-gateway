import { z } from 'zod';

// Private, versioned terminal UI protocol, not the HTML MCP Apps extension.
export const UI_MIME = 'application/vnd.mcp-native-ui+json';
export const UI_CONTEXT = 'native-ui/context';
export const UI_STATE = 'native-ui/state';
const text = z.string().max(20_000);
const scalar = z.union([text, z.number().finite(), z.boolean(), z.null()]);
export const ContextSchema = z.object({ conversationId: z.string().min(1).max(256), state: z.record(z.string(), z.unknown()) });
const control = z.object({
  id: z.string().min(1).max(256), label: text, icon: z.string().max(8).optional(), description: text.optional(),
  kind: z.enum(['action', 'text', 'number', 'toggle', 'select']),
  value: scalar.optional(), multiline: z.boolean().optional(),
  options: z.array(z.object({ label: text, value: scalar })).max(256).optional(),
  confirm: text.optional(),
}).strict();
export const ViewSchema = z.object({
  version: z.literal(1), title: text, revision: z.string().min(1).max(256),
  state: z.record(z.string(), z.unknown()), body: text.optional(),
  controls: z.array(control).max(256),
  footer: z.array(z.object({ text, url: z.string().max(2048).optional(), width: z.number().int().min(3).max(1000).optional() }).strict()).max(128).optional(),
}).strict().superRefine((view, ctx) => {
  if (new Set(view.controls.map((c) => c.id)).size !== view.controls.length) ctx.addIssue({ code: 'custom', message: 'Duplicate control IDs' });
  if (JSON.stringify(view.state).length > 8192) ctx.addIssue({ code: 'custom', message: 'UI state exceeds 8 KiB' });
});
export const ActionSchema = z.object({
  method: z.literal('native-ui/action'),
  params: z.object({ uri: z.string().max(4096), revision: z.string().min(1).max(256), action: z.string().min(1).max(256), value: scalar.optional(), _meta: z.record(z.string(), z.unknown()).optional() }),
});
export const ActionResultSchema = z.object({ view: ViewSchema, draft: text.optional(), preview: text.optional() });
export const ChangedSchema = z.object({ method: z.literal('notifications/native-ui/changed'), params: z.object({ uri: z.string().max(4096) }) });
export type NativeView = z.infer<typeof ViewSchema>;
export type NativeControl = z.infer<typeof control>;

export function clean(text: string): string {
  return text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 20_000);
}
export function footerText(view: NativeView, clip: (text: string, width: number) => string = (text) => text): string {
  return (view.footer ?? []).map(({ text, url, width }) => {
    const label = clip(clean(text).replace(/\n/g, ' '), width ?? 60);
    if (!url || /[\s\u0000-\u001f\u007f-\u009f]/u.test(url)) return label;
    try {
      const target = new URL(url);
      if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password) return label;
      return `\x1b]8;;${target.href}\x1b\\${label}\x1b]8;;\x1b\\`;
    } catch { return label; }
  }).join('');
}
