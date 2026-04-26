# Production Beta Qualification Report

Generated: 2026-04-26T20:23:38.556Z
Gate status: passed
Artifact root: /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-implemented-core-2026-04-26-r3

## Suite Results

| Suite | Required | Status | Duration | Production implication |
| --- | --- | --- | --- | --- |
| snapshot-regression | yes | passed | 1.5s | Snapshot and workspace-index restore semantics must stay exact before user data is trusted. |
| openclaw-stress | yes | passed | 17.0s | Governed local agent actions, denials, snapshots, recoveries, and explicit checkpoints must pass together. |
| sensitive-redaction | yes | passed | 19ms | Synthetic secrets must not leak into qualification summaries or browser-visible evidence. |
| diff-check | yes | passed | 34ms | Whitespace and patch hygiene must be clean before publishing release evidence. |

## Snapshot Regression

- Suite id: `snapshot-regression`
- Status: `passed`
- Required: yes
- Duration: 1.5s
- Command: `pnpm --filter @agentgit/workspace-index test -- src/index.test.ts && pnpm --filter @agentgit/snapshot-engine test -- src/index.test.ts`
- Summary: All commands completed successfully.
- Production implication: Snapshot and workspace-index restore semantics must stay exact before user data is trusted.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-implemented-core-2026-04-26-r3/snapshot-regression/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-implemented-core-2026-04-26-r3/snapshot-regression/command-2.json`

## OpenClaw Stress

- Suite id: `openclaw-stress`
- Status: `passed`
- Required: yes
- Duration: 17.0s
- Command: `node scripts/stress-autonomous-governance.mjs --profile openclaw --iterations 36 --recover-every 1 --shell-share 0.75 --initialize-git --git-remote https://github.com/openclaw/production-readiness-pipeline.git --workflow-name openclaw-production-readiness --session-root /tmp/agq-29640599e0 --seed 20260425 --delay-ms 25`
- Summary: attempted=36, denied=25, snapshots=11, exact_restore_mismatches=0, checkpoint_mismatches=0
- Production implication: Governed local agent actions, denials, snapshots, recoveries, and explicit checkpoints must pass together.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-implemented-core-2026-04-26-r3/openclaw-stress/command.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-implemented-core-2026-04-26-r3/openclaw-stress/session-root.txt`
  - `/tmp/agq-29640599e0/report/summary.json`

## Sensitive Redaction

- Suite id: `sensitive-redaction`
- Status: `passed`
- Required: yes
- Duration: 19ms
- Command: `scan /tmp/agq-29640599e0`
- Summary: No synthetic secrets were found in qualification report artifacts.
- Production implication: Synthetic secrets must not leak into qualification summaries or browser-visible evidence.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-implemented-core-2026-04-26-r3/sensitive-redaction/redaction-scan.json`

## Diff Check

- Suite id: `diff-check`
- Status: `passed`
- Required: yes
- Duration: 34ms
- Command: `git diff --check`
- Summary: All commands completed successfully.
- Production implication: Whitespace and patch hygiene must be clean before publishing release evidence.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-implemented-core-2026-04-26-r3/diff-check/command-1.json`

