# Pre-Code Specification Checklist

This document resolves the pre-code decisions that must be fixed before implementation.

Important note:
- Checked items in this file mean the specification decision is now defined.
- They do not necessarily mean code or example fixtures already exist.
- The expanded section-by-section specs live in [pre-code-specs/README.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/pre-code-specs/README.md).

---

## 1. FOUNDATIONAL DECISIONS

### Language and Runtime

- [x] Primary implementation language for the authority daemon: **TypeScript on Node.js 24.x Active LTS**
  Why:
  - best fit for npm OSS launch
  - strongest distribution path for dev-tool adoption
  - easiest first-party TS SDK story
  - good enough IPC / fs / SQLite ecosystem
  Validated baseline:
  - Node.js **24.14.0**

- [x] SDK wrapper strategy: **polyglot launch with first-party TypeScript SDK and Python SDK**
  Rule:
  - daemon stays canonical
  - SDKs stay thin
  - no business logic divergence across SDKs

- [x] Build system and monorepo tooling: **pnpm 10.33.x workspace + Turborepo 2.8.x**
  Layout target:
  - `packages/authority-daemon`
  - `packages/authority-sdk-ts`
  - `packages/authority-sdk-py`
  - `packages/schemas`
  - `packages/policy-engine`
  - `packages/snapshot-engine`
  - `packages/execution-adapters`

- [x] Minimum supported platform versions:
  - macOS: **14+**
  - Linux: **Ubuntu 22.04+ / Debian 12+ / equivalent modern distro with glibc and Node 24 support**
  - Windows: **not launch-critical; experimental later**

- [x] Dependency philosophy: **lean but pragmatic**
  Rule:
  - prefer battle-tested libraries for SQLite, TOML, JSON Schema validation, tracing
  - avoid heavy framework lock-in
  - avoid runtime dependency bloat for the daemon critical path

### Serialization and Wire Format

- [x] IPC serialization format: **framed JSON**
  Reason:
  - easiest cross-language launch choice
  - debuggable
  - aligns with JSON Schema pack

- [x] IPC interaction model: **request/response with explicit streaming/subscriptions for long-running work**

- [x] IPC envelope shape:
  - `api_version`
  - `request_id`
  - `session_id`
  - `method`
  - `idempotency_key` optional
  - `trace`
  - `payload`

- [x] Error envelope shape:
  - `code`
  - `error_class`
  - `message`
  - `details`
  - `retryable`

- [x] Standard error code registry for launch:
  - `BAD_REQUEST`
  - `VALIDATION_FAILED`
  - `NOT_FOUND`
  - `CONFLICT`
  - `TIMEOUT`
  - `PRECONDITION_FAILED`
  - `POLICY_BLOCKED`
  - `UPSTREAM_FAILURE`
  - `CAPABILITY_UNAVAILABLE`
  - `STORAGE_UNAVAILABLE`
  - `BROKER_UNAVAILABLE`
  - `INTERNAL_ERROR`

- [x] API versioning strategy: **envelope field**
  Field:
  - `api_version = authority.v1`

- [x] Backward compatibility policy:
  - support **one stable API version at launch**
  - additive fields allowed within a version
  - breaking behavior requires `authority.v2`

### ID Strategy

- [x] ID generation algorithm: **UUIDv7**
  Reason:
  - sortable by time
  - strong ecosystem support
  - low collision risk

- [x] ID prefixes per object type:
  - `run_`
  - `sess_`
  - `req_`
  - `act_`
  - `pol_`
  - `snap_`
  - `exec_`
  - `evt_`
  - `approval_`
  - `rcvplan_`
  - `rcv_`
  - `step_`
  - `job_`
  - `stream_`
  - `artifact_`

- [x] Collision handling: **detect and fail loudly**
  Rule:
  - collisions are treated as integrity faults
  - no silent regeneration after persistence boundary

- [x] ID ordering guarantee: **IDs are approximately creation-time sortable**
  Rule:
  - sequence numbers remain the authoritative intra-run order
  - UUIDv7 ordering is helpful but not sufficient for causality

---

## 2. INTER-SUBSYSTEM CONTRACTS

### Wrapper → Normalizer

- [x] Raw tool call envelope:
  - `run_id`
  - `session_id`
  - `workspace_id` optional
  - `tool_registration`
  - `raw_call`
  - `environment_context`
  - `framework_context`
  - `trace`
  - `received_at`

- [x] Wrapper-populated vs normalizer-inferred fields:
  Wrapper populates:
  - raw tool name/type
  - raw args/payload
  - run/session/workspace context
  - framework metadata
  - declared cwd/env metadata
  Normalizer infers:
  - canonical domain/kind
  - target/scope
  - risk hints
  - warnings
  - normalization confidence

- [x] Runtime context attachment:
  - `run_id` and `session_id` required
  - `workspace_id` optional but preferred
  - `workspace_roots` included in environment context

- [x] Wrapper cannot reach daemon behavior: **fail closed by default**
  Rules:
  - governed action surfaces fail with typed local error
  - non-governed observational helpers may optionally queue telemetry, but not side effects
  - default timeout: **2 seconds**

### Normalizer → Policy Engine

- [x] Policy request shape: **full `Action` by value**
  Reason:
  - avoids extra round-trips
  - keeps policy deterministic and self-contained

- [x] Pass by value vs by reference: **by value**

- [x] Policy evaluation timeout: **50ms soft target, 200ms hard timeout**
  Behavior:
  - on timeout, return `ask` if action is governable and risky
  - otherwise fail closed for side-effecting governed actions

- [x] Low normalization confidence behavior:
  - confidence `< 0.5` => add `LOW_NORMALIZATION_CONFIDENCE`
  - confidence `< 0.3` on mutating actions => treat as `ask` unless explicit safe rule allows
  - confidence never silently ignored by policy

### Policy Engine → Snapshot Engine

- [x] Snapshot request shape:
  - `action`
  - `policy_outcome`
  - capability summary
  - storage budget summary
  - current lineage metadata

- [x] Snapshot class selection owner: **snapshot engine decides from policy + capabilities + budgets**
  Policy may hint; snapshot engine makes final class selection.

- [x] Snapshot class selection algorithm:
  Inputs:
  - policy decision and reasons
  - action scope/risk/reversibility hints
  - platform capability state
  - path classification
  - storage pressure
  - current journal-chain depth
  Output:
  - `metadata_only`
  - `journal_only`
  - `journal_plus_anchor`
  - `exact_anchor`

- [x] Unavailable snapshot class behavior:
  - downgrade using fallback chain
  - add warning + lowered fidelity/confidence
  - if no acceptable class remains and policy required recoverability, return typed failure to coordinator

- [x] Snapshot fallback chain:
  - `exact_anchor` -> `journal_plus_anchor`
  - `journal_plus_anchor` -> `journal_only`
  - `journal_only` -> `metadata_only` only when policy allows review-only fallback
  - otherwise fail precondition

### Policy Engine → Execution Adapters

- [x] Execution request shape:
  - `action`
  - `policy_outcome`
  - `snapshot_record` optional
  - `credential_handles`
  - `execution_context`
  - `capabilities`

- [x] Precondition verification protocol:
  Adapters must verify:
  - decision permits execution
  - snapshot exists if required
  - approval resolved if required
  - credential mode satisfies trust requirements
  - execution surface matches governed path
  - timeout/resources configured

- [x] Precondition failure behavior:
  - adapter returns `ExecutionResult.status = blocked`
  - coordinator writes `execution.blocked`
  - no side effect may begin

### Execution Adapters → Journal

- [x] Event submission protocol: **synchronous append through daemon-owned journal service**

- [x] Transactional boundaries:
  - journal append for `execution.started` must complete before adapter is considered live
  - terminal result write is not atomic with side effects, but must happen immediately after adapter returns

- [x] Backpressure mechanism:
  - bounded in-memory event queue per in-flight action
  - if journal service cannot keep up, new side-effecting actions stop being admitted

- [x] Journal write failure after side effects behavior:
  - mark runtime degraded
  - write emergency recovery notice to fallback local diagnostic log
  - block further governed actions
  - require reconciliation on restart

### Journal → Recovery Engine

- [x] Journal query contract to recovery:
  - fetch run events by run and sequence range
  - fetch entity-linked event chains by `action_id`, `snapshot_id`, `execution_result_id`
  - fetch changed-path and artifact indexes

- [x] Recovery data access model: **pull**
  Reason:
  - recovery planning is query-driven
  - avoids unnecessary subscriptions at launch

### Journal → Timeline/Helper

- [x] Projection query API:
  - fetch run summary
  - fetch steps
  - fetch step details
  - fetch changed-path summaries
  - fetch external effect summaries
  - fetch recovery affordances

- [x] Projection freshness SLA:
  - active run timeline: **< 1 second lag**
  - helper fact cache for active run: **< 3 seconds lag**
  - cold historical projections: eventually consistent, rebuildable

- [x] Helper fact cache invalidation:
  - invalidate on new run event affecting same run
  - invalidate on recovery-plan creation/update
  - invalidate on approval resolution

### Recovery Engine → Execution Adapters

- [x] Recovery-generated action marking:
  - `framework_context.recovery = true`
  - `action.correlation.parent_action_id` or `recovery_plan_id` linked

- [x] Recovery actions policy path: **full policy evaluation by default**
  Exception:
  - exact local file restore may use a streamlined path only when policy explicitly allows

- [x] Adapter distinction for recovery:
  - adapter receives recovery metadata in execution context
  - still emits standard `ExecutionResult`

---

## 3. POLICY ENGINE SPECIFICATIONS

### Predicate Language

- [x] Predicate format: **structured JSON/TOML conditions with regex support as an operator, not a freeform DSL**

- [x] Predicate field vocabulary:
  - `action.operation.domain`
  - `action.operation.kind`
  - `action.execution_path.surface`
  - `action.execution_path.credential_mode`
  - `action.target.scope.breadth`
  - `action.target.primary.locator`
  - `action.risk_hints.*`
  - `action.facets.*`
  - `capabilities.*`
  - `budgets.*`
  - `context.workspace_id`

- [x] Supported operators:
  - `eq`
  - `neq`
  - `matches`
  - `contains`
  - `gt`
  - `gte`
  - `lt`
  - `lte`
  - `in`
  - `not_in`
  - `exists`

- [x] Predicate composition:
  - support `all`, `any`, `not`
  - max nesting depth: **5**

- [x] Example rules:
  - block `rm -rf /`
  - ask on `shell.exec` with `external_effects = network`
  - allow `filesystem.write` under approved roots when file size small
  - allow `read_only` commands in `shell.safe`
  - ask on untrusted MCP mutating tool
  - require snapshot for destructive workspace mutation
  - deny `email.send` in local-only restricted profile
  - ask on `browser.submit`
  - deny `credential_mode = direct` for owned integrations
  - allow trusted read-only MCP tools

- [x] Predicate validation:
  - validate at config load time
  - unknown field references fail config validation

### Rule Evaluation

- [x] Terminal rule meaning:
  - terminal rule produces a decision for the current phase and halts lower-priority rules in that phase

- [x] Same-priority conflict resolution:
  - source precedence first:
    - system defaults
    - safe mode compiled rules
    - user config
    - workspace config
    - runtime override
  - then explicit numeric priority
  - deny beats ask beats allow_with_snapshot beats simulate beats allow

- [x] Non-terminal rule accumulation:
  - allowed
  - may add tags/facts/reason hints for later phases

- [x] Short-circuit behavior:
  - yes, within each terminal phase

- [x] Rule debugging output:
  - matched rules
  - skipped rules
  - final phase winner
  - computed decision
  - reason codes

### Safe Modes

- [x] `filesystem.safe` small write threshold: **256 KB per file, max 20 touched files for automatic allow**

- [x] `shell.safe` read-only commands:
  - `ls`
  - `pwd`
  - `cat`
  - `head`
  - `tail`
  - `find`
  - `rg`
  - `git status`
  - `git diff`
  - `wc`
  Rule:
  - exact or normalized-safe subcommands only

- [x] `browser.safe` behavior:
  - allow navigation and inspection on approved origins
  - ask on submit/upload/download/auth entry
  - deny clearly blocked origins

- [x] `mcp.safe` behavior:
  - allow trusted read-only tools
  - ask on untrusted or mutating tools
  - require brokered credentials where configured

- [x] Safe mode compilation algorithm:
  - each safe mode expands into an ordered rule bundle with stable generated IDs
  - compiled bundle is inspectable in diagnostics

- [x] Safe modes composable:
  - yes, per domain

### Budgets

- [x] One side-effecting action definition:
  - any action with `side_effect_level != read_only` or external effect not `none`

- [x] Budget granularity:
  - runtime duration: per-run
  - token and spend: per-run and optional rolling window
  - side-effect count: per-run
  - approvals: per-run

- [x] Enforcement levels:
  - `informational`: log only
  - `soft_limit`: return `ask`
  - `hard_limit`: return `deny`

- [x] Exceeded mid-run behavior:
  - current action evaluated against current counters
  - if threshold crossed before action executes, apply configured enforcement immediately

- [x] Budget reset semantics:
  - run-scoped counters reset at run end
  - time-window counters reset on window boundary

### Approvals

- [x] Sticky scope enum:
  - `one_time`
  - `run_sticky`
  - `session_sticky`
  - `pattern_sticky`

- [x] Session meaning for sticky approvals:
  - daemon session bound to current authority process and local user profile

- [x] Approval expiration rules:
  - `one_time`: expires on use or run end
  - `run_sticky`: run end
  - `session_sticky`: daemon restart or explicit revoke
  - `pattern_sticky`: 24h default unless configured otherwise

- [x] Approval revocation mechanism:
  - yes
  - revocation appends a new approval state record and invalidates future matching uses

- [x] Approval storage location and durability:
  - canonical state in journal
  - fast lookup index in state/projection store

- [x] Approval task shape:
  - approval ID
  - action summary
  - risk and reason codes
  - provenance
  - reversibility class
  - options:
    - approve once
    - reject
    - approve for run/session/pattern when allowed

### Simulation

- [x] Dry-run support registration:
  - adapter capability flag per action kind

- [x] Simulation result shape:
  - standard `ExecutionResult` with
    - `status = completed`
    - `outcome.result_type = simulated`
    - simulation artifact references

- [x] Simulation requested but unsupported:
  - policy falls back to `ask` or `deny` depending on rule and risk

### Reason Codes

- [x] Full v1 reason-code registry categories:
  - trust
  - budget
  - scope
  - reversibility
  - safe-mode
  - capability
  - credential
  - externality
  Example codes:
  - `PATH_NOT_GOVERNED`
  - `LOW_NORMALIZATION_CONFIDENCE`
  - `DIRECT_CREDENTIALS_FORBIDDEN`
  - `TRUSTED_READONLY_ALLOWED`
  - `UNTRUSTED_SERVER_MUTATION`
  - `UNKNOWN_SCOPE_REQUIRES_APPROVAL`
  - `FS_DESTRUCTIVE_WORKSPACE_MUTATION`
  - `IRREVERSIBLE_EXTERNAL_COMMUNICATION`
  - `BUDGET_SOFT_LIMIT_REQUIRES_APPROVAL`
  - `BUDGET_HARD_LIMIT_EXCEEDED`
  - `SNAPSHOT_BACKEND_DEGRADED`
  - `CAPABILITY_UNAVAILABLE`

- [x] Reason code versioning:
  - new codes may be added in `v1`
  - existing code semantics cannot change without API/schema version bump

- [x] Severity levels:
  - `low`: informational or routine gating
  - `moderate`: meaningful risk, recoverable
  - `high`: strong trust/safety concern
  - `critical`: hard stop or severe irreversible risk

---

## 4. ACTION NORMALIZER SPECIFICATIONS

### Scope Inference

- [x] Shell scope inference algorithm:
  - static pattern analysis first
  - known command/subcommand matchers
  - path extraction where possible
  - conservative fallback to `unknown`

- [x] Filesystem scope inference:
  - exact path(s), glob, recursive, or unknown

- [x] Unknowable scope behavior:
  - if command is opaque like `python script.py`, default to `unknown` unless the wrapper provided stronger structured intent

- [x] `estimated_count` heuristic:
  - integer when concrete path count or expansion estimate is available
  - omitted/null when genuinely unknown

- [x] `unknowns` semantics:
  - array of unknown dimensions such as:
    - `scope`
    - `target_count`
    - `external_side_effects`

### Redaction

- [x] Secret detection algorithm:
  - known-format regexes first
  - env/header field-name heuristics
  - entropy-based fallback only for suspicious tokens above length threshold

- [x] Redaction candidates:
  - command args
  - env vars
  - request bodies
  - headers
  - browser form values

- [x] Redaction marker format:
  - `[REDACTED:<kind>]`
  Examples:
  - `[REDACTED:api_key]`
  - `[REDACTED:password]`

- [x] False positive handling:
  - allow explicit config allowlist by field name/pattern

- [x] Redacted value recoverability:
  - not recoverable from journaled/action records
  - raw secret may remain only in OS-native secret store when appropriate

### Mappers

- [x] Mapper interface:
  Input:
  - raw wrapper envelope
  Output:
  - canonical `Action`
  - warnings
  - normalization confidence
  Errors:
  - typed normalization error or no-match

- [x] Mapper registry:
  - explicit in-process registry keyed by matcher predicates

- [x] Mapper fallback behavior:
  - if no mapper matches, create minimal `Action` with `domain = system`, low confidence, `unknown` scope

- [x] Mapper versioning:
  - named versions like `shell/v1`
  - old and new versions may coexist in code; one default active mapper per domain at a time

- [x] v1 mapper specs:
  - `shell/v1`: parse command, cwd, env keys, scope heuristics, shell facet
  - `filesystem/v1`: explicit file ops and path list
  - `mcp/v1`: server metadata + `tools/call` + trust hints
  - `function/v1`: wrapped function name + args + schema hash
  - `browser/v1`: structured browser action list + URL/origin/selector hints

### Normalization Confidence

- [x] Confidence computation:
  Inputs:
  - explicit tool type confidence
  - target extraction success
  - scope certainty
  - mapper-specific parse success
  Output:
  - 0.0 to 1.0

- [x] Confidence thresholds:
  - `>= 0.8`: high
  - `0.5 - 0.79`: medium
  - `< 0.5`: low
  - `< 0.3`: effectively unknown for risky policy decisions

- [x] Low confidence propagation:
  - policy receives confidence + warnings as first-class inputs

### Warnings

- [x] Warning taxonomy:
  - `unknown_scope`
  - `partial_parse`
  - `untrusted_metadata`
  - `possible_secret_redacted`
  - `opaque_execution`
  - `capability_assumption`

- [x] Warning surfacing:
  - stored on `Action.normalization.warnings`
  - visible to policy
  - journaled through action event payloads

---

## 5. SNAPSHOT ENGINE SPECIFICATIONS

### Snapshot Class Definitions

- [x] `metadata_only` semantics:
  - captures manifest delta and context only
  - no exact automated restore guarantee

- [x] `journal_only` semantics:
  - captures reverse patches, preimages, structural file ops, manifest delta
  - supports strong surgical restore for protected paths

- [x] `journal_plus_anchor` semantics:
  - exact sparse anchor at chosen boundary plus downstream journals
  - default for broad/uncertain but recoverable local mutations

- [x] `exact_anchor` semantics:
  - strongest exact local restore boundary
  - CoW/native snapshot preferred
  - user-space full copy only as last resort and usually not on hot path

- [x] `fidelity` enum:
  - `metadata_only`
  - `review_only`
  - `partial_for_protected_paths`
  - `exact_for_protected_paths`
  - `exact_boundary`

### Manifest Format

- [x] Manifest serialization format: **SQLite row-backed metadata plus optional compact JSON export**

- [x] Manifest schema per entry:
  - `path`
  - `content_id`
  - `size`
  - `mtime`
  - `mode`
  - `file_type`
  - `classification`
  - `hash_algorithm`

- [x] Manifest diff format:
  - per-path status:
    - `added`
    - `modified`
    - `deleted`
    - `moved`
    - `metadata_changed`

- [x] Manifest storage location/indexing:
  - `data_root/snapshots/manifests/`
  - indexed by `manifest_id`, `workspace_id`, `parent_manifest_id`

### Reverse Patch Strategy

- [x] Preimage vs reverse patch threshold: **256 KB confirmed**

- [x] Patch stability definition:
  - patch applies cleanly against exact stored pre-change hash
  - text file only
  - patch size <= 80% of full preimage

- [x] Chunked preimage strategy:
  - for large files > 256 KB when patch unstable
  - coarse chunking, not fine CDC by default

- [x] Binary file behavior:
  - preimage or content-addressed blob
  - no text diff assumption

- [x] Patch format: **unified diff for text**

### Anchor Strategy

- [x] Anchor frequency heuristics:
  - synthesize anchor when journal chain > **50 actions**
  - or cumulative changed protected bytes > **128 MB**
  - or broad/unknown-scope destructive action arrives

- [x] Branch point detection:
  - explicit user checkpoint
  - approval boundary before major risky action
  - broad destructive shell action
  - recovery plan created off current lineage

- [x] Broad/unknown scope actions:
  - anchor required when recoverability promise depends on exact path recovery and scope cannot be narrowed safely

### Path Classification

- [x] Default classification rules:
  - `protected`: src, config, docs, prompts, migrations, user-created content
  - `derivable`: build output, caches, temp bundles, transpiled artifacts
  - `ephemeral`: temp files, swap files, scratch dirs
  - `ignored`: admin/user explicit ignore

- [x] `.gitignore` interaction:
  - hint only, not authority
  - ignored paths may still be `protected` if explicitly configured

- [x] User override mechanism:
  - central/workspace policy config with explicit path classification rules

- [x] Outside-workspace paths:
  - default to `unknown` or denied for governed mutation unless explicitly allowed

### Compaction and GC

- [x] Compaction triggers:
  - chain length > 50
  - pack fragmentation > 30%
  - snapshot storage exceeds 80% of local snapshot budget

- [x] Rebase algorithm:
  - materialize latest protected state into new anchor
  - repoint lineage
  - mark old journal segments GC-eligible after safety window

- [x] GC safety:
  - no deletion of any chain referenced by active recovery, active run, or active projection rebuild

- [x] Retention defaults:
  - active-run recent snapshots: 24h minimum
  - key anchors may persist longer under budget
  - metadata for expired snapshots remains in journal

### Integrity

- [x] Integrity verification strategy:
  - checksums for blobs and manifests
  - periodic sampled restore drills

- [x] Restore drill sampling:
  - risk-weighted + random
  - at least one drill per 100 significant snapshots or per day on active workspace

- [x] Integrity failure behavior:
  - quarantine affected snapshot lineage
  - mark confidence degraded
  - block exact-restore claims for affected lineage

---

## 6. EXECUTION ADAPTER SPECIFICATIONS

### Adapter Interface

- [x] Common adapter interface:
  Methods:
  - `canHandle(action): boolean`
  - `prepare(context): PreparedExecution`
  - `execute(prepared): ExecutionResult`
  - `cleanup(context): void`

- [x] Adapter registration/discovery:
  - explicit in-process registry at launch

- [x] Adapter selection algorithm:
  - match on `action.operation.domain` then `execution_path.surface`
  - tie-break by adapter priority

- [x] Adapter lifecycle:
  - mostly stateless per-call
  - persistent browser/shell sessions allowed through explicit adapter-managed session objects

### Per-Adapter Specs

- [x] Filesystem adapter:
  - supports write, overwrite, move, delete, mkdir
  - atomic rename where underlying fs supports it
  - symlinks never followed for protected-path mutation without explicit allow
  - preserve mode bits where practical

- [x] Shell adapter:
  - supports ephemeral first, persistent optional later
  - isolated cwd/env per execution context
  - hard timeout + signal escalation
  - captures exit code and changed-path evidence

- [x] Apply-patch adapter:
  - supports strict structured patch format
  - conflict => `failed` with diagnostics
  - partial apply not allowed unless explicitly returned as `partial`

- [x] Browser/computer adapter:
  - ordered batched actions allowed
  - final screenshot always attempted
  - DOM/a11y snapshot captured when available

- [x] MCP proxy adapter:
  - maps upstream tool/protocol errors separately
  - injects credentials at proxy boundary
  - passes through `structuredContent` when valid

- [x] HTTP/API adapter:
  - captures sanitized request/response summaries
  - retries only idempotent safe cases
  - follows redirects only when allowed by policy/integration config

### Shell Session Model

- [x] Ephemeral vs persistent semantics:
  - ephemeral: one action, isolated process tree, reset env/cwd
  - persistent: named shell context reused across actions, explicit session ID

- [x] Session state isolation:
  - cwd, env allowlist, shell options, temp files scoped per session

- [x] Session corruption detection:
  - shell exits unexpectedly
  - cwd escapes allowed roots
  - env invariants broken

- [x] Session timeout and cleanup:
  - idle persistent session timeout: **15 minutes**
  - force cleanup on daemon shutdown

### Artifact Capture

- [x] Artifact taxonomy:
  - `stdout`
  - `stderr`
  - `file_diff`
  - `request_summary`
  - `response_summary`
  - `screenshot`
  - `dom_snapshot`
  - `file_preimage_ref`
  - `file_postimage_ref`
  - `structured_output`
  - `error_report`

- [x] Artifact budget per adapter:
  - filesystem: 10 MB default per action
  - shell: 2 MB stdout + 2 MB stderr inline capture before truncation/ref
  - browser: 5 screenshots max per step, 25 MB total
  - HTTP/API: 256 KB structured summary cap

- [x] Budget overflow behavior:
  - truncate large text artifacts
  - retain digest/summary
  - never fail successful execution only because a noncritical artifact overflowed

- [x] Visibility levels:
  - `user`
  - `model`
  - `internal`

- [x] Visibility owner:
  - adapter sets default
  - policy/config may downgrade visibility

### Error Classification

- [x] Precondition taxonomy:
  - missing snapshot
  - invalid/missing approval
  - credential mode mismatch
  - capability unavailable
  - governed surface mismatch

- [x] Execution taxonomy:
  - timeout
  - permission denied
  - command not found
  - nonzero exit
  - upstream rejected
  - partial completion

- [x] Adapter taxonomy:
  - internal failure
  - transport failure
  - resource exhaustion
  - artifact capture failure

- [x] Partial execution detection:
  - compare pre/post manifests where possible
  - track adapter-side object creation IDs
  - mark `partial` when side effects occurred but terminal success did not

### Credential Injection

- [x] Credential request timing: **lazy per action**
  Exception:
  - persistent browser sessions may renew scoped session material on session start

- [x] Injection mechanisms by adapter:
  - shell: env var or temp file only when unavoidable
  - HTTP/API: in-memory header injection preferred
  - MCP proxy: proxy-managed upstream auth
  - browser: session/cookie/context injection
  - file-based creds: temp file ref with scoped lifetime only when unavoidable

- [x] Broker unavailable behavior:
  - adapter returns `blocked`
  - policy may later choose alternate degraded flow if configured

- [x] Expiry during execution:
  - if refreshable and adapter-integrated, refresh once
  - otherwise fail with typed auth error

---

## 7. JOURNAL SPECIFICATIONS

### Event Type Registry

- [x] Complete v1 event type enum:
  - `run.created`
  - `run.started`
  - `run.paused`
  - `run.resumed`
  - `run.completed`
  - `run.failed`
  - `run.cancelled`
  - `action.normalized`
  - `action.observed`
  - `action.imported`
  - `policy.evaluated`
  - `policy.blocked`
  - `policy.approval_requested`
  - `policy.approval_resolved`
  - `snapshot.created`
  - `snapshot.failed`
  - `snapshot.compacted`
  - `snapshot.rebased`
  - `snapshot.expired`
  - `execution.started`
  - `execution.completed`
  - `execution.failed`
  - `execution.partial`
  - `execution.blocked`
  - `execution.cancelled`
  - `artifact.recorded`
  - `artifact.redacted`
  - `artifact.expired`
  - `recovery.planned`
  - `recovery.started`
  - `recovery.completed`
  - `recovery.failed`
  - `recovery.step_started`
  - `recovery.step_completed`
  - `recovery.step_failed`
  - `analysis.summary_created`
  - `analysis.root_cause_suspected`
  - `annotation.user_note_added`
  - `annotation.system_note_added`
  - `run.recovered_after_crash`

- [x] Required payload schema per event type:
  - each event type has typed payload schema in code registry
  - `run-event.schema.json` covers envelope; per-type payload schema registry enforced at write time

- [x] Event type versioning strategy:
  - stable event type string + envelope `schema_version = run-event.v1`
  - payload schema evolution additive within v1

- [x] Event extensibility rules:
  - new event types may be added in v1 if consumers tolerate unknowns in non-critical views
  - projection code must explicitly opt in before showing a new type

### Ordering and Causality

- [x] Sequence vs occurred_at vs recorded_at:
  - `sequence`: authoritative run-local append order
  - `occurred_at`: real-world event time
  - `recorded_at`: journal commit time

- [x] Out-of-order events:
  - imported events may have earlier `occurred_at` and later `sequence`
  - timeline default uses `sequence`, detail views may expose both

- [x] Causal chain construction:
  - link by `action_id`
  - then `policy_outcome_id`
  - then `snapshot_id`
  - then `execution_result_id`
  - then recovery IDs

- [x] `parent_event_id` semantics:
  - direct logical predecessor for the same local chain, not arbitrary grouping

### Transactional Boundaries

- [x] Atomic journal write unit:
  - single event append is atomic
  - small related batches may share one DB transaction when no external side effect has started

- [x] Partial batch failure behavior:
  - transaction rollback if no side effects began
  - otherwise append reconciliation event on restart

- [x] Write-ahead guarantees:
  - event durable once SQLite transaction commits and write call returns success

### Projections

- [x] v1 projection list:
  - run summary
  - timeline steps
  - approval inbox
  - recovery state
  - changed-path index
  - external-effect index
  - helper fact cache

- [x] Projection update strategies:
  - run summary: sync-in-transaction when cheap
  - active run timeline: async but near-real-time
  - helper fact cache: async
  - full rebuilds: explicit maintenance job

- [x] “Cheap” sync threshold:
  - <= 5 rows touched and no large aggregation

- [x] Max projection lag:
  - active run summary/timeline: 1s
  - approvals: 500ms
  - helper cache: 3s
  - cold indexes: best effort

- [x] Projection corruption detection:
  - projection checksum/version mismatch
  - missing sequence coverage
  - rebuild trigger on failed consistency check

- [x] Projection rebuild targets:
  - 100k events on modern laptop: **< 30 seconds** full rebuild target

### SQLite Specifics

- [x] WAL checkpoint policy:
  - size trigger: **64 MB**
  - time trigger: **5 minutes**
  - idle trigger: when no active actions and WAL > 8 MB

- [x] WAL file hard limit: **256 MB**

- [x] Coordinated writer protocol:
  - all writes serialized through authority daemon journal service

- [x] Reader concurrency model:
  - many readers, one writer
  - small bounded reader pool per process

- [x] Minimum SQLite version and compile options:
  - SQLite **3.51.3+**
  - must include March 2026 WAL reset fix lineage
  - JSON1 enabled

- [x] Table schema:
  - `runs`
  - `run_events`
  - `artifacts`
  - `projection_state`
  - projection tables/indexes

- [x] Migration strategy:
  - versioned SQL migrations for DB schema
  - projection rebuild from events

### Event Payload Size

- [x] Maximum inline event payload size: **64 KB**

- [x] Payload over limit behavior:
  - store large material by artifact reference
  - reject only if reference extraction impossible

- [x] Large payload strategy:
  - artifact store ref + summary in payload

### Import and Observation

- [x] Import protocol:
  - typed ingestion method into daemon or internal import worker
  - imported records normalized into `RunEvent` with provenance metadata

- [x] Imported event validation:
  - envelope validation
  - provenance source required
  - timestamps sanity-checked

- [x] Trust labeling:
  - imported and observed preserved distinctly

- [x] Projection interaction:
  - yes, imported/observed events update projections

---

## 8. RECOVERY ENGINE SPECIFICATIONS

### Confidence Scoring

- [x] Confidence computation:
  Inputs:
  - snapshot fidelity
  - intervening actions
  - path overlap
  - provenance strength
  - external divergence risk
  Output:
  - `low`, `medium`, `high`

- [x] Auto-allow vs approval thresholds:
  - `high` exact local restore with no significant overlap may auto-allow if policy permits
  - `medium` usually ask
  - `low` ask or remediation only

- [x] Confidence decay:
  - one level downgrade after significant overlapping later mutation
  - one level downgrade for unknown external divergence

- [x] Strategy baseline confidence:
  - restore: high by default when fidelity strong
  - compensate: medium by default
  - remediate: low by default

### Compensation Generation

- [x] Compensation plan generation owner: **hybrid**
  - hardcoded per-adapter/integration mappings for v1
  - no LLM-generated compensators on launch critical path

- [x] Filesystem compensation:
  - delete created files
  - recreate deleted files from snapshot/preimage
  - restore modified files

- [x] Shell compensation:
  - no general shell inverse
  - usually restore via snapshot or classify as review_only

- [x] MCP compensation:
  - explicit per trusted integration/tool mapping only

- [x] HTTP/API compensation:
  - per integration contract
  - never naive generic DELETE-for-POST assumption without integration metadata

- [x] Browser compensation:
  - mostly remediation
  - explicit cancellation flows only where supported

- [x] External side-effect compensation:
  - only for known integration-specific inverse actions
  - sent email generally irreversible

### Conflict Analysis

- [x] Path overlap detection:
  - exact path match
  - ancestor/descendant containment
  - rename lineage mapping where available

- [x] Conflict severity scoring:
  - `low`: no overlapping protected paths
  - `moderate`: overlapping paths but no later conflicting writes
  - `high`: later conflicting writes or external divergence

- [x] Overlap definition:
  - exact match or containment inside protected restore scope

- [x] Conflict behavior:
  - low => proceed
  - moderate => warn / ask depending on policy
  - high => ask or remediation only

- [x] Rename/move handling:
  - track move lineage in manifest/journal where available

### Recovery Approval Flow

- [x] Approval unit:
  - approve the recovery plan, not every step by default
  - highly sensitive compensating steps may still trigger per-step policy asks

- [x] User edits to recovery plans:
  - limited at launch
  - allow selecting `surgical` vs `boundary_exact`
  - no arbitrary step editing in v1

- [x] Recovery-generated action denied by policy:
  - recovery enters `partial` or `failed`
  - plan remains resumable

- [x] Recovery budget accounting:
  - yes, tracked separately under recovery budget category

### Recovery Failure

- [x] Restore failure behavior:
  - try alternate restore strategy if same class supports it
  - otherwise degrade to compensation or remediation if available

- [x] Mid-chain compensation failure:
  - stop chain by default
  - mark partial
  - preserve resumable step state

- [x] Recovery from recovery:
  - recovery actions themselves are journaled and can be diagnosed like normal actions
  - no hidden rollback of failed recovery without explicit new plan

- [x] Recovery idempotency verification:
  - each step declares idempotency
  - verify current state before rerun when possible

### External Object Recovery

- [x] External object identification:
  - stable tuple:
    - integration
    - object_type
    - object_id
    - version/etag optional

- [x] External object versioning/state tracking:
  - store object ID + version marker if available in artifacts

- [x] Divergence detection:
  - compare stored version/etag/state summary against current fetched summary when possible

- [x] `review_only` presentation:
  - affected systems
  - objects touched
  - likely manual remediation steps
  - evidence and uncertainty

---

## 9. TIMELINE AND HELPER SPECIFICATIONS

### Step Construction

- [x] Step grouping algorithm:
  - one top-level step per action boundary or explicit approval/recovery unit
  - group related events by `action_id` then by run-local sequence window

- [x] Actions with no policy decision:
  - shown as observed/imported/bypassed step with warning

- [x] Multiple snapshots per action:
  - one step, multiple snapshot refs in detail

- [x] Retried actions:
  - one step with attempts in detail when same `action_id`
  - separate steps if a new `action_id` is created

- [x] System events:
  - major ones may appear as `system_step`
  - low-level noise remains in detail view only

- [x] Step ordering:
  - default by run-local sequence
  - causal/detail links preserved separately

### Timeline Views

- [x] Default view requirements:
  - title
  - status
  - provenance
  - decision
  - reversibility class
  - summary
  - recovery affordance

- [x] Change view aggregation:
  - show top changed roots + counts
  - collapse large path sets into summaries
  - allow drill-down

- [x] Risk view filtering:
  - includes steps with deny/ask/allow_with_snapshot/simulate or severity >= moderate

- [x] Recovery view data:
  - precomputed affordance summary
  - on-demand detailed impact preview

### Helper Query Layer

- [x] Grounded query pipeline:
  - journal facts -> projections -> artifacts -> recovery plans -> model synthesis

- [x] Confidence reporting format:
  - `high`, `medium`, `low` + short explanation

- [x] Uncertainty handling:
  - helper says “I don’t know” or “evidence is incomplete” when structured evidence insufficient
  - no unsupported definitive causal claims

- [x] Helper fact cache schema:
  - per run + query type + evidence fingerprint + generated fact summary

- [x] Root cause analysis algorithm:
  - candidate scoring from:
    - first failing/partial step proximity
    - changed-path overlap
    - external object overlap
    - policy/risk anomalies
  - suggest candidates only above defined score threshold

- [x] Cross-run comparison:
  - yes, read-only helper comparisons allowed for similar runs/workspaces

### Provenance Display

- [x] Visual distinction:
  - governed = normal confident styling
  - observed = clearly labeled reduced-trust
  - imported = external-source label
  - unknown = warning label

- [x] Mixed provenance display:
  - step shows dominant provenance + detail breakdown

- [x] Provenance effect on helper confidence:
  - governed evidence weighted highest
  - imported/observed weighted lower
  - unknown heavily degrades confidence

### Summarization

- [x] Run purpose detection:
  - user-supplied if available
  - otherwise derived from workflow metadata and first meaningful steps

- [x] Major changes ordering:
  - by impact first, then chronology

- [x] Summary length targets:
  - run summary: 4-8 bullets or short paragraphs equivalent
  - step summary: 1 sentence
  - detail summary: up to 5 concise points

---

## 10. CREDENTIAL BROKER SPECIFICATIONS

### Protocol

- [x] Credential request shape:
  - `request_id`
  - `integration`
  - `account_scope`
  - `workspace_scope`
  - `run_id` optional
  - `adapter_kind`
  - `action_kind`
  - `ttl_hint`
  - `reason`

- [x] Credential handle response shape:
  - `handle_id`
  - `mode`
  - `scope`
  - `expires_at`
  - `audit_ref`
  - `injection_kind`

- [x] Injection models:
  - environment variable injection: allowed only for child-process adapters when necessary
  - HTTP header injection: preferred for API adapters
  - signed request callback: supported for broker-aware integrations
  - file-based credential: temp file only when unavoidable
  - token passthrough: only via broker-issued short-lived token/handle

- [x] Lease lifecycle:
  - request -> validate scope -> issue lease -> use -> expire/revoke -> audit

### Secret Storage

- [x] OS-native integration:
  - macOS Keychain: default durable store
  - Linux Secret Service: preferred when available
  - Windows Credential Manager / DPAPI: preferred durable options

- [x] Fallback when unavailable:
  - session-only credentials preferred
  - otherwise OS-protected encrypted file envelope if acceptable
  - if neither possible, fail closed for durable brokered mode

- [x] Secret rotation protocol:
  - mark old profile stale
  - acquire new secret
  - issue new leases only from new material
  - revoke old leases when safe

### Scope Model

- [x] Scope axes:
  - integration
  - account
  - workspace
  - run
  - session
  - adapter_kind
  - action_kind

- [x] Scope composition rules:
  - integration required
  - account optional
  - workspace + run/session may combine
  - narrower scope always wins over broader

- [x] Scope validation:
  - broker checks requested execution context against handle scope before release

### Audit

- [x] Credential usage audit schema:
  - `event_id`
  - `handle_id`
  - `integration`
  - `adapter_kind`
  - `action_id`
  - `scope_summary`
  - `timestamp`

- [x] Logged vs never logged:
  - logged: handle IDs, scope, adapter, action, expiry, result
  - never logged: raw secret values, token bodies, passwords, private keys

- [x] Audit retention:
  - same as journal retention for credential usage metadata

---

## 11. SUPPORT INFRASTRUCTURE SPECIFICATIONS

### Runtime Architecture

- [x] Daemon startup sequence with error handling:
  - load config -> acquire lock -> open stores -> verify versions -> detect capabilities -> init broker -> reconcile in-flight state -> open IPC -> start scheduler
  - fail closed before IPC open if journal/storage integrity not established

- [x] Shutdown sequence:
  - stop new actions
  - finish/cancel noncritical tasks
  - checkpoint state
  - mark interrupted work
  - close IPC
  - release lock
  - grace period: **10 seconds**, then force exit

- [x] Single-instance lock mechanism:
  - runtime-root lockfile + OS file lock
  - PID file for diagnostics only

- [x] IPC endpoint health check:
  - `hello` + lightweight `diagnostics` ping

- [x] Internal dependency graph:
  - config -> stores -> capabilities -> broker -> journal -> IPC -> scheduler

- [x] Daemon self-monitoring:
  - health summary
  - queue backlog
  - storage pressure
  - projection lag
  - memory use

### Local Storage

- [x] Directory creation and permissions:
  - create roots at startup
  - user-only permissions where OS allows
  - fail if canonical durable root is world-readable on supported platforms

- [x] `.agentgit/authority.json` schema:
  - `workspace_id`
  - `authority_root_hint`
  - `config_ref` optional
  - `created_at`
  No secrets, no canonical history.

- [x] Blob sharding strategy:
  - 2-char prefix + optional second 2-char level for large stores

- [x] Storage quota enforcement:
  - per-store soft and hard limits
  - global local budget too
  - on hard full: block new noncritical artifact writes and snapshot expansion before journal truth writes

- [x] Migration framework:
  - versioned SQL migrations for DB
  - versioned directory migration steps for stores

- [x] Migration failure behavior:
  - fail closed
  - require explicit user intervention or rollback

### Background Jobs

- [x] Yield-under-load metrics:
  - any active action queue > 0 and CPU > 70% or memory pressure high => maintenance yields

- [x] Retry backoff:
  - exponential with jitter

- [x] Max retry count:
  - critical reconciliation: 10
  - maintenance: 5
  - ephemeral helper/cache jobs: 2

- [x] Job payload storage:
  - inline for small payloads < 4 KB
  - artifact/store ref for larger payloads

- [x] Queue size limits:
  - durable queue: 10k jobs soft cap
  - ephemeral queue: 1k jobs soft cap
  - overflow drops lowest-priority ephemeral jobs first

- [x] WAL checkpoint size threshold default:
  - 64 MB

- [x] Projection rebuild lag tolerance default:
  - 3 seconds active run, 60 seconds cold projections

- [x] Orphan artifact detection:
  - no live references and older than grace window of 1 hour

### Platform Capabilities

- [x] Capability quality thresholds:
  - `strong`: fully supported and preferred
  - `usable`: supported with caveats
  - `degraded`: possible but materially weaker
  - `unsupported`: unavailable

- [x] Capability invalidation triggers:
  - daemon restart
  - workspace mount change
  - explicit refresh
  - significant OS/env change detected

- [x] Capability -> snapshot mapping:
  - strong CoW snapshot support => anchors favored
  - usable only => journal_plus_anchor or journal_only
  - degraded/no CoW => journal-only bias and stricter policy for broad destructive actions

- [x] Capability -> adapter selection:
  - adapter registry can filter on capability requirements

- [x] Degraded mode behavior:
  - no CoW => lower restore confidence
  - no secret store => session-only credentials
  - no browser harness => governed browser unsupported

### Config and Policy Surface

- [x] TOML schema sections:
  - `[runtime]`
  - `[storage]`
  - `[safe_modes]`
  - `[budgets]`
  - `[trust]`
  - `[approvals]`
  - `[snapshots]`
  - `[[rules]]`

- [x] Config layer merge algorithm:
  - scalar override by precedence
  - maps deep-merge by key
  - rule arrays concatenate by source precedence

- [x] Workspace-local vs central config priority:
  - runtime override
  - workspace-local
  - central workspace
  - user
  - defaults

- [x] Hot-reload scope:
  - helper settings, budgets, most policy rules, maintenance thresholds
  - not storage roots or schema versions

- [x] Config reload atomicity:
  - new actions see new config after successful reload commit
  - in-flight actions continue under prior snapshot of config

- [x] Validation error reporting:
  - human-readable file/field path
  - machine-readable error code
  - nonzero CLI exit

### Sync and Hosted Boundary

- [x] Compact RunEvent export format:
  - JSON lines or compact framed JSON batches with stable IDs and selective payload fields

- [x] Sync conflict detection:
  - hosted rejects attempts to mutate immutable record IDs
  - local treats downsync as new records, not row mutation

- [x] Approval routing protocol:
  - approval record carries target daemon/workspace identity
  - local daemon polls/subscribes through sync agent later

- [x] Artifact summary schema:
  - `type`
  - `count`
  - `size_bytes`
  - `scope`
  - `summary_text`

- [x] Offline backlog ordering guarantee:
  - preserve causal order by local journal sequence within run

- [x] Selective artifact upload opt-in:
  - per-type and per-run policy
  - never default raw snapshot upload

- [x] Sync auth model:
  - later hosted token/device auth via brokered local daemon credential
  - not required for local v1

---

## 12. CROSS-CUTTING SPECIFICATIONS

### Error Handling Patterns

- [x] Consistent error representation:
  - daemon envelope error for API-level problems
  - typed result/error payload for domain execution failures

- [x] Partial failure semantics:
  - side effects happened + terminal success absent => `partial`

- [x] Retry policy framework:
  - retryability encoded per error code/class
  - daemon owns request retry guidance
  - jobs own maintenance retry guidance

- [x] Cascading failure behavior:
  - journal/storage failure => fail closed
  - projection failure => degrade read paths only
  - broker failure => block broker-required actions

### Observability

- [x] Structured logging format:
  - JSON logs with level, timestamp, component, request_id, run_id, action_id

- [x] Trace propagation:
  - OpenTelemetry-compatible `trace_id` + `span_id`
  - no secrets in baggage

- [x] Health check endpoint shape:
  - local daemon method `diagnostics`
  - sections for health, queues, storage, capabilities

- [x] Metrics:
  - policy eval latency
  - snapshot create latency by class
  - journal write latency
  - projection lag
  - helper query latency
  - action end-to-end latency
  - storage usage by store/class

- [x] Policy debugging output:
  - matched rules
  - skipped rules
  - phase order
  - final reasons

- [x] Storage breakdown reporting:
  - per store
  - per snapshot class
  - per workspace

### Performance Targets

- [x] Policy evaluation latency target:
  - p95 < **50 ms**

- [x] Snapshot creation latency targets:
  - `metadata_only`: p95 < **20 ms**
  - `journal_only`: p95 < **100 ms**
  - `journal_plus_anchor`: p95 < **500 ms**
  - `exact_anchor`: best effort, target < **1500 ms** on supported local paths

- [x] Journal write latency target:
  - p95 < **10 ms**

- [x] Manifest diff target:
  - 100k files => p95 < **500 ms** for indexed diff

- [x] Projection query target:
  - timeline summary p95 < **100 ms**

- [x] End-to-end action latency budget:
  - wrapper -> completed response for fast local actions p95 < **500 ms** excluding long-running tool execution itself

### Testing Strategy

- [x] Unit test boundaries:
  - per subsystem module

- [x] Integration test strategy:
  - wrapper->normalizer
  - normalizer->policy
  - policy->snapshot
  - snapshot->execution
  - execution->journal
  - journal->recovery
  - journal->timeline/helper

- [x] End-to-end scenarios:
  - simple allow
  - allow_with_snapshot
  - ask/approve
  - deny
  - partial execution
  - recovery success/failure
  - imported event flow

- [x] Snapshot fidelity testing:
  - automated restore drills in isolated workspaces

- [x] Recovery testing safety:
  - sandboxed temp workspaces and mocked external integrations

- [x] Policy rule testing framework:
  - declarative test vectors mapping sample `Action` -> expected `PolicyOutcome`

### Schema Evolution

- [x] Schema versioning strategy:
  - new version per breaking change

- [x] Schema migration path:
  - write latest
  - read latest + explicitly supported older versions
  - migrate projections/re-emit derived views as needed

- [x] Backward compatibility window:
  - support previous major schema pack version during upgrade window

- [x] Validation enforcement:
  - write-time and read-time for external/imported boundaries

### Security

- [x] Threat model:
  - curious/misbehaving model
  - untrusted remote tools/servers
  - local accidental misuse
  - partial workstation compromise
  Assets:
  - governed action path
  - snapshots
  - secrets
  - approvals
  - history integrity

- [x] Credential leakage prevention:
  - structured redaction
  - no raw secrets in logs, errors, helper, or journal

- [x] Approval tampering prevention:
  - approval IDs unguessable UUIDv7 + daemon-side lookup
  - approval resolution only accepted over valid local session

- [x] Sticky approval scope isolation:
  - sticky approvals scoped by action kind + trust surface + workspace + session/run pattern

- [x] IPC authentication:
  - local user trust domain at launch
  - session handshake required
  - future peer credential checks possible

- [x] Daemon file permission requirements:
  - canonical durable roots user-readable only where possible
  - secret stores OS-managed

---

## 13. EXAMPLE RECORDS AND VALIDATION

### Schema Validation

- [x] Valid example requirement:
  - create **3 valid examples per schema**:
    - happy path
    - edge case
    - minimal valid

- [x] Invalid example requirement:
  - create **3 invalid examples per schema**:
    - missing required
    - wrong type
    - invalid enum/reference

- [x] Validation rule:
  - all examples must be validated against the JSON schemas in CI

- [x] Referential integrity rule:
  - example bundles must include linked IDs that resolve across records

### End-to-End Trace Examples

- [x] Required example traces:
  - simple file write (`allow`)
  - destructive shell command (`allow_with_snapshot`)
  - untrusted MCP tool call (`ask -> approve -> execute`)
  - denied action
  - failed execution with recovery
  - simulated action
  - imported/observed action

---

## TRACKING

This checklist is now resolved at the specification level.

Recommended next implementation sequence:

1. Create example records and end-to-end traces from these decisions
2. Generate runtime types from schema pack
3. Implement daemon handshake + `register_run` + `submit_action_attempt`
4. Implement journal and projection backbone
5. Implement policy + snapshot + execution happy path
6. Add recovery and helper layers
