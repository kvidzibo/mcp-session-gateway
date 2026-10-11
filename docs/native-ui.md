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
status area. Footer actions use the same controls and confirmations as the app menu;
no Pinote-specific code is required. Clicks never start a model turn.

For terminal clicks, append [`pi/kitty/open-actions.conf`](../pi/kitty/open-actions.conf)
to Kitty's existing open-actions file, replacing its absolute helper path. Reload
Kitty with Ctrl+Shift+F5. Regular mode uses normal link clicks; fullscreen uses
Ctrl+Shift+click so Kitty, not Pi's URL opener, handles the link. Other terminals
can install an equivalent protocol handler or use **Open app** as a keyboard fallback.
The helper signals a private local socket; it never runs a service command itself.
Installation does not change terminal configuration.

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
  "retainOnNew": true,
  "body": "Optional explanatory text",
  "controls": [
    { "id": "label", "kind": "text", "label": "Label", "value": "Example", "confirm": "Save label?" },
    { "id": "enabled", "kind": "toggle", "label": "Enabled", "value": true },
    { "id": "preview", "kind": "action", "label": "Preview" }
  ],
  "footer": [{ "text": "Example", "width": 40, "action": "preview" }]
}
```

Control kinds: `action`, `text`, `number`, `toggle`, `select`. Text can specify
`multiline: true` as a hint (this host still uses escaped JSON input); selects supply `options: [{label, value}]`. Optional `icon` and
`description` provide presentation hints. Values are string, number, boolean, or
null. IDs must be unique. The exact schemas and limits live in
[`src/native-ui.ts`](../src/native-ui.ts): 256 controls, 20,000-character strings,
8 KiB opaque state, and 256,000-character resource documents. Unknown document
properties, unknown versions, duplicate IDs, and unsupported controls fail closed.

A footer item may specify `action` referencing an existing `kind: "action"`
control, or `url` for a safe HTTP(S) link, never both. Labels/icons remain service
owned. The host mints single-use links tied to the displayed revision and current
session; no service can inject a socket path or executable link. Refresh, tree
navigation, disconnect and shutdown invalidate old links. Multiple services can
render actions independently. A busy gateway menu/confirmation rejects a click;
finish that dialog and refresh the app before retrying. Accepted operations drain
if the helper disconnects; there is no automatic replay.

The host sends `native-ui/action` with `{uri, revision, action, value?, _meta}`.
The gateway unwraps the resource URI, routes only to that service, and validates
`{view, draft?, preview?}` responses. These requests are **not model tools**.
A service must verify the revision and allowed action before writing, validate
values itself, and use atomic persistence/concurrency checks. Host validation and
confirmation hints are not authorization against other clients or local OS tools.
There are no retries of actions; after an error, inspect refreshed state because
the write may have committed.

`preview` appends a display-only text entry to the transcript, including while an
agent is running. It is excluded from model context and never starts a turn. `draft` requests a separately
confirmed editor insertion; existing drafts are never overwritten or submitted.
Arbitrary shell commands, executable UI, session reset, and reload effects are
unsupported. Do not put secrets in drafts; submitted drafts become model context.

## Conversation state and updates

Reads, actions, and model tool calls receive:

```json
{"_meta":{"native-ui/context":{"conversationId":"current-pi-session-id","contextId":"retained-service-context-id","state":{"selectedId":12}}}}
```

The generic host persists the returned opaque `state` in display-only Pi custom
entries, scoped by config path and service. Resume, reload, and tree navigation
restore active-branch state. By default new conversations start empty. Services
opting into `retainOnNew: true` carry their opaque state and `contextId` into an
accepted `/new`; the actual `conversationId` changes. The transfer is keyed to the
exact destination session file and consumed only after persistence there. If the
first gateway launch fails, a later reload/restart of that same destination can
finish the transfer. Cancelled
switches and unrelated fresh launches do not inherit it; nothing is shared by cwd.
Forks inherit only their copied branch entries, not a `/new` transfer. Services
must independently invalidate consumed consent (for example with durable receipts)
so an old branch cannot replay a completed action. Pi normally saves a
new session after the first submitted message; unsaved/no-session conversations
cannot promise durable state. No previous Pinote-extension selection is imported.
State, context and conversation IDs are correlation labels, not authentication.
The gateway run UUID remains ephemeral and is never the durable selection key.
No session-reset effect exists: completing a service action leaves the Pi
conversation and editor intact.

The service should be stateless with respect to selection: always use the supplied
host state. Return canonical state and compute the revision over that same state.
Do not key selection by cwd or gateway-run UUID. A reconnect gets a new gateway
UUID but receives the restored conversation context.

A successful model tool can return `_meta["native-ui/state"]` containing the
new opaque state (same 8 KiB limit). The host validates and persists it **before**
refreshing that service. Failed tools cannot update state. Calls and actions for
a service serialize around this update; late results cannot cross session/tree
boundaries. Metadata is not added to model-facing content. Only services with an
advertised native app may return UI state.

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

## Read-only extension queries

Other trusted Pi extensions may emit `gateway:query-service-tool` with
`{service, tool, arguments?, respond}`. `respond` is called synchronously with
`{handled:false}` when the gateway does not own the configured service, otherwise
`{handled:true, result: Promise<CallToolResult>}` (or `error` for an invalid request).
The promise uses the normal MCP request timeout and current native context; only
model-visible tools explicitly advertising `readOnlyHint:true` are allowed.
It rejects when an owned service is unavailable. While a selected gateway's
configuration is still loading (or failed to load), queries return a handled
error rather than claiming a service is absent. Consumers must not substitute
an unrelated selection on that failure or on a null result. No transcript/model
turn is created. This event is a trusted extension API, not a security boundary.

Screens and previews are UI-only and never appended as model messages. Ordinary
MCP tool results still reach the model. This is routing, not a secrecy boundary:
trusted services and agents retain the OS access granted to their processes.
