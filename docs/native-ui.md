# Native terminal UI v1

A **private MCP extension**, not HTML MCP Apps. Services supply validated JSON screens;
the Pi adapter renders them without importing service code or starting a model turn. The
gateway stays service-agnostic.

## Operator workflow

Open **`/pi-services` → service** or **`/gateway` → Services → service**. An available
app opens directly; otherwise the service feature menu opens.

| Key | Action |
|---|---|
| Arrows / Enter | Navigate / select |
| Ctrl+R | Refresh |
| Tab | Open service settings; closing them returns to the app |
| Ctrl+O | Open service features, including Resources |
| Escape | Return to Services |

Controls have labels and optional icons/descriptions. Text/number inputs use JSON
values: quote strings and use `\n` for line breaks. Tabs and boundary whitespace are
preserved exactly.

Confirmation shows the proposed value in a scrollable review, JSON-escaped so
whitespace/control characters cannot hide changes. Every line must display before Enter
confirms; resizing resets review and Escape cancels. Forms save only when their action
succeeds; see [action recovery](#definite-rejection-versus-uncertain-completion) for
failures after dispatch.

Footer text and HTTP(S) links use Pi's ordinary status area. Footer actions use the app
menu's controls and confirmations; no Pinote-specific code is needed. Clicks never start
a model turn.

### Terminal clicks

The gateway's ` MCP N services` footer segment opens Services, or recovery when
disconnected. Its count reflects the last start/restart configuration, **not service
health**. Links survive gateway disconnect but clear on session shutdown.

#### Install primary clicks

1. Append [`pi/kitty/open-actions.conf`](../pi/kitty/open-actions.conf) to Kitty's
   existing open-actions file; replace its absolute helper path.
2. Reload Kitty with **Ctrl+Shift+F5**.
3. Use normal link clicks in regular mode; in fullscreen, use **Ctrl+Shift+click** so
   Kitty, not Pi's URL opener, handles the link.

Other terminals can install an equivalent protocol handler. **`/pi-services` → service**
is the keyboard fallback. The helper signals a private local socket; it never runs
service commands. Installation does not change terminal configuration.

#### Install alternate clicks

Also include [`pi/kitty/mouse.conf`](../pi/kitty/mouse.conf) in `kitty.conf`, replace
its absolute kitten path, and reload Kitty.

- Right-click invokes the alternate action in regular and fullscreen modes.
- Ordinary links and controls without an alternate do nothing; there is **no
  primary-action fallback**.
- The mapping reserves right-button press even outside links. Omit it if it conflicts
  with terminal/application bindings.
- App-menu actions remain available without the mapping.

## Service contract

### Root resource and controls

Advertise `capabilities.experimental["native-ui-v1"] = {}`. List exactly one root
resource per service with MIME type `application/vnd.mcp-native-ui+json`.
`resources/read` returns textual JSON:

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

| Control property | Contract |
|---|---|
| `kind` | `action`, `text`, `number`, `toggle`, `select` |
| `value` | String, number, boolean or null |
| `id` | Unique |
| `multiline: true` | Text hint; this host still uses escaped JSON input |
| `options: [{label, value}]` | Select choices |
| `icon`, `description` | Optional presentation hints |

Exact schemas: [`src/native-ui.ts`](../src/native-ui.ts). Limits: **256 controls,
20,000-character strings, 8 KiB opaque state, 256,000-character resource documents**.
Unknown properties/versions, duplicate IDs and unsupported controls fail closed.

### Footer actions and link lifetime

| Footer field | Contract |
|---|---|
| `action` | References an existing `kind: "action"` control |
| `url` | Safe HTTP(S) link; never combined with `action` |
| `secondaryAction` | References another action control; requires primary `action` and [negotiation](#alternate-footer-negotiation) |

Right-click uses the secondary control's own confirmation and revision. Primary and
secondary share one single-use capability: either invalidates both. Labels/icons remain
service-owned.

Host-minted links bind to the displayed revision and current session; services cannot
inject socket paths or executable links. Refresh, tree navigation, disconnect and
shutdown invalidate links. Services render actions independently.

A busy gateway menu/confirmation rejects clicks: finish the dialog and refresh before
retrying. Accepted operations drain even if the helper disconnects; nothing replays
automatically.

### Action dispatch and persistence

The host sends `native-ui/action` with `{uri, revision, action, value?, _meta}`. The
gateway unwraps the URI, routes only to its service and validates `{view, draft?,
preview?}` responses. These are **not model tools**.

Before writing, services must verify revisions and allowed actions, validate values, and
use atomic persistence/concurrency checks. Host validation and confirmation hints do not
authorize access against other clients or local OS tools. Actions are never retried;
after uncertain completion, inspect refreshed state because writes may have committed.

#### Scoped revision negotiation

Gateways accepting scoped validation advertise:

```text
capabilities.experimental["native-ui-v1"].actionRevisions = true
```

Only then do supporting hosts send `_meta["native-ui/features"] = {"actionRevisions":
true}` on reads, actions and tools. Older gateways retain legacy behavior.

For negotiated requests only, services may add a **1–256-character** `revision` to each
control. The host sends it instead of the view revision and permits an in-progress edit
across unrelated view changes when control ID, kind and revision still match. Without
it, the full-view guard remains.

Services must bind scoped revisions to the action target, displayed values/options,
confirmation semantics and relevant persistence dependencies, then validate atomically
before writing. Read-only actions may use fresh data. Omit control revisions for legacy
hosts, including action-result views, to satisfy their strict schemas.

#### Alternate footer negotiation

Gateways advertise `capabilities.experimental["native-ui-v1"].footerSecondaryActions =
true`; supporting hosts independently negotiate
`_meta["native-ui/features"].footerSecondaryActions = true`.

Without this feature, services must omit `secondaryAction`, including action responses:
older strict schemas reject unknown fields. Keep alternates in the app menu for
keyboard/older-host access. The flag means protocol support, not an installed mouse
mapping.

#### Definite rejection versus uncertain completion

A service rejecting a stale action **before any persistent effect** may throw MCP error
`-33003` with data:

```json
{"native-ui/action":{"status":"not-applied","reason":"stale-view"}}
```

The host refreshes and reports **Action not applied**, without a possible-commit
warning. Local pre-dispatch failures are also definite rejections.

Never attach this marker after any write or receipt consumption. Ordinary errors,
timeouts and disconnects retain the possible-commit warning; error text alone does not
establish rejection.

### Preview and draft results

- `preview`: appends display-only transcript text, even while an agent runs. Excluded
  from model context; never starts a turn.
- `draft`: requests separately confirmed editor insertion. Existing drafts are never
  overwritten or submitted. **Do not include secrets:** submitted drafts become model
  context.

Arbitrary shell commands, executable UI, session reset and reload effects are
unsupported.

## Conversation state and updates

Reads, actions and model tool calls receive:

```json
{"_meta":{"native-ui/context":{"conversationId":"current-pi-session-id","contextId":"retained-service-context-id","state":{"selectedId":12}}}}
```

### State lifetime and `/new`

The host persists returned opaque `state` in display-only Pi custom entries, scoped by
config path and service.

| Event | State behavior |
|---|---|
| Resume, reload, tree navigation | Restore active-branch state |
| New conversation | Empty by default |
| Accepted `/new` with `retainOnNew: true` | Carries state and `contextId`; `conversationId` changes |
| Fork | Inherits copied branch entries only, not a `/new` transfer |
| Reconnect | New gateway UUID; restored conversation context |

A `/new` transfer targets the exact destination session file and is consumed only after
persistence there. If its first gateway launch fails, a later reload/restart of that
destination can finish the transfer. Cancelled switches and unrelated fresh launches
inherit nothing; cwd shares nothing.

Pi normally saves new sessions after the first submitted message; unsaved/no-session
conversations cannot promise durable state. No old Pinote-extension selection is
imported.

Services must independently invalidate consumed consent, for example with durable
receipts, to prevent completed-action replay from old branches. State,
context/conversation IDs and the ephemeral gateway UUID are correlation labels, not
authentication. Never use the gateway UUID as a durable selection key. Completing an
action leaves the conversation/editor intact; no session-reset effect exists.

### Canonical state and tool updates

Services should be selection-stateless: use supplied host state, return canonical state,
and compute its revision over that same state. Do not key selection by cwd or
gateway-run UUID.

Successful model tools may return `_meta["native-ui/state"]` with new opaque state,
limited to **8 KiB**. Only services advertising a native app may do so.

- The host validates and persists state **before** refreshing the service.
- Failed tools cannot update state.
- Calls and actions for a service serialize around the update; late results cannot cross
  session/tree boundaries.
- Metadata stays out of model-facing content.

### Change notifications and invalidation

Emit `notifications/native-ui/changed` with `{uri}` after mutations. The gateway wraps
the URI; the host rereads the view. Notifications cannot perform actions.

Services may observe shared storage to notify external changes. Otherwise external
writers must emit updates or users must refresh: the generic host adds no watcher or
background polling. It also refreshes after model tool calls.

| Event | Host behavior |
|---|---|
| Missing/invalid view | Clears service footer; shows error |
| Gateway disconnect | Clears native views |
| Child disconnect | Gateway emits `notifications/native-ui/invalidated` with `{service}`; clears that service's view/controls/footer |
| Notification during refresh | Queues a follow-up read |
| Invalidated view | Cannot dispatch a pending edit |
| Late response after navigation/shutdown | Discarded by lifetime guards |

## Read-only extension queries

Trusted Pi extensions may emit `gateway:query-service-tool` with `{service, tool,
arguments?, respond}`. `respond` is called synchronously:

| Condition | Response |
|---|---|
| Gateway does not own configured service | `{handled:false}` |
| Owned service | `{handled:true, result: Promise<CallToolResult>}` |
| Invalid request | Handled response with `error` |
| Selected gateway configuration loading/failed | Handled error, not service absence |

The promise uses the normal MCP timeout and current native context. Only model-visible
tools explicitly advertising `readOnlyHint:true` are allowed; unavailable owned services
reject.

Consumers must not substitute an unrelated selection after failure or a null result.
Queries create no transcript/model turn. This trusted extension API is not a security
boundary.

Screens and previews are UI-only, never model messages; ordinary MCP tool results still
reach the model. Routing is not secrecy: trusted services and agents retain their
processes' OS access.
