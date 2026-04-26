# Production Beta Qualification Report

Generated: 2026-04-26T20:31:30.598Z
Gate status: passed
Artifact root: /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-wired-category-pass-2026-04-26

## Suite Results

| Suite | Required | Status | Duration | Production implication |
| --- | --- | --- | --- | --- |
| crash-restart | yes | passed | 76.9s | Daemon, journal, checkpoint, restore, and connector outbox state must survive restart boundaries without false success. |
| concurrent-agents | yes | passed | 12.8s | Overlapping autonomous runs must keep session ownership, checkpoints, and restore evidence isolated. |
| connector-loop | yes | passed | 6.7s | Restore, replay, approval, heartbeat, command pull, and ack paths must round-trip through the local connector contract. |
| snapshot-maintenance | yes | passed | 65.4s | Snapshot GC, synthetic anchor rebase, compaction, WAL checkpointing, and restore previews must preserve recovery honesty. |
| migration-compat | yes | passed | 1.8s | Older audit bundles, CLI compatibility manifests, and sync-schema incompatibilities must be handled deliberately. |
| audit-export | yes | passed | 1.8s | CSV/JSON audit exports must preserve ordering, links, authorization, and redaction-safe payloads. |
| diff-check | yes | passed | 99ms | Whitespace and patch hygiene must be clean before publishing release evidence. |

## Crash Restart

- Suite id: `crash-restart`
- Status: `passed`
- Required: yes
- Duration: 76.9s
- Command: `pnpm --filter @agentgit/authority-daemon test -- src/server.integration.test.ts -t "rehydrates persisted runs after a daemon restart|replays register_run idempotently across restart|creates an explicit run checkpoint and restores back to it" && pnpm --filter @agentgit/cloud-connector test -- src/index.test.ts -t "keeps pending events in the durable outbox across a restart"`
- Summary: All commands completed successfully.
- Production implication: Daemon, journal, checkpoint, restore, and connector outbox state must survive restart boundaries without false success.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-wired-category-pass-2026-04-26/crash-restart/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-wired-category-pass-2026-04-26/crash-restart/command-2.json`

## Concurrent Agents

- Suite id: `concurrent-agents`
- Status: `passed`
- Required: yes
- Duration: 12.8s
- Command: `node scripts/stress-autonomous-governance.mjs --profile openclaw --iterations 18 --recover-every 2 --shell-share 0.65 --initialize-git --git-remote https://github.com/openclaw/concurrent-agent-1.git --workflow-name openclaw-concurrent-agent-1 --session-root /tmp/agc1-8f8138d5d7 --seed 2026042601 --delay-ms 10 & node scripts/stress-autonomous-governance.mjs --profile openclaw --iterations 18 --recover-every 2 --shell-share 0.65 --initialize-git --git-remote https://github.com/openclaw/concurrent-agent-2.git --workflow-name openclaw-concurrent-agent-2 --session-root /tmp/agc2-8f8138d5d7 --seed 2026042602 --delay-ms 10`
- Summary: agents=2, attempted=36, restore_mismatches=0
- Production implication: Overlapping autonomous runs must keep session ownership, checkpoints, and restore evidence isolated.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-wired-category-pass-2026-04-26/concurrent-agents/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-wired-category-pass-2026-04-26/concurrent-agents/session-root-1.txt`
  - `/tmp/agc1-8f8138d5d7/report/summary.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-wired-category-pass-2026-04-26/concurrent-agents/command-2.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-wired-category-pass-2026-04-26/concurrent-agents/session-root-2.txt`
  - `/tmp/agc2-8f8138d5d7/report/summary.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-wired-category-pass-2026-04-26/concurrent-agents/concurrent-summary.json`

## Connector Loop

- Suite id: `connector-loop`
- Status: `passed`
- Required: yes
- Duration: 6.7s
- Command: `pnpm --filter @agentgit/cloud-sync-protocol test && pnpm --filter @agentgit/control-plane-state test && pnpm --filter @agentgit/cloud-connector test -- src/index.test.ts && pnpm --filter @agentgit/cloud-ui test -- src/lib/backend/control-plane/connectors.test.ts src/app/api/v1/sync/register/route.test.ts src/app/api/v1/sync/heartbeat/route.test.ts src/app/api/v1/sync/events/route.test.ts src/app/api/v1/sync/commands/pull/route.test.ts "src/app/api/v1/sync/commands/[commandId]/ack/route.test.ts"`
- Summary: All commands completed successfully.
- Production implication: Restore, replay, approval, heartbeat, command pull, and ack paths must round-trip through the local connector contract.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-wired-category-pass-2026-04-26/connector-loop/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-wired-category-pass-2026-04-26/connector-loop/command-2.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-wired-category-pass-2026-04-26/connector-loop/command-3.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-wired-category-pass-2026-04-26/connector-loop/command-4.json`

## Snapshot Maintenance

- Suite id: `snapshot-maintenance`
- Status: `passed`
- Required: yes
- Duration: 65.4s
- Command: `pnpm --filter @agentgit/workspace-index test -- src/index.test.ts -t "compacts snapshots|previewRestore reports overlapping later actions|restores only the requested subset" && pnpm --filter @agentgit/authority-daemon test -- src/server.integration.test.ts -t "runs supported maintenance jobs inline|garbage collects orphaned snapshot containers|rebases synthetic snapshot anchors"`
- Summary: All commands completed successfully.
- Production implication: Snapshot GC, synthetic anchor rebase, compaction, WAL checkpointing, and restore previews must preserve recovery honesty.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-wired-category-pass-2026-04-26/snapshot-maintenance/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-wired-category-pass-2026-04-26/snapshot-maintenance/command-2.json`

## Migration Compatibility

- Suite id: `migration-compat`
- Status: `passed`
- Required: yes
- Duration: 1.8s
- Command: `node --test scripts/verify-cli-compatibility.test.mjs scripts/release-package-config.test.mjs && pnpm --filter @agentgit/cloud-ui test -- src/app/api/v1/sync/register/route.test.ts src/app/api/v1/sync/heartbeat/route.test.ts src/app/api/v1/sync/events/route.test.ts src/app/api/v1/sync/commands/pull/route.test.ts "src/app/api/v1/sync/commands/[commandId]/ack/route.test.ts"`
- Summary: All commands completed successfully.
- Production implication: Older audit bundles, CLI compatibility manifests, and sync-schema incompatibilities must be handled deliberately.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-wired-category-pass-2026-04-26/migration-compat/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-wired-category-pass-2026-04-26/migration-compat/command-2.json`

## Audit Export

- Suite id: `audit-export`
- Status: `passed`
- Required: yes
- Duration: 1.8s
- Command: `pnpm --filter @agentgit/cloud-ui test -- src/lib/backend/workspace/audit-log.test.ts src/app/api/v1/audit/export/route.test.ts src/app/api/v1/auth-guards.test.ts`
- Summary: All commands completed successfully.
- Production implication: CSV/JSON audit exports must preserve ordering, links, authorization, and redaction-safe payloads.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-wired-category-pass-2026-04-26/audit-export/command-1.json`

## Diff Check

- Suite id: `diff-check`
- Status: `passed`
- Required: yes
- Duration: 99ms
- Command: `git diff --check`
- Summary: All commands completed successfully.
- Production implication: Whitespace and patch hygiene must be clean before publishing release evidence.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-wired-category-pass-2026-04-26/diff-check/command-1.json`

