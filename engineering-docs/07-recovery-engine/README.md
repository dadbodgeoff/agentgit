# 07. Recovery Engine

## Working Thesis

The Recovery Engine should turn a past action boundary into the safest truthful remediation path available.

That path is not always “undo.”

For any action or boundary, recovery should classify the best available option as one of:

- `restore`
- `compensate`
- `review_only`
- `irrecoverable`

This subsystem should be rigorous about the difference.

The product promise is not:

- perfect reversibility for everything

It is:

- reversible when we can truly restore
- compensatable when we can safely counteract
- explainable when we can only review

## Why This Matters

If we pretend every side effect can be undone:

- users will lose trust quickly
- recovery will damage state further
- the timeline helper will overclaim

If recovery is only a button that says “restore snapshot”:

- external side effects are ignored
- partial failures become ambiguous
- users cannot reason about what they would lose

So the recovery engine should optimize for:

**truthful remediation with explicit boundaries, previews, and consequences**

## Research-Driven Design Constraints

### Inversion is not the same as restoration

SQLite’s session extension has an explicit notion of changeset inversion and rebase, which is a useful reminder:

- some changes can be inverted exactly
- some inversions must be rebased against later state

Design implication:

- recovery should distinguish exact restore from inverse replay against drifted state
- restore plans need preflight conflict checks

### Git offers multiple recovery models because one model is not enough

Official Git docs spread recovery across:

- `restore` for path content recovery
- `revert` for compensating commits
- `reflog` for finding old reachable positions
- `bisect` for locating the likely change that caused a problem

Design implication:

- our recovery model should similarly separate:
  - restore to prior state
  - compensating follow-up action
  - investigation support

### Filesystem-native rollback primitives are powerful but scope-bound

ZFS rollback/snapshots and Btrfs snapshots are strong exact-state tools, but they operate within dataset/subvolume boundaries and may not fit every workspace shape.

Design implication:

- restore promises must be scoped to the snapshot substrate that actually exists
- whole-workspace rollback should not be promised when only partial anchors exist

### Recovery must survive drift

The longer the time between action and recovery:

- the more likely later actions depend on the earlier state
- the more likely exact restore becomes destructive to newer work

Design implication:

- recovery needs impact previews
- restore plans should identify conflicting later actions and data loss risk

## Product Role

The Recovery Engine consumes:

- `SnapshotRecord`
- `ExecutionResult`
- journal history
- target recovery boundary

and produces:

- a recovery classification
- a preview
- an executable remediation plan
- a recorded recovery result

## Non-Goals

- Guarantee exact reversal of external systems without integration support
- Hide recovery conflicts
- Assume latest state can always be safely replaced by older state
- Replace forensic investigation when no remediation is safe

## Recovery Classes

### 1. `restore`

Meaning:

- we can restore the affected protected state to a previously recorded boundary with high confidence

Examples:

- revert governed filesystem edits using journal data
- restore anchored workspace state
- recover deleted file contents from preimage or anchor

### 2. `compensate`

Meaning:

- we cannot literally restore prior state, but we can apply a follow-up action that counteracts the effect

Examples:

- send a follow-up message
- archive or void a created record
- create a compensating API call
- revert a commit by applying inverse changes rather than time-traveling the entire workspace

### 3. `review_only`

Meaning:

- the system can explain what happened and what later changes depend on it, but it cannot safely remediate automatically

Examples:

- broad shell action with insufficient exact state
- browser workflow that touched an external site without compensating API support
- partial observed-only actions outside governed boundaries

### 4. `irrecoverable`

Meaning:

- no trustworthy restore or compensation path exists

Examples:

- irreversible payment with no refund path exposed to the adapter
- external communication that cannot be unsent
- destructive external operation without snapshots, audit hooks, or compensators

## Recovery Boundary Model

Recovery should work against explicit boundaries, not loose timestamps.

### Supported boundary types

- `snapshot_id`
- `action_boundary`
- `run_checkpoint`
- `branch_point`
- `external_object`
- `path_subset`

### Current runtime support

- `snapshot_id`
  - plans exact restore when a persisted snapshot exists
- `action_boundary`
  - resolves to the linked snapshot boundary when one was captured
  - otherwise returns `review_only` with manual guidance rather than inventing restore
- `run_checkpoint`
  - resolves to a persisted `snapshot.created` boundary inside a run via an opaque `<run_id>#<sequence>` token
  - returns `NOT_FOUND` or `PRECONDITION_FAILED` instead of guessing when the checkpoint token is missing or malformed
- `branch_point`
  - resolves to a persisted `snapshot.created` boundary inside a run via structured `{ run_id, sequence }` input
  - uses the same fail-closed rules as `run_checkpoint`, but without opaque token parsing
- `external_object`
  - resolves to the newest governed boundary for a recorded external object identifier
  - fails closed when the object identifier is ambiguous across object families
- `path_subset`
  - resolves against a persisted filesystem snapshot boundary and restores only the requested in-workspace paths
  - returns `review_only` for metadata-only boundaries and `PRECONDITION_FAILED` when a requested path escapes the workspace root
  - also degrades to `review_only` when cached workspace access or runtime storage capability state is stale, unavailable, or incomplete enough to make automatic restore untrustworthy

### Why this matters

Users ask questions like:

- “undo what happened after step 4”
- “take me back before this refactor”
- “what would I lose if I revert here?”

Those are boundary questions, not raw event questions.

## RecoveryPlan Shape

The recovery engine should emit a plan before execution.

Recommended shape:

```json
{
  "recovery_plan_id": "recp_01H...",
  "target_boundary": {
    "kind": "action_id",
    "id": "act_01H..."
  },
  "classification": "restore",
  "confidence": "high",
  "steps": [
    {
      "kind": "restore_files",
      "snapshot_id": "snap_01H...",
      "paths": ["src/app.ts", "README.md"]
    }
  ],
  "impact_preview": {
    "later_actions_affected": 3,
    "protected_paths_changed_after_boundary": 2,
    "external_side_effects_not_restored": 1
  },
  "warnings": [
    {
      "code": "LATER_CHANGES_WILL_BE_LOST",
      "message": "Two later governed edits touch the same protected paths."
    }
  ]
}
```

## Recovery Pipeline

### Step 1. Locate candidate boundary

Find the relevant:

- snapshot
- action
- branch point
- journal slice

### Step 2. Classify recoverability

Use:

- snapshot fidelity
- execution path
- artifact quality
- current drift
- external object identifiers

### Step 3. Build impact preview

Compute:

- later governed actions touching same scope
- newer snapshots layered on top
- external side effects not covered by restore
- probable data loss if state is rolled back

### Step 4. Build recovery plan

Choose:

- exact restore
- inverse/compensating operation
- mixed plan
- review-only answer

### Step 5. Validate preconditions

Before executing recovery:

- verify referenced artifacts still exist
- verify snapshots are restorable
- verify required credentials or permissions exist
- verify no hard conflicts force downgrade to review-only

### Step 6. Execute and journal

Recovery execution should itself be treated as a governed action lineage and journaled accordingly.

## Restore Semantics

`restore` should not be one mechanism.
It should choose among several.

### Text/file restore

Preferred order:

1. exact journal replay from preimages or reverse patches
2. restore from `journal_plus_anchor`
3. restore from `exact_anchor`
4. path-level restore from content-addressed blob refs

### Workspace restore

Preferred when:

- anchor fidelity is high
- scope is broad
- later drift analysis is acceptable

This should always surface what newer changes are being overwritten.

### Drift-aware restore

If later changes affect the same paths:

- offer full restore
- or selective restore if safe
- or downgrade to `review_only` if conflict risk is too high

## Compensation Semantics

Compensation is a first-class path, not a fallback hack.

### Good compensation candidates

- API objects with delete/archive/void endpoints
- emails with follow-up correction pattern
- browser/admin actions where the same integration can undo or archive the created object
- version-control operations where inverse change application is safer than time-travel restore

### Compensation record requirements

- original external object IDs
- adapter/integration identity
- compensating action type
- known limitations

### Honesty rule

Compensation should say:

- what effect is being counteracted
- what cannot be undone

## Review-Only Path

When recovery is not safely automatable, the engine should still produce a useful answer.

At minimum the runtime should surface:

- systems touched
- objects touched
- likely manual steps
- concrete uncertainty

This is especially important for:

- action boundaries with no persisted snapshot
- metadata-only boundaries
- external effects without adapter-specific compensators

That answer should include:

- what happened
- what changed afterward
- which dependent actions make rollback risky
- which external effects remain live
- recommended manual next steps if known

This is part of the product, not a failure mode to hide.

## Impact Preview

Before executing any meaningful recovery, the engine should answer:

- what later actions overlap this boundary?
- what protected paths will change?
- what external effects remain untouched?
- what data or work will be lost?

### Launch preview fields

- `later_actions_affected`
- `overlapping_paths`
- `external_effects_remaining`
- `estimated_data_loss_scope`
- `confidence`

## Reversibility Labels

These should be derived from both action class and actual recorded evidence.

### Launch labels

- `exact_restore_available`
- `selective_restore_available`
- `compensation_available`
- `review_only`
- `irrecoverable`

These should appear in the timeline and helper output.

## Interaction With Other Subsystems

### Snapshot Engine

Provides:

- snapshot fidelity
- manifest and anchor refs
- journal lineage

### Execution Adapters

Provide:

- partial completion evidence
- external object IDs
- artifacts needed for compensation or review

### Run Journal

Provides:

- ordered history
- later-overlap detection
- approval and execution context

## Recovery Result

Recovery should emit a durable result record.

Recommended fields:

- `recovery_result_id`
- `recovery_plan_id`
- `status`
- `classification_executed`
- `started_at`
- `completed_at`
- `artifacts`
- `warnings`
- `residual_risks`

Recommended statuses:

- `completed`
- `failed`
- `partial`
- `blocked`
- `aborted`

## Main Risks

### 1. Overwriting later good work

Mitigation:

- mandatory impact preview
- overlapping-path detection
- explicit warnings before restore

### 2. Pretending compensation equals undo

Mitigation:

- separate class labels
- require explicit limitation text

### 3. Missing artifacts at recovery time

Mitigation:

- validate before execution
- downgrade gracefully to review-only when possible

### 4. Recovery loops becoming invisible

Mitigation:

- journal recovery as its own governed lineage
- show “recovery of recovery” honestly in the timeline

## Build Order

1. Define `RecoveryPlan` and `RecoveryResult` schemas
2. Implement recoverability classification from snapshots and execution evidence
3. Implement path overlap and later-action impact previews
4. Implement text/file restore from journals and anchors
5. Implement workspace restore for strong anchor cases
6. Implement compensating-action hooks for owned API adapters
7. Implement review-only explanation outputs
8. Journal recovery execution and outcomes

## Concrete Recommendation

For v1, the recovery engine should optimize for one thing:

**tell the truth about what can be restored, show what will be lost, and only automate remediation when the boundary is strong enough to deserve trust**

That is how recovery becomes a real product capability instead of a scary button.

## Research Inputs

- SQLite session intro: <https://sqlite.org/sessionintro.html>
- SQLite invert changeset: <https://sqlite.org/session/sqlite3changeset_invert.html>
- SQLite rebase changeset: <https://sqlite.org/session/sqlite3rebaser_rebase.html>
- Git revert: <https://git-scm.com/docs/git-revert.html>
- Git restore: <https://git-scm.com/docs/git-restore.html>
- Git reflog: <https://git-scm.com/docs/git-reflog.html>
- Git bisect: <https://git-scm.com/docs/git-bisect.html>
- OpenZFS `zfs` docs: <https://openzfs.github.io/openzfs-docs/man/v0.8/8/zfs.8.html>
- OpenZFS `zfs-diff`: <https://openzfs.github.io/openzfs-docs/man/v2.0/8/zfs-diff.8.html>
- Btrfs subvolumes: <https://btrfs.readthedocs.io/en/latest/Subvolumes.html>
