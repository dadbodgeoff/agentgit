# MVP Production Readiness Plan

Status date: 2026-04-03 (America/New_York)

This plan tracks execution toward the local-first MVP production-readiness bar.
Automation evidence can go green before the final contained-GA signoff record is complete.

## Current Baseline

Verified now:

- `pnpm release:verify` pass
- `pnpm py:build` pass
- installed `agentgit` smoke pass
- signed artifact pack + signature verification rehearsal pass
- recovery drill evidence archived
- operator tamper/triage tabletop evidence archived

## Gate Status

| Gate | Status | Launch Blocking? |
| --- | --- | --- |
| G1 Local-first scope lock | Green | No |
| G2 Deterministic policy + fail-closed | Green | No |
| G3 Snapshot/recovery drill reliability | Green | No |
| G4 Journal integrity + audit flow stability | Green | No |
| G5 Release/rollback/signed artifacts | Green | No |
| G6 Security baseline completion | Green | No |
| G7 Operator failure-mode runbooks | Green | No |
| G8 Lint/format/coverage CI gates | Green | No |

## Phase 0: Launch Blockers (Completed)

### P0.1 Signed artifact workflow gate (G5)

Outcome required:
- release artifacts cryptographically signed
- verification hard-fails on signature mismatch/missing signature

Status: `Completed`

Completion evidence:
- [pack-release-artifacts.mjs](/Users/geoffreyfernald/Documents/agentgit/scripts/pack-release-artifacts.mjs)
- [verify-release-artifacts.mjs](/Users/geoffreyfernald/Documents/agentgit/scripts/verify-release-artifacts.mjs)
- [release.yml](/Users/geoffreyfernald/Documents/agentgit/.github/workflows/release.yml)

### P0.2 Security dependency scanning gate (G6)

Outcome required:
- Node and Python dependency vulnerability scanning mandatory
- security workflow version drift removed

Status: `Completed`

Completion evidence:
- [audit-python-dependencies.mjs](/Users/geoffreyfernald/Documents/agentgit/scripts/audit-python-dependencies.mjs)
- [ci.yml](/Users/geoffreyfernald/Documents/agentgit/.github/workflows/ci.yml)
- [security-hardening.yml](/Users/geoffreyfernald/Documents/agentgit/.github/workflows/security-hardening.yml)

### P0.3 Deterministic policy replay gate (G2)

Outcome required:
- deterministic policy outcomes with golden fixtures
- restart consistency covered in daemon integration tests

Status: `Completed`

Completion evidence:
- [index.test.ts](/Users/geoffreyfernald/Documents/agentgit/packages/policy-engine/src/index.test.ts)
- [deterministic-policy-golden.json](/Users/geoffreyfernald/Documents/agentgit/packages/policy-engine/src/test-fixtures/deterministic-policy-golden.json)
- [server.integration.test.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-daemon/src/server.integration.test.ts)

### P0.4 Recovery drill evidence signoff (G3)

Outcome required:
- executed drill with archived artifacts and measured RTO/RPO

Status: `Completed`

Completion evidence:
- [run-recovery-drill.mjs](/Users/geoffreyfernald/Documents/agentgit/scripts/run-recovery-drill.mjs)
- [Recovery Drill Summary](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/recovery-drills/2026-04-02-mvp-recovery-drill/summary.json)

## Phase 1: MVP Hardening (Completed)

### P1.1 Scope lock governance (G1 sustainment)

Status: `Completed`

Completion evidence:
- [verify-release-scope-claims.mjs](/Users/geoffreyfernald/Documents/agentgit/scripts/verify-release-scope-claims.mjs)
- [RELEASE-CHECKLIST.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/RELEASE-CHECKLIST.md)

### P1.2 Operator tabletop signoff (G7 sustainment)

Status: `Completed`

Completion evidence:
- [run-operator-tabletop.mjs](/Users/geoffreyfernald/Documents/agentgit/scripts/run-operator-tabletop.mjs)
- [Operator Tabletop Summary](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/operator-tabletop/2026-04-02-tamper-and-triage/summary.json)
- [CLI-OPERATOR-RUNBOOK.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/CLI-OPERATOR-RUNBOOK.md)

### P1.3 Coverage ratchet policy (G8 sustainment)

Status: `Completed`

Completion evidence:
- [verify-coverage-ratchet.mjs](/Users/geoffreyfernald/Documents/agentgit/scripts/verify-coverage-ratchet.mjs)
- [coverage-threshold-baseline.json](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/coverage-threshold-baseline.json)
- [COVERAGE-RATCHET-POLICY.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/COVERAGE-RATCHET-POLICY.md)

## Phase 2: Cloud Features (Deferred, Not MVP Blockers)

Deferred and explicitly excluded from MVP claim:

- hosted MCP execution
- durable hosted workers/queue orchestration
- browser/computer governance
- generic governed HTTP adapter

## Definition Of MVP Ready

Automation requirements are satisfied for the local-first launch contract when release verification, Python packaging, and installed-artifact smokes are green.
Final launch approval still requires a completed contained-GA signoff record.
