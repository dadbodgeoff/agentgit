# Production Readiness TDD: Approval-Light Automation And Contained GA

Status date: 2026-04-03 (America/New_York)

Owner: AgentGit core

Implementation status: complete in repo. This document now describes the repo-native implementation path that shipped in this pass.

## 1. Purpose

Define the concrete design and execution plan required to make AgentGit production-ready in the remaining high-value areas that are still intentionally incomplete:

- broader approval-light automation for recoverable external and tool lanes
- explicit checkpoint UX beyond `agentgit run`
- richer contained egress than proxy-aware HTTP(S) only
- broader credential broker shapes than env/file delivery only

This document is intentionally repo-native.

It does not propose a parallel architecture.

It extends the existing product, daemon, recovery, containment, and policy layers that already exist in the repo.

## 2. Executive Summary

The repo already has the right backbone:

- a real authority daemon
- a real policy engine
- a real snapshot and recovery engine
- a real product runtime layer
- a real contained Docker path

The remaining work is not "add a few features."

The remaining work is to make the system fully coherent around one operating principle:

**AgentGit should automate anything it can recover honestly, and escalate only when recovery or execution confidence breaks down.**

To do that cleanly, the repo needs one integrated production plan across:

1. policy decision semantics
2. recovery-boundary proof
3. contained backend capability truth
4. credential binding truth
5. product wording and operator workflows

This TDD makes those contracts explicit and defines the implementation order, schema changes, tests, and signoff bar.

## 3. Product Law

**Seatbelt, not a framework.**

This remains non-negotiable.

Consequences:

- no mode explosion in the product surface
- no policy-admin UX maze
- no new hosted control plane requirement
- no branch into a separate sandbox product
- no product claim that outruns the actual governed boundary

## 4. Target Outcome

AgentGit is production-ready for day-one launch only when all of the following are true:

- recoverable risky work usually continues automatically
- humans are looped in only for degraded, unrecoverable, or consent-bound situations
- contained setup, run, inspect, restore, remove, and repair remain truthful under drift and failure
- checkpointing is a normal product habit, not hidden operator machinery
- contained credentials and egress are described and enforced through explicit capability truth
- every shipped claim is backed by deterministic tests and live integration coverage

## 5. What Exists Today

### 5.1 Strong existing foundations

Already real in the repo:

- product CLI surface in [/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/main.ts](/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/main.ts)
- product service orchestration in [/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/service.ts](/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/service.ts)
- contained backend seam and Docker implementation in [/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/containment.ts](/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/containment.ts)
- policy decisions in [/Users/geoffreyfernald/Documents/agentgit/packages/policy-engine/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/policy-engine/src/index.ts)
- snapshot selection in [/Users/geoffreyfernald/Documents/agentgit/packages/snapshot-engine/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/snapshot-engine/src/index.ts)
- action execution and recovery APIs in [/Users/geoffreyfernald/Documents/agentgit/packages/authority-daemon/src/server.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-daemon/src/server.ts)
- credential brokerage in [/Users/geoffreyfernald/Documents/agentgit/packages/credential-broker/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/credential-broker/src/index.ts)
- action schemas in [/Users/geoffreyfernald/Documents/agentgit/packages/schemas/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/schemas/src/index.ts)

### 5.2 Delivered in this pass

Now implemented in the repo:

- approval-light automation records recovery proof in policy context for local snapshot-backed lanes and trusted compensator lanes, while intentionally keeping mutating MCP trust conservative
- checkpoints are persisted as runtime-profile defaults and surfaced through setup, inspect, restore guidance, and `run`
- contained egress truth is explicit through `contained_egress_mode` and `contained_egress_assurance`, with Docker failing closed when a profile expects backend-enforced host allowlists
- runtime-contained credential bindings are a distinct model from MCP registry bindings and support `env`, `file`, `header_template`, `runtime_ticket`, and `tool_scoped_ref`

## 6. Design Principles

### 6.1 Recoverability first

Policy should optimize for:

- `allow`
- `allow_with_snapshot`
- true escalation only when automatic recovery is not trustworthy

### 6.2 One recovery model

Automatic checkpoints, explicit checkpoints, snapshot anchors, contained publish-back, and compensating external recovery must all remain part of one recovery model.

There must not be a "product restore system" and a separate "operator restore system."

### 6.3 One capability truth model

Contained backend capability, credential capability, and egress capability must all flow through:

- persisted profile/install state
- verify / inspect / repair
- launch preflight
- user-facing product wording

### 6.4 No silent downgrade

If the system falls from a stronger guarantee to a weaker one, that must surface in:

- inspect
- setup success output
- repair output
- run preflight when the profile expects stronger guarantees than the current backend can deliver

## 7. Architectural Decisions

## 7.1 Broader approval-light automation

### Problem

The current `ask` outcome is still overloaded.

It covers:

- degraded capability paths
- shell opacity
- external consent boundaries
- unsupported execution
- some lanes that are actually recoverable if the system records the right boundary

### Decision

Shift the repo from action-family-first policy toward recovery-proof-first policy.

### Required internal model

Add an internal recoverability classifier in the policy engine:

- `recoverable_local`
- `recoverable_external_compensated`
- `recoverable_contained_publish`
- `unrecoverable_or_degraded`

This is internal only for now.

The public decision surface remains:

- `allow`
- `allow_with_snapshot`
- `ask`
- `deny`

### Required rule

Any action that can prove one of the following should bias toward `allow_with_snapshot` instead of `ask`:

- trustworthy preimage capture exists
- trustworthy explicit checkpoint exists
- trusted compensator exists
- contained publish-back boundary exists

### Hard exceptions that remain escalation or deny

- direct credentials on governed execution paths
- degraded capability states where refresh cannot recover truth safely
- public or unsupported mutating MCP without trusted recovery proof
- irreversible external actions without compensator
- explicit user-consent boundaries

### Required journaling addition

Every decision that auto-continues because recovery is trusted must record a recovery-proof rationale in the action’s policy context.

New decision basis concepts:

- `recovery_proof_kind`
- `recovery_proof_source`
- `recovery_proof_scope`

## 7.2 Explicit checkpoint UX beyond `agentgit run`

### Problem

The repo now supports explicit checkpoints on `run`, but checkpoints are not yet a durable product habit across setup, inspect, and restore.

### Decision

Do not explode the command surface immediately.

Keep the five-command product surface, but make checkpoints a first-class persisted product preference and recovery concept.

### Required product model

Add profile-level checkpoint defaults:

- `never`
- `risky_runs`
- `always_before_run`

Add optional operator intent metadata:

- `checkpoint_intent`
- `checkpoint_reason_template`

### Required product behavior

- `setup` Advanced must allow setting the default checkpoint policy
- `inspect` must identify:
  - latest explicit checkpoint
  - latest automatic risky-run checkpoint
  - whether the current recommended restore target is narrower or broader than the latest checkpoint
- `restore --preview` must explain when an explicit checkpoint is the best source of truth
- `demo` should remain deterministic but should also be able to teach checkpoint-backed recovery in documentation/tests

### Non-goal

Do not add a new top-level `agentgit checkpoint` command in this slice unless product UX proves that `run` and profile defaults are insufficient.

## 7.3 Richer contained egress

### Problem

The current contained path is honest, but its egress story is still too narrow:

- `inherit`
- `none`
- proxy-aware HTTP(S) allowlist only

That is not enough for production-grade guarantee language.

### Decision

Introduce an explicit contained egress capability matrix before adding stronger backend enforcement.

### Required egress model

Persist:

- `egress_mode`
  - `inherit`
  - `none`
  - `proxy_http_https`
  - `backend_enforced_allowlist`
- `egress_assurance`
  - `degraded`
  - `scoped`
  - `boundary_enforced`
- `egress_allowlist_hosts`
- backend-specific enforcement facts

### Required runtime rules

- `run` preflight must fail closed when a profile expects stronger egress than the active backend can satisfy
- `inspect` must explicitly say when raw-socket traffic is not governed
- `repair` must either restore the expected egress mode or explain why it cannot

### Product language rules

- proxy-aware HTTP(S) is always degraded relative to backend-enforced allowlists
- never say or imply universal network governance when only proxy-aware HTTP(S) is active

## 7.4 Broader credential broker shapes

### Problem

Today contained credentials are modeled mostly as env injection or read-only secret-file injection.

That is implementation-shaped, not product-shaped.

### Decision

Introduce a first-class credential binding model that can survive across runtimes and adapters.

### Required credential binding model

Shipped binding kinds in this slice:

- `env`
- `file`
- `header_template`
- `runtime_ticket`
- `tool_scoped_ref`

Modeled but deferred delivery implementations may exist later, but the schema should be ready now.

### Required rules

- bindings must resolve as late as possible
- bindings must remain redacted in persisted state, logs, inspect output, and errors
- bindings must support preflight validation, expiry detection, rotation, and repair
- direct host env passthrough remains a degraded mode, not the default brokered mode

### Required adapter behavior

Execution adapters and contained runtimes must resolve credential bindings through a shared broker contract rather than inventing per-runtime secret plumbing.

## 8. Required Schema Changes

All changes must be additive and migrate-on-read.

## 8.1 Policy and decision context

Add to policy outcome / policy context structures:

- `recovery_proof_kind?: "snapshot_preimage" | "explicit_checkpoint" | "trusted_compensator" | "contained_publish_boundary"`
- `recovery_proof_source?: string`
- `recovery_proof_scope?: "path" | "workspace" | "external_object" | "contained_projection"`

Primary file:

- [/Users/geoffreyfernald/Documents/agentgit/packages/schemas/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/schemas/src/index.ts)

## 8.2 Runtime profile and install docs

Add to runtime profile and install persistence:

- `default_checkpoint_policy?: "never" | "risky_runs" | "always_before_run"`
- `checkpoint_intent?: "operator_requested" | "broad_risk_default" | "high_value_workspace"`
- `checkpoint_reason_template?: string`
- `contained_egress_mode?: "inherit" | "none" | "proxy_http_https" | "backend_enforced_allowlist"`
- `contained_egress_assurance?: "degraded" | "scoped" | "boundary_enforced"`
- `runtime_credential_bindings?: RuntimeCredentialBindingDocument[]`

This runtime-contained binding model is intentionally distinct from MCP registry credential bindings.

Primary files:

- [/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/types.ts](/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/types.ts)
- [/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/state.ts](/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/state.ts)

## 8.3 Credential binding schema

Add a typed credential binding structure:

- `binding_id`
- `kind`
- `target`
- `broker_source_ref`
- `redacted_delivery_metadata`
- `expires_at?`
- `rotates?`

Primary files:

- [/Users/geoffreyfernald/Documents/agentgit/packages/schemas/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/schemas/src/index.ts)
- [/Users/geoffreyfernald/Documents/agentgit/packages/credential-broker/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/credential-broker/src/index.ts)

## 9. Package-Level Implementation Plan

## 9.1 `packages/policy-engine`

Required changes:

- add internal recoverability classification
- shift more external/tool lanes from `ask` to `allow_with_snapshot` only when recovery proof exists
- record recovery-proof rationale in policy context
- keep degraded capability, direct-credential, and unsupported execution lanes conservative

Required tests:

- trusted-compensator generic function lanes
- contained publish-boundary lanes
- degraded capability lanes remain `ask`
- direct credential lanes remain `ask` or `deny`

## 9.2 `packages/snapshot-engine`

Required changes:

- keep current widening logic
- consume explicit checkpoint defaults from product/runtime context where appropriate
- support broader rationale recording for why a stronger boundary was selected

Required tests:

- profile default checkpoint policy influences widening
- repeated ambiguity still widens even without explicit defaults
- explicit checkpoint and automatic risky-run checkpoint remain distinguishable

## 9.3 `packages/authority-daemon`

Required changes:

- persist and surface recovery-proof context
- expose latest checkpoint and checkpoint class information to product inspect/restore callers
- validate expected egress and credential capability at launch preflight
- support credential binding resolution contracts through execution and recovery paths

Required tests:

- restart resilience with new checkpoint defaults
- recovery-proof journaling visible after restart
- preflight fails closed when expected egress is not satisfiable
- preflight fails closed when required credential binding is missing or expired

## 9.4 `packages/credential-broker`

Required changes:

- add binding-oriented resolution APIs
- support binding kinds beyond env/file
- maintain redaction guarantees at all non-runtime surfaces
- support expiry and rotation metadata for bindings

Required tests:

- env binding
- file binding
- header template binding
- runtime ticket binding
- tool-scoped ref binding
- missing binding
- expired binding
- rotated binding
- no-leak logging and state assertions

## 9.5 `packages/execution-adapters`

Required changes:

- consume credential bindings instead of assuming env/file-only delivery
- honor egress capability truth where adapter behavior depends on outbound network

Required tests:

- binding resolution per adapter kind
- failures stay redacted
- backend or adapter mismatch degrades honestly

## 9.6 `packages/agent-runtime-integration`

Required changes:

- persist checkpoint defaults and egress truth
- expose richer inspect/setup/repair output
- resolve explicit checkpoint and default checkpoint policy consistently
- surface credential binding summaries without leaking secret values
- fail closed when profile expectations exceed backend truth

Required tests:

- advanced setup saves checkpoint defaults
- inspect shows latest explicit and automatic checkpoint context
- repair preserves checkpoint/egress/credential binding truth
- contained preflight fails for stronger-than-backend egress expectations
- contained inspect wording stays honest across all egress assurance levels

## 10. Milestone Order

## M1: Integrated schema and truth model

Build first:

- recovery-proof journaling
- checkpoint-default persistence
- egress mode and assurance fields
- credential binding schema

Exit criteria:

- migrate-on-read works
- inspect/setup formatting has schema support
- no existing profile or runtime doc becomes unreadable

## M2: Broader approval-light automation

Build second:

- recoverability classifier
- broader `allow_with_snapshot` rollout for recoverable external/tool lanes
- policy tests and daemon integration coverage

Exit criteria:

- more recoverable work proceeds automatically
- true exception lanes remain conservative
- all new automated lanes record recovery proof

## M3: Checkpoint defaults and product UX

Build third:

- checkpoint defaults in setup
- inspect/restore checkpoint explanations
- daemon support for latest-checkpoint product queries

Exit criteria:

- checkpoints become a durable product habit
- restore/inspect explain checkpoint-backed recovery clearly

## M4: Credential broker v2

Build fourth:

- shipped binding kinds
- binding resolution in broker and adapters
- preflight, inspect, and repair binding truth

Exit criteria:

- env/file are no longer the only first-class model
- missing/expired/rotated bindings remain redacted and fail closed

## M5: Egress truth matrix

Build fifth:

- richer egress mode and assurance model
- preflight enforcement for profile-vs-backend mismatch
- inspect/setup wording for raw-socket and proxy-only truth

Exit criteria:

- product never over-claims network governance
- degraded proxy-only truth is clearly visible

## M6: Production signoff sweep

Build last:

- release checklist completion
- wording audit
- sequential smoke and live backend verification
- drift / restart / repair / remove / restore verification across new contracts

Exit criteria:

- no open blocker remains across policy truth, recovery truth, credential truth, or contained capability truth

## 11. Testing Requirements

This work is not complete without all four layers of testing.

### 11.1 Unit

- recoverability classification
- checkpoint default selection
- egress assurance formatting
- credential binding parsing, migration, and redaction
- policy recovery-proof rationale

### 11.2 Fixture and adapter

- planner behavior across credential binding kinds
- egress mode compatibility by backend
- verify and repair behavior across degraded capability states

### 11.3 Integration

- setup / run / inspect / restore / repair / remove across:
  - attached runtime
  - integrated runtime
  - contained Docker runtime
- restart resilience for:
  - checkpoints
  - binding drift
  - egress mismatch
  - recovery-proof journaling

### 11.4 Live smoke

Required sequential signoff commands:

- `pnpm typecheck`
- `pnpm test`
- `pnpm smoke:agent-runtime`

Smoke must verify:

- demo flow
- attached generic flow
- contained Docker flow
- checkpoint-backed recovery when available

## 12. Signoff Bar

Production-ready means all of these are done:

- engineering signoff
- security signoff on secret redaction and credential binding behavior
- product wording signoff on contained egress and automation claims
- QA signoff on restart, drift, repair, restore, and remove behavior

Release must not ship if any of these are still open:

- silent downgrade path
- credential leakage risk
- inconsistent checkpoint truth between inspect and restore
- egress wording stronger than backend reality
- automated external mutation without trustworthy recovery proof

## 13. What This TDD Does Not Change

This document does not change:

- the five-command product surface
- the core "seatbelt, not a framework" law
- the authority daemon as the real execution authority
- the existing recovery engine as the basis for restore
- the contained backend interface direction already established in the repo

## 14. Related Documents

- base runtime integration TDD: [/Users/geoffreyfernald/Documents/agentgit/engineering-docs/09-agent-runtime-integration/TDD.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/09-agent-runtime-integration/TDD.md)
- approval-light R&D: [/Users/geoffreyfernald/Documents/agentgit/engineering-docs/09-agent-runtime-integration/approval-light-automation-rd.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/09-agent-runtime-integration/approval-light-automation-rd.md)
- snapshot boundary audit: [/Users/geoffreyfernald/Documents/agentgit/engineering-docs/09-agent-runtime-integration/snapshot-boundary-audit.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/09-agent-runtime-integration/snapshot-boundary-audit.md)
- contained GA plan: [/Users/geoffreyfernald/Documents/agentgit/engineering-docs/09-agent-runtime-integration/contained-ga-plan.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/09-agent-runtime-integration/contained-ga-plan.md)
