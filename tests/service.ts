import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'gateway-test-service', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'identity', description: 'Return this service identity', inputSchema: { type: 'object' } },
    {
      name: 'echo',
      description: 'Echo arguments and gateway metadata',
      inputSchema: {
        type: 'object',
        properties: { value: {} },
        required: ['value'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const identity = {
    sessionId: process.env.MCP_GATEWAY_SESSION_ID,
    serviceId: process.env.MCP_GATEWAY_SERVICE_ID,
    workspace: process.env.MCP_GATEWAY_WORKSPACE,
    cwd: process.cwd(),
  };
  const observedMeta = extra._meta ?? {};

  if (request.params.name === 'identity') {
    const result = { ...identity, meta: observedMeta };
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
    };
  }

  if (request.params.name === 'echo') {
    const result = {
      ...identity,
      arguments: request.params.arguments ?? {},
      meta: observedMeta,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
    };
  }

  return {
    content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
    isError: true,
  };
});

const transport = new StdioServerTransport();
process.stdin.once('end', () => {
  void server.close();
});

await server.connect(transport);
