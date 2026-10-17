# Local stdio MCP gateway

Run local MCP servers behind one stdio connection. Each launch owns its UUID and child processes—no
shared daemon or HTTP server.

```text
Pi A ⇄ gateway A ⇄ child MCP processes A
Pi B ⇄ gateway B ⇄ child MCP processes B
```

The optional Pi adapter adds operator menus, approvals, settings, service apps and live panels.

> **Not a sandbox.** Configure only trusted executables: servers run with your OS
> permissions. Identity and private UI routing are not security boundaries.

## Contents

[Setup](#setup) · [Connect Pi](#connect-pi) · [Demo](#try-the-demo) · [Operator
menu](#operator-menu) · [Troubleshooting](#troubleshooting) · [Documentation](#documentation) ·
[Development](#development-validation)

## Setup

Requires **Node.js 22+** and the child servers' runtimes. The adapter is tested with **Pi 1.1.0**,
which requires **Node.js 22.19+**.

```bash
npm ci
npm run build
```

To try it without another server, use the [counter demo](#try-the-demo).

### Configure your servers

Copy `gateway.example.json` to `gateway.json` and replace the entry point:

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

Commands are executables, not shell expressions; arguments are literal. `cwd` defaults to the config
directory. Children receive SDK defaults plus configured `env`, **not the full parent environment**.
`${VARIABLE}` in `env` reads the gateway environment; missing variables fail startup. Never commit
credentials.

See [configuration](docs/reference.md#configuration) for paths, names, environment and legacy
`servers` support.

<a id="connect-pi-built-in-mcp-alternative"></a>

## Connect Pi

Choose **one** method; never register the same gateway through both.

### Option A: Pi adapter

From this checkout:

```bash
pi --extension "$PWD/pi/gateway.ts" --gateway-config "$PWD/gateway.json"
```

Use absolute paths elsewhere. The adapter starts one gateway with the session and closes it and its
children at shutdown. It rebuilds stale/missing output before connecting; this requires development
dependencies and POSIX process groups. [Build checks and recovery](docs/reference.md#adapter-builds)
cover failures and locks.

### Option B: Pi's built-in MCP client

For plain MCP without adapter menus/panels, add this to `mcp.json`. Replace the paths, build
manually, and **do not load the adapter**.

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

Pi reads `~/.pi/agent/mcp.json` and trusted projects' `.pi/mcp.json`. Diagnose with `pi mcp list`;
`/reload` applies changes but [stops active jobs](#troubleshooting).

## Try the demo

1. Complete [setup](#setup). In `gateway.demo.json`, replace `mcpServers.demo.args[0]` with this
   checkout's absolute path to `dist/examples/demo-service.js`. JSON arguments do not expand `$PWD`.
2. Launch:
   ```bash
   pi --extension "$PWD/pi/gateway.ts" --gateway-config "$PWD/gateway.demo.json"
   ```
3. Ask Pi:
   ```text
   Use gateway_tools to discover demo__increment, then call it through gateway_call.
   ```
4. Review and allow the disclosure. The first approved call returns `Counter is 1.`; declining
   leaves the in-memory counter unchanged.
5. Open **`/gateway` → Services → demo → Resources → Demo counter**. Press **r** to refresh or
   **Escape** to return.

## Operator menu

`gateway_tools` discovers model-callable tools; `gateway_call` calls names such as
`example__read_file`. Menus/panels stay outside model context; explicit tool results still reach the
model.

| Command/action | Purpose |
|---|---|
| `/gateway` | Operator menu; package/recovery actions also work disconnected |
| `/pi-services` | Services, or recovery when disconnected |
| Service → Enter | Controls: enable/disable, app, settings and resources |
| Tab | Service settings; closing returns to the calling list/app |
| Ctrl+O in an app | Features, including Resources |
| Escape | Back; close at root; return from an app to Services |

Use arrows/Enter to navigate; viewers support Arrow/Page keys and **r** refresh (inventory refresh
is local). Menus remember selection, explain unavailable features and have no inactivity deadline;
shutdown cancels dialogs.

The footer's ` MCP 3 services` is the last configured count, **not health**. Click it to open
Services/recovery; Kitty needs the [click handler](docs/native-ui.md#terminal-clicks). **Display:
Minimal / Full** saves immediately; Full adds clickable service counters. See [counter
semantics](docs/reference.md#display-and-call-counts) and the historical [startup
snapshot](docs/reference.md#startup-snapshot).

### Approvals

**Allow once**, **Decline** and **Cancel** differ. Allow once requires viewing every disclosure line
before Enter; resizing resets review. Missing UI, timeout, disconnect or cancellation never
approves. Incoming confirmations are cancelled while menus are open. Services must honor decisions;
[prompts are cooperative](docs/reference.md#approvals).

### Enable or disable a service

Choose **Services → service → Disable service / Enable service**. The choice saves immediately
for future launches in all sessions sharing the config; running services stay unchanged. Disabled
services remain listed and launch no process or tools. Choose **Connection / restart… → Restart
gateway services…** to apply here after reviewing the confirmation. Restart cancels active/queued
jobs for **all** services in this session. Services controls also work while disconnected.

### Child-server settings

Highlight a service and press **Tab**; edit, choose **Save changes**, review and confirm. Declining
keeps the draft; Escape/Back discards it. Type to filter. Settings require TUI mode and [service
opt-in](docs/settings.md). For pi-delegate, add `"settings": { "tokenEnv":
"PI_DELEGATE_SETTINGS_TOKEN" }` inside its existing entry. This names a variable, not a token value;
never configure the token.

### Package manager

**Packages** offers inventory, update checks, preparation, activation and rollback; **Connection**
offers restart. Inventory/checks install nothing. First managed installation and restart require
separate confirmations.

**Auto update: Off/On** saves immediately and affects the next startup/reload, not running services.
Enabling it authorizes trusted downloads/builds/validation without per-update prompts. Read the
[package guide](docs/packages.md) before enabling it, including Git 2.45+/POSIX requirements and
in-place local-update effects.

## Integrations

### Browser service

[pi-browser](docs/integrations.md#browser-service): isolated Chromium, profiles, manual login and
cookie approvals. One process per saved profile; do not also load the old native extension.

### Live delegate panel

[pi-delegate](docs/integrations.md#live-delegate-panel): jobs above the editor, without
polling/model turns. Finished means **unverified**; disconnect means stale.

### Server-driven UI

[Pinote](docs/integrations.md#pinote) is an example of the generic [native UI
protocol](docs/native-ui.md).

<a id="lifecycle-and-validation"></a>

## Troubleshooting

| Symptom | Action |
|---|---|
| Startup fails | Check executable paths, required env, stderr/logs and log-directory permissions; every launched server must initialize. |
| Tools disappear after timeout/cancellation | The started request retired its connection. Restart; calls are not retried. Other services stay connected. |
| Settings unavailable | Check TUI mode, opt-in and connection. After uncertain saves, reread state; never replay blindly. Restart retired connections first. |
| Managed service stopped | Manually prepare/activate its first release, then confirm restart. Auto-update does not install it first. |

> **Restart/reload stops this gateway's children and cancels active/queued jobs.**
> Finish work first. It neither saves settings nor detaches jobs; other sessions
> keep running.

### Logs

Diagnostics go to stderr and `gateway.log` beside the config; stdout is MCP-only. The parent
directory must exist and be writable. Child diagnostics may be sensitive; tool arguments/results are
not logged.

```bash
tail -F /absolute/path/to/config-directory/gateway.log
```

See [logging](docs/reference.md#logs) and [lifecycle](docs/reference.md#lifecycle).

### Migration note

`/gateway-manager`, `/gateway-ui`, `/mcp-settings` and `/gateway-panel` became `/gateway` submenus.
`gateway_tools` and `gateway_call` are unchanged.

<a id="identity"></a>

## Documentation

- [Integrations](docs/integrations.md): browser, delegate, Pinote.
- [Reference](docs/reference.md): configuration, builds, counters, protocol and lifecycle.
- [Packages](docs/packages.md): install/update/rollback and recovery.
- [Settings](docs/settings.md): operator workflow and service contract.
- [Native UI](docs/native-ui.md): terminal clicks and service protocol.

## Development validation

```bash
npm run check
npm test
npm run build
```

Tests exercise real gateway processes and the Pi adapter.
