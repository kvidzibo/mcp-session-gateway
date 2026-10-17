# Native terminal UI v1

Private MCP extension, not HTML MCP Apps: services supply validated JSON; Pi renders without
importing service code. Screens/previews stay outside model context; ordinary tool results do not.

Open **`/pi-services` → service** or **`/gateway` → Services → service** for service controls,
including enable/disable and **Open app** when available. Apps use Pi's standard bordered inline
menus and configured selection keys, with the focused control's help below the list. Long body text
has a compact summary. Ctrl+R refreshes apps; Tab opens settings and returns; Ctrl+O in an app opens
features/Resources; Escape returns from an app or service controls to Services.

Text/number inputs use JSON: quote strings; escape newlines. Tabs/boundary whitespace persist.
Confirmations show JSON-escaped values: display every line before Enter; resizing resets review;
Escape cancels. After dispatch, failures may have committed; inspect refreshed state.

## Terminal clicks

` MCP N services` opens Services/recovery; count is last-start configuration, not health. Links
survive disconnect, not shutdown. Footer text/HTTP(S) links use Pi's status area; actions use app
controls/confirmations without model turns.

**Fullscreen (0.30.0+):** service footers use native mouse regions below the editor.
Click normally; double-click invokes the declared double action. Action titles are not
terminal hyperlinks, so they add no hyperlink underline or hand pointer and do not take
keyboard focus. Hover hints name actions when space permits. A fast double-click waits
for its single-click preview; one accepting gesture cannot complete the newly selected
task. The app launcher opens the service menu; Escape returns to the editor. Safe external
URLs remain terminal links. No Kitty handler or saved terminal setting is needed for these
native actions. Try a separate Pi process with `--tui-mode fullscreen`; regular mode is unchanged.

**Regular mode and older adapters:** use the Kitty bridge below. Its hyperlinks retain
Kitty's underline/pointer styling. The generic MCP/service counters also remain hyperlinks.

- Primary: append [`pi/kitty/open-actions.conf`](../pi/kitty/open-actions.conf) to Kitty's existing
  open-actions file; replace the absolute helper path. Reload **Ctrl+Shift+F5**. Click normally;
  fullscreen requires **Ctrl+Shift+click**, bypassing Pi's URL opener.
- Secondary: include [`pi/kitty/mouse.conf`](../pi/kitty/mouse.conf) in `kitty.conf`, replace the
  absolute kitten path, reload. Right-click works in both modes; ordinary links/controls without
  alternates do nothing—no primary fallback. This reserves right-button press even outside links;
  omit conflicting mappings. App-menu actions remain available.

- Double-click (0.28.0+): update the same mouse include and kitten. Regular mode uses
  double-click; fullscreen uses **Ctrl+Shift+double-click**. The second press invokes
  only the declared double action; single-click remains the primary action. Kitty's
  click interval distinguishes gestures, with no host timing heuristic. Non-gateway
  double-clicks retain word selection. Ctrl+Shift single-click now waits for Kitty's
  click interval instead of firing immediately on release. Existing includes must
  be updated/reloaded; old mappings cannot invoke double actions. Menus/icons remain
  available without the mapping.

Other terminals need equivalent protocol handlers; `/pi-services` is the keyboard fallback. The
helper signals a private socket, never service commands; installation leaves terminal config
unchanged.

## Service contract

Advertise `capabilities.experimental["native-ui-v1"] = {}`; list exactly one root resource, MIME
`application/vnd.mcp-native-ui+json`. `resources/read` returns textual JSON:

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

Controls: unique `id`; `kind`: `action|text|number|toggle|select`; `value`:
string/number/boolean/null; select `options: [{label, value}]`; optional `icon`/`description`;
`multiline: true` hints text, though this host uses escaped JSON. Labels/icons remain service-owned.
[Schema](../src/native-ui.ts): **256 controls, 20,000-character strings, 8 KiB state,
256,000-character documents**. Unknown properties/versions, duplicate IDs, unsupported controls fail
closed.

Footer `action` references an action control; `url` is safe HTTP(S), mutually exclusive with
`action`. `secondaryAction` requires primary `action` and negotiation; it references another action
control, using its own confirmation/revision. Both share one single-use capability: either
invalidates both. Host links bind revision/session; services cannot inject socket paths/executable
links. Refresh/navigation/disconnect/shutdown invalidate action links. Services render actions
independently. Negotiated `doubleAction` references its own action control (and its
confirmation/revision); it may stand alone or accompany a primary action, but not
`url`. All actions on a link share single-use consent; accepting a suggestion cannot
reuse that capability to complete its newly selected task. Unsupported gestures do
not fall back to primary and do not consume the link.

Negotiated `style: {italic?: boolean, color?: "accent"|"muted"|"text"}` styles a footer
segment using the host theme, after sanitization/truncation. Services cannot supply
raw ANSI or arbitrary colors. Omit styles and double actions from all views, including
action results, until the corresponding feature is negotiated.

Negotiated `openApp: true` makes a footer segment open its service app. It cannot also
contain a URL or server action and sends no mutation by itself. Omit it until
`footerNativeActions` is negotiated. Native actions still validate displayed revisions,
serialize with service operations, and reject stale views; disconnected/shutdown footers
cannot act. Triple clicks and a replayed second click do not turn acceptance into completion.

Busy menus/confirmations reject clicks: finish and refresh. Accepted operations drain
despite helper disconnect; no automatic replay.

`native-ui/action` receives `{uri, revision, action, value?, _meta}`; gateway unwraps/routes URI
only to its service, validating `{view, draft?, preview?}`. These are not model tools. Services must
validate revisions, actions, values and atomically check/persist concurrency dependencies. Host
validation/confirmation does not authorize other clients/OS tools. Never retry actions; inspect
refreshed state after uncertain completion.

| Negotiation | Contract |
|---|---|
| Scoped revisions | Gateway advertises `capabilities.experimental["native-ui-v1"].actionRevisions = true`; only then supporting hosts send `_meta["native-ui/features"] = {"actionRevisions": true}` on reads/actions/tools. |
| Footer styles | Gateway advertises `capabilities.experimental["native-ui-v1"].footerStyles = true`; host independently sends `_meta["native-ui/features"].footerStyles = true`. |
| Double footer | Gateway advertises `capabilities.experimental["native-ui-v1"].footerDoubleActions = true`; host independently sends `_meta["native-ui/features"].footerDoubleActions = true`. This does not imply installed mouse mappings. |
| Native footer | Gateway advertises `capabilities.experimental["native-ui-v1"].footerNativeActions = true`; only fullscreen hosts send `_meta["native-ui/features"].footerNativeActions = true`. Enables `openApp: true`; regular hosts never negotiate it. |
| Alternate footer | Gateway advertises `capabilities.experimental["native-ui-v1"].footerSecondaryActions = true`; hosts independently negotiate `_meta["native-ui/features"].footerSecondaryActions = true`. This does not imply installed mouse mappings. |

Negotiated controls may supply **1–256-character** `revision`: host sends it instead of view
revision; edits survive unrelated changes only while ID/kind/revision match. Otherwise full-view
guard applies. Bind scoped revisions to target, displayed values/options, confirmation and
persistence dependencies; validate atomically. Read-only actions may use fresh data. Legacy gateways
retain legacy behavior: omit control revisions and unnegotiated `secondaryAction`, including
action-result views, for strict schemas. Keep alternates in app menus for keyboard/older hosts.

A stale rejection **before any persistent effect** may throw MCP `-33003` with data:

```json
{"native-ui/action":{"status":"not-applied","reason":"stale-view"}}
```

Host refreshes/reports **Action not applied**, without possible-commit warning; local pre-dispatch
failures are also definite. Never mark after writes/receipt consumption. Ordinary errors/timeouts/
disconnects retain possible-commit warnings; error text proves nothing.

`preview` appends display-only transcript text, even during agent runs. `draft` requests separately
confirmed editor insertion: never overwrite/submit existing drafts. **Exclude secrets:** submitted
drafts enter model context. Shell commands, executable UI, session reset/reload effects are
unsupported.

## Conversation state and updates

Reads/actions/model tools receive:

```json
{"_meta":{"native-ui/context":{"conversationId":"current-pi-session-id","contextId":"retained-service-context-id","state":{"selectedId":12}}}}
```

Host persists opaque state in display-only Pi entries, scoped by config path/service:
- Resume/reload/tree navigation restore active-branch state; reconnect changes gateway UUID, not
  context.
- New conversations default empty. Accepted `/new` with `retainOnNew: true` carries state/contextId;
  conversationId changes. Forks inherit copied branch entries only.
- Transfers target the exact destination session file, consumed only after persistence there. Failed
  initial launch can finish on that destination's reload/restart. Cancelled switches, unrelated
  launches and shared cwd inherit nothing.
- Pi normally saves after first submission; unsaved/no-session state lacks durability guarantees.
  Old Pinote-extension selection is not imported.

Services independently invalidate consumed consent, e.g. durable receipts, against old-branch
replay. IDs/state are correlation, not authentication; never key durable selection by gateway
UUID/cwd. Use supplied state, return canonical state and compute its revision over that state.
Completion leaves conversation/editor intact.

Successful native-app services' tools may return `_meta["native-ui/state"]` (**8 KiB**). Host
validates/persists before refreshing; failed tools cannot update. Per-service calls/actions
serialize around updates; lifetime guards discard responses crossing
session/tree/navigation/shutdown boundaries. Metadata stays outside model content.

Emit `notifications/native-ui/changed` with `{uri}` after mutations; gateway wraps URI, host
rereads. Notifications cannot act; during refresh they queue another read. Host also refreshes after
model tools. Observe shared storage or require external writers to notify/manual refresh; no host
watcher/polling. Invalid/missing views clear footer/show error; gateway disconnect clears native
views; child disconnect emits `notifications/native-ui/invalidated` with `{service}`, clearing its
view/controls/footer. Invalidated views cannot dispatch pending edits.

## Read-only extension queries

Trusted extensions emit `gateway:query-service-tool` with `{service, tool, arguments?, respond}`;
`respond` runs synchronously:

| Condition | Response |
|---|---|
| Service not owned | `{handled:false}` |
| Owned | `{handled:true, result: Promise<CallToolResult>}` |
| Invalid request | Handled `error` |
| Selected configuration loading/failed | Handled error, not absence |

Promise uses normal timeout/current context. Only model-visible `readOnlyHint:true` tools qualify;
unavailable owned services reject. Never substitute unrelated selection after failure/null. Queries
create no transcript/turn. Trusted routing is neither secrecy nor sandboxing; services/agents retain
OS access.
