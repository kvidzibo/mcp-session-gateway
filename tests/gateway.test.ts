import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const servicePath = path.join(here, 'service.ts');
const cliPath = path.join(projectRoot, 'src', 'cli.ts');
const gatewayMeta = (sessionId: string, serviceId: string) => ({
  'local-stdio-mcp-gateway/sessionId': sessionId,
  'local-stdio-mcp-gateway/serviceId': serviceId,
});

test('stdio gateway isolates sessions and routes names, arguments, and metadata', { timeout: 20_000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'mcp-gateway-test-'));
  const configPath = path.join(tempDir, 'config.json');
  const serverConfig = {
    command: process.execPath,
    args: ['--import', 'tsx', servicePath],
    cwd: projectRoot,
    env: { MCP_GATEWAY_SESSION_ID: 'spoofed', MCP_GATEWAY_SERVICE_ID: 'spoofed', MCP_GATEWAY_WORKSPACE: 'spoofed' },
  };
  const clients: Array<{ client: Client; transport: StdioClientTransport }> = [];
  try {
    for (const [i, configKey] of ['mcpServers', 'servers'].entries()) {
      await writeFile(configPath, JSON.stringify({
        [configKey]: { alpha: serverConfig, beta: serverConfig },
        timeoutMs: 5000,
      }));
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--import', import.meta.resolve('tsx'), cliPath, '--config', configPath],
        cwd: tempDir,
        stderr: 'pipe',
      });
      const client = new Client({ name: `gateway-test-${i}`, version: '1.0.0' });
      clients.push({ client, transport });
      let stderr = '';
      transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      try {
        await client.connect(transport);
      } catch (error) {
        throw new Error(`Gateway connection failed: ${stderr}`, { cause: error });
      }
    }

    const listed = await Promise.all(clients.map(({ client }) => client.listTools()));
    for (const result of listed) {
      assert.deepEqual(
        result.tools.map(({ name }) => name).sort(),
        ['alpha__echo', 'alpha__identity', 'beta__echo', 'beta__identity', 'gateway__identity'],
      );
    }

    const identities = await Promise.all(clients.map(async ({ client }) => {
      const gateway = await client.callTool({ name: 'gateway__identity' });
      assert.ok(gateway.structuredContent);
      const gatewayIdentity = gateway.structuredContent as { sessionId: string };
      assert.equal(typeof gatewayIdentity.sessionId, 'string');
      assert.ok(gatewayIdentity.sessionId.length > 0);

      const children = await Promise.all(['alpha', 'beta'].map(async (serviceId) => {
        const result = await client.callTool({
          name: `${serviceId}__identity`,
          _meta: {
            'local-stdio-mcp-gateway/sessionId': 'caller-spoofed-session',
            'local-stdio-mcp-gateway/serviceId': 'caller-spoofed-service',
          },
        });
        assert.ok(result.structuredContent);
        const content = result.structuredContent as {
          sessionId: string;
          serviceId: string;
          workspace: string;
          cwd: string;
          meta: { sessionId: string; serviceId: string };
        };
        assert.equal(content.sessionId, gatewayIdentity.sessionId);
        assert.equal(content.serviceId, serviceId);
        assert.equal(content.workspace, tempDir, 'Launch workspace overrides configured spoofing');
        assert.equal(content.cwd, projectRoot, 'Child cwd remains independent from workspace');
        assert.deepEqual(content.meta, gatewayMeta(gatewayIdentity.sessionId, serviceId));
        return content;
      }));
      return { client, sessionId: gatewayIdentity.sessionId, children };
    }));

    assert.notEqual(identities[0].sessionId, identities[1].sessionId);
    assert.equal(identities[0].children[0].sessionId, identities[0].children[1].sessionId);
    assert.equal(identities[1].children[0].sessionId, identities[1].children[1].sessionId);

    for (const { client, sessionId } of identities) {
      for (const serviceId of ['alpha', 'beta']) {
        const result = await client.callTool({
          name: `${serviceId}__echo`,
          arguments: { value: `routed-to-${serviceId}`, extra: 42 },
          _meta: {
            'local-stdio-mcp-gateway/sessionId': 'caller-spoofed-session',
            'local-stdio-mcp-gateway/serviceId': 'caller-spoofed-service',
            callerField: 'preserved',
          },
        });
        assert.ok(result.structuredContent);
        const echoed = result.structuredContent as {
          sessionId: string;
          serviceId: string;
          arguments: { value: string; extra: number };
          meta: { sessionId: string; serviceId: string };
        };
        assert.equal(echoed.sessionId, sessionId);
        assert.equal(echoed.serviceId, serviceId);
        assert.deepEqual(echoed.arguments, { value: `routed-to-${serviceId}`, extra: 42 });
        assert.deepEqual(echoed.meta, { ...gatewayMeta(sessionId, serviceId), callerField: 'preserved' });
      }

      await assert.rejects(
        client.callTool({ name: 'missing__tool', arguments: {} }),
        /unknown|not found|tool/i,
      );
    }
  } finally {
    await Promise.all(clients.map(async ({ client, transport }) => {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }));
    await rm(tempDir, { recursive: true, force: true });
  }
});
