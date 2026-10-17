# Integration recipes

[Back to README](../README.md) · [Gateway reference](reference.md)

These recipes use the [Pi adapter setup](../README.md#connect-pi). Merge service
entries into your existing `mcpServers` map; do not replace other services.
Children receive only configured environment variables plus SDK defaults—see
[environment configuration](reference.md#configuration).

## Browser service

[pi-browser 0.6.0+](https://github.com/kvidzibo/pi-browser/blob/main/docs/mcp.md)
provides isolated Chromium as a stdio MCP service.

### Connect

- **Managed installation:** use
  [`gateway.browser.example.json`](../gateway.browser.example.json) after that
  browser version is available on its `main` branch. See the
  [package workflow](packages.md#workflow) for preparation, activation, and restart.
- **Existing checkout:** run `npm ci && npm run build:mcp` in a tested browser
  checkout, then configure `node /absolute/path/to/pi-browser/mcp/cli.mjs`.

First installation remains manual. Later startup updates require the explicit
[auto-update opt-in](packages.md#automatic-startup-updates); manual preparation,
activation, and gateway restart otherwise remain separate confirmed actions.

### Use

Discover `browser__browser` with `gateway_tools` and call it with `gateway_call`.
Open **`/gateway` → Services → browser** for profiles, manual login, cookie-site
selection, display modes, and logout. Cookie approval uses the gateway's
[form-elicitation route](reference.md#approvals). Approvals and native UI actions
are not model tool results; missing UI never grants cookie access.

- Allow enough `timeoutMs` for consent plus startup; the example uses **180 seconds**.
- Forward display, keyring, and agent-directory environment variables only when
  needed; follow the browser service guide linked above.
- Use each saved profile in **only one process**.
- Remove the old native browser extension only after approving that migration,
  then reload. Loading both creates independent sessions that can contend for
  profiles; do not remove the old setup beforehand.

No browser-specific gateway code or private service socket is required.

## Live delegate panel

[pi-delegate 0.20.0+](https://github.com/kvidzibo/pi-delegate#readme) provides a live
job resource. Add its service to your configuration:

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

To enable role settings, add the
[settings opt-in](../README.md#child-server-settings) to this same service entry.
Do not put a token value in configuration; the gateway generates it.

### Read the panel

Queued/running jobs appear automatically **above the editor**, even while the
parent is idle. Cards show role, model/reasoning, task preview, elapsed/queue time,
job ID, and current/recent tool activity. Small terminals show overflow counts.

- Completed jobs remain for **eight seconds**. Finished means **unverified**, not
  successful.
- Disconnects show a stale warning and freeze the last-known clock; they do not
  imply completion.
- For full JSON, open **`/gateway` → Services → service → Ctrl+O → Resources** when
  the service has an app; otherwise choose Resources from its feature menu.
- Settings and approval dialogs remain usable while the widget is visible.

The adapter uses one gateway connection for tools and UI. It does not load the
original delegate extension, start an observer server, poll jobs, send chat
messages, or trigger model turns. Clock ticks are local; MCP reads happen on
discovery and change notifications, with bursts combined.

No widget or subscriptions start outside TUI mode. Models still see explicit tool
results; resources are not a secrecy boundary. **Reload closes the connection and
its workers; it does not detach jobs.** See the
[resource format and limits](reference.md#resources) for client integration.

## Pinote

Services can provide native terminal apps through the
[native UI v1 protocol](native-ui.md). The adapter is generic: Pinote screens and
behavior live in Pinote's MCP server, not the gateway. Pinote MCP
suggestions/actions require gateway **0.12.0+**.

### Connect

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

Pass `PI_CODING_AGENT_DIR` and XDG overrides explicitly in service `env` if used.
Do not also load the old Pinote-specific extension unless you deliberately want
separate selections and duplicate UI. Keep the existing setup until its
replacement is tested; installation does not migrate it automatically.

### Open the app

Use **`/pi-services` → pinote** or **`/gateway` → Services → pinote**. Services with
an app open it directly; **Open app** is also in the service feature menu. Clicks
and keyboard actions go directly to the service without a model turn.

UI state follows the Pi conversation/branch, not the gateway UUID. Services can
retain state across `/new`, return state from model tools, and expose clickable
footer actions. Preview actions add display-only transcript entries; completing
a task never resets the conversation. Terminal clicks require the
[protocol handler](native-ui.md); the app menu is the keyboard fallback.
