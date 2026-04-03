# Recovery & Snapshots

agentgit pre-computes a recovery plan for every recoverable action before it executes. This page explains how snapshots work, what the recovery strategies mean, and how to plan and execute recovery.

---

## Recovery Strategies

| Strategy | When used | What recovery does |
|----------|-----------|------------------|
| Restore from snapshot | Filesystem writes with snapshot boundary | Restore files to their exact pre-action state |
| Compensation | Owned-function actions (ticket, note, draft) | Execute inverse operation (delete, reopen, restore field) |
| Remediation | Shell commands or bounded external effects | Describe outcome and manual steps; no automatic undo |
| Review only | Actions without a recovery path | Document event; surface impact; no automatic action |

---

## How Snapshots Work

A snapshot is a recovery boundary — a record of what the workspace looked like before a risky action executed.

The policy engine decides when to require a snapshot (via the `allow_with_snapshot` outcome). The snapshot engine then chooses the minimum capture class that satisfies the recovery promise for the action.

### Snapshot classes

| Class | What's captured | Use case |
|-------|----------------|----------|
| `full` | Complete file content + metadata | High-risk writes requiring exact rollback |
| `metadata_only` | File metadata only (path, size, mode, hash) | Lower-risk operations; detect changes |
| `content_only` | Content without metadata (rare) | Specific narrow scopes |
| `none` | No snapshot taken | Read-only or non-recoverable actions |

The engine considers: operation family, scope breadth, side-effect level, confidence score, disk pressure, and whether an explicit branch point was flagged.

### Snapshot IDs

Snapshots are identified as `snap_<timestamp>_<uuid>`. Pass a snapshot ID to `plan-recovery` or `execute-recovery` to target a specific boundary.

### Deduplication

If the workspace hasn't changed since the last snapshot for the same root, the engine reuses the existing anchor rather than capturing a new one.

---

## Planning Recovery

Always plan before executing — `plan-recovery` returns a full description of what recovery will do.

```bash
# Plan from an action ID
agentgit-authority plan-recovery act_xyz

# Plan from a snapshot ID
agentgit-authority plan-recovery snap_abc123

# JSON output
agentgit-authority --json plan-recovery act_xyz
```

**Example output:**
```
Recovery Plan  rp_abc
  Target       act_xyz (filesystem.write)
  Strategy     restore_from_snapshot
  Confidence   0.94

  Impact
    Data loss risk: low
    External effects: none

  Steps
    1. restore /workspace/src/index.ts from snap_abc
    2. restore /workspace/src/utils.ts from snap_abc

  Review guidance
    Systems touched: local filesystem
    Manual steps: none
```

Via TypeScript SDK:
```ts
const plan = await client.planRecovery("act_xyz");
console.log(plan.strategy);         // e.g. "restore_from_snapshot"
console.log(plan.confidence);       // 0.0-1.0
console.log(plan.impact_preview);   // { data_loss_risk, external_effects }
console.log(plan.steps);
console.log(plan.review_guidance);

// Preview without creating an executable plan
const preview = await client.planRecovery("act_xyz", { preview_only: true });
```

Via Python SDK:
```python
plan = client.plan_recovery("act_xyz")
print(plan["strategy"], plan["confidence"])

preview = client.plan_recovery("act_xyz", preview_only=True)
```

---

## Executing Recovery

After reviewing the plan, execute it:

```bash
agentgit-authority execute-recovery act_xyz
agentgit-authority --json execute-recovery act_xyz
```

```ts
const result = await client.executeRecovery("act_xyz");
```

```python
result = client.execute_recovery("act_xyz")
```

### Safety guarantees
- Plans are always shown before execution — no surprises
- `review_only` plans never attempt automatic changes
- Recovery execution is idempotent for snapshot restores — safe to retry
- Warnings are surfaced for low-confidence or uncertain recoveries

---

## Recovery Target Types

Recovery targets can be specified as a string ID or a structured target object:

| Target type | What it covers |
|-------------|---------------|
| `snapshot_id` | A specific named snapshot boundary |
| `action_boundary` | Restore state as of before a specific action |
| `run_checkpoint` | Restore to a run checkpoint |
| `branch_point` | Restore to a branch/decision point |
| `path_subset` | Restore a specific path subset |
| `external_object` | Plan compensation for an external object |

```ts
// String shorthand (resolves type automatically)
await client.planRecovery("snap_abc");
await client.planRecovery("act_xyz");

// Structured target
await client.planRecovery({ type: "action_boundary", id: "act_xyz" });
await client.planRecovery({ type: "path_subset", id: "snap_abc", paths: ["/workspace/src"] });
```

---

## Compensation (Owned Functions)

For owned-function integrations (drafts, notes, tickets), recovery uses compensation rather than snapshot restore. The execution adapter records the **preimage** at mutation time, enabling precise compensation plans.

**Examples:**

| Action | Compensation plan |
|--------|------------------|
| Create ticket | Close + delete ticket |
| Update field (null → alice) | Restore field to null |
| Close ticket | Reopen ticket |
| Add label "priority/high" | Remove label |
| Create draft | Archive + delete draft |

---

## Recovery Drills

Run this against a test workspace before needing recovery in production:

```bash
# 1. Register a test run
agentgit-authority register-run recovery-drill

# 2. Write a test file (note the action_id from the output)
agentgit-authority submit-filesystem-write <run-id> /tmp/drill-test.txt "original"

# 3. Overwrite it (simulate a mistake)
agentgit-authority submit-filesystem-write <run-id> /tmp/drill-test.txt "overwritten"

# 4. Find action IDs in the timeline
agentgit-authority --json timeline <run-id>

# 5. Plan recovery for the second write
agentgit-authority plan-recovery <second-action-id>

# 6. Execute recovery
agentgit-authority execute-recovery <second-action-id>

# 7. Verify the file was restored
cat /tmp/drill-test.txt   # → "original"
```

---

## Snapshot Maintenance

Snapshot GC runs during daemon maintenance. Trigger manually:

```bash
agentgit-authority maintenance snapshot_gc
agentgit-authority maintenance snapshot_compaction
agentgit-authority maintenance snapshot_rebase_anchor
agentgit-authority --json maintenance snapshot_gc snapshot_compaction
```

Default retention: snapshots linked to unresolved recovery plans are kept. Expired plan snapshots are eligible after the configured `artifact_expiry_days`.

---

## Related

- [Core Concepts: Snapshots](Core-Concepts.md#3-snapshots)
- [Core Concepts: Recovery](Core-Concepts.md#5-recovery)
- [CLI Reference: recovery commands](CLI-Reference.md#recovery)
- [`@agentgit/snapshot-engine` README](../packages/snapshot-engine/README.md)
- [`@agentgit/recovery-engine` README](../packages/recovery-engine/README.md)
