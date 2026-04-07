# Shell Trust Boundary Remediation Scope

Status date: 2026-04-06 (America/New_York)

## Purpose

Define the full remediation scope for the confirmed shell trust-boundary failures.

This document is the implementation and verification scope for fixing the current `P0` class issues, not just a high-level plan.

It exists to answer four questions clearly:

1. what is broken,
2. how far the blast radius extends,
3. what systems must change together,
4. what must be verified before the issue can be considered closed.

Implementation contract companion:

- [Shell Trust Boundary Implementation Contract](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/SHELL-TRUST-BOUNDARY-IMPLEMENTATION-CONTRACT.md)

## Problem Statement

The current governed shell path is not operating under the same trust contract as the governed filesystem path.

Today, shell actions can be treated as safe or snapshot-backed based primarily on command family and confidence classification rather than on the actual paths they read or mutate.

This creates a split-brain trust model:

- filesystem actions are path-aware and policy-aware
- shell actions are partly command-aware but not fully path-aware
- recovery metadata can still describe some shell actions as locally recoverable when actual recovery is only `review_only`

This is not a narrow shell bug.
It is a control-plane consistency failure across:

- action normalization
- policy evaluation
- execution containment
- snapshot/recovery truthfulness
- operator evidence and reporting

## Confirmed Findings

Live repros already confirmed:

1. governed shell can read protected files such as `.env`
2. governed shell can read absolute paths outside the workspace
3. governed shell can mutate protected files such as `.env`
4. governed shell can mutate control surfaces such as `.agentgit/policy.toml`
5. governed shell can write to absolute paths outside the workspace
6. governed shell can write through in-workspace symlinks into out-of-workspace targets
7. policy/recovery metadata can overstate local recoverability for shell actions that later downgrade to `review_only`

Current archived evidence:

- [Campaign 0 summary](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/adversarial-audit/2026-04-06-campaign-0-containment/summary.json)
- [Campaign 0 report](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/adversarial-audit/2026-04-06-campaign-0-containment/REPORT.md)
- [Campaign 0 runner](/Users/geoffreyfernald/Documents/agentgit/scripts/run-adversarial-campaign-0.mjs)

## Blast Radius

The blast radius is larger than `submit-shell`.

Affected trust properties:

- confidentiality
- integrity
- containment
- recoverability truthfulness
- operator trust
- audit evidence accuracy

Affected user promises:

- protected files are outside the governed auto-execution surface
- governed execution is workspace-contained
- `allow_with_snapshot` preserves a meaningful rollback boundary
- operator-facing evidence tells the truth about what happened

Affected runtime surfaces:

- direct CLI shell submission
- SDK-driven shell submission
- agent-runtime shell-backed actions
- any future adapter or integration that maps behavior into the governed shell lane

Affected failure modes:

- secret exfiltration
- protected control-surface mutation
- outside-workspace mutation
- misleading recovery confidence
- misleading operator summary and audit interpretation

## Core Remediation Principle

The product must use one single trust model for all governed action types:

1. determine actual affected paths,
2. evaluate those paths against policy,
3. enforce containment at execution time,
4. make recovery claims that match actual possible restore behavior.

If any layer has weaker assumptions than the others, the trust contract is broken.

## Scope Of Change

This fix is in scope for all of the following subsystems.

### 1. Action Normalizer

Why it is in scope:

- shell normalization currently records the workspace as the shell target too often
- shell classification focuses on command families and opaque-confidence bands
- actual argv path targets are not fully promoted into the canonical action model

Required outcomes:

- shell attempts must capture referenced path targets when they can be identified
- scope must degrade honestly when path extraction is incomplete
- protected-path and external-path hints must become available to policy
- shell read-only classification must not imply “safe regardless of target”

Primary files:

- [packages/action-normalizer/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/action-normalizer/src/index.ts)
- [packages/action-normalizer/src/index.test.ts](/Users/geoffreyfernald/Documents/agentgit/packages/action-normalizer/src/index.test.ts)

### 2. Policy Engine

Why it is in scope:

- current default secret/control-surface deny rules are scoped to `filesystem`
- shell policy currently allows trusted read-only shell by command class
- opaque shell can still become `allow_with_snapshot` without path-aware guardrails
- recovery hints emitted by policy can overstate local recoverability

Required outcomes:

- protected-path and control-surface rules must apply to shell where relevant
- outside-workspace path access must fail closed
- opaque shell scope must not auto-proceed when actual affected paths are unknown and risk-relevant
- `allow_with_snapshot` must not be used as a substitute for permission
- policy recovery context must not claim `recoverable_local` unless that is truly supportable

Primary files:

- [packages/policy-engine/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/policy-engine/src/index.ts)
- [packages/policy-engine/src/default-policy-pack.ts](/Users/geoffreyfernald/Documents/agentgit/packages/policy-engine/src/default-policy-pack.ts)
- [packages/policy-engine/src/index.test.ts](/Users/geoffreyfernald/Documents/agentgit/packages/policy-engine/src/index.test.ts)

### 3. Execution Adapters

Why it is in scope:

- shell execution currently validates `cwd` containment but does not fully contain the effective argv targets
- policy and normalization can miss cases, so the adapter must provide defense in depth

Required outcomes:

- shell execution must reject out-of-root argv targets
- shell execution must reject protected/control-surface targets
- shell execution must reject symlink-resolved outside targets
- execution-time containment must remain fail-closed even if upstream classification is imperfect

Primary files:

- [packages/execution-adapters/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/execution-adapters/src/index.ts)
- [packages/execution-adapters/src/index.test.ts](/Users/geoffreyfernald/Documents/agentgit/packages/execution-adapters/src/index.test.ts)

### 4. Authority Daemon Integration

Why it is in scope:

- the daemon is where normalized action, policy outcome, snapshot creation, execution, and recovery metadata are stitched together
- end-to-end semantics need to stay coherent across request/decision/execution/reporting

Required outcomes:

- submit flows must surface the corrected shell decisions
- run summaries, timelines, and helpers must reflect the corrected trust semantics
- no downstream subsystem should preserve stale optimistic assumptions about shell recoverability

Primary files:

- [packages/authority-daemon/src/server.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-daemon/src/server.ts)
- [packages/authority-daemon/src/server.integration.test.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-daemon/src/server.integration.test.ts)

### 5. Snapshot And Recovery Semantics

Why it is in scope:

- current outcomes can imply a workspace-local snapshot proof for actions that actually touched external paths or opaque shell scope
- recovery planning later downgrades some of these actions, creating a truth gap

Required outcomes:

- recovery classification must agree with policy-time claims
- external effects must be surfaced when present or plausibly unbounded
- shell actions that are only reviewable must be marked that way consistently
- no restore plan should imply stronger scope knowledge than the system actually has

Primary files:

- [packages/recovery-engine/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/recovery-engine/src/index.ts)
- [packages/recovery-engine/src/index.test.ts](/Users/geoffreyfernald/Documents/agentgit/packages/recovery-engine/src/index.test.ts)
- snapshot-related files if recovery proof scope or boundary generation must change

### 6. Operator Evidence And Audit Surfaces

Why it is in scope:

- current outputs can make dangerous shell actions look more governed or more recoverable than they are
- confidentiality failures can surface through stdout/artifacts and then propagate into evidence workflows

Required outcomes:

- helper, timeline, run summary, artifact, and audit export flows must remain honest about confidentiality and recoverability
- secret-bearing outputs must not be emitted through user-visible surfaces when policy says access should be denied
- audit records must describe what actually happened, not the earlier optimistic assumption

Primary files:

- [packages/authority-cli/src/commands/runtime.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-cli/src/commands/runtime.ts)
- [packages/authority-cli/src/main.integration.test.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-cli/src/main.integration.test.ts)
- timeline/helper related packages if summaries or explanations need correction

### 7. Adversarial Verification Harnesses

Why it is in scope:

- these findings must become durable launch gates, not memory-based knowledge

Required outcomes:

- `Campaign 0` must stay green after the fix
- the autonomy stress harness must stop reporting shell trust bypasses
- future campaigns must build on the corrected baseline

Primary files:

- [scripts/run-adversarial-campaign-0.mjs](/Users/geoffreyfernald/Documents/agentgit/scripts/run-adversarial-campaign-0.mjs)
- [scripts/stress-autonomous-governance.mjs](/Users/geoffreyfernald/Documents/agentgit/scripts/stress-autonomous-governance.mjs)
- [engineering-docs/PRE-LAUNCH-ADVERSARIAL-AUDIT-PLAN.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/PRE-LAUNCH-ADVERSARIAL-AUDIT-PLAN.md)

## Explicitly In Scope Behaviors

The remediation is not complete unless all of these behaviors are addressed.

### Confidentiality

- shell reads of protected files
- shell reads of control-surface files
- shell reads of outside-workspace absolute paths
- shell reads through symlink-resolved outside paths
- secret leakage via stdout/stderr/artifacts after shell execution

### Integrity

- shell writes to protected files
- shell writes to control-surface files
- shell writes to outside-workspace absolute paths
- shell writes through symlink-resolved outside paths
- shell rename/delete operations targeting protected or outside paths

### Containment

- argv path enforcement
- relative-path traversal handling
- symlink resolution handling
- disagreement between `cwd` containment and effective target containment

### Recoverability Truthfulness

- false `recoverable_local` classification
- false `snapshot_preimage` implication for effectively external or opaque shell effects
- missing external-effects language in recovery planning
- policy/recovery disagreement on what can be restored automatically

### Operator Honesty

- summaries that sound safer than reality
- audit bundles that preserve misleading trust interpretation
- helper answers that omit uncertainty or externality

## Explicitly Out Of Scope For This Remediation

These are important, but they are not the success criteria for this specific fix unless they become directly implicated by implementation work:

- browser/computer governance
- generic governed HTTP adapter
- hosted MCP deferred roadmap work
- non-shell UI polish
- unrelated CI or release formatting debt

## Non-Negotiable Invariants

The implementation must preserve these invariants:

1. `allow_with_snapshot` is never a substitute for permission.
2. Unknown or opaque scope does not become implicitly safe.
3. Execution adapters remain fail-closed even when normalization is imperfect.
4. Recovery labels never overstate actual restore capability.
5. Operator evidence must be at least as conservative as the actual runtime state.

## Acceptance Criteria

The issue is not closed until all of the following are true.

### Code Acceptance

- shell normalization becomes path-aware enough to support real policy enforcement
- shell policy decisions align with protected-path and outside-workspace rules
- shell execution is contained at adapter time
- recovery metadata is honest and aligned with actual restore class

### Test Acceptance

Regression coverage must exist for:

- shell protected read
- shell outside absolute read
- shell protected write
- shell control-surface write
- shell outside absolute write
- shell outside symlink write
- recovery honesty for external shell effects

### Adversarial Acceptance

- `pnpm audit:campaign0` passes cleanly
- no `P0` findings remain in `Campaign 0`
- the shell-heavy adversarial stress profile no longer surfaces these bypasses

### Operator Acceptance

- run summary, timeline, helper, and audit outputs no longer overclaim local recoverability or safety for shell actions

## Recommended Implementation Order

Do the work in this order:

1. action normalization
2. policy engine
3. execution adapter containment
4. recovery/trust metadata alignment
5. regression tests
6. adversarial rerun

This order matters because:

- normalization defines the canonical facts
- policy consumes those facts
- execution enforces them even if policy misses one
- recovery and operator surfaces must reflect the corrected runtime truth

## Verification Order

Once code changes are in:

1. run targeted unit/integration tests for normalizer, policy engine, execution adapters, and daemon integration
2. run `pnpm audit:campaign0`
3. rerun shell-heavy `pnpm stress:autonomy -- --profile adversarial ...`
4. rerun the recovery-honesty probes
5. archive fresh evidence under `engineering-docs/release-signoff/adversarial-audit/`

## Closure Condition

This remediation is complete only when:

- the trust model is consistent across normalization, policy, execution, recovery, and evidence
- the archived adversarial evidence shows a green `Campaign 0`
- no open `P0` shell trust-boundary findings remain
