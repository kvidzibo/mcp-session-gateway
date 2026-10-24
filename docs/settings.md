# Reusable operator settings (version 1)

Custom MCP extension shared with
[pi-delegate](https://github.com/kvidzibo/pi-delegate/blob/main/mcp/README.md#operator-settings-extension),
not standard MCP. Settings stay outside tools/resources/agent context; services own fields/storage.

## Operator guide

With the [Pi adapter](../README.md#connect-pi), open **`/pi-services` → highlight service → Tab**,
**Tab** in its app, or its settings action (named **Roles** for pi-delegate). Requires TUI, opt-in,
connection and v1; other services work normally. See [delegate setup](integrations.md#live-delegate-panel).

Pi-delegate lists each role with its configured model ID and reasoning level, without opening it.
Type to filter by role, model/provider or reasoning. Select one to edit model, thinking, tool checkboxes,
extension access, enablement and its multiline prompt. **Add role** creates a draft with no tools or
extension access; choose a model and enter a prompt to complete it; it saves automatically once valid. Extension access
enables configured extension and MCP discovery, not a sandbox or per-extension allowlist.

1. Type case-insensitive words to filter fields/choices, including models/providers.
   Backspace edits search; Escape goes back.
2. Completed valid edits **save automatically**, without a separate Save/review action, and keep
   the selected role open. Enter submits multiline text; Shift+Enter inserts a newline. Checkbox
   **Done** commits. Model and reasoning choices save together; Escape cancels an incomplete field
   edit without sending it. Invalid existing-role edits report an error and restore the previous value.
3. New roles are labeled **new draft — not saved**, with validation errors until complete/valid.
   Back/Escape from the new role cancels that draft. Valid drafts save automatically.
   Service displays apply policy; pi-delegate changes affect future jobs, not running/queued jobs.

Schema supplies fields, not hardcoded names/Pi's catalogue. Native inline controls preserve
spacing and navigation beside widgets/footers; settings cannot overlap one-shot approvals.
Cancelling an incomplete edit sends nothing; previously saved edits remain saved.
After dispatch, cancellation/timeout may leave committed writes. After conflict/uncertainty,
reopen/read; never replay. Started-request cancellation/timeout retires connection: restart first,
collecting/cancelling work as needed.
**`/reload` restarts gateway/children; it does not save settings.**

## Service opt-in

Inside the service entry, configure `"settings": { "tokenEnv": "SERVICE_SETTINGS_TOKEN" }`: a
service-documented, valid, non-reserved variable name, not a token value. Gateway generates a fresh
32-byte base64url token per service/connection, overriding configured values. Service must
consume/remove it before workers/helpers, authenticate before reading settings, and never return/log
it.

Advertise `com.kvidzibo/settings` under capabilities `extensions`, plus `experimental` for older
clients:

```json
{
  "version": 1,
  "getMethod": "kvidzibo/settings/get",
  "updateMethod": "kvidzibo/settings/update",
  "authorization": "token",
  "audience": "operator",
  "title": "Roles"
}
```

Only fixed methods route; missing/incompatible capabilities omit settings. Optional `title` names
the service's settings action; omitted/empty titles retain **Settings**.

### Read

`kvidzibo/settings/get` receives `{ "token": "<private service token>" }`. Return:

```json
{
  "schemaVersion": 1,
  "title": "Example service",
  "revision": "opaque revision",
  "writable": true,
  "conflict": false,
  "applyTo": "future-jobs",
  "schema": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "enabled": { "type": "boolean", "title": "Enabled" },
      "limit": { "type": "integer", "minimum": 1, "maximum": 10 }
    },
    "additionalProperties": false
  },
  "values": { "enabled": true, "limit": 2 }
}
```

`writable: false`/`conflict: true` disables editing. `conflict`, `warning`, `applyTo`, `models` are
optional; warnings/apply policy display privately. **Exclude credentials and secret fields.** Role
prompts and permissions belong only in this trusted operator route, never tools/resources.

| Schema/input | Behavior |
|---|---|
| Inline nested objects/primitives | Editable; a sole named collection lists entries first |
| `enum`/primitive `oneOf` constants | Selectors, even without `type` |
| Strings/numbers | Focused single-line JSON; quote strings, escape newlines/controls |
| String with `x-multiline: true` | Plain multiline editor; Shift+Enter newline, Enter submits/saves; summary shows lines and approximate tokens (`ceil(characters / 4)`; model tokenizer varies) |
| Unique arrays with primitive `items.enum` | Checkboxes; Done commits, Escape discards this field's edits |
| Collection with object `additionalProperties` | Add a named entry using its schema/defaults; `propertyNames` validates names |
| `readOnly` | Propagates to descendants |
| Complex unions/other arrays/`$ref` controls/unsupported types | View-only |

Selectors use isolated single-row scrolling lists; empty results are unselectable. Lists truncate
labels; single-line values/paths escape spaces/non-ASCII as `\uXXXX` to expose invisible/bidirectional
characters. Open a multiline field to inspect its full text.

Full JSON Schema 2020-12 validation precedes saving, not opening. Large distinct constant-only
`oneOf` compiles as equivalent `enum`, retaining titles; referenced/duplicate/constrained
alternatives stay unchanged. Paths use JSON Pointer escaping; unsafe prototype names are refused.
Limits: **16 object levels, 500 leaves**. New entries explicitly use schema defaults, but no model
is silently selected. There is no field deletion/reset API. Tool arrays recognize `*` as all tools;
deselecting one replaces it with an explicit list of the remaining offered tools.

Optional `models` uses pi-delegate's hint contract:

```json
[
  { "id": "provider/model", "label": "Model name", "available": true, "thinking": ["off", "low", "high"] }
]
```

String `model` fields use available entries; sibling `thinking` uses supported levels. Model changes
save both atomically, offering reasoning choice when sibling editable. Unavailable current choices remain
visible/unselectable; no fallback. Availability describes service configuration, not
credential/endpoint health. Other services need no catalogue/delegate roles.

### Update

`kvidzibo/settings/update` receives:

```json
{
  "token": "<private service token>",
  "revision": "<revision from get>",
  "patch": { "limit": 3 }
}
```

Patch only changed leaves, including all fields of completed new entries. Service must reject stale revisions, validate entire
prospective state, preserve unrelated values, persist atomically and return envelope/new revision.
Service owns accepted-work effects; pi-delegate's `future-jobs` retains acceptance-time policy.

Suggested errors: `-33001` unauthorized; `-33002` revision/disk conflict; `-33003`
persistence/catalogue unavailable; `-32602` invalid input. Hosts follow [operator
workflow](#operator-guide).

## Trusted host route

In TUI mode, adapter passes a separate private token through `MCP_GATEWAY_SETTINGS_TOKEN`. Gateway
consumes/removes it before children; without it, no operator handlers/child settings tokens. Tokens:
base64url, **32–256 characters**, at least **32 random bytes**; never model arguments/readable
config. Enabled gateway advertises `com.kvidzibo/gateway-settings` under
`capabilities.experimental`:

```json
{ "version": 1, "audience": "operator", "authorization": "token" }
```

Same upstream MCP connection:

| Method | Parameters | Result |
|---|---|---|
| `gateway/settings/list` | `token` | `{ services: [{ name, title? }] }`: eligible connected services |
| `gateway/settings/get` | `token`, `service` | Envelope |
| `gateway/settings/update` | `token`, `service`, `revision`, `patch` | Updated envelope |

Gateway authenticates upstream first, selects existing child connection, substitutes private token,
forwards fixed method. Per-service serialization, timeouts/cancellation/cleanup apply. **Never
expose generic tool/custom-RPC forwarding.** Hosts must expose edits only through trusted operator UI;
completed valid field edits authorize revisioned updates without a separate confirmation. The token
authenticates the route, not clicks. Hidden methods/stdio are no OS sandbox; trust services.
