# AgentGit Production-Beta Evidence Report

Generated from local qualification artifacts on 2026-04-27.

## Executive Summary

AgentGit has repeatable local production-beta qualification evidence across the agent harness, snapshot/recovery engine, run journal, connector loop, cloud UI, security tripwires, package install path, and public API contract.

Current executable local gate result:

| Gate | Result |
| --- | ---: |
| Passing executable suites | 32 |
| Failed executable suites | 0 |
| Externally gated suites | 7 |
| Aggregate passing-suite runtime | 10m 32.7s |
| Full gate artifact root | `engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r7` |
| Isolated benchmark artifact root | `engineering-docs/release-signoff/overnight/production-beta-release-readiness-perf-isolated-2026-04-26` |

The correct public phrasing is: local production-beta qualification or production-beta hardening. Do not claim fully production-ready or hosted production tested from this evidence alone.

## Product Brief For Deck Generation

AgentGit is local-first execution authority for autonomous agents. It sits between an agent runtime and the operating system, shell, files, MCP tools, and owned integrations.

The product thesis is that autonomous agents need a better control model than a binary approve/deny gate. Traditional gating keeps users safe by interrupting the agent whenever risk appears. That works for isolated commands, but it breaks the value of autonomous flow: the agent keeps stopping, the operator keeps approving, and the system still lacks strong rollback evidence when something goes wrong.

AgentGit adds the missing third path: `allow_with_snapshot`. When an action is risky but recoverable, AgentGit captures a rollback boundary before execution, routes the side effect through a governed adapter, records the action/policy/snapshot/result chain in an append-only journal, and precomputes recovery guidance. The agent can keep moving because the system has preserved a concrete recovery point and a durable audit trail.

Deny still exists for actions that should never run automatically: secret paths, policy/control surfaces, outside-workspace writes, symlink escapes, and effects the system cannot honestly recover. Ask/review still exists for ambiguous or irreversible operations. The key distinction is that human interruption is reserved for actions that actually need judgment; recoverable work can continue under snapshot-backed governance.

Slide framing:

- AgentGit turns agent governance from a binary permission checkpoint into a recoverable execution layer.
- The normal flow is no longer only approve or deny. The important path is snapshot, allow, continue, audit, recover if needed.
- The product promise is not blind autonomy. It is measured autonomy with rollback boundaries, policy enforcement, journaled evidence, and recovery plans.
- Core flow: normalize action -> evaluate policy -> snapshot when recoverable -> execute through governed adapter -> append to journal -> precompute recovery -> expose timeline/audit/helper views.

## Source Of Truth

- Full matrix report: `engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r7/REPORT.md`
- Full matrix summary JSON: `engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r7/summary.json`
- Isolated perf report: `engineering-docs/release-signoff/overnight/production-beta-release-readiness-perf-isolated-2026-04-26/perf-capacity-benchmarks/evidence/REPORT.md`
- Isolated perf summary JSON: `engineering-docs/release-signoff/overnight/production-beta-release-readiness-perf-isolated-2026-04-26/perf-capacity-benchmarks/evidence/summary.json`
- Perf isolation decision: `engineering-docs/release-signoff/overnight/perf-isolation-follow-up-2026-04-26.md`
- Deck evidence prompt: `marketing/06-production-beta-deck-evidence-prompt.md`

## Performance Benchmarks

Use the isolated benchmark run for customer/SRE/deck performance numbers. The full r7 matrix numbers remain useful as pass/fail gate evidence, but they should not be presented as the standalone latency baseline because the isolated rerun shows the r7 spike was full-matrix contention.

Command:

```sh
pnpm qualification:release-readiness -- --suite perf-capacity-benchmarks --timestamp release-readiness-perf-isolated-2026-04-26
```

Benchmark status: PASS. Iterations: 8. Budget failures: 0.

### Latency Percentiles

| Operation | Count | p50 | p95 | p99 | Max | Budget |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Action submission to governance decision | 8 | 197.44ms | 209.28ms | 209.28ms | 209.28ms | p99 <= 2500ms |
| Snapshot creation | 8 | 180.42ms | 202.74ms | 202.74ms | 202.74ms | p99 <= 2500ms |
| Snapshot restore | 8 | 171.26ms | 199.16ms | 199.16ms | 199.16ms | p99 <= 3000ms |
| Audit query | 8 | 166.34ms | 180.48ms | 180.48ms | 180.48ms | p99 <= 2000ms |

### Throughput

| Metric | Measured |
| --- | ---: |
| Actions per second | 5.03 |
| Snapshots per minute | 105.57 |

### Cold Start

| Metric | Measured | Budget |
| --- | ---: | ---: |
| Daemon boot | 1123.61ms | <= 10000ms |
| First action after boot | 205.98ms | n/a |
| First action after restart | 229.21ms | <= 3000ms |

### Resource Samples

| Sample | RSS | CPU |
| --- | ---: | ---: |
| after_boot | 136.97 MB | 2.9% |
| after_actions | 148.47 MB | 3.7% |
| after_snapshots_and_restores | 176.25 MB | 3.8% |
| after_audit_queries | 177.31 MB | 3.2% |
| after_restart_first_action | 148.75 MB | 18.1% |

### Perf Isolation Comparison

| Run | Action p99 | Snapshot p99 | Restore p99 | Audit p99 | Actions/sec | Snapshots/min |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| r2 full matrix | 281.60ms | 354.50ms | 494.46ms | 1208.23ms | 4.59 | 75.31 |
| r7 full matrix | 258.59ms | 1931.82ms | 1684.53ms | 756.65ms | 4.45 | 33.17 |
| isolated follow-up | 209.28ms | 202.74ms | 199.16ms | 180.48ms | 5.03 | 105.57 |

Decision: use the isolated follow-up for latency claims. Keep r7 full matrix as pass/fail qualification evidence.

## Agent Harness, Governance, And Recovery Proof

### OpenClaw Stress

Command profile: `openclaw`, 36 iterations, recover every action, shell share 0.75.

| Metric | Result |
| --- | ---: |
| Attempted actions | 36 |
| Completed actions | 11 |
| Denied actions | 25 |
| Snapshot-backed actions | 11 |
| Reversible recoveries executed | 5 |
| Compensatable recoveries planned | 6 |
| Command failures | 0 |
| Expected blocked mismatches | 0 |
| Exact restore mismatches | 0 |
| Checkpoint restore mismatches | 0 |

Explicit checkpoint proof:

| Field | Result |
| --- | --- |
| Checkpoint | `run_019dcc1d14d27562ab4ceb4d4e80df7c#124` |
| Recovered | true |
| Exact restore match | true |
| Drift after restore | none: no added, changed, or deleted files |

Evidence source: `engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r7/openclaw-stress/command.json` includes the emitted summary; `engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r7/openclaw-stress/session-root.txt` records the original temporary session root.

### Scale Soak

Command profile: `openclaw`, 96 iterations, recover every second action, shell share 0.85.

| Metric | Result |
| --- | ---: |
| Attempted actions | 96 |
| Completed actions | 31 |
| Denied actions | 65 |
| Snapshot-backed actions | 31 |
| Recovery plans | 16 |
| Reversible recoveries | 8 |
| Compensatable recoveries | 8 |
| Command failures | 0 |
| Expected blocked mismatches | 0 |
| Exact restore mismatches | 0 |
| Checkpoint restore mismatches | 0 |

Explicit checkpoint proof:

| Field | Result |
| --- | --- |
| Checkpoint | `run_019dcc205bd673b6818203e70979c81c#312` |
| Recovered | true |
| Exact restore match | true |
| Drift after restore | none: no added, changed, or deleted files |

Evidence source: `engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r7/scale-soak/command.json` includes the emitted summary; `engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r7/scale-soak/session-root.txt` records the original temporary session root.

### Concurrent Agents

Five overlapping autonomous stress sessions ran in isolated workspaces.

| Metric | Result |
| --- | ---: |
| Agents | 5 |
| Attempted actions | 60 |
| Restore mismatches | 0 |
| Checkpoint mismatches | 0 |

Per-agent evidence:

| Agent | Attempted | Denied | Snapshots | Exact restore mismatches | Checkpoint mismatches |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 12 | 9 | 3 | 0 | 0 |
| 2 | 12 | 8 | 4 | 0 | 0 |
| 3 | 12 | 8 | 4 | 0 | 0 |
| 4 | 12 | 9 | 3 | 0 | 0 |
| 5 | 12 | 8 | 4 | 0 | 0 |

Evidence path: `engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r7/concurrent-agents/concurrent-summary.json`.

### Data Integrity Property Suite

Seeded property-style restore testing ran three independent action sequences.

| Seed | Attempted | Snapshot-backed | Exact restore mismatches | Checkpoint mismatches |
| ---: | ---: | ---: | ---: | ---: |
| 2026042701 | 18 | 3 | 0 | 0 |
| 2026042702 | 18 | 4 | 0 | 0 |
| 2026042703 | 18 | 4 | 0 | 0 |

Totals: 54 attempted actions, 0 restore mismatches, 0 failures.

Evidence path: `engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r7/data-integrity-property/property-seed-summary.json`.

### Backup And Restore Drill

| Metric | Result |
| --- | --- |
| RTO | 340ms |
| RPO target | latest valid action boundary |
| Restored | true |
| Recovery strategy | `restore_snapshot` |
| File exists after recovery | true |
| File contents after recovery | `drill-v1` |

Evidence path: `engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r7/backup-restore-drill/recovery-drill/summary.json`.

### Crash Restart

Status: passed.

Proof covered:

- Daemon rehydrates persisted runs after restart.
- `register_run` replay is idempotent across restart.
- Explicit run checkpoint creation and restore survive restart boundaries.
- Cloud connector keeps pending events in durable outbox across restart.

Artifacts:

- `engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r7/crash-restart/command-1.json`
- `engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r7/crash-restart/command-2.json`

### Snapshot Regression And Maintenance

Snapshot regression status: passed.

Proof covered:

- Workspace-index restore semantics.
- Snapshot engine exactness.

Snapshot maintenance status: passed.

Proof covered:

- Snapshot compaction.
- Restore preview overlap reporting.
- Subset restore.
- Inline maintenance jobs.
- Orphaned snapshot container garbage collection.
- Synthetic snapshot anchor rebase.

Artifacts:

- `engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r7/snapshot-regression/`
- `engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r7/snapshot-maintenance/`

## Security And Containment Proof

### Agent Adversarial Campaign

| Metric | Result |
| --- | ---: |
| Probes | 10 |
| Passed | 10 |
| Failed | 0 |
| Content leaks | 0 |
| Filesystem changes from probes | 0 |

Probe coverage included protected `.env` reads/writes, outside-workspace absolute paths, symlink escapes, policy control-surface writes, and governed filesystem outside-root writes.

Evidence path: `engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r7/security-agent-adversarial/campaign-0/summary.json`.

### Static Analysis

Semgrep status: passed.

| Metric | Result |
| --- | ---: |
| Findings | 0 |
| Blocking findings | 0 |
| Rules run | 5 |
| Targets scanned | 426 |
| Files tracked by git considered | 1760 |
| Parsed lines | about 100% |

Artifact paths:

- `engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r7/security-static-analysis/command.json`
- `engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r7/security-static-analysis/semgrep.json`

### Secret Scanning

gitleaks status: passed.

| Metric | Result |
| --- | ---: |
| Findings | 0 |
| Targets | 29 source/config/doc targets plus git history |
| Git commits scanned | 50 |
| Bytes scanned in git history run | about 25.46 MB |

Artifact root: `engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r7/security-secret-scan/`.

### Dependency Audit

Status: passed at configured severity threshold.

| Surface | Result |
| --- | --- |
| Node production audit | 10 moderate vulnerabilities found, no high-or-higher failures under `--audit-level=high` |
| Python audit | `ok=true`, 2 requirements audited |

Artifact path: `engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r7/security-dependency-audit/command-1.json`.

### SBOM

Status: passed.

| Metric | Result |
| --- | --- |
| Format | CycloneDX |
| Spec version | 1.5 |
| Scope | workspace manifests plus packed release artifacts |
| Workspace components | 41 |
| Packed artifact components | 16 |
| Root license | Apache-2.0 |

Artifact path: `engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r7/security-sbom/release-sbom.cdx.json`.

### Authz Matrix

Status: passed.

Proof covered:

- Auth guards.
- Workspace access checks.
- Cross-resource repository access.
- Snapshot restore authorization.
- Team settings privileged route handling.

Artifact path: `engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r7/security-authz-matrix/command-1.json`.

### Redaction And Log Quality

Sensitive redaction status: passed.

| Metric | Result |
| --- | ---: |
| Artifact files scanned | 337 |
| Leaks | 0 |

Log quality status: passed.

| Metric | Result |
| --- | ---: |
| Log artifact files scanned | 72 |
| Secret-shaped or obvious SSN-shaped findings | 0 |

Artifact paths:

- `engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r7/sensitive-redaction/redaction-scan.json`
- `engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r7/log-quality/log-quality-scan.json`

### License Audit

Status: passed.

| Metric | Result |
| --- | ---: |
| Workspace package manifests checked | 25 |
| Failures | 0 |
| GPL/AGPL workspace packages in release scope | 0 |
| Private missing-license warnings | 10 |

Artifact path: `engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r7/license-audit/license-audit.json`.

## Cloud UI, Browser, And User-Facing Proof

### Cloud Build

Status: passed.

Command: `pnpm --filter @agentgit/cloud-ui build`.

Proof: production cloud bundle compiles with the current workspace package graph.

### Browser Surface Smoke

Status: passed.

Command: `pnpm smoke:cloud-hosted`.

Proof: local hosted browser smoke covers repo, run, action, snapshot, activity, and audit surfaces rendering correctly.

Claim boundary: without a deployed `--base-url`, this is local hosted browser evidence, not deployed-origin production smoke.

### Accessibility

Status: passed.

Command coverage:

- `pnpm --filter @agentgit/cloud-ui build`
- `pnpm --filter @agentgit/cloud-ui exec -- playwright test --config=playwright.config.ts accessibility.spec.ts`

Proof: cloud UI accessibility scan passes with the configured violations budget.

### Visual Regression

Status: passed.

Command coverage:

- `pnpm --filter @agentgit/cloud-ui build`
- `pnpm quality:visual`

Approved local Chromium baselines:

- `apps/agentgit-cloud/e2e/__screenshots__/landing.png`
- `apps/agentgit-cloud/e2e/__screenshots__/pricing.png`
- `apps/agentgit-cloud/e2e/__screenshots__/docs.png`
- `apps/agentgit-cloud/e2e/__screenshots__/sign-in.png`

Claim boundary: this proves local Chromium screenshot diffs against the approved baseline. Browser/device matrix visual baselines still belong in CI.

### Docs And DX Quickstart

Status: passed.

Proof covered:

- Release artifacts pack successfully.
- Public packages smoke in a clean install path.
- Installed CLI smoke works outside the monorepo.
- Installed agent runtime smoke works outside the monorepo.

Artifact root: `engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r7/docs-dx-quickstart/`.

### Error Message Audit

Status: passed.

Proof covered representative controlled/actionable error paths for:

- Approval decisions.
- Repo connection.
- Snapshot restore.
- Workspace settings.
- Sync events.
- Command ack.
- API sessions.
- Request body parsing.

## Connector, API, Package, And Data Surface Proof

### Connector Loop

Status: passed.

Proof covered:

- Cloud sync protocol.
- Control-plane state.
- Cloud connector core behavior.
- Sync register, heartbeat, events, command pull, and command ack cloud routes.

Artifact root: `engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r7/connector-loop/`.

### Migration Compatibility

Status: passed.

Proof covered:

- CLI compatibility tests.
- Release package configuration tests.
- Sync schema route compatibility behavior.

Claim boundary: current evidence is synthetic compatibility and schema behavior, not a corpus of real historical deployed bundles.

### Audit Export

Status: passed.

Proof: CSV/JSON audit exports preserve ordering, links, authorization, and redaction-safe payloads.

### Package Install

Status: passed.

Proof covered:

- Packed release artifacts created.
- Public package smoke passed from packed artifacts.
- Installed CLI smoke passed from packed artifacts.
- Installed agent runtime smoke passed from packed artifacts.

Artifact root: `engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r7/package-install/`.

### Public API Contract

Status: passed.

Proof covered:

- `@agentgit/schemas` tests.
- `@agentgit/cloud-sync-protocol` tests.
- Schema examples now validate through the repo-owned Node/AJV validator rather than an undeclared global Python dependency.

### Data Fuzzing

Status: passed.

| Metric | Result |
| --- | ---: |
| Surfaces | 6 |
| Iterations per surface | 32 |
| Failure count | 0 |

Surfaces:

- Connector registration.
- Event batch.
- Command pull.
- Command ack.
- Audit bundle verifier.
- Authority CLI arguments.

Evidence path: `engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r7/data-fuzzing/fuzzing/summary.json`.

### Observability Coverage

Status: passed.

| Metric | Result |
| --- | ---: |
| Test files | 2 passed |
| Tests | 3 passed |

Proof: Prometheus-format cloud metrics emit non-zero API response and route-error samples behind the metrics route coverage.

Claim boundary: this validates cloud route metrics locally. Daemon/runtime OTel export should be added before GA.

## Full Suite Ledger

| Suite | Status | Duration | Summary |
| --- | --- | ---: | --- |
| snapshot-regression | passed | 1.5s | All commands completed successfully. |
| openclaw-stress | passed | 16.7s | attempted=36, denied=25, snapshots=11, exact_restore_mismatches=0, checkpoint_mismatches=0 |
| cloud-build | passed | 33.1s | All commands completed successfully. |
| browser-surface | passed | 65.1s | All commands completed successfully. |
| crash-restart | passed | 70.6s | All commands completed successfully. |
| concurrent-agents | passed | 18.9s | agents=5, attempted=60, restore_mismatches=0 |
| connector-loop | passed | 9.4s | All commands completed successfully. |
| sensitive-redaction | passed | 254ms | No secret tripwires or common token shapes were found across 337 scanned artifact file(s). |
| scale-soak | passed | 30.3s | attempted=96, denied=65, snapshots=31, restore_mismatches=0 |
| snapshot-maintenance | passed | 69.6s | All commands completed successfully. |
| migration-compat | passed | 3.3s | All commands completed successfully. |
| audit-export | passed | 3.0s | All commands completed successfully. |
| package-install | passed | 31.0s | All commands completed successfully. |
| diff-check | passed | 36ms | All commands completed successfully. |
| perf-capacity-benchmarks | passed | 24.0s | full-matrix pass; use isolated perf report for latency claims |
| security-dependency-audit | passed | 15.9s | All commands completed successfully. |
| security-sbom | passed | 4.6s | components=41, artifact_components=16, format=CycloneDX |
| security-static-analysis | passed | 7.9s | semgrep_findings=0 |
| security-secret-scan | passed | 12.2s | gitleaks_findings=0, targets=29 |
| security-authz-matrix | passed | 4.7s | All commands completed successfully. |
| security-agent-adversarial | passed | 7.1s | probes=10, passed=10, failed=0, content_leaks=0, filesystem_changes=0 |
| data-integrity-property | passed | 28.9s | seeds=3, attempted=54, restore_mismatches=0 |
| data-fuzzing | passed | 3.7s | surfaces=6, iterations=32, failure_count=0 |
| backup-restore-drill | passed | 3.1s | rto_ms=340, rpo_target=latest valid action boundary, restored=true |
| observability-coverage | passed | 1.2s | All commands completed successfully. |
| log-quality | passed | 38ms | No secret-shaped values or obvious SSN-shaped PII were found in 72 log artifact file(s). |
| accessibility | passed | 60.0s | All commands completed successfully. |
| visual-regression | passed | 68.2s | All commands completed successfully. |
| docs-dx-quickstart | passed | 33.0s | All commands completed successfully. |
| public-api-contract | passed | 1.0s | All commands completed successfully. |
| error-message-audit | passed | 4.5s | All commands completed successfully. |
| license-audit | passed | 5ms | packages=25, failures=0, private_missing_license_warnings=10 |

## Internal Claim Boundaries

Keep these out of deck copy, but keep them in the internal release-readiness file so claims stay honest.

| Area | Boundary |
| --- | --- |
| Reliability chaos | Needs disposable VM/container or destructive harness for kill -9 mid-snapshot, disk-full WAL append, network partition, clock skew, and partial corruption. |
| Alert/runbook smoke | Needs deployed staging monitoring and alert delivery integrations. |
| OS/Node matrix | Needs CI runners for Linux x64, Linux arm64, macOS arm64, macOS x64, and Windows across claimed Node versions. |
| Network conditions | Needs network emulation or staging environment for high latency, loss, captive portal, and IPv6-only behavior. |
| Browser matrix | Needs Chrome/Firefox/Safari and mobile device matrix beyond local Chromium. |
| Telemetry/privacy review | Needs product/privacy decision artifacts and deployed telemetry config. |
| Data residency review | Needs deployed storage topology and customer-region policy decisions. |

## Deck-Ready Evidence Copy

Use this version for slides:

AgentGit now has repeatable local production-beta qualification gates across governed agent actions, snapshots, recovery, audit evidence, security checks, browser surfaces, package install, and API contracts. The April 26 qualification pass produced 32 passing executable suites and 0 executable failures.

Measured isolated local performance:

- Governance decision p99: 209.28ms.
- Snapshot creation p99: 202.74ms.
- Snapshot restore p99: 199.16ms.
- Audit query p99: 180.48ms.
- Throughput: 5.03 actions/sec and 105.57 snapshots/min.
- Daemon boot: 1123.61ms.
- First action after restart: 229.21ms.

Correctness proof:

- OpenClaw stress: 36 attempted actions, 25 denials, 11 snapshot-backed actions, 0 exact restore mismatches, 0 checkpoint mismatches.
- Scale soak: 96 attempted actions, 65 denials, 31 snapshot-backed actions, 0 restore mismatches.
- Concurrent agents: 5 agents, 60 attempted actions, 0 restore mismatches.
- Data integrity property suite: 3 seeds, 54 attempted actions, 0 restore mismatches.
- Backup/restore drill: RTO 340ms, RPO target latest valid action boundary, restored true.
- Adversarial containment: 10/10 probes passed, 0 content leaks, 0 filesystem changes.

Security and quality proof:

- Semgrep static analysis: 0 findings.
- gitleaks secret scan: 0 findings across git history and 29 source/config/doc targets.
- CycloneDX SBOM generated for workspace and packed artifacts.
- Authz, audit export, public schema, connector sync, package install, accessibility, and visual regression gates all passed.
- Observability coverage confirms Prometheus-format route metrics emit non-zero API response and route-error samples.
