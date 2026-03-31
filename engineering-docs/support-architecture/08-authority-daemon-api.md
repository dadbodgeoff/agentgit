# 08. Authority Daemon API

## Working Thesis

The authority daemon API should be the single local contract through which SDKs, CLI tools, and local UI surfaces interact with the control plane.

That means:

- one local IPC boundary
- one coherent request/response model
- explicit streaming where long-running work needs it
- canonical record schemas reused across the boundary where possible

The daemon API is not just an implementation detail.
It is the seam that keeps the whole local-first system coherent.

## Why This Matters

If the daemon API is vague:

- SDKs drift
- CLI and UI behavior diverge
- testing gets harder
- future hosted sync or worker separation becomes messy

If it is too overdesigned:

- launch gets bogged down in transport abstractions
- implementation becomes slower than the product needs

So the right launch contract is:

**small, local, versioned, schema-backed, and biased toward a single authority process**

## Design Goals

- local-first only
- transport-agnostic but IPC-oriented
- versioned
- idempotent where retries are plausible
- compatible with future out-of-process workers
- grounded in the existing canonical schemas

## Non-Goals

- Public internet API design
- Multi-tenant hosted API design
- Long-term remote auth protocol
- General plugin RPC for arbitrary third parties at launch

## Transport Model

### Launch recommendation

Use:

- Unix domain sockets on macOS/Linux
- named pipes on Windows later

The wire protocol can be simple framed JSON messages.

### Why framed JSON

- easy for TypeScript and Python SDKs
- easy to inspect while debugging
- works well with the JSON Schema pack
- sufficient for launch IPC

If needed later:

- the same logical API can be mapped to gRPC, HTTP-over-localhost, or another transport
- but the logical method contract should stay stable

## API Versioning

The daemon should expose:

- `api_version`
- `schema_pack_version`
- `runtime_version`

Launch recommendation:

- `api_version = authority.v1`

Breaking changes:

- require a new API version
- do not silently reinterpret old requests

## Session Model

Clients should establish a lightweight local session with the daemon.

Session purposes:

- identify client type
- negotiate API version
- attach workspace and runtime context
- provide diagnostics and tracing context

### Client types

- `sdk_ts`
- `sdk_py`
- `cli`
- `ui`
- `worker`

## Connection Handshake

### Step 1. Connect

Client opens local IPC channel.

### Step 2. Hello

Client sends:

- requested API version
- client type
- client version
- optional workspace roots

### Step 3. Server capabilities

Daemon responds with:

- accepted API version
- runtime version
- schema pack version
- capability summary
- session ID

This gives us a simple, explicit local compatibility handshake.

## Message Envelope

Use one shared envelope shape for requests and responses.

### Request envelope

```json
{
  "api_version": "authority.v1",
  "request_id": "req_01H...",
  "session_id": "sess_01H...",
  "method": "submit_action_attempt",
  "idempotency_key": "idem_01H...",
  "trace": {
    "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
    "span_id": "00f067aa0ba902b7"
  },
  "payload": {}
}
```

### Response envelope

```json
{
  "api_version": "authority.v1",
  "request_id": "req_01H...",
  "session_id": "sess_01H...",
  "ok": true,
  "result": {},
  "error": null
}
```

### Streaming event envelope

```json
{
  "api_version": "authority.v1",
  "session_id": "sess_01H...",
  "stream_id": "stream_01H...",
  "event_type": "execution.progress",
  "payload": {}
}
```

## Core Methods

The launch surface should cover the core local workflows and nothing more.

## 1. `hello`

Purpose:

- negotiate compatibility
- create session

Request payload:

- `client_type`
- `client_version`
- `requested_api_version`
- `workspace_roots`

Response payload:

- `session_id`
- `accepted_api_version`
- `runtime_version`
- `schema_pack_version`
- `capabilities`

## 2. `register_run`

Purpose:

- register a new governed run with the daemon

Request payload:

- `workflow_name`
- `agent_framework`
- `agent_name`
- `workspace_roots`
- `client_metadata`

Response payload:

- `run_id`
- `run_handle`
- `effective_policy_profile`

## 3. `submit_action_attempt`

Purpose:

- send a raw governed attempt into the full action pipeline

Request payload:

- `run_id`
- `tool_registration`
- `raw_call`
- `environment_context`
- `framework_context`

Response payload:

- `action`
- `policy_outcome`
- optional `snapshot_record`
- optional `execution_result`
- `terminal_state`

### Notes

This is the most important method in the whole daemon.

It may produce:

- immediate completion
- immediate deny/block
- an approval-required response
- a stream handle for long-running execution

Launch response note:

- when a response includes an approval record, it should also include a structured `primary_reason`
  derived from the first policy reason so operators can explain the gate without reparsing the full policy trace

Launch note:

- launch-owned policy should consume fresh cached capability state where automatic execution depends on that capability
- for brokered ticket mutations, stale or unavailable cached capability state should stop automatic execution and require refresh or explicit approval
- for governed filesystem mutations and snapshot-backed mutating shell commands, stale or degraded cached workspace/runtime capability state should stop automatic execution and require refresh or explicit approval
- recovery planning and execution should consume the same cached workspace/runtime capability state and degrade snapshot-backed restore to `review_only` when that guarantee boundary is stale, unavailable, or incomplete

If the daemon restarts after snapshot creation or execution start but before a terminal execution event is durably journaled, the authority process should append `execution.outcome_unknown` during startup reconciliation. The API should surface that uncertainty explicitly instead of collapsing it into a synthetic failure result.

## 4. `resolve_approval`

Purpose:

- resolve a pending approval task

Request payload:

- `approval_id`
- `decision`
  - `approved`
  - `rejected`
- `sticky_scope` optional
- `actor_metadata`

Response payload:

- `approval_record`
- affected `run_id`
- resume status

Launch response note:

- approval records and inbox views should include a structured `primary_reason`
  copied from the stored policy outcome so approval UIs can show the dominant gate reason consistently

## 5. `query_timeline`

Purpose:

- retrieve projected timeline data for a run

Request payload:

- `run_id`
- optional `step_id`
- optional filters:
  - provenance
  - status
  - reversibility

Response payload:

- `run_summary`
- `steps`
  - array of `TimelineStep`
- `projection_status`

## 6. `query_helper`

Purpose:

- answer grounded helper questions over a run

Request payload:

- `run_id`
- `question_type`
- structured parameters

### Launch `question_type` values

- `what_happened`
- `what_changed_after`
- `likely_cause`
- `revert_impact`
- `external_effects`
- `run_summary`
- `why_blocked`
- `reversible_steps`

Response payload:

- `answer`
- `confidence`
- optional structured `primary_reason`
- `evidence`
- `uncertainty`

Launch note:

- helper answers for focused policy or blocked-state questions should preserve the dominant recorded reason in machine-readable form instead of forcing callers to parse warning prose

## 7. `plan_recovery`

Purpose:

- compute a `RecoveryPlan` without executing it

Request payload:

- target selector
  - `action_id`
  - `snapshot_id`
  - `path_subset`
  - `run_checkpoint`
- `mode`
  - `surgical`
  - `boundary_exact`

Response payload:

- `recovery_plan`
- `impact_preview`
- `conflicts`

Launch note:

- snapshot-backed recovery should consume cached workspace/runtime capability state and return `review_only` instead of promising automatic restore when that state is stale, unavailable, or incomplete

## 8. `execute_recovery`

Purpose:

- execute a previously planned recovery

Request payload:

- `recovery_plan_id`
- optional `approval_context`

Response payload:

- initial recovery status
- optional stream handle

Launch note:

- if snapshot-backed recovery degrades to `review_only` because cached capability state is stale, unavailable, or incomplete, execution should fail closed with `PRECONDITION_FAILED` instead of attempting restore anyway

## 9. `run_maintenance`

Purpose:

- trigger one or more maintenance jobs explicitly

Request payload:

- `job_types`
- `priority_override` optional
- `scope`

Response payload:

- per-job results
- stream handle optional

Launch note:

- the daemon may execute small owned maintenance jobs inline and return terminal results immediately
- launch-owned inline jobs currently include `startup_reconcile_runs`, `startup_reconcile_recoveries`, WAL checkpointing, snapshot garbage collection, snapshot compaction, synthetic-anchor rebasing, artifact expiry, artifact orphan cleanup, projection refresh/rebuild confirmation, `capability_refresh`, and `helper_fact_warm`
- `capability_refresh` should refresh and durably cache the latest detected capability snapshot for diagnostics and policy use
- `helper_fact_warm` should warm exact helper answers against the current journal state and artifact-health digest, and those cached answers should be invalidated when run events or durable artifact evidence drift
- unsupported documented job types should return explicit per-job `not_supported` results if future documented jobs outpace launch ownership
- do not fabricate a background queue or stream if no scheduler owns that work yet

## 10. `get_capabilities`

Purpose:

- retrieve detected host/workspace capability state

Request payload:

- optional `workspace_root`

Response payload:

- capability records
- detection timestamps
- degraded-mode warnings

Launch note:

- return only capability records the daemon can detect from owned runtime state at request time
- current launch detection should cover local runtime storage, credential broker mode, owned ticket credential configuration, and optional workspace root access
- if a capability is only partially supported at launch, mark it `degraded` instead of fabricating stronger guarantees

## 11. `diagnostics`

Purpose:

- inspect health, backlog, and runtime state

Request payload:

- requested sections

Response payload:

- daemon health
- journal health
- maintenance backlog
- projection lag
- storage summary
- capability summary

Launch note:

- return only sections the daemon can prove from owned runtime state
- use `null` or zero values for queue-heavy fields the launch runtime does not yet track durably
- diagnostics should surface the latest durably refreshed capability warnings when that cache exists
- capability freshness should be governed by an explicit runtime threshold rather than an undocumented hardcoded assumption
- do not fabricate maintenance jobs or compaction debt if no scheduler owns them yet
- each non-null section should expose an optional structured `primary_reason` so operators can distinguish
  dominant causes like pending approvals, stale capability state, degraded artifact capture, or low-disk pressure
  without having to parse warning strings

## Request/Response Patterns

The daemon should support three interaction styles.

### 1. Unary

For:

- `hello`
- `register_run`
- `get_capabilities`
- most `query_timeline`
- most `query_helper`

### 2. Unary with deferred side effects

For:

- `run_maintenance`
- `plan_recovery`

These return quickly but may enqueue durable work.

### 3. Unary plus stream

For:

- long-running action execution
- browser/computer operations
- recovery execution
- projection rebuild
- maintenance jobs

The initiating method returns:

- accepted state
- `stream_id`

and progress is sent on the stream channel.

## Streaming Event Types

Recommended launch stream events:

- `execution.progress`
- `execution.completed`
- `execution.failed`
- `approval.required`
- `recovery.progress`
- `recovery.completed`
- `maintenance.progress`
- `maintenance.completed`
- `projection.progress`
- `diagnostic.notice`

## Idempotency

The daemon should accept optional `idempotency_key` on mutating requests.

Especially useful for:

- `register_run`
- `submit_action_attempt`
- `resolve_approval`
- `execute_recovery`
- `run_maintenance`

Launch rule:

- if a duplicate mutating request arrives with the same session and idempotency key, return the existing terminal or accepted result if safe
- if the same session and idempotency key are reused with a different method or payload fingerprint, fail closed with a precondition error
- if the original request is still in progress, fail closed with a retryable precondition error rather than double-executing side effects

This helps with client retries after local IPC interruption.

## Error Model

Errors should be typed and explicit.

### Error envelope

```json
{
  "code": "PRECONDITION_FAILED",
  "message": "Snapshot required before execution but no snapshot record was found.",
  "details": {
    "action_id": "act_01H..."
  }
}
```

### Launch error codes

- `BAD_REQUEST`
- `UNSUPPORTED_API_VERSION`
- `SESSION_NOT_FOUND`
- `RUN_NOT_FOUND`
- `APPROVAL_NOT_FOUND`
- `RECOVERY_PLAN_NOT_FOUND`
- `PRECONDITION_FAILED`
- `POLICY_BLOCKED`
- `CAPABILITY_UNAVAILABLE`
- `BROKER_UNAVAILABLE`
- `STORAGE_UNAVAILABLE`
- `PROJECTION_STALE`
- `INTERNAL_ERROR`

### Important distinction

Daemon API errors are not the same as tool execution failures.

Examples:

- a shell command exiting nonzero should typically still be a successful daemon response containing an `ExecutionResult` with `status: failed`
- a missing journal or malformed request is a daemon API error

## Schema Mapping

The daemon API should reuse the schema pack as much as possible.

### Directly reused

- `Action`
- `PolicyOutcome`
- `SnapshotRecord`
- `ExecutionResult`
- `RecoveryPlan`
- `TimelineStep`

### Wrapped in method responses

- `RunEvent`
  - usually queried indirectly through projections or diagnostics

This keeps the daemon contract aligned with the rest of the architecture.

## Security And Trust Rules

### Local-only boundary

The daemon must not listen on a network-accessible interface by default.

### Client trust

At launch, the daemon can treat local clients as part of the same user trust domain, while still validating:

- session existence
- API version
- request shape

### Future hardening

Possible later additions:

- peer credential checks on Unix sockets
- signed local session tokens
- finer client permission segmentation

But the logical API should not depend on these being present at launch.

## Observability

Every daemon method should record:

- request start
- request completion
- result status
- linked run/action IDs where applicable

This gives us strong internal diagnostics without making the daemon surface itself noisy.

## Backward Compatibility Strategy

For launch:

- keep the method set small
- prefer additive fields over semantic widening
- version entire methods when behavior would materially change

Avoid:

- unstable “misc” endpoints
- raw internal debugging methods becoming part of the public local contract

## Recommended Implementation Order

1. `hello`
2. `register_run`
3. `submit_action_attempt`
4. `query_timeline`
5. `query_helper`
6. `plan_recovery`
7. `execute_recovery`
8. `get_capabilities`
9. `diagnostics`
10. `resolve_approval`
11. `run_maintenance`

## Launch Recommendation

For launch, the authority daemon API should be:

- local-only
- versioned
- schema-backed
- request/response first
- stream-capable where necessary
- centered on `submit_action_attempt` as the primary action gateway

That gives you a clean OSS/local-first surface now and a stable seam for future UI, worker, and hosted extensions later.
