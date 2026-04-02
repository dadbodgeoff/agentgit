# Recovery Drill Runbook

Status date: 2026-04-02 (America/New_York)

## Purpose

Run a repeatable local-first recovery drill to prove snapshot/recovery reliability before MVP launch.

## MVP Targets

- `RTO` target: `<= 15 minutes` from drill start to successful recovery verification.
- `RPO` target: recover to the latest valid snapshot/action boundary selected for the drill.

## Prerequisites

- daemon reachable
- workspace path known
- `jq` installed for parsing JSON output

## Drill Scenario

Use a controlled filesystem mutation and recover from it.

## Step 1: Start And Verify Runtime

```bash
pnpm daemon:start
pnpm cli -- --json ping
pnpm cli -- --json doctor
```

Pass criteria:
- `ping` succeeds
- `doctor` reports daemon reachability

## Step 2: Create Session And Run

```bash
SESSION_ID=$(pnpm cli -- --json hello | jq -r '.session_id')
RUN_ID=$(pnpm cli -- --json register-run recovery-drill | jq -r '.run_id')
echo "session=$SESSION_ID run=$RUN_ID"
```

Pass criteria:
- both IDs are non-empty

## Step 3: Execute Controlled Mutation

```bash
TARGET_PATH="recovery-drill.txt"
pnpm cli -- --json submit-filesystem-write "$RUN_ID" "$TARGET_PATH" "drill-v1"
pnpm cli -- --json submit-filesystem-delete "$RUN_ID" "$TARGET_PATH"
```

Pass criteria:
- both submissions return `ok=true`

## Step 4: Inspect Timeline For Recovery Target

```bash
pnpm cli -- --json timeline "$RUN_ID" internal > /tmp/recovery-drill-timeline.json
cat /tmp/recovery-drill-timeline.json | jq '.steps | length'
```

Pick a valid recovery target from timeline data:
- snapshot boundary target, or
- action boundary target

## Step 5: Plan Recovery

Example with action target:

```bash
RECOVERY_TARGET="<snapshot-id-or-action-id>"
pnpm cli -- --json plan-recovery "$RECOVERY_TARGET" > /tmp/recovery-plan.json
cat /tmp/recovery-plan.json | jq '.'
```

Pass criteria:
- response contains a recovery plan with non-empty plan id/strategy details
- no `manual_review_required` downgrade unless expected by policy/capability state

## Step 6: Execute Recovery

```bash
pnpm cli -- --json execute-recovery "$RECOVERY_TARGET" > /tmp/recovery-execute.json
cat /tmp/recovery-execute.json | jq '.'
```

Pass criteria:
- recovery execution returns success state
- terminal recovery result is not failed

## Step 7: Verify Post-Recovery State

```bash
pnpm cli -- --json run-summary "$RUN_ID" > /tmp/recovery-run-summary.json
pnpm cli -- --json timeline "$RUN_ID" internal > /tmp/recovery-timeline-after.json
```

Filesystem verification:

```bash
if [ -f "$TARGET_PATH" ]; then
  echo "target exists"
else
  echo "target missing"
fi
```

Pass criteria:
- observed filesystem state matches planned recovery target outcome
- timeline includes recovery plan/execution evidence

## Step 8: Capture Evidence Bundle

```bash
mkdir -p ./recovery-drill-evidence
cp /tmp/recovery-drill-timeline.json ./recovery-drill-evidence/
cp /tmp/recovery-plan.json ./recovery-drill-evidence/
cp /tmp/recovery-execute.json ./recovery-drill-evidence/
cp /tmp/recovery-run-summary.json ./recovery-drill-evidence/
cp /tmp/recovery-timeline-after.json ./recovery-drill-evidence/
```

Record:
- drill start/end timestamps
- measured RTO
- selected recovery target type
- pass/fail and any downgrade reason

## Failure Handling

If plan or execute fails:

1. collect diagnostics:

```bash
pnpm cli -- --json diagnostics storage_summary
pnpm cli -- --json diagnostics capability_summary
pnpm cli -- --json diagnostics daemon_health
```

2. switch to manual-review recovery path if required.
3. file an incident with command outputs and run id.

## Launch Signoff Requirement

Before MVP launch, at least one completed drill artifact set must be attached to release signoff.

## Executed Drill Record

Latest executed drill artifact set:

- [Recovery Drill Report](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/recovery-drills/2026-04-02-mvp-recovery-drill/REPORT.md)
- [Recovery Drill Summary](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/recovery-drills/2026-04-02-mvp-recovery-drill/summary.json)
