# Local stdio MCP gateway

Run local MCP servers behind one stdio connection. Each launch gets its own UUID
and child processes—no shared daemon or HTTP server.

```text
Pi A ⇄ gateway A ⇄ child MCP processes A
Pi B ⇄ gateway B ⇄ child MCP processes B
```

Use it as a standalone MCP gateway, or add the optional Pi adapter for operator
menus, approvals, service settings/apps, and a live delegate panel.

> **Trusted processes, not a sandbox.** Servers run with your OS permissions.
> Gateway identity and private UI routing are not security boundaries. Only
> configure trusted executables.

## Contents

[Setup](#setup) · [Connect Pi](#connect-pi) · [Demo](#try-the-demo) ·
[Operator menu](#operator-menu) · [Troubleshooting](#troubleshooting) ·
[Documentation](#documentation) · [Development](#development-validation)

## Setup

Requires **Node.js 22+** and your child servers' runtimes. The adapter is tested
with **Pi 1.1.0**, which requires **Node.js 22.19+**.

From this checkout:

```bash
npm ci
npm run build
```

**Trying it first?** [Run the bundled counter demo](#try-the-demo); no external
MCP server is needed. Otherwise, configure your servers below.

### Configure your servers

```bash
cp gateway.example.json gateway.json
```

Replace the placeholder with your actual MCP server entry point:

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

- **Commands** are executables, not shell expressions; arguments are literal.
- **Paths:** `cwd` defaults to the config directory; relative values resolve there.
- **Environment:** children receive SDK defaults plus configured `env`, **not the
  full parent environment**. `${VARIABLE}` references in `env` read the gateway's
  environment; missing variables fail startup. Never check credentials into Git.
- **Names:** lowercase letters, digits, and hyphens, starting with a letter;
  `gateway` is reserved.
- Prefer `mcpServers`; legacy `servers` also works, but never specify both.
  Other clients' configuration options are not necessarily supported.

See [configuration and environment examples](docs/reference.md#configuration).

<a id="connect-pi-built-in-mcp-alternative"></a>

## Connect Pi

Choose **one** connection method. Never register the same gateway through both
`mcp.json` and the adapter.

### Option A: Pi adapter

For menus, approvals, settings, service apps, and live panels, run from this checkout:

```bash
pi --extension "$PWD/pi/gateway.ts" --gateway-config "$PWD/gateway.json"
```

Use absolute paths when launching elsewhere. The adapter starts one gateway with
the session and closes it and its children at shutdown.

Before each launch, the adapter checks content fingerprints of the gateway/example
sources, package manifest/lockfile, TypeScript configs, and compiled outputs.
Missing or changed output runs `npm run build` in this checkout before connecting;
the first launch after upgrading to this behavior also builds once to record a
fingerprint. Fresh builds are reused. This requires the development dependencies
from `npm ci` and POSIX process-group support; it never installs dependencies or
updates sources. Standalone/built-in MCP launches still require a manual build.

Concurrent adapter launches wait for the same checkout's build lock, with a
five-minute build/wait limit. Shutdown cancels compilation. Build failure leaves
the gateway disconnected rather than running stale output; inspect the reported
compiler error, run `npm ci` if dependencies changed, and retry `/reload` after
finishing other gateway jobs. A crashed Pi can leave `dist/.gateway-build.lock`:
remove it only after verifying its recorded PID and any compiler children are no
longer running. Already-running gateways are never rebuilt or restarted by this
check.

### Option B: Pi's built-in MCP client

For a plain MCP connection without adapter menus/panels, add this entry to
`mcp.json`, replacing the paths. **Do not load the adapter.**

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

Pi reads personal entries from `~/.pi/agent/mcp.json` and trusted project entries
from `.pi/mcp.json`. Diagnose with `pi mcp list`; use `/reload` after config changes.
Read the [restart warning](#troubleshooting) first if work is running.

## Try the demo

After the [install/build steps](#setup), edit `gateway.demo.json`: replace
`mcpServers.demo.args[0]` with this checkout's absolute path to
`dist/examples/demo-service.js`. JSON arguments do not expand `$PWD`.

**Shell:**

```bash
pi --extension "$PWD/pi/gateway.ts" --gateway-config "$PWD/gateway.demo.json"
```

**Ask Pi:**

```text
Use gateway_tools to discover demo__increment, then call it through gateway_call.
```

Allow the one-shot prompt and review its disclosure. The first approved call
returns `Counter is 1.`; declining leaves the counter unchanged. The counter is
in memory only.

**Pi command:** open **`/gateway` → Services → demo → Resources → Demo counter**.
Press **r** to refresh and **Escape** to go back.

## Operator menu

With the adapter, use `gateway_tools` to discover model-callable tools and
`gateway_call` to call them. Tools use names such as `example__read_file`.

**`/gateway`** opens the private operator menu; **`/pi-services`** opens Services
directly, or the recovery menu when disconnected. The bottom bar shows
` MCP 3 services`: the configured count from the last start/restart, **not a live
or healthy-service count**. Observed child disconnects add `· !N`; a closed gateway
shows `· off`. Before configuration is available the count is `?`. No status
polling is added.

New sessions also print a compact, display-only **startup snapshot** listing each
service's observed connection state and exposed tool count. Unactivated managed
services show `stopped · package not activated`. The snapshot excludes gateway-owned
tools and is not a health check or live dashboard. It is saved outside model
context; reload/resume/fork do not append duplicate cards. Status-read failures show
an unavailable summary without stopping a working gateway.

Click the whole MCP segment to open Services (or recovery when disconnected),
without starting a model turn. Kitty needs the existing
[footer-link handler](docs/native-ui.md#terminal-clicks); `/pi-services` is the
keyboard fallback. Menus/panels do not add their contents to model context.
Explicit tool results still reach the model.

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
| **Escape** | Go back; close at the root; return from an app to Services |
| **Tab** | Open settings for the highlighted service or current app |
| **Ctrl+O** in an app | Open its feature menu, including Resources |
| **↑/↓**, **PgUp/PgDn** in a viewer | Scroll details, inventory, logs, or resources |
| **r** in inventory/resources | Refresh; inventory refresh reads local metadata only |

A service without an app opens its feature menu. Closing settings returns to the
calling list/app. Menus remember selection while open, explain unavailable
features, and have no inactivity deadline. Service names reflect configuration
and the last launch, **not a health check**. Package/recovery menus remain usable
while disconnected; shutdown still cancels dialogs.

### Approvals

**Allow once**, **Decline**, and **Cancel** are distinct. Allow once requires
viewing every disclosure line before **Enter** confirms; resizing resets review.
Missing UI, timeouts, disconnects, and aborted calls **never grant approval**.
Incoming confirmations are cancelled while gateway menus are open.

Services must honor the decision; prompts are not general permission enforcement.
See the [approval contract](docs/reference.md#approvals).

### Child-server settings

Open **`/pi-services`**, highlight a service, and press **Tab**. Edit the draft,
choose **Save changes**, review every preview line, then confirm. Declining keeps
the draft editable; **Escape/Back** discards it. Type to filter settings/choices.

For a service implementing the [settings contract](docs/settings.md), add its
settings opt-in **inside the existing service entry**. For pi-delegate, add
`"settings": { "tokenEnv": "PI_DELEGATE_SETTINGS_TOKEN" }`.

This names an environment variable, not a token value; the gateway generates the
private token. Never put tokens in config or prompts. Settings require TUI mode.
See [editing and save behavior](docs/settings.md#operator-guide).

### Package manager

Open **`/gateway` → Packages** for inventory, update checks, preparation,
activation, and rollback. Inventory is read-only; checking installs nothing.
Writes and restarting all gateway services require separate confirmations.
Managed services stay stopped until their first manual preparation/activation.

Updates are manual by default. Top-level `"autoUpdate": true` authorizes startup
updates of already-activated managed packages, **including trusted download/build/
validation commands without per-update confirmation**. Other sessions' running
services are not restarted. Read the [package guide](docs/packages.md), including
its Git 2.45+/POSIX requirements, before enabling management.

## Integrations

### Browser service

[Connect pi-browser](docs/integrations.md#browser-service) for isolated Chromium,
profiles, manual login, and cookie approvals. Use one process per saved profile;
do not load both the browser service and its old native extension.

### Live delegate panel

[Connect pi-delegate](docs/integrations.md#live-delegate-panel) to show queued and
running jobs above the editor without polling or model turns. Completed means
**unverified**, not successful; disconnects show stale state, not completion.

### Server-driven UI

Services can provide native terminal apps without a model turn.
[Connect Pinote](docs/integrations.md#pinote) for an example, or see the
[native UI protocol](docs/native-ui.md) to implement a service.

<a id="lifecycle-and-validation"></a>

## Troubleshooting

| Symptom | Check or action |
|---|---|
| Startup fails | Every launched server must initialize. Check executable paths, required environment variables, stderr/logs, and log-directory writability. |
| Tools disappear after cancellation/timeout | A cancelled/timed-out started request retires that connection. Restart the gateway; calls are not retried automatically. Other services stay connected. |
| Settings unavailable | Requires TUI mode, service opt-in, and a compatible connected service. After a conflicting/uncertain save, reopen to read state; do not replay the save. A retired connection needs restart first. |
| Managed service stays stopped | Prepare and activate its first release manually, then confirm restart. Startup auto-update does not perform first installation. |

> **Restarting this gateway stops its children and cancels active/queued jobs.**
> Finish work first. `/reload` is not a settings-save or job-detach operation.
> Other Pi sessions keep running.

### Logs

Diagnostics go to stderr and `gateway.log` beside the config; stdout is MCP-only.
The log's parent directory must already exist and be writable. Child diagnostics
may contain sensitive data; the gateway does not log tool arguments/results.

```bash
tail -F /absolute/path/to/config-directory/gateway.log
```

See [log paths/rotation](docs/reference.md#logs) and
[request/shutdown behavior](docs/reference.md#lifecycle).

### Migration note

`/gateway-manager`, `/gateway-ui`, `/mcp-settings`, and `/gateway-panel` were
replaced by `/gateway` submenus. `gateway_tools` and `gateway_call` are unchanged.

<a id="identity"></a>

## Documentation

- [Integration recipes](docs/integrations.md): browser, delegate, and Pinote.
- [Gateway reference](docs/reference.md): configuration, protocol limits,
  [identity](docs/reference.md#identity), approvals, resources, logs, and lifecycle.
- [Package management](docs/packages.md): sources, updates, confirmations, rollback, recovery.
- [Service settings](docs/settings.md): operator guide and reusable protocol.
- [Native terminal UI](docs/native-ui.md): service protocol and terminal click setup.

## Development validation

```bash
npm run check
npm test
npm run build
```

Tests exercise real gateway processes and the Pi adapter.
