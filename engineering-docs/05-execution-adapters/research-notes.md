# Research Notes

## Scope

This note captures the external research used to shape the first plan for the Execution Adapters subsystem.

Research date:

- March 29, 2026

## Key Findings

### 1. Real execution almost always happens outside the model

OpenAI Agents and Anthropic tool-use docs both describe the same pattern:

- the model decides to call a tool
- the host application or runtime executes it
- the result is returned to the model

Design implication:

- adapters are the true side-effecting boundary
- they must be treated as trusted runtime components

### 2. Framework guardrails do not cover every execution surface

OpenAI explicitly documents that built-in execution tools and hosted tools do not use the normal function-tool guardrail pipeline.

Design implication:

- execution adapters must enforce our `PolicyOutcome` directly
- we cannot rely on upstream framework safety hooks

### 3. Tool outputs should preserve structure when available

MCP tools can return `structuredContent`, `outputSchema`, and actionable `isError` execution failures.

Design implication:

- adapters should preserve structured outputs for internal recording and upstream tool results
- execution failures should be distinguishable from protocol or transport failures

### 4. Artifact capture is part of execution, not just observability

OpenAI computer-use and Anthropic bash tooling naturally produce:

- screenshots
- stdout/stderr
- ordered action traces
- persistent session context

Design implication:

- adapters should emit typed artifacts as part of their core contract

### 5. Standard tracing maps well onto adapter execution

OpenTelemetry guidance reinforces that:

- spans are operations
- events are time-significant occurrences
- exceptions should be captured explicitly when errors escape

Design implication:

- adapter execution should emit span-like records with typed attributes and error semantics

## Source Notes

### OpenAI

- Agents tools guide
  - Confirms the split between hosted tools, local runtime tools, function tools, and MCP integrations.
  - <https://openai.github.io/openai-agents-python/tools/>

- Agents JS tools guide
  - Documents built-in execution tools, browser action batching, and execution ordering.
  - <https://openai.github.io/openai-agents-js/guides/tools/>

- Agents guardrails
  - Explicitly states built-in execution tools and hosted tools do not use the same guardrail pipeline as function tools.
  - <https://openai.github.io/openai-agents-python/guardrails/>

- Agents JS results
  - Reinforces separate result surfaces, interruptions, state, and new items.
  - <https://openai.github.io/openai-agents-js/guides/results/>

- Agents MCP guide
  - Shows hosted MCP as another execution path and streaming result surface.
  - <https://openai.github.io/openai-agents-js/guides/mcp/>

### Model Context Protocol

- Tools spec
  - Structured outputs, `outputSchema`, and `isError` execution semantics are especially relevant.
  - <https://modelcontextprotocol.io/specification/draft/server/tools>

### Anthropic / Claude

- Bash tool
  - Confirms a persistent shell session model and stdout/stderr-style output loop.
  - <https://platform.claude.com/docs/en/agents-and-tools/tool-use/bash-tool>

- Claude Code SDK / MCP docs
  - Confirms MCP clients remain responsible for user confirmation and that tool outputs may need explicit limits.
  - <https://code.claude.com/docs/en/sdk>
  - <https://code.claude.com/docs/en/mcp>

### OpenTelemetry

- Trace API
  - Spans should carry attributes, events, status, and links.
  - <https://opentelemetry.io/docs/specs/otel/trace/api>

- Trace semantic conventions
  - Standard naming and semantic fields help polyglot correlation.
  - <https://opentelemetry.io/docs/specs/semconv/general/trace/>

- Exceptions
  - Unhandled exceptions should be recorded explicitly.
  - <https://opentelemetry.io/docs/specs/otel/trace/exceptions/>

## Resulting Recommendation

Execution adapters should be:

- thin on policy
- strong on precondition enforcement
- rich in artifact capture
- explicit about partial outcomes
- careful with brokered credentials
- aligned to a common normalized execution-result shape
