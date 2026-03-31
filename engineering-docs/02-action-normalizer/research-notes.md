# Research Notes

## Scope

This note captures the external research used to shape the first plan for the Action Normalizer subsystem.

Research date:

- March 29, 2026

## Key Findings

### 1. MCP tool calls are already close to the boundary we need

The MCP tools spec defines a clear request/response boundary:

- `tools/call` requests have a stable tool name and arguments
- tool definitions carry `inputSchema`
- tool results can include structured content and `outputSchema`
- clients are told to treat annotations as untrusted unless the server is trusted

Design implication:

- a proxied MCP `tools/call` should map to exactly one normalized action
- server-provided hints should be preserved but labeled untrusted

### 2. JSON Schema 2020-12 is the right internal baseline

MCP defaults to 2020-12 when no explicit schema is provided, and current agent tooling is already aligned around JSON Schema-like tool arguments.

Design implication:

- define the canonical action model in JSON Schema 2020-12
- preserve source schema references and hashes when available

### 3. Tool calls need stable cross-system IDs

OpenAI tool-calling documentation shows a distinct tool call identity and argument payload shape, including `call_id`, `name`, and `arguments`.

Design implication:

- normalized actions should retain upstream call IDs for traceability
- the raw upstream request and the normalized action should be linkable without ambiguity

### 4. We should separate action descriptors from lifecycle events

OpenAI Agents SDK tracing and OpenTelemetry both reinforce the same pattern:

- there is a durable operation identity
- lifecycle is represented by spans/events around that identity

Design implication:

- the `Action` object should remain a stable descriptor
- policy outcomes, snapshots, execution results, and recovery attempts should be separate records keyed by `action_id`

### 5. Standard trace propagation is enough for correlation

W3C Trace Context and OpenTelemetry already define the interoperable fields needed for correlation across process and network boundaries.

Design implication:

- carry trace IDs and parent relationships in the action model
- do not invent a custom distributed-correlation format

### 6. Context propagation is not a safe place for secrets

OpenTelemetry baggage guidance is explicit that propagated baggage can be visible on the wire and should not carry credentials or other sensitive data.

Design implication:

- credentials must not be stored in action payloads or trace baggage
- normalized actions should only store redacted inputs, references, or stable fingerprints

## Source Notes

### Model Context Protocol

- Tools specification
  - Defines `inputSchema`, optional `outputSchema`, `tools/call`, structured content, and the trust model for annotations.
  - <https://modelcontextprotocol.io/specification/draft/server/tools>

### OpenAI

- Function calling guide
  - Tool call flow reinforces the distinction between tool request, application execution, and tool output.
  - <https://platform.openai.com/docs/guides/function-calling>

- Tools guide
  - Confirms the mixed tool ecosystem: function tools, remote MCP, built-in tools, shell, apply-patch, computer use.
  - <https://platform.openai.com/docs/guides/tools?api-mode=responses>

- Agents SDK tracing
  - Confirms that runs, tool calls, handoffs, and guardrails are all modeled as trace/span records rather than one flattened blob.
  - <https://openai.github.io/openai-agents-python/tracing/>

### JSON Schema

- Draft 2020-12
  - Current meta-schema and vocabulary baseline.
  - <https://json-schema.org/draft/2020-12>

### Trace Correlation

- W3C Trace Context
  - Standard `traceparent` and `tracestate` propagation format across boundaries.
  - <https://www.w3.org/TR/trace-context/>

- OpenTelemetry trace semantic conventions
  - Reinforces a stable operation + typed attributes model.
  - <https://opentelemetry.io/docs/specs/semconv/general/trace/>

- OpenTelemetry propagators API
  - Confirms standard propagation defaults around W3C Trace Context and Baggage.
  - <https://opentelemetry.io/docs/specs/otel/context/api-propagators/>

- OpenTelemetry baggage guidance
  - Explicit warning not to place sensitive values like API keys or credentials in propagated baggage.
  - <https://opentelemetry.io/docs/concepts/signals/baggage/>

## Resulting Recommendation

The Action Normalizer should emit a stable, JSON-Schema-defined `Action` descriptor with:

- honest provenance
- standard trace correlation
- explicit execution path
- secret-safe redacted inputs
- typed domain facets

The action descriptor should stay separate from downstream policy, snapshot, execution, and recovery records.
