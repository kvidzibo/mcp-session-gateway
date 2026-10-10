# Reusable operator settings (version 1)

A custom MCP extension shared with [pi-delegate](https://github.com/kvidzibo/pi-delegate/blob/main/mcp/README.md#operator-settings-extension), not a standard MCP feature. Settings remain outside tools/resources and agent context. Service names, fields and storage are service-owned.

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
`oneOf` constant choices become selectors. `readOnly` propagates to descendants.
Complex unions, arrays, `$ref` controls and unsupported types remain view-only;
full JSON Schema 2020-12 validation still runs before saving. Property paths use
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
optional; other services need no model catalogue or delegate roles. Availability is
service configuration, not proof that credentials/endpoints work.

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

## Trusted host route

The Pi adapter generates a separate private token and passes it to its gateway via
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
