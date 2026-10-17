# Gateway reference

[Back to README](../README.md) · [Integration recipes](integrations.md)

[Configuration](#configuration) · [Tools and adapter](#tools-and-adapter-connection) ·
[Builds](#adapter-builds) · [Display/counts](#display-and-call-counts) · [Startup
snapshot](#startup-snapshot) · [Resources](#resources) · [Approvals](#approvals) ·
[Identity](#identity) · [Logs](#logs) · [Lifecycle](#lifecycle)

## Configuration

| Setting | Behavior |
|---|---|
| Server map | Prefer `mcpServers`; legacy `servers` is accepted. Specifying both is an error. Other clients' options are not necessarily supported. |
| Commands/arguments | Executables and literal arguments, not shell expressions |
| `cwd` | Defaults to the config directory; relative values resolve there |
| Service names | Lowercase letters, digits, hyphens; start with a letter; `gateway` is reserved |
| `timeoutMs` | Default **30,000 ms**; integer **100–300,000**. Allow time for approvals and service work. |
| `autoUpdateConcurrency` | Optional integer **1–128**; `1` runs sequentially. Does not enable `autoUpdate`. See [CPU-based default and cleanup/resource behavior](packages.md#automatic-startup-updates). |
| `display` | `"minimal"` (default) or `"full"`; see [display and call counts](#display-and-call-counts) |

### Environment variables

Children receive SDK defaults plus configured `env`, **not the full parent
environment**. `${VARIABLE}` references read the gateway environment; missing variables
fail startup. The Pi adapter passes Pi's environment to the gateway, not directly to
children.

Every child receives `MCP_GATEWAY_WORKSPACE`: the gateway launch directory, independent
of child `cwd`. With the adapter this is the session workspace. Services can use this
trusted launcher value for project scope rather than the config/package directory;
explicit workspace arguments may take precedence. There is no argument/shell
interpolation or dynamic workspace switching.

Merge this server into your `mcpServers` map:

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

Set `DATABASE_URL` in the gateway launch environment; keep credentials out of checked-in
configuration. Forward display, keyring, `PI_CODING_AGENT_DIR`, or XDG variables
explicitly when required by a service's guide.

For managed sources, package references, and `{{packageRoot}}`, see [package
configuration](packages.md#git-main-managed-configuration).

## Tools and adapter connection

The gateway works without Pi packages: local stdio, no HTTP server, shared daemon, or
custom job events. Standard MCP subscriptions are forwarded.

| Tool behavior | Contract |
|---|---|
| Names | `<server>__<tool>`, e.g. `files__read_file`; Pi adds its MCP namespace |
| Discovery | Namespaced names must fit MCP's **128-character limit**. Duplicate/invalid names fail discovery; pagination and tool-list changes are supported. |
| Exclusions | Task-required tools are omitted. Sampling, tasks, resource templates, and browser-based MCP Apps are not forwarded. |
| Adapter calls | One MCP SDK client; `gateway_tools` discovers live model-callable tools; `gateway_call` validates advertised JSON Schema 2020-12. |
| UI-only tools | Omitted and rejected; tools visible to model and app remain callable |
| Resources/panels | No resource tools registered; panel contents stay outside conversation context |

Agents with OS tools can still access the same system; UI routing is not a secrecy
boundary.

The adapter creates no process at extension load. On `session_start`, it checks builds,
starts the gateway, and safely closes it even after repeated shutdown requests. The
upstream handshake precedes child startup so form elicitation is advertised only when
the harness supports it.

### Adapter builds

Before each launch, the adapter fingerprints gateway/example sources, package
manifest/lockfile, TypeScript configs, and compiled outputs. Missing/changed output runs
`npm run build` in this checkout; the first launch after upgrading to this behavior also
builds once to record a fingerprint. Fresh builds are reused.

- Requires development dependencies from `npm ci` and **POSIX process-group support**.
- Never installs dependencies or updates sources. Standalone/built-in MCP launches still
  need a manual build.
- Concurrent launches share a checkout build lock, with a **five-minute build/wait
  limit**. Shutdown cancels compilation.
- Already-running gateways are never rebuilt or restarted by this check.

Build failure leaves the gateway disconnected rather than using stale output. Inspect
the compiler error, run `npm ci` if dependencies changed, finish other gateway jobs,
then retry `/reload`.

A crashed Pi may leave `dist/.gateway-build.lock`. Remove it **only after verifying its
recorded PID and any compiler children are no longer running**.

### Display and call counts

**`/gateway` → Display: Minimal / Full** saves the raw configuration and applies
immediately. Other sessions pick it up on reload or their next toggle.

Minimal shows the footer, for example ` MCP 3 services`. Its count is the configuration
loaded at the last start/restart, **not live service health**:

| Indicator | Meaning |
|---|---|
| `?` | Configuration not yet available |
| `· !N` | Observed child disconnects |
| `· off` | Gateway closed |

Full adds a horizontal, wrapping panel below the editor, preserving Pi's footer and
service action links:

```text
 MCP 3 services · 31 tool calls
 delegate ✓12 ✗0  │  pinote ✓17 ✗2  │  browser ✓0 ✗0
```

Click a service name/counter to open its app, or feature menu if it has no app. Closing
the service screen returns to the editor. Settings are separate and disabled in the
feature menu when unavailable. Disconnected and `previous` services have no link.
Keyboard fallback: **`/pi-services` → service → Enter**. Existing service-provided
footer actions are unchanged.

Nonzero successes (`✓`) are green, failures (`✗`) red, and in-flight calls (`…`) amber;
zeros and names are muted.

| Count | Meaning |
|---|---|
| Included | Child tool dispatches in this Pi session, even in Minimal display; background queries implemented as tools also count |
| Excluded | Discovery, resource reads, settings, native app actions, and pre-dispatch rejections |
| Success | Non-error tool response, not a verified outcome |
| Failure | Errors, timeouts, cancellations after dispatch, and interrupted/unconfirmed calls on disconnect/reload; child approval denials count when returned as errors |

Counts stay outside model context and survive gateway restart, reload, and resume. New
sessions/forks start at zero; tree navigation does not rewind usage. Totals are scoped
to session and config path, recording only activity since this feature was installed—not
reconstructed history. Removed services with recorded calls remain labelled `previous`.
Crashes can lose unflushed notifications; these are operational counters, not an audit
log.

Telemetry uses `notifications/gateway/tool-call` with `{id, service, phase}`: `started`,
`success`, or `failure` at dispatch/settlement. Dispatch IDs are UUIDs; pre-dispatch
rejections and gateway-owned tools emit nothing. Notifications carry no
arguments/results and add no polling.

### Startup snapshot

During startup/reload, an animated indicator above the editor names the current stage:
configuration, optional package updates, build check, service connection, tool
discovery, apps, and live panels. It clears on success, failure, or shutdown;
noninteractive sessions do not animate.

For package eligibility, progress and concurrency, see [automatic startup
updates](packages.md#automatic-startup-updates).

New TUI sessions also print a compact, display-only **Startup snapshot**: each service's
observed connection state, exposed tool count, and tool names. Names wrap beneath the
service; call them as `service__tool` through `gateway_call`. Unactivated managed
services show `stopped · package not activated`.

#### Status contract

Gateways advertise `experimental["gateway-status-v1"] = {}` for private, read-only
`gateway/status`. It waits for successful startup and rejects while closing. The result
is:

```text
{services: [{name, state, tools, toolNames}]}
```

- `state`: `connected`, `stopped` (managed package not activated), or `disconnected`.
- `tools`: exposed model-visible service tool count, excluding gateway-owned and
  app-only tools.
- `toolNames`: original, unprefixed names. Older saved snapshots without names still
  render counts.

This reads in-memory observations, not child health checks, and creates no model tool or
live dashboard. The adapter reads once per new session and saves a config-scoped entry
outside model context. Cards remain historical after restart; reload/resume/fork do not
append cards, and matching saved entries prevent reopening duplicates.

The footer remains the connection indicator; `/pi-services` opens current navigation.
Missing/failed reads show **Startup status unavailable** without closing a working
connection.

## Resources

`resources/subscribe` and `resources/unsubscribe` route to the owning service. Updates
go only to subscribed URIs; list changes and disconnects propagate upstream. Subscribe
before reading, then reread after updates. Services without subscriptions retain manual
reads. Resource reads do not prompt for approval.

Resource and returned-content URIs are wrapped as:

```text
gateway-resource://<service>/<percent-encoded-original-uri>
```

Observation requests with progress tokens receive standard heartbeats while queued or
aggregating pages. The live adapter resets its timeout per heartbeat, avoiding
cancellation merely because total discovery exceeds one child-request timeout. Each
actual child request retains its normal timeout/retirement policy.

The live delegate adapter automatically subscribes to
`application/vnd.pi-delegate.jobs+json` resources (schema version 1), validates them,
and caps them at **32 sources, 256 jobs per source, and 1 MB per snapshot**. The gateway
forwards resources generically without interpreting delegate JSON. See the [panel
guide](integrations.md#live-delegate-panel).

## Approvals

Standard MCP `elicitation/create` carries approvals, not model-visible tool results.
Services must request a flat form with one required boolean; other forms are cancelled.
No credentials are collected.

| Decision | Result |
|---|---|
| Allow once | `accept`, required field `true` |
| Decline | `decline` |
| Cancel | `cancel` |

Missing UI, timeouts, disconnects, and aborted calls **never grant approval**. Dialogs
serialize; incoming confirmations are cancelled while gateway menus are open. In TUI
mode, every disclosure line must be displayed before Enter approves. Escape cancels;
resizing resets review. Oversized disclosures are refused, not truncated into approval.

Services must check decisions before acting: prompts are cooperative, not general
permission enforcement. Tool annotations are hints, not security guarantees. Each
service processes one forwarded request at a time, attributing confirmations to the
active tool without custom metadata. Separate services run concurrently.

## Identity

`gateway__identity` returns `{ "sessionId": "<uuid>" }`.

| Child environment variable | Value |
|---|---|
| `MCP_GATEWAY_SESSION_ID` | Same UUID for all this gateway's children |
| `MCP_GATEWAY_SERVICE_ID` | Configured service name |
| `MCP_GATEWAY_WORKSPACE` | Absolute gateway launch directory, independent of child `cwd` |

Forwarded tool calls also receive request `_meta`:

```json
{
  "local-stdio-mcp-gateway/sessionId": "<uuid>",
  "local-stdio-mcp-gateway/serviceId": "files"
}
```

These override caller/config replacements. Arguments stay unchanged, other metadata is
preserved, and progress tokens are translated between connections. Children can forward
identity to APIs or logs.

**Identity belongs to the gateway run, not the Pi conversation.** Reconnect, restart, or
reload creates a UUID; switching conversations may recreate the gateway. Native UI uses
a separate durable conversation ID and branch-local opaque state. Gateway UUIDs are
ephemeral correlation labels, not authentication or a sandbox. Servers run with your OS
permissions; agents with OS tools can inspect files/processes. Configure only trusted
executables.

## Logs

Gateway/child diagnostics go to **stderr and an append-only file**; stdout is MCP-only.

| Setting | Behavior |
|---|---|
| Default | `gateway.log` beside the config |
| Custom | Top-level `"logFile": "logs/gateway.log"`, relative to config, not cwd |
| Permissions | New files use `0600`; parent directory must exist and be writable |
| Rotation | External rotation supported; no automatic rotation or size limit |

```bash
tail -F /absolute/path/to/config-directory/gateway.log
```

Restarts/concurrent runs append without truncation. Each append reopens the path, so
writes are immediately visible and external rotation works.

Child stderr is copied verbatim and **may contain sensitive data**; tool
arguments/results are not logged. Config/argument errors before log initialization
appear only on stderr. An unwritable log prevents startup; later write failure reports
to stderr and triggers cleanup.

## Lifecycle

### Startup and request failures

- Every launched server must initialize; failure aborts startup and awaits child
  cleanup. Inactive managed services stay stopped until manual preparation, activation,
  and separately confirmed restart. Auto-update never performs first installation.
- Explicit `localUpdate` packages update in place before connection. Incomplete
  builds/validation block even standalone/manual launches; see [local Git
  packages](packages.md#local-git-packages).
- Tool/resource requests wait for child startup; upstream EOF is observed throughout.
  Child disconnect removes its tools; reconnect the gateway to restart it.
- Calls use configured timeouts and propagate cancellation, with **no automatic
  tool-call retries**.
- Cancelling/timing out a started service request, including a resource read, retires
  its connection and removes tools/resources until gateway restart (`/reload` with the
  adapter). Other services stay connected. MCP cancellation has no completion
  acknowledgement; retirement prevents attributing late confirmations to another call.

### Shutdown

Closing stdin or sending SIGINT/SIGTERM closes the gateway and direct children:

1. Allow **500 ms** after child EOF.
2. Send SIGTERM; allow another **500 ms**.
3. Send SIGKILL if needed; allow up to **1 second** to observe exit.
4. Allow up to **100 ms each** for remaining child diagnostics and buffered gateway
   stderr.

This keeps cleanup within an upstream client's shutdown deadline. Avoid commands that
detach or launch unmanaged descendants; they need their own cleanup. Failed gateway
stderr also triggers cleanup and suppresses further stderr; file logging remains
available.

**Restart/reload stops children and cancels active/queued jobs**, not saves settings or
detaches workers. Other sessions are not restarted. See the [package
workflow](packages.md#workflow) for confirmed restart and recovery.
