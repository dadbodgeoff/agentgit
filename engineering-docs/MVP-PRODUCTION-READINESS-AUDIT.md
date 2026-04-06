# MVP Production Readiness Audit

Status date: 2026-04-03 (America/New_York)

This is a repository-grounded audit of MVP production readiness for the local-first launch contract.
It summarizes automation evidence and code-state verification; it is not a substitute for the human signoff record in the contained-GA checklist.

## Verification Snapshot

Commands executed against the current workspace:

| Command | Result | Notes |
| --- | --- | --- |
| `pnpm lint` | Pass | ESLint gate is active and clean. |
| `pnpm format:check` | Pass | Prettier gate is active and clean. |
| `pnpm release:verify:claims` | Pass | Changeset release-note scope assertion is active and green. |
| `pnpm release:verify:coverage-ratchet` | Pass | Configured thresholds plus measured aggregate/per-package coverage are ratchet-protected. |
| `pnpm security:audit` | Pass | Node and Python dependency vulnerability scanning gate is active and green. |
| `pnpm test:coverage` | Pass | TypeScript tests + coverage thresholds pass. |
| `pnpm py:test` | Pass | Python SDK tests pass. |
| `pnpm py:build` | Pass | Python SDK wheel/sdist build and install smoke pass. |
| `pnpm smoke:cli-install` | Pass | Public tarballs install and execute outside monorepo. |
| `pnpm smoke:agent-runtime-install` | Pass | Public `agentgit` tarball installs and executes outside monorepo. |
| `pnpm smoke:cli-compat` | Pass | Compatibility/upgrade/rollback and legacy audit-bundle checks pass. |
| `pnpm release:verify` | Pass | End-to-end release verification is green. |
| `pnpm release:pack --signing-mode required` + `verify-release-artifacts` | Pass | Signed artifact pack + verification rehearsal passes with real cryptographic keys. |
| `node scripts/run-recovery-drill.mjs` | Pass | Recovery drill executed and archived. |
| `node scripts/run-operator-tabletop.mjs` | Pass | Tamper/triage tabletop executed and archived. |

## Gate Scorecard

Legend:
- `Green`: launch-ready for MVP gate

| Gate | Status | Why |
| --- | --- | --- |
| G1 Local-first scope only | `Green` | Scope lock assertion is enforced in release-note verification and docs/runtime remain local-first. |
| G2 Deterministic policy + fail-closed fully tested | `Green` | Deterministic policy golden-fixture tests and daemon restart consistency test are active. |
| G3 Snapshot/recovery reliability with repeatable drills | `Green` | Recovery drill runbook exists and an executed evidence bundle is archived. |
| G4 Journal integrity + audit export/verify stability | `Green` | Export/verify/report/share/compare and tamper detection are integration-tested and validated by tabletop evidence. |
| G5 Release pipeline + rollback + signed artifacts | `Green` | Release workflow now requires signed artifacts and signature verification before publish. |
| G6 Security baseline complete | `Green` | Node+Python dependency vulnerability scanning gate is active; security workflow toolchain is baseline-aligned. |
| G7 Operator runbooks for failure modes | `Green` | Failure-mode matrix, SEV escalation, tamper response, and tabletop evidence/signoff are documented. |
| G8 Lint/format + coverage threshold in CI | `Green` | Enforced in CI; configured thresholds and measured coverage baselines are ratchet-protected. |

Automation readiness: `Green`.
Final contained-GA launch approval: `Pending human signoff record`.

## Area Closure Summary

### 1) Scope Contract (G1)

Current setup:
- Local-first scope is explicitly enforced.
- Release-note scope check now blocks hosted/cloud claims unless explicitly deferred.

Evidence:
- [verify-release-scope-claims.mjs](/Users/geoffreyfernald/Documents/agentgit/scripts/verify-release-scope-claims.mjs)
- [README.md](/Users/geoffreyfernald/Documents/agentgit/README.md)
- [CURRENT-IMPLEMENTATION-STATE.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/CURRENT-IMPLEMENTATION-STATE.md)

### 2) Policy Determinism + Fail-Closed (G2)

Current setup:
- Deterministic policy golden fixtures are added and enforced.
- Daemon restart consistency for policy explanations is integration-tested.

Evidence:
- [index.test.ts](/Users/geoffreyfernald/Documents/agentgit/packages/policy-engine/src/index.test.ts)
- [deterministic-policy-golden.json](/Users/geoffreyfernald/Documents/agentgit/packages/policy-engine/src/test-fixtures/deterministic-policy-golden.json)
- [server.integration.test.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-daemon/src/server.integration.test.ts)

### 3) Snapshot/Recovery Drills (G3)

Current setup:
- Repeatable drill script and runbook exist.
- Executed drill evidence is archived.

Evidence:
- [run-recovery-drill.mjs](/Users/geoffreyfernald/Documents/agentgit/scripts/run-recovery-drill.mjs)
- [RECOVERY-DRILL-RUNBOOK.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/RECOVERY-DRILL-RUNBOOK.md)
- [Recovery Drill Report](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/recovery-drills/2026-04-02-mvp-recovery-drill/REPORT.md)

### 4) Journal Integrity + Audit Workflows (G4)

Current setup:
- Audit verification and tamper detection are proven by integration tests and live tabletop evidence.

Evidence:
- [main.integration.test.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-cli/src/main.integration.test.ts)
- [run-operator-tabletop.mjs](/Users/geoffreyfernald/Documents/agentgit/scripts/run-operator-tabletop.mjs)
- [Operator Tabletop Report](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/operator-tabletop/2026-04-02-tamper-and-triage/REPORT.md)

### 5) Release, Rollback, Signed Artifacts (G5)

Current setup:
- Signed artifact creation and signature verification are wired as hard gates in release workflow.
- Local rehearsal with real keys succeeded.

Evidence:
- [pack-release-artifacts.mjs](/Users/geoffreyfernald/Documents/agentgit/scripts/pack-release-artifacts.mjs)
- [verify-release-artifacts.mjs](/Users/geoffreyfernald/Documents/agentgit/scripts/verify-release-artifacts.mjs)
- [release.yml](/Users/geoffreyfernald/Documents/agentgit/.github/workflows/release.yml)

### 6) Security Baseline (G6)

Current setup:
- Dependency vulnerability scanning for Node and Python is now enforced.
- Security-hardening workflow now matches repo Node/pnpm baselines.

Evidence:
- [audit-python-dependencies.mjs](/Users/geoffreyfernald/Documents/agentgit/scripts/audit-python-dependencies.mjs)
- [ci.yml](/Users/geoffreyfernald/Documents/agentgit/.github/workflows/ci.yml)
- [security-hardening.yml](/Users/geoffreyfernald/Documents/agentgit/.github/workflows/security-hardening.yml)

### 7) Operator Runbooks (G7)

Current setup:
- Incident/failure/tamper runbooks are complete and now backed by tabletop signoff evidence.

Evidence:
- [CLI-OPERATOR-RUNBOOK.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/CLI-OPERATOR-RUNBOOK.md)
- [Operator Tabletop Summary](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/operator-tabletop/2026-04-02-tamper-and-triage/summary.json)

### 8) Lint/Format/Coverage CI Gates (G8)

Current setup:
- Lint/format/coverage are enforced and green.
- Coverage ratchet policy now covers both threshold configuration and measured coverage output.

Evidence:
- [verify-coverage-ratchet.mjs](/Users/geoffreyfernald/Documents/agentgit/scripts/verify-coverage-ratchet.mjs)
- [coverage-threshold-baseline.json](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/coverage-threshold-baseline.json)
- [COVERAGE-RATCHET-POLICY.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/COVERAGE-RATCHET-POLICY.md)

## Remaining Explicitly Deferred Cloud-Later Features

These are intentionally deferred and remain non-blocking for MVP:

- hosted MCP execution as a production claim
- durable hosted worker orchestration as a production claim
- browser/computer governance
- generic governed HTTP adapter
