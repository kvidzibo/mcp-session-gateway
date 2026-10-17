# Integration recipes

[Back to README](../README.md) · [Gateway reference](reference.md)

Use the [Pi adapter](../README.md#connect-pi). Merge entries into your existing `mcpServers` map.
Children receive SDK defaults and configured `env`, not the full parent environment. Private menus
do not create model turns; explicit tool results still reach the model. UI routing is not a secrecy
boundary.

## Browser service

[pi-browser 0.6.0+](https://github.com/kvidzibo/pi-browser/blob/main/docs/mcp.md) provides isolated
Chromium over stdio.

### Connect

- **Managed:** use [`gateway.browser.example.json`](../gateway.browser.example.json) once the
  required version is on `main`; follow the [package workflow](packages.md#workflow).
- **Checkout:** run `npm ci && npm run build:mcp`, then configure `node
  /absolute/path/to/pi-browser/mcp/cli.mjs`.

First installation is manual; later startup updates require
[opt-in](packages.md#automatic-startup-updates). Otherwise preparation, activation and restart
remain separate confirmed actions.

### Use

Discover `browser__browser` with `gateway_tools`; call it through `gateway_call`. **`/gateway` →
Services → browser** opens profiles, manual login, cookie-site selection, display modes and logout.
Cookie access uses [form approval](reference.md#approvals); missing UI never grants access.

- Allow consent/startup time in `timeoutMs`; the example uses **180 seconds**.
- Forward display, keyring and agent-directory variables only as needed; see the browser guide.
- Use each saved profile in **one process only**. Keep the old extension until migration is
  approved, then remove it and reload; running both can contend for profiles.

No browser-specific gateway code or private service socket is needed.

## Live delegate panel

[pi-delegate 0.20.0+](https://github.com/kvidzibo/pi-delegate#readme) supplies the live job
resource:

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

Add [settings opt-in](../README.md#child-server-settings) to this same entry for role settings. The
gateway generates the token; never configure its value.

### Read the panel

TUI cards appear **above the editor**, even while idle: role, model/reasoning, task, elapsed/queue
time, job ID and tool activity. Small terminals show overflow counts. Completed cards remain **eight
seconds** and mean **unverified**, not successful; disconnects show stale state and freeze clocks.
Settings/approvals remain usable.

For full JSON, open the service's **Ctrl+O → Resources**, or its feature menu if no app. One gateway
connection handles tools/UI; reads follow discovery and coalesced change notifications, clocks tick
locally. No polling, observer server, original extension, chat messages or model turns;
widgets/subscriptions require TUI mode.

**Reload closes workers, not detaches jobs.** See [resource limits](reference.md#resources).

## Pinote

Pinote owns its screens through [native UI v1](native-ui.md); suggestions/actions require gateway
**0.12.0+**.

### Connect

Install the checkout's `pi/` dependencies and Python CLI, then build with **Node.js 22.19+**:

```bash
npm --prefix /absolute/path/to/pinote/pi run build:mcp
```

Register:

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

Forward `PI_CODING_AGENT_DIR`/XDG overrides in `env` if used. Keep the existing setup until tested;
installation does not migrate it. Loading the old extension too creates separate selections and
duplicate UI.

### Open the app

Open **`/pi-services` → pinote** or **`/gateway` → Services → pinote**; **Open app** also exists in
its feature menu. State follows the conversation/branch, not gateway UUID; services can retain it
across `/new` or return it from model tools. Previews are display-only; task completion never resets
the conversation. Footer actions need the [click handler](native-ui.md#terminal-clicks); the app
menu is the fallback.
