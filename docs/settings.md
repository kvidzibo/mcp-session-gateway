# Reusable operator settings (version 1)

Custom MCP extension shared with
[pi-delegate](https://github.com/kvidzibo/pi-delegate/blob/main/mcp/README.md#operator-settings-extension),
not standard MCP. Settings stay outside tools/resources/agent context; services own fields/storage.

## Operator guide

With the [Pi adapter](../README.md#connect-pi), open **`/pi-services` → highlight service → Tab**,
**Tab** in its app, or feature-menu **Settings**. Requires TUI, opt-in, connection and v1; other
services work normally. See [delegate setup](integrations.md#live-delegate-panel).

1. Edit draft; type case-insensitive words to filter fields/choices, including models/providers.
   Backspace edits search; Escape goes back.
2. **Save changes**: visibly review every preview line before Enter. Resizing resets review;
   unrendered resize events cannot authorize writes. Decline preserves draft; Escape/Back discards.
3. Confirm. Service displays apply policy; pi-delegate changes affect future jobs, not
   running/queued jobs.

Schema supplies fields, not hardcoded names/Pi's catalogue. Isolated scrollable overlays preserve
controls beside widgets/footers; settings cannot overlap one-shot approvals. **Before confirmation,
nothing dispatches**, including cancellation/timeout. After dispatch, cancellation/timeout may leave
committed writes. After conflict/uncertainty, reopen/read; never replay. Started-request
cancellation/timeout retires connection: restart first, collecting/cancelling work as needed.
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
  "audience": "operator"
}
```

Only fixed methods route; missing/incompatible capabilities omit settings.

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
optional; warnings/apply policy display privately. **Exclude credentials, prompts, executable
settings and secret fields.**

| Schema/input | Behavior |
|---|---|
| Inline nested objects/primitives | Editable |
| `enum`/primitive `oneOf` constants | Selectors, even without `type` |
| Strings/numbers | Focused single-line JSON; quote strings, escape newlines/controls |
| `readOnly` | Propagates to descendants |
| Complex unions/arrays/`$ref` controls/unsupported types | View-only |

Selectors use isolated single-row scrolling lists; empty results are unselectable. Lists truncate
labels; previews show complete values, escaping spaces/non-ASCII in values/paths as `\uXXXX` to
expose invisible/bidirectional characters and preserve whitespace.

Full JSON Schema 2020-12 validation precedes saving, not opening. Large distinct constant-only
`oneOf` compiles as equivalent `enum`, retaining titles; referenced/duplicate/constrained
alternatives stay unchanged. Paths use JSON Pointer escaping; unsafe prototype names are refused.
Limits: **16 object levels, 500 leaves**. No silent defaults or field deletion/reset API.

Optional `models` uses pi-delegate's hint contract:

```json
[
  { "id": "provider/model", "label": "Model name", "available": true, "thinking": ["off", "low", "high"] }
]
```

String `model` fields use available entries; sibling `thinking` uses supported levels. Model changes
stage both, offering reasoning choice when sibling editable. Unavailable current choices remain
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

Patch only changed leaves under original keys. Service must reject stale revisions, validate entire
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
| `gateway/settings/list` | `token` | `{ services: [{ name }] }`: eligible connected services |
| `gateway/settings/get` | `token`, `service` | Envelope |
| `gateway/settings/update` | `token`, `service`, `revision`, `patch` | Updated envelope |

Gateway authenticates upstream first, selects existing child connection, substitutes private token,
forwards fixed method. Per-service serialization, timeouts/cancellation/cleanup apply. **Never
expose generic tool/custom-RPC forwarding.** Hosts must show exact changes and obtain human
confirmation; token authenticates route, not clicks. Hidden methods/stdio are no OS sandbox; trust
services.
