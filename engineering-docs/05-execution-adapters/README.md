# 05. Execution Adapters

Status note:

- this document captures the wider adapter design, not the audited launch surface
- launch-real adapters today are `filesystem`, `shell`, and owned `function` integrations
- browser/computer and generic governed HTTP adapters are not shipped runtime surfaces today

## Working Thesis

Execution Adapters should be thin, trusted runtimes that turn approved actions into real-world execution plus structured evidence.

That means each adapter should:

- accept a normalized `Action`
- enforce the `PolicyOutcome` preconditions
- honor snapshot requirements before mutating state
- execute through a controlled boundary
- emit a typed `ExecutionResult`
- attach artifacts that support replay, debugging, and recovery

The adapter should not re-decide policy.
It should faithfully execute the approved plan and record what actually happened.

## Why This Matters

If adapters are too thin:

- we lose evidence about what actually happened
- rollback gets weaker
- timeline quality collapses

If adapters are too smart:

- policy logic gets duplicated
- behavior diverges across tool types
- developers cannot reason about where decisions are happening

So the right design is:

**policy decides, adapters enforce and execute, artifacts explain**

## Research-Driven Design Constraints

### Execution often happens outside the model, even when the model requests it

OpenAI Agents SDK and Anthropic bash/tool docs both reinforce the same architecture:

- the model requests a tool call
- the application or runtime performs the actual work
- tool output is then returned to the model

Design implication:

- adapters are the concrete execution boundary
- they must be trustworthy even if the tool request came from a model

### Built-in tool guardrails are not universal

OpenAI’s official guardrails docs explicitly say built-in execution tools and hosted tools do not use the same tool-guardrail pipeline as function tools.

Design implication:

- adapters must consume our own policy outputs directly
- execution-time enforcement cannot rely on upstream guardrail coverage

### Structured tool results matter

MCP tools support:

- `structuredContent`
- `outputSchema`
- actionable tool execution errors via `isError`

Design implication:

- adapters should emit results in a way that preserves structured outputs where possible
- execution errors should be distinguished from protocol or infrastructure failures

Launch note:

- the current runtime owns a real governed MCP proxy slice for operator-managed servers over `stdio` and `streamable_http`
- launch scope today is durable registry-backed operator management, durable local encrypted MCP bearer-secret storage, explicit public host allowlist policy, CLI/SDK/daemon registration flows plus first-class CLI MCP tool submission, `tools/list`, `tools/call`, tool-list cache validation, approval-first mutation policy, explicit `streamable_http` network scope (`loopback`, `private`, or `public_https`), and per-server concurrency limits
- hosted MCP execution and arbitrary remote MCP registration from agent or user input remain out of launch truth until built

### Runtime tools can produce rich artifacts

OpenAI computer-use tooling and Anthropic bash tooling show that runtime tools often naturally produce:

- stdout/stderr
- screenshots
- diffs
- ordered action lists
- stateful session outputs

Design implication:

- artifact capture should be a first-class adapter concern
- artifacts should be typed and linked to execution spans

### Tracing should follow standard span/event semantics

OpenTelemetry guidance is clear:

- spans represent operations
- events represent significant timed occurrences
- exceptions should be recorded explicitly when errors escape

Design implication:

- each adapter execution should produce a span or span-like record
- artifacts and failures should be attached using standard-ish semantics where possible

## Product Role

Execution adapters are the last trusted step before side effects happen.

They translate:

- approved actions
- snapshot preconditions
- brokered credentials
- runtime environment constraints

into:

- actual execution
- structured result
- typed artifacts
- execution telemetry

## Non-Goals

- Recompute policy decisions
- Hide side effects behind generic success/failure booleans
- Make every adapter return the same raw payload shape
- Promise exact rollback from execution results alone

## Core Adapter Contract

Each adapter should implement a common contract.

### Inputs

- `Action`
- `PolicyOutcome`
- optional `SnapshotRecord`
- brokered credential handles or injected runtime credentials
- execution context:
  - cwd
  - roots
  - network constraints
  - timeouts
  - session info

### Outputs

- `ExecutionResult`
- artifact references
- execution span metadata
- partial completion metadata if applicable

## ExecutionResult Shape

Recommended core shape:

```json
{
  "execution_result_id": "exec_01H...",
  "action_id": "act_01H...",
  "adapter_kind": "shell",
  "status": "completed",
  "started_at": "2026-03-29T17:10:00Z",
  "completed_at": "2026-03-29T17:10:03Z",
  "outcome": {
    "result_type": "success",
    "message": "Shell command completed"
  },
  "tool_result": {
    "content": [
      {
        "type": "text",
        "text": "..."
      }
    ],
    "structured_content": null,
    "is_error": false
  },
  "artifacts": [
    {
      "artifact_id": "art_01H...",
      "type": "stdout",
      "ref": "blob_01H..."
    }
  ],
  "resource_usage": {
    "duration_ms": 3012,
    "bytes_written": 1024,
    "network_requests": 0
  },
  "execution_trace": {
    "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
    "span_id": "aa01bb02cc03dd04"
  }
}
```

## Status Model

Recommended statuses:

- `completed`
- `failed`
- `timed_out`
- `cancelled`
- `blocked`
- `partial`

### `blocked`

Use when the adapter refuses execution because a required precondition was not satisfied.

Examples:

- snapshot missing
- brokered credentials required but unavailable
- governed path required but runtime is unsafely degraded

### `partial`

Use when side effects have already happened, but the adapter failed before clean completion.

Examples:

- batch shell script wrote some files then timed out
- browser action clicked and navigated but screenshot capture failed
- API batch call partially succeeded

This is important for honest recovery.

## Precondition Enforcement

Adapters must validate that policy requirements are satisfied before execution begins.

### Required checks

- `PolicyOutcome` decision allows execution
- snapshot exists if `snapshot_required = true`
- approval is resolved if `approval_required = true`
- credential mode satisfies trust requirements
- execution surface matches the claimed governed path
- timeout and resource limits are initialized

If any of these fail, return `blocked` and emit a journal event.

## Credential Handling

Adapters should be the place where owned integrations receive usable credentials.

### Launch rule

If policy requires brokered credentials:

- the adapter requests a runtime credential handle
- the adapter injects or delegates it to the integration
- the adapter never returns the raw secret to the agent

### Supported modes

- `brokered`
  - adapter receives scoped ephemeral credentials or signed requests
- `delegated`
  - adapter gets a handle to call another brokered service
- `direct`
  - adapter uses directly supplied credentials only if policy explicitly allows it
- `none`
  - no credential material needed

### Evidence rule

The adapter should record:

- credential mode used
- broker ID or credential handle ID if safe
- scopes or policy labels if safe

It should not record raw secrets.

## Artifact Model

Artifacts should be typed, content-addressed where possible, and separately retrievable.

### Launch artifact types

- `stdout`
- `stderr`
- `file_diff`
- `file_preimage_ref`
- `file_postimage_ref`
- `screenshot`
- `dom_snapshot`
- `http_request_summary`
- `http_response_summary`
- `tool_output_text`
- `structured_output`
- `error_report`

### Artifact principles

- large artifact payloads should live outside the main result record
- artifact metadata should be enough to render a timeline or replay step
- artifacts should declare whether they are user-visible, model-visible, or internal

## Adapter Types

## 1. Filesystem Adapter

Purpose:

- execute direct governed file mutations

Typical operations:

- write file
- update file
- move file
- delete file
- mkdir

Strengths:

- precise scope
- precise recovery support
- strong artifact capture

Expected artifacts:

- file diffs
- pre/post image refs
- changed path list

## 2. Shell Adapter

Purpose:

- execute approved shell commands in a governed runtime

Challenges:

- command scope may be uncertain
- subprocess behavior can exceed initial intent
- persistent sessions can accumulate state

Adapter requirements:

- explicit cwd and environment handling
- timeout enforcement
- stdout/stderr capture
- exit code capture
- changed-path detection after execution
- session state handling if persistent shell is used

Expected artifacts:

- stdout/stderr
- exit status
- changed path manifest delta
- optional command transcript

### Shell session model

Support two modes:

- `ephemeral`
  - one command per execution boundary
- `persistent`
  - session state retained across actions

Persistent sessions are useful, but they increase replay and rollback complexity. Launch should default to ephemeral unless the agent integration clearly benefits from persistence.

## 3. Apply-Patch Adapter

Purpose:

- execute structured patch operations where the patch grammar is explicit

Why separate from generic filesystem adapter:

- patch semantics are richer than arbitrary write calls
- diff and rollback artifacts are naturally first-class

Expected artifacts:

- patch input
- applied diff
- per-file status
- conflict diagnostics

## 4. Browser / Computer Adapter

Purpose:

- execute governed browser/computer actions

Challenges:

- UI state is volatile
- actions often need screenshots for replay
- a single model request may contain batched actions

Adapter requirements:

- execute ordered actions deterministically
- evaluate per-action preconditions when batching is supported
- capture final screenshot and optional intermediate screenshots
- record origin, URL, and navigation result

Expected artifacts:

- screenshot
- URL/origin timeline
- action transcript
- DOM or accessibility snapshot where available

### Batching rule

If the upstream framework emits multiple ordered browser actions in one call:

- the adapter should preserve the batch as one execution boundary
- but record per-subaction evidence where available

## 5. MCP Proxy Adapter

Purpose:

- forward approved MCP calls to upstream servers while preserving governance

Launch-owned scope today:

- operator-owned server registry only
- `stdio` and `streamable_http` transports
- upstream `tools/list`
- upstream `tools/call`
- explicit read-only allowlist or approval-required mutation policy
- direct credential passthrough forbidden

Not in launch scope yet:

- hosted MCP execution
- arbitrary model-supplied or user-supplied upstream server definitions

Responsibilities:

- validate upstream server identity and connection mode
- forward `tools/call`
- preserve request/response IDs
- validate `structuredContent` against `outputSchema` when available
- distinguish protocol errors from tool execution errors

Expected artifacts:

- upstream server identity
- call payload summary
- structured output summary
- `isError` details if present

This adapter is strategically important because it extends our control plane into broader ecosystems without requiring every server to adopt our SDK.

## 6. HTTP / API Adapter

Purpose:

- execute governed external API calls for owned integrations

Requirements:

- inject brokered credentials
- capture request summary without leaking secrets
- capture response status and shape
- support idempotency keys where relevant

Expected artifacts:

- sanitized request summary
- status code
- response summary
- remote object identifiers if created

## Output Normalization

Adapters should return tool outputs in the shape expected by their upstream host, but also emit a normalized internal form.

This means two layers:

- `tool_result`
  - what goes back to the agent framework
- `ExecutionResult`
  - what goes to the journal, timeline, and recovery engine

Do not force every tool surface into a plain string if structured output exists.

## Error Model

Adapters should distinguish at least three failure classes:

### 1. Precondition failure

Execution never started because the adapter refused.

Examples:

- missing snapshot
- approval unresolved
- credential broker unavailable

### 2. Execution failure

Execution started and the operation failed.

Examples:

- nonzero shell exit
- MCP tool returned `isError: true`
- HTTP 500 from external API

### 3. Adapter failure

The adapter itself malfunctioned.

Examples:

- artifact capture crashed
- screenshot serialization failed
- transport to local authority daemon broke mid-run

These should have different reason codes and recovery implications.

## Observability

Each adapter invocation should map cleanly to a span-like execution record.

Recommended span attributes:

- `authority.action_id`
- `authority.adapter_kind`
- `authority.execution_surface`
- `authority.credential_mode`
- `authority.result_status`
- domain-specific attributes:
  - shell command hash
  - file path count
  - browser origin
  - HTTP method/status

Recommended events:

- `execution.started`
- `artifact.captured`
- `execution.partial`
- `exception`
- `execution.completed`

## Runtime Isolation And Constraints

Adapters should expose runtime knobs, even if the first launch only uses a subset:

- timeout
- memory limit where applicable
- network policy
- writable roots
- environment variable allowlist
- persistent session toggle

The key is that the adapter should be able to prove which constraints were actually applied.

## Interaction With Other Subsystems

### Snapshot Engine

Receives:

- changed-path evidence
- post-execution scope refinement

Depends on:

- snapshot preconditions being satisfied before execution

### Recovery Engine

Consumes:

- artifacts
- partial completion info
- external object identifiers

### Timeline / Helper

Consumes:

- normalized execution result
- user-visible artifacts
- explanation-ready error classes

## Main Risks

### 1. Adapter drift

If each adapter invents its own lifecycle shape, the product fragments.

Mitigation:

- one common contract
- one normalized result format
- typed domain artifacts only under a shared envelope

### 2. Artifact overload

Capturing everything can destroy performance and storage.

Mitigation:

- typed artifact budget
- visibility levels
- large payloads stored by reference
- timeline/helper responses should expose when inline preview budget truncated or omitted artifacts
- stored artifact refs should remain fetchable by durable `artifact_id`

### 3. Hidden side effects

Adapters may execute more than the user expects, especially shell and browser.

Mitigation:

- capture post-execution deltas
- preserve exact command/action transcript
- report partial outcomes honestly

### 4. Credential leakage

Adapters are a natural leak point if not designed carefully.

Mitigation:

- brokered credentials by default
- redacted request/response summaries
- no secret egress in artifacts

## Proposed Build Order

1. Define `ExecutionResult` and artifact envelope schemas
2. Implement filesystem adapter
3. Implement shell adapter with stdout/stderr, exit codes, and changed-path capture
4. Implement apply-patch adapter
5. Implement MCP proxy adapter
6. Implement browser/computer adapter
7. Implement HTTP/API adapter with brokered credential injection
8. Add richer span/event instrumentation and artifact budgeting

## Concrete Recommendation

For launch, execution adapters should optimize for one thing:

**be the trustworthy place where approved actions actually happen, and leave behind enough structured evidence that policy, recovery, and timeline never have to guess**

That is what makes the rest of the control plane believable.

## Research Inputs

- OpenAI Agents tools guide: <https://openai.github.io/openai-agents-python/tools/>
- OpenAI Agents JS tools guide: <https://openai.github.io/openai-agents-js/guides/tools/>
- OpenAI Agents guardrails: <https://openai.github.io/openai-agents-python/guardrails/>
- OpenAI Agents JS results: <https://openai.github.io/openai-agents-js/guides/results/>
- OpenAI Agents MCP guide: <https://openai.github.io/openai-agents-js/guides/mcp/>
- MCP tools specification: <https://modelcontextprotocol.io/specification/draft/server/tools>
- Anthropic bash tool: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/bash-tool>
- Claude Code SDK docs: <https://code.claude.com/docs/en/sdk>
- Claude Code MCP docs: <https://code.claude.com/docs/en/mcp>
- OpenTelemetry trace API: <https://opentelemetry.io/docs/specs/otel/trace/api>
- OpenTelemetry trace semantic conventions: <https://opentelemetry.io/docs/specs/semconv/general/trace/>
- OpenTelemetry exceptions: <https://opentelemetry.io/docs/specs/otel/trace/exceptions/>
