# OpenClaw Production Readiness Live Test - 2026-04-25

## Scope

Live local production-readiness qualification against a git-backed synthetic OpenClaw-style workspace with realistic repo data, synthetic customer data, protected secrets/config files, outside-root and symlink escape fixtures, governed note/draft integration actions, snapshot-backed file mutations, and explicit checkpoint restore.

## Command

```sh
pnpm stress:production-readiness -- --session-root /tmp/agentgit-openclaw-prod-1777143478 --seed 20260425 --delay-ms 25
```

## Result

- Summary: pass
- Run: `run_019dc60194727448970b20d2238d4284`
- Workspace: `/tmp/agentgit-openclaw-prod-1777143478/workspace`
- Report: `/tmp/agentgit-openclaw-prod-1777143478/report/summary.json`
- Evidence:
  - `/tmp/agentgit-openclaw-prod-1777143478/report/evidence/run-summary.json`
  - `/tmp/agentgit-openclaw-prod-1777143478/report/evidence/timeline.internal.json`
  - `/tmp/agentgit-openclaw-prod-1777143478/report/evidence/helper.what-happened.json`
  - `/tmp/agentgit-openclaw-prod-1777143478/report/evidence/policy-calibration-report.json`
  - `/tmp/agentgit-openclaw-prod-1777143478/report/evidence/diagnostics.json`

## Runtime Totals

- Actions attempted: 36
- Completed: 11
- Blocked/denied: 25
- Expected blocked paths: 15/15 matched
- Command failures: 0
- Snapshot-backed actions: 11
- Recovery plans: 11
- Reversible recoveries executed: 5
- Compensating recovery plans: 6
- Exact restore matches: 5
- Exact restore mismatches: 0
- Explicit checkpoints created: 1
- Explicit checkpoint recoveries executed: 1
- Explicit checkpoint exact restore matches: 1
- Explicit checkpoint exact restore mismatches: 0

## Browser Verification

Verified in the local production Next server at `http://localhost:3137` with the OpenClaw workspace connected to the `Live Loop Workspace`.

- Repository list shows `openclaw/production-readiness-pipeline` as connected, completed, and healthy.
- Run detail loads `run_019dc60194727448970b20d2238d4284`, shows `openclaw-production-readiness`, 126 timeline steps, deny outcomes, allow-with-snapshot outcomes, snapshot links, and completed status.
- Action detail loads `act_019dc601bbbb707e8aa2343303987a88`, shows `allow_with_snapshot`, destructive filesystem delete, snapshot `snap_1777143495617_d384af90670f41e9a5671f70c906bd69`, execution event trail, and recovery context.
- Snapshots page lists 12/12 snapshots, 12 restorable manifests, all verified, 6 restored, and the explicit checkpoint snapshot `snap_1777143496166_4d4b604d470d472d92713fe21bf35017`.
- Activity page shows OpenClaw recovery and run events.
- Audit page shows OpenClaw recovery events for `openclaw-production-readiness`.

## Bugs Exposed And Fixed

- Explicit checkpoint restore did not remove a new live file created after the checkpoint when that file had never been indexed. Fixed in `packages/workspace-index/src/index.ts` by removing live files outside the target restoration set during restore execution.
- Added regression coverage in `packages/workspace-index/src/index.test.ts`.
- Added CLI support for `create-run-checkpoint` plus run-checkpoint recovery targets in `packages/authority-cli/src/commands/runtime.ts`.

## Production Signal

The current policy correctly blocks protected data writes, policy control-surface writes, symlink escape writes, outside-root shell writes, and secret-copy shell attempts.

Broad shell-based pipeline/customer-data transforms were denied. That is the safer current behavior. For OpenClaw-style autonomous pipelines, production agents should either decompose work into governed filesystem actions or wait for true OS/container containment before arbitrary local shell is treated as production-ready.
