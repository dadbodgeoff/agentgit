# Core Concepts

Understanding these five concepts will give you a solid mental model of how agentgit works.

---

## 1. Actions

An **Action** is the canonical unit of governance. Everything an agent does becomes an Action.

When an agent submits something — "write this file", "run this command", "call this tool" — the action normalizer converts the raw attempt into a stable Action record before anything else happens. This normalization step is what makes the rest of the system possible: policy evaluation, journaling, and recovery all operate on the canonical Action shape, not on raw tool calls.

**Key fields:**
```ts
{
  action_id: "act_xyz",
  run_id: "run_abc",
  domain: "filesystem",          // execution_domain
  tool_name: "write_file",
  normalized_inputs: { ... },
  side_effect_level: "write",    // read_only | write | delete
  recovery_class: "reversible",  // what kind of recovery is possible
  confidence_estimate: 0.85,     // how well-formed / predictable this action is
  workspace_path_validated: true,
  provenance: { submitted_at, agent_id, sdk_version },
}
```

**Why it matters:** By the time an action reaches the policy engine, it's always the same shape — regardless of which SDK or agent submitted it. This means policy rules are domain-level, not SDK-specific.

---

## 2. Policy

**Policy** is the set of rules that determine what happens to an action. The policy engine evaluates each Action and returns exactly one **PolicyOutcome**.

### The five outcomes

| Outcome | What happens next |
|---------|------------------|
| `allow` | Execute immediately |
| `deny` | Reject; surface reason to agent and journal |
| `ask` | Block; create approval request for operator |
| `simulate` | Dry-run; describe what would happen, don't execute |
| `allow_with_snapshot` | Capture a rollback boundary, then execute |

### Rule types
- **Trust rules** — confidence thresholds per domain/side-effect level
- **Safe modes** — global overrides (`simulate_all`, `ask_all`, `allow_readonly`)
- **Budgets** — limits on operation counts or file sizes per run
- **Approval gates** — required approvals for specific action signatures

### What "deterministic" means here
Given the same Action and the same policy config, the policy engine always returns the same outcome. There's no randomness, no ML model, no ambiguity. This is intentional: it makes policy auditable and replayable.

→ [Policy Engine deep dive](Policy-Engine.md)

---

## 3. Snapshots

A **Snapshot** is a recovery boundary — a record of what the workspace looked like before a risky action executed, so the action can be undone if needed.

Not every action gets a snapshot. The policy engine decides when to require one (via the `allow_with_snapshot` outcome). The snapshot engine then chooses the cheapest capture strategy that satisfies the recovery promise.

### Snapshot classes

| Class | What's captured | Recovery capability |
|-------|----------------|---------------------|
| `metadata_only` | Path + metadata manifest only | Detect what changed and support review |
| `journal_only` | Journal lineage without a content anchor | Plan recovery and explain impact |
| `journal_plus_anchor` | Journal lineage plus a bounded anchor | Exact restore for the anchored scope |
| `exact_anchor` | Full anchored file bodies and metadata | Byte-for-byte rollback for the captured scope |

### Why not snapshot everything?
Snapshots have a cost — disk space, capture time, and maintenance overhead. The engine uses the minimum snapshot class that still satisfies the recovery promise. For many actions, a manifest-level snapshot (hashes, not bodies) is enough to accurately describe what recovery would need to do.

### Snapshot lifecycle
```
1. Policy returns allow_with_snapshot
2. Snapshot engine captures the selected boundary class
3. Action executes via adapter
4. Recovery engine derives the best available restore or review plan from that boundary
5. Snapshot is held until recovery plan is resolved or expires
6. Expired snapshots are pruned during inline maintenance
```

→ [Recovery & Snapshots deep dive](Recovery-and-Snapshots.md)

---

## 4. The Run Journal

The **Run Journal** is the append-only SQLite database that records everything. It is the single source of truth for the entire system.

### Key properties

**Logically append-only**: the audit model is append-only for reconstruction, but some SQLite rows are updated for maintenance and expiry bookkeeping. Treat the journal semantics as append-only, not the raw page layout.

**Causally linked**: each record references the records that produced it. An `ExecutionResult` links to its `Action`, which links to its `PolicyOutcome` and `SnapshotRecord`. Following these links reconstructs the full causal history of a run.

**Tamper-detectable**: audit export bundles include integrity hashes over journal records. The `run-audit-verify` command checks these hashes and exits non-zero if any record has been altered.

**Projection-friendly**: the timeline helper and recovery engine are pure reads over journal records — they derive their views from the canonical history without needing separate state.

### What's in the journal

```
RunEvent (atomic unit)
  ├── Action (normalized intent)
  ├── PolicyOutcome (evaluation result)
  ├── SnapshotRecord (recovery boundary, if captured)
  ├── ExecutionResult (adapter output)
  └── ApprovalRequest (if operator approval was required)
```

### Startup reconciliation
When the daemon starts, it reconciles the journal against the current state. Runs that were `in_progress` when the daemon last stopped are either recovered or marked with an appropriate terminal status. Stale timeline projections are rebuilt.

---

## 5. Recovery

**Recovery** is what happens when you need to undo or mitigate what an agent did.

agentgit distinguishes four recovery types because not everything is undoable in the same way:

### `reversible`
The action can be fully undone from a snapshot boundary.

**Example**: a filesystem write with a manifest snapshot. Recovery restores the files to their pre-action state.

**What you get**: a plan with explicit steps, confidence score, and impact preview. Execute with `execute-recovery`.

### `compensatable`
The action can't be rolled back, but can be undone with an inverse operation.

**Example**: creating a ticket. Recovery is "close the ticket" or "delete the draft".

**What you get**: a compensation plan derived from the preimage values captured by the integration-state package. Recovery executes the inverse operations.

### `review_only`
The action has no automatic recovery path, but agentgit can describe what happened and what was affected.

**Example**: a shell command that modified state in an opaque way. Recovery can't undo the command; the operator gets documentation, impact evidence, and review context rather than a reversible recovery promise.

### `irreversible`
The action has known irreversible external effects (e.g., an email was sent).

**What you get**: documentation of the event and explicit prevention of escalation. The operator is informed via the timeline.

### Recovery is always operator-reviewed
Plans are computed separately from execution. You always call `plan-recovery` first, review the plan (including confidence score and impact), then call `execute-recovery`. Low-confidence plans require explicit operator acknowledgment.

→ [Recovery & Snapshots deep dive](Recovery-and-Snapshots.md)

---

## How It All Fits Together

```
Action attempt
  ↓ normalize → Action record
  ↓ evaluate → PolicyOutcome (allow_with_snapshot)
  ↓ capture → SnapshotRecord
  ↓ execute → ExecutionResult + artifacts
  ↓ journal → RunEvent (links all of the above)
  ↓ pre-compute → RecoveryPlan
  ↓ project → TimelineStep
  ↓ operator reviews timeline, approvals, recovery options
```

Every step is recorded. Nothing is thrown away. The operator always has a complete picture.
