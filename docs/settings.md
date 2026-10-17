# Reusable operator settings (version 1)

A custom MCP extension shared with [pi-delegate](https://github.com/kvidzibo/pi-delegate/blob/main/mcp/README.md#operator-settings-extension), not a standard MCP feature. Settings remain outside tools/resources and agent context. Service names, fields and storage are service-owned.

## Operator guide

With the [Pi adapter](../README.md#connect-pi), open **`/pi-services`**, highlight a
service, and press **Tab**, or press **Tab** in its app. The feature menu also
offers Settings. Only opted-in, connected services with contract version 1 are
eligible; services without settings still work normally.

1. Edit the local draft. Type in settings/choice lists to filter by
   case-insensitive words, including model names/providers. Backspace edits the
   search; Escape goes back.
2. Choose **Save changes** and review every preview line before Enter can save.
   Resizing resets review. Declining leaves the draft editable; Escape/Back
   discards it.
3. Confirm the save. pi-delegate applies changes to **future jobs**; running/queued
   jobs retain their settings. Other services report their own apply policy.

Settings are discovered from the child's schema, not hardcoded service names or
Pi's model catalogue. JSON Schema constraints are checked before saving; the
service owns validation, atomic persistence, and revisions. Scrollable overlays
keep controls visible with editor widgets/custom footers. Settings require TUI
mode and cannot overlap one-shot approval prompts.

After conflicting or uncertain writes, reopen to read current state—saves are
never replayed automatically. If the connection was retired by cancellation or
timeout, restart it first. Manual external changes may require collecting or
cancelling work before restarting. **`/reload` restarts the gateway and children;
it does not save settings.**

The following sections describe service opt-in, supported fields, and the
reusable protocol. See the [delegate recipe](integrations.md#live-delegate-panel)
for a complete service entry.

## Service opt-in

A gateway config entry uses `"settings": { "tokenEnv": "SERVICE_SETTINGS_TOKEN" }`.
Choose the environment variable documented by the service. It must be a valid,
non-reserved environment variable name. The gateway generates a fresh 32-byte
base64url token per service/connection and overrides any configured value. The
service must consume/remove that variable before starting workers or helpers,
validate the token before reading settings and never return/log it.

Advertise this object as `com.kvidzibo/settings` under MCP server capabilities
`extensions`, and `experimental` for older MCP clients:

```json
{
  "version": 1,
  "getMethod": "kvidzibo/settings/get",
  "updateMethod": "kvidzibo/settings/update",
  "authorization": "token",
  "audience": "operator"
}
```

Only these fixed methods are routed; arbitrary advertised RPC methods are not
forwarded. A missing/incompatible capability omits the service from settings.

### Read

`kvidzibo/settings/get` receives `{ "token": "<private service token>" }`.
Return:

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

`conflict`, `warning`, `applyTo` and `models` are optional. `writable: false` or
`conflict: true` disables editing. Warnings and apply policy are displayed privately.
Do not return credentials, prompts, executable settings or secret fields in this
operator envelope. The editor is for ordinary values, not credential entry.

Schemas use inline nested object properties and primitive fields. `enum` and
primitive `oneOf` constant choices become selectors even without an explicit `type`.
TUI selectors use single-row, scrolling lists in isolated overlays, independent
of editor widgets and footers. Typing filters immediately by case-insensitive words
anywhere in a label (including provider/model IDs). Backspace edits the query;
Escape goes back. An empty result cannot be selected. Long labels are truncated in selection lists; save
previews show the complete values. Strings/numbers use a focused, single-line JSON
input overlay (quote strings, use JSON escapes for newlines/control characters).
Spaces and all non-ASCII characters in values/paths are escaped as `\uXXXX` in
previews, preserving whitespace and exposing invisible/bidirectional characters. `readOnly` propagates to descendants.
Complex unions, arrays, `$ref` controls and unsupported types remain view-only;
full JSON Schema 2020-12 validation still runs before saving, not when opening the
editor. Large, distinct constant-only `oneOf` choices compile as equivalent `enum`
constraints; titles remain in the UI, while referenced, duplicate or constrained
alternatives retain their original schema. Property paths use
JSON Pointer escaping. Unsafe prototype property names are refused. Object nesting
is limited to 16 levels and 500 leaf fields. Schema defaults are not silently applied,
and there is no field deletion/reset API.

An optional `models` array follows pi-delegate's existing hint contract:

```json
[
  { "id": "provider/model", "label": "Model name", "available": true, "thinking": ["off", "low", "high"] }
]
```

When supplied, string fields named `model` use available catalogue entries; sibling
`thinking` fields use that model's supported levels. Changing a model stages both
values, with a reasoning choice when that sibling is editable. These hints are
optional; other services need no model catalogue or delegate roles. Current
unavailable choices remain visible but cannot be selected; no automatic fallback
is chosen. Availability is service configuration, not proof that
credentials/endpoints work.

### Update

`kvidzibo/settings/update` receives:

```json
{
  "token": "<private service token>",
  "revision": "<revision from get>",
  "patch": { "limit": 3 }
}
```

The patch contains only changed leaves, nested under their original object keys.
The service must reject stale revisions, validate the entire prospective state,
preserve unrelated values, persist atomically and return the same envelope with
its new revision. It owns how changes affect accepted work. pi-delegate uses
`future-jobs` and retains acceptance-time policy for running/queued jobs.

Suggested errors match pi-delegate: `-33001` unauthorized, `-33002` revision/disk
conflict, `-33003` persistence/catalogue unavailable, `-32602` invalid input. The UI
never automatically retries a write; reread after conflict or uncertain completion.
Confirmation uses an isolated scrolling overlay. Enter can save only after every
preview line has been rendered visibly. Resizing resets that review; unrendered
resize events cannot authorize writing. Escape, cancellation or timeout during
confirmation never dispatches a save. After dispatch, cancellation or timeout may
leave a committed write; reread state before attempting another save.

## Trusted host route

In TUI mode, the Pi adapter generates a separate private token and passes it to its gateway via
`MCP_GATEWAY_SETTINGS_TOKEN`. The gateway consumes/removes it before spawning
children. With no token, it registers no operator RPC handlers and generates no
child settings tokens. Tokens must be base64url, 32–256 characters; generate at
least 32 random bytes. Do not put them in model arguments or model-readable config.

An enabled gateway advertises `com.kvidzibo/gateway-settings` under
`capabilities.experimental`: `{ "version": 1, "audience": "operator", "authorization": "token" }`.
Custom requests on the same upstream MCP connection:

| Method | Parameters | Result |
|---|---|---|
| `gateway/settings/list` | `token` | `{ services: [{ name }] }` for eligible connected services |
| `gateway/settings/get` | `token`, `service` | Service settings envelope |
| `gateway/settings/update` | `token`, `service`, `revision`, `patch` | Updated envelope |

The gateway authenticates upstream first, chooses the existing child connection,
replaces upstream authorization with that child's private token, and forwards only
the fixed settings method. All requests use existing per-service serialization,
timeouts/cancellation and connection cleanup. A timed-out/cancelled started request
retires that service connection; reopening settings cannot revive it without a restart.

**Never expose this route as a generic tool or custom-RPC forwarding tool.** A host
must show exact changes and obtain human confirmation before sending updates. The
token authenticates the operator route, not proof that a human clicked. Stdio
isolation and hidden methods are not an OS sandbox; configure only trusted services.
