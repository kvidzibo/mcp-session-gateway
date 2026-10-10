# Native terminal UI v1

This is a **private extension over MCP**, not HTML MCP Apps. A service supplies
validated JSON screens; the Pi adapter renders them without importing service
code or running a model turn. The gateway remains service-agnostic.

Use **`/gateway` → Services → service → Open app**. Use arrows/Enter to
navigate, Ctrl+R to refresh, and Escape to return to the service menu. Controls have labels and optional
icons/descriptions. Forms save only when their action succeeds; confirmation
prompts show the proposed value in a scrollable review. Every line must be displayed
before Enter confirms; resizing resets review and Escape cancels. Proposed values
are JSON-escaped so whitespace/control characters cannot hide changes.
Text/number inputs use JSON values (quote strings;
use `\n` for line breaks), preserving tabs and boundary whitespace exactly. Footer text and HTTP(S) links use Pi's ordinary
status area. Footer actions are accessed through the app menu, not clickable icons.

## Service contract

Advertise `capabilities.experimental["native-ui-v1"] = {}`. List exactly one root
resource per service with MIME type `application/vnd.mcp-native-ui+json`.
`resources/read` returns a textual JSON document:

```json
{
  "version": 1,
  "title": "Example · Settings",
  "revision": "opaque-current-revision",
  "state": { "selectedId": 12 },
  "body": "Optional explanatory text",
  "controls": [
    { "id": "label", "kind": "text", "label": "Label", "value": "Example", "confirm": "Save label?" },
    { "id": "enabled", "kind": "toggle", "label": "Enabled", "value": true }
  ],
  "footer": [{ "text": "Example", "width": 40 }]
}
```

Control kinds: `action`, `text`, `number`, `toggle`, `select`. Text can specify
`multiline: true` as a hint (this host still uses escaped JSON input); selects supply `options: [{label, value}]`. Optional `icon` and
`description` provide presentation hints. Values are string, number, boolean, or
null. IDs must be unique. The exact schemas and limits live in
[`src/native-ui.ts`](../src/native-ui.ts): 256 controls, 20,000-character strings,
8 KiB opaque state, and 256,000-character resource documents. Unknown document
properties, unknown versions, duplicate IDs, and unsupported controls fail closed.

The host sends `native-ui/action` with `{uri, revision, action, value?, _meta}`.
The gateway unwraps the resource URI, routes only to that service, and validates
`{view, draft?, preview?}` responses. These requests are **not model tools**.
A service must verify the revision and allowed action before writing, validate
values itself, and use atomic persistence/concurrency checks. Host validation and
confirmation hints are not authorization against other clients or local OS tools.
There are no retries of actions; after an error, inspect refreshed state because
the write may have committed.

`preview` opens a private scrollable text view. `draft` requests a separately
confirmed editor insertion; existing drafts are never overwritten or submitted.
Arbitrary shell commands, executable UI, session reset, and reload effects are
unsupported. Do not put secrets in drafts; submitted drafts become model context.

## Conversation state and updates

Reads, actions, and model tool calls receive:

```json
{"_meta":{"native-ui/context":{"conversationId":"durable-host-session-id","state":{"selectedId":12}}}}
```

The generic host persists the returned opaque `state` in display-only Pi custom
entries, scoped by config path and service. Resume, reload, and tree navigation
restore active-branch state. New conversations start empty. Pi normally saves a
new session after the first submitted message; unsaved/no-session conversations
cannot promise durable state. No previous Pinote-extension selection is imported.
State and conversation IDs are correlation/context, not authentication.

The service should be stateless with respect to selection: always use the supplied
host state. Return canonical state and compute the revision over that same state.
Do not key selection by cwd or gateway-run UUID. A reconnect gets a new gateway
UUID but receives the restored conversation context.

Emit `notifications/native-ui/changed` with `{uri}` after mutations. The gateway
wraps that URI for the host, which rereads the view. Notifications cannot perform
actions. External writers need to emit an update or the user must refresh; no file
watcher or background polling is installed. The host also refreshes after model
tool calls. Missing/invalid views clear the service's footer and show an error;
gateway disconnect clears native views. Child disconnect emits a gateway-owned
`notifications/native-ui/invalidated` with `{service}` and clears that service's
view/controls/footer. In-flight refresh notifications queue a follow-up read;
invalidated views cannot dispatch a pending edit. Lifetime guards discard late responses
after navigation or shutdown.

Screens and previews are UI-only and never appended as model messages. Ordinary
MCP tool results still reach the model. This is routing, not a secrecy boundary:
trusted services and agents retain the OS access granted to their processes.
