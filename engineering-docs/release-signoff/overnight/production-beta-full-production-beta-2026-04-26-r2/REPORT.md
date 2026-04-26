# Production Beta Qualification Report

Generated: 2026-04-26T21:37:08.791Z
Gate status: passed
Artifact root: /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2

## Suite Results

| Suite | Required | Status | Duration | Production implication |
| --- | --- | --- | --- | --- |
| snapshot-regression | yes | passed | 1.4s | Snapshot and workspace-index restore semantics must stay exact before user data is trusted. |
| openclaw-stress | yes | passed | 17.4s | Governed local agent actions, denials, snapshots, recoveries, and explicit checkpoints must pass together. |
| cloud-build | yes | passed | 32.7s | The production cloud bundle must compile with the workspace package graph used by the local product. |
| browser-surface | yes | passed | 64.4s | The cloud UI smoke path must prove repo, run, action, snapshot, activity, and audit surfaces render correctly. |
| crash-restart | yes | passed | 67.0s | Daemon, journal, checkpoint, restore, and connector outbox state must survive restart boundaries without false success. |
| concurrent-agents | yes | passed | 14.7s | Five overlapping autonomous stress sessions must keep session ownership, checkpoints, and restore evidence isolated. |
| connector-loop | yes | passed | 6.9s | Restore, replay, approval, heartbeat, command pull, and ack paths must round-trip through the local connector contract. |
| sensitive-redaction | yes | passed | 103ms | Known synthetic secrets and common token shapes must not leak into qualification artifacts, session reports, or browser test output. |
| scale-soak | yes | passed | 27.2s | A 96-iteration beta-scale OpenClaw burst must keep snapshots and recoveries exact across a heavier local run. |
| snapshot-maintenance | yes | passed | 65.3s | Snapshot GC, synthetic anchor rebase, compaction, WAL checkpointing, and restore previews must preserve recovery honesty. |
| migration-compat | yes | passed | 1.8s | Synthetic audit-bundle compatibility, CLI compatibility manifests, and sync-schema incompatibilities must be handled deliberately. |
| audit-export | yes | passed | 1.8s | CSV/JSON audit exports must preserve ordering, links, authorization, and redaction-safe payloads. |
| package-install | yes | passed | 26.4s | Packed npm artifacts must install into a clean project and the installed CLIs/runtime smoke paths must work outside the monorepo. |
| diff-check | yes | passed | 30ms | Whitespace and patch hygiene must be clean before publishing release evidence. |

## Snapshot Regression

- Suite id: `snapshot-regression`
- Status: `passed`
- Required: yes
- Duration: 1.4s
- Command: `pnpm --filter @agentgit/workspace-index test -- src/index.test.ts && pnpm --filter @agentgit/snapshot-engine test -- src/index.test.ts`
- Summary: All commands completed successfully.
- Production implication: Snapshot and workspace-index restore semantics must stay exact before user data is trusted.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/snapshot-regression/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/snapshot-regression/command-2.json`

## OpenClaw Stress

- Suite id: `openclaw-stress`
- Status: `passed`
- Required: yes
- Duration: 17.4s
- Command: `node scripts/stress-autonomous-governance.mjs --profile openclaw --iterations 36 --recover-every 1 --shell-share 0.75 --initialize-git --git-remote https://github.com/openclaw/production-readiness-pipeline.git --workflow-name openclaw-production-readiness --session-root /tmp/agq-aad62a11e1 --seed 20260425 --delay-ms 25`
- Summary: attempted=36, denied=25, snapshots=11, exact_restore_mismatches=0, checkpoint_mismatches=0
- Production implication: Governed local agent actions, denials, snapshots, recoveries, and explicit checkpoints must pass together.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/openclaw-stress/command.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/openclaw-stress/session-root.txt`
  - `/tmp/agq-aad62a11e1/report/summary.json`

## Cloud Build

- Suite id: `cloud-build`
- Status: `passed`
- Required: yes
- Duration: 32.7s
- Command: `pnpm --filter @agentgit/cloud-ui build`
- Summary: All commands completed successfully.
- Production implication: The production cloud bundle must compile with the workspace package graph used by the local product.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/cloud-build/command-1.json`

## Browser Surface

- Suite id: `browser-surface`
- Status: `passed`
- Required: yes
- Duration: 64.4s
- Command: `pnpm smoke:cloud-hosted`
- Summary: All commands completed successfully.
- Production implication: The cloud UI smoke path must prove repo, run, action, snapshot, activity, and audit surfaces render correctly.
- Evidence ceiling: Without --base-url this is local hosted browser evidence, not a real deployed-origin smoke.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/browser-surface/command-1.json`

## Crash Restart

- Suite id: `crash-restart`
- Status: `passed`
- Required: yes
- Duration: 67.0s
- Command: `pnpm --filter @agentgit/authority-daemon test -- src/server.integration.test.ts -t "rehydrates persisted runs after a daemon restart|replays register_run idempotently across restart|creates an explicit run checkpoint and restores back to it" && pnpm --filter @agentgit/cloud-connector test -- src/index.test.ts -t "keeps pending events in the durable outbox across a restart"`
- Summary: All commands completed successfully.
- Production implication: Daemon, journal, checkpoint, restore, and connector outbox state must survive restart boundaries without false success.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/crash-restart/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/crash-restart/command-2.json`

## Concurrent Agents

- Suite id: `concurrent-agents`
- Status: `passed`
- Required: yes
- Duration: 14.7s
- Command: `node scripts/stress-autonomous-governance.mjs --profile openclaw --iterations 12 --recover-every 2 --shell-share 0.65 --initialize-git --git-remote https://github.com/openclaw/concurrent-agent-1.git --workflow-name openclaw-concurrent-agent-1 --session-root /tmp/agc1-7751d8c576 --seed 2026042601 --delay-ms 10 & node scripts/stress-autonomous-governance.mjs --profile openclaw --iterations 12 --recover-every 2 --shell-share 0.65 --initialize-git --git-remote https://github.com/openclaw/concurrent-agent-2.git --workflow-name openclaw-concurrent-agent-2 --session-root /tmp/agc2-7751d8c576 --seed 2026042602 --delay-ms 10 & node scripts/stress-autonomous-governance.mjs --profile openclaw --iterations 12 --recover-every 2 --shell-share 0.65 --initialize-git --git-remote https://github.com/openclaw/concurrent-agent-3.git --workflow-name openclaw-concurrent-agent-3 --session-root /tmp/agc3-7751d8c576 --seed 2026042603 --delay-ms 10 & node scripts/stress-autonomous-governance.mjs --profile openclaw --iterations 12 --recover-every 2 --shell-share 0.65 --initialize-git --git-remote https://github.com/openclaw/concurrent-agent-4.git --workflow-name openclaw-concurrent-agent-4 --session-root /tmp/agc4-7751d8c576 --seed 2026042604 --delay-ms 10 & node scripts/stress-autonomous-governance.mjs --profile openclaw --iterations 12 --recover-every 2 --shell-share 0.65 --initialize-git --git-remote https://github.com/openclaw/concurrent-agent-5.git --workflow-name openclaw-concurrent-agent-5 --session-root /tmp/agc5-7751d8c576 --seed 2026042605 --delay-ms 10`
- Summary: agents=5, attempted=60, restore_mismatches=0
- Production implication: Five overlapping autonomous stress sessions must keep session ownership, checkpoints, and restore evidence isolated.
- Evidence ceiling: This is an isolated-workspace concurrency floor; it does not prove 5-10 agents mutating the same workspace.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/concurrent-agents/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/concurrent-agents/session-root-1.txt`
  - `/tmp/agc1-7751d8c576/report/summary.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/concurrent-agents/command-2.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/concurrent-agents/session-root-2.txt`
  - `/tmp/agc2-7751d8c576/report/summary.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/concurrent-agents/command-3.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/concurrent-agents/session-root-3.txt`
  - `/tmp/agc3-7751d8c576/report/summary.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/concurrent-agents/command-4.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/concurrent-agents/session-root-4.txt`
  - `/tmp/agc4-7751d8c576/report/summary.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/concurrent-agents/command-5.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/concurrent-agents/session-root-5.txt`
  - `/tmp/agc5-7751d8c576/report/summary.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/concurrent-agents/concurrent-summary.json`

## Connector Loop

- Suite id: `connector-loop`
- Status: `passed`
- Required: yes
- Duration: 6.9s
- Command: `pnpm --filter @agentgit/cloud-sync-protocol test && pnpm --filter @agentgit/control-plane-state test && pnpm --filter @agentgit/cloud-connector test -- src/index.test.ts && pnpm --filter @agentgit/cloud-ui test -- src/lib/backend/control-plane/connectors.test.ts src/app/api/v1/sync/register/route.test.ts src/app/api/v1/sync/heartbeat/route.test.ts src/app/api/v1/sync/events/route.test.ts src/app/api/v1/sync/commands/pull/route.test.ts "src/app/api/v1/sync/commands/[commandId]/ack/route.test.ts"`
- Summary: All commands completed successfully.
- Production implication: Restore, replay, approval, heartbeat, command pull, and ack paths must round-trip through the local connector contract.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/connector-loop/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/connector-loop/command-2.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/connector-loop/command-3.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/connector-loop/command-4.json`

## Sensitive Redaction

- Suite id: `sensitive-redaction`
- Status: `passed`
- Required: yes
- Duration: 103ms
- Command: `scan /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2 /tmp/agc1-7751d8c576 /tmp/agc2-7751d8c576 /tmp/agc3-7751d8c576 /tmp/agc4-7751d8c576 /tmp/agc5-7751d8c576 /tmp/agq-aad62a11e1 /Users/geoffreyfernald/Documents/agentgit/apps/agentgit-cloud/test-results /Users/geoffreyfernald/Documents/agentgit/apps/agentgit-cloud/playwright-report`
- Summary: No secret tripwires or common token shapes were found across 337 scanned artifact file(s).
- Production implication: Known synthetic secrets and common token shapes must not leak into qualification artifacts, session reports, or browser test output.
- Evidence ceiling: This is a heuristic artifact scanner, not a full DLP engine or guarantee against every novel secret format.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/sensitive-redaction/redaction-scan.json`

## Scale Soak

- Suite id: `scale-soak`
- Status: `passed`
- Required: yes
- Duration: 27.2s
- Command: `node scripts/stress-autonomous-governance.mjs --profile openclaw --iterations 96 --recover-every 2 --shell-share 0.85 --initialize-git --git-remote https://github.com/openclaw/scale-soak-readiness.git --workflow-name openclaw-scale-soak-readiness --session-root /tmp/ags-ba46533ca3 --seed 2026042696 --delay-ms 0`
- Summary: attempted=96, denied=65, snapshots=31, restore_mismatches=0
- Production implication: A 96-iteration beta-scale OpenClaw burst must keep snapshots and recoveries exact across a heavier local run.
- Evidence ceiling: This is not an hours-long soak; GA still needs a long-running leak, WAL growth, and snapshot bloat variant.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/scale-soak/command.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/scale-soak/session-root.txt`
  - `/tmp/ags-ba46533ca3/report/summary.json`

## Snapshot Maintenance

- Suite id: `snapshot-maintenance`
- Status: `passed`
- Required: yes
- Duration: 65.3s
- Command: `pnpm --filter @agentgit/workspace-index test -- src/index.test.ts -t "compacts snapshots|previewRestore reports overlapping later actions|restores only the requested subset" && pnpm --filter @agentgit/authority-daemon test -- src/server.integration.test.ts -t "runs supported maintenance jobs inline|garbage collects orphaned snapshot containers|rebases synthetic snapshot anchors"`
- Summary: All commands completed successfully.
- Production implication: Snapshot GC, synthetic anchor rebase, compaction, WAL checkpointing, and restore previews must preserve recovery honesty.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/snapshot-maintenance/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/snapshot-maintenance/command-2.json`

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
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/migration-compat/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/migration-compat/command-2.json`

## Audit Export

- Suite id: `audit-export`
- Status: `passed`
- Required: yes
- Duration: 1.8s
- Command: `pnpm --filter @agentgit/cloud-ui test -- src/lib/backend/workspace/audit-log.test.ts src/app/api/v1/audit/export/route.test.ts src/app/api/v1/auth-guards.test.ts`
- Summary: All commands completed successfully.
- Production implication: CSV/JSON audit exports must preserve ordering, links, authorization, and redaction-safe payloads.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/audit-export/command-1.json`

## Package Install

- Suite id: `package-install`
- Status: `passed`
- Required: yes
- Duration: 26.4s
- Command: `node scripts/pack-release-artifacts.mjs --out-dir /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/package-install/packed --signing-mode none && node scripts/smoke-public-packages.mjs --artifacts-dir /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/package-install/packed && node scripts/smoke-installed-cli.mjs --artifacts-dir /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/package-install/packed && node scripts/smoke-installed-agent-runtime.mjs --artifacts-dir /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/package-install/packed`
- Summary: All commands completed successfully.
- Production implication: Packed npm artifacts must install into a clean project and the installed CLIs/runtime smoke paths must work outside the monorepo.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/package-install/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/package-install/command-2.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/package-install/command-3.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/package-install/command-4.json`

## Diff Check

- Suite id: `diff-check`
- Status: `passed`
- Required: yes
- Duration: 30ms
- Command: `git diff --check`
- Summary: All commands completed successfully.
- Production implication: Whitespace and patch hygiene must be clean before publishing release evidence.
- Evidence ceiling: This only proves patch hygiene; it does not mean the worktree is clean or fully reviewed.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/diff-check/command-1.json`

