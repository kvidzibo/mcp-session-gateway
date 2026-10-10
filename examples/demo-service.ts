import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';

let counter = 0;
const server = new Server({ name: 'gateway-demo', version: '1.0.0' }, { capabilities: { tools: {}, resources: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'increment', description: 'Ask approval, then increment the in-memory counter.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: 'demo://counter', name: 'Demo counter', mimeType: 'text/plain' }] }));
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri !== 'demo://counter') throw new Error('Unknown resource');
  return { contents: [{ uri: request.params.uri, mimeType: 'text/plain', text: `Counter: ${counter}` }] };
});
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (request.params.name !== 'increment') throw new Error('Unknown tool');
  if (!server.getClientCapabilities()?.elicitation?.form) return { content: [{ type: 'text', text: 'Confirmation UI unavailable; nothing changed.' }], isError: true };
  const result = await server.elicitInput({
    mode: 'form',
    message: 'Increment the in-memory demo counter?',
    requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean', title: 'Confirm increment' } }, required: ['confirm'] },
  }, { signal: extra.signal });
  if (result.action !== 'accept') return { content: [{ type: 'text', text: result.action === 'decline' ? 'Request declined.' : 'Request cancelled.' }], isError: true };
  if (extra.signal.aborted || result.content?.confirm !== true) return { content: [{ type: 'text', text: 'Confirmation missing.' }], isError: true };
  counter += 1;
  return { content: [{ type: 'text', text: `Counter is ${counter}.` }] };
});
await server.connect(new StdioServerTransport());
