# Local stdio MCP gateway

A small TypeScript MCP gateway. Each launch generates a UUID, starts local MCP servers, and exposes their generic tools and subscribable resources through one stdio connection.

```text
Pi A ⇄ gateway A ⇄ child MCP processes A
Pi B ⇄ gateway B ⇄ child MCP processes B
```

No HTTP, sockets, cookies, shared daemon, or custom job events. Standard MCP resource subscriptions are forwarded. The optional Pi adapter owns one MCP SDK client and provides generic tool discovery/calls, a native resource panel, a live delegate widget, reusable child-server settings, boolean one-shot approval prompts, and [server-driven native UI](docs/native-ui.md). Sampling, tasks, resource templates, and browser-based MCP Apps are not forwarded.

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
  "mcpServers": {
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

`mcpServers` is the preferred child-server map. Legacy `servers` is still accepted; specifying both is an error. This naming matches common MCP client configuration, but only the gateway options documented here are supported.

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

## Package inventory

The Pi adapter's **`/gateway-manager`** shows declared installed versions and
optional update sources without reading service configuration files. Add a
`packages` map and optional service `package` references alongside existing
`mcpServers` entries; see [the package contract and example](docs/packages.md).

Opening the screen reads local metadata only. Press **c** to check public npm
versions or HTTPS Git branch heads, **r** to refresh locally, and Escape to close.
Unlinked services and local folders are externally managed. This first stage is
**read-only**: no installation, updates, service restarts, or background checks.
No Pinote/delegate-specific code or service UI support is required.

## Live delegate panel

The optional Pi adapter automatically subscribes to resources declaring MIME type
`application/vnd.pi-delegate.jobs+json` (schema version 1), provided by
[pi-delegate 0.20.0+](https://github.com/kvidzibo/pi-delegate#readme). Use the same
adapter/config setup above, with a delegate service:

```json
{
  "mcpServers": {
    "delegate": {
      "command": "pi-delegate-mcp",
      "args": ["--workspace", "/absolute/path/to/project"]
    }
  }
}
```

Queued/running jobs appear automatically **above the editor**, independent of
parent activity. Cards show role, model/reasoning, task preview, elapsed/queue time,
job ID and current/recent tool activity. Completed jobs remain for eight seconds;
finished means **unverified**, not successful. Disconnects retain a stale warning
and freeze the last-known clock instead of claiming completion. `/gateway-panel`
opens the full resource JSON; the compact widget shows overflow counts on small
terminals. Settings and approval dialogs remain usable while the widget is visible.

The adapter owns one gateway connection for both tools and UI. It does not load
the original delegate extension, start another observer server, poll job status,
send chat messages or trigger model turns. Clock ticks are local; MCP reads occur
on discovery and change notifications, coalescing bursts. Resources are not a
secrecy boundary. Models still see their explicit tool results. No widget or
subscriptions are started outside TUI mode. Reload closes the connection and its
workers; it is not a way to detach jobs.

Gateway resource forwarding is generic: `resources/subscribe` and
`resources/unsubscribe` route to the owning service, and updates are forwarded
only for subscribed URIs. Resource-list changes and service disconnects propagate
upstream. Clients must subscribe before reading and reread after each update.
Services without subscription support keep manual reads. Resource observation
requests that supply a progress token receive standard progress heartbeats while
queued or aggregating pages. The live adapter resets its request timeout on those
heartbeats; healthy children are not cancelled merely because total discovery
exceeds one child-request timeout. Each actual child request retains its normal
timeout and retirement policy. Resource templates are not forwarded. Pi rendering is isolated in `pi/live-jobs.ts`; the gateway does not
interpret delegate JSON. The adapter validates the declared format and caps it at
32 sources, 256 jobs per source and 1 MB per snapshot.

## Child-server settings

With the optional Pi adapter, use **`/mcp-settings`** to select a child service, or
**`/mcp-settings delegate`** to open one directly. Settings are discovered from the
child's schema, not hardcoded service names or the parent Pi model catalogue.
Edits stay in a local draft until **Save changes** shows the exact changes and you
confirm. Escape/Back discards the draft; declining a save leaves it editable.
Scrollable overlay dialogs keep controls visible even with editor widgets/custom
footers. Review every preview line before Enter can save; resizing resets that
review. Settings require TUI mode and cannot overlap one-shot approval prompts.

Enable only services implementing the [operator settings contract](docs/settings.md):

```json
{
  "mcpServers": {
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
constant-choice fields, plus read-only hints. Free-form strings/numbers use JSON
value input (quote strings); significant whitespace is escaped in save previews.
Unsupported controls (arrays, references,
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
The adapter creates no settings route outside TUI mode. This is routing isolation, **not
a sandbox**: trusted services and agents with OS access can still inspect files/processes.
See [the reusable protocol](docs/settings.md) for other clients and service authors.

## Server-driven UI

Services can supply menus, settings forms, previews, and footer text through the
[native UI v1 protocol](docs/native-ui.md). Open `/gateway-ui [service]`; clicks and
keyboard actions go directly to the service without a model turn. The adapter is
generic—Pinote screens and behavior live in Pinote's MCP server, not this package.
UI state follows the Pi conversation/branch, separately from the gateway UUID.

For a checkout of Pinote with its MCP server, install its `pi/` dependencies and
Python CLI, then register a service:

```json
{
  "servers": {
    "pinote": {
      "command": "node",
      "args": ["/absolute/path/to/pinote/pi/dist-mcp/mcp/server.js"],
      "env": { "PINOTE_NOTE_COMMAND": "/absolute/path/to/pinote/.venv/bin/note" }
    }
  }
}
```

Build the service with `npm --prefix /absolute/path/to/pinote/pi run build:mcp` (Node.js 22.19+). Pass `PI_CODING_AGENT_DIR`
and XDG overrides explicitly in service `env` if used: the gateway does not inherit
them into children. Do not load the old Pinote-specific Pi extension alongside
this alternative unless you deliberately want separate selections and duplicate UI.
Keep the existing configuration until the replacement has been tested; installation
does not migrate it automatically.

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

**The identity belongs to the gateway run, not the Pi conversation.** Reconnect, restart, or reload creates a new UUID. Switching conversations inside Pi may also recreate the gateway. The optional native UI host supplies a separate durable conversation ID and branch-local opaque state; the gateway UUID itself remains ephemeral.

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

The integration tests run real gateway processes and verify identity isolation, downstream identity propagation, namespaced routing, approval/decline/cancellation and no-UI behavior, manual and live panel updates through Pi’s extension loader, subscription routing and disconnects, narrow-width rendering, unknown-tool rejection, private authenticated settings routing, confirmed schema-valid saves and stale revision rejection, and cleanup of stubborn children after startup timeout, raw upstream EOF, SDK-managed shutdown, or a closed stderr reader.

## Try the demo

```bash
npm run build
# In gateway.demo.json, replace the service path with this checkout's absolute path.
pi --extension "$PWD/pi/gateway.ts" --gateway-config "$PWD/gateway.demo.json"
```

Ask the model to discover `gateway_tools` and call `demo__increment`; approve or decline the one-shot prompt. Then run `/gateway-panel` and select **Demo counter**, or provide `gateway-resource://demo/demo%3A%2F%2Fcounter`; press `r` to refresh and Escape to close. The demo only increments an in-memory counter.
