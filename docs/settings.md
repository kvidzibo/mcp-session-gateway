# Reusable operator settings (version 1)

A custom MCP extension shared with
[pi-delegate](https://github.com/kvidzibo/pi-delegate/blob/main/mcp/README.md#operator-settings-extension),
not standard MCP. Settings stay outside tools/resources and agent context. Services own
names, fields and storage.

## Operator guide

With the [Pi adapter](../README.md#connect-pi), open **`/pi-services` → highlight
service → Tab**, press **Tab** in its app, or choose **Settings** from its feature menu.
Requires TUI mode, service opt-in, a connection and contract version 1. Services without
settings work normally.

### Edit and confirm

1. Edit the local draft. Type case-insensitive words to filter settings/choices,
   including model names/providers. Backspace edits the search; Escape goes back.
2. Choose **Save changes**. Every preview line must render visibly before Enter
   confirms. Resizing resets review; unrendered resize events cannot authorize writes.
   Declining keeps the draft editable; Escape/Back discards it.
3. Confirm. pi-delegate changes affect **future jobs**; running/queued jobs retain their
   settings. Other services display their own apply policy.

Fields come from the service schema, not hardcoded names or Pi's model catalogue.
Isolated, scrollable overlays keep controls visible with editor widgets/custom footers.
Settings cannot overlap one-shot approvals.

**No save is dispatched before confirmation.** Escape, cancellation or timeout during
confirmation sends nothing. After dispatch, cancellation or timeout may leave a
committed write.

### Recover an uncertain save

After conflict or uncertain completion, reopen to read current state; saves are never
replayed automatically. Cancellation/timeout of a started request retires the
connection: restart before reopening. External changes may require collecting or
cancelling work before restart.

**`/reload` restarts the gateway and children; it does not save settings.**

See the [delegate recipe](integrations.md#live-delegate-panel) for a complete entry.

## Service opt-in

Configure `"settings": { "tokenEnv": "SERVICE_SETTINGS_TOKEN" }` inside the service
entry. Use the service-documented, valid, non-reserved environment variable name.

The gateway generates a fresh 32-byte base64url token per service/connection, overriding
configured values. The service must:

- Consume/remove the variable before starting workers or helpers.
- Validate the token before reading settings.
- Never return or log it.

Advertise `com.kvidzibo/settings` under MCP server capabilities `extensions`, and
`experimental` for older clients:

```json
{
  "version": 1,
  "getMethod": "kvidzibo/settings/get",
  "updateMethod": "kvidzibo/settings/update",
  "authorization": "token",
  "audience": "operator"
}
```

Only these fixed methods are routed, not arbitrary advertised RPC methods.
Missing/incompatible capabilities omit the service from settings.

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

| Field | Behavior |
|---|---|
| `writable: false` or `conflict: true` | Disables editing |
| `conflict`, `warning`, `applyTo`, `models` | Optional |
| Warnings and apply policy | Displayed privately |

**Do not return credentials, prompts, executable settings or secret fields.** This
envelope edits ordinary values, not credentials.

#### Fields and validation

| Schema/input | Editor behavior |
|---|---|
| Inline nested objects and primitive fields | Editable |
| `enum` or primitive `oneOf` constant choices | Selectors, even without explicit `type` |
| Strings/numbers | Focused single-line JSON input; quote strings and escape newlines/control characters |
| `readOnly` | Propagates to descendants |
| Complex unions, arrays, `$ref` controls, unsupported types | View-only |

Selectors use single-row scrolling lists in isolated overlays. Empty results cannot be
selected. Long labels are truncated in lists; save previews show complete values.
Previews escape spaces and all non-ASCII characters in values/paths as `\uXXXX`,
preserving whitespace and exposing invisible/bidirectional characters.

- Full JSON Schema 2020-12 validation runs **before saving**, not on editor opening.
- Large, distinct constant-only `oneOf` choices compile as equivalent `enum`
  constraints; UI titles remain. Referenced, duplicate or constrained alternatives keep
  their original schema.
- Property paths use JSON Pointer escaping; unsafe prototype property names are refused.
- Limits: **16 object levels, 500 leaf fields**.
- Defaults are not silently applied; no field deletion/reset API exists.

#### Model hints

Optional `models` follows pi-delegate's existing hint contract:

```json
[
  { "id": "provider/model", "label": "Model name", "available": true, "thinking": ["off", "low", "high"] }
]
```

- String fields named `model` use available catalogue entries; sibling `thinking` fields
  use the selected model's supported levels.
- Changing a model stages both values, offering a reasoning choice when the sibling is
  editable.
- Current unavailable choices remain visible but unselectable; no automatic fallback is
  chosen.
- Availability reflects service configuration, not working credentials/endpoints.

Other services need no model catalogue or delegate roles.

### Update

`kvidzibo/settings/update` receives:

```json
{
  "token": "<private service token>",
  "revision": "<revision from get>",
  "patch": { "limit": 3 }
}
```

The patch contains only changed leaves under their original object keys. The service
must reject stale revisions, validate the entire prospective state, preserve unrelated
values, persist atomically and return the same envelope with a new revision.

The service owns effects on accepted work. pi-delegate uses `future-jobs`, retaining
acceptance-time policy for running/queued jobs.

| Suggested error | Meaning |
|---|---|
| `-33001` | Unauthorized |
| `-33002` | Revision/disk conflict |
| `-33003` | Persistence/catalogue unavailable |
| `-32602` | Invalid input |

Hosts must follow the [confirmation workflow](#edit-and-confirm) and [uncertain-save
recovery](#recover-an-uncertain-save); never replay writes automatically.

## Trusted host route

### Authorization and advertisement

In TUI mode, the adapter generates a separate private token and passes it to the gateway
through `MCP_GATEWAY_SETTINGS_TOKEN`. The gateway consumes/removes it before spawning
children. Without it, no operator RPC handlers or child settings tokens are created.

Tokens must be base64url, **32–256 characters**, generated from at least **32 random
bytes**. Never put them in model arguments or model-readable config.

An enabled gateway advertises `com.kvidzibo/gateway-settings` under
`capabilities.experimental`:

```json
{ "version": 1, "audience": "operator", "authorization": "token" }
```

### Requests and lifecycle

Custom requests use the same upstream MCP connection:

| Method | Parameters | Result |
|---|---|---|
| `gateway/settings/list` | `token` | `{ services: [{ name }] }` for eligible connected services |
| `gateway/settings/get` | `token`, `service` | Service settings envelope |
| `gateway/settings/update` | `token`, `service`, `revision`, `patch` | Updated envelope |

The gateway authenticates upstream first, selects the existing child connection,
substitutes its private token and forwards only the fixed settings method. Requests
retain per-service serialization, timeouts/cancellation and cleanup. A
timed-out/cancelled started request retires that connection; reopening settings requires
restart.

**Never expose this route as a generic tool or custom-RPC forwarding tool.** Hosts must
show exact changes and obtain human confirmation before updates. The token authenticates
the route, not a human click. Stdio isolation and hidden methods are not an OS sandbox;
configure only trusted services.
