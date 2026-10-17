# Native terminal UI v1

This is a **private extension over MCP**, not HTML MCP Apps. A service supplies
validated JSON screens; the Pi adapter renders them without importing service
code or running a model turn. The gateway remains service-agnostic.

Use **`/pi-services` → service** (or **`/gateway` → Services → service**)
to open an available app directly. Use arrows/Enter to navigate, Ctrl+R to refresh,
Tab to open service settings, Ctrl+O for the service feature menu (including
Resources), and Escape to return to Services. Closing settings returns to the app.
Services without an app open their feature menu instead. Controls have labels and optional
icons/descriptions. Forms save only when their action succeeds; confirmation
prompts show the proposed value in a scrollable review. Every line must be displayed
before Enter confirms; resizing resets review and Escape cancels. Proposed values
are JSON-escaped so whitespace/control characters cannot hide changes.
Text/number inputs use JSON values (quote strings;
use `\n` for line breaks), preserving tabs and boundary whitespace exactly. Footer text and HTTP(S) links use Pi's ordinary
status area. Footer actions use the same controls and confirmations as the app menu;
no Pinote-specific code is required. Clicks never start a model turn.

<a id="terminal-clicks"></a>

The gateway's own ` MCP N services` footer segment uses this same click transport
to open Services directly, or recovery when disconnected. Its count describes the
configuration loaded at the last start/restart, not service health. This segment
remains available after a gateway disconnect; session shutdown clears its links.

For terminal clicks, append [`pi/kitty/open-actions.conf`](../pi/kitty/open-actions.conf)
to Kitty's existing open-actions file, replacing its absolute helper path. Reload
Kitty with Ctrl+Shift+F5. Regular mode uses normal link clicks; fullscreen uses
Ctrl+Shift+click so Kitty, not Pi's URL opener, handles the link. Other terminals
can install an equivalent protocol handler or select the service in **`/pi-services`** as a keyboard fallback.
The helper signals a private local socket; it never runs a service command itself.
Installation does not change terminal configuration.

For alternate footer actions, also include [`pi/kitty/mouse.conf`](../pi/kitty/mouse.conf)
in `kitty.conf`, replacing its absolute kitten path, then reload Kitty. Right-click
invokes the alternate action in regular and fullscreen mode. It does nothing on
ordinary links or controls without an alternate; it never falls back to the primary
action. The mapping reserves right-button press for this helper (including outside
links); omit it if that conflicts with your terminal/application bindings. App-menu
actions remain available without the mapping.

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
control, or `url` for a safe HTTP(S) link, never both. An optional `secondaryAction`
references another action control and requires a primary `action`; right-click uses
that control's own confirmation and revision. Both choices share one single-use
capability, so selecting either invalidates both. Labels/icons remain service
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
There are no retries of actions; after an unknown error, inspect refreshed state
because the write may have committed.

Gateways accepting scoped validation advertise
`capabilities.experimental["native-ui-v1"].actionRevisions = true`. Only when this
capability is present do supporting hosts send
`_meta["native-ui/features"] = {"actionRevisions": true}` on reads, actions, and
tools. An older gateway therefore retains legacy behavior. Only for such requests,
a service may add `revision` (1–256 characters) to each control. The host sends
that control revision instead of the view revision and permits an in-progress
edit across unrelated view changes when the control ID, kind, and revision still
match. Without a control revision, the full-view guard remains. Services must bind
scoped revisions to the action's target, displayed values/options, confirmation
semantics, and relevant persistence dependencies, then validate atomically before
writing. Read-only actions can use fresh data. Omit control revisions for legacy
hosts, including in action-result views, so their strict schemas remain valid.

Gateways supporting alternate footer actions advertise
`capabilities.experimental["native-ui-v1"].footerSecondaryActions = true`.
Supporting hosts independently negotiate
`_meta["native-ui/features"].footerSecondaryActions = true`. Services must omit
`secondaryAction` without this feature, including in action responses, because
older strict schemas reject unknown fields. Keep alternate actions in the app menu
as a keyboard/older-host fallback. This flag indicates protocol support, not that a
terminal mouse mapping is installed.

A service that rejects a stale action **before any persistent effect** may throw
MCP error `-33003` with data
`{"native-ui/action":{"status":"not-applied","reason":"stale-view"}}`.
The host refreshes and reports **Action not applied**, without the uncertain-commit
warning. Local pre-dispatch failures are also definite rejections. Do not attach
this marker to failures after any write or receipt consumption; ordinary errors,
timeouts, and disconnects retain the possible-commit warning. Error text alone
never establishes that an action was rejected.

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
actions. Services can observe their own shared storage to notify external changes;
otherwise external writers need to emit an update or the user must refresh. The
generic host installs no file watcher or background polling. The host also refreshes after model
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
