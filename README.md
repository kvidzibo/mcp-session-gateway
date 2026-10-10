# Local stdio MCP gateway

A small TypeScript MCP gateway. Each launch generates a UUID, starts local MCP servers, and exposes their tools through one stdio connection.

```text
Pi A ⇄ gateway A ⇄ child MCP processes A
Pi B ⇄ gateway B ⇄ child MCP processes B
```

No HTTP, sockets, cookies, or shared daemon. This first version proxies tools, not resources, prompts, sampling, elicitation, tasks, or agent wake-up events.

## Setup

Requires Node.js 22+ and the runtimes needed by your child servers.

```bash
npm ci
npm run build
cp gateway.example.json gateway.json
```

Edit `gateway.json` with actual MCP server commands:

```json
{
  "timeoutMs": 30000,
  "servers": {
    "files": {
      "command": "node",
      "args": ["/absolute/path/to/files-mcp.js"],
      "cwd": "."
    },
    "database": {
      "command": "uvx",
      "args": ["your-database-mcp-package"],
      "env": { "DATABASE_URL": "${DATABASE_URL}" }
    }
  }
}
```

Commands are executables, not shell expressions. `cwd` defaults to the config directory; relative `cwd` values resolve there. Arguments are passed literally. Server names use lowercase letters, digits, and hyphens, starting with a letter; `gateway` is reserved.

Child processes receive the MCP SDK's minimal default environment plus configured `env`. Other parent environment variables are **not** inherited automatically. `${VARIABLE}` references in `env` resolve from the gateway environment; missing variables fail startup. Keep credentials out of checked-in config files.

## Connect Pi

Add an entry to your Pi `mcp.json`, merging it with existing entries. Replace paths with your checkout and config locations:

```json
{
  "mcpServers": {
    "gateway": {
      "command": "node",
      "args": [
        "/absolute/path/to/mcp-session-gateway/dist/cli.js",
        "--config",
        "/absolute/path/to/mcp-session-gateway/gateway.json"
      ],
      "description": "Local service tools with a per-run gateway identity"
    }
  }
}
```

Pi reads personal entries from `~/.pi/agent/mcp.json` and trusted project entries from `.pi/mcp.json`. Run `pi mcp list` to diagnose the connection, or `/reload` after configuration changes in an existing Pi session. No Pi extension is required.

Tools are named `<server>__<tool>` by the gateway, for example `files__read_file`. Pi adds its own MCP namespace. Namespaced tool names must fit MCP's 128-character name limit. Duplicate or invalid names fail discovery. Paginated tool discovery and tool-list change notifications are supported. Task-required tools are omitted.

## Identity

Call `gateway__identity` to get `{ "sessionId": "<uuid>" }`.

Every child service receives:

| Environment variable | Value |
|---|---|
| `MCP_GATEWAY_SESSION_ID` | Same UUID for all children of this gateway |
| `MCP_GATEWAY_SERVICE_ID` | Service name from config |

Every forwarded tool call also receives request `_meta`:

```json
{
  "local-stdio-mcp-gateway/sessionId": "<uuid>",
  "local-stdio-mcp-gateway/serviceId": "files"
}
```

These values override caller/config attempts to replace them; tool arguments are unchanged. Other request metadata is preserved, while progress tokens are translated between connections. Child services can forward the identity to their own APIs or logs.

**The identity belongs to the gateway run, not the Pi conversation.** Reconnect, restart, or reload creates a new UUID. Switching conversations inside Pi may also recreate the gateway. Persistent conversation identity would require additional Pi integration.

Identity is a correlation label, **not authentication or a sandbox**. All configured servers execute with your OS permissions, and only trusted executables should be configured. Tool annotations are upstream hints, not security guarantees.

## Logs

Gateway and child-server diagnostics go to **both stderr and an append-only file**.
The default is `gateway.log` beside your config. Set a top-level `"logFile": "logs/gateway.log"`
to choose another path; relative paths resolve beside the config, not the working directory.
The parent directory must already exist and be writable. New files use owner-only permissions (`0600`).

Monitor the default log:

```bash
tail -F /absolute/path/to/config-directory/gateway.log
```

Restarts and concurrent gateway runs append without truncation. Writes are immediately
visible; external rotation is supported because each append reopens the path. No automatic
rotation or size limit is provided. Child stderr is copied verbatim; stdout remains MCP-only.
Tool arguments/results are not logged by the gateway, but child diagnostics may contain
sensitive data. Config/argument errors before logging is initialized appear only on stderr.
An unwritable log prevents startup; a later write failure reports to stderr and triggers cleanup.

## Lifecycle and validation

All configured servers must initialize successfully. Startup fails and awaits child cleanup if any server fails. Upstream EOF is observed during startup; incoming initialization messages are buffered up to 1 MiB until services are ready. A child disconnect removes its tools; reconnect the gateway to restart it. Tool calls have the configured timeout and propagate cancellation. No automatic tool-call retries are performed.

Closing stdin or sending SIGINT/SIGTERM closes the gateway and its direct child processes. Child shutdown allows 500 ms after EOF, then 500 ms after SIGTERM, before SIGKILL (with up to 1 second to observe exit). This shorter budget prevents an upstream MCP client's shutdown deadline from killing the gateway before it cleans up children. Commands that detach or launch unmanaged descendants need their own cleanup; avoid such wrappers. Gateway and child diagnostics use stderr and the log file; stdout is reserved for MCP messages. A failed gateway stderr stream triggers cleanup and suppresses further stderr output; file logging remains available during cleanup.

```bash
npm run check
npm test
npm run build
```

The integration tests run real gateway processes and verify identity isolation, downstream identity propagation, namespaced routing, unknown-tool rejection, and cleanup of stubborn children after startup timeout, raw upstream EOF, SDK-managed shutdown, or a closed stderr reader.
