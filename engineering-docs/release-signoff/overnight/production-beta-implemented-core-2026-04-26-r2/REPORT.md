# Production Beta Qualification Report

Generated: 2026-04-26T20:22:16.135Z
Gate status: failed
Artifact root: /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-implemented-core-2026-04-26-r2

## Suite Results

| Suite | Required | Status | Duration | Production implication |
| --- | --- | --- | --- | --- |
| snapshot-regression | yes | passed | 1.7s | Snapshot and workspace-index restore semantics must stay exact before user data is trusted. |
| openclaw-stress | yes | failed | 15.6s | Governed local agent actions, denials, snapshots, recoveries, and explicit checkpoints must pass together. |
| sensitive-redaction | yes | blocked | 1ms | Synthetic secrets must not leak into qualification summaries or browser-visible evidence. |
| diff-check | yes | passed | 49ms | Whitespace and patch hygiene must be clean before publishing release evidence. |

## Snapshot Regression

- Suite id: `snapshot-regression`
- Status: `passed`
- Required: yes
- Duration: 1.7s
- Command: `pnpm --filter @agentgit/workspace-index test -- src/index.test.ts && pnpm --filter @agentgit/snapshot-engine test -- src/index.test.ts`
- Summary: All commands completed successfully.
- Production implication: Snapshot and workspace-index restore semantics must stay exact before user data is trusted.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-implemented-core-2026-04-26-r2/snapshot-regression/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-implemented-core-2026-04-26-r2/snapshot-regression/command-2.json`

## OpenClaw Stress

- Suite id: `openclaw-stress`
- Status: `failed`
- Required: yes
- Duration: 15.6s
- Command: `node scripts/stress-autonomous-governance.mjs --profile openclaw --iterations 36 --recover-every 1 --shell-share 0.75 --initialize-git --git-remote https://github.com/openclaw/production-readiness-pipeline.git --workflow-name openclaw-production-readiness --session-root /tmp/agentgit-openclaw-qualification-production-beta-implemented-core-2026-04-26-r2-1777234920464 --seed 20260425 --delay-ms 25`
- Summary: OpenClaw stress command exited 1.
- Production implication: Governed local agent actions, denials, snapshots, recoveries, and explicit checkpoints must pass together.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-implemented-core-2026-04-26-r2/openclaw-stress/command.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-implemented-core-2026-04-26-r2/openclaw-stress/session-root.txt`
  - `/tmp/agentgit-openclaw-qualification-production-beta-implemented-core-2026-04-26-r2-1777234920464/report/summary.json`

## Sensitive Redaction

- Suite id: `sensitive-redaction`
- Status: `blocked`
- Required: yes
- Duration: 1ms
- Command: `scan latest OpenClaw qualification artifacts`
- Summary: No OpenClaw stress summary was available to scan.
- Production implication: Synthetic secrets must not leak into qualification summaries or browser-visible evidence.

## Diff Check

- Suite id: `diff-check`
- Status: `passed`
- Required: yes
- Duration: 49ms
- Command: `git diff --check`
- Summary: All commands completed successfully.
- Production implication: Whitespace and patch hygiene must be clean before publishing release evidence.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-implemented-core-2026-04-26-r2/diff-check/command-1.json`

