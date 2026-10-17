# Integration recipes

[Back to README](../README.md) · [Gateway reference](reference.md)

Use the [Pi adapter](../README.md#connect-pi). Merge entries into your existing
`mcpServers` map; do not replace other services. Children receive SDK defaults and
configured `env`, not the full parent environment
([details](reference.md#configuration)).

## Browser service

[pi-browser 0.6.0+](https://github.com/kvidzibo/pi-browser/blob/main/docs/mcp.md)
provides isolated Chromium over stdio.

### Connect

| Installation | Setup |
|---|---|
| Managed | Use [`gateway.browser.example.json`](../gateway.browser.example.json) once the required browser version is on `main`. Follow the [package workflow](packages.md#workflow) to prepare, activate and restart. |
| Existing checkout | Run `npm ci && npm run build:mcp`, then configure `node /absolute/path/to/pi-browser/mcp/cli.mjs`. |

First installation is manual. Later startup updates require [auto-update
opt-in](packages.md#automatic-startup-updates); otherwise preparation, activation and
restart remain separate confirmed actions.

### Use

- **Tools:** discover `browser__browser` with `gateway_tools`; call it through
  `gateway_call`.
- **App:** `/gateway` → Services → browser opens profiles, manual login, cookie-site
  selection, display modes and logout.
- **Cookie approval:** uses [form elicitation](reference.md#approvals), not model tool
  results. Native UI actions are also outside model results; missing UI never grants
  access.

**Before connecting:**

- Allow consent and startup time in `timeoutMs`; the example uses **180 seconds**.
- Forward display, keyring and agent-directory variables only as needed; follow the
  browser guide linked above.
- Use each saved profile in **one process only**.
- Keep the old native extension until migration is approved, then remove it and reload.
  Do not run both: independent sessions can contend for profiles.

No browser-specific gateway code or private service socket is needed.

## Live delegate panel

[pi-delegate 0.20.0+](https://github.com/kvidzibo/pi-delegate#readme) provides the live
job resource. Add its service:

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

For role settings, add the [settings opt-in](../README.md#child-server-settings) to this
same entry. The gateway generates the token; never configure its value.

### Read the panel

Cards appear **above the editor**, including while the parent is idle. They show role,
model/reasoning, task preview, elapsed/queue time, job ID and recent tool activity.
Small terminals show overflow counts; settings and approvals remain usable.

| State | Display |
|---|---|
| Queued/running | Live card |
| Completed | Retained for **eight seconds**; finished means **unverified**, not successful |
| Disconnected | Stale warning and frozen clock, not inferred completion |

For full JSON, open the service's **Ctrl+O → Resources** menu; without an app, choose
**Resources** from its feature menu.

The adapter shares one gateway connection for tools and UI. It reads on discovery and
coalesced change notifications; clock ticks are local. It does not poll, load the
original delegate extension, start an observer server or create model turns.
Widgets/subscriptions require TUI mode. Explicit tool results still reach the model;
resources are not a secrecy boundary.

> **Reload closes the connection and its workers; it does not detach jobs.**

See [resource format and limits](reference.md#resources) for client integration.

## Pinote

Pinote owns its screens and behavior; the gateway renders them through [native UI
v1](native-ui.md). Suggestions/actions require gateway **0.12.0+**.

### Connect

1. In a Pinote checkout, install the `pi/` dependencies and Python CLI.
2. Build the MCP server with **Node.js 22.19+**:

   ```bash
   npm --prefix /absolute/path/to/pinote/pi run build:mcp
   ```

3. Register the service:

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

Pass `PI_CODING_AGENT_DIR` and XDG overrides explicitly in `env` if used. Keep the old
setup until the replacement is tested; installation does not migrate it. Loading the old
Pinote extension too creates separate selections and duplicate UI.

### Open the app

Open **`/pi-services` → pinote** or **`/gateway` → Services → pinote**. **Open app** is
also available in the feature menu. Keyboard and click actions go directly to the
service without a model turn.

- State follows the Pi conversation/branch, not the gateway UUID; services can retain it
  across `/new` and return it from model tools.
- Footer actions require the [terminal click handler](native-ui.md#terminal-clicks); the
  app menu is the keyboard fallback.
- Previews are display-only transcript entries; completing a task never resets the
  conversation.
