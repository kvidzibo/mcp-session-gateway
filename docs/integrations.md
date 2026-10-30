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
