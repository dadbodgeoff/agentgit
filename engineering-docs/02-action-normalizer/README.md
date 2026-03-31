# 02. Action Normalizer

Status note:

- this document describes the broader normalization design space
- audited launch/runtime truth is narrower: governed launch surfaces are `filesystem`, `shell`, and owned `function` integrations
- browser/computer and generic governed HTTP are not shipped launch/runtime surfaces today

## Working Thesis

The Action Normalizer should produce a single canonical `Action` object for the smallest governable execution attempt.

That means:

- one wrapped shell command is one action
- one wrapped function tool invocation is one action
- one proxied MCP `tools/call` request is one action
- one governed browser interaction request is one action

The action is the stable descriptor.
Policy decisions, snapshots, execution results, and restore attempts should be separate lifecycle records that reference `action_id`.

This keeps the action model durable and prevents the schema from collapsing into an all-purpose event blob.

## Why This Matters

If the canonical action is too abstract:

- policy cannot reason precisely
- snapshots will not know what boundary they protect
- timelines will feel vague
- rollback will be hard to explain

If the canonical action is too granular:

- shell commands explode into too many pseudo-actions
- browser sessions become unreadable
- the system loses the same governable boundary the user actually approved

So the right unit is:

**the smallest execution attempt we can govern honestly before side effects happen**

## Research-Driven Design Constraints

### MCP already gives us a strong raw tool-call shape

The MCP tools spec gives us a useful baseline:

- a tool has a stable `name`
- `inputSchema` is JSON Schema
- `outputSchema` can exist
- `tools/call` has a discrete request boundary
- tool annotations are untrusted unless the server is trusted

Design implication:

- MCP tool calls map cleanly to a normalized action
- MCP annotations should be ingested as hints, not facts

### OpenAI tool-calling gives us a stable call identity pattern

OpenAI’s tool-calling flow uses a distinct call item with fields such as:

- call identity
- tool name
- JSON-encoded arguments

Design implication:

- the normalizer should preserve raw upstream call IDs for correlation
- raw tool arguments should be retained in a redacted, auditable form

### JSON Schema 2020-12 should be our internal schema baseline

MCP defaults to JSON Schema 2020-12 when no `$schema` is present, and modern tool ecosystems are already aligned around JSON Schema-like tool definitions.

Design implication:

- our canonical `Action` schema should be defined in JSON Schema 2020-12
- tool input and output schema refs should be preserved when available

### Trace propagation should use standard correlation, not custom magic

W3C Trace Context and OpenTelemetry are the current interoperability center for traces, spans, and causal correlation.

Design implication:

- actions should carry trace correlation fields
- we should use standard trace IDs and parent relationships where available
- credentials and secrets must never ride in propagated trace baggage

## What Counts As An Action

An action is a normalized record representing an attempt to perform a governable or observed operation that could matter to policy, recovery, or replay.

### Count as actions

- shell command execution attempts
- filesystem mutation attempts
- browser navigation/click/type/submit attempts when routed through our harness
- HTTP or API calls routed through owned adapters
- MCP tool invocations
- custom function tool invocations
- external communications like email send
- financial or irreversible operations later

### Do not count as standalone actions in v1

- every single file changed by a shell command
- every DOM mutation caused by a browser click
- every log line
- every token streamed by a model

Those belong in artifacts, spans, or side-effect evidence, not as independent governable actions.

## Non-Goals

- Create a perfect universal ontology for all possible tool behavior
- Flatten every side effect into the same level of detail
- Encode policy decisions, snapshots, and execution outputs inside the action object itself

## Canonical Model

The normalizer should emit a canonical `Action` object with a stable core plus domain-specific facets.

## Top-Level Shape

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "schema_version": "action.v1",
  "action_id": "act_01H...",
  "run_id": "run_01H...",
  "session_id": "sess_01H...",
  "status": "normalized",
  "timestamps": {
    "requested_at": "2026-03-29T15:10:24Z",
    "normalized_at": "2026-03-29T15:10:24Z"
  },
  "provenance": {
    "mode": "governed",
    "source": "sdk",
    "confidence": 1.0
  },
  "correlation": {
    "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
    "span_id": "00f067aa0ba902b7",
    "parent_action_id": null,
    "upstream_call_ids": [
      {
        "system": "openai_responses",
        "id": "call_12345xyz"
      }
    ]
  },
  "actor": {
    "type": "agent",
    "agent_name": "code-agent",
    "agent_framework": "openai_agents_python",
    "tool_name": "shell",
    "tool_kind": "shell"
  },
  "operation": {
    "domain": "shell",
    "kind": "shell.exec",
    "name": "exec",
    "display_name": "Run shell command"
  },
  "execution_path": {
    "surface": "governed_shell",
    "mode": "pre_execution",
    "credential_mode": "none"
  },
  "target": {
    "primary": {
      "type": "workspace",
      "locator": "file:///repo"
    },
    "scope": {
      "breadth": "workspace",
      "unknowns": []
    }
  },
  "input": {
    "raw": {
      "command": "rm -rf build"
    },
    "redacted": {
      "command": "rm -rf build"
    },
    "schema_ref": null,
    "contains_sensitive_data": false
  },
  "risk_hints": {
    "side_effect_level": "destructive",
    "external_effects": "none",
    "reversibility_hint": "potentially_reversible",
    "sensitivity_hint": "low",
    "batch": false
  },
  "facets": {
    "shell": {
      "argv": ["rm", "-rf", "build"],
      "cwd": "/repo",
      "interpreter": "execve",
      "declared_env_keys": []
    }
  },
  "normalization": {
    "mapper": "shell/v1",
    "inferred_fields": [],
    "warnings": []
  }
}
```

## Core Fields

### Identity

- `schema_version`
- `action_id`
- `run_id`
- `session_id`

These fields make the action independently addressable and versioned.

### Status

The normalizer should emit `status: normalized`.

Downstream systems should not mutate the action into a result object. They should emit lifecycle events such as:

- policy decided
- snapshot created
- execution started
- execution completed
- recovery attempted

### Timestamps

At normalization time we only need:

- `requested_at`
- `normalized_at`

Execution and completion timestamps belong in later records.

## Provenance Model

Every action should be labeled with one of these provenance modes:

### `governed`

We saw the request before execution on a wrapped path and could have blocked or modified behavior.

### `observed`

We detected the action or its effects after the fact from a watcher, trace feed, diff, or instrumentation source.

### `imported`

We ingested the record from an external provider log or foreign audit stream.

### `unknown`

We know something happened, but we do not have enough trustworthy information to classify it more precisely.

This distinction is essential.
It prevents us from overclaiming control.

## Correlation Model

Use standard trace fields when available:

- `trace_id`
- `span_id`
- `parent_action_id`
- `upstream_call_ids`

This lets us correlate:

- a model tool call
- the normalized action
- the adapter execution span
- downstream HTTP requests
- later timeline and replay views

Do not put secrets, tokens, or raw credentials in trace context or baggage.

## Actor Model

The actor block should answer:

- who or what initiated this action?
- through which tool surface?

Recommended fields:

- `type`: `agent`, `user`, `system`, `observer`
- `agent_name`
- `agent_framework`
- `tool_name`
- `tool_kind`
- `tool_registration_id` optional

## Operation Taxonomy

Each action should have both:

- `domain`
- `kind`

### Recommended domains for v1

- `shell`
- `filesystem`
- `browser`
- `http`
- `api`
- `mcp`
- `function`
- `email`
- `payment`
- `system`

### Recommended `kind` examples

- `shell.exec`
- `filesystem.write`
- `filesystem.delete`
- `filesystem.move`
- `browser.navigate`
- `browser.click`
- `browser.type`
- `browser.submit`
- `http.request`
- `api.call`
- `mcp.tool_call`
- `function.call`
- `email.send`
- `payment.charge`

`domain` keeps reporting and safe modes intuitive.
`kind` gives us the precision policy and replay need.

## Execution Path

This block captures how the action reached us.

Recommended fields:

- `surface`
  - `sdk_function`
  - `governed_shell`
  - `governed_fs`
  - `governed_browser`
  - `mcp_proxy`
  - `provider_hosted`
  - `observer`
- `mode`
  - `pre_execution`
  - `post_hoc`
  - `imported`
- `credential_mode`
  - `brokered`
  - `delegated`
  - `direct`
  - `none`
  - `unknown`

This is where the launch boundary becomes visible in the data model.

## Target And Scope

These fields should answer:

- what is the primary thing this action is aimed at?
- how broad is the likely blast radius?

Recommended shape:

- `primary`
  - typed locator such as `file:///repo/src`, `https://api.example.com/tickets`, `mailto:user@example.com`
- `additional`
  - optional list of additional targets
- `scope`
  - `breadth`: `single`, `set`, `workspace`, `repository`, `origin`, `external`, `unknown`
  - `estimated_count`
  - `unknowns`

Scope is often partially inferred.
Unknown scope should be represented explicitly, not hidden by omission.

## Input Handling

We should preserve three things:

- the raw upstream input when safe to store
- a redacted form suitable for audit and replay
- a schema reference when available

Recommended fields:

- `raw`
- `redacted`
- `schema_ref`
- `contains_sensitive_data`
- `redaction_reasons`

If credentials appear in raw input:

- do not store secrets in cleartext
- replace with redaction markers
- store stable hashes or references only when needed for correlation

## Risk Hints

The normalizer should not make the final policy decision.
It should provide structured hints that policy can consume.

Recommended fields:

- `side_effect_level`
  - `read_only`
  - `mutating`
  - `destructive`
  - `unknown`
- `external_effects`
  - `none`
  - `network`
  - `communication`
  - `financial`
  - `unknown`
- `reversibility_hint`
  - `reversible`
  - `potentially_reversible`
  - `compensatable`
  - `irreversible`
  - `unknown`
- `sensitivity_hint`
  - `low`
  - `moderate`
  - `high`
  - `unknown`
- `batch`
  - boolean

These are hints, not verdicts.

## Domain Facets

The core model should stay stable while domain-specific details live under `facets`.

### `facets.shell`

- `argv`
- `cwd`
- `interpreter`
- `declared_env_keys`
- `stdin_kind`

### `facets.filesystem`

- `operation`
- `paths`
- `path_count`
- `recursive`
- `overwrite`

### `facets.browser`

- `action`
- `url`
- `origin`
- `selector`
- `element_role`
- `navigation_expected`

### `facets.http`

- `method`
- `url`
- `origin`
- `path_template`
- `request_body_kind`
- `response_expected`

### `facets.mcp`

- `server_label`
- `server_uri` optional
- `tool_name`
- `tool_annotations`
- `trusted_server`

### `facets.function`

- `function_name`
- `arguments_kind`
- `declared_schema_hash`

## Normalization Metadata

We need to record how the action was produced.

Recommended fields:

- `mapper`
- `inferred_fields`
- `warnings`
- `normalization_confidence`

This is especially important for:

- observed actions
- imported audit events
- shell commands with unclear scope
- browser actions with ambiguous targets

## Explicitly Out Of The Action Object

These should not be embedded directly in the canonical action:

- policy decision
- approval record
- snapshot reference
- stdout/stderr payloads
- file diffs
- screenshots
- HTTP response bodies
- recovery result

Those belong in:

- the policy engine output
- execution artifacts
- the immutable run journal

## Normalization Rules

### Rule 1. Normalize before policy on governed paths

Wrapped tool calls should be normalized before any allow/deny/snapshot decision is made.

### Rule 2. Preserve raw upstream identity

Keep upstream identifiers like:

- OpenAI `call_id`
- MCP request ID
- framework tool invocation IDs

These are crucial for tracing and debugging.

### Rule 3. Never trust foreign hints without labeling them

MCP annotations, tool metadata, or framework categories should be retained as hints but clearly marked untrusted unless they come from a trusted source.

### Rule 4. One governable boundary equals one action

Do not split a shell command into child actions during normalization.

If a batch operation needs more detail later:

- keep the parent action
- attach artifacts or derived subeffects later

### Rule 5. Unknown is better than guessed certainty

When scope, reversibility, or sensitivity is unclear, record:

- the best bounded inference
- the uncertainty
- the warning

### Rule 6. No secrets in normalized actions

Canonical actions may contain references, redacted placeholders, and stable hashes.
They must not become a shadow credential store.

## First Mappers To Build

### 1. `shell/v1`

Input:

- command string or argv
- cwd
- runtime env metadata

Output:

- `domain: shell`
- `kind: shell.exec`
- shell facet
- scope and reversibility hints

### 2. `filesystem/v1`

Input:

- governed file helper operation

Output:

- `domain: filesystem`
- precise file operation kind
- explicit target paths

### 3. `mcp/v1`

Input:

- server metadata
- `tools/call` request
- upstream tool schemas and annotations if available

Output:

- `domain: mcp`
- `kind: mcp.tool_call`
- MCP facet
- untrusted hint capture

### 4. `function/v1`

Input:

- wrapped function tool
- arguments
- schema reference

Output:

- `domain: function`
- `kind: function.call`
- function facet

### 5. `browser/v1`

Input:

- governed browser harness request

Output:

- `domain: browser`
- action-specific browser kind
- origin and selector hints

## Proposed Build Order

1. Finalize the canonical `Action` JSON Schema
2. Finalize the provenance model: `governed`, `observed`, `imported`, `unknown`
3. Finalize execution-path fields including `credential_mode`
4. Build `shell/v1`, `filesystem/v1`, and `mcp/v1` mappers
5. Add redaction rules and secret-safe storage policy
6. Add target/scope inference warnings
7. Add `browser/v1` and `function/v1`

## Concrete Recommendation

For v1, the normalizer should optimize for one outcome:

**every governable action enters the rest of the system with a stable identity, honest provenance, explicit execution path, and enough typed structure for policy and recovery to reason about it**

If we get that right, the rest of the control plane has a real substrate to build on.

## Research Inputs

- MCP tools specification: <https://modelcontextprotocol.io/specification/draft/server/tools>
- JSON Schema Draft 2020-12: <https://json-schema.org/draft/2020-12>
- OpenAI function calling guide: <https://platform.openai.com/docs/guides/function-calling>
- OpenAI tools guide: <https://platform.openai.com/docs/guides/tools?api-mode=responses>
- OpenAI Agents SDK tracing: <https://openai.github.io/openai-agents-python/tracing/>
- W3C Trace Context: <https://www.w3.org/TR/trace-context/>
- OpenTelemetry trace semantic conventions: <https://opentelemetry.io/docs/specs/semconv/general/trace/>
- OpenTelemetry propagators API: <https://opentelemetry.io/docs/specs/otel/context/api-propagators/>
- OpenTelemetry baggage guidance: <https://opentelemetry.io/docs/concepts/signals/baggage/>
