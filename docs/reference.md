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

### Adapter builds

Each launch fingerprints gateway/example sources, manifest/lockfile, TypeScript configs, and
compiled outputs. Missing/changed output runs `npm run build` here; the first launch after this
behavior's introduction also builds to record a fingerprint. Fresh builds are reused.

Requires `npm ci` development dependencies and **POSIX process-group support**. The build check
itself never installs dependencies or updates sources; the separate [gateway startup update
policy](packages.md#gateway-self-updates) can do both. Standalone/built-in launches need manual builds. Concurrent
launches, dependency imports and automatic updates share a **five-minute lock-wait limit**;
builds also have a five-minute deadline. The dependency-light adapter loader waits before importing
packages that an update may be replacing; the launch lock stays held through the child handshake.
Readiness and loaded-installation identity are rechecked under that lock. Shutdown cancels compilation; already-running gateways
are never rebuilt/restarted.

Failure leaves the gateway disconnected, not stale. Finish gateway jobs and wait for all updates
and builds before manually running `npm ci --include=dev`; manual npm commands do not take the
gateway lock. Start a fresh Pi with Auto update on to rebuild/validate an interrupted self-update.
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

Click names/counters for apps or feature menus; closing returns to the editor. Settings remain
separate, disabled when unavailable. Disconnected/`previous` services have no link. Keyboard:
**`/pi-services` → service → Enter**. Nonzero successes `✓` are green, failures `✗` red, in-flight
`…` amber; zeros/names muted.

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
`success`, or `failure` at dispatch/settlement. Pre-dispatch rejections and gateway-owned tools emit
nothing. No arguments/results or polling.

### Startup snapshot

Startup/reload animates configuration, gateway checks/updates, optional service updates, build check, connection, discovery,
apps, and panels above the editor; clears on success/failure/shutdown. Noninteractive sessions do
not animate. [Package progress/concurrency](packages.md#automatic-startup-updates).

New TUI sessions print display-only **Startup snapshot** cards: observed connection state, exposed
tool count, and names wrapping beneath each service. Call via `service__tool` through
`gateway_call`. Disabled and unactivated managed services show `disabled`.

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
