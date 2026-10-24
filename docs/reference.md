# Gateway reference

[Back to README](../README.md) · [Integration recipes](integrations.md)

## Configuration

- Prefer `mcpServers`; legacy `servers` works, but specifying both fails. Other clients' options are
  not necessarily supported.
- Per-service `enabled`: boolean, default `true`. `false` skips process launch and environment
  expansion but retains the entry for re-enabling. Saved changes apply on next launch/restart;
  existing processes in every session stay unchanged.
- Commands are executables with literal arguments, not shell expressions.
- `cwd` defaults to the config directory; relative values resolve there.
- Service names: lowercase letters, digits, hyphens; start with a letter; `gateway` is reserved.
- `timeoutMs`: integer **100–300,000**, default **30,000 ms**; include approval/work time.
- `autoUpdateConcurrency`: integer **1–128**; `1` is sequential. Does not enable `autoUpdate`. See
  [defaults and resource limits](packages.md#automatic-startup-updates).
- `display`: `"minimal"` (default) or `"full"`.
- Per-service `agentContext`: `"off"` (default), `"service"` (service name/description),
  `"summary"` (tool names/descriptions), or `"full"` (also input schemas). A top-level
  `agentContext` remains a backward-compatible default for entries without an override, including
  newly added services. Pi adapter only; **`/gateway` → Agent context** cycles each service inline
  and provides a private exact-content preview. Saves raw config without expanding credentials.
- Per-service `additionalContext`: strict boolean, default `false`, independent of `agentContext`.
  Supporting services expose an inline On/Off row. Read fresh before every agent run, even with Tools
  Off; no resource body reads when Off or disabled. See [protocol and trust boundaries](agent-context.md).
- Per-service `description`: optional non-empty string, trimmed for display/context. Service-only
  mode uses it, otherwise lists available model-visible tool names in sorted order. No LLM generation.

### Environment variables

Children receive SDK defaults plus configured `env`, **not the full parent environment**.
`${VARIABLE}` reads the gateway environment; missing variables in enabled services fail startup. The adapter passes Pi's
environment to the gateway, not children. No argument/shell interpolation occurs.

`MCP_GATEWAY_WORKSPACE` gives every child the gateway launch directory (the adapter's session
workspace), independent of `cwd`. Services may use it for project scope; explicit workspace
arguments may override it. No dynamic workspace switching occurs.

Merge into `mcpServers`:

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

Set `DATABASE_URL` at launch; never commit credentials. Explicitly forward required display,
keyring, `PI_CODING_AGENT_DIR`, or XDG variables. See [packages and
`{{packageRoot}}`](packages.md#git-main-managed-configuration).

## Tools and adapter connection

Local stdio needs no Pi packages, HTTP server, shared daemon, or custom job events. Standard MCP
subscriptions are forwarded.

- Names: `<server>__<tool>`, e.g. `files__read_file`; Pi adds its MCP namespace. Namespaced names
  must fit **128 characters**; duplicate/invalid names fail discovery. Pagination and tool-list
  changes work.
- Task-required tools are omitted; sampling, tasks, resource templates, and browser-based MCP Apps
  are not forwarded.
- One SDK client serves `gateway_tools` discovery and `gateway_call`, which validates advertised
  JSON Schema 2020-12. UI-only tools are omitted/rejected; dual-use tools remain callable.
- No resource tools are registered; panels stay outside conversation context.

The adapter creates no process at extension load. On `session_start`, it checks builds and starts
the gateway; repeated shutdown requests close it safely. The upstream handshake precedes child
startup, advertising form elicitation only when supported by the harness.

### Agent context injection

Before each agent run, the adapter rereads service descriptions and context modes, discovering
current model-visible tools unless all services are Off or disabled. The catalog groups tools by configured
service and omits Off/disabled services (even with stale running inventory), services with no available model-visible tools, and gateway-owned
tools (still discoverable on demand). Service-only mode omits tool descriptions/schemas; summary
mode omits schemas. The catalog explains how to discover missing details through `gateway_tools`.

Additional service reference data uses a separate `gateway_service_context` section, independent
of the tool catalog. Both sections are replaced before each run; historical context already sent to
the model is not erased. The private preview reads fresh too, labels sources separately, and its
raw view shows both sections when additional context is enabled. Unavailable reads produce an
explicit per-service unavailable status and warning, not an empty/no-task assertion or stale snapshot.
Off/disabled services never contribute task data. See [resource protocol](agent-context.md).

A dedicated `gateway_tools` prompt section is replaced, not repeatedly appended; Pi manages
transcript deltas. The private native inline preview derives its tree and exact raw text from the
same catalog snapshot used for injection, without a model turn or persisted task snapshot (durable host identity may be saved). Services
start collapsed; expansion reveals only injected tools and, in Full schemas mode, full input
schemas. Service-only entries have no tool/schema children. Tab toggles raw/tree; configured Pi
selection keys navigate/toggle/back, page keys scroll long content independently of selection,
Home/End jump, and r refreshes with cancellation of superseded reads. Disconnect/cancellation
cannot publish stale results. Disabled settings rows are dimmed and locked with zero tokens;
the saved mode survives disabling, and saving rejects a service disabled since opening the menu.
Menu and preview show rough added-token estimates (characters ÷ 4, including the section wrapper;
tokenizer-dependent). Selected service details include a standalone estimate with the shared
header, so per-service estimates are not additive. Metadata is reference data, not instructions
or permission. Menus, resources and app-only tools are not injected. Discovery/configuration
failures omit the section and warn rather than reusing a stale catalog.

Saved choices apply across sessions on their next run, including resume/fork; changing modes does
not erase previous messages. Calls still go through `gateway_call`, with existing validation and
approvals. Delegated agents have their own context configuration.

### Adapter builds

Each launch fingerprints gateway/example sources, manifest/lockfile, TypeScript configs, and
compiled outputs. Missing/changed output runs `npm run build` here; the first launch after this
behavior's introduction also builds to record a fingerprint. Fresh builds are reused.

Requires `npm ci` development dependencies and **POSIX process-group support**. The build check
itself never installs dependencies or updates sources; the separate [gateway startup update
policy](packages.md#gateway-self-updates) can do both. Standalone/built-in launches need manual builds. Concurrent
launches and automatic updates have a **five-minute lock-wait limit**; builds also have a
five-minute deadline. The dependency-light loader runs automatic updates in a disposable worker
before importing a versioned runtime copy, including on `/reload`. Copying holds the checkout
lock; compilation and the child handshake hold the copy's build lock. Discovery only registers
lightweight tools/commands; runtime imports happen at session startup or on demand for recovery
commands. Readiness blocks service startup, not recovery menus. Shutdown cancels copying and compilation;
already-running gateway copies are never replaced or restarted.

Failure leaves the gateway disconnected, not stale. Finish gateway jobs and wait for all updates
and builds before manually running `npm ci --include=dev`; manual npm commands do not take the
gateway lock. Run `/reload` with Auto update on to rebuild/validate an interrupted self-update.
A Pi process still using the old loader may need one full restart during migration.
Do not delete failed-build receipts.

Git checkouts use `mcp-gateway-build.lock` in the Git common directory (shared by linked worktrees);
archives use `dist/.gateway-build.lock`. Crash-left locks require
[process-group recovery](packages.md#store-logs-and-recovery), never automatic deletion.

### Display and call counts

**`/gateway` → Display: Minimal / Full** saves raw configuration and applies immediately; other
sessions follow on reload or their next toggle.

Minimal shows ` MCP 3 services`: the last start/restart's count excluding disabled/unactivated
services, **not health**. `?` means configuration unavailable; `· !N` counts observed child
disconnects; `· off` means closed. Full also omits disabled/unactivated service counters without
erasing saved usage or changing the session total. If startup status is unavailable, only explicit
configuration disables are excluded. Full adds a wrapping panel below the editor:

```text
 MCP 3 services · 31 tool calls
 delegate ✓12 ✗0  │  pinote ✓17 ✗2  │  browser ✓0 ✗0
```

Click a **service name** for its controls (only connected services); keyboard:
**`/pi-services` → service → Enter**. Click an individual `✓`, `✗`, or `…` count for that
service's successful, failed, or pending child tool calls, including disconnected/`previous`
services. Keyboard fallback, also in Minimal mode: **`/gateway` → Tool call history → service
→ status**. Regular mode uses the terminal click handler; fullscreen uses native Pi clicks.
Nonzero successes `✓` are green, failures `✗` red, in-flight `…` amber; zeros/names muted.

History lists tool names and trimmed parameter/result previews. Enter opens a call with at most
two visible lines per preview. Result previews show readable text when available; expansion shows
the complete retained MCP response. **Tab** selects Parameters, Result/error, or Back; **Enter**
expands/collapses each payload independently. In fullscreen, click a section heading to toggle it.
Arrow keys or the mouse wheel scroll; regular mode also supports Page keys (fullscreen keeps Pi's
transcript page shortcuts). Back/Escape returns to the list. Selection, confirmation and cancel
follow Pi's configured selection keybindings. **r** refreshes the filtered list; an open call
updates when its result arrives or the connection closes. These are inline native screens,
not overlays, and do not send anything to the model.

Payload retention is **memory-only**, across explicit gateway restarts in the same loaded Pi
session: the newest **100 dispatches globally**, with at most **16,384 characters per parameter
or result payload** (larger values show a retention-truncation marker). Reload, shutdown,
new/resumed/forked sessions clear payload history; session-wide counters keep their existing
semantics below. Each filter shows retained versus full-session totals and the number whose
payloads are unavailable. Old payloads cannot be recovered or expanded past the retention limit.
Tool arguments/results can contain sensitive data: they are not written to gateway logs, Pi
session entries, or model context by the inspector. Terminal control sequences are sanitized
for display. This is a diagnostic preview, not an audit log or a secret-redaction feature.

- Count child tool dispatches, including background tool queries, even in Minimal mode. Exclude
  discovery, resources, settings, native actions, and pre-dispatch rejections.
- Success means non-error response, not verified outcome. Failure includes errors, timeouts,
  post-dispatch cancellations, interrupted/unconfirmed disconnect/reload calls, and approval denials
  returned as errors.
- Counts stay outside model context; survive restart/reload/resume; new sessions/forks start at
  zero. Tree navigation never rewinds usage. Scope: session/config path, since feature installation,
  without reconstructed history. Removed services with calls remain `previous`. Crashes may lose
  unflushed notifications; counters are not an audit log.

`notifications/gateway/tool-call` carries `{id, service, phase}`: UUID dispatch ID and `started`,
`success`, or `failure` at dispatch/settlement. Started events additionally carry the original
child `tool` name and bounded serialized `parameters`; settlement carries bounded serialized
`output` (service result or thrown error). These transient notifications are never persisted by
the adapter. Pre-dispatch rejections and gateway-owned tools emit nothing. No polling.

### Startup snapshot

Startup/reload animates configuration, gateway checks/updates, optional service updates, build check, connection, discovery,
apps, and panels above the editor; clears on success/failure/shutdown. Noninteractive sessions do
not animate. [Package progress/concurrency](packages.md#automatic-startup-updates).

New TUI sessions print display-only **Startup snapshot** cards: observed connection state, exposed
tool count, approximate context tokens (`3 tools · ≈1.2k tool-only tokens`), and names wrapping beneath each
service. These tool-only estimates exclude additional service context and reflect the configured Tools mode, using characters ÷ 4 including the
shared header/section wrapper; Off and services without model-visible tools cost zero. Per-service
estimates include shared overhead and should not be added together. They exclude future tool calls
and results; actual tokenizer counts vary. Older cards without estimates still render normally.
Call via `service__tool` through `gateway_call`. Disabled and unactivated managed services show `disabled`.

`experimental["gateway-status-v1"] = {}` advertises private read-only `gateway/status`: waits for
successful startup, rejects while closing, returns:

```text
{services: [{name, state, tools, toolNames}]}
```

- `state`: `connected`, `stopped` (disabled or unactivated managed package), or `disconnected`.
- `tools`: model-visible tool count, excluding gateway-owned/app-only tools.
- `toolNames`: original unprefixed names; older saved snapshots still render counts.

These are in-memory observations, not health checks, model tools, or a live dashboard. The adapter
reads at startup/restart for footer visibility, saving config-scoped entries outside model context
only for new sessions. Cards remain historical after restart; reload/resume/fork append none;
matching saved entries prevent duplicates.
Footer indicates connection; `/pi-services` opens current navigation. Failed/missing reads show
**Startup status unavailable** without closing working connections.

## Resources

`resources/subscribe`/`resources/unsubscribe` route by owner; updates reach subscribed URIs only.
List changes/disconnects propagate. Subscribe before reading; reread after updates. Without
subscriptions, read manually. Reads require no approval. Resource/returned-content URIs:

```text
gateway-resource://<service>/<percent-encoded-original-uri>
```

Observation requests with progress tokens receive standard heartbeats while queued/paginating; the
live adapter resets its timeout per heartbeat. Actual child requests retain normal
timeout/retirement policy.

The delegate adapter subscribes to validated `application/vnd.pi-delegate.jobs+json` version 1: **32
sources, 256 jobs/source, 1 MB/snapshot** maximum. The gateway forwards generically. See [panel
guide](integrations.md#live-delegate-panel).

## Approvals

`elicitation/create` carries approvals, not model results: flat form, one required boolean; other
forms cancelled; no credentials. Allow once returns `accept` with field `true`; Decline returns
`decline`; Cancel returns `cancel`.

Missing UI, timeout, disconnect, or abortion **never grants approval**. Dialogs serialize; incoming
confirmations cancel while gateway menus are open. TUI approval requires every disclosure line
displayed; Escape cancels, resizing resets review. Oversized disclosures are refused, not truncated.

Services must honor decisions; prompts/annotations are not permission enforcement/security
guarantees. Each service serializes forwarded requests, attributing confirmations to the active tool
without custom metadata; separate services run concurrently.

## Identity

`gateway__identity` returns `{ "sessionId": "<uuid>" }`. Children receive:
- `MCP_GATEWAY_SESSION_ID`: shared gateway UUID.
- `MCP_GATEWAY_SERVICE_ID`: configured name.
- `MCP_GATEWAY_WORKSPACE`: absolute launch directory, independent of child `cwd`.

Forwarded tools receive `_meta`:

```json
{
  "local-stdio-mcp-gateway/sessionId": "<uuid>",
  "local-stdio-mcp-gateway/serviceId": "files"
}
```

These override caller/config replacements; arguments/other metadata remain unchanged; progress
tokens translate. Children may forward identity to APIs/logs.

UUIDs identify gateway runs, not conversations: reconnect/restart/reload creates one; conversation
switches may recreate the gateway. [Native UI](native-ui.md) uses durable conversation
IDs/branch-local state. Identity/UI routing is not authentication, secrecy, or a sandbox.
Servers/OS-equipped agents have OS access; configure only trusted executables.

## Logs

Diagnostics use stderr and append-only `gateway.log` beside config; stdout is MCP-only. Top-level
`"logFile": "logs/gateway.log"` resolves relative to config, not cwd. New files: `0600`; parent must
exist/be writable. No automatic rotation/size limit. Each append reopens the path: concurrent
runs/restarts never truncate; external rotation works; writes are immediate.

```bash
tail -F /absolute/path/to/config-directory/gateway.log
```

Child stderr is verbatim and **may contain sensitive data**; tool arguments/results aren't logged.
Pre-log config/argument errors use stderr only. Unwritable logs block startup; later write failures
report to stderr and trigger cleanup.

## Lifecycle

### Startup and request failures

- All launched servers must initialize; failure aborts startup and awaits cleanup. Managed first
  installation requires manual preparation/activation and confirmed restart, never auto-update.
  [Local builds](packages.md#local-git-packages) update in place before connection; incomplete
  builds/validation block standalone/manual launches too.
- Tool/resource requests await startup; upstream EOF remains observed. Child disconnect removes
  tools; reconnect the gateway to restart it.
- In the Pi adapter, losing an initialized gateway during optional app/panel discovery leaves the
  footer **off** and recovery available, without an extra cancellation error. Startup failures and
  explicit cancellation still propagate after teardown; there is no automatic reconnect.
- Configured timeouts/cancellation apply; **no automatic tool retries**. Cancelling/timing out
  started requests, including resource reads, retires that connection/tools/resources until restart
  (`/reload` in adapter); other services remain connected. MCP cancellation lacks completion
  acknowledgement; retirement prevents misattributing late confirmations.

### Shutdown

Stdin closure or SIGINT/SIGTERM closes gateway/direct children:
1. After child EOF, allow **500 ms**.
2. SIGTERM; allow **500 ms**.
3. SIGKILL if needed; allow **1 second** to observe exit.
4. Allow **100 ms each** for remaining child diagnostics/buffered gateway stderr.

This fits upstream shutdown deadlines. Avoid detached/unmanaged descendants; clean them separately.
Failed gateway stderr triggers cleanup/suppresses further stderr; file logging remains.

**Restart/reload stops children and cancels active/queued jobs**—never saves settings or detaches
workers. Other sessions continue. [Confirmed restart/recovery](packages.md#workflow).
