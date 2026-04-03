# @agentgit/snapshot-engine

> **Internal package** — used by the agentgit daemon. Not published to npm.

Creates recovery boundaries before risky, recoverable agent actions. When the policy engine returns `allow_with_snapshot`, the snapshot engine selects the minimum capture class that satisfies the recovery promise and writes a `SnapshotManifest` to the workspace index.

---

## What It Does

Not every action needs a snapshot. The snapshot engine applies the cheapest capture strategy based on the action's operation family, scope breadth, side-effect level, confidence score, and disk pressure.

### Snapshot classes

| Class | What's captured | Use case |
|-------|----------------|----------|
| `full` | Complete file content + metadata | High-risk writes requiring exact rollback |
| `metadata_only` | Path, size, mode, hash — no bodies | Lower-risk writes; detect what changed |
| `content_only` | Content without metadata (rare) | Narrow-scope content recovery |
| `none` | Nothing captured | Read-only or non-recoverable actions |

---

## Snapshot Manifest

Each snapshot produces a `SnapshotManifest`:

```ts
{
  snapshot_id: "snap_<timestamp>_<uuid>",
  action_id: "act_xyz",
  run_id: "run_abc",
  target_path: "/workspace/src/index.ts",
  workspace_root: "/workspace",
  existed_before: true,
  entry_kind: "file",                  // "file" | "directory" | "missing"
  snapshot_class: "full",
  fidelity: "full",                    // "full" | "metadata_only" | "content_only" | "degraded"
  created_at: "...",
  anchor_content_hash: "sha256:...",
  operation_domain: "filesystem",
  operation_kind: "write",
  side_effect_level: "write",
  reversibility_hint: "reversible",
}
```

---

## Selection Logic

The engine evaluates a `SnapshotSelectionInput` and returns a `SnapshotSelectionResult` with the chosen class and reason codes:

```ts
// Factors considered:
// - operation_family (filesystem.write, shell.execute, etc.)
// - scope_breadth (single file, directory, workspace-wide, unknown)
// - side_effect_level (read_only, write, delete)
// - normalization_confidence (0.0-1.0)
// - low_disk_pressure_observed
// - journal_chain_depth (how many actions since last anchor)
// - explicit_branch_point (operator-flagged checkpoint)
// - explicit_hard_checkpoint
```

---

## Deduplication

If the workspace hasn't changed since the last anchor (same content hash), the engine reuses the existing anchor instead of writing a new snapshot record. This keeps the journal lean during runs with many small actions against a stable workspace.

---

## Snapshot GC

Snapshots are pruned during maintenance when they are no longer referenced by any active recovery plan:

- `snapshot_gc` — removes expired/orphaned snapshots
- `snapshot_compaction` — merges adjacent snapshots for the same workspace root
- `snapshot_rebase_anchor` — rebases anchor chains to save storage

---

## Related Packages

- [`@agentgit/workspace-index`](../workspace-index/README.md) — stores the actual manifest files
- [`@agentgit/recovery-engine`](../recovery-engine/README.md) — reads snapshots to build restore plans
- [`@agentgit/run-journal`](../run-journal/README.md) — snapshot records are persisted here
- [`@agentgit/policy-engine`](../policy-engine/README.md) — triggers snapshots via `allow_with_snapshot`
- [`@agentgit/schemas`](../schemas/README.md) — `SnapshotRecord` type definition
