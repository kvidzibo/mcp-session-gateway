# Gateway reference

[Back to README](../README.md) · [Integration recipes](integrations.md)

- [Configuration](#configuration)
- [Tools and adapter connection](#tools-and-adapter-connection)
- [Resources](#resources)
- [Approvals](#approvals)
- [Identity](#identity)
- [Logs](#logs)
- [Lifecycle](#lifecycle)

## Configuration

`mcpServers` is the preferred child-server map; legacy `servers` is also accepted.
Specifying both is an error. The common map name does not imply compatibility
with every other MCP client's configuration options.

Commands are executables, not shell expressions; arguments are literal. `cwd`
defaults to the config directory, and relative values resolve there. Names use
lowercase letters, digits, and hyphens, starting with a letter; `gateway` is
reserved.

`timeoutMs` defaults to **30,000 ms** and must be an integer from 100 to 300,000.
Allow enough time for approval dialogs as well as service work.

`autoUpdateConcurrency` optionally overrides the CPU-based startup package-update
limit with an integer from **1 to 128** (`1` runs sequentially). See
[startup update concurrency](packages.md#automatic-startup-updates) for the default
and resource/cleanup behavior. It does not enable `autoUpdate` by itself.

`display` is `"minimal"` (default) or `"full"`. The Pi adapter's `/gateway` →
Display row saves it in the raw configuration and applies it immediately to the
current session. Other sessions pick up the saved preference on reload or their
next toggle. Full shows colored per-service tool-call counts in a wrapping
below-editor panel; see [counter semantics](../README.md#operator-menu).

### Environment variables

Children receive the MCP SDK's minimal default environment plus configured
`env`. Other parent variables are **not inherited automatically**. `${VARIABLE}`
references in `env` resolve from the gateway environment; missing variables fail
startup. The Pi adapter passes Pi's environment to the gateway, not directly to
its children. Every child also receives `MCP_GATEWAY_WORKSPACE`: the gateway's
launch directory, independent of the child's configured `cwd`. The Pi adapter
launches the gateway in the session workspace. Services can use this trusted
launcher value for project scope instead of accidentally using the config or
package directory; explicit service workspace arguments may take precedence.
There is no argument/shell interpolation or dynamic workspace switching.

For example, merge this server into your `mcpServers` map:

```json
{
  "database": {
    "command": "uvx",
    "args": ["your-database-mcp-package"],
    "cwd": ".",
    "env": { "DATABASE_URL": "${DATABASE_URL}" }
  }
}
```

Set `DATABASE_URL` in the gateway's launch environment. Keep credentials out of
checked-in configuration files. Other integrations may need explicit display,
keyring, `PI_CODING_AGENT_DIR`, or XDG variables; follow each service's guide.

For managed sources, package references, and `{{packageRoot}}`, see
[package configuration](packages.md#git-main-managed-configuration).

## Tools and adapter connection

The gateway is usable without Pi packages. Transport is local stdio, with no HTTP
server, shared daemon, or custom job events. Standard MCP subscriptions are
forwarded. `notifications/gateway/tool-call` is display-only telemetry with
`{id, service, phase}` (`started`, `success`, `failure`), emitted at child tool
dispatch and settlement. It contains no arguments/results and adds no polling.
Each dispatch ID is a UUID; pre-dispatch rejection and gateway-owned tools emit
nothing.

Tools use `<server>__<tool>`, for example `files__read_file`. Pi adds its own MCP
namespace. Namespaced names must fit MCP's **128-character limit**; duplicate or
invalid names fail discovery. Paginated discovery and tool-list changes are
supported. Task-required tools are omitted. Sampling, tasks, resource templates,
and browser-based MCP Apps are not forwarded.

The adapter owns one MCP SDK client. `gateway_tools` discovers live model-callable
tools; `gateway_call` validates each call against its advertised JSON Schema
(2020-12). UI-only tools are omitted and rejected; tools visible to both model and
app remain callable. No resource tools are registered, and panel contents are
not added to the conversation. Agents with other OS tools can still access the
same system—this is not a secrecy boundary.

The adapter creates no process at extension load time. Before launch it checks
content fingerprints and rebuilds missing/stale compiled output with `npm run build`;
see [adapter build requirements and recovery](../README.md#option-a-pi-adapter).
A build failure prevents launch, never falls back to stale output, and shutdown
cancels the build. It starts the gateway on `session_start` and closes it safely
even if shutdown is requested more than once.
The upstream handshake precedes child startup so form elicitation is advertised
only when supported by the harness.

### Startup snapshot

Gateways advertise `experimental["gateway-status-v1"] = {}` for the private,
read-only `gateway/status` request. Each service includes its observed state,
model-visible tool count and `toolNames` (original, unprefixed names). Older saved
snapshots without names still render their counts. It waits for successful startup and rejects
while closing. The result is `{services: [{name, state, tools}]}`: `state` is
`connected`, `stopped` (managed package not activated), or `disconnected`; `tools`
counts exposed service tools, excluding gateway-owned and app-only tools. This
reads in-memory observations, not child health checks, and creates no model tool.

The TUI adapter reads once for a new session and saves a config-scoped,
display-only startup entry. Cards explicitly say **Startup snapshot**; existing
cards remain historical after restart. Reload/resume/fork do not append cards,
and an existing matching entry prevents duplicates when reopening a session.
The footer remains the connection indicator; `/pi-services` opens current service
navigation. A missing/failed status read shows **Startup status unavailable**
without closing an otherwise working connection.

## Resources

`resources/subscribe` and `resources/unsubscribe` route to the owning service.
Updates go only to subscribed URIs; resource-list changes and disconnects
propagate upstream. Clients must subscribe before reading, then reread after each
update. Services without subscription support retain manual reads. Resource reads
do not trigger approval prompts.

Resource URIs and returned-content URIs are wrapped as:

```text
gateway-resource://<service>/<percent-encoded-original-uri>
```

Observation requests supplying a progress token receive standard heartbeats while
queued or aggregating pages. The live adapter resets its timeout on each
heartbeat, so healthy children are not cancelled just because total discovery
exceeds one child-request timeout. Each actual child request keeps its normal
timeout and retirement policy.

The live delegate adapter automatically subscribes to resources declaring MIME
type `application/vnd.pi-delegate.jobs+json` (schema version 1). It validates the
format and caps it at **32 sources, 256 jobs per source, and 1 MB per snapshot**.
The gateway forwards resources generically; it does not interpret delegate JSON.
See the [panel guide](integrations.md#live-delegate-panel) for operator behavior.

## Approvals

Approvals use standard MCP `elicitation/create`, not model-visible tool results.
Services must request a flat form with one required boolean field; other forms
are cancelled. No credentials are collected.

| Decision | Result |
|---|---|
| Allow once | `accept`, with the required field set to `true` |
| Decline | `decline` |
| Cancel | `cancel` |

Missing UI, timeouts, disconnects, and aborted calls never grant approval. Dialogs
are serialized; incoming confirmations are cancelled while gateway menus are open.
In TUI mode, Allow once opens a scrollable disclosure: every line must be displayed
before Enter grants approval. Escape cancels, resizing resets review, and oversized
disclosures are refused rather than truncated into approval.

Services must check the decision before acting. Prompts are cooperative, not
general permission enforcement. Tool annotations are upstream hints, not security
guarantees. Each service processes one forwarded request at a time, allowing
confirmations to be attributed to the active tool without custom metadata.
Separate services can run concurrently.

## Identity

Call `gateway__identity` to get `{ "sessionId": "<uuid>" }`.

Every child receives:

| Environment variable | Value |
|---|---|
| `MCP_GATEWAY_SESSION_ID` | Same UUID for all children of this gateway |
| `MCP_GATEWAY_SERVICE_ID` | Service name from config |
| `MCP_GATEWAY_WORKSPACE` | Absolute gateway launch directory, independent of child `cwd` |

Every forwarded tool call also receives request `_meta`:

```json
{
  "local-stdio-mcp-gateway/sessionId": "<uuid>",
  "local-stdio-mcp-gateway/serviceId": "files"
}
```

These values override caller/config attempts to replace them. Tool arguments stay
unchanged, other metadata is preserved, and progress tokens are translated
between connections. Children can forward identity to their APIs or logs.

**Identity belongs to the gateway run, not the Pi conversation.** Reconnect,
restart, or reload creates a new UUID; switching Pi conversations may also
recreate the gateway. The native UI host supplies a separate durable conversation
ID and branch-local opaque state. The gateway UUID is an ephemeral correlation
label, not authentication or a sandbox.

All configured servers run with your OS permissions; agents with OS tools can
inspect files/processes too. Only configure trusted executables.

## Logs

Gateway and child diagnostics go to **stderr and an append-only file**. Stdout is
reserved for MCP messages.

| Setting | Behavior |
|---|---|
| Default file | `gateway.log` beside the config |
| Custom file | Top-level `"logFile": "logs/gateway.log"`; relative to the config, not cwd |
| Permissions | New files use `0600`; the parent directory must exist and be writable |
| Rotation | External rotation supported; no automatic rotation or size limit |

```bash
tail -F /absolute/path/to/config-directory/gateway.log
```

Restarts and concurrent runs append without truncation. Each append reopens the
path, making writes immediately visible and supporting external rotation.

Child stderr is copied verbatim and **may contain sensitive data**. The gateway
does not log tool arguments/results. Config/argument errors before logging
initializes appear only on stderr. An unwritable log prevents startup; a later
write failure reports to stderr and triggers cleanup.

## Lifecycle

### Startup and request failures

- All launched servers must initialize. Any failure aborts startup and waits for
  child cleanup. Managed services without an active release stay stopped until
  manual preparation, activation, and a separately confirmed restart; auto-update
  does not perform first installation. Explicit `localUpdate` packages instead
  update in place before connection. Incomplete local builds/validation block
  startup (including standalone/manual launches); see [local Git packages](packages.md#local-git-packages).
- Tool/resource requests wait for child startup; upstream EOF is observed
  throughout. A child disconnect removes its tools. Reconnect the gateway to
  restart it.
- Calls use the configured timeout and propagate cancellation, with **no automatic
  tool-call retries**.
- Cancelling or timing out a started service request, including a resource read,
  retires that connection and removes its tools/resources until gateway restart
  (`/reload` with the adapter). Other services stay connected. MCP cancellation
  has no completion acknowledgement; retirement prevents late confirmations from
  being attributed to another call.

### Shutdown

Closing stdin or sending SIGINT/SIGTERM closes the gateway and its direct children:

1. Allow **500 ms** after child EOF.
2. Send SIGTERM and allow another **500 ms**.
3. Send SIGKILL if needed, with up to **1 second** to observe exit.
4. Allow up to **100 ms each** for remaining child diagnostics and buffered
   gateway stderr.

This budget keeps cleanup within an upstream client's shutdown deadline. Avoid
commands that detach or launch unmanaged descendants; they need their own cleanup.
A failed gateway stderr stream also triggers cleanup and suppresses further
stderr output; file logging remains available.

Restart/reload stops children and cancels active/queued jobs; it is not a way to
save settings or detach workers. Other sessions are not restarted. For confirmed
managed-service restart and recovery, see the [package workflow](packages.md#workflow).
