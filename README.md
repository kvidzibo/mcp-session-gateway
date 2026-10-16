# Local stdio MCP gateway

Run local MCP servers behind one stdio connection. Each gateway launch gets its
own UUID and child processes—there is no shared daemon, HTTP server, or socket.

```text
Pi A ⇄ gateway A ⇄ child MCP processes A
Pi B ⇄ gateway B ⇄ child MCP processes B
```

The gateway forwards tools and subscribable resources. The optional Pi adapter
adds operator menus, service settings, approval dialogs, native service apps, and
a live delegate panel. The standalone gateway needs no Pi packages.

> **Trusted processes, not a sandbox.** Configured servers run with your OS
> permissions. Gateway identity and private UI routing are not security boundaries.
> Only configure trusted executables.

## Contents

- **Get started:** [Setup](#setup) · [Connect Pi](#connect-pi) · [Try the demo](#try-the-demo)
- **Use the adapter:** [Operator menu](#operator-menu) · [Approvals](#approvals) · [Child-server settings](#child-server-settings)
- **Optional features:** [Package manager](#package-manager) · [Browser service](#browser-service) · [Live delegate panel](#live-delegate-panel) · [Server-driven UI](#server-driven-ui)
- **Reference:** [Identity](#identity) · [Logs](#logs) · [Lifecycle and validation](#lifecycle-and-validation)

## Setup

### 1. Install and build

Requires **Node.js 22+** and the runtimes needed by your child servers. The optional
adapter is tested with **Pi 1.1.0**, which requires **Node.js 22.19+**.

From this checkout:

```bash
npm ci
npm run build
cp gateway.example.json gateway.json
```

### 2. Configure your servers

Replace the example commands in `gateway.json` with your actual MCP servers:

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

Configuration rules:

- **Server map:** prefer `mcpServers`. Legacy `servers` also works, but specifying
  both is an error. Only documented gateway options are supported; matching other
  MCP clients' map name does not imply full configuration compatibility.
- **Commands:** executables, not shell expressions. Arguments are passed literally.
- **Paths:** `cwd` defaults to the config directory; relative values resolve there.
- **Names:** lowercase letters, digits, and hyphens, starting with a letter.
  `gateway` is reserved.
- **Environment:** children receive the MCP SDK's minimal defaults plus their
  configured `env`, **not the full parent environment**. `${VARIABLE}` references
  resolve from the gateway environment; missing variables fail startup. Keep
  credentials out of checked-in config files.

### 3. Choose a Pi connection

Use **one** of the options below. Never register the same gateway through both
`mcp.json` and the adapter.

<a id="connect-pi-built-in-mcp-alternative"></a>

## Connect Pi

### Option A: Pi adapter

Choose this for gateway menus, settings, approvals, service apps, and live panels:

```bash
pi --extension "$PWD/pi/gateway.ts" --gateway-config "$PWD/gateway.json"
```

Run this from the checkout, or replace both paths with absolute paths.

| Command or tool | Purpose |
|---|---|
| `gateway_tools` | Discover live model-callable tools |
| `gateway_call` | Call a tool after validating its advertised JSON Schema (2020-12) |
| `/gateway` | Open the operator menu |
| `/pi-services` | Open Services directly; open the recovery menu when disconnected |

The adapter starts one gateway on `session_start`, creates no process at extension
load time, and closes it idempotently at shutdown. The gateway inherits Pi's
environment so `${VARIABLE}` references work; children still receive only SDK
defaults and configured `env`.

Panel contents are not added to the conversation, and the adapter registers no
resource tools. UI-only tools are omitted and rejected; tools visible to both
model and app remain callable. Agents with other OS tools can still access the
same system—this routing is not a secrecy boundary.

### Option B: Pi's built-in MCP client

Choose this for a plain MCP connection without the adapter's menus or panels.
**Do not load the adapter.** Add this entry to `mcp.json`, replacing the paths:

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

Pi reads personal entries from `~/.pi/agent/mcp.json` and trusted project entries
from `.pi/mcp.json`. Diagnose with `pi mcp list`; use `/reload` after configuration
changes in an existing session. No Pi extension is required.

### Tool names and protocol limits

Tools use `<server>__<tool>`, for example `files__read_file`; Pi adds its own MCP
namespace. Namespaced names must fit MCP's 128-character limit. Duplicate or
invalid names fail discovery.

Paginated tool discovery, tool-list changes, and standard resource subscriptions
are supported. Task-required tools are omitted. Sampling, tasks, resource
templates, and browser-based MCP Apps are not forwarded.

## Try the demo

The demo only increments an in-memory counter. From this checkout:

```bash
npm run build
# In gateway.demo.json, replace the service path with this checkout's absolute path.
pi --extension "$PWD/pi/gateway.ts" --gateway-config "$PWD/gateway.demo.json"
```

1. Ask the model to discover tools with `gateway_tools` and call `demo__increment`
   through `gateway_call`.
2. Approve or decline the one-shot prompt.
3. Open **`/gateway` → Services → demo → Resources → Demo counter**.
   Press **r** to refresh and **Escape** to go back.

## Operator menu

**`/gateway`** opens the private operator menu. **`/pi-services`** opens Services
directly, or the root menu when disconnected. Neither starts a model turn.

```text
Gateway
├─ Services → service → app (when available)
│  ├─ Tab → Settings (also from the service list)
│  └─ Ctrl+O → service features → Open app / Settings / Resources
├─ Packages
│  ├─ Installed versions
│  ├─ Check for updates
│  └─ Manage releases → package → prepare / activate / roll back / log
└─ Connection
   ├─ Connection details
   └─ Restart gateway services…
```

| Key | Action |
|---|---|
| **↑/↓**, **Enter** | Select and open an item |
| **Escape** | Go back one level; close at the root; return from an app to Services |
| **Tab** | Open settings for the highlighted service or current app; closing returns there |
| **Ctrl+O** in an app | Open its feature menu, including Resources |
| **↑/↓**, **PgUp/PgDn** in a viewer | Scroll details, inventory, logs, or resources |
| **r** in inventory/resources | Refresh; inventory refresh reads local metadata only |

Selecting a service opens its app when available, otherwise its feature menu.
Menus remember your selection while open. Unavailable features stay visible with
an explanation. Service names reflect configuration and the last launch, not a
health check. Package and recovery menus work while disconnected. Navigation has
no inactivity deadline; shutdown still cancels dialogs.

The former `/gateway-manager`, `/gateway-ui`, `/mcp-settings`, and `/gateway-panel`
commands have been removed. Their actions are in these submenus; `gateway_tools`
and `gateway_call` are unchanged.

## Approvals

One-shot approvals use standard MCP `elicitation/create`, not model-visible tool
results. Services must request a flat form with one required boolean field;
other forms are cancelled. No credentials are collected.

- **Allow once** returns `accept` with that field set to `true`.
- **Decline** and **Cancel** remain distinct.
- Missing UI, timeouts, disconnects, and aborted calls never grant approval.
- Dialogs are serialized. Incoming confirmations are cancelled while gateway
  menus are open.
- In TUI mode, Allow once opens a scrollable disclosure. Every line must be
  displayed before **Enter** grants approval; **Escape** cancels and resizing
  resets review. Oversized disclosures are refused, not silently truncated.

Services must check the decision before acting. These are cooperative prompts,
not general permission enforcement; tool annotations are hints, not guarantees.

Each service processes one forwarded request at a time, so confirmations can be
attributed to the active tool without custom metadata. Separate services can run
concurrently. Resource reads do not trigger approval prompts.

## Child-server settings

### Open and edit

With the adapter, open **`/pi-services`**, highlight a service, and press **Tab**.
You can also press **Tab** in its app or choose Settings from its feature menu.
Settings come from the child's schema, not hardcoded service names or Pi's model
catalogue.

1. Edit the local draft. Type in settings or choice lists to filter by
   case-insensitive words, including model names/providers; **Backspace** edits
   the search and **Escape** goes back.
2. Choose **Save changes** and review the exact changes. Every preview line must
   be displayed before **Enter** can save; resizing resets review.
3. Confirm to save. Declining leaves the draft editable; **Escape/Back** discards it.

Scrollable overlays keep controls visible with editor widgets and custom footers.
Settings require TUI mode and cannot overlap one-shot approval prompts.

### Enable a service

Only enable services implementing the [operator settings contract](docs/settings.md):

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

For another service, use its documented token environment variable. The gateway
generates private per-service tokens—never put tokens in config or prompts. Only
opted-in, connected services advertising contract version 1 appear. Services
without settings continue to work normally.

### Supported fields and save behavior

- **Editable:** nested objects with string, number, integer, boolean, enum, and
  constant-choice fields, plus read-only hints. Free-form strings/numbers use
  JSON value input (quote strings); previews escape significant whitespace.
- **Not editable:** arrays, references, complex unions, and secrets.
- **Validation:** JSON Schema constraints are checked before saving. The child
  owns validation, atomic persistence, and revisions.
- **Model catalogues:** optional catalogues follow pi-delegate's contract.
  Unavailable models remain visible but cannot be selected. Changing models
  selects supported reasoning in the same save; no fallback is chosen.
- **Apply policy:** pi-delegate changes affect **future jobs**, not running/queued
  jobs. Other services report their own policy.
- **Conflicts or uncertain writes:** reopen to read current state. Saves are
  never replayed automatically.

Manual external changes may require collecting/cancelling work before restarting
that child. **Do not use `/reload` to save settings:** it restarts the gateway and
its children.

Settings use authenticated custom RPC on existing connections, never tools,
resources, or model messages. No settings route exists outside TUI mode, and Pi's
built-in MCP connection has no gateway settings menu. This is routing isolation,
not a sandbox. See the [protocol](docs/settings.md) for client/service integration.

## Package manager

Open **`/gateway` → Packages**. Package sources/installations are separate from
service launch configuration and service-owned settings. Add a `packages` map
and optional service `package` references alongside `mcpServers`; no
service-specific host code or UI support is required.

| Action | Effect |
|---|---|
| **Installed versions** | Read local metadata |
| **Check for updates** | Check public npm versions or HTTPS Git branch heads; install nothing |
| **Manage releases** | Prepare/build/validate, activate, roll back, or view the last preparation log; writes require separate confirmation |
| **Connection → Restart gateway services…** | Separately confirm restarting **all services in this gateway**, cancelling active/queued jobs; other sessions keep running |

Use [`gateway.managed.example.json`](gateway.managed.example.json) with your actual
URL, commands, and entry point. Git sources default to **main**. Managed launches
use `{{packageRoot}}`; before first activation they stay stopped. Existing folders
remain externally managed and are never silently adopted or overwritten.

### Optional startup updates

Updates are **manual by default**. Setting top-level `"autoUpdate": true` opts the
Pi adapter into this policy on startup/reload:

1. Check already-activated managed packages linked to servers.
2. Prepare and validate newer releases, then activate them **before** services launch.
3. Post a display-only chat notice listing actual updates; stay quiet when up to date.

First installs and external checkouts remain manual. Other sessions' running
services are not restarted. Failures warn and use the current activation, with
no automatic retry.

> This opt-in authorizes trusted download/build/validation commands **without
> per-update confirmation**. Builds run with your OS permissions.

Opening inventory stays read-only. Managed builds require POSIX; Git inspection
requires **Git 2.45+**. Read [configuration, confirmations, storage, rollback, and
recovery](docs/packages.md) before enabling management.

## Browser service

[pi-browser 0.6.0+](https://github.com/kvidzibo/pi-browser/blob/main/docs/mcp.md)
provides isolated Chromium as a stdio service.

### Connect

- **Managed:** use [`gateway.browser.example.json`](gateway.browser.example.json)
  after that version is available on the browser's `main` branch.
- **Existing checkout:** run `npm ci && npm run build:mcp` in a tested browser
  checkout, then configure `node /absolute/path/to/pi-browser/mcp/cli.mjs`.

Merge entries into your configuration; do not replace other services. Preparation,
activation, and restart remain explicit actions unless you enable the
[startup update policy](#optional-startup-updates).

### Use safely

- Discover `browser__browser` with `gateway_tools`; call it with `gateway_call`.
- Open **`/gateway` → Services → browser** for profiles, manual login, cookie-site
  selection, display modes, and logout. Cookie approval uses form elicitation;
  missing UI never grants access. Approvals/UI actions are not model tool results.
- Allow enough `timeoutMs` for consent and startup; the example uses **180 seconds**.
- Forward display, keyring, and agent-directory environment variables only when
  needed; see the browser service guide.
- Use each saved profile in only one process. After approving migration, remove
  the old native browser extension and reload. Loading both creates independent
  sessions that can contend for profiles. Do not remove the old setup beforehand.

No browser-specific host code or private socket is needed.

## Live delegate panel

The adapter automatically subscribes to resources from
[pi-delegate 0.20.0+](https://github.com/kvidzibo/pi-delegate#readme) declaring MIME
type `application/vnd.pi-delegate.jobs+json` (schema version 1). Add a service to
the adapter's configuration:

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

### What the panel shows

Queued/running jobs appear **above the editor**, even while the parent is idle.
Cards show role, model/reasoning, task preview, elapsed/queue time, job ID, and
current/recent tool activity. Small terminals show overflow counts.

- Completed jobs remain for **eight seconds**. Finished means **unverified**, not
  successful.
- Disconnects show a stale warning and freeze the last-known clock; they do not
  imply completion.
- Open **`/gateway` → Services → service → Ctrl+O → Resources** for full JSON when
  the service has an app; otherwise choose Resources from its feature menu.
- Settings and approvals remain usable while the widget is visible.

One gateway connection serves both tools and UI. The adapter does not load the
original delegate extension, start an observer server, poll jobs, send chat
messages, or trigger model turns. Clock ticks are local; MCP reads happen on
discovery and change notifications, with bursts coalesced.

Resources are not a secrecy boundary; models still see explicit tool results.
Outside TUI mode, no widget or subscriptions start. **Reload closes the connection
and its workers; it does not detach jobs.**

### Resource forwarding

- `resources/subscribe` and `resources/unsubscribe` route to the owning service.
  Updates go only to subscribed URIs; resource-list changes and disconnects
  propagate upstream. Subscribe before reading, then reread after each update.
  Services without subscriptions retain manual reads.
- Resource and returned-content URIs are wrapped as
  `gateway-resource://<service>/<percent-encoded-original-uri>`.
- Observation requests supplying a progress token receive standard heartbeats
  while queued or aggregating pages. The live adapter resets its timeout on each
  heartbeat, so total discovery can exceed one child-request timeout. Each actual
  child request keeps its normal timeout and retirement policy.
- Resource templates are not forwarded. The gateway does not interpret delegate
  JSON; rendering lives in `pi/live-jobs.ts`. The adapter validates the format and
  caps it at **32 sources, 256 jobs per source, and 1 MB per snapshot**.

## Server-driven UI

Services can provide menus, settings forms, previews, and footer text through the
[native UI v1 protocol](docs/native-ui.md). Selecting a service opens its app when
available; **Open app** is also in the feature menu. Clicks and keyboard actions
go directly to the service without a model turn.

The adapter is generic: Pinote screens and behavior live in Pinote's MCP server.
UI state follows the Pi conversation/branch, not the gateway UUID. Services can
retain state across `/new`, return state from model tools, and expose clickable
footer actions. Preview actions add display-only transcript entries; completing
a task never resets the conversation. Terminal clicks need the
[protocol handler](docs/native-ui.md); the app menu is the keyboard fallback.
Pinote MCP suggestions/actions require gateway **0.12.0+**.

### Pinote example

In a Pinote checkout, install its `pi/` dependencies and Python CLI, then build the
MCP server (Node.js 22.19+):

```bash
npm --prefix /absolute/path/to/pinote/pi run build:mcp
```

Register the service:

```json
{
  "mcpServers": {
    "pinote": {
      "command": "node",
      "args": ["/absolute/path/to/pinote/pi/dist-mcp/mcp/server.js"],
      "env": { "PINOTE_NOTE_COMMAND": "/absolute/path/to/pinote/.venv/bin/note" }
    }
  }
}
```

Pass `PI_CODING_AGENT_DIR` and XDG overrides explicitly in service `env` if used;
children do not inherit them. Do not also load the old Pinote-specific extension
unless you want separate selections and duplicate UI. Keep the existing setup
until its replacement is tested; installation does not migrate it automatically.

## Identity

Call `gateway__identity` to get `{ "sessionId": "<uuid>" }`.

Every child receives:

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

These values override caller/config attempts to replace them. Tool arguments stay
unchanged, other metadata is preserved, and progress tokens are translated
between connections. Children can forward identity to their APIs or logs.

**Identity belongs to the gateway run, not the Pi conversation.** Reconnect,
restart, or reload creates a new UUID; switching Pi conversations may also
recreate the gateway. The native UI host supplies a separate durable conversation
ID and branch-local opaque state. The gateway UUID remains an ephemeral
correlation label, not authentication.

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
does not log tool arguments/results. Errors before logging initializes appear
only on stderr. An unwritable log prevents startup; a later write failure reports
to stderr and triggers cleanup.

## Lifecycle and validation

### Startup and request failures

- All launched servers must initialize. Any failure aborts startup and waits for
  child cleanup. Managed services without an active release stay stopped until
  manual preparation, activation, and confirmed restart; auto-update does not
  install them.
- The upstream handshake runs first, so children advertise form elicitation only
  when the harness supports it. Tool/resource requests wait for child startup;
  upstream EOF is observed throughout.
- A child disconnect removes its tools. Reconnect the gateway to restart it.
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

### Validate changes

```bash
npm run check
npm test
npm run build
```

Integration tests run real gateway processes. They cover identity isolation and
propagation, namespaced routing and unknown tools, approval/decline/cancellation
and no-UI behavior, manual/live panels through Pi's extension loader, subscription
routing and disconnects, narrow-width rendering, authenticated settings,
confirmed schema-valid saves and stale revisions, and stubborn-child cleanup
after startup timeout, upstream EOF, SDK shutdown, or a closed stderr reader.
