import { createHash, randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import {
  AgentGitError,
  InternalError,
  type ActionRecord,
  type PolicyOutcomeRecord,
  type SnapshotClass,
  type SnapshotRecord,
} from "@agentgit/schemas";
import {
  inspectPersistedWorkspaceSnapshotIndex,
  type LayeredSnapshotRecord,
  type SnapManifest,
  WorkspaceIndex,
} from "@agentgit/workspace-index";

export type { SnapshotClass, SnapshotFidelity, SnapshotRecord } from "@agentgit/schemas";

export interface SnapshotManifest {
  snapshot_id: string;
  action_id: string;
  run_id: string;
  target_path: string;
  workspace_root: string;
  existed_before: boolean;
  entry_kind: "file" | "directory" | "missing";
  snapshot_class: SnapshotClass;
  fidelity: SnapshotRecord["fidelity"];
  created_at: string;
  anchor_content_hash?: string | null;
  anchor_file_mode?: number | null;
  operation_domain?: ActionRecord["operation"]["domain"];
  operation_kind?: string;
  action_display_name?: string | null;
  execution_surface?: ActionRecord["execution_path"]["surface"];
  tool_kind?: ActionRecord["actor"]["tool_kind"];
  tool_name?: string | null;
  side_effect_level?: ActionRecord["risk_hints"]["side_effect_level"];
  external_effects?: ActionRecord["risk_hints"]["external_effects"];
  reversibility_hint?: ActionRecord["risk_hints"]["reversibility_hint"];
  captured_preimage?: Record<string, unknown> | null;
}

export interface SnapshotRequest {
  action: ActionRecord;
  requested_class: SnapshotClass;
  workspace_root: string;
  captured_preimage?: Record<string, unknown> | null;
}

export interface SnapshotSelectionInput {
  action: ActionRecord;
  policy_decision: PolicyOutcomeRecord["decision"];
  capability_state?: "healthy" | "stale" | "degraded";
  low_disk_pressure_observed?: boolean;
  journal_chain_depth?: number;
  explicit_branch_point?: boolean;
  explicit_hard_checkpoint?: boolean;
}

export interface SnapshotSelectionResult {
  snapshot_class: SnapshotClass;
  reason_codes: string[];
  basis: {
    operation_family: string;
    scope_breadth: ActionRecord["target"]["scope"]["breadth"];
    scope_unknowns: string[];
    normalization_confidence: number;
    side_effect_level: ActionRecord["risk_hints"]["side_effect_level"];
    external_effects: ActionRecord["risk_hints"]["external_effects"];
    reversibility_hint: ActionRecord["risk_hints"]["reversibility_hint"];
    capability_state: "healthy" | "stale" | "degraded";
    low_disk_pressure_observed: boolean;
    journal_chain_depth: number;
    explicit_branch_point: boolean;
    explicit_hard_checkpoint: boolean;
  };
}

export interface SnapshotEngine {
  createSnapshot(request: SnapshotRequest): Promise<SnapshotRecord>;
  verifyIntegrity(snapshotId: string): Promise<boolean>;
  restore(snapshotId: string): Promise<boolean>;
}

export interface RestorePreview {
  paths_to_change: number;
  later_actions_affected: number;
  overlapping_paths: string[];
  data_loss_risk: "low" | "moderate" | "high" | "unknown";
  confidence: number;
}

export interface SubsetRestoreResult {
  restored: boolean;
  paths: string[];
}

export interface SnapshotCompactionSummary {
  workspaces_considered: number;
  snaps_removed: number;
  bytes_freed: number;
  compacted_snapshots: number;
}

export interface SnapshotCheckpointSummary {
  workspaces_considered: number;
  checkpointed_databases: number;
  skipped_databases: number;
}

export interface SnapshotGcSummary {
  workspaces_considered: number;
  referenced_layered_snapshots: number;
  layered_snapshots_removed: number;
  legacy_snapshots_removed: number;
  stray_entries_removed: number;
  bytes_freed: number;
  empty_directories_removed: number;
}

export interface SnapshotAnchorRebaseSummary {
  workspaces_considered: number;
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

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function measurePathBytes(targetPath: string): Promise<number> {
  const stats = await fs.stat(targetPath);

  if (stats.isFile()) {
    return stats.size;
  }

  if (stats.isDirectory()) {
    const entries = await fs.readdir(targetPath);
    const sizes = await Promise.all(entries.map((entry) => measurePathBytes(path.join(targetPath, entry))));
    return sizes.reduce((total, size) => total + size, 0);
  }

  return 0;
}

function createSnapshotId(): string {
  return `snap_${Date.now()}_${randomUUID().replaceAll("-", "")}`;
}

function createMetadataSnapshot(request: SnapshotRequest): SnapshotRecord {
  const locator = request.action.target.primary.locator;

  return {
    snapshot_id: createSnapshotId(),
    action_id: request.action.action_id,
    snapshot_class: "metadata_only",
    fidelity: "metadata_only",
    scope_paths: locator ? [locator] : [],
    storage_bytes: 0,
    created_at: new Date().toISOString(),
  };
}

function createMetadataManifest(request: SnapshotRequest, snapshotId: string, createdAt: string): SnapshotManifest {
  return {
    snapshot_id: snapshotId,
    action_id: request.action.action_id,
    run_id: request.action.run_id,
    target_path: request.action.target.primary.locator,
    workspace_root: request.workspace_root,
    existed_before: false,
    entry_kind: "missing",
    snapshot_class: "metadata_only",
    fidelity: "metadata_only",
    created_at: createdAt,
    operation_domain: request.action.operation.domain,
    operation_kind: request.action.operation.kind,
    action_display_name: request.action.operation.display_name ?? null,
    execution_surface: request.action.execution_path.surface,
    tool_kind: request.action.actor.tool_kind,
    tool_name: request.action.actor.tool_name ?? null,
    side_effect_level: request.action.risk_hints.side_effect_level,
    external_effects: request.action.risk_hints.external_effects,
    reversibility_hint: request.action.risk_hints.reversibility_hint,
    captured_preimage: request.captured_preimage ?? null,
  };
}

function workspaceKey(workspaceRoot: string): string {
  return createHash("sha1").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 16);
}

function snapshotOperationFamily(action: ActionRecord): string {
  if (action.operation.domain === "shell") {
    const commandFamily =
      typeof action.facets.shell === "object" &&
      action.facets.shell !== null &&
      typeof (action.facets.shell as { command_family?: unknown }).command_family === "string"
        ? (action.facets.shell as { command_family: string }).command_family
        : "unclassified";
    return `shell/${commandFamily}`;
  }

  if (action.operation.domain === "filesystem") {
    const operation =
      typeof action.facets.filesystem === "object" &&
      action.facets.filesystem !== null &&
      typeof (action.facets.filesystem as { operation?: unknown }).operation === "string"
        ? (action.facets.filesystem as { operation: string }).operation
        : action.operation.kind;
    return `filesystem/${operation}`;
  }

  if (action.operation.domain === "function") {
    const operation =
      typeof action.facets.function === "object" &&
      action.facets.function !== null &&
      typeof (action.facets.function as { operation?: unknown }).operation === "string"
        ? (action.facets.function as { operation: string }).operation
        : action.operation.kind;
    return `function/${operation}`;
  }

  return `${action.operation.domain}/${action.operation.kind}`;
}

export function selectSnapshotClass(input: SnapshotSelectionInput): SnapshotSelectionResult {
  const capabilityState = input.capability_state ?? "healthy";
  const lowDiskPressureObserved = input.low_disk_pressure_observed ?? false;
  const journalChainDepth = input.journal_chain_depth ?? 0;
  const explicitBranchPoint = input.explicit_branch_point ?? false;
  const explicitHardCheckpoint = input.explicit_hard_checkpoint ?? false;
  const operationFamily = snapshotOperationFamily(input.action);
  const scopeBreadth = input.action.target.scope.breadth;
  const scopeUnknowns = input.action.target.scope.unknowns;
  const normalizationConfidence = input.action.normalization.normalization_confidence;
  const { side_effect_level, external_effects, reversibility_hint } = input.action.risk_hints;
  const reasonCodes: string[] = [];
  let snapshotClass: SnapshotClass = "metadata_only";

  if (input.policy_decision !== "allow_with_snapshot") {
    reasonCodes.push("policy.no_snapshot_required");
  } else if (explicitHardCheckpoint) {
    snapshotClass = "exact_anchor";
    reasonCodes.push("snapshot.explicit_hard_checkpoint");
  } else if (explicitBranchPoint) {
    snapshotClass = "exact_anchor";
    reasonCodes.push("snapshot.explicit_branch_point");
  } else if (operationFamily === "shell/package_manager" || operationFamily === "shell/build_tool") {
    snapshotClass = "exact_anchor";
    reasonCodes.push("snapshot.opaque_workspace_wide_tooling");
  } else if (
    input.action.operation.domain === "filesystem" &&
    (scopeBreadth === "workspace" ||
      scopeBreadth === "repository" ||
      scopeBreadth === "origin" ||
      scopeBreadth === "external" ||
      scopeBreadth === "unknown")
  ) {
    snapshotClass = "exact_anchor";
    reasonCodes.push("snapshot.broad_scope_branch_point");
  } else if (
    input.action.operation.domain === "filesystem" &&
    scopeBreadth === "single" &&
    scopeUnknowns.length === 0 &&
    normalizationConfidence >= 0.9 &&
    side_effect_level === "mutating" &&
    external_effects === "none" &&
    reversibility_hint === "reversible"
  ) {
    snapshotClass = "journal_only";
    reasonCodes.push("snapshot.narrow_reversible_mutation");
  } else if (input.action.operation.domain === "filesystem") {
    snapshotClass = "journal_plus_anchor";
    reasonCodes.push("snapshot.filesystem_recovery_boundary");
  } else if (input.action.operation.domain === "shell") {
    snapshotClass = "journal_plus_anchor";
    reasonCodes.push("snapshot.shell_mutation_boundary");
  } else {
    snapshotClass = "metadata_only";
    reasonCodes.push("snapshot.non_filesystem_metadata_only");
  }

  if (capabilityState !== "healthy" && snapshotClass === "journal_only") {
    snapshotClass = "journal_plus_anchor";
    reasonCodes.push("snapshot.capability_state_strengthened");
  }

  if (lowDiskPressureObserved) {
    reasonCodes.push("snapshot.low_disk_pressure_observed");
  }

  if (journalChainDepth >= 25 && snapshotClass === "journal_plus_anchor") {
    snapshotClass = "exact_anchor";
    reasonCodes.push("snapshot.deep_journal_chain_branch_point");
  }

  return {
    snapshot_class: snapshotClass,
    reason_codes: [...new Set(reasonCodes)],
    basis: {
      operation_family: operationFamily,
      scope_breadth: scopeBreadth,
      scope_unknowns: scopeUnknowns,
      normalization_confidence: normalizationConfidence,
      side_effect_level,
      external_effects,
      reversibility_hint,
      capability_state: capabilityState,
      low_disk_pressure_observed: lowDiskPressureObserved,
      journal_chain_depth: journalChainDepth,
      explicit_branch_point: explicitBranchPoint,
      explicit_hard_checkpoint: explicitHardCheckpoint,
    },
  };
}

export class MetadataOnlySnapshotEngine implements SnapshotEngine {
  async createSnapshot(request: SnapshotRequest): Promise<SnapshotRecord> {
    return createMetadataSnapshot(request);
  }

  async verifyIntegrity(_snapshotId: string): Promise<boolean> {
    return true;
  }

  async restore(_snapshotId: string): Promise<boolean> {
    return false;
  }
}

export interface LocalSnapshotEngineOptions {
  rootDir: string;
}

function layeredTargetEntryKind(
  action: ActionRecord,
  layered: {
    anchor_exists: boolean;
  },
): SnapshotManifest["entry_kind"] {
  if (action.target.primary.type === "workspace" || action.target.primary.type === "repository") {
    return "directory";
  }

  return layered.anchor_exists ? "file" : "missing";
}

function createLayeredMetadataManifest(request: SnapshotRequest, layered: LayeredSnapshotRecord): SnapshotManifest {
  return {
    snapshot_id: layered.snap_id,
    action_id: request.action.action_id,
    run_id: request.action.run_id,
    target_path: request.action.target.primary.locator,
    workspace_root: request.workspace_root,
    existed_before: layered.anchor_exists,
    entry_kind: layeredTargetEntryKind(request.action, layered),
    snapshot_class: request.requested_class,
    fidelity: "full",
    created_at: layered.created_at,
    anchor_content_hash: layered.anchor_content_hash,
    anchor_file_mode: layered.anchor_file_mode,
    operation_domain: request.action.operation.domain,
    operation_kind: request.action.operation.kind,
    action_display_name: request.action.operation.display_name ?? null,
    execution_surface: request.action.execution_path.surface,
    tool_kind: request.action.actor.tool_kind,
    tool_name: request.action.actor.tool_name ?? null,
    side_effect_level: request.action.risk_hints.side_effect_level,
    external_effects: request.action.risk_hints.external_effects,
    reversibility_hint: request.action.risk_hints.reversibility_hint,
    captured_preimage: request.captured_preimage ?? null,
  };
}

export class LocalSnapshotEngine implements SnapshotEngine {
  private readonly workspaceIndexes = new Map<string, WorkspaceIndex>();

  constructor(private readonly options: LocalSnapshotEngineOptions) {}

  private resolveWorkspaceRoots(workspaceRoots?: string[]): string[] {
    if (!workspaceRoots || workspaceRoots.length === 0) {
      return [...this.workspaceIndexes.keys()];
    }

    return [...new Set(workspaceRoots.map((root) => path.resolve(root)))];
  }

  private legacySnapshotDir(snapshotId: string): string {
    return path.join(this.options.rootDir, snapshotId);
  }

  private legacyManifestPath(snapshotId: string): string {
    return path.join(this.legacySnapshotDir(snapshotId), "manifest.json");
  }

  private preimagePath(snapshotId: string): string {
    return path.join(this.legacySnapshotDir(snapshotId), "preimage");
  }

  private layeredManifestPath(snapshotId: string): string {
    return path.join(this.options.rootDir, "snaps", snapshotId, "manifest.json");
  }

  private metadataManifestPath(snapshotId: string): string {
    return path.join(this.options.rootDir, "metadata", `${snapshotId}.json`);
  }

  private indexesRootDir(): string {
    return path.join(this.options.rootDir, "indexes");
  }

  private snapsRootDir(): string {
    return path.join(this.options.rootDir, "snaps");
  }

  private async listPersistedIndexDbPaths(): Promise<string[]> {
    const indexesRoot = this.indexesRootDir();
    if (!(await pathExists(indexesRoot))) {
      return [];
    }

    const entries = await fs.readdir(indexesRoot, { withFileTypes: true });
    const dbPaths: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const dbPath = path.join(indexesRoot, entry.name, "index.db");
      if (await pathExists(dbPath)) {
        dbPaths.push(dbPath);
      }
    }

    return dbPaths.sort();
  }

  private async collectReferencedLayeredSnapshotIds(workspaceRoots?: string[]): Promise<{
    workspaces_considered: number;
    snapshot_ids: Set<string>;
  }> {
    const requestedRoots = workspaceRoots ? new Set(workspaceRoots.map((root) => path.resolve(root))) : null;
    const snapshotIds = new Set<string>();
    let workspacesConsidered = 0;

    for (const dbPath of await this.listPersistedIndexDbPaths()) {
      try {
        const persistedIndex = inspectPersistedWorkspaceSnapshotIndex(dbPath);
        const workspaceRoot = persistedIndex.workspace_root;

        if (requestedRoots && !requestedRoots.has(workspaceRoot)) {
          continue;
        }

        workspacesConsidered += 1;
        for (const snapshotId of persistedIndex.snapshot_ids) {
          snapshotIds.add(snapshotId);
        }
      } catch (error) {
        if (error instanceof InternalError) {
          throw error;
        }

        if (isLowDiskPressureError(error)) {
          throw storageUnavailableError("Failed to inspect persisted snapshot indexes for garbage collection.", error, {
            db_path: dbPath,
          });
        }

        throw new InternalError("Failed to inspect persisted snapshot indexes for garbage collection.", {
          db_path: dbPath,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      workspaces_considered: workspacesConsidered,
      snapshot_ids: snapshotIds,
    };
  }

  async garbageCollectSnapshots(workspaceRoots?: string[]): Promise<SnapshotGcSummary> {
    const { workspaces_considered, snapshot_ids } = await this.collectReferencedLayeredSnapshotIds(workspaceRoots);
    const summary: SnapshotGcSummary = {
      workspaces_considered,
      referenced_layered_snapshots: snapshot_ids.size,
      layered_snapshots_removed: 0,
      legacy_snapshots_removed: 0,
      stray_entries_removed: 0,
      bytes_freed: 0,
      empty_directories_removed: 0,
    };

    try {
      const snapsRoot = this.snapsRootDir();
      if (await pathExists(snapsRoot)) {
        const snapEntries = await fs.readdir(snapsRoot, { withFileTypes: true });

        for (const entry of snapEntries) {
          const entryPath = path.join(snapsRoot, entry.name);

          if (entry.isDirectory()) {
            if (snapshot_ids.has(entry.name)) {
              continue;
            }

            summary.bytes_freed += await measurePathBytes(entryPath);
            await fs.rm(entryPath, { recursive: true, force: true });
            summary.layered_snapshots_removed += 1;
            continue;
          }

          let bytesFreed = 0;
          try {
            bytesFreed = (await fs.stat(entryPath)).size;
          } catch {
            bytesFreed = 0;
          }
          await fs.rm(entryPath, { force: true });
          summary.bytes_freed += bytesFreed;
          summary.stray_entries_removed += 1;
        }

        const remainingSnapEntries = await fs.readdir(snapsRoot);
        if (remainingSnapEntries.length === 0) {
          await fs.rmdir(snapsRoot);
          summary.empty_directories_removed += 1;
        }
      }

      const rootEntries = await fs.readdir(this.options.rootDir, { withFileTypes: true });
      for (const entry of rootEntries) {
        if (!entry.isDirectory() || !entry.name.startsWith("snap_")) {
          continue;
        }

        const entryPath = path.join(this.options.rootDir, entry.name);
        const manifestPath = path.join(entryPath, "manifest.json");
        if (await pathExists(manifestPath)) {
          continue;
        }

        summary.bytes_freed += await measurePathBytes(entryPath);
        await fs.rm(entryPath, { recursive: true, force: true });
        summary.legacy_snapshots_removed += 1;
      }

      return summary;
    } catch (error) {
      if (isLowDiskPressureError(error)) {
        throw storageUnavailableError("Failed to garbage collect orphaned snapshots.", error, {
          workspaces_considered: summary.workspaces_considered,
        });
      }

      throw new InternalError("Failed to garbage collect orphaned snapshots.", {
        cause: error instanceof Error ? error.message : String(error),
        workspaces_considered: summary.workspaces_considered,
      });
    }
  }

  private getWorkspaceIndex(workspaceRoot: string): WorkspaceIndex {
    const resolvedRoot = path.resolve(workspaceRoot);
    const existing = this.workspaceIndexes.get(resolvedRoot);
    if (existing) {
      return existing;
    }

    const key = workspaceKey(resolvedRoot);
    const dbPath = path.join(this.options.rootDir, "indexes", key, "index.db");
    fsSync.mkdirSync(path.dirname(dbPath), { recursive: true });
    fsSync.mkdirSync(path.join(this.options.rootDir, "snaps"), { recursive: true });
    const index = new WorkspaceIndex({
      dbPath,
      workspaceRoot: resolvedRoot,
      snapshotDir: this.options.rootDir,
    });
    this.workspaceIndexes.set(resolvedRoot, index);
    return index;
  }

  private async loadLayeredManifest(snapshotId: string): Promise<SnapManifest | null> {
    try {
      const raw = await fs.readFile(this.layeredManifestPath(snapshotId), "utf8");
      return JSON.parse(raw) as SnapManifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw new InternalError("Failed to load layered snapshot manifest.", {
        cause: error instanceof Error ? error.message : String(error),
        snapshot_id: snapshotId,
      });
    }
  }

  private async loadMetadataManifest(snapshotId: string): Promise<SnapshotManifest | null> {
    try {
      const raw = await fs.readFile(this.metadataManifestPath(snapshotId), "utf8");
      return JSON.parse(raw) as SnapshotManifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw new InternalError("Failed to load metadata snapshot manifest.", {
        cause: error instanceof Error ? error.message : String(error),
        snapshot_id: snapshotId,
      });
    }
  }

  private async createPersistedMetadataSnapshot(request: SnapshotRequest): Promise<SnapshotRecord> {
    try {
      const snapshot = createMetadataSnapshot(request);
      const manifest = createMetadataManifest(request, snapshot.snapshot_id, snapshot.created_at);

      await fs.mkdir(path.dirname(this.metadataManifestPath(snapshot.snapshot_id)), { recursive: true });
      await fs.writeFile(this.metadataManifestPath(snapshot.snapshot_id), JSON.stringify(manifest, null, 2), "utf8");

      return snapshot;
    } catch (error) {
      if (isLowDiskPressureError(error)) {
        throw storageUnavailableError("Failed to create metadata snapshot.", error, {
          action_id: request.action.action_id,
          run_id: request.action.run_id,
          workspace_root: request.workspace_root,
        });
      }

      throw error;
    }
  }

  async createSnapshot(request: SnapshotRequest): Promise<SnapshotRecord> {
    const usesWorkspaceSnapshot =
      request.action.operation.domain === "filesystem" ||
      (request.action.operation.domain === "shell" && request.requested_class !== "metadata_only");

    if (!usesWorkspaceSnapshot) {
      return this.createPersistedMetadataSnapshot(request);
    }

    const targetPath = request.action.target.primary.locator;
    const workspaceIndex = this.getWorkspaceIndex(request.workspace_root);

    try {
      const prepared = await workspaceIndex.prepareScan();
      const layered = await workspaceIndex.commitSnapshot({
        preparedSet: prepared,
        trigger_reason: `action:${request.action.operation.kind}`,
        action_id: request.action.action_id,
        run_id: request.action.run_id,
        anchor_path: targetPath,
      });

      const scopePaths =
        layered.dirty_files.length > 0
          ? layered.dirty_files.map((file: { path: string }) => path.join(request.workspace_root, file.path))
          : [targetPath];
      const metadataManifest = createLayeredMetadataManifest(request, layered);

      await fs.mkdir(path.dirname(this.metadataManifestPath(layered.snap_id)), { recursive: true });
      await fs.writeFile(this.metadataManifestPath(layered.snap_id), JSON.stringify(metadataManifest, null, 2), "utf8");

      return {
        snapshot_id: layered.snap_id,
        action_id: request.action.action_id,
        snapshot_class: request.requested_class,
        fidelity: "full",
        scope_paths: scopePaths,
        storage_bytes: layered.total_bytes,
        created_at: layered.created_at,
      };
    } catch (error) {
      if (error instanceof AgentGitError) {
        throw error;
      }

      if (isLowDiskPressureError(error)) {
        throw storageUnavailableError("Failed to create workspace snapshot.", error, {
          target_path: targetPath,
          action_id: request.action.action_id,
          run_id: request.action.run_id,
          workspace_root: request.workspace_root,
        });
      }

      throw new InternalError("Failed to create workspace snapshot.", {
        cause: error instanceof Error ? error.message : String(error),
        target_path: targetPath,
      });
    }
  }

  async verifyIntegrity(snapshotId: string): Promise<boolean> {
    const layeredManifest = await this.loadLayeredManifest(snapshotId);
    if (layeredManifest) {
      try {
        const workspaceIndex = this.getWorkspaceIndex(layeredManifest.workspace_root);
        return workspaceIndex.getSnapshotManifest(snapshotId) !== null;
      } catch {
        return false;
      }
    }

    const metadataManifest = await this.loadMetadataManifest(snapshotId);
    if (metadataManifest) {
      return true;
    }

    try {
      const manifest = await this.getSnapshotManifest(snapshotId);
      if (!manifest) {
        return false;
      }

      if (!manifest.existed_before) {
        return true;
      }

      return pathExists(this.preimagePath(snapshotId));
    } catch {
      return false;
    }
  }

  async restore(snapshotId: string): Promise<boolean> {
    const layeredManifest = await this.loadLayeredManifest(snapshotId);
    if (layeredManifest) {
      try {
        const workspaceIndex = this.getWorkspaceIndex(layeredManifest.workspace_root);
        await workspaceIndex.restore(snapshotId);
        return true;
      } catch {
        return false;
      }
    }

    const metadataManifest = await this.loadMetadataManifest(snapshotId);
    if (metadataManifest) {
      return false;
    }

    try {
      const manifest = await this.getSnapshotManifest(snapshotId);

      if (!manifest) {
        return false;
      }

      const targetPath = manifest.target_path;
      const preimagePath = this.preimagePath(snapshotId);

      if (!manifest.existed_before || manifest.entry_kind === "missing") {
        await fs.rm(targetPath, { recursive: true, force: true });
        return true;
      }

      if (!(await pathExists(preimagePath))) {
        return false;
      }

      await fs.rm(targetPath, { recursive: true, force: true });
      await fs.mkdir(path.dirname(targetPath), { recursive: true });

      if (manifest.entry_kind === "directory") {
        await fs.cp(preimagePath, targetPath, { recursive: true });
      } else {
        await fs.copyFile(preimagePath, targetPath);
      }

      return true;
    } catch {
      return false;
    }
  }

  async restoreSubset(snapshotId: string, subsetPaths: string[]): Promise<SubsetRestoreResult> {
    const layeredManifest = await this.loadLayeredManifest(snapshotId);
    if (layeredManifest) {
      try {
        const workspaceIndex = this.getWorkspaceIndex(layeredManifest.workspace_root);
        await workspaceIndex.restoreSubset(snapshotId, subsetPaths);
        return {
          restored: true,
          paths: subsetPaths,
        };
      } catch {
        return {
          restored: false,
          paths: subsetPaths,
        };
      }
    }

    return {
      restored: false,
      paths: subsetPaths,
    };
  }

  async previewRestore(snapshotId: string): Promise<RestorePreview> {
    const layeredManifest = await this.loadLayeredManifest(snapshotId);
    if (layeredManifest) {
      const workspaceIndex = this.getWorkspaceIndex(layeredManifest.workspace_root);
      return workspaceIndex.previewRestore(snapshotId);
    }

    const metadataManifest = await this.loadMetadataManifest(snapshotId);
    if (metadataManifest) {
      return {
        paths_to_change: 0,
        later_actions_affected: 0,
        overlapping_paths: [],
        data_loss_risk: "unknown",
        confidence: 0.42,
      };
    }

    const manifest = await this.getSnapshotManifest(snapshotId);
    if (!manifest) {
      throw new InternalError("Snapshot preview failed because the manifest was missing.", {
        snapshot_id: snapshotId,
      });
    }

    return {
      paths_to_change: 1,
      later_actions_affected: 0,
      overlapping_paths: [],
      data_loss_risk: !manifest.existed_before ? "low" : manifest.entry_kind === "directory" ? "moderate" : "low",
      confidence: 0.96,
    };
  }

  async previewRestoreSubset(snapshotId: string, subsetPaths: string[]): Promise<RestorePreview> {
    const layeredManifest = await this.loadLayeredManifest(snapshotId);
    if (layeredManifest) {
      const workspaceIndex = this.getWorkspaceIndex(layeredManifest.workspace_root);
      return workspaceIndex.previewRestoreSubset(snapshotId, subsetPaths);
    }

    const metadataManifest = await this.loadMetadataManifest(snapshotId);
    if (metadataManifest) {
      return {
        paths_to_change: 0,
        later_actions_affected: 0,
        overlapping_paths: [],
        data_loss_risk: "unknown",
        confidence: 0.42,
      };
    }

    return {
      paths_to_change: 0,
      later_actions_affected: 0,
      overlapping_paths: [],
      data_loss_risk: "unknown",
      confidence: 0.42,
    };
  }

  async verifyTargetUnchanged(snapshotId: string, targetPath: string): Promise<boolean> {
    const layeredManifest = await this.loadLayeredManifest(snapshotId);
    if (!layeredManifest) {
      return true;
    }

    const workspaceIndex = this.getWorkspaceIndex(layeredManifest.workspace_root);
    const currentState = await workspaceIndex.statLiveFile(targetPath);

    if (!layeredManifest.anchor_exists) {
      return currentState.exists === false;
    }

    return currentState.exists === true && currentState.content_hash === layeredManifest.anchor_content_hash;
  }

  async getSnapshotManifest(snapshotId: string): Promise<SnapshotManifest | null> {
    const layeredManifest = await this.loadLayeredManifest(snapshotId);
    if (layeredManifest) {
      const metadataManifest = await this.loadMetadataManifest(snapshotId);
      const targetPath = layeredManifest.anchor_path
        ? path.join(layeredManifest.workspace_root, layeredManifest.anchor_path)
        : layeredManifest.workspace_root;

      return {
        snapshot_id: layeredManifest.snap_id,
        action_id: metadataManifest?.action_id ?? layeredManifest.action_id ?? "unknown_action",
        run_id: metadataManifest?.run_id ?? layeredManifest.run_id ?? "unknown_run",
        target_path: metadataManifest?.target_path ?? targetPath,
        workspace_root: layeredManifest.workspace_root,
        existed_before: metadataManifest?.existed_before ?? layeredManifest.anchor_exists,
        entry_kind: metadataManifest?.entry_kind ?? (layeredManifest.anchor_exists ? "file" : "missing"),
        snapshot_class: metadataManifest?.snapshot_class ?? "journal_plus_anchor",
        fidelity: metadataManifest?.fidelity ?? "full",
        created_at: layeredManifest.created_at,
        anchor_content_hash: layeredManifest.anchor_content_hash,
        anchor_file_mode: layeredManifest.anchor_file_mode,
        operation_domain: metadataManifest?.operation_domain,
        operation_kind: metadataManifest?.operation_kind,
        action_display_name: metadataManifest?.action_display_name,
        execution_surface: metadataManifest?.execution_surface,
        tool_kind: metadataManifest?.tool_kind,
        tool_name: metadataManifest?.tool_name,
        side_effect_level: metadataManifest?.side_effect_level,
        external_effects: metadataManifest?.external_effects,
        reversibility_hint: metadataManifest?.reversibility_hint,
        captured_preimage: metadataManifest?.captured_preimage ?? null,
      };
    }

    const metadataManifest = await this.loadMetadataManifest(snapshotId);
    if (metadataManifest) {
      return metadataManifest;
    }

    try {
      const manifestRaw = await fs.readFile(this.legacyManifestPath(snapshotId), "utf8");
      return JSON.parse(manifestRaw) as SnapshotManifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }

      throw new InternalError("Failed to load snapshot manifest.", {
        cause: error instanceof Error ? error.message : String(error),
        snapshot_id: snapshotId,
      });
    }
  }

  async compactSnapshots(workspaceRoots?: string[], keepLastN = 20): Promise<SnapshotCompactionSummary> {
    const roots = this.resolveWorkspaceRoots(workspaceRoots);
    let snapsRemoved = 0;
    let bytesFreed = 0;
    let compactedSnapshots = 0;

    for (const workspaceRoot of roots) {
      const result = await this.getWorkspaceIndex(workspaceRoot).compact(keepLastN);
      snapsRemoved += result.snaps_removed;
      bytesFreed += result.bytes_freed;
      if (result.compacted_snap_id) {
        compactedSnapshots += 1;
      }
    }

    return {
      workspaces_considered: roots.length,
      snaps_removed: snapsRemoved,
      bytes_freed: bytesFreed,
      compacted_snapshots: compactedSnapshots,
    };
  }

  checkpointWal(workspaceRoots?: string[]): SnapshotCheckpointSummary {
    const roots = this.resolveWorkspaceRoots(workspaceRoots);
    let checkpointedDatabases = 0;
    let skippedDatabases = 0;

    for (const workspaceRoot of roots) {
      const result = this.getWorkspaceIndex(workspaceRoot).checkpointWal();
      if (result.checkpointed) {
        checkpointedDatabases += 1;
      } else {
        skippedDatabases += 1;
      }
    }

    return {
      workspaces_considered: roots.length,
      checkpointed_databases: checkpointedDatabases,
      skipped_databases: skippedDatabases,
    };
  }

  async rebaseSyntheticAnchors(workspaceRoots?: string[]): Promise<SnapshotAnchorRebaseSummary> {
    const roots = this.resolveWorkspaceRoots(workspaceRoots);
    let snapshotsScanned = 0;
    let anchorsRebased = 0;
    let bytesFreed = 0;
    let emptyDirectoriesRemoved = 0;

    for (const workspaceRoot of roots) {
      const result = await this.getWorkspaceIndex(workspaceRoot).rebaseSyntheticAnchors();
      snapshotsScanned += result.snapshots_scanned;
      anchorsRebased += result.anchors_rebased;
      bytesFreed += result.bytes_freed;
      emptyDirectoriesRemoved += result.empty_directories_removed;
    }

    return {
      workspaces_considered: roots.length,
      snapshots_scanned: snapshotsScanned,
      anchors_rebased: anchorsRebased,
      bytes_freed: bytesFreed,
      empty_directories_removed: emptyDirectoriesRemoved,
    };
  }
}
