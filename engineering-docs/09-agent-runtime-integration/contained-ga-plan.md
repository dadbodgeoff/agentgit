# Contained GA Plan

Status date: 2026-04-03 (America/New_York)

Owner: AgentGit core

Implementation status: Docker-contained GA work from this plan is complete in repo. This document remains as the execution plan record and now reads as a shipped design reference.

## Purpose

Define the concrete implementation and release program required to take the contained runtime path from "real and honest" to "fully production-ready and signed off."

This plan assumes the current state already exists:

- product CLI surface is live
- Docker-backed contained execution is live
- projection + governed publish-back is live
- setup / run / inspect / restore / remove / repair are live
- assurance, governance mode, guarantees, and degraded reasons are persisted and surfaced

This plan is about closing the remaining enterprise-grade gaps without inflating product claims.

## Release Principle

Contained GA is not a code-complete milestone.

Contained GA is achieved only when all three are true:

1. capability truth is honest under failure, drift, restart, and downgrade
2. operational behavior is deterministic and recoverable
3. release signoff is complete across engineering, security, QA, and product language

## Current Gaps

The remaining known gaps after this pass are intentionally narrow:

1. Docker is still the only shipped contained backend
2. backend-enforced host allowlists are modeled and fail closed honestly, but Docker still cannot satisfy that stronger guarantee
3. runtime-contained brokered bindings now cover `env`, `file`, `header_template`, `runtime_ticket`, and `tool_scoped_ref`, but future backends may add additional delivery mechanisms

These are not equal-priority gaps.

Recommended priority order:

1. backend interface and assurance matrix
2. credential broker v2
3. Linux-native contained backend
4. egress enforcement truth matrix
5. full signoff sweep

## Program Structure

Run this as five milestones.

### M1: Backend Interface And Assurance Matrix

Goal:

- make containment backend-specific without creating product-surface sprawl

Implementation:

- extract a contained backend interface from the current Docker-specific path
- split backend responsibilities into:
  - capability detection
  - launch preparation
  - projected workspace handoff
  - runtime execution
  - cleanup
  - backend-specific diagnostics
- persist backend capability snapshots in a way that `inspect`, `repair`, and `run` can revalidate consistently
- define an assurance capability matrix that maps:
  - backend
  - network mode
  - credential mode
  - governance mode
  - guarantees
  - degraded reasons

Target files:

- [/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/containment.ts](/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/containment.ts)
- [/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/service.ts](/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/service.ts)
- [/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/types.ts](/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/types.ts)
- [/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/state.ts](/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/state.ts)

Exit criteria:

- Docker path is reimplemented through the backend interface
- `setup`, `inspect`, `repair`, and `run` all use the same backend truth model
- no product language change is required when a second backend is added later

### M2: Credential Broker V2

Goal:

- move from env/file-only brokered delivery to a first-class contained credential binding model

Implementation:

- introduce a contained credential binding schema with kinds like:
  - `env`
  - `file`
  - `header_template`
  - `runtime_ticket`
  - `tool_scoped_ref`
- define which of those are:
  - shipped in this repo
  - deferred but modeled
- keep direct host env allowlist as an explicit degraded mode
- keep brokered env/file bindings as the stable default brokered mode
- add binding resolution, validation, rotation behavior, and expiry handling
- ensure no binding leaks secret material into:
  - state docs
  - inspect output
  - logs
  - errors

Target files:

- [/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/types.ts](/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/types.ts)
- [/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/service.ts](/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/service.ts)
- [/Users/geoffreyfernald/Documents/agentgit/packages/credential-broker/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/credential-broker/src/index.ts)

Exit criteria:

- contained runs can use a richer brokered binding model without ambient host secret reuse
- preflight, inspect, and repair all report missing/expired brokered bindings honestly
- secret material remains redacted everywhere outside runtime injection points

### M3: Linux-Native Contained Backend

Goal:

- remove single-backend risk and create a path toward stronger non-Docker containment

Implementation:

- add a Linux-native contained backend behind the shared backend interface
- reuse the same projection and governed publish-back model
- keep CLI and product surface unchanged
- surface backend-specific capability and degraded reasons in inspect/setup

Important rule:

- do not let this milestone fork restore or publication semantics
- the backend may change execution isolation, but not the product’s recovery contract

Exit criteria:

- Linux hosts can use either Docker-contained or Linux-native contained execution through the same product surface
- `inspect`, `repair`, and `remove` work identically from the user’s perspective
- drift and backend-unavailable states fail closed

### M4: Egress Truth And Enforcement Matrix

Goal:

- stop treating "proxy-aware HTTP(S) allowlist" as the end state

Implementation:

- define explicit contained egress modes:
  - `none`
  - `proxy_http_https`
  - `backend_enforced`
- map each mode to product language and guarantees
- keep proxy-based egress clearly degraded
- only surface a stronger egress guarantee when the backend can enforce it for real
- add preflight rules so stronger expected egress modes fail closed if the current backend cannot satisfy them

Exit criteria:

- the egress guarantee shown in `setup` and `inspect` matches actual backend capability
- non-proxy traffic is never misrepresented as governed
- repair can recover a degraded profile or explain exactly why it cannot

### M5: Contained GA Signoff Sweep

Goal:

- make contained GA a deliberate release event, not an accumulation of green tests

Implementation:

- run the full test matrix
- complete the release-signoff checklist
- review every product claim in CLI formatting and docs
- verify demo, inspect, restore, and remove remain coherent after the M1-M4 changes

Exit criteria:

- signoff checklist is complete
- all required tests are green
- no open blocker remains in:
  - assurance truth
  - restore semantics
  - remove/repair cleanup
  - secret leakage risk
  - backend drift handling

## Required Schema Evolution

Schema changes should be staged, migrate-on-read, and additive.

Expected additions:

1. backend-level capability snapshot normalization
- explicit backend identifier
- backend capability version
- backend-specific degraded facts

2. contained credential binding model
- saved binding kind
- saved broker source reference
- redacted delivery metadata

3. contained egress mode model
- explicit egress mode enum
- allowlist metadata where applicable
- backend-enforcement capability truth

Non-goals:

- no breaking schema rewrite
- no replacement of the current persistence model
- no new hosted control plane

## Test Matrix

Contained GA requires both deterministic tests and live backend tests.

### Unit

- assurance matrix derivation
- backend capability normalization
- credential binding parsing and migration
- egress mode formatting
- degraded-reason derivation
- allowlist parsing and validation

### Fixture And Adapter

- backend capability detection fixtures
- planner behavior across backend / assurance combinations
- verify behavior across degraded backend states
- rollback behavior with backend-specific metadata

### Integration

- `setup` / `run` / `inspect` / `restore` / `remove` / `repair` for every shipped backend
- contained credential broker flows:
  - env binding
  - file binding
  - missing binding
  - expired binding
  - rotated binding
- contained egress flows:
  - blocked
  - proxy-allowlisted
  - degraded raw-socket truth
- restart resilience between:
  - setup and run
  - run and inspect
  - inspect and restore
  - contained publish conflict and restore

### Failure And Drift

- backend unavailable after setup
- selected direct host env key missing at run time
- brokered secret removed after setup
- backend downgrade after setup
- publish-back conflict after contained run
- remove and repair after partial launch failure

### Release Validation

- full repo `typecheck`
- full repo `test`
- package-level build/typecheck/test for runtime integration
- deterministic demo latency guard
- no secret leakage in printed output

## Signoff Roles

Contained GA needs named signoff from four perspectives.

### Engineering

Engineering must sign off that:

- backend interface is stable
- no silent downgrade path exists
- restore semantics remain coherent
- no known startup / cleanup orphan states remain

### Security

Security must sign off that:

- credential handling does not leak secrets
- direct host env passthrough remains explicit and degraded
- egress claims match actual enforcement
- degraded states fail closed

### QA

QA must sign off that:

- all supported contained paths pass the release matrix
- remove / repair / restore flows behave correctly under drift and restart
- docs and CLI output match observable behavior

### Product / UX

Product or owning engineering lead must sign off that:

- assurance language is honest
- degraded states are understandable
- setup remains low-friction
- advanced mode has not turned into config sprawl

## Go / No-Go Rules

Do not call contained generic "fully production ready" if any of the following are true:

- a degraded backend can still be described as stronger than it is
- restore or remove behavior differs materially between backends without being surfaced
- a secret can leak into state, inspect, logs, or error output
- preflight allows known-unsafe launch expectations to proceed
- the egress story still over-claims beyond proxy-aware HTTP(S) control

## Recommended Immediate Next Step

Start with M1.

Why:

- it reduces future rework
- it keeps Docker from becoming architecture instead of an implementation
- it gives every later milestone one place to hang truth, testing, and release gates

The best first patch after this plan should:

1. extract the contained backend interface
2. normalize capability snapshots and degraded facts
3. add tests proving Docker now runs through that backend seam
