# Proposal: @agentgit/workspace-index — Incremental Dirty-File Tracking & Layered Snapshots

## Overview

A new package that replaces the current single-file-copy snapshot model with incremental workspace-aware snapshots. Only files that have actually changed since the last **durably committed workspace baseline** get captured. Snapshots become thin delta layers with parent pointers, enabling efficient point-in-time workspace recovery.

This revised proposal is deliberately **correctness-first**:

- No background processes
- No baseline mutation until snapshot commit succeeds
- No invented snapshot IDs
- No guessed crash outcomes
- No auto-compaction in v1
- No telemetry requirements in v1

No AI. No cron. Pure filesystem diffing triggered synchronously in the existing pipeline.

---

## Problem Statement

### Current Behavior

`LocalSnapshotEngine.createSnapshot()` copies the single target file of each action into `{rootDir}/{snapshotId}/preimage`. This works but has limitations:

1. No workspace awareness. Snapshots only know about the one file the action targets. If an agent modifies 5 files in sequence, each snapshot is isolated.
2. No deduplication. If the same file gets snapshotted repeatedly without changing, storage grows linearly.
3. No relationship between snapshots. There is no parent chain, so point-in-time workspace recovery is awkward.
4. Weak recovery semantics. The current snapshot record is durable only for that one target path.

### Target Behavior

- Snapshots capture only files that changed since the last committed baseline
- Snapshots form a linked chain enabling point-in-time recovery
- Recovery can restore the workspace to any snapshot in the chain
- Storage is proportional to actual change volume, not action count
- Snapshot state is never "advanced" unless a real snapshot commit succeeds

---

## Design

### New Package: `@agentgit/workspace-index`

**Responsibility**: Maintain a fast content-addressed index of the workspace filesystem. On demand, produce a dirty file list by diffing current state against the last committed baseline, then durably commit that diff as a snapshot layer.

**Dependencies**: `@agentgit/schemas` only. No other internal deps.

**No background processes.** The index is updated synchronously when called. It runs inside the existing snapshot path.

### Core Invariant

`file_index` is the **last durably committed workspace baseline**, not "whatever the most recent scan happened to observe."

That means:

- `prepareScan()` is read-only against the committed baseline
- `commitSnapshot()` is the only operation allowed to mutate `file_index`
- if snapshot copy/manifest/DB work fails, the baseline remains unchanged
- the next retry still sees the same dirty files and can recover safely

This is the main v1 safety property.

### Index Storage: SQLite

```sql
CREATE TABLE IF NOT EXISTS file_index (
  path          TEXT PRIMARY KEY,
  content_hash  TEXT NOT NULL,
  mtime_ms      INTEGER NOT NULL,
  size_bytes    INTEGER NOT NULL,
  file_mode     INTEGER NOT NULL,
  entry_kind    TEXT NOT NULL,       -- 'file' | 'directory' | 'symlink'
  is_deleted    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS snapshots (
  snap_id            TEXT PRIMARY KEY,
  parent_snap_id     TEXT,
  baseline_revision  INTEGER NOT NULL,
  scan_seq           INTEGER NOT NULL,
  trigger_reason     TEXT NOT NULL,
  action_id          TEXT,
  run_id             TEXT,
  file_count         INTEGER NOT NULL,
  total_bytes        INTEGER NOT NULL,
  created_at         TEXT NOT NULL,
  FOREIGN KEY (parent_snap_id) REFERENCES snapshots(snap_id)
);

CREATE TABLE IF NOT EXISTS snap_files (
  snap_id       TEXT NOT NULL,
  path          TEXT NOT NULL,
  change_type   TEXT NOT NULL,       -- 'created' | 'modified' | 'deleted' | 'permissions'
  content_hash  TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  file_mode     INTEGER NOT NULL,
  PRIMARY KEY (snap_id, path),
  FOREIGN KEY (snap_id) REFERENCES snapshots(snap_id)
);

CREATE TABLE IF NOT EXISTS prepared_scans (
  prepared_scan_id   TEXT PRIMARY KEY,
  baseline_revision  INTEGER NOT NULL,
  scan_seq           INTEGER NOT NULL,
  created_at         TEXT NOT NULL,
  committed_at       TEXT
);

CREATE TABLE IF NOT EXISTS index_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Stores: 'current_scan_seq', 'current_baseline_revision', 'workspace_root', 'schema_version'
```

### Prepare Scan Algorithm

```
prepareScan(workspace_root, ignore_patterns) → PreparedDirtySet

1. Atomically allocate next scan_seq
2. Read current_baseline_revision
3. Walk workspace filesystem (respecting ignore patterns)
4. Diff filesystem state against file_index
5. Build DirtyFile[] without mutating file_index
6. Persist a prepared_scans row
7. Return:
   {
     prepared_scan_id,
     baseline_revision,
     scan_seq,
     files: DirtyFile[]
   }
```

For each file found:

- If no baseline row exists → `created`
- If mtime + size match baseline row → fast-path skip
- If metadata differs → hash contents
- If hash differs → `modified`
- If content matches but mode differs → `permissions`
- After the walk, any baseline row not seen and not already deleted → `deleted`

`prepareScan()` must not update `file_index`, `is_deleted`, or the current baseline revision.

**Performance**: mtime+size comparison skips hashing for unchanged files. Only files with changed metadata get hashed.

### Ignore Patterns (Sensitive File Protection)

Built-in ignore list:

```
.env
.env.*
*.pem
*.key
*.p12
*.pfx
credentials.*
secrets.*
**/node_modules/**
**/.git/**
**/.agentgit/**
*.sqlite
*.db
*.sqlite-wal
*.sqlite-shm
```

User-configurable via `.agentgit/indexignore` using gitignore-like syntax.

Sensitive files never enter the snapshot store.

### Snapshot Commit (Delta Layers)

```
commitSnapshot(preparedDirtySet, options) → LayeredSnapshotRecord

1. Re-read current_baseline_revision
2. If it differs from preparedDirtySet.baseline_revision:
   - abort with retryable conflict (`baseline_changed`)
3. Create staging dir:
   .agentgit/snapshots/staging/{snap_id}/files/
4. Copy dirty files into staging
   - created/modified: copy file bytes
   - deleted: manifest-only row
   - permissions: copy file + store mode
5. Write manifest.json in staging
6. Atomically rename staging dir into:
   .agentgit/snapshots/snaps/{snap_id}/
7. In one SQLite transaction:
   - insert snapshot row
   - insert snap_files rows
   - promote prepared state into file_index
   - increment current_baseline_revision
   - mark prepared_scans.committed_at
8. Return LayeredSnapshotRecord
```

If any step before (7) fails, the baseline is unchanged.

If (7) fails, the snapshot files may already exist on disk, but they are not considered committed until the DB transaction succeeds.

### No Synthetic Snapshots

If a scan produces zero dirty files, v1 must do exactly one of these:

1. Return the current head snapshot explicitly, or
2. Persist a real zero-delta checkpoint

It must **not** fabricate a snapshot ID that cannot later be restored.

### Manifest

Each committed snapshot stores:

```json
{
  "snap_id": "snap_123",
  "parent_snap_id": "snap_122",
  "baseline_revision": 41,
  "scan_seq": 84,
  "trigger_reason": "action:write",
  "action_id": "act_123",
  "run_id": "run_123",
  "file_count": 3,
  "total_bytes": 12840,
  "created_at": "2026-03-29T17:00:00.000Z",
  "files": [
    {
      "path": "src/foo.ts",
      "change_type": "modified",
      "content_hash": "abc123",
      "size_bytes": 321,
      "file_mode": 420
    }
  ]
}
```

### Filesystem Layout

```
.agentgit/
  ├── index.db
  └── snapshots/
      ├── staging/
      │   └── snap_tmp_.../
      └── snaps/
          ├── snap_001/
          │   ├── manifest.json
          │   └── files/
          └── snap_002/
              ├── manifest.json
              └── files/
```

### Recovery: Chain Walking

To restore workspace to `snap_002`:

```
restore(target_snap_id) → RestoreResult

1. Build restoration set:
   - Start at target snap, collect snap_files
   - Walk parent chain backwards
   - For each file, first occurrence wins
   - Deleted files become removals
2. Apply restoration set to workspace
3. Run a fresh prepareScan() against restored workspace
4. Commit a normal recovery checkpoint as the new baseline
5. Return RestoreResult
```

Restoring should not silently mutate `file_index` via a write-on-scan side effect. Recovery should produce a normal committed baseline transition.

### Compaction (Post-v1)

Compaction is useful, but it should not ship in the first safe release. The first implementation should establish snapshot/restore invariants first.

Planned later flow:

```
compact(keep_last_n) → CompactionResult

1. Find snapshots older than the Nth most recent
2. Flatten them into one full snapshot
3. Delete old individual layers
4. Repoint the oldest kept snapshot to the compacted parent
5. Return bytes freed
```

---

## Integration Points

### What Changes in Existing Packages

#### schemas

New Zod types:

```typescript
export const DirtyFileSchema = z.object({
  path: z.string().min(1),
  change_type: z.enum(["created", "modified", "deleted", "permissions"]),
  content_hash: z.string().min(1),
  size_bytes: z.number().int().nonneg(),
  file_mode: z.number().int(),
});

export const PreparedDirtySetSchema = z.object({
  prepared_scan_id: z.string().min(1),
  baseline_revision: z.number().int().nonnegative(),
  scan_seq: z.number().int().positive(),
  files: z.array(DirtyFileSchema),
});

export const LayeredSnapshotRecordSchema = SnapshotRecordSchema.extend({
  parent_snap_id: z.string().nullable(),
  baseline_revision: z.number().int().nonnegative(),
  scan_seq: z.number().int().positive(),
  dirty_files: z.array(DirtyFileSchema),
});

export const RestoreResultSchema = z.object({
  target_snap_id: z.string().min(1),
  files_restored: z.array(z.object({
    path: z.string(),
    action: z.enum(["restored", "removed", "permissions_reset"]),
  })),
  restored_at: TimestampStringSchema,
});
```

#### snapshot-engine

- `LocalSnapshotEngine` gains a `WorkspaceIndex` dependency
- `createSnapshot()` calls `workspaceIndex.prepareScan()` then `workspaceIndex.commitSnapshot()`
- `restore()` delegates to workspace-index chain walking
- Backward compatible fallback remains available if no workspace index is configured

```typescript
async createSnapshot(request: SnapshotRequest): Promise<LayeredSnapshotRecord> {
  if (this.workspaceIndex) {
    const prepared = await this.workspaceIndex.prepareScan();
    return this.workspaceIndex.commitSnapshot(prepared, {
      trigger_reason: `action:${request.action.operation.name}`,
      action_id: request.action.action_id,
      run_id: request.action.run_id,
    });
  }

  return this.captureSingleFile(request);
}
```

#### authority-daemon

- Creates `WorkspaceIndex` on startup
- Passes it into `LocalSnapshotEngine`
- Performs live stale-state revalidation before execute
- Reconciles crash-interrupted actions on startup as `execution.outcome_unknown`

#### recovery-engine

- `planSnapshotRecovery()` uses chain-walking restore impact
- `executeSnapshotRecovery()` restores through workspace-index and emits a new recovery checkpoint

#### run-journal

- Adds `execution.outcome_unknown`
- May optionally store a lightweight phase marker later, but not required for v1

#### policy-engine

No required changes for v1.

### Dependency Graph

```
schemas
  ← workspace-index
  ← snapshot-engine
  ← authority-daemon
  ← recovery-engine
```

No circular deps. `workspace-index` remains a leaf package consumed by the snapshot path.

---

## Crash Recovery (Incomplete Action Handling)

### Problem

The daemon can crash after snapshot commit but before a terminal execution event is journaled. In that window, the workspace may or may not have been mutated already.

### Correct v1 Behavior

On daemon startup, scan the journal for actions that have a snapshot but no terminal execution event. Do **not** mark them as `execution.failed` automatically.

Instead, append a distinct event:

```typescript
async function recoverInterruptedActions(journal: RunJournal): Promise<void> {
  const allRuns = journal.listAllRuns();

  for (const run of allRuns) {
    const events = journal.listRunEvents(run.run_id);
    const snapshotEvents = events.filter((e) => e.event_type === "snapshot.created");

    for (const snapEvent of snapshotEvents) {
      const actionId = snapEvent.payload.action_id;
      const hasTerminalEvent = events.some(
        (e) =>
          e.payload?.action_id === actionId &&
          (
            e.event_type === "execution.completed" ||
            e.event_type === "execution.failed" ||
            e.event_type === "execution.simulated"
          ),
      );

      if (!hasTerminalEvent) {
        journal.appendRunEvent(run.run_id, {
          event_type: "execution.outcome_unknown",
          occurred_at: new Date().toISOString(),
          recorded_at: new Date().toISOString(),
          payload: {
            action_id: actionId,
            reason: "daemon_crash_recovery",
            message: "Daemon crashed before a terminal execution event was recorded. Workspace may have changed; snapshot preserved for reconciliation or manual recovery.",
          },
        });
      }
    }
  }
}
```

This keeps the journal truthful. The system preserves the snapshot and acknowledges uncertainty instead of inventing a failure outcome it cannot prove.

---

## Concurrent Agent Safety

### Problem

Two agents operate on the same workspace simultaneously. One agent prepares a snapshot against baseline revision `N`; another commits a different snapshot first.

### Solution (Minimal, Safe v1)

- `prepareScan()` reads `current_baseline_revision`
- `commitSnapshot()` succeeds only if that same revision is still current
- if the baseline changed, commit fails with a retryable conflict
- before execution, the daemon revalidates the target against **live disk**, not just the cached index

```typescript
const prepared = await workspaceIndex.prepareScan();
const snapshot = await workspaceIndex.commitSnapshot(prepared, options);

const currentState = await workspaceIndex.statLiveFile(action.target_path);
if (currentState.content_hash !== snapshot.target_preimage_hash) {
  throw new PreconditionError(
    "File modified between snapshot and execution. Another agent may have changed it.",
    {
      path: action.target_path,
      expected: snapshot.target_preimage_hash,
      actual: currentState.content_hash,
    },
  );
}
```

This is optimistic concurrency control with a real compare-and-swap boundary and live-file revalidation.

---

## Observability (Minimal v1)

Structured JSON logs to stdout only. No external deps.

Recommended v1 events:

```json
{"level":"info","pkg":"workspace-index","event":"prepare_scan_complete","files_scanned":847,"files_dirty":3,"duration_ms":42}
{"level":"info","pkg":"workspace-index","event":"snapshot_commit_succeeded","snap_id":"snap_123","file_count":3,"baseline_revision":41}
{"level":"warn","pkg":"workspace-index","event":"snapshot_commit_conflict","reason":"baseline_changed","expected_revision":41}
{"level":"warn","pkg":"authority-daemon","event":"execution_outcome_unknown_recovered","run_id":"run_123","action_id":"act_123"}
```

Keep the first release small: commit start/success/failure, restore start/success/failure, and startup crash reconciliation.

---

## Telemetry Hook Points (Post-v1)

The package naturally exposes useful counters:

```typescript
interface WorkspaceIndexTelemetry {
  scan_duration_ms: number;
  files_scanned: number;
  files_dirty: number;
  files_skipped_fast: number;
  bytes_snapshotted: number;
  restore_triggered: boolean;
  restore_chain_depth: number;
  restore_file_count: number;
  total_snap_count: number;
  total_storage_bytes: number;
}
```

All anonymous and opt-in. No file contents, no paths, no workspace structure.

This should ship only after the core snapshot invariants are proven.

---

## Action Groups / Transactions (Future — Design Only)

Multi-action transactions still fit naturally on top of the snapshot chain, but they are explicitly out of v1. The single-action model must be solid first.

---

## Explicit v1 Scope

Ship in v1:

- prepared scan against committed baseline
- atomic snapshot commit using staging dir + DB transaction
- zero-delta snapshot correctness
- chain-walking restore
- truthful crash reconciliation via `execution.outcome_unknown`
- optimistic concurrency with baseline compare-and-swap
- live-file stale-state revalidation before execute
- sensitive-file ignore support
- targeted tests for crash windows and concurrent scanners

Do not ship in v1:

- auto-compaction
- telemetry collection
- broad observability surface
- action groups / multi-action transactions

---

## Implementation Estimate

| Component | Effort | Lines (est.) |
|-----------|--------|-------------|
| workspace-index package (prepared scan, baseline CAS, dirty set) | Core | ~450 |
| Snapshot commit (staging dir, manifest, atomic promotion) | Core | ~250 |
| Chain-walking restore | Core | ~175 |
| Schema additions (Zod types) | Small | ~50 |
| Snapshot-engine refactor | Moderate | ~110 |
| Daemon wiring + live-file revalidation | Moderate | ~60 |
| Recovery-engine enhancement | Moderate | ~90 |
| Crash reconciliation on boot | Small | ~50 |
| Ignore patterns + sensitive file filter | Small | ~60 |
| Tests | Required | ~500 |
| **Total** | | **~1,795 lines** |

---

## Summary

This proposal adds incremental dirty-file tracking and layered delta snapshots to agentgit without changing the overall pipeline shape.

The key change from the original draft is the contract:

- scan is read-only against the committed baseline
- snapshot commit is atomic from the product's point of view
- zero-delta snapshots are real, not synthetic
- crash reconciliation is truthful (`execution.outcome_unknown`, not guessed failure)
- concurrent scanners are handled with baseline compare-and-swap

Sensitive-file protection ships in v1. Compaction, richer observability, telemetry, and action groups remain good follow-on work, but they are intentionally deferred until the core snapshot and recovery invariants are proven.
