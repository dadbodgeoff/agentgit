# @agentgit/workspace-index

> **Internal package** — used by the agentgit daemon. Not published to npm.

Persisted workspace snapshot metadata. Tracks files and directories within workspace roots so the snapshot engine can efficiently detect changes, anchor snapshots, and support layered restore operations.

---

## What It Does

`workspace-index` is the storage layer for workspace manifests. It answers questions the snapshot engine asks:

- What files exist in this workspace, with what content hashes?
- What changed since the last snapshot?
- Which snapshot anchor covers this workspace at this hash?

It does **not** store file content bodies — just metadata (path, hash, size, mode). Content for `full` snapshots is stored in the snapshot root directory.

---

## Key Types

### DirtyFile
Represents a file change detected during a workspace scan:

```ts
{
  path: string;
  change_type: "created" | "modified" | "deleted" | "permissions";
  content_hash: string;
  size_bytes: number;
  file_mode: number;
}
```

### SnapManifest
A snapshot manifest record:

```ts
{
  snap_id: "snap_<uuid>";
  parent_snap_id: string | null;      // layered snapshot chain
  workspace_root: string;
  baseline_revision: number;
  scan_seq: number;
  trigger_reason: string;
  action_id: string | null;
  run_id: string | null;
  file_count: number;
  total_bytes: number;
  created_at: string;
  anchor_path: string | null;         // path of the anchor file
  anchor_exists: boolean;
  anchor_content_hash: string | null;
  anchor_file_mode: number | null;
  anchor_source_snap_id: string | null;
  files: DirtyFile[];
}
```

### LayeredSnapshotRecord
A snapshot in the layered chain:

```ts
{
  snap_id: string;
  parent_snap_id: string | null;
  baseline_revision: number;
  scan_seq: number;
  file_count: number;
  total_bytes: number;
  dirty_files: DirtyFile[];
  created_at: string;
  // + anchor metadata fields
}
```

---

## Restore Operations

After a recovery plan is executed, the workspace-index records the restore:

```ts
interface RestoreResult {
  target_snap_id: string;
  files_restored: Array<{
    path: string;
    action: "restored" | "removed" | "permissions_reset";
  }>;
  restored_at: string;
  recovery_snapshot_id: string;
}
```

---

## Anchor Rebase

`AnchorRebaseResult` is returned by the `snapshot_rebase_anchor` maintenance job:

```ts
{
  snapshots_scanned: number;
  anchors_rebased: number;
  bytes_freed: number;
  empty_directories_removed: number;
}
```

---

## SQLite Storage

Workspace index data is stored in a dedicated SQLite database at `<project-root>/.agentgit/state/mcp/` (alongside the other state databases). Tables track:

- Baseline revisions per workspace root
- Layered snapshot chains (parent → child)
- Dirty file sets per snapshot
- Anchor file metadata

---

## Related Packages

- [`@agentgit/snapshot-engine`](../snapshot-engine/README.md) — calls workspace-index to capture and query manifests
- [`@agentgit/recovery-engine`](../recovery-engine/README.md) — reads manifests to build restore plans and describe changes
- [`@agentgit/run-journal`](../run-journal/README.md) — snapshot records are linked to journal events
