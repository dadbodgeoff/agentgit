import { AgentGitError, InternalError, NotFoundError } from "@agentgit/schemas";
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type ChangeType = "created" | "modified" | "deleted" | "permissions";

export interface DirtyFile {
  path: string;
  change_type: ChangeType;
  content_hash: string;
  size_bytes: number;
  file_mode: number;
}

interface BaselineUpdate {
  path: string;
  content_hash: string;
  mtime_ms: number;
  size_bytes: number;
  file_mode: number;
  is_deleted: 0 | 1;
}

export interface PreparedDirtySet {
  prepared_scan_id: string;
  baseline_revision: number;
  scan_seq: number;
  files: DirtyFile[];
  scan_duration_ms: number;
  files_scanned: number;
  files_skipped_fast: number;
  baseline_updates: BaselineUpdate[];
}

export interface SnapManifest {
  snap_id: string;
  parent_snap_id: string | null;
  workspace_root: string;
  baseline_revision: number;
  scan_seq: number;
  trigger_reason: string;
  action_id: string | null;
  run_id: string | null;
  file_count: number;
  total_bytes: number;
  created_at: string;
  anchor_path: string | null;
  anchor_exists: boolean;
  anchor_content_hash: string | null;
  anchor_file_mode: number | null;
  anchor_source_snap_id: string | null;
  files: DirtyFile[];
}

export interface LayeredSnapshotRecord {
  snap_id: string;
  parent_snap_id: string | null;
  baseline_revision: number;
  scan_seq: number;
  file_count: number;
  total_bytes: number;
  dirty_files: DirtyFile[];
  created_at: string;
  anchor_path: string | null;
  anchor_exists: boolean;
  anchor_content_hash: string | null;
  anchor_file_mode: number | null;
  anchor_source_snap_id: string | null;
}

export interface RestoreResult {
  target_snap_id: string;
  files_restored: Array<{
    path: string;
    action: "restored" | "removed" | "permissions_reset";
  }>;
  restored_at: string;
  recovery_snapshot_id: string;
}

export interface RestorePreview {
  paths_to_change: number;
  later_actions_affected: number;
  overlapping_paths: string[];
  data_loss_risk: "low" | "moderate" | "high" | "unknown";
  confidence: number;
}

export interface AnchorRebaseResult {
  snapshots_scanned: number;
  anchors_rebased: number;
  bytes_freed: number;
  empty_directories_removed: number;
}

function storageErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const candidate = (error as { code?: unknown }).code;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function isLowDiskPressureError(error: unknown): boolean {
  const code = storageErrorCode(error);
  if (code === "ENOSPC" || code === "SQLITE_FULL") {
    return true;
  }

  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("no space left on device") || message.includes("database or disk is full");
}

function storageUnavailableError(message: string, error: unknown, details?: Record<string, unknown>): AgentGitError {
  const lowDiskPressure = isLowDiskPressureError(error);
  return new AgentGitError(
    message,
    "STORAGE_UNAVAILABLE",
    {
      ...details,
      cause: error instanceof Error ? error.message : String(error),
      storage_error_code: storageErrorCode(error),
      low_disk_pressure: lowDiskPressure,
      retry_hint: lowDiskPressure ? "Free disk space, then retry." : undefined,
    },
    lowDiskPressure,
  );
}

export interface SnapshotListEntry {
  snap_id: string;
  parent_snap_id: string | null;
  baseline_revision: number;
  trigger_reason: string;
  action_id: string | null;
  file_count: number;
  total_bytes: number;
  created_at: string;
}

export interface CompactionResult {
  snaps_removed: number;
  bytes_freed: number;
  compacted_snap_id: string | null;
}

export interface SqliteCheckpointResult {
  journal_mode: "WAL" | "DELETE";
  checkpointed: boolean;
  busy: number;
  log_frames: number;
  checkpointed_frames: number;
}

export interface WorkspaceIndexOptions {
  dbPath: string;
  workspaceRoot: string;
  snapshotDir: string;
  ignorePatterns?: string[];
}

export interface PersistedWorkspaceSnapshotIndex {
  workspace_root: string;
  snapshot_ids: string[];
}

interface FsEntry {
  relativePath: string;
  mtimeMs: number;
  size: number;
  mode: number;
}

type IndexRow = {
  path: string;
  content_hash: string;
  mtime_ms: number;
  size_bytes: number;
  file_mode: number;
  is_deleted: number;
};

const DEFAULT_IGNORE_PATTERNS = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "credentials.*",
  "secrets.*",
  "**/node_modules/**",
  "**/.git/**",
  "**/.agentgit/**",
  "*.sqlite",
  "*.db",
  "*.sqlite-wal",
  "*.sqlite-shm",
];

export function matchesIgnorePattern(filePath: string, patterns: string[]): boolean {
  const normalized = filePath.replaceAll(path.sep, "/");
  const basename = path.basename(normalized);

  for (const pattern of patterns) {
    if (pattern.includes("**/")) {
      const suffix = pattern.replace("**/", "");
      if (suffix.endsWith("/**")) {
        const dir = suffix.slice(0, -3);
        if (normalized.includes(`/${dir}/`) || normalized.startsWith(`${dir}/`)) {
          return true;
        }
      } else if (normalized.includes(suffix) || normalized.endsWith(suffix)) {
        return true;
      }
      continue;
    }

    if (pattern.startsWith("*.")) {
      const ext = pattern.slice(1);
      if (basename.endsWith(ext)) return true;
      continue;
    }

    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -2);
      if (basename.startsWith(prefix) && basename.includes(".")) return true;
      continue;
    }

    if (basename === pattern) return true;

    if (!pattern.endsWith(".*") && pattern.startsWith(".")) {
      if (basename === pattern || basename.startsWith(`${pattern}.`)) return true;
    }
  }

  return false;
}

async function hashFile(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function createPreparedScanId(): string {
  return `prep_${Date.now()}_${randomUUID().replaceAll("-", "")}`;
}

function createSnapId(): string {
  return `snap_${Date.now()}_${randomUUID().replaceAll("-", "")}`;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function normalizeSubsetSelectors(paths: string[], workspaceRoot: string): string[] {
  const resolvedRoot = path.resolve(workspaceRoot);
  const selectors = new Set<string>();

  for (const inputPath of paths) {
    const trimmed = inputPath.trim();
    if (trimmed.length === 0) {
      throw new AgentGitError("Path subset selectors must not be empty.", "PRECONDITION_FAILED", {
        paths,
      });
    }

    const resolvedPath = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(resolvedRoot, trimmed);
    if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new AgentGitError("Path subset selectors must stay within the workspace root.", "PRECONDITION_FAILED", {
        path: inputPath,
        workspace_root: resolvedRoot,
      });
    }

    const relativePath = path.relative(resolvedRoot, resolvedPath);
    selectors.add(relativePath.length === 0 ? "." : path.normalize(relativePath));
  }

  return Array.from(selectors).sort();
}

function pathMatchesSelectors(filePath: string, selectors: string[]): boolean {
  const normalizedPath = path.normalize(filePath);
  return selectors.some((selector) => {
    if (selector === ".") {
      return true;
    }

    const normalizedSelector = path.normalize(selector);
    return normalizedPath === normalizedSelector || normalizedPath.startsWith(`${normalizedSelector}${path.sep}`);
  });
}

async function walkWorkspace(rootDir: string, ignorePatterns: string[]): Promise<FsEntry[]> {
  const results: FsEntry[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(rootDir, fullPath);

      if (matchesIgnorePattern(relativePath, ignorePatterns)) {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      try {
        const stats = await fs.stat(fullPath);
        results.push({
          relativePath,
          mtimeMs: stats.mtimeMs,
          size: stats.size,
          mode: stats.mode,
        });
      } catch {
        // Best-effort walk; unreadable paths are skipped.
      }
    }
  }

  await walk(rootDir);
  return results;
}

export class WorkspaceIndex {
  private readonly db: Database.Database;
  private readonly workspaceRoot: string;
  private readonly snapshotDir: string;
  private readonly ignorePatterns: string[];

  constructor(options: WorkspaceIndexOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.snapshotDir = path.resolve(options.snapshotDir);
    const internalIgnorePatterns = this.buildInternalIgnorePatterns();
    this.ignorePatterns = [...DEFAULT_IGNORE_PATTERNS, ...internalIgnorePatterns, ...(options.ignorePatterns ?? [])];

    this.db = new Database(options.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.ensureSchema();
  }

  private buildInternalIgnorePatterns(): string[] {
    const relativeSnapshotDir = path.relative(this.workspaceRoot, this.snapshotDir).replaceAll(path.sep, "/");
    if (relativeSnapshotDir.length === 0 || relativeSnapshotDir === "." || relativeSnapshotDir.startsWith("..")) {
      return [];
    }

    return [`**/${relativeSnapshotDir}/**`];
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_index (
        path          TEXT PRIMARY KEY,
        content_hash  TEXT NOT NULL,
        mtime_ms      INTEGER NOT NULL,
        size_bytes    INTEGER NOT NULL,
        file_mode     INTEGER NOT NULL,
        entry_kind    TEXT NOT NULL DEFAULT 'file',
        scan_seq      INTEGER NOT NULL DEFAULT 0,
        is_deleted    INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        snap_id              TEXT PRIMARY KEY,
        parent_snap_id       TEXT,
        baseline_revision    INTEGER NOT NULL DEFAULT 0,
        scan_seq             INTEGER NOT NULL,
        trigger_reason       TEXT NOT NULL,
        action_id            TEXT,
        run_id               TEXT,
        file_count           INTEGER NOT NULL,
        total_bytes          INTEGER NOT NULL,
        created_at           TEXT NOT NULL,
        anchor_path          TEXT,
        anchor_exists        INTEGER NOT NULL DEFAULT 0,
        anchor_content_hash  TEXT,
        anchor_file_mode     INTEGER,
        anchor_source_snap_id TEXT,
        FOREIGN KEY (parent_snap_id) REFERENCES snapshots(snap_id)
      );

      CREATE TABLE IF NOT EXISTS snap_files (
        snap_id       TEXT NOT NULL,
        path          TEXT NOT NULL,
        change_type   TEXT NOT NULL,
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
    `);

    this.ensureMeta("current_scan_seq", "0");
    this.ensureMeta("current_baseline_revision", "0");
    this.ensureMeta("workspace_root", this.workspaceRoot);
    this.ensureMeta("schema_version", "2");
    this.ensureSnapshotColumn("baseline_revision", "INTEGER NOT NULL DEFAULT 0");
    this.ensureSnapshotColumn("anchor_path", "TEXT");
    this.ensureSnapshotColumn("anchor_exists", "INTEGER NOT NULL DEFAULT 0");
    this.ensureSnapshotColumn("anchor_content_hash", "TEXT");
    this.ensureSnapshotColumn("anchor_file_mode", "INTEGER");
    this.ensureSnapshotColumn("anchor_source_snap_id", "TEXT");
  }

  private ensureMeta(key: string, defaultValue: string): void {
    this.db.prepare("INSERT OR IGNORE INTO index_meta (key, value) VALUES (?, ?)").run(key, defaultValue);
  }

  private ensureSnapshotColumn(columnName: string, columnDefinition: string): void {
    const columns = this.db.prepare("PRAGMA table_info(snapshots)").all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === columnName)) {
      return;
    }

    this.db.exec(`ALTER TABLE snapshots ADD COLUMN ${columnName} ${columnDefinition}`);
  }

  private getMetaNumber(key: string): number {
    const row = this.db.prepare("SELECT value FROM index_meta WHERE key = ?").get(key) as { value: string };
    return parseInt(row.value, 10);
  }

  private allocateScanSeq(): number {
    return this.db.transaction(() => {
      const current = this.getMetaNumber("current_scan_seq");
      const next = current + 1;
      this.db.prepare("UPDATE index_meta SET value = ? WHERE key = 'current_scan_seq'").run(String(next));
      return next;
    })();
  }

  private getCurrentBaselineRevision(): number {
    return this.getMetaNumber("current_baseline_revision");
  }

  private async loadIgnorePatterns(): Promise<string[]> {
    const userIgnorePath = path.join(this.workspaceRoot, ".agentgit", "indexignore");
    let extraIgnores: string[] = [];
    try {
      const content = await fs.readFile(userIgnorePath, "utf8");
      extraIgnores = content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));
    } catch {
      // No user ignore file.
    }

    return [...this.ignorePatterns, ...extraIgnores];
  }

  async prepareScan(): Promise<PreparedDirtySet> {
    const startTime = Date.now();
    const scanSeq = this.allocateScanSeq();
    const baselineRevision = this.getCurrentBaselineRevision();
    const preparedScanId = createPreparedScanId();
    const ignores = await this.loadIgnorePatterns();
    const fsEntries = await walkWorkspace(this.workspaceRoot, ignores);
    const seenPaths = new Set<string>();
    const dirty: DirtyFile[] = [];
    const baselineUpdates: BaselineUpdate[] = [];
    let filesSkippedFast = 0;

    const getExisting = this.db.prepare(
      "SELECT path, content_hash, mtime_ms, size_bytes, file_mode, is_deleted FROM file_index WHERE path = ?",
    );
    const activeRows = this.db
      .prepare(
        "SELECT path, content_hash, mtime_ms, size_bytes, file_mode, is_deleted FROM file_index WHERE is_deleted = 0",
      )
      .all() as IndexRow[];

    for (const entry of fsEntries) {
      seenPaths.add(entry.relativePath);
      const existing = getExisting.get(entry.relativePath) as IndexRow | undefined;

      if (
        existing &&
        !existing.is_deleted &&
        existing.mtime_ms === entry.mtimeMs &&
        existing.size_bytes === entry.size &&
        existing.file_mode === entry.mode
      ) {
        filesSkippedFast += 1;
        continue;
      }

      const fullPath = path.join(this.workspaceRoot, entry.relativePath);
      let hash: string;
      try {
        hash = await hashFile(fullPath);
      } catch {
        continue;
      }

      const isNew = !existing || existing.is_deleted;
      const contentChanged = !!existing && !existing.is_deleted && existing.content_hash !== hash;
      const permissionsChanged =
        !!existing && !existing.is_deleted && existing.content_hash === hash && existing.file_mode !== entry.mode;

      baselineUpdates.push({
        path: entry.relativePath,
        content_hash: hash,
        mtime_ms: entry.mtimeMs,
        size_bytes: entry.size,
        file_mode: entry.mode,
        is_deleted: 0,
      });

      if (isNew) {
        dirty.push({
          path: entry.relativePath,
          change_type: "created",
          content_hash: hash,
          size_bytes: entry.size,
          file_mode: entry.mode,
        });
      } else if (contentChanged) {
        dirty.push({
          path: entry.relativePath,
          change_type: "modified",
          content_hash: hash,
          size_bytes: entry.size,
          file_mode: entry.mode,
        });
      } else if (permissionsChanged) {
        dirty.push({
          path: entry.relativePath,
          change_type: "permissions",
          content_hash: hash,
          size_bytes: entry.size,
          file_mode: entry.mode,
        });
      }
    }

    for (const row of activeRows) {
      if (seenPaths.has(row.path)) {
        continue;
      }

      dirty.push({
        path: row.path,
        change_type: "deleted",
        content_hash: row.content_hash,
        size_bytes: row.size_bytes,
        file_mode: row.file_mode,
      });

      baselineUpdates.push({
        path: row.path,
        content_hash: row.content_hash,
        mtime_ms: row.mtime_ms,
        size_bytes: row.size_bytes,
        file_mode: row.file_mode,
        is_deleted: 1,
      });
    }

    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO prepared_scans (prepared_scan_id, baseline_revision, scan_seq, created_at, committed_at)
         VALUES (?, ?, ?, ?, NULL)`,
      )
      .run(preparedScanId, baselineRevision, scanSeq, createdAt);

    return {
      prepared_scan_id: preparedScanId,
      baseline_revision: baselineRevision,
      scan_seq: scanSeq,
      files: dirty,
      scan_duration_ms: Date.now() - startTime,
      files_scanned: fsEntries.length,
      files_skipped_fast: filesSkippedFast,
      baseline_updates: baselineUpdates,
    };
  }

  async scan(): Promise<PreparedDirtySet> {
    return this.prepareScan();
  }

  async commitSnapshot(options: {
    preparedSet: PreparedDirtySet;
    trigger_reason: string;
    action_id?: string;
    run_id?: string;
    anchor_path?: string;
  }): Promise<LayeredSnapshotRecord> {
    const { preparedSet } = options;
    const snapId = createSnapId();
    const createdAt = new Date().toISOString();
    const newBaselineRevision = preparedSet.baseline_revision + 1;
    const parentRow = this.db
      .prepare("SELECT snap_id FROM snapshots ORDER BY baseline_revision DESC, created_at DESC LIMIT 1")
      .get() as { snap_id: string } | undefined;
    const parentSnapId = parentRow?.snap_id ?? null;
    const relativeAnchorPath =
      typeof options.anchor_path === "string" && options.anchor_path.length > 0
        ? path.isAbsolute(options.anchor_path)
          ? path.relative(this.workspaceRoot, options.anchor_path)
          : options.anchor_path
        : null;
    const anchorState =
      relativeAnchorPath === null ? null : await this.statLiveFile(path.join(this.workspaceRoot, relativeAnchorPath));

    const stagingBaseDir = path.join(this.snapshotDir, "staging", snapId);
    const stagingFilesDir = path.join(stagingBaseDir, "files");
    const finalBaseDir = path.join(this.snapshotDir, "snaps", snapId);
    const finalManifestPath = path.join(finalBaseDir, "manifest.json");

    try {
      await fs.mkdir(stagingFilesDir, { recursive: true });

      let totalBytes = 0;
      for (const file of preparedSet.files) {
        if (file.change_type === "deleted") {
          continue;
        }

        const srcPath = path.join(this.workspaceRoot, file.path);
        const destPath = path.join(stagingFilesDir, file.path);
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.copyFile(srcPath, destPath);
        totalBytes += file.size_bytes;
      }

      const shouldPersistAnchorFile =
        relativeAnchorPath !== null &&
        anchorState?.exists === true &&
        !preparedSet.files.some((file) => file.path === relativeAnchorPath);

      if (shouldPersistAnchorFile) {
        const anchorSrcPath = path.join(this.workspaceRoot, relativeAnchorPath);
        const anchorDestPath = path.join(stagingFilesDir, relativeAnchorPath);
        await fs.mkdir(path.dirname(anchorDestPath), { recursive: true });
        await fs.copyFile(anchorSrcPath, anchorDestPath);
        totalBytes += anchorState.size_bytes ?? 0;
      }

      const manifest: SnapManifest = {
        snap_id: snapId,
        parent_snap_id: parentSnapId,
        workspace_root: this.workspaceRoot,
        baseline_revision: newBaselineRevision,
        scan_seq: preparedSet.scan_seq,
        trigger_reason: options.trigger_reason,
        action_id: options.action_id ?? null,
        run_id: options.run_id ?? null,
        file_count: preparedSet.files.length,
        total_bytes: totalBytes,
        created_at: createdAt,
        anchor_path: relativeAnchorPath,
        anchor_exists: anchorState?.exists ?? false,
        anchor_content_hash: anchorState?.content_hash ?? null,
        anchor_file_mode: anchorState?.file_mode ?? null,
        anchor_source_snap_id: anchorState?.exists ? snapId : null,
        files: preparedSet.files,
      };

      await fs.writeFile(path.join(stagingBaseDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
      await fs.mkdir(path.dirname(finalBaseDir), { recursive: true });
      await fs.rename(stagingBaseDir, finalBaseDir);

      try {
        this.db.transaction(() => {
          const currentBaseline = this.getCurrentBaselineRevision();
          if (currentBaseline !== preparedSet.baseline_revision) {
            throw new AgentGitError(
              "Workspace baseline changed before snapshot commit.",
              "CONFLICT",
              {
                expected_baseline_revision: preparedSet.baseline_revision,
                actual_baseline_revision: currentBaseline,
              },
              true,
            );
          }

          this.db
            .prepare(
              `INSERT INTO snapshots (
              snap_id,
              parent_snap_id,
              baseline_revision,
              scan_seq,
              trigger_reason,
              action_id,
              run_id,
              file_count,
              total_bytes,
              created_at,
              anchor_path,
              anchor_exists,
              anchor_content_hash,
              anchor_file_mode,
              anchor_source_snap_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              snapId,
              parentSnapId,
              newBaselineRevision,
              preparedSet.scan_seq,
              options.trigger_reason,
              options.action_id ?? null,
              options.run_id ?? null,
              preparedSet.files.length,
              totalBytes,
              createdAt,
              relativeAnchorPath,
              manifest.anchor_exists ? 1 : 0,
              manifest.anchor_content_hash,
              manifest.anchor_file_mode,
              manifest.anchor_source_snap_id,
            );

          const insertSnapFile = this.db.prepare(
            "INSERT INTO snap_files (snap_id, path, change_type, content_hash, size_bytes, file_mode) VALUES (?, ?, ?, ?, ?, ?)",
          );
          for (const file of preparedSet.files) {
            insertSnapFile.run(snapId, file.path, file.change_type, file.content_hash, file.size_bytes, file.file_mode);
          }

          const upsertFile = this.db.prepare(`
          INSERT INTO file_index (path, content_hash, mtime_ms, size_bytes, file_mode, entry_kind, scan_seq, is_deleted)
          VALUES (?, ?, ?, ?, ?, 'file', ?, ?)
          ON CONFLICT(path) DO UPDATE SET
            content_hash = excluded.content_hash,
            mtime_ms = excluded.mtime_ms,
            size_bytes = excluded.size_bytes,
            file_mode = excluded.file_mode,
            entry_kind = excluded.entry_kind,
            scan_seq = excluded.scan_seq,
            is_deleted = excluded.is_deleted
        `);

          for (const update of preparedSet.baseline_updates) {
            upsertFile.run(
              update.path,
              update.content_hash,
              update.mtime_ms,
              update.size_bytes,
              update.file_mode,
              preparedSet.scan_seq,
              update.is_deleted,
            );
          }

          this.db
            .prepare("UPDATE index_meta SET value = ? WHERE key = 'current_baseline_revision'")
            .run(String(newBaselineRevision));
          this.db
            .prepare("UPDATE prepared_scans SET committed_at = ? WHERE prepared_scan_id = ?")
            .run(createdAt, preparedSet.prepared_scan_id);
        })();
      } catch (error) {
        try {
          await fs.rm(finalBaseDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup for failed commits.
        }
        throw error;
      }

      await fs.writeFile(finalManifestPath, JSON.stringify(manifest, null, 2), "utf8");

      return {
        snap_id: snapId,
        parent_snap_id: parentSnapId,
        baseline_revision: newBaselineRevision,
        scan_seq: preparedSet.scan_seq,
        file_count: preparedSet.files.length,
        total_bytes: totalBytes,
        dirty_files: preparedSet.files,
        created_at: createdAt,
        anchor_path: relativeAnchorPath,
        anchor_exists: manifest.anchor_exists,
        anchor_content_hash: manifest.anchor_content_hash,
        anchor_file_mode: manifest.anchor_file_mode,
        anchor_source_snap_id: manifest.anchor_source_snap_id,
      };
    } catch (error) {
      if (error instanceof AgentGitError) {
        if (error.code === "STORAGE_UNAVAILABLE") {
          throw error;
        }
        if (error.code === "CONFLICT") {
          throw error;
        }
      }

      if (isLowDiskPressureError(error)) {
        try {
          await fs.rm(stagingBaseDir, { recursive: true, force: true });
          await fs.rm(finalBaseDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup for failed low-disk commits.
        }
        throw storageUnavailableError("Workspace snapshot commit failed because storage was unavailable.", error, {
          action_id: options.action_id ?? null,
          run_id: options.run_id ?? null,
          workspace_root: this.workspaceRoot,
          anchor_path: relativeAnchorPath,
        });
      }

      throw error;
    }
  }

  async captureSnapshot(options: {
    dirtySet: PreparedDirtySet;
    trigger_reason: string;
    action_id?: string;
    run_id?: string;
    anchor_path?: string;
  }): Promise<LayeredSnapshotRecord> {
    return this.commitSnapshot({
      preparedSet: options.dirtySet,
      trigger_reason: options.trigger_reason,
      action_id: options.action_id,
      run_id: options.run_id,
      anchor_path: options.anchor_path,
    });
  }

  async restore(targetSnapId: string): Promise<RestoreResult> {
    const manifest = this.getSnapshotManifest(targetSnapId);
    if (!manifest) {
      throw new NotFoundError(`Snapshot not found: ${targetSnapId}`, {
        snap_id: targetSnapId,
      });
    }

    const restorationSet = this.buildRestorationSet(targetSnapId);
    const filesRestored: RestoreResult["files_restored"] = [];

    for (const [filePath, entry] of restorationSet) {
      const fullPath = path.join(this.workspaceRoot, filePath);

      if (entry.state === "deleted") {
        if (await pathExists(fullPath)) {
          await fs.rm(fullPath, { recursive: true, force: true });
          filesRestored.push({ path: filePath, action: "removed" });
        }
        continue;
      }

      const srcPath = path.join(this.snapshotDir, "snaps", entry.snap_id, "files", filePath);
      if (!(await pathExists(srcPath))) {
        continue;
      }

      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.copyFile(srcPath, fullPath);
      try {
        await fs.chmod(fullPath, entry.file_mode);
      } catch {
        // Best effort for modes on platforms that support them.
      }
      filesRestored.push({ path: filePath, action: "restored" });
    }

    const activeBaselineRows = this.db.prepare("SELECT path FROM file_index WHERE is_deleted = 0").all() as Array<{
      path: string;
    }>;

    for (const row of activeBaselineRows) {
      if (restorationSet.has(row.path)) {
        continue;
      }

      const fullPath = path.join(this.workspaceRoot, row.path);
      if (!(await pathExists(fullPath))) {
        continue;
      }

      await fs.rm(fullPath, { recursive: true, force: true });
      filesRestored.push({ path: row.path, action: "removed" });
    }

    if (manifest.anchor_path && !manifest.anchor_exists && !restorationSet.has(manifest.anchor_path)) {
      const anchorFullPath = path.join(this.workspaceRoot, manifest.anchor_path);
      if (await pathExists(anchorFullPath)) {
        await fs.rm(anchorFullPath, { recursive: true, force: true });
        filesRestored.push({ path: manifest.anchor_path, action: "removed" });
      }
    }

    const prepared = await this.prepareScan();
    const recoveryRecord = await this.commitSnapshot({
      preparedSet: prepared,
      trigger_reason: "recovery:restore",
      run_id: manifest.run_id ?? undefined,
      anchor_path: manifest.anchor_path ?? undefined,
    });

    return {
      target_snap_id: targetSnapId,
      files_restored: filesRestored,
      restored_at: new Date().toISOString(),
      recovery_snapshot_id: recoveryRecord.snap_id,
    };
  }

  async restoreSubset(targetSnapId: string, subsetPaths: string[]): Promise<RestoreResult> {
    const manifest = this.getSnapshotManifest(targetSnapId);
    if (!manifest) {
      throw new NotFoundError(`Snapshot not found: ${targetSnapId}`, {
        snap_id: targetSnapId,
      });
    }

    const selectors = normalizeSubsetSelectors(subsetPaths, this.workspaceRoot);
    const restorationSet = this.buildRestorationSet(targetSnapId);
    const filteredRestorationSet = new Map(
      Array.from(restorationSet.entries()).filter(([filePath]) => pathMatchesSelectors(filePath, selectors)),
    );
    const filesRestored: RestoreResult["files_restored"] = [];

    for (const [filePath, entry] of filteredRestorationSet) {
      const fullPath = path.join(this.workspaceRoot, filePath);

      if (entry.state === "deleted") {
        if (await pathExists(fullPath)) {
          await fs.rm(fullPath, { recursive: true, force: true });
          filesRestored.push({ path: filePath, action: "removed" });
        }
        continue;
      }

      const srcPath = path.join(this.snapshotDir, "snaps", entry.snap_id, "files", filePath);
      if (!(await pathExists(srcPath))) {
        continue;
      }

      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.copyFile(srcPath, fullPath);
      try {
        await fs.chmod(fullPath, entry.file_mode);
      } catch {
        // Best effort for modes on platforms that support them.
      }
      filesRestored.push({ path: filePath, action: "restored" });
    }

    const liveEntries = await walkWorkspace(this.workspaceRoot, await this.loadIgnorePatterns());
    for (const entry of liveEntries) {
      if (!pathMatchesSelectors(entry.relativePath, selectors) || filteredRestorationSet.has(entry.relativePath)) {
        continue;
      }

      const fullPath = path.join(this.workspaceRoot, entry.relativePath);
      if (!(await pathExists(fullPath))) {
        continue;
      }

      await fs.rm(fullPath, { recursive: true, force: true });
      filesRestored.push({ path: entry.relativePath, action: "removed" });
    }

    if (
      manifest.anchor_path &&
      pathMatchesSelectors(manifest.anchor_path, selectors) &&
      !manifest.anchor_exists &&
      !filteredRestorationSet.has(manifest.anchor_path)
    ) {
      const anchorFullPath = path.join(this.workspaceRoot, manifest.anchor_path);
      if (await pathExists(anchorFullPath)) {
        await fs.rm(anchorFullPath, { recursive: true, force: true });
        filesRestored.push({ path: manifest.anchor_path, action: "removed" });
      }
    }

    const prepared = await this.prepareScan();
    const recoveryRecord = await this.commitSnapshot({
      preparedSet: prepared,
      trigger_reason: "recovery:restore_subset",
      run_id: manifest.run_id ?? undefined,
      anchor_path: manifest.anchor_path ?? undefined,
    });

    return {
      target_snap_id: targetSnapId,
      files_restored: filesRestored,
      restored_at: new Date().toISOString(),
      recovery_snapshot_id: recoveryRecord.snap_id,
    };
  }

  private buildRestorationSet(
    targetSnapId: string,
  ): Map<string, { state: "exists" | "deleted"; snap_id: string; file_mode: number; content_hash: string }> {
    const result = new Map<
      string,
      { state: "exists" | "deleted"; snap_id: string; file_mode: number; content_hash: string }
    >();

    let currentSnapId: string | null = targetSnapId;
    while (currentSnapId) {
      const files = this.db
        .prepare("SELECT path, change_type, file_mode, content_hash FROM snap_files WHERE snap_id = ?")
        .all(currentSnapId) as Array<{
        path: string;
        change_type: ChangeType;
        file_mode: number;
        content_hash: string;
      }>;

      for (const file of files) {
        if (result.has(file.path)) {
          continue;
        }

        result.set(file.path, {
          state: file.change_type === "deleted" ? "deleted" : "exists",
          snap_id: currentSnapId,
          file_mode: file.file_mode,
          content_hash: file.content_hash,
        });
      }

      const parentRow = this.db.prepare("SELECT parent_snap_id FROM snapshots WHERE snap_id = ?").get(currentSnapId) as
        | { parent_snap_id: string | null }
        | undefined;
      currentSnapId = parentRow?.parent_snap_id ?? null;
    }

    const targetManifest = this.getSnapshotManifest(targetSnapId);
    if (targetManifest?.anchor_path && !result.has(targetManifest.anchor_path)) {
      result.set(targetManifest.anchor_path, {
        state: targetManifest.anchor_exists ? "exists" : "deleted",
        snap_id: this.normalizeAnchorSourceSnapId(targetManifest) ?? targetSnapId,
        file_mode: targetManifest.anchor_file_mode ?? 0,
        content_hash: targetManifest.anchor_content_hash ?? "",
      });
    }

    return result;
  }

  async previewRestore(targetSnapId: string): Promise<RestorePreview> {
    const manifest = this.getSnapshotManifest(targetSnapId);
    if (!manifest) {
      throw new NotFoundError(`Snapshot not found: ${targetSnapId}`, {
        snap_id: targetSnapId,
      });
    }

    const restorationSet = this.buildRestorationSet(targetSnapId);
    const ignorePatterns = await this.loadIgnorePatterns();
    const liveEntries = await walkWorkspace(this.workspaceRoot, ignorePatterns);
    const currentMap = new Map<string, { content_hash: string; file_mode: number }>();

    for (const entry of liveEntries) {
      const fullPath = path.join(this.workspaceRoot, entry.relativePath);
      try {
        currentMap.set(entry.relativePath, {
          content_hash: await hashFile(fullPath),
          file_mode: entry.mode,
        });
      } catch {
        // Skip files that disappear during preview generation.
      }
    }

    let pathsToChange = 0;
    let removals = 0;
    const changedPaths = new Set<string>();

    for (const [filePath, target] of restorationSet) {
      const current = currentMap.get(filePath);

      if (target.state === "deleted") {
        if (current) {
          pathsToChange += 1;
          removals += 1;
          changedPaths.add(filePath);
        }
        continue;
      }

      if (!current) {
        pathsToChange += 1;
        changedPaths.add(filePath);
        continue;
      }

      if (current.content_hash !== target.content_hash || current.file_mode !== target.file_mode) {
        pathsToChange += 1;
        changedPaths.add(filePath);
      }
    }

    for (const filePath of currentMap.keys()) {
      if (!restorationSet.has(filePath)) {
        pathsToChange += 1;
        removals += 1;
        changedPaths.add(filePath);
      }
    }

    const overlappingPaths = new Set<string>();
    const laterActionKeys = new Set<string>();
    const laterSnapshots = this.listSnapshots().filter(
      (snapshot) => snapshot.baseline_revision > manifest.baseline_revision,
    );

    for (const snapshot of laterSnapshots) {
      const dirtyFiles = this.diffSnapshot(snapshot.snap_id);
      let snapshotOverlaps = false;

      for (const file of dirtyFiles) {
        if (!changedPaths.has(file.path)) {
          continue;
        }

        snapshotOverlaps = true;
        overlappingPaths.add(file.path);
      }

      if (!snapshotOverlaps) {
        continue;
      }

      laterActionKeys.add(snapshot.action_id ? `action:${snapshot.action_id}` : `snapshot:${snapshot.snap_id}`);
    }

    let dataLossRisk: RestorePreview["data_loss_risk"] = removals > 10 ? "high" : removals > 0 ? "moderate" : "low";
    if (laterActionKeys.size > 0) {
      dataLossRisk = overlappingPaths.size > 3 || removals > 0 ? "high" : "moderate";
    }

    const baseConfidence = manifest.file_count > 0 || manifest.anchor_path !== null ? 0.99 : 0.96;
    const confidencePenalty = Math.min(0.25, laterActionKeys.size * 0.05);

    return {
      paths_to_change: pathsToChange,
      later_actions_affected: laterActionKeys.size,
      overlapping_paths: Array.from(overlappingPaths).sort(),
      data_loss_risk: dataLossRisk,
      confidence: Math.max(0.55, baseConfidence - confidencePenalty),
    };
  }

  async previewRestoreSubset(targetSnapId: string, subsetPaths: string[]): Promise<RestorePreview> {
    const manifest = this.getSnapshotManifest(targetSnapId);
    if (!manifest) {
      throw new NotFoundError(`Snapshot not found: ${targetSnapId}`, {
        snap_id: targetSnapId,
      });
    }

    const selectors = normalizeSubsetSelectors(subsetPaths, this.workspaceRoot);
    const restorationSet = this.buildRestorationSet(targetSnapId);
    const filteredRestorationSet = new Map(
      Array.from(restorationSet.entries()).filter(([filePath]) => pathMatchesSelectors(filePath, selectors)),
    );
    const ignorePatterns = await this.loadIgnorePatterns();
    const liveEntries = await walkWorkspace(this.workspaceRoot, ignorePatterns);
    const currentMap = new Map<string, { content_hash: string; file_mode: number }>();

    for (const entry of liveEntries) {
      if (!pathMatchesSelectors(entry.relativePath, selectors)) {
        continue;
      }

      const fullPath = path.join(this.workspaceRoot, entry.relativePath);
      try {
        currentMap.set(entry.relativePath, {
          content_hash: await hashFile(fullPath),
          file_mode: entry.mode,
        });
      } catch {
        // Skip files that disappear during preview generation.
      }
    }

    let pathsToChange = 0;
    let removals = 0;
    const changedPaths = new Set<string>();

    for (const [filePath, target] of filteredRestorationSet) {
      const current = currentMap.get(filePath);

      if (target.state === "deleted") {
        if (current) {
          pathsToChange += 1;
          removals += 1;
          changedPaths.add(filePath);
        }
        continue;
      }

      if (!current) {
        pathsToChange += 1;
        changedPaths.add(filePath);
        continue;
      }

      if (current.content_hash !== target.content_hash || current.file_mode !== target.file_mode) {
        pathsToChange += 1;
        changedPaths.add(filePath);
      }
    }

    for (const filePath of currentMap.keys()) {
      if (!filteredRestorationSet.has(filePath)) {
        pathsToChange += 1;
        removals += 1;
        changedPaths.add(filePath);
      }
    }

    const overlappingPaths = new Set<string>();
    const laterActionKeys = new Set<string>();
    const laterSnapshots = this.listSnapshots().filter(
      (snapshot) => snapshot.baseline_revision > manifest.baseline_revision,
    );

    for (const snapshot of laterSnapshots) {
      const dirtyFiles = this.diffSnapshot(snapshot.snap_id);
      let snapshotOverlaps = false;

      for (const file of dirtyFiles) {
        if (!changedPaths.has(file.path)) {
          continue;
        }

        snapshotOverlaps = true;
        overlappingPaths.add(file.path);
      }

      if (!snapshotOverlaps) {
        continue;
      }

      laterActionKeys.add(snapshot.action_id ? `action:${snapshot.action_id}` : `snapshot:${snapshot.snap_id}`);
    }

    let dataLossRisk: RestorePreview["data_loss_risk"] = removals > 10 ? "high" : removals > 0 ? "moderate" : "low";
    if (laterActionKeys.size > 0) {
      dataLossRisk = overlappingPaths.size > 3 || removals > 0 ? "high" : "moderate";
    }

    const baseConfidence = manifest.file_count > 0 || manifest.anchor_path !== null ? 0.99 : 0.96;
    const confidencePenalty = Math.min(0.25, laterActionKeys.size * 0.05);

    return {
      paths_to_change: pathsToChange,
      later_actions_affected: laterActionKeys.size,
      overlapping_paths: Array.from(overlappingPaths).sort(),
      data_loss_risk: dataLossRisk,
      confidence: Math.max(0.55, baseConfidence - confidencePenalty),
    };
  }

  listSnapshots(): SnapshotListEntry[] {
    return this.db
      .prepare(
        `SELECT snap_id, parent_snap_id, baseline_revision, trigger_reason, action_id, file_count, total_bytes, created_at
         FROM snapshots
         ORDER BY baseline_revision DESC, created_at DESC`,
      )
      .all() as SnapshotListEntry[];
  }

  getSnapshotManifest(snapId: string): SnapManifest | null {
    const snap = this.db.prepare("SELECT * FROM snapshots WHERE snap_id = ?").get(snapId) as
      | Record<string, unknown>
      | undefined;

    if (!snap) {
      return null;
    }

    const files = this.db
      .prepare("SELECT path, change_type, content_hash, size_bytes, file_mode FROM snap_files WHERE snap_id = ?")
      .all(snapId) as DirtyFile[];

    return {
      snap_id: snap.snap_id as string,
      parent_snap_id: (snap.parent_snap_id as string | null) ?? null,
      workspace_root: this.workspaceRoot,
      baseline_revision: snap.baseline_revision as number,
      scan_seq: snap.scan_seq as number,
      trigger_reason: snap.trigger_reason as string,
      action_id: (snap.action_id as string | null) ?? null,
      run_id: (snap.run_id as string | null) ?? null,
      file_count: snap.file_count as number,
      total_bytes: snap.total_bytes as number,
      created_at: snap.created_at as string,
      anchor_path: (snap.anchor_path as string | null) ?? null,
      anchor_exists: Boolean(snap.anchor_exists),
      anchor_content_hash: (snap.anchor_content_hash as string | null) ?? null,
      anchor_file_mode: (snap.anchor_file_mode as number | null) ?? null,
      anchor_source_snap_id: (snap.anchor_source_snap_id as string | null) ?? null,
      files,
    };
  }

  diffSnapshot(snapId: string): DirtyFile[] {
    const manifest = this.getSnapshotManifest(snapId);
    if (!manifest) {
      throw new NotFoundError(`Snapshot not found: ${snapId}`, {
        snap_id: snapId,
      });
    }
    return manifest.files;
  }

  checkFile(filePath: string): { content_hash: string; size_bytes: number; file_mode: number } | null {
    const relativePath = path.isAbsolute(filePath) ? path.relative(this.workspaceRoot, filePath) : filePath;
    const row = this.db
      .prepare("SELECT content_hash, size_bytes, file_mode FROM file_index WHERE path = ? AND is_deleted = 0")
      .get(relativePath) as { content_hash: string; size_bytes: number; file_mode: number } | undefined;
    return row ?? null;
  }

  async statLiveFile(
    filePath: string,
  ): Promise<{ exists: boolean; content_hash: string | null; size_bytes: number | null; file_mode: number | null }> {
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(this.workspaceRoot, filePath);

    try {
      const stats = await fs.stat(fullPath);
      if (!stats.isFile()) {
        return {
          exists: false,
          content_hash: null,
          size_bytes: null,
          file_mode: null,
        };
      }

      return {
        exists: true,
        content_hash: await hashFile(fullPath),
        size_bytes: stats.size,
        file_mode: stats.mode,
      };
    } catch {
      return {
        exists: false,
        content_hash: null,
        size_bytes: null,
        file_mode: null,
      };
    }
  }

  private snapshotFilesRoot(snapId: string): string {
    return path.join(this.snapshotDir, "snaps", snapId, "files");
  }

  private snapshotManifestPath(snapId: string): string {
    return path.join(this.snapshotDir, "snaps", snapId, "manifest.json");
  }

  private anchorBlobPath(snapId: string, anchorPath: string): string {
    return path.join(this.snapshotFilesRoot(snapId), anchorPath);
  }

  private normalizeAnchorSourceSnapId(manifest: SnapManifest): string | null {
    if (!manifest.anchor_exists || !manifest.anchor_path) {
      return null;
    }

    return manifest.anchor_source_snap_id ?? manifest.snap_id;
  }

  private snapshotHasTrackedPath(snapId: string, filePath: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM snap_files WHERE snap_id = ? AND path = ? LIMIT 1")
      .get(snapId, filePath) as { 1: number } | undefined;
    return Boolean(row);
  }

  private anchorDeduplicationKey(manifest: SnapManifest): string | null {
    if (!manifest.anchor_exists || !manifest.anchor_path || !manifest.anchor_content_hash) {
      return null;
    }

    return [manifest.anchor_path, manifest.anchor_content_hash, String(manifest.anchor_file_mode ?? 0)].join("\u0000");
  }

  private async persistAnchorSource(manifest: SnapManifest, anchorSourceSnapId: string | null): Promise<void> {
    this.db
      .prepare("UPDATE snapshots SET anchor_source_snap_id = ? WHERE snap_id = ?")
      .run(anchorSourceSnapId, manifest.snap_id);
    await fs.writeFile(
      this.snapshotManifestPath(manifest.snap_id),
      JSON.stringify(
        {
          ...manifest,
          anchor_source_snap_id: anchorSourceSnapId,
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  async rebaseSyntheticAnchors(): Promise<AnchorRebaseResult> {
    const snapshots = this.db
      .prepare(
        `SELECT snap_id
         FROM snapshots
         WHERE anchor_exists = 1 AND anchor_path IS NOT NULL
         ORDER BY baseline_revision ASC, created_at ASC`,
      )
      .all() as Array<{ snap_id: string }>;
    const summary: AnchorRebaseResult = {
      snapshots_scanned: snapshots.length,
      anchors_rebased: 0,
      bytes_freed: 0,
      empty_directories_removed: 0,
    };
    const sourceByAnchorKey = new Map<string, string>();

    try {
      for (const row of snapshots) {
        const manifest = this.getSnapshotManifest(row.snap_id);
        if (!manifest || !manifest.anchor_path || !manifest.anchor_exists) {
          continue;
        }

        const anchorKey = this.anchorDeduplicationKey(manifest);
        if (!anchorKey) {
          continue;
        }

        const trackedInSnapshot = this.snapshotHasTrackedPath(manifest.snap_id, manifest.anchor_path);
        const normalizedSource = this.normalizeAnchorSourceSnapId(manifest);

        if (trackedInSnapshot) {
          sourceByAnchorKey.set(anchorKey, manifest.snap_id);
          if (normalizedSource !== manifest.snap_id) {
            await this.persistAnchorSource(manifest, manifest.snap_id);
          }
          continue;
        }

        const existingSource = sourceByAnchorKey.get(anchorKey);
        const currentBlobPath = this.anchorBlobPath(manifest.snap_id, manifest.anchor_path);
        const currentBlobExists = await pathExists(currentBlobPath);

        if (existingSource && existingSource !== manifest.snap_id) {
          const sourceBlobPath = this.anchorBlobPath(existingSource, manifest.anchor_path);
          if (!(await pathExists(sourceBlobPath))) {
            sourceByAnchorKey.set(anchorKey, manifest.snap_id);
            continue;
          }

          if (currentBlobExists) {
            summary.bytes_freed += (await fs.stat(currentBlobPath)).size;
            await fs.rm(currentBlobPath, { force: true });

            let currentDir = path.dirname(currentBlobPath);
            const filesRoot = this.snapshotFilesRoot(manifest.snap_id);
            while (currentDir.startsWith(filesRoot) && currentDir !== filesRoot) {
              const entries = await fs.readdir(currentDir);
              if (entries.length > 0) {
                break;
              }
              await fs.rmdir(currentDir);
              summary.empty_directories_removed += 1;
              currentDir = path.dirname(currentDir);
            }

            const filesRootEntries = await fs.readdir(filesRoot).catch(() => []);
            if (filesRootEntries.length === 0) {
              const removedFilesRoot = await fs
                .rmdir(filesRoot)
                .then(() => true)
                .catch(() => false);
              if (removedFilesRoot) {
                summary.empty_directories_removed += 1;
              }
            }
          }

          await this.persistAnchorSource(manifest, existingSource);
          summary.anchors_rebased += 1;
          continue;
        }

        if (currentBlobExists) {
          sourceByAnchorKey.set(anchorKey, manifest.snap_id);
          if (normalizedSource !== manifest.snap_id) {
            await this.persistAnchorSource(manifest, manifest.snap_id);
          }
        }
      }

      return summary;
    } catch (error) {
      if (error instanceof AgentGitError) {
        throw error;
      }

      if (isLowDiskPressureError(error)) {
        throw storageUnavailableError("Failed to rebase synthetic snapshot anchors.", error, {
          workspace_root: this.workspaceRoot,
          snapshots_scanned: summary.snapshots_scanned,
        });
      }

      throw new InternalError("Failed to rebase synthetic snapshot anchors.", {
        workspace_root: this.workspaceRoot,
        snapshots_scanned: summary.snapshots_scanned,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async compact(_keepLastN: number = 20): Promise<CompactionResult> {
    return {
      snaps_removed: 0,
      bytes_freed: 0,
      compacted_snap_id: null,
    };
  }

  getStats(): {
    indexed_files: number;
    total_snapshots: number;
    total_snapshot_bytes: number;
    current_scan_seq: number;
    current_baseline_revision: number;
  } {
    const indexedFilesRow = this.db.prepare("SELECT COUNT(*) AS count FROM file_index WHERE is_deleted = 0").get() as {
      count: number;
    };
    const snapshotStatsRow = this.db
      .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(total_bytes), 0) AS bytes FROM snapshots")
      .get() as { count: number; bytes: number };

    return {
      indexed_files: indexedFilesRow.count,
      total_snapshots: snapshotStatsRow.count,
      total_snapshot_bytes: snapshotStatsRow.bytes,
      current_scan_seq: this.getMetaNumber("current_scan_seq"),
      current_baseline_revision: this.getCurrentBaselineRevision(),
    };
  }

  checkpointWal(): SqliteCheckpointResult {
    const modeRow = this.db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
    const journalMode = (modeRow?.journal_mode?.toUpperCase() ?? "WAL") as "WAL" | "DELETE";

    if (journalMode !== "WAL") {
      return {
        journal_mode: journalMode,
        checkpointed: false,
        busy: 0,
        log_frames: 0,
        checkpointed_frames: 0,
      };
    }

    const row = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
      | { busy?: number; log?: number; checkpointed?: number }
      | undefined;

    return {
      journal_mode: "WAL",
      checkpointed: true,
      busy: row?.busy ?? 0,
      log_frames: row?.log ?? 0,
      checkpointed_frames: row?.checkpointed ?? 0,
    };
  }

  close(): void {
    this.db.close();
  }
}

export function inspectPersistedWorkspaceSnapshotIndex(dbPath: string): PersistedWorkspaceSnapshotIndex {
  const db = new Database(dbPath, { readonly: true });

  try {
    const workspaceRootRow = db.prepare("SELECT value FROM index_meta WHERE key = 'workspace_root'").get() as
      | { value?: string }
      | undefined;
    const workspaceRoot = workspaceRootRow?.value ? path.resolve(workspaceRootRow.value) : null;

    if (!workspaceRoot) {
      throw new InternalError("Persisted workspace index was missing workspace_root metadata.", {
        db_path: dbPath,
      });
    }

    const rows = db.prepare("SELECT snap_id FROM snapshots").all() as Array<{ snap_id: string }>;
    return {
      workspace_root: workspaceRoot,
      snapshot_ids: rows.map((row) => row.snap_id).sort(),
    };
  } finally {
    db.close();
  }
}
