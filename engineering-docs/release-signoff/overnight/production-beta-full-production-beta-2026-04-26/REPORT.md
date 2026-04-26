# Production Beta Qualification Report

Generated: 2026-04-26T20:38:08.481Z
Gate status: passed
Artifact root: /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26

## Suite Results

| Suite | Required | Status | Duration | Production implication |
| --- | --- | --- | --- | --- |
| snapshot-regression | yes | passed | 1.3s | Snapshot and workspace-index restore semantics must stay exact before user data is trusted. |
| openclaw-stress | yes | passed | 16.8s | Governed local agent actions, denials, snapshots, recoveries, and explicit checkpoints must pass together. |
| cloud-build | yes | passed | 29.8s | The production cloud bundle must compile with the workspace package graph used by the local product. |
| browser-surface | yes | passed | 63.3s | The actual cloud UI must prove repo, run, action, snapshot, activity, and audit surfaces render correctly. |
| crash-restart | yes | passed | 71.9s | Daemon, journal, checkpoint, restore, and connector outbox state must survive restart boundaries without false success. |
| concurrent-agents | yes | passed | 11.8s | Overlapping autonomous runs must keep session ownership, checkpoints, and restore evidence isolated. |
| connector-loop | yes | passed | 7.2s | Restore, replay, approval, heartbeat, command pull, and ack paths must round-trip through the local connector contract. |
| sensitive-redaction | yes | passed | 40ms | Synthetic secrets must not leak into qualification summaries or browser-visible evidence. |
| scale-soak | yes | passed | 27.7s | Longer OpenClaw-style action histories must keep snapshots and recoveries exact across a heavier local run. |
| snapshot-maintenance | yes | passed | 69.4s | Snapshot GC, synthetic anchor rebase, compaction, WAL checkpointing, and restore previews must preserve recovery honesty. |
| migration-compat | yes | passed | 2.5s | Older audit bundles, CLI compatibility manifests, and sync-schema incompatibilities must be handled deliberately. |
| audit-export | yes | passed | 1.8s | CSV/JSON audit exports must preserve ordering, links, authorization, and redaction-safe payloads. |
| package-install | yes | passed | 76.4s | Packed npm artifacts must install into a clean project and the installed CLIs/runtime smoke paths must work outside the monorepo. |
| diff-check | yes | passed | 160ms | Whitespace and patch hygiene must be clean before publishing release evidence. |

## Snapshot Regression

- Suite id: `snapshot-regression`
- Status: `passed`
- Required: yes
- Duration: 1.3s
- Command: `pnpm --filter @agentgit/workspace-index test -- src/index.test.ts && pnpm --filter @agentgit/snapshot-engine test -- src/index.test.ts`
- Summary: All commands completed successfully.
- Production implication: Snapshot and workspace-index restore semantics must stay exact before user data is trusted.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/snapshot-regression/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/snapshot-regression/command-2.json`

## OpenClaw Stress

- Suite id: `openclaw-stress`
- Status: `passed`
- Required: yes
- Duration: 16.8s
- Command: `node scripts/stress-autonomous-governance.mjs --profile openclaw --iterations 36 --recover-every 1 --shell-share 0.75 --initialize-git --git-remote https://github.com/openclaw/production-readiness-pipeline.git --workflow-name openclaw-production-readiness --session-root /tmp/agq-1031c1daa2 --seed 20260425 --delay-ms 25`
- Summary: attempted=36, denied=25, snapshots=11, exact_restore_mismatches=0, checkpoint_mismatches=0
- Production implication: Governed local agent actions, denials, snapshots, recoveries, and explicit checkpoints must pass together.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/openclaw-stress/command.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/openclaw-stress/session-root.txt`
  - `/tmp/agq-1031c1daa2/report/summary.json`

## Cloud Build

- Suite id: `cloud-build`
- Status: `passed`
- Required: yes
- Duration: 29.8s
- Command: `pnpm --filter @agentgit/cloud-ui build`
- Summary: All commands completed successfully.
- Production implication: The production cloud bundle must compile with the workspace package graph used by the local product.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/cloud-build/command-1.json`

## Browser Surface

- Suite id: `browser-surface`
- Status: `passed`
- Required: yes
- Duration: 63.3s
- Command: `pnpm smoke:cloud-hosted`
- Summary: All commands completed successfully.
- Production implication: The actual cloud UI must prove repo, run, action, snapshot, activity, and audit surfaces render correctly.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/browser-surface/command-1.json`

## Crash Restart

- Suite id: `crash-restart`
- Status: `passed`
- Required: yes
- Duration: 71.9s
- Command: `pnpm --filter @agentgit/authority-daemon test -- src/server.integration.test.ts -t "rehydrates persisted runs after a daemon restart|replays register_run idempotently across restart|creates an explicit run checkpoint and restores back to it" && pnpm --filter @agentgit/cloud-connector test -- src/index.test.ts -t "keeps pending events in the durable outbox across a restart"`
- Summary: All commands completed successfully.
- Production implication: Daemon, journal, checkpoint, restore, and connector outbox state must survive restart boundaries without false success.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/crash-restart/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/crash-restart/command-2.json`

## Concurrent Agents

- Suite id: `concurrent-agents`
- Status: `passed`
- Required: yes
- Duration: 11.8s
- Command: `node scripts/stress-autonomous-governance.mjs --profile openclaw --iterations 18 --recover-every 2 --shell-share 0.65 --initialize-git --git-remote https://github.com/openclaw/concurrent-agent-1.git --workflow-name openclaw-concurrent-agent-1 --session-root /tmp/agc1-9a73cde1a7 --seed 2026042601 --delay-ms 10 & node scripts/stress-autonomous-governance.mjs --profile openclaw --iterations 18 --recover-every 2 --shell-share 0.65 --initialize-git --git-remote https://github.com/openclaw/concurrent-agent-2.git --workflow-name openclaw-concurrent-agent-2 --session-root /tmp/agc2-9a73cde1a7 --seed 2026042602 --delay-ms 10`
- Summary: agents=2, attempted=36, restore_mismatches=0
- Production implication: Overlapping autonomous runs must keep session ownership, checkpoints, and restore evidence isolated.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/concurrent-agents/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/concurrent-agents/session-root-1.txt`
  - `/tmp/agc1-9a73cde1a7/report/summary.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/concurrent-agents/command-2.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/concurrent-agents/session-root-2.txt`
  - `/tmp/agc2-9a73cde1a7/report/summary.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/concurrent-agents/concurrent-summary.json`

## Connector Loop

- Suite id: `connector-loop`
- Status: `passed`
- Required: yes
- Duration: 7.2s
- Command: `pnpm --filter @agentgit/cloud-sync-protocol test && pnpm --filter @agentgit/control-plane-state test && pnpm --filter @agentgit/cloud-connector test -- src/index.test.ts && pnpm --filter @agentgit/cloud-ui test -- src/lib/backend/control-plane/connectors.test.ts src/app/api/v1/sync/register/route.test.ts src/app/api/v1/sync/heartbeat/route.test.ts src/app/api/v1/sync/events/route.test.ts src/app/api/v1/sync/commands/pull/route.test.ts "src/app/api/v1/sync/commands/[commandId]/ack/route.test.ts"`
- Summary: All commands completed successfully.
- Production implication: Restore, replay, approval, heartbeat, command pull, and ack paths must round-trip through the local connector contract.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/connector-loop/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/connector-loop/command-2.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/connector-loop/command-3.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/connector-loop/command-4.json`

## Sensitive Redaction

- Suite id: `sensitive-redaction`
- Status: `passed`
- Required: yes
- Duration: 40ms
- Command: `scan /tmp/agq-1031c1daa2`
- Summary: No synthetic secrets were found in qualification report artifacts.
- Production implication: Synthetic secrets must not leak into qualification summaries or browser-visible evidence.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/sensitive-redaction/redaction-scan.json`

## Scale Soak

- Suite id: `scale-soak`
- Status: `passed`
- Required: yes
- Duration: 27.7s
- Command: `node scripts/stress-autonomous-governance.mjs --profile openclaw --iterations 96 --recover-every 2 --shell-share 0.85 --initialize-git --git-remote https://github.com/openclaw/scale-soak-readiness.git --workflow-name openclaw-scale-soak-readiness --session-root /tmp/ags-66283aa263 --seed 2026042696 --delay-ms 0`
- Summary: attempted=96, denied=65, snapshots=31, restore_mismatches=0
- Production implication: Longer OpenClaw-style action histories must keep snapshots and recoveries exact across a heavier local run.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/scale-soak/command.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/scale-soak/session-root.txt`
  - `/tmp/ags-66283aa263/report/summary.json`

## Snapshot Maintenance

- Suite id: `snapshot-maintenance`
- Status: `passed`
- Required: yes
- Duration: 69.4s
- Command: `pnpm --filter @agentgit/workspace-index test -- src/index.test.ts -t "compacts snapshots|previewRestore reports overlapping later actions|restores only the requested subset" && pnpm --filter @agentgit/authority-daemon test -- src/server.integration.test.ts -t "runs supported maintenance jobs inline|garbage collects orphaned snapshot containers|rebases synthetic snapshot anchors"`
- Summary: All commands completed successfully.
- Production implication: Snapshot GC, synthetic anchor rebase, compaction, WAL checkpointing, and restore previews must preserve recovery honesty.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/snapshot-maintenance/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/snapshot-maintenance/command-2.json`

## Migration Compatibility

- Suite id: `migration-compat`
- Status: `passed`
- Required: yes
- Duration: 2.5s
- Command: `node --test scripts/verify-cli-compatibility.test.mjs scripts/release-package-config.test.mjs && pnpm --filter @agentgit/cloud-ui test -- src/app/api/v1/sync/register/route.test.ts src/app/api/v1/sync/heartbeat/route.test.ts src/app/api/v1/sync/events/route.test.ts src/app/api/v1/sync/commands/pull/route.test.ts "src/app/api/v1/sync/commands/[commandId]/ack/route.test.ts"`
- Summary: All commands completed successfully.
- Production implication: Older audit bundles, CLI compatibility manifests, and sync-schema incompatibilities must be handled deliberately.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/migration-compat/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/migration-compat/command-2.json`

## Audit Export

- Suite id: `audit-export`
- Status: `passed`
- Required: yes
- Duration: 1.8s
- Command: `pnpm --filter @agentgit/cloud-ui test -- src/lib/backend/workspace/audit-log.test.ts src/app/api/v1/audit/export/route.test.ts src/app/api/v1/auth-guards.test.ts`
- Summary: All commands completed successfully.
- Production implication: CSV/JSON audit exports must preserve ordering, links, authorization, and redaction-safe payloads.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/audit-export/command-1.json`

## Package Install

- Suite id: `package-install`
- Status: `passed`
- Required: yes
- Duration: 76.4s
- Command: `node scripts/pack-release-artifacts.mjs --out-dir /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/package-install/packed --signing-mode none && node scripts/smoke-public-packages.mjs --artifacts-dir /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/package-install/packed && node scripts/smoke-installed-cli.mjs --artifacts-dir /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/package-install/packed && node scripts/smoke-installed-agent-runtime.mjs --artifacts-dir /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/package-install/packed`
- Summary: All commands completed successfully.
- Production implication: Packed npm artifacts must install into a clean project and the installed CLIs/runtime smoke paths must work outside the monorepo.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/package-install/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/package-install/command-2.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/package-install/command-3.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/package-install/command-4.json`

## Diff Check

- Suite id: `diff-check`
- Status: `passed`
- Required: yes
- Duration: 160ms
- Command: `git diff --check`
- Summary: All commands completed successfully.
- Production implication: Whitespace and patch hygiene must be clean before publishing release evidence.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26/diff-check/command-1.json`

