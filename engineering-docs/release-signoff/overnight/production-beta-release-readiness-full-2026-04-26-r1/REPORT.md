# Production Beta Qualification Report

Generated: 2026-04-26T22:06:49.283Z
Gate status: failed
Artifact root: /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1

## Suite Results

| Suite | Required | Status | Duration | Production implication |
| --- | --- | --- | --- | --- |
| snapshot-regression | yes | passed | 1.5s | Snapshot and workspace-index restore semantics must stay exact before user data is trusted. |
| openclaw-stress | yes | passed | 24.5s | Governed local agent actions, denials, snapshots, recoveries, and explicit checkpoints must pass together. |
| cloud-build | yes | passed | 28.4s | The production cloud bundle must compile with the workspace package graph used by the local product. |
| browser-surface | yes | passed | 63.6s | The cloud UI smoke path must prove repo, run, action, snapshot, activity, and audit surfaces render correctly. |
| crash-restart | yes | passed | 68.7s | Daemon, journal, checkpoint, restore, and connector outbox state must survive restart boundaries without false success. |
| concurrent-agents | yes | passed | 15.6s | Five overlapping autonomous stress sessions must keep session ownership, checkpoints, and restore evidence isolated. |
| connector-loop | yes | passed | 6.7s | Restore, replay, approval, heartbeat, command pull, and ack paths must round-trip through the local connector contract. |
| sensitive-redaction | yes | passed | 137ms | Known synthetic secrets and common token shapes must not leak into qualification artifacts, session reports, or browser test output. |
| scale-soak | yes | passed | 28.6s | A 96-iteration beta-scale OpenClaw burst must keep snapshots and recoveries exact across a heavier local run. |
| snapshot-maintenance | yes | passed | 66.3s | Snapshot GC, synthetic anchor rebase, compaction, WAL checkpointing, and restore previews must preserve recovery honesty. |
| migration-compat | yes | passed | 1.8s | Synthetic audit-bundle compatibility, CLI compatibility manifests, and sync-schema incompatibilities must be handled deliberately. |
| audit-export | yes | passed | 2.0s | CSV/JSON audit exports must preserve ordering, links, authorization, and redaction-safe payloads. |
| package-install | yes | passed | 57.7s | Packed npm artifacts must install into a clean project and the installed CLIs/runtime smoke paths must work outside the monorepo. |
| diff-check | yes | passed | 66ms | Whitespace and patch hygiene must be clean before publishing release evidence. |
| perf-capacity-benchmarks | yes | passed | 10.4s | Measured latency percentiles, throughput, cold-start time, and resource samples must be available for SRE review. |
| reliability-chaos | yes | blocked | 0ms | Fault injection for kill -9 mid-snapshot, disk-full WAL append, network partition, clock skew, and partial filesystem corruption must produce measured RTO/RPO. |
| security-dependency-audit | yes | passed | 10.8s | Node and Python dependency audits must pass the configured severity threshold. |
| security-sbom | yes | passed | 2.9s | A machine-readable SBOM must exist for workspace and packed release artifacts. |
| security-static-analysis | yes | blocked | 0ms | Semgrep or CodeQL must scan injection, path traversal, SSRF, hardcoded secrets, and unsafe deserialization classes. |
| security-secret-scan | yes | blocked | 0ms | gitleaks or trufflehog must scan git history, working tree, and packed artifacts. |
| security-authz-matrix | yes | passed | 2.9s | Authentication and authorization route tests must cover guards, token/session paths, cross-resource access, and privileged actions. |
| security-agent-adversarial | yes | passed | 7.2s | Agent-specific governance bypass, shell boundary, and secret-redaction adversarial campaign must pass. |
| data-integrity-property | yes | passed | 30.6s | Multiple seeded action sequences must preserve exact restore-to-checkpoint properties with zero mismatches. |
| data-fuzzing | yes | blocked | 0ms | Audit bundle parser, sync protocol decoder, and CLI argument surfaces must run fuzz corpora. |
| backup-restore-drill | yes | passed | 3.1s | A measured recovery drill must prove restore behavior, RTO, and recovery evidence on a fresh temporary workspace. |
| observability-coverage | yes | blocked | 0ms | Prometheus or OpenTelemetry metrics must cover core operations with non-zero samples under qualification load. |
| log-quality | yes | passed | 21ms | Qualification logs must not contain secret-shaped values or obvious PII. |
| alert-runbook-smoke | yes | blocked | 0ms | Synthetic staging failures must trigger alerts, and the top documented incident runbooks must execute successfully. |
| os-node-matrix | yes | blocked | 0ms | Package install must pass on Linux x64, Linux arm64, macOS arm64, macOS x64, and Windows for claimed Node versions. |
| network-conditions | yes | blocked | 0ms | High-latency, lossy, captive-portal, and IPv6-only network conditions must be tested. |
| browser-matrix | yes | blocked | 0ms | Cloud UI must pass on Chrome, Firefox, Safari, and mobile browser targets for supported versions. |
| accessibility | yes | failed | 2.6s | Cloud UI accessibility scan must pass with the configured violations budget. |
| visual-regression | yes | blocked | 0ms | Cloud UI screenshot diffs must pass against an approved baseline for core surfaces. |
| docs-dx-quickstart | yes | passed | 27.5s | Published quickstart/install instructions must work from clean install through a governed agent run. |
| public-api-contract | yes | passed | 846ms | Public schema and sync protocol tests must pass before claiming API contract stability. |
| error-message-audit | yes | passed | 2.6s | Representative user-facing error paths must be exercised for controlled, actionable responses. |
| license-audit | yes | passed | 3ms | Workspace package manifests must declare acceptable licenses and no GPL/AGPL workspace package may enter release scope. |
| telemetry-privacy-review | yes | blocked | 0ms | Telemetry sent home, privacy documentation, and opt-out behavior must be reviewed and tested. |
| data-residency-review | yes | blocked | 0ms | Snapshot and cloud-mirrored data residency claims must match actual storage locations. |

## Snapshot Regression

- Suite id: `snapshot-regression`
- Status: `passed`
- Required: yes
- Duration: 1.5s
- Command: `pnpm --filter @agentgit/workspace-index test -- src/index.test.ts && pnpm --filter @agentgit/snapshot-engine test -- src/index.test.ts`
- Summary: All commands completed successfully.
- Production implication: Snapshot and workspace-index restore semantics must stay exact before user data is trusted.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/snapshot-regression/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/snapshot-regression/command-2.json`

## OpenClaw Stress

- Suite id: `openclaw-stress`
- Status: `passed`
- Required: yes
- Duration: 24.5s
- Command: `node scripts/stress-autonomous-governance.mjs --profile openclaw --iterations 36 --recover-every 1 --shell-share 0.75 --initialize-git --git-remote https://github.com/openclaw/production-readiness-pipeline.git --workflow-name openclaw-production-readiness --session-root /tmp/agq-711ee77dd7 --seed 20260425 --delay-ms 25`
- Summary: attempted=36, denied=25, snapshots=11, exact_restore_mismatches=0, checkpoint_mismatches=0
- Production implication: Governed local agent actions, denials, snapshots, recoveries, and explicit checkpoints must pass together.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/openclaw-stress/command.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/openclaw-stress/session-root.txt`
  - `/tmp/agq-711ee77dd7/report/summary.json`

## Cloud Build

- Suite id: `cloud-build`
- Status: `passed`
- Required: yes
- Duration: 28.4s
- Command: `pnpm --filter @agentgit/cloud-ui build`
- Summary: All commands completed successfully.
- Production implication: The production cloud bundle must compile with the workspace package graph used by the local product.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/cloud-build/command-1.json`

## Browser Surface

- Suite id: `browser-surface`
- Status: `passed`
- Required: yes
- Duration: 63.6s
- Command: `pnpm smoke:cloud-hosted`
- Summary: All commands completed successfully.
- Production implication: The cloud UI smoke path must prove repo, run, action, snapshot, activity, and audit surfaces render correctly.
- Evidence ceiling: Without --base-url this is local hosted browser evidence, not a real deployed-origin smoke.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/browser-surface/command-1.json`

## Crash Restart

- Suite id: `crash-restart`
- Status: `passed`
- Required: yes
- Duration: 68.7s
- Command: `pnpm --filter @agentgit/authority-daemon test -- src/server.integration.test.ts -t "rehydrates persisted runs after a daemon restart|replays register_run idempotently across restart|creates an explicit run checkpoint and restores back to it" && pnpm --filter @agentgit/cloud-connector test -- src/index.test.ts -t "keeps pending events in the durable outbox across a restart"`
- Summary: All commands completed successfully.
- Production implication: Daemon, journal, checkpoint, restore, and connector outbox state must survive restart boundaries without false success.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/crash-restart/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/crash-restart/command-2.json`

## Concurrent Agents

- Suite id: `concurrent-agents`
- Status: `passed`
- Required: yes
- Duration: 15.6s
- Command: `node scripts/stress-autonomous-governance.mjs --profile openclaw --iterations 12 --recover-every 2 --shell-share 0.65 --initialize-git --git-remote https://github.com/openclaw/concurrent-agent-1.git --workflow-name openclaw-concurrent-agent-1 --session-root /tmp/agc1-d85998f91a --seed 2026042601 --delay-ms 10 & node scripts/stress-autonomous-governance.mjs --profile openclaw --iterations 12 --recover-every 2 --shell-share 0.65 --initialize-git --git-remote https://github.com/openclaw/concurrent-agent-2.git --workflow-name openclaw-concurrent-agent-2 --session-root /tmp/agc2-d85998f91a --seed 2026042602 --delay-ms 10 & node scripts/stress-autonomous-governance.mjs --profile openclaw --iterations 12 --recover-every 2 --shell-share 0.65 --initialize-git --git-remote https://github.com/openclaw/concurrent-agent-3.git --workflow-name openclaw-concurrent-agent-3 --session-root /tmp/agc3-d85998f91a --seed 2026042603 --delay-ms 10 & node scripts/stress-autonomous-governance.mjs --profile openclaw --iterations 12 --recover-every 2 --shell-share 0.65 --initialize-git --git-remote https://github.com/openclaw/concurrent-agent-4.git --workflow-name openclaw-concurrent-agent-4 --session-root /tmp/agc4-d85998f91a --seed 2026042604 --delay-ms 10 & node scripts/stress-autonomous-governance.mjs --profile openclaw --iterations 12 --recover-every 2 --shell-share 0.65 --initialize-git --git-remote https://github.com/openclaw/concurrent-agent-5.git --workflow-name openclaw-concurrent-agent-5 --session-root /tmp/agc5-d85998f91a --seed 2026042605 --delay-ms 10`
- Summary: agents=5, attempted=60, restore_mismatches=0
- Production implication: Five overlapping autonomous stress sessions must keep session ownership, checkpoints, and restore evidence isolated.
- Evidence ceiling: This is an isolated-workspace concurrency floor; it does not prove 5-10 agents mutating the same workspace.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/concurrent-agents/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/concurrent-agents/session-root-1.txt`
  - `/tmp/agc1-d85998f91a/report/summary.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/concurrent-agents/command-2.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/concurrent-agents/session-root-2.txt`
  - `/tmp/agc2-d85998f91a/report/summary.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/concurrent-agents/command-3.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/concurrent-agents/session-root-3.txt`
  - `/tmp/agc3-d85998f91a/report/summary.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/concurrent-agents/command-4.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/concurrent-agents/session-root-4.txt`
  - `/tmp/agc4-d85998f91a/report/summary.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/concurrent-agents/command-5.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/concurrent-agents/session-root-5.txt`
  - `/tmp/agc5-d85998f91a/report/summary.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/concurrent-agents/concurrent-summary.json`

## Connector Loop

- Suite id: `connector-loop`
- Status: `passed`
- Required: yes
- Duration: 6.7s
- Command: `pnpm --filter @agentgit/cloud-sync-protocol test && pnpm --filter @agentgit/control-plane-state test && pnpm --filter @agentgit/cloud-connector test -- src/index.test.ts && pnpm --filter @agentgit/cloud-ui test -- src/lib/backend/control-plane/connectors.test.ts src/app/api/v1/sync/register/route.test.ts src/app/api/v1/sync/heartbeat/route.test.ts src/app/api/v1/sync/events/route.test.ts src/app/api/v1/sync/commands/pull/route.test.ts "src/app/api/v1/sync/commands/[commandId]/ack/route.test.ts"`
- Summary: All commands completed successfully.
- Production implication: Restore, replay, approval, heartbeat, command pull, and ack paths must round-trip through the local connector contract.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/connector-loop/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/connector-loop/command-2.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/connector-loop/command-3.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/connector-loop/command-4.json`

## Sensitive Redaction

- Suite id: `sensitive-redaction`
- Status: `passed`
- Required: yes
- Duration: 137ms
- Command: `scan /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1 /tmp/agc1-d85998f91a /tmp/agc2-d85998f91a /tmp/agc3-d85998f91a /tmp/agc4-d85998f91a /tmp/agc5-d85998f91a /tmp/agq-711ee77dd7 /Users/geoffreyfernald/Documents/agentgit/apps/agentgit-cloud/test-results /Users/geoffreyfernald/Documents/agentgit/apps/agentgit-cloud/playwright-report`
- Summary: No secret tripwires or common token shapes were found across 337 scanned artifact file(s).
- Production implication: Known synthetic secrets and common token shapes must not leak into qualification artifacts, session reports, or browser test output.
- Evidence ceiling: This is a heuristic artifact scanner, not a full DLP engine or guarantee against every novel secret format.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/sensitive-redaction/redaction-scan.json`

## Scale Soak

- Suite id: `scale-soak`
- Status: `passed`
- Required: yes
- Duration: 28.6s
- Command: `node scripts/stress-autonomous-governance.mjs --profile openclaw --iterations 96 --recover-every 2 --shell-share 0.85 --initialize-git --git-remote https://github.com/openclaw/scale-soak-readiness.git --workflow-name openclaw-scale-soak-readiness --session-root /tmp/ags-4f2119dd22 --seed 2026042696 --delay-ms 0`
- Summary: attempted=96, denied=65, snapshots=31, restore_mismatches=0
- Production implication: A 96-iteration beta-scale OpenClaw burst must keep snapshots and recoveries exact across a heavier local run.
- Evidence ceiling: This is not an hours-long soak; GA still needs a long-running leak, WAL growth, and snapshot bloat variant.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/scale-soak/command.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/scale-soak/session-root.txt`
  - `/tmp/ags-4f2119dd22/report/summary.json`

## Snapshot Maintenance

- Suite id: `snapshot-maintenance`
- Status: `passed`
- Required: yes
- Duration: 66.3s
- Command: `pnpm --filter @agentgit/workspace-index test -- src/index.test.ts -t "compacts snapshots|previewRestore reports overlapping later actions|restores only the requested subset" && pnpm --filter @agentgit/authority-daemon test -- src/server.integration.test.ts -t "runs supported maintenance jobs inline|garbage collects orphaned snapshot containers|rebases synthetic snapshot anchors"`
- Summary: All commands completed successfully.
- Production implication: Snapshot GC, synthetic anchor rebase, compaction, WAL checkpointing, and restore previews must preserve recovery honesty.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/snapshot-maintenance/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/snapshot-maintenance/command-2.json`

## Migration Compatibility

- Suite id: `migration-compat`
- Status: `passed`
- Required: yes
- Duration: 1.8s
- Command: `node --test scripts/verify-cli-compatibility.test.mjs scripts/release-package-config.test.mjs && pnpm --filter @agentgit/cloud-ui test -- src/app/api/v1/sync/register/route.test.ts src/app/api/v1/sync/heartbeat/route.test.ts src/app/api/v1/sync/events/route.test.ts src/app/api/v1/sync/commands/pull/route.test.ts "src/app/api/v1/sync/commands/[commandId]/ack/route.test.ts"`
- Summary: All commands completed successfully.
- Production implication: Synthetic audit-bundle compatibility, CLI compatibility manifests, and sync-schema incompatibilities must be handled deliberately.
- Evidence ceiling: This does not include a corpus of real deployed historical bundles unless those fixtures are added.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/migration-compat/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/migration-compat/command-2.json`

## Audit Export

- Suite id: `audit-export`
- Status: `passed`
- Required: yes
- Duration: 2.0s
- Command: `pnpm --filter @agentgit/cloud-ui test -- src/lib/backend/workspace/audit-log.test.ts src/app/api/v1/audit/export/route.test.ts src/app/api/v1/auth-guards.test.ts`
- Summary: All commands completed successfully.
- Production implication: CSV/JSON audit exports must preserve ordering, links, authorization, and redaction-safe payloads.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/audit-export/command-1.json`

## Package Install

- Suite id: `package-install`
- Status: `passed`
- Required: yes
- Duration: 57.7s
- Command: `node scripts/pack-release-artifacts.mjs --out-dir /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/package-install/packed --signing-mode none && node scripts/smoke-public-packages.mjs --artifacts-dir /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/package-install/packed && node scripts/smoke-installed-cli.mjs --artifacts-dir /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/package-install/packed && node scripts/smoke-installed-agent-runtime.mjs --artifacts-dir /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/package-install/packed`
- Summary: All commands completed successfully.
- Production implication: Packed npm artifacts must install into a clean project and the installed CLIs/runtime smoke paths must work outside the monorepo.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/package-install/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/package-install/command-2.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/package-install/command-3.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/package-install/command-4.json`

## Diff Check

- Suite id: `diff-check`
- Status: `passed`
- Required: yes
- Duration: 66ms
- Command: `git diff --check`
- Summary: All commands completed successfully.
- Production implication: Whitespace and patch hygiene must be clean before publishing release evidence.
- Evidence ceiling: This only proves patch hygiene; it does not mean the worktree is clean or fully reviewed.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/diff-check/command-1.json`

## Performance And Capacity Benchmarks

- Suite id: `perf-capacity-benchmarks`
- Status: `passed`
- Required: yes
- Duration: 10.4s
- Command: `node scripts/production-readiness-benchmarks.mjs --output-dir /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/perf-capacity-benchmarks/evidence --iterations 8`
- Summary: action_p99_ms=225.64, snapshot_p99_ms=211.84, restore_p99_ms=185.92, audit_p99_ms=191.04, actions_per_second=4.75, snapshots_per_minute=99.92, budget_failures=0
- Production implication: Measured latency percentiles, throughput, cold-start time, and resource samples must be available for SRE review.
- Evidence ceiling: Local single-machine benchmark evidence is a beta floor; CI/staging should add controlled hardware and baseline-regression comparison.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/perf-capacity-benchmarks/command.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/perf-capacity-benchmarks/evidence/summary.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/perf-capacity-benchmarks/evidence/REPORT.md`

## Reliability Chaos

- Suite id: `reliability-chaos`
- Status: `blocked`
- Required: yes
- Duration: 0ms
- Command: `reliability-chaos`
- Summary: Requires a destructive chaos harness or disposable VM/container environment with disk/network/clock controls.
- Production implication: Fault injection for kill -9 mid-snapshot, disk-full WAL append, network partition, clock skew, and partial filesystem corruption must produce measured RTO/RPO.
- Evidence ceiling: External release-readiness evidence is required before this suite can pass.

## Security Dependency Audit

- Suite id: `security-dependency-audit`
- Status: `passed`
- Required: yes
- Duration: 10.8s
- Command: `pnpm security:audit`
- Summary: All commands completed successfully.
- Production implication: Node and Python dependency audits must pass the configured severity threshold.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/security-dependency-audit/command-1.json`

## Security SBOM

- Suite id: `security-sbom`
- Status: `passed`
- Required: yes
- Duration: 2.9s
- Command: `node scripts/pack-release-artifacts.mjs --out-dir /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/security-sbom/packed --signing-mode none && node scripts/generate-release-sbom.mjs --output /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/security-sbom/release-sbom.cdx.json --artifacts-dir /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/security-sbom/packed`
- Summary: components=41, artifact_components=16, format=CycloneDX
- Production implication: A machine-readable SBOM must exist for workspace and packed release artifacts.
- Evidence ceiling: This local SBOM is generated from workspace manifests; enterprise release should attach CycloneDX/SPDX output from CI.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/security-sbom/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/security-sbom/command-2.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/security-sbom/release-sbom.cdx.json`

## Security Static Analysis

- Suite id: `security-static-analysis`
- Status: `blocked`
- Required: yes
- Duration: 0ms
- Command: `security-static-analysis`
- Summary: No Semgrep/CodeQL scanner is configured in the repo-local qualification environment yet.
- Production implication: Semgrep or CodeQL must scan injection, path traversal, SSRF, hardcoded secrets, and unsafe deserialization classes.
- Evidence ceiling: External release-readiness evidence is required before this suite can pass.

## Security Secret Scan

- Suite id: `security-secret-scan`
- Status: `blocked`
- Required: yes
- Duration: 0ms
- Command: `security-secret-scan`
- Summary: The current local heuristic redaction scanner is not a replacement for gitleaks/trufflehog with history-aware scanning.
- Production implication: gitleaks or trufflehog must scan git history, working tree, and packed artifacts.
- Evidence ceiling: External release-readiness evidence is required before this suite can pass.

## Security Authz Matrix

- Suite id: `security-authz-matrix`
- Status: `passed`
- Required: yes
- Duration: 2.9s
- Command: `pnpm --filter @agentgit/cloud-ui test -- src/app/api/v1/auth-guards.test.ts src/lib/auth/workspace-access.test.ts "src/app/api/v1/repositories/[owner]/[name]/route.test.ts" "src/app/api/v1/repositories/[owner]/[name]/snapshots/[snapshotId]/restore/route.test.ts" src/app/api/v1/settings/team/route.test.ts`
- Summary: All commands completed successfully.
- Production implication: Authentication and authorization route tests must cover guards, token/session paths, cross-resource access, and privileged actions.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/security-authz-matrix/command-1.json`

## Security Agent Adversarial

- Suite id: `security-agent-adversarial`
- Status: `passed`
- Required: yes
- Duration: 7.2s
- Command: `node scripts/run-adversarial-campaign-0.mjs --output-dir /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/security-agent-adversarial/campaign-0`
- Summary: probes=10, passed=10, failed=0, content_leaks=0, filesystem_changes=0
- Production implication: Agent-specific governance bypass, shell boundary, and secret-redaction adversarial campaign must pass.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/security-agent-adversarial/command.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/security-agent-adversarial/campaign-0/summary.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/security-agent-adversarial/campaign-0/REPORT.md`

## Data Integrity Property

- Suite id: `data-integrity-property`
- Status: `passed`
- Required: yes
- Duration: 30.6s
- Command: `node scripts/stress-autonomous-governance.mjs --profile openclaw --iterations 18 --seed <matrix>`
- Summary: seeds=3, attempted=54, restore_mismatches=0
- Production implication: Multiple seeded action sequences must preserve exact restore-to-checkpoint properties with zero mismatches.
- Evidence ceiling: This is seeded property-style stress evidence; a true property-based generator and shrinker is still needed.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/data-integrity-property/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/data-integrity-property/session-root-1.txt`
  - `/tmp/agp1-2762e80b33/report/summary.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/data-integrity-property/command-2.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/data-integrity-property/session-root-2.txt`
  - `/tmp/agp2-a30731f838/report/summary.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/data-integrity-property/command-3.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/data-integrity-property/session-root-3.txt`
  - `/tmp/agp3-fe896e5f61/report/summary.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/data-integrity-property/property-seed-summary.json`

## Data Fuzzing

- Suite id: `data-fuzzing`
- Status: `blocked`
- Required: yes
- Duration: 0ms
- Command: `data-fuzzing`
- Summary: No fuzzing harness or corpus is configured yet.
- Production implication: Audit bundle parser, sync protocol decoder, and CLI argument surfaces must run fuzz corpora.
- Evidence ceiling: External release-readiness evidence is required before this suite can pass.

## Backup Restore Drill

- Suite id: `backup-restore-drill`
- Status: `passed`
- Required: yes
- Duration: 3.1s
- Command: `node scripts/run-recovery-drill.mjs --output-dir /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/backup-restore-drill/recovery-drill`
- Summary: rto_ms=348, rpo_target=latest valid action boundary, restored=true
- Production implication: A measured recovery drill must prove restore behavior, RTO, and recovery evidence on a fresh temporary workspace.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/backup-restore-drill/command.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/backup-restore-drill/recovery-drill/summary.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/backup-restore-drill/recovery-drill/REPORT.md`

## Observability Coverage

- Suite id: `observability-coverage`
- Status: `blocked`
- Required: yes
- Duration: 0ms
- Command: `observability-coverage`
- Summary: Runtime metrics export is not wired into the qualification harness yet.
- Production implication: Prometheus or OpenTelemetry metrics must cover core operations with non-zero samples under qualification load.
- Evidence ceiling: External release-readiness evidence is required before this suite can pass.

## Log Quality

- Suite id: `log-quality`
- Status: `passed`
- Required: yes
- Duration: 21ms
- Command: `scan log artifacts under /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1`
- Summary: No secret-shaped values or obvious SSN-shaped PII were found in 39 log artifact file(s).
- Production implication: Qualification logs must not contain secret-shaped values or obvious PII.
- Evidence ceiling: This is a local artifact/log scanner; correlation-ID completeness still needs structured production log validation.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/log-quality/log-quality-scan.json`

## Alert And Runbook Smoke

- Suite id: `alert-runbook-smoke`
- Status: `blocked`
- Required: yes
- Duration: 0ms
- Command: `alert-runbook-smoke`
- Summary: Requires deployed staging monitoring and alert delivery integrations.
- Production implication: Synthetic staging failures must trigger alerts, and the top documented incident runbooks must execute successfully.
- Evidence ceiling: External release-readiness evidence is required before this suite can pass.

## OS And Node Matrix

- Suite id: `os-node-matrix`
- Status: `blocked`
- Required: yes
- Duration: 0ms
- Command: `os-node-matrix`
- Summary: Requires CI matrix runners; this local Mac can only produce one environment result.
- Production implication: Package install must pass on Linux x64, Linux arm64, macOS arm64, macOS x64, and Windows for claimed Node versions.
- Evidence ceiling: External release-readiness evidence is required before this suite can pass.

## Network Conditions

- Suite id: `network-conditions`
- Status: `blocked`
- Required: yes
- Duration: 0ms
- Command: `network-conditions`
- Summary: Requires a network-emulation test harness or staging environment.
- Production implication: High-latency, lossy, captive-portal, and IPv6-only network conditions must be tested.
- Evidence ceiling: External release-readiness evidence is required before this suite can pass.

## Browser Matrix

- Suite id: `browser-matrix`
- Status: `blocked`
- Required: yes
- Duration: 0ms
- Command: `browser-matrix`
- Summary: Requires Playwright/browser device matrix beyond the local hosted smoke default.
- Production implication: Cloud UI must pass on Chrome, Firefox, Safari, and mobile browser targets for supported versions.
- Evidence ceiling: External release-readiness evidence is required before this suite can pass.

## Accessibility

- Suite id: `accessibility`
- Status: `failed`
- Required: yes
- Duration: 2.6s
- Command: `pnpm --filter @agentgit/cloud-ui exec -- playwright test --config=playwright.config.ts accessibility.spec.ts`
- Summary: pnpm --filter @agentgit/cloud-ui exec -- playwright test --config=playwright.config.ts accessibility.spec.ts exited 1
- Production implication: Cloud UI accessibility scan must pass with the configured violations budget.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/accessibility/command-1.json`

## Visual Regression

- Suite id: `visual-regression`
- Status: `blocked`
- Required: yes
- Duration: 0ms
- Command: `visual-regression`
- Summary: No screenshot baseline or visual diff approval workflow is configured yet.
- Production implication: Cloud UI screenshot diffs must pass against an approved baseline for core surfaces.
- Evidence ceiling: External release-readiness evidence is required before this suite can pass.

## Docs DX Quickstart

- Suite id: `docs-dx-quickstart`
- Status: `passed`
- Required: yes
- Duration: 27.5s
- Command: `node scripts/pack-release-artifacts.mjs --out-dir /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/docs-dx-quickstart/packed --signing-mode none && node scripts/smoke-public-packages.mjs --artifacts-dir /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/docs-dx-quickstart/packed && node scripts/smoke-installed-cli.mjs --artifacts-dir /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/docs-dx-quickstart/packed && node scripts/smoke-installed-agent-runtime.mjs --artifacts-dir /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/docs-dx-quickstart/packed`
- Summary: All commands completed successfully.
- Production implication: Published quickstart/install instructions must work from clean install through a governed agent run.
- Evidence ceiling: This uses local packed artifacts and smoke scripts; clean VM execution should be added in CI before GA.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/docs-dx-quickstart/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/docs-dx-quickstart/command-2.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/docs-dx-quickstart/command-3.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/docs-dx-quickstart/command-4.json`

## Public API Contract

- Suite id: `public-api-contract`
- Status: `passed`
- Required: yes
- Duration: 846ms
- Command: `pnpm --filter @agentgit/schemas test && pnpm --filter @agentgit/cloud-sync-protocol test`
- Summary: All commands completed successfully.
- Production implication: Public schema and sync protocol tests must pass before claiming API contract stability.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/public-api-contract/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/public-api-contract/command-2.json`

## Error Message Audit

- Suite id: `error-message-audit`
- Status: `passed`
- Required: yes
- Duration: 2.6s
- Command: `pnpm --filter @agentgit/cloud-ui test -- src/app/api/v1/approvals/approval-decision-routes.test.ts src/app/api/v1/repos/connect/route.test.ts "src/app/api/v1/repositories/[owner]/[name]/snapshots/[snapshotId]/restore/route.test.ts" src/app/api/v1/settings/workspace/route.test.ts src/app/api/v1/sync/events/route.test.ts "src/app/api/v1/sync/commands/[commandId]/ack/route.test.ts" src/lib/auth/api-session.test.ts src/lib/http/request-body.test.ts`
- Summary: All commands completed successfully.
- Production implication: Representative user-facing error paths must be exercised for controlled, actionable responses.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/error-message-audit/command-1.json`

## License Audit

- Suite id: `license-audit`
- Status: `passed`
- Required: yes
- Duration: 3ms
- Command: `scan workspace package manifests`
- Summary: packages=25, failures=0, private_missing_license_warnings=10
- Production implication: Workspace package manifests must declare acceptable licenses and no GPL/AGPL workspace package may enter release scope.
- Evidence ceiling: This checks workspace manifests only; transitive dependency license export should be added from CI.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r1/license-audit/license-audit.json`

## Telemetry Privacy Review

- Suite id: `telemetry-privacy-review`
- Status: `blocked`
- Required: yes
- Duration: 0ms
- Command: `telemetry-privacy-review`
- Summary: Requires product/privacy decision artifacts and deployed telemetry configuration.
- Production implication: Telemetry sent home, privacy documentation, and opt-out behavior must be reviewed and tested.
- Evidence ceiling: External release-readiness evidence is required before this suite can pass.

## Data Residency Review

- Suite id: `data-residency-review`
- Status: `blocked`
- Required: yes
- Duration: 0ms
- Command: `data-residency-review`
- Summary: Requires deployed cloud storage topology and customer-region policy decisions.
- Production implication: Snapshot and cloud-mirrored data residency claims must match actual storage locations.
- Evidence ceiling: External release-readiness evidence is required before this suite can pass.

