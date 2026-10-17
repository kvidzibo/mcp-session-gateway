# Local stdio MCP gateway

Run local MCP servers behind one stdio connection. Each launch has its own UUID and
child processes—no shared daemon or HTTP server.

```text
Pi A ⇄ gateway A ⇄ child MCP processes A
Pi B ⇄ gateway B ⇄ child MCP processes B
```

Use the standalone gateway or the optional Pi adapter for operator menus, approvals,
service settings/apps, and a live delegate panel.

> **Trusted processes, not a sandbox.** Servers run with your OS permissions.
> Gateway identity and private UI routing are not security boundaries. Configure
> only trusted executables.

## Contents

[Setup](#setup) · [Connect Pi](#connect-pi) · [Demo](#try-the-demo) · [Operator
menu](#operator-menu) · [Integrations](#integrations) ·
[Troubleshooting](#troubleshooting) · [Documentation](#documentation) ·
[Development](#development-validation)

## Setup

Requires **Node.js 22+** and your child servers' runtimes. The adapter is tested with
**Pi 1.1.0**, which requires **Node.js 22.19+**.

From this checkout:

```bash
npm ci
npm run build
```

To try it without an external server, skip to the [counter demo](#try-the-demo).
Otherwise, configure your servers.

### Configure your servers

```bash
cp gateway.example.json gateway.json
```

Replace the placeholder with your MCP server's entry point:

```json
{
  "mcpServers": {
    "example": {
      "command": "node",
      "args": ["/absolute/path/to/your/mcp-server.js"]
    }
  }
}
```

- **Commands:** executables, not shell expressions; arguments are literal.
- **Paths:** `cwd` defaults to the config directory; relative values resolve there.
  `MCP_GATEWAY_WORKSPACE` gives children the gateway launch directory (Pi's session
  workspace with the adapter), independent of their `cwd`.
- **Environment:** children receive SDK defaults plus configured `env`, **not the full
  parent environment**. `${VARIABLE}` in `env` reads the gateway environment; missing
  variables fail startup. Never commit credentials.
- **Names:** lowercase letters, digits, and hyphens, starting with a letter; `gateway`
  is reserved.
- Prefer `mcpServers`; legacy `servers` works, but specifying both is an error. Other
  clients' configuration options are not necessarily supported.

See [configuration and environment examples](docs/reference.md#configuration).

<a id="connect-pi-built-in-mcp-alternative"></a>

## Connect Pi

Choose **one** method. Never register the same gateway through both `mcp.json` and the
adapter.

### Option A: Pi adapter

For menus, approvals, settings, service apps, and live panels, run from this checkout:

```bash
pi --extension "$PWD/pi/gateway.ts" --gateway-config "$PWD/gateway.json"
```

Use absolute paths when launching elsewhere. The adapter starts one gateway with the
session and closes it and its children at shutdown.

Before connecting, it rebuilds missing/stale output with `npm run build`. This requires
development dependencies from `npm ci` and POSIX process-group support; it never
installs dependencies or updates sources. Build failure leaves the gateway disconnected,
not running stale output. See [build checks, locking, and
recovery](docs/reference.md#adapter-builds).

### Option B: Pi's built-in MCP client

For plain MCP without adapter menus/panels, add this to `mcp.json`, replacing the paths.
**Do not load the adapter.** Standalone/built-in launches require a manual build.

```json
{
  "mcpServers": {
    "gateway": {
      "command": "node",
      "args": [
        "/absolute/path/to/mcp-session-gateway/dist/cli.js",
        "--config",
        "/absolute/path/to/mcp-session-gateway/gateway.json"
      ]
    }
  }
}
```

Pi reads `~/.pi/agent/mcp.json` and trusted projects' `.pi/mcp.json`. Diagnose with `pi
mcp list`; use `/reload` after config changes. If work is running, read the [restart
warning](#troubleshooting) first.

## Try the demo

1. Complete [setup](#setup), then edit `gateway.demo.json`: replace
   `mcpServers.demo.args[0]` with this checkout's absolute path to
   `dist/examples/demo-service.js`. JSON arguments do not expand `$PWD`.
2. Launch:

   ```bash
   pi --extension "$PWD/pi/gateway.ts" --gateway-config "$PWD/gateway.demo.json"
   ```

3. Ask Pi:

   ```text
   Use gateway_tools to discover demo__increment, then call it through gateway_call.
   ```

4. Review the one-shot disclosure and allow the call. The first approved call returns
   `Counter is 1.`; declining leaves the in-memory counter unchanged.
5. Open **`/gateway` → Services → demo → Resources → Demo counter**. Press **r** to
   refresh and **Escape** to return.

## Operator menu

Use `gateway_tools` to discover model-callable tools and `gateway_call` to call names
such as `example__read_file`.

**`/gateway`** opens the private operator menu. **`/pi-services`** opens Services, or
recovery when disconnected. Menus/panels stay outside model context; explicit tool
results still reach the model.

```text
Gateway
├─ Services → service → app (or feature menu if no app)
│  ├─ Tab → Settings (also from the service list)
│  └─ Ctrl+O → service features → Open app / Settings / Resources
├─ Packages
│  ├─ Installed versions
│  ├─ Check for updates
│  └─ Manage releases → package → prepare / activate / roll back / log
├─ Update all packages → confirm a one-time update; no restart
├─ Auto update: Off / On → toggle and save immediately
├─ Display: Minimal / Full → toggle and save immediately
└─ Connection
   ├─ Connection details
   └─ Restart gateway services…
```

| Key | Action |
|---|---|
| **↑/↓**, **Enter** | Select and open |
| **Escape** | Go back; close at root; return from an app to Services |
| **Tab** | Settings for the highlighted service or current app |
| **Ctrl+O** in an app | Feature menu, including Resources |
| **↑/↓**, **PgUp/PgDn** in a viewer | Scroll details, inventory, logs, or resources |
| **r** in inventory/resources | Refresh; inventory reads local metadata only |

Settings return to the calling list/app when closed and are disabled in the feature menu
when unavailable. Menus remember selection while open, explain unavailable features, and
have no inactivity deadline. Service names reflect configuration and the last launch,
**not health**. Package/recovery menus work while disconnected; shutdown cancels
dialogs.

The footer's ` MCP 3 services` is the configured count at the last start/restart, **not
a live or healthy-service count**. Click the whole segment to open Services or recovery
without a model turn. Kitty requires the existing [footer-link
handler](docs/native-ui.md#terminal-clicks); `/pi-services` is the keyboard fallback.

**Display: Minimal / Full** saves immediately. Full adds clickable per-service call
counts below the editor; [display and counter
semantics](docs/reference.md#display-and-call-counts) cover totals, failures,
persistence, and disconnect indicators.

Startup/reload shows an animated stage indicator; new sessions also receive a
display-only [startup snapshot](docs/reference.md#startup-snapshot) of observed
connections and tools. Neither adds status polling or a health check.

### Approvals

**Allow once**, **Decline**, and **Cancel** are distinct. Allow once requires viewing
every disclosure line before **Enter** confirms; resizing resets review. Missing UI,
timeouts, disconnects, and aborted calls **never grant approval**. Incoming
confirmations are cancelled while gateway menus are open.

Services must honor the decision; prompts are not general permission enforcement. See
the [approval contract](docs/reference.md#approvals).

### Child-server settings

1. Open **`/pi-services`**, highlight a service, and press **Tab**.
2. Edit the draft; type to filter settings/choices.
3. Choose **Save changes**, review every preview line, then confirm. Declining keeps the
   draft editable; **Escape/Back** discards it.

Settings require TUI mode and a service implementing the [settings
contract](docs/settings.md). Add its opt-in **inside the existing service entry**; for
pi-delegate: `"settings": { "tokenEnv": "PI_DELEGATE_SETTINGS_TOKEN" }`.

This names an environment variable, not a token value; the gateway generates the private
token. Never put tokens in config or prompts. See [editing and save
behavior](docs/settings.md#operator-guide).

### Package manager

**`/gateway` → Packages** provides inventory, update checks, preparation, activation,
and rollback. Inventory is read-only; checking installs nothing. Writes and restarting
all gateway services require separate confirmations. Managed services remain stopped
until first manual preparation/activation.

Updates default to manual. **Auto update: Off/On** saves immediately to the selected
config, even while disconnected; it rewrites JSON formatting but preserves other values.
It affects the next startup/reload, not running services. You can also edit top-level
`"autoUpdate"` directly.

**`"autoUpdate": true` authorizes trusted download/build/validation commands without
per-update confirmation.** Eligible activated managed releases and explicitly configured
[local Git packages](docs/packages.md#local-git-packages) update before connection;
other development folders are never adopted. Other sessions' running services are not
restarted.

Read the [package guide](docs/packages.md), including **Git 2.45+/POSIX** requirements
and [update concurrency/resource limits](docs/packages.md#automatic-startup-updates),
before enabling management.

## Integrations

### Browser service

[Connect pi-browser](docs/integrations.md#browser-service) for isolated Chromium,
profiles, manual login, and cookie approvals. Use one process per saved profile; do not
load both the service and its old native extension.

### Live delegate panel

[Connect pi-delegate](docs/integrations.md#live-delegate-panel) for queued/running jobs
above the editor without polling or model turns. Completed means **unverified**, not
successful; disconnects show stale state, not completion.

### Server-driven UI

Services can provide native terminal apps without a model turn. [Connect
Pinote](docs/integrations.md#pinote) or implement the [native UI
protocol](docs/native-ui.md).

<a id="lifecycle-and-validation"></a>

## Troubleshooting

| Symptom | Check or action |
|---|---|
| Startup fails | Every launched server must initialize. Check executable paths, required environment variables, stderr/logs, and log-directory writability. |
| Tools disappear after cancellation/timeout | A cancelled/timed-out started request retires that connection. Restart the gateway; calls are not retried. Other services stay connected. |
| Settings unavailable | Requires TUI mode, opt-in, and a compatible connected service. After a conflicting/uncertain save, reopen to read state; do not replay it. Restart a retired connection first. |
| Managed service stays stopped | Manually prepare and activate its first release, then confirm restart. Auto-update does not perform first installation. |

> **Restarting this gateway stops its children and cancels active/queued jobs.**
> Finish work first. `/reload` neither saves settings nor detaches jobs.
> Other Pi sessions keep running.

### Logs

Diagnostics go to stderr and `gateway.log` beside the config; stdout is MCP-only. The
parent directory must exist and be writable. Child diagnostics may contain sensitive
data; the gateway does not log tool arguments/results.

```bash
tail -F /absolute/path/to/config-directory/gateway.log
```

See [log paths/rotation](docs/reference.md#logs) and [request/shutdown
behavior](docs/reference.md#lifecycle).

### Migration note

`/gateway-manager`, `/gateway-ui`, `/mcp-settings`, and `/gateway-panel` became
`/gateway` submenus. `gateway_tools` and `gateway_call` are unchanged.

<a id="identity"></a>

## Documentation

- [Integration recipes](docs/integrations.md): browser, delegate, Pinote.
- [Gateway reference](docs/reference.md): configuration, builds, counters, snapshots,
  protocol limits, [identity](docs/reference.md#identity), approvals, resources, logs,
  lifecycle.
- [Package management](docs/packages.md): sources, updates, confirmations, rollback,
  recovery.
- [Service settings](docs/settings.md): operator guide and reusable protocol.
- [Native terminal UI](docs/native-ui.md): service protocol and terminal clicks.

## Development validation

```bash
npm run check
npm test
npm run build
```

Tests exercise real gateway processes and the Pi adapter.
