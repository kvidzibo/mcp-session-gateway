# Local stdio MCP gateway

A small TypeScript MCP gateway. Each launch generates a UUID, starts local MCP servers, and exposes their generic tools and manually-read resources through one stdio connection.

```text
Pi A ⇄ gateway A ⇄ child MCP processes A
Pi B ⇄ gateway B ⇄ child MCP processes B
```

No HTTP, sockets, cookies, shared daemon, subscriptions, or custom events. The optional Pi adapter owns one MCP SDK client and provides generic tool discovery/calls, a native resource panel, reusable child-server settings, and boolean one-shot approval prompts. Sampling, tasks, resource templates, and browser-based MCP Apps are not forwarded.

## Setup

Requires Node.js 22+ and the runtimes needed by your child servers. The optional adapter is tested with Pi 1.1.0 (which requires Node.js 22.19+).

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

## Connect Pi (built-in MCP alternative)

Use the optional extension instead of adding the gateway to `mcp.json`; never register the same gateway in both places. Load the extension explicitly with the config flag:

```bash
pi --extension /absolute/path/to/local-stdio-mcp-gateway/pi/gateway.ts --gateway-config /absolute/path/to/gateway.json
```

The extension starts one stdio gateway on `session_start`, creates no process at load time, and closes it idempotently at shutdown. The gateway inherits Pi’s environment so `${VARIABLE}` config references work; service processes still receive only their configured environment plus SDK defaults. `gateway_tools` discovers live model-callable tools, `gateway_call` validates each call against its advertised JSON Schema (2020-12), and `/gateway-panel [gateway-resource-uri]` manually lists or reads resources. The adapter registers no resource tools; panel contents are not added to the conversation. An agent can still access the same OS through other tools: this routing is not a secrecy boundary. UI-only tools are omitted and rejected; tools visible to both model and app remain callable. The standalone gateway remains usable without Pi packages.

Approvals use ordinary MCP `elicitation/create`, not an agent-visible tool result. Services must request a flat form with one required boolean field; other forms are cancelled. Allow once returns `accept` with that field set to `true`; Decline and Cancel remain distinct. No UI, timeout, disconnect, or aborted calls cannot grant approval. Dialogs are serialized, and incoming confirmations are cancelled while the panel is open. No credentials are collected. Services must check the decision before performing the operation.

Each service processes one forwarded request at a time, allowing stdio confirmations to be attributed to the active tool without custom request metadata. Separate services can run concurrently. Resource reads do not trigger approval prompts. Resource URIs are wrapped as `gateway-resource://<service>/<percent-encoded-original-uri>`; returned content URIs are wrapped too.

To use Pi's built-in MCP client instead, add an entry to `mcp.json` as below and do not load the adapter. Replace paths with your checkout and config locations:

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

## Child-server settings

With the optional Pi adapter, use **`/mcp-settings`** to select a child service, or
**`/mcp-settings delegate`** to open one directly. Settings are discovered from the
child's schema, not hardcoded service names or the parent Pi model catalogue.
Edits stay in a local draft until **Save changes** shows the exact changes and you
confirm. Escape/Back discards the draft; declining a save leaves it editable.
Oversized confirmation previews are refused: save fewer/smaller changes or enlarge
the terminal. Settings dialogs and one-shot approval prompts cannot overlap.

Enable only services implementing the [operator settings contract](docs/settings.md):

```json
{
  "servers": {
    "delegate": {
      "command": "pi-delegate-mcp",
      "args": ["--workspace", "/absolute/path/to/project"],
      "settings": { "tokenEnv": "PI_DELEGATE_SETTINGS_TOKEN" }
    }
  }
}
```

The same configuration works for another service by selecting its documented token
environment variable. The gateway generates private per-service tokens; never put
tokens in config or prompts. Only opted-in, connected services advertising contract
version 1 appear. Services without settings continue to work normally.

The editor supports nested objects with string, number, integer, boolean, enum and
constant-choice fields, plus read-only hints. Unsupported controls (arrays, references,
complex unions, secrets) are not editable. JSON Schema constraints are checked before
saving; the child remains responsible for validation, atomic persistence and revisions.
Optional model/reasoning catalogues follow pi-delegate's contract: unavailable models
cannot be selected, and model changes select supported reasoning in the same save.
No automatic fallback is chosen. Current unavailable values remain visible.

pi-delegate applies changes to **future jobs**; running/queued jobs retain their
settings. Other services report their own apply policy. Conflicts/uncertain writes
require reopening the menu to read current state; saves are never replayed automatically.
Manual external changes may require collecting/cancelling work before restarting the
child. `/reload` restarts the gateway and its children—do not use it to save settings.

Settings use authenticated custom RPC on the existing connections, never tools,
resources or model messages. Pi's built-in MCP alternative has no `/mcp-settings`.
The adapter creates no settings route without a UI. This is routing isolation, **not
a sandbox**: trusted services and agents with OS access can still inspect files/processes.
See [the reusable protocol](docs/settings.md) for other clients and service authors.

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

Identity is a correlation label, **not authentication or a sandbox**. All configured servers execute with your OS permissions; Pi's `bash` tool has the same OS access, so this is not a security boundary. One-shot confirmations are cooperative service prompts, not general permission enforcement. Only configure trusted executables. Tool annotations are upstream hints, not security guarantees.

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

All configured servers must initialize successfully. Startup fails and awaits child cleanup if any server fails. The upstream handshake happens first so child clients only advertise form elicitation when the harness supports it. Tool and resource requests wait for child startup; upstream EOF is observed throughout. A child disconnect removes its tools; reconnect the gateway to restart it. Tool calls have the configured timeout and propagate cancellation. No automatic tool-call retries are performed. Cancelling or timing out a started service request (including resource reads) retires that service connection and removes its tools/resources until gateway restart (`/reload` in the adapter). MCP cancellation has no completion acknowledgement; retiring prevents late confirmations being attributed to another call. Other services stay connected.

Closing stdin or sending SIGINT/SIGTERM closes the gateway and its direct child processes. Child shutdown allows 500 ms after EOF, then 500 ms after SIGTERM, before SIGKILL (with up to 1 second to observe exit). Final bounded drains allow up to 100 ms each for remaining child diagnostics and buffered gateway stderr. This shorter budget prevents an upstream MCP client's shutdown deadline from killing the gateway before it cleans up children. Commands that detach or launch unmanaged descendants need their own cleanup; avoid such wrappers. Gateway and child diagnostics use stderr and the log file; stdout is reserved for MCP messages. A failed gateway stderr stream triggers cleanup and suppresses further stderr output; file logging remains available during cleanup.

```bash
npm run check
npm test
npm run build
```

The integration tests run real gateway processes and verify identity isolation, downstream identity propagation, namespaced routing, approval/decline/cancellation and no-UI behavior, private panel refresh through Pi’s extension loader, unknown-tool rejection, private authenticated settings routing, confirmed schema-valid saves and stale revision rejection, and cleanup of stubborn children after startup timeout, raw upstream EOF, SDK-managed shutdown, or a closed stderr reader.

## Try the demo

```bash
npm run build
# In gateway.demo.json, replace the service path with this checkout's absolute path.
pi --extension "$PWD/pi/gateway.ts" --gateway-config "$PWD/gateway.demo.json"
```

Ask the model to discover `gateway_tools` and call `demo__increment`; approve or decline the one-shot prompt. Then run `/gateway-panel` and select **Demo counter**, or provide `gateway-resource://demo/demo%3A%2F%2Fcounter`; press `r` to refresh and Escape to close. The demo only increments an in-memory counter.
