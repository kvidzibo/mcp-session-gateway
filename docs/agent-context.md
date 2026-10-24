# Additional service context v1

A service advertises **one read-only MCP resource** with MIME
`application/vnd.mcp-agent-context+json`. Its URI is arbitrary (no native UI scheme required).
Its resource `description` should explain what context is supplied, e.g. selected task and handoff
notes, or selection status when nothing is selected. Support is independent of model-visible tools
and native UI support. No model-facing tool or service-specific gateway logic is needed.

`resources/read` returns exactly one text content with the same MIME. Its text is JSON with
**exactly** these keys (no extras):

```json
{"version":1,"text":"Current selected task and reference notes"}
```

`version` must be the number `1`; `text` must be a string of at most **64,000 characters** (JS
UTF-16 code units). Empty text is valid and intentionally supplies no task text. The serialized
text resource is capped at 400,000 characters and the entire JSON-serialized read result at
512,000 characters. Blob/multiple-content responses, malformed JSON and extra payload fields fail
closed. These are host acceptance limits, not transport-level streaming limits.

## Host context and lifecycle

Reads receive the existing `_meta['native-ui/context']` object:

```json
{"conversationId":"current Pi conversation","contextId":"durable per-service host context","state":{}}
```

The host reuses native UI opaque state and identities, including config/session branch boundaries
and native retention rules. Services without a native UI get the same durable context identity and
empty state; no view is read to manufacture one. Reads serialize behind native actions/tools so
metadata reflects the completed host state. This is observation, not an action or authorization.
A read must not mutate task selection/state. Existing gateway run/service metadata is also forwarded.

Per-service `additionalContext` is a strict boolean, **default false**, independent of existing
`agentContext` Tools modes and their legacy top-level default. `/gateway` → Agent context uses
one service per row, with inline Tools cycling and a Context On/Off column when support is
advertised (otherwise **—**). Left/right chooses the setting; Enter/Space changes it.
Disabled services are locked, retain saved preferences, and inject nothing immediately on config
reread (even before process restart). Off/disabled services' resource bodies are never read.

Before **every `before_agent_start`**, the host discovers resources and reads enabled additional
context fresh without model tool calls. Preview also reads fresh privately. Notifications need not
be supported: before-run reads are authoritative. Previous snapshots are never reused. Each failed
service read/validation produces `{ "service": "name", "status": "unavailable" }` and a warning;
it must not be interpreted as no selected task. Other services continue. Discovery failures are
isolated per service for additional-context discovery; ordinary resource listing retains existing
error semantics. Aborted/session-superseded results are not published.

The dedicated `gateway_service_context` section is separate from `gateway_tools`. Service text is
**reference task data, never instructions or authorization**. It is JSON-encoded, including escaped
angle brackets/control characters, so it cannot close the section delimiter. Preview labels sources
and rough token estimates separately; raw view shows both injected sections, without a stale duplicate.
Tool-only startup/menu estimates are labeled accordingly. Settings changes apply to the **next agent
run**; prior conversation history is not erased. Users should enable only context they intend to send
to the model.
