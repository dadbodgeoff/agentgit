import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import Database from "better-sqlite3";
import {
  type ActionRecord,
  AgentGitError,
  type ArtifactAvailability,
  type ApprovalRequest,
  API_VERSION,
  type GetCapabilitiesResponsePayload,
  type GetPolicyCalibrationReportResponsePayload,
  type HelperQuestionType,
  InternalError,
  NotFoundError,
  type PolicyCalibrationActionFamilyBucket,
  type PolicyCalibrationApprovalCounts,
  type PolicyCalibrationConfidenceStats,
  type PolicyCalibrationCountItem,
  type PolicyCalibrationDecisionCounts,
  type PolicyCalibrationSample,
  type ReasonDetail,
  QueryHelperResponsePayloadSchema,
  RunEventSummarySchema,
  RunMaintenanceStatusSchema,
  RunSummarySchema,
  type StoredArtifactRecord,
  type PolicyOutcomeRecord,
  type RequestEnvelope,
  type ResponseEnvelope,
  type ResolveApprovalRequestPayload,
  type SnapshotRecord,
  type QueryHelperResponsePayload,
  type VisibilityScope,
} from "@agentgit/schemas";

type RunEventSummary = ReturnType<typeof RunEventSummarySchema.parse>;
type RunMaintenanceStatus = ReturnType<typeof RunMaintenanceStatusSchema.parse>;
type RunSummary = ReturnType<typeof RunSummarySchema.parse>;
type PolicyCalibrationQuality = GetPolicyCalibrationReportResponsePayload["report"]["totals"]["calibration"];
type PolicyCalibrationBin = PolicyCalibrationQuality["bins"][number];

export interface PolicyReplayRecord {
  run_id: string;
  action_id: string;
  evaluated_at: string;
  action_family: string;
  recorded_decision: PolicyCalibrationSample["decision"];
  approval_status: ApprovalRequest["status"] | null;
  confidence_score: number;
  low_confidence_threshold: number | null;
  confidence_triggered: boolean;
  action: ActionRecord | null;
}

interface PolicyCalibrationEvidence {
  samples: PolicyCalibrationSample[];
  replay_records: PolicyReplayRecord[];
}

function primaryReasonFromPolicyOutcome(policyOutcome: PolicyOutcomeRecord): ReasonDetail | null {
  const firstReason = policyOutcome.reasons[0];
  if (!firstReason) {
    return null;
  }

  return {
    code: firstReason.code,
    message: firstReason.message,
  };
}

export interface RunRecordInput {
  run_id: string;
  session_id: string;
  workflow_name: string;
  agent_framework: string;
  agent_name: string;
  workspace_roots: string[];
  client_metadata: Record<string, unknown>;
  budget_config: RunSummary["budget_config"];
  created_at: string;
}

export interface RunJournalEventInput {
  event_type: string;
  occurred_at: string;
  recorded_at: string;
  payload?: Record<string, unknown>;
}

export interface RunJournalEventRecord extends RunJournalEventInput {
  sequence: number;
}

export interface RunJournalOptions {
  dbPath: string;
  artifactRootPath?: string;
  artifactRetentionMs?: number | null;
}

export interface StoredApprovalRecord extends ApprovalRequest {
  action: ActionRecord;
  policy_outcome: PolicyOutcomeRecord;
  snapshot_record: SnapshotRecord | null;
}

export interface RunJournalDiagnosticsOverview {
  total_runs: number;
  total_events: number;
  pending_approvals: number;
  maintenance_status: RunMaintenanceStatus;
  capability_snapshot: CapabilitySnapshotRecord | null;
}

export interface CapabilitySnapshotRecord {
  capabilities: GetCapabilitiesResponsePayload["capabilities"];
  detection_timestamps: GetCapabilitiesResponsePayload["detection_timestamps"];
  degraded_mode_warnings: string[];
  workspace_root: string | null;
  refreshed_at: string;
}

export interface SqliteCheckpointResult {
  journal_mode: SqliteJournalMode;
  checkpointed: boolean;
  busy: number;
  log_frames: number;
  checkpointed_frames: number;
}

export interface ArtifactOrphanCleanupSummary {
  files_scanned: number;
  referenced_files: number;
  orphaned_files_removed: number;
  bytes_freed: number;
  empty_directories_removed: number;
}

export interface HelperFactCacheRecord {
  run_id: string;
  question_type: HelperQuestionType;
  focus_step_id: string | null;
  compare_step_id: string | null;
  visibility_scope: VisibilityScope;
  event_count: number;
  latest_sequence: number;
  artifact_state_digest: string;
  response: QueryHelperResponsePayload;
  warmed_at: string;
}

export interface StoredIdempotentMutationRecord {
  session_id: string;
  idempotency_key: string;
  method: RequestEnvelope<unknown>["method"];
  payload_digest: string;
  response: ResponseEnvelope<unknown>;
  stored_at: string;
}

export type ClaimIdempotentMutationResult =
  | { status: "claimed"; payload_digest: string }
  | { status: "replay"; record: StoredIdempotentMutationRecord }
  | {
      status: "conflict";
      record: StoredIdempotentMutationRecord | null;
      request_method: RequestEnvelope<unknown>["method"];
      request_payload_digest: string;
    }
  | {
      status: "in_progress";
      session_id: string;
      idempotency_key: string;
      method: RequestEnvelope<unknown>["method"];
      payload_digest: string;
      stored_at: string;
    };

const ARTIFACT_INTEGRITY_SCHEMA_VERSION = "artifact-integrity.v1" as const;
const ARTIFACT_INTEGRITY_DIGEST_ALGORITHM = "sha256" as const;
const HELPER_FACT_CACHE_VERSION = "helper-fact-cache.v1" as const;

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJsonStringify(entryValue)}`).join(",")}}`;
  }

  return JSON.stringify(value);
}

function payloadDigestForIdempotency(payload: unknown): string {
  return crypto.createHash("sha256").update(stableJsonStringify(payload), "utf8").digest("hex");
}

type BetterSqliteDatabase = InstanceType<typeof Database>;
type SqliteJournalMode = "WAL" | "DELETE";

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

function resolveSqliteJournalMode(): SqliteJournalMode {
  const configured = process.env.AGENTGIT_SQLITE_JOURNAL_MODE?.trim().toUpperCase();
  if (!configured) {
    return "WAL";
  }

  if (configured === "WAL" || configured === "DELETE") {
    return configured;
  }

  throw new InternalError("Unsupported SQLite journal mode.", {
    configured_mode: configured,
    supported_modes: ["WAL", "DELETE"],
  });
}

function emptyCalibrationDecisionCounts(): PolicyCalibrationDecisionCounts {
  return {
    allow: 0,
    allow_with_snapshot: 0,
    ask: 0,
    deny: 0,
  };
}

function emptyCalibrationApprovalCounts(): PolicyCalibrationApprovalCounts {
  return {
    requested: 0,
    pending: 0,
    approved: 0,
    denied: 0,
  };
}

function updateCalibrationDecisionCounts(
  counts: PolicyCalibrationDecisionCounts,
  decision: PolicyCalibrationSample["decision"],
): void {
  if (decision === "allow" || decision === "allow_with_snapshot" || decision === "ask" || decision === "deny") {
    counts[decision] += 1;
  }
}

function updateCalibrationApprovalCounts(
  counts: PolicyCalibrationApprovalCounts,
  sample: PolicyCalibrationSample,
): void {
  if (!sample.approval_requested) {
    return;
  }

  counts.requested += 1;
  if (sample.approval_status === "approved") {
    counts.approved += 1;
    return;
  }
  if (sample.approval_status === "denied") {
    counts.denied += 1;
    return;
  }
  counts.pending += 1;
}

function incrementCalibrationCount(map: Map<string, number>, key: string | null | undefined): void {
  if (!key) {
    return;
  }
  map.set(key, (map.get(key) ?? 0) + 1);
}

function finalizeCalibrationCounts(map: Map<string, number>, limit = 10): PolicyCalibrationCountItem[] {
  return [...map.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return left[0].localeCompare(right[0]);
    })
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

function finalizeCalibrationConfidenceStats(
  sum: number,
  count: number,
  min: number | null,
  max: number | null,
): PolicyCalibrationConfidenceStats {
  if (count === 0) {
    return {
      average: null,
      min: null,
      max: null,
    };
  }

  return {
    average: Number((sum / count).toFixed(6)),
    min,
    max,
  };
}

function emptyCalibrationQuality(): PolicyCalibrationQuality {
  return {
    resolved_sample_count: 0,
    pending_sample_count: 0,
    approved_count: 0,
    denied_count: 0,
    mean_confidence: null,
    mean_observed_approval_rate: null,
    brier_score: null,
    expected_calibration_error: null,
    max_calibration_error: null,
    bins: [],
  };
}

function roundCalibrationValue(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(6));
}

function wilsonInterval(successes: number, total: number): { lower: number; upper: number } | null {
  if (total === 0) {
    return null;
  }

  const z = 1.96;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return {
    lower: Math.max(0, Math.min(1, (center - margin) / denominator)),
    upper: Math.max(0, Math.min(1, (center + margin) / denominator)),
  };
}

function buildCalibrationBins(samples: PolicyCalibrationSample[], binCount = 10): PolicyCalibrationBin[] {
  if (samples.length === 0) {
    return [];
  }

  const bins = Array.from({ length: binCount }, (_, index) => ({
    confidence_floor: index / binCount,
    confidence_ceiling: index === binCount - 1 ? 1 : (index + 1) / binCount,
    sample_count: 0,
    resolved_sample_count: 0,
    pending_sample_count: 0,
    approved_count: 0,
    denied_count: 0,
    confidence_sum: 0,
    brier_sum: 0,
  }));

  for (const sample of samples) {
    const normalizedScore = Math.max(0, Math.min(1, sample.confidence_score));
    const rawIndex = Math.floor(normalizedScore * binCount);
    const binIndex = Math.min(binCount - 1, Math.max(0, rawIndex));
    const bin = bins[binIndex]!;
    bin.sample_count += 1;
    bin.confidence_sum += normalizedScore;

    if (sample.approval_status === "approved") {
      bin.resolved_sample_count += 1;
      bin.approved_count += 1;
      bin.brier_sum += Math.pow(normalizedScore - 1, 2);
    } else if (sample.approval_status === "denied") {
      bin.resolved_sample_count += 1;
      bin.denied_count += 1;
      bin.brier_sum += Math.pow(normalizedScore, 2);
    } else {
      bin.pending_sample_count += 1;
    }
  }

  return bins
    .filter((bin) => bin.sample_count > 0)
    .map((bin) => {
      const averageConfidence = bin.sample_count > 0 ? bin.confidence_sum / bin.sample_count : null;
      const approvalRate = bin.resolved_sample_count > 0 ? bin.approved_count / bin.resolved_sample_count : null;
      const interval =
        bin.resolved_sample_count > 0 ? wilsonInterval(bin.approved_count, bin.resolved_sample_count) : null;
      return {
        confidence_floor: Number(bin.confidence_floor.toFixed(3)),
        confidence_ceiling: Number(bin.confidence_ceiling.toFixed(3)),
        sample_count: bin.sample_count,
        resolved_sample_count: bin.resolved_sample_count,
        pending_sample_count: bin.pending_sample_count,
        approved_count: bin.approved_count,
        denied_count: bin.denied_count,
        average_confidence: roundCalibrationValue(averageConfidence),
        approval_rate: roundCalibrationValue(approvalRate),
        approval_rate_lower_bound: roundCalibrationValue(interval?.lower ?? null),
        approval_rate_upper_bound: roundCalibrationValue(interval?.upper ?? null),
        absolute_gap:
          averageConfidence !== null && approvalRate !== null
            ? roundCalibrationValue(Math.abs(averageConfidence - approvalRate))
            : null,
      };
    });
}

function buildCalibrationQuality(samples: PolicyCalibrationSample[]): PolicyCalibrationQuality {
  const calibrationSamples = samples.filter((sample) => sample.approval_requested);
  if (calibrationSamples.length === 0) {
    return emptyCalibrationQuality();
  }

  const bins = buildCalibrationBins(calibrationSamples);
  let resolvedSampleCount = 0;
  let pendingSampleCount = 0;
  let approvedCount = 0;
  let deniedCount = 0;
  let confidenceSum = 0;
  let observedApprovalSum = 0;
  let brierSum = 0;

  for (const sample of calibrationSamples) {
    confidenceSum += sample.confidence_score;
    if (sample.approval_status === "approved") {
      resolvedSampleCount += 1;
      approvedCount += 1;
      observedApprovalSum += 1;
      brierSum += Math.pow(sample.confidence_score - 1, 2);
    } else if (sample.approval_status === "denied") {
      resolvedSampleCount += 1;
      deniedCount += 1;
      brierSum += Math.pow(sample.confidence_score, 2);
    } else {
      pendingSampleCount += 1;
    }
  }

  const meanConfidence = calibrationSamples.length > 0 ? confidenceSum / calibrationSamples.length : null;
  const meanObservedApprovalRate = resolvedSampleCount > 0 ? observedApprovalSum / resolvedSampleCount : null;
  const brierScore = resolvedSampleCount > 0 ? brierSum / resolvedSampleCount : null;
  const expectedCalibrationError =
    resolvedSampleCount > 0
      ? bins.reduce((total, bin) => {
          if (bin.approval_rate === null || bin.average_confidence === null) {
            return total;
          }
          return (
            total +
            Math.abs(bin.average_confidence - bin.approval_rate) * (bin.resolved_sample_count / resolvedSampleCount)
          );
        }, 0)
      : null;
  const maxCalibrationError =
    resolvedSampleCount > 0 ? bins.reduce((maxGap, bin) => Math.max(maxGap, bin.absolute_gap ?? 0), 0) : null;

  return {
    resolved_sample_count: resolvedSampleCount,
    pending_sample_count: pendingSampleCount,
    approved_count: approvedCount,
    denied_count: deniedCount,
    mean_confidence: roundCalibrationValue(meanConfidence),
    mean_observed_approval_rate: roundCalibrationValue(meanObservedApprovalRate),
    brier_score: roundCalibrationValue(brierScore),
    expected_calibration_error: roundCalibrationValue(expectedCalibrationError),
    max_calibration_error: roundCalibrationValue(maxCalibrationError),
    bins,
  };
}

function policyEvidenceKey(runId: string, actionId: string): string {
  return `${runId}:${actionId}`;
}

export class RunJournal {
  private readonly db: BetterSqliteDatabase;
  private readonly artifactRootPath: string;
  private readonly artifactRetentionMs: number | null;

  constructor(options: RunJournalOptions) {
    try {
      if (
        options.artifactRetentionMs !== undefined &&
        options.artifactRetentionMs !== null &&
        options.artifactRetentionMs < 0
      ) {
        throw new InternalError("Artifact retention must be null or a non-negative number of milliseconds.", {
          artifact_retention_ms: options.artifactRetentionMs,
        });
      }

      fs.mkdirSync(path.dirname(options.dbPath), { recursive: true });
      this.db = new Database(options.dbPath);
      this.artifactRootPath = options.artifactRootPath ?? path.join(path.dirname(options.dbPath), "artifacts");
      this.artifactRetentionMs = options.artifactRetentionMs ?? null;
      fs.mkdirSync(this.artifactRootPath, { recursive: true });
      this.db.pragma(`journal_mode = ${resolveSqliteJournalMode()}`);
      this.db.pragma("foreign_keys = ON");
      this.migrate();
      this.enforceArtifactRetention();
    } catch (error) {
      if (error instanceof InternalError) {
        throw error;
      }

      throw new InternalError("Failed to initialize run journal.", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workflow_name TEXT NOT NULL,
        agent_framework TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        workspace_roots_json TEXT NOT NULL,
        client_metadata_json TEXT NOT NULL,
        budget_config_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        started_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(run_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_run_events_run_sequence
        ON run_events (run_id, sequence);

      CREATE INDEX IF NOT EXISTS idx_run_events_run_recorded_at
        ON run_events (run_id, recorded_at);

      CREATE TABLE IF NOT EXISTS approval_requests (
        approval_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        action_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        resolved_at TEXT,
        resolution_note TEXT,
        decision_requested TEXT NOT NULL,
        action_summary TEXT NOT NULL,
        action_json TEXT NOT NULL,
        policy_outcome_json TEXT NOT NULL,
        snapshot_record_json TEXT,
        FOREIGN KEY (run_id) REFERENCES runs(run_id)
      );

      CREATE INDEX IF NOT EXISTS idx_approval_requests_run_status
        ON approval_requests (run_id, status, requested_at);

      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content_ref TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        integrity_schema_version TEXT,
        content_digest_algorithm TEXT,
        content_digest TEXT,
        content_sha256 TEXT,
        visibility TEXT NOT NULL,
        storage_relpath TEXT NOT NULL,
        expires_at TEXT,
        expired_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(run_id)
      );

      CREATE INDEX IF NOT EXISTS idx_artifacts_run_execution
        ON artifacts (run_id, execution_id, created_at);

      CREATE TABLE IF NOT EXISTS capability_snapshots (
        snapshot_key TEXT PRIMARY KEY,
        capabilities_json TEXT NOT NULL,
        degraded_mode_warnings_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        workspace_root TEXT,
        refreshed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS helper_fact_cache (
        cache_key TEXT PRIMARY KEY,
        cache_version TEXT NOT NULL,
        run_id TEXT NOT NULL,
        question_type TEXT NOT NULL,
        focus_step_id TEXT,
        compare_step_id TEXT,
        visibility_scope TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        latest_sequence INTEGER NOT NULL,
        artifact_state_digest TEXT NOT NULL,
        response_json TEXT NOT NULL,
        warmed_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(run_id)
      );

      CREATE INDEX IF NOT EXISTS idx_helper_fact_cache_run_id
        ON helper_fact_cache (run_id, visibility_scope, question_type);

      CREATE TABLE IF NOT EXISTS idempotent_mutations (
        session_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        method TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        state TEXT NOT NULL,
        response_json TEXT,
        stored_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY (session_id, idempotency_key)
      );
    `);

    this.ensureColumn("runs", "budget_config_json", "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn("artifacts", "integrity_schema_version", "TEXT");
    this.ensureColumn("artifacts", "content_digest_algorithm", "TEXT");
    this.ensureColumn("artifacts", "content_digest", "TEXT");
    this.ensureColumn("artifacts", "content_sha256", "TEXT");
    this.ensureColumn("artifacts", "expires_at", "TEXT");
    this.ensureColumn("artifacts", "expired_at", "TEXT");
    this.ensureColumn("capability_snapshots", "workspace_root", "TEXT");
    this.ensureColumn("capability_snapshots", "refreshed_at", "TEXT NOT NULL DEFAULT ''");
  }

  private ensureColumn(tableName: string, columnName: string, columnDefinition: string): void {
    const pragmaStatement = this.db.prepare(`PRAGMA table_info(${tableName})`) as unknown as {
      all(): Array<{ name: string }>;
    };
    const columns = pragmaStatement.all();

    if (!columns.some((column) => column.name === columnName)) {
      this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
    }
  }

  private helperFactCacheKey(input: {
    run_id: string;
    question_type: HelperQuestionType;
    focus_step_id: string | null;
    compare_step_id: string | null;
    visibility_scope: VisibilityScope;
  }): string {
    return JSON.stringify([
      HELPER_FACT_CACHE_VERSION,
      input.run_id,
      input.question_type,
      input.focus_step_id ?? "",
      input.compare_step_id ?? "",
      input.visibility_scope,
    ]);
  }

  private parseStoredIdempotentResponse(responseJson: string): ResponseEnvelope<unknown> {
    try {
      const parsed = JSON.parse(responseJson) as ResponseEnvelope<unknown>;
      if (parsed.api_version !== API_VERSION || parsed.ok !== true) {
        throw new Error("Stored idempotent response was not a successful authority.v1 response envelope.");
      }

      return parsed;
    } catch (error) {
      throw new InternalError("Stored idempotent response could not be parsed.", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private artifactRelativePath(artifactId: string): string {
    const digest = crypto.createHash("sha256").update(artifactId).digest("hex");
    return path.join(digest.slice(0, 2), digest.slice(2, 4), `${artifactId}.txt`);
  }

  private normalizeTimestampToMillis(value: string, field: string, artifactId?: string): number {
    const millis = Date.parse(value);

    if (Number.isNaN(millis)) {
      throw new InternalError(`Artifact ${field} was not a valid timestamp.`, {
        artifact_id: artifactId,
        [field]: value,
      });
    }

    return millis;
  }

  private computeArtifactExpiresAt(createdAt: string, artifactId?: string): string | null {
    if (this.artifactRetentionMs === null) {
      return null;
    }

    const createdAtMs = this.normalizeTimestampToMillis(createdAt, "created_at", artifactId);
    return new Date(createdAtMs + this.artifactRetentionMs).toISOString();
  }

  private isArtifactExpired(expiresAt: string | null, expiredAt: string | null, artifactId?: string): boolean {
    if (expiredAt) {
      return true;
    }

    if (!expiresAt) {
      return false;
    }

    return this.normalizeTimestampToMillis(expiresAt, "expires_at", artifactId) <= Date.now();
  }

  private artifactStatusForRow(row: {
    storage_relpath: string;
    expires_at: string | null;
    expired_at: string | null;
    byte_size: number;
    integrity_schema_version: string | null;
    content_digest_algorithm: string | null;
    content_digest: string | null;
    content_sha256: string | null;
    artifact_id?: string;
  }): ArtifactAvailability {
    if (this.isArtifactExpired(row.expires_at, row.expired_at, row.artifact_id)) {
      return "expired";
    }

    const storagePath = path.join(this.artifactRootPath, row.storage_relpath);
    if (!fs.existsSync(storagePath)) {
      return "missing";
    }

    try {
      const stat = fs.statSync(storagePath);
      if (!stat.isFile()) {
        return "corrupted";
      }

      if (stat.size !== row.byte_size) {
        return "tampered";
      }

      const expectedDigest = row.content_digest ?? row.content_sha256;
      const digestAlgorithm = row.content_digest_algorithm ?? ARTIFACT_INTEGRITY_DIGEST_ALGORITHM;
      const schemaVersion = row.integrity_schema_version ?? ARTIFACT_INTEGRITY_SCHEMA_VERSION;

      if (!expectedDigest) {
        return "corrupted";
      }

      if (
        schemaVersion !== ARTIFACT_INTEGRITY_SCHEMA_VERSION ||
        digestAlgorithm !== ARTIFACT_INTEGRITY_DIGEST_ALGORITHM
      ) {
        return "corrupted";
      }

      const digest = crypto.createHash(digestAlgorithm).update(fs.readFileSync(storagePath)).digest("hex");
      return digest === expectedDigest ? "available" : "tampered";
    } catch {
      return "corrupted";
    }
  }

  enforceArtifactRetention(now = new Date().toISOString()): number {
    if (this.artifactRetentionMs === null) {
      return 0;
    }

    try {
      const selectExpiredArtifacts = this.db.prepare(
        `
          SELECT artifact_id, storage_relpath
          FROM artifacts
          WHERE expired_at IS NULL
            AND expires_at IS NOT NULL
            AND expires_at <= ?
        `,
      ) as unknown as {
        all(expirationCutoff: string): Array<{ artifact_id: string; storage_relpath: string }>;
      };
      const rows = selectExpiredArtifacts.all(now);

      if (rows.length === 0) {
        return 0;
      }

      const updateExpiredAt = this.db.prepare(`
        UPDATE artifacts
        SET expired_at = ?
        WHERE artifact_id = ?
      `);

      const transaction = this.db.transaction(
        (expiredRows: Array<{ artifact_id: string; storage_relpath: string }>) => {
          for (const row of expiredRows) {
            const storagePath = path.join(this.artifactRootPath, row.storage_relpath);
            fs.rmSync(storagePath, { force: true });
            updateExpiredAt.run(now, row.artifact_id);
          }
        },
      );

      transaction(rows);
      return rows.length;
    } catch (error) {
      if (isLowDiskPressureError(error)) {
        throw storageUnavailableError("Failed to enforce artifact retention.", error);
      }

      throw new InternalError("Failed to enforce artifact retention.", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  cleanupOrphanedArtifacts(): ArtifactOrphanCleanupSummary {
    const summary: ArtifactOrphanCleanupSummary = {
      files_scanned: 0,
      referenced_files: 0,
      orphaned_files_removed: 0,
      bytes_freed: 0,
      empty_directories_removed: 0,
    };

    const referencedPaths = new Set<string>();

    try {
      const rows = (
        this.db.prepare(
          `
            SELECT storage_relpath
            FROM artifacts
          `,
        ) as unknown as {
          all(): Array<{ storage_relpath: string }>;
        }
      ).all();

      for (const row of rows) {
        referencedPaths.add(path.normalize(row.storage_relpath));
      }

      const walk = (directoryPath: string): void => {
        const entries = fs.readdirSync(directoryPath, { withFileTypes: true });

        for (const entry of entries) {
          const entryPath = path.join(directoryPath, entry.name);
          const relativePath = path.normalize(path.relative(this.artifactRootPath, entryPath));

          if (entry.isDirectory()) {
            walk(entryPath);
            continue;
          }

          summary.files_scanned += 1;

          if (referencedPaths.has(relativePath)) {
            summary.referenced_files += 1;
            continue;
          }

          let bytesFreed = 0;
          try {
            const stat = fs.lstatSync(entryPath);
            if (stat.isFile()) {
              bytesFreed = stat.size;
            }
          } catch {
            bytesFreed = 0;
          }

          fs.rmSync(entryPath, { force: true, recursive: true });
          summary.orphaned_files_removed += 1;
          summary.bytes_freed += bytesFreed;
        }

        if (directoryPath === this.artifactRootPath) {
          return;
        }

        const remainingEntries = fs.readdirSync(directoryPath);
        if (remainingEntries.length === 0) {
          fs.rmdirSync(directoryPath);
          summary.empty_directories_removed += 1;
        }
      };

      walk(this.artifactRootPath);
      return summary;
    } catch (error) {
      if (isLowDiskPressureError(error)) {
        throw storageUnavailableError("Failed to clean orphaned artifact blobs.", error);
      }

      throw new InternalError("Failed to clean orphaned artifact blobs.", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  clearHelperFactCache(runId: string): number {
    try {
      const result = this.db
        .prepare(
          `
            DELETE FROM helper_fact_cache
            WHERE run_id = ?
          `,
        )
        .run(runId);
      return result.changes;
    } catch (error) {
      if (isLowDiskPressureError(error)) {
        throw storageUnavailableError("Failed to clear helper fact cache.", error, {
          run_id: runId,
        });
      }

      throw new InternalError("Failed to clear helper fact cache.", {
        cause: error instanceof Error ? error.message : String(error),
        run_id: runId,
      });
    }
  }

  getRunArtifactStateDigest(runId: string): string {
    try {
      const rows = (
        this.db.prepare(
          `
            SELECT
              artifact_id,
              storage_relpath,
              byte_size,
              integrity_schema_version,
              content_digest_algorithm,
              content_digest,
              content_sha256,
              expires_at,
              expired_at
            FROM artifacts
            WHERE run_id = ?
            ORDER BY artifact_id ASC
          `,
        ) as unknown as {
          all(boundRunId: string): Array<{
            artifact_id: string;
            storage_relpath: string;
            byte_size: number;
            integrity_schema_version: string | null;
            content_digest_algorithm: string | null;
            content_digest: string | null;
            content_sha256: string | null;
            expires_at: string | null;
            expired_at: string | null;
          }>;
        }
      ).all(runId);

      const digestInput = rows.map((row) => ({
        artifact_id: row.artifact_id,
        status: this.artifactStatusForRow(row),
      }));

      return crypto.createHash("sha256").update(JSON.stringify(digestInput), "utf8").digest("hex");
    } catch (error) {
      throw new InternalError("Failed to compute run artifact state digest.", {
        cause: error instanceof Error ? error.message : String(error),
        run_id: runId,
      });
    }
  }

  getHelperFactCache(input: {
    run_id: string;
    question_type: HelperQuestionType;
    focus_step_id?: string;
    compare_step_id?: string;
    visibility_scope: VisibilityScope;
  }): HelperFactCacheRecord | null {
    try {
      const row = this.db
        .prepare(
          `
            SELECT
              run_id,
              question_type,
              focus_step_id,
              compare_step_id,
              visibility_scope,
              event_count,
              latest_sequence,
              artifact_state_digest,
              response_json,
              warmed_at
            FROM helper_fact_cache
            WHERE cache_key = ?
          `,
        )
        .get(
          this.helperFactCacheKey({
            run_id: input.run_id,
            question_type: input.question_type,
            focus_step_id: input.focus_step_id ?? null,
            compare_step_id: input.compare_step_id ?? null,
            visibility_scope: input.visibility_scope,
          }),
        ) as
        | {
            run_id: string;
            question_type: HelperQuestionType;
            focus_step_id: string | null;
            compare_step_id: string | null;
            visibility_scope: VisibilityScope;
            event_count: number;
            latest_sequence: number;
            artifact_state_digest: string;
            response_json: string;
            warmed_at: string;
          }
        | undefined;

      if (!row) {
        return null;
      }

      return {
        run_id: row.run_id,
        question_type: row.question_type,
        focus_step_id: row.focus_step_id,
        compare_step_id: row.compare_step_id,
        visibility_scope: row.visibility_scope,
        event_count: row.event_count,
        latest_sequence: row.latest_sequence,
        artifact_state_digest: row.artifact_state_digest,
        response: QueryHelperResponsePayloadSchema.parse(JSON.parse(row.response_json) as unknown),
        warmed_at: row.warmed_at,
      };
    } catch (error) {
      throw new InternalError("Failed to load helper fact cache entry.", {
        cause: error instanceof Error ? error.message : String(error),
        run_id: input.run_id,
        question_type: input.question_type,
        focus_step_id: input.focus_step_id ?? null,
        compare_step_id: input.compare_step_id ?? null,
        visibility_scope: input.visibility_scope,
      });
    }
  }

  storeHelperFactCache(input: HelperFactCacheRecord): void {
    try {
      this.db
        .prepare(
          `
            INSERT INTO helper_fact_cache (
              cache_key,
              cache_version,
              run_id,
              question_type,
              focus_step_id,
              compare_step_id,
              visibility_scope,
              event_count,
              latest_sequence,
              artifact_state_digest,
              response_json,
              warmed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(cache_key) DO UPDATE SET
              cache_version = excluded.cache_version,
              event_count = excluded.event_count,
              latest_sequence = excluded.latest_sequence,
              artifact_state_digest = excluded.artifact_state_digest,
              response_json = excluded.response_json,
              warmed_at = excluded.warmed_at
          `,
        )
        .run(
          this.helperFactCacheKey({
            run_id: input.run_id,
            question_type: input.question_type,
            focus_step_id: input.focus_step_id,
            compare_step_id: input.compare_step_id,
            visibility_scope: input.visibility_scope,
          }),
          HELPER_FACT_CACHE_VERSION,
          input.run_id,
          input.question_type,
          input.focus_step_id,
          input.compare_step_id,
          input.visibility_scope,
          input.event_count,
          input.latest_sequence,
          input.artifact_state_digest,
          JSON.stringify(input.response),
          input.warmed_at,
        );
    } catch (error) {
      if (isLowDiskPressureError(error)) {
        throw storageUnavailableError("Failed to store helper fact cache entry.", error, {
          run_id: input.run_id,
          question_type: input.question_type,
        });
      }

      throw new InternalError("Failed to store helper fact cache entry.", {
        cause: error instanceof Error ? error.message : String(error),
        run_id: input.run_id,
        question_type: input.question_type,
      });
    }
  }

  claimIdempotentMutation(input: {
    session_id: string;
    idempotency_key: string;
    method: RequestEnvelope<unknown>["method"];
    payload: unknown;
    stored_at: string;
  }): ClaimIdempotentMutationResult {
    const payloadDigest = payloadDigestForIdempotency(input.payload);

    try {
      const transaction = this.db.transaction(() => {
        const existing = this.db
          .prepare(
            `
              SELECT
                session_id,
                idempotency_key,
                method,
                payload_digest,
                state,
                response_json,
                stored_at
              FROM idempotent_mutations
              WHERE session_id = ? AND idempotency_key = ?
            `,
          )
          .get(input.session_id, input.idempotency_key) as
          | {
              session_id: string;
              idempotency_key: string;
              method: RequestEnvelope<unknown>["method"];
              payload_digest: string;
              state: "pending" | "completed";
              response_json: string | null;
              stored_at: string;
            }
          | undefined;

        if (!existing) {
          this.db
            .prepare(
              `
                INSERT INTO idempotent_mutations (
                  session_id,
                  idempotency_key,
                  method,
                  payload_digest,
                  state,
                  response_json,
                  stored_at,
                  completed_at
                ) VALUES (?, ?, ?, ?, 'pending', NULL, ?, NULL)
              `,
            )
            .run(input.session_id, input.idempotency_key, input.method, payloadDigest, input.stored_at);

          return {
            status: "claimed",
            payload_digest: payloadDigest,
          } satisfies ClaimIdempotentMutationResult;
        }

        if (existing.method !== input.method || existing.payload_digest !== payloadDigest) {
          return {
            status: "conflict",
            record: existing.response_json
              ? {
                  session_id: existing.session_id,
                  idempotency_key: existing.idempotency_key,
                  method: existing.method,
                  payload_digest: existing.payload_digest,
                  response: this.parseStoredIdempotentResponse(existing.response_json),
                  stored_at: existing.stored_at,
                }
              : null,
            request_method: input.method,
            request_payload_digest: payloadDigest,
          } as ClaimIdempotentMutationResult;
        }

        if (existing.state === "completed" && existing.response_json) {
          return {
            status: "replay",
            record: {
              session_id: existing.session_id,
              idempotency_key: existing.idempotency_key,
              method: existing.method,
              payload_digest: existing.payload_digest,
              response: this.parseStoredIdempotentResponse(existing.response_json),
              stored_at: existing.stored_at,
            },
          } satisfies ClaimIdempotentMutationResult;
        }

        return {
          status: "in_progress",
          session_id: existing.session_id,
          idempotency_key: existing.idempotency_key,
          method: existing.method,
          payload_digest: existing.payload_digest,
          stored_at: existing.stored_at,
        } satisfies ClaimIdempotentMutationResult;
      }) as () => ClaimIdempotentMutationResult;

      return transaction();
    } catch (error) {
      if (error instanceof InternalError) {
        throw error;
      }

      if (isLowDiskPressureError(error)) {
        throw storageUnavailableError("Failed to claim idempotent mutation.", error, {
          session_id: input.session_id,
          idempotency_key: input.idempotency_key,
          method: input.method,
        });
      }

      throw new InternalError("Failed to claim idempotent mutation.", {
        cause: error instanceof Error ? error.message : String(error),
        session_id: input.session_id,
        idempotency_key: input.idempotency_key,
        method: input.method,
      });
    }
  }

  completeIdempotentMutation(input: {
    session_id: string;
    idempotency_key: string;
    response: ResponseEnvelope<unknown>;
    completed_at: string;
  }): void {
    try {
      this.db
        .prepare(
          `
            UPDATE idempotent_mutations
            SET state = 'completed',
                response_json = ?,
                completed_at = ?
            WHERE session_id = ? AND idempotency_key = ?
          `,
        )
        .run(JSON.stringify(input.response), input.completed_at, input.session_id, input.idempotency_key);
    } catch (error) {
      if (isLowDiskPressureError(error)) {
        throw storageUnavailableError("Failed to complete idempotent mutation.", error, {
          session_id: input.session_id,
          idempotency_key: input.idempotency_key,
        });
      }

      throw new InternalError("Failed to complete idempotent mutation.", {
        cause: error instanceof Error ? error.message : String(error),
        session_id: input.session_id,
        idempotency_key: input.idempotency_key,
      });
    }
  }

  releaseIdempotentMutation(sessionId: string, idempotencyKey: string): void {
    try {
      this.db
        .prepare(
          `
            DELETE FROM idempotent_mutations
            WHERE session_id = ? AND idempotency_key = ? AND state = 'pending'
          `,
        )
        .run(sessionId, idempotencyKey);
    } catch (error) {
      if (isLowDiskPressureError(error)) {
        throw storageUnavailableError("Failed to release pending idempotent mutation.", error, {
          session_id: sessionId,
          idempotency_key: idempotencyKey,
        });
      }

      throw new InternalError("Failed to release pending idempotent mutation.", {
        cause: error instanceof Error ? error.message : String(error),
        session_id: sessionId,
        idempotency_key: idempotencyKey,
      });
    }
  }

  getArtifactStatus(artifactId: string): ArtifactAvailability {
    try {
      const row = this.db
        .prepare(
          `
          SELECT artifact_id, storage_relpath, byte_size, content_sha256, expires_at, expired_at
               , integrity_schema_version, content_digest_algorithm, content_digest
            FROM artifacts
            WHERE artifact_id = ?
          `,
        )
        .get(artifactId) as
        | {
            artifact_id: string;
            storage_relpath: string;
            byte_size: number;
            integrity_schema_version: string | null;
            content_digest_algorithm: string | null;
            content_digest: string | null;
            content_sha256: string | null;
            expires_at: string | null;
            expired_at: string | null;
          }
        | undefined;

      if (!row) {
        throw new NotFoundError(`No artifact found for ${artifactId}.`, {
          artifact_id: artifactId,
        });
      }

      return this.artifactStatusForRow(row);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }

      throw new InternalError("Failed to inspect execution artifact status.", {
        cause: error instanceof Error ? error.message : String(error),
        artifact_id: artifactId,
      });
    }
  }

  storeArtifact(
    input: Omit<StoredArtifactRecord, "integrity"> & {
      content: string;
    },
  ): StoredArtifactRecord["integrity"] {
    const attemptStore = (): StoredArtifactRecord["integrity"] => {
      const storageRelpath = this.artifactRelativePath(input.artifact_id);
      const storagePath = path.join(this.artifactRootPath, storageRelpath);
      const expiresAt = this.computeArtifactExpiresAt(input.created_at, input.artifact_id);
      const contentDigest = crypto
        .createHash(ARTIFACT_INTEGRITY_DIGEST_ALGORITHM)
        .update(input.content, "utf8")
        .digest("hex");
      const integrity: StoredArtifactRecord["integrity"] = {
        schema_version: ARTIFACT_INTEGRITY_SCHEMA_VERSION,
        digest_algorithm: ARTIFACT_INTEGRITY_DIGEST_ALGORITHM,
        digest: contentDigest,
      };
      fs.mkdirSync(path.dirname(storagePath), { recursive: true });
      const tempPath = `${storagePath}.tmp`;
      fs.writeFileSync(tempPath, input.content, "utf8");
      fs.renameSync(tempPath, storagePath);

      this.db
        .prepare(
          `
            INSERT OR REPLACE INTO artifacts (
              artifact_id,
              run_id,
              action_id,
              execution_id,
              type,
              content_ref,
              byte_size,
              integrity_schema_version,
              content_digest_algorithm,
              content_digest,
              content_sha256,
              visibility,
              storage_relpath,
              expires_at,
              expired_at,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          input.artifact_id,
          input.run_id,
          input.action_id,
          input.execution_id,
          input.type,
          input.content_ref,
          input.byte_size,
          ARTIFACT_INTEGRITY_SCHEMA_VERSION,
          ARTIFACT_INTEGRITY_DIGEST_ALGORITHM,
          contentDigest,
          contentDigest,
          input.visibility,
          storageRelpath,
          expiresAt,
          null,
          input.created_at,
        );
      this.clearHelperFactCache(input.run_id);
      this.enforceArtifactRetention(input.created_at);
      return integrity;
    };

    try {
      this.enforceArtifactRetention(input.created_at);
      return attemptStore();
    } catch (error) {
      if (isLowDiskPressureError(error)) {
        let purgedExpiredArtifacts = 0;
        try {
          purgedExpiredArtifacts = this.enforceArtifactRetention(input.created_at);
          if (purgedExpiredArtifacts > 0) {
            return attemptStore();
          }
        } catch (retentionError) {
          if (isLowDiskPressureError(retentionError)) {
            throw storageUnavailableError("Failed to store execution artifact.", retentionError, {
              artifact_id: input.artifact_id,
              purged_expired_artifacts: purgedExpiredArtifacts,
              recovery_attempted: true,
            });
          }
        }

        throw storageUnavailableError("Failed to store execution artifact.", error, {
          artifact_id: input.artifact_id,
          purged_expired_artifacts: purgedExpiredArtifacts,
          recovery_attempted: true,
        });
      }

      throw new InternalError("Failed to store execution artifact.", {
        cause: error instanceof Error ? error.message : String(error),
        artifact_id: input.artifact_id,
      });
    }
  }

  getArtifact(
    artifactId: string,
  ): StoredArtifactRecord & { content: string | null; artifact_status: ArtifactAvailability } {
    try {
      const row = this.db
        .prepare(
          `
            SELECT
              artifact_id,
              run_id,
              action_id,
              execution_id,
              type,
              content_ref,
              byte_size,
              integrity_schema_version,
              content_digest_algorithm,
              content_digest,
              content_sha256,
              visibility,
              storage_relpath,
              expires_at,
              expired_at,
              created_at
            FROM artifacts
            WHERE artifact_id = ?
          `,
        )
        .get(artifactId) as
        | {
            artifact_id: string;
            run_id: string;
            action_id: string;
            execution_id: string;
            type: StoredArtifactRecord["type"];
            content_ref: string;
            byte_size: number;
            integrity_schema_version: string | null;
            content_digest_algorithm: string | null;
            content_digest: string | null;
            content_sha256: string | null;
            visibility: StoredArtifactRecord["visibility"];
            storage_relpath: string;
            expires_at: string | null;
            expired_at: string | null;
            created_at: string;
          }
        | undefined;

      if (!row) {
        throw new NotFoundError(`No artifact found for ${artifactId}.`, {
          artifact_id: artifactId,
        });
      }

      const artifactStatus = this.artifactStatusForRow(row);
      const storagePath = path.join(this.artifactRootPath, row.storage_relpath);
      let content: string | null = null;
      if (artifactStatus === "available" && fs.existsSync(storagePath)) {
        try {
          content = fs.readFileSync(storagePath, "utf8");
        } catch {
          content = null;
        }
      }
      return {
        artifact_id: row.artifact_id,
        run_id: row.run_id,
        action_id: row.action_id,
        execution_id: row.execution_id,
        type: row.type,
        content_ref: row.content_ref,
        byte_size: row.byte_size,
        integrity: {
          schema_version: (row.integrity_schema_version ??
            ARTIFACT_INTEGRITY_SCHEMA_VERSION) as typeof ARTIFACT_INTEGRITY_SCHEMA_VERSION,
          digest_algorithm: (row.content_digest_algorithm ??
            ARTIFACT_INTEGRITY_DIGEST_ALGORITHM) as typeof ARTIFACT_INTEGRITY_DIGEST_ALGORITHM,
          digest: row.content_digest ?? row.content_sha256,
        },
        visibility: row.visibility,
        expires_at: row.expires_at,
        expired_at: row.expired_at,
        created_at: row.created_at,
        artifact_status: content === null && artifactStatus === "available" ? "corrupted" : artifactStatus,
        content,
      };
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }

      throw new InternalError("Failed to load execution artifact.", {
        cause: error instanceof Error ? error.message : String(error),
        artifact_id: artifactId,
      });
    }
  }

  registerRunLifecycle(run: RunRecordInput): void {
    try {
      const insertRun = this.db.prepare(`
        INSERT INTO runs (
          run_id,
          session_id,
          workflow_name,
          agent_framework,
          agent_name,
          workspace_roots_json,
          client_metadata_json,
          budget_config_json,
          created_at,
          started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertEvent = this.db.prepare(`
        INSERT INTO run_events (
          run_id,
          sequence,
          event_type,
          occurred_at,
          recorded_at,
          payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);

      const transaction = this.db.transaction((runRecord: RunRecordInput) => {
        insertRun.run(
          runRecord.run_id,
          runRecord.session_id,
          runRecord.workflow_name,
          runRecord.agent_framework,
          runRecord.agent_name,
          JSON.stringify(runRecord.workspace_roots),
          JSON.stringify(runRecord.client_metadata),
          JSON.stringify(runRecord.budget_config),
          runRecord.created_at,
          runRecord.created_at,
        );

        const lifecycleEvents: RunJournalEventInput[] = [
          {
            event_type: "run.created",
            occurred_at: runRecord.created_at,
            recorded_at: runRecord.created_at,
            payload: {
              workflow_name: runRecord.workflow_name,
              agent_framework: runRecord.agent_framework,
              agent_name: runRecord.agent_name,
              budget_config: runRecord.budget_config,
            },
          },
          {
            event_type: "run.started",
            occurred_at: runRecord.created_at,
            recorded_at: runRecord.created_at,
            payload: {
              session_id: runRecord.session_id,
              workspace_roots: runRecord.workspace_roots,
            },
          },
        ];

        lifecycleEvents.forEach((event, index) => {
          insertEvent.run(
            runRecord.run_id,
            index + 1,
            event.event_type,
            event.occurred_at,
            event.recorded_at,
            JSON.stringify(event.payload ?? {}),
          );
        });
      });

      transaction(run);
    } catch (error) {
      throw new InternalError("Failed to register run lifecycle.", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private getMaintenanceStatus(runId?: string): RunMaintenanceStatus {
    const artifactRows = runId
      ? (
          this.db.prepare(
            `
              SELECT artifact_id, storage_relpath, byte_size, content_sha256, expires_at, expired_at
                   , integrity_schema_version, content_digest_algorithm, content_digest
                FROM artifacts
                WHERE run_id = ?
            `,
          ) as unknown as {
            all(runId: string): Array<{
              artifact_id: string;
              storage_relpath: string;
              byte_size: number;
              integrity_schema_version: string | null;
              content_digest_algorithm: string | null;
              content_digest: string | null;
              content_sha256: string | null;
              expires_at: string | null;
              expired_at: string | null;
            }>;
          }
        ).all(runId)
      : (
          this.db.prepare(
            `
              SELECT artifact_id, storage_relpath, byte_size, content_sha256, expires_at, expired_at
                   , integrity_schema_version, content_digest_algorithm, content_digest
                FROM artifacts
            `,
          ) as unknown as {
            all(): Array<{
              artifact_id: string;
              storage_relpath: string;
              byte_size: number;
              integrity_schema_version: string | null;
              content_digest_algorithm: string | null;
              content_digest: string | null;
              content_sha256: string | null;
              expires_at: string | null;
              expired_at: string | null;
            }>;
          }
        ).all();

    const artifactHealth: RunMaintenanceStatus["artifact_health"] = {
      total: artifactRows.length,
      available: 0,
      missing: 0,
      expired: 0,
      corrupted: 0,
      tampered: 0,
    };

    for (const row of artifactRows) {
      const status = this.artifactStatusForRow(row);
      artifactHealth[status] += 1;
    }

    const degradedRows = runId
      ? (
          this.db.prepare(
            `
              SELECT payload_json
              FROM run_events
              WHERE run_id = ?
                AND event_type IN ('execution.completed', 'execution.simulated')
            `,
          ) as unknown as {
            all(runId: string): Array<{ payload_json: string }>;
          }
        ).all(runId)
      : (
          this.db.prepare(
            `
              SELECT payload_json
              FROM run_events
              WHERE event_type IN ('execution.completed', 'execution.simulated')
            `,
          ) as unknown as {
            all(): Array<{ payload_json: string }>;
          }
        ).all();

    let degradedArtifactCaptureActions = 0;
    let lowDiskPressureSignals = 0;

    for (const row of degradedRows) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      } catch {
        continue;
      }

      const failedCount =
        typeof payload.artifact_capture_failed_count === "number" ? payload.artifact_capture_failed_count : 0;
      if (failedCount > 0) {
        degradedArtifactCaptureActions += 1;
      }

      const failures = Array.isArray(payload.artifact_capture_failures)
        ? payload.artifact_capture_failures.filter(
            (failure): failure is { low_disk_pressure?: unknown } => failure !== null && typeof failure === "object",
          )
        : [];
      lowDiskPressureSignals += failures.filter((failure) => failure.low_disk_pressure === true).length;
    }

    return {
      projection_status: "fresh",
      projection_lag_events: 0,
      degraded_artifact_capture_actions: degradedArtifactCaptureActions,
      low_disk_pressure_signals: lowDiskPressureSignals,
      artifact_health: artifactHealth,
    };
  }

  private getRunMaintenanceStatus(runId: string): RunMaintenanceStatus {
    return this.getMaintenanceStatus(runId);
  }

  getDiagnosticsOverview(): RunJournalDiagnosticsOverview {
    try {
      const totalRunsRow = this.db.prepare("SELECT COUNT(*) AS count FROM runs").get() as { count: number };
      const totalEventsRow = this.db.prepare("SELECT COUNT(*) AS count FROM run_events").get() as { count: number };
      const pendingApprovalsRow = this.db
        .prepare("SELECT COUNT(*) AS count FROM approval_requests WHERE status = 'pending'")
        .get() as { count: number };

      return {
        total_runs: totalRunsRow.count,
        total_events: totalEventsRow.count,
        pending_approvals: pendingApprovalsRow.count,
        maintenance_status: this.getMaintenanceStatus(),
        capability_snapshot: this.getCapabilitySnapshot(),
      };
    } catch (error) {
      throw new InternalError("Failed to load diagnostics overview.", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  checkpointWal(): SqliteCheckpointResult {
    try {
      const modeRow = this.db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
      const journalMode = (modeRow?.journal_mode?.toUpperCase() ?? resolveSqliteJournalMode()) as SqliteJournalMode;

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
    } catch (error) {
      if (isLowDiskPressureError(error)) {
        throw storageUnavailableError("Failed to checkpoint the run journal WAL.", error);
      }

      throw new InternalError("Failed to checkpoint the run journal WAL.", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getRunSummary(runId: string): RunSummary | null {
    try {
      const runRow = this.db
        .prepare(
          `
            SELECT
              run_id,
              session_id,
              workflow_name,
              agent_framework,
              agent_name,
              workspace_roots_json,
              budget_config_json,
              created_at,
              started_at
            FROM runs
            WHERE run_id = ?
          `,
        )
        .get(runId) as
        | {
            run_id: string;
            session_id: string;
            workflow_name: string;
            agent_framework: string;
            agent_name: string;
            workspace_roots_json: string;
            budget_config_json: string;
            created_at: string;
            started_at: string;
          }
        | undefined;

      if (!runRow) {
        return null;
      }

      const eventCountRow = this.db
        .prepare(
          `
            SELECT COUNT(*) AS event_count
            FROM run_events
            WHERE run_id = ?
          `,
        )
        .get(runId) as { event_count: number };

      const latestEventRow = this.db
        .prepare(
          `
            SELECT sequence, event_type, occurred_at, recorded_at
            FROM run_events
            WHERE run_id = ?
            ORDER BY sequence DESC
            LIMIT 1
          `,
        )
        .get(runId) as RunEventSummary | undefined;

      return {
        run_id: runRow.run_id,
        session_id: runRow.session_id,
        workflow_name: runRow.workflow_name,
        agent_framework: runRow.agent_framework,
        agent_name: runRow.agent_name,
        workspace_roots: JSON.parse(runRow.workspace_roots_json) as string[],
        event_count: eventCountRow.event_count,
        latest_event: latestEventRow ?? null,
        budget_config: normalizeBudgetConfig(JSON.parse(runRow.budget_config_json) as Record<string, unknown>),
        budget_usage: this.getRunBudgetUsage(runId),
        maintenance_status: this.getRunMaintenanceStatus(runId),
        created_at: runRow.created_at,
        started_at: runRow.started_at,
      };
    } catch (error) {
      throw new InternalError("Failed to load run summary.", {
        cause: error instanceof Error ? error.message : String(error),
        run_id: runId,
      });
    }
  }

  appendRunEvent(runId: string, event: RunJournalEventInput): number {
    try {
      if (!this.getRunSummary(runId)) {
        throw new NotFoundError(`No run found for ${runId}.`, { run_id: runId });
      }

      const nextSequenceRow = this.db
        .prepare(
          `
            SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
            FROM run_events
            WHERE run_id = ?
          `,
        )
        .get(runId) as { next_sequence: number };

      const insertEvent = this.db.prepare(`
        INSERT INTO run_events (
          run_id,
          sequence,
          event_type,
          occurred_at,
          recorded_at,
          payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);

      insertEvent.run(
        runId,
        nextSequenceRow.next_sequence,
        event.event_type,
        event.occurred_at,
        event.recorded_at,
        JSON.stringify(event.payload ?? {}),
      );
      this.clearHelperFactCache(runId);

      return nextSequenceRow.next_sequence;
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }

      throw new InternalError("Failed to append run event.", {
        cause: error instanceof Error ? error.message : String(error),
        run_id: runId,
      });
    }
  }

  storeCapabilitySnapshot(snapshot: CapabilitySnapshotRecord): void {
    try {
      this.db
        .prepare(
          `
            INSERT INTO capability_snapshots (
              snapshot_key,
              capabilities_json,
              degraded_mode_warnings_json,
              started_at,
              completed_at,
              workspace_root,
              refreshed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(snapshot_key) DO UPDATE SET
              capabilities_json = excluded.capabilities_json,
              degraded_mode_warnings_json = excluded.degraded_mode_warnings_json,
              started_at = excluded.started_at,
              completed_at = excluded.completed_at,
              workspace_root = excluded.workspace_root,
              refreshed_at = excluded.refreshed_at
          `,
        )
        .run(
          "latest",
          JSON.stringify(snapshot.capabilities),
          JSON.stringify(snapshot.degraded_mode_warnings),
          snapshot.detection_timestamps.started_at,
          snapshot.detection_timestamps.completed_at,
          snapshot.workspace_root,
          snapshot.refreshed_at,
        );
    } catch (error) {
      if (isLowDiskPressureError(error)) {
        throw storageUnavailableError("Failed to store capability snapshot.", error);
      }

      throw new InternalError("Failed to store capability snapshot.", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getCapabilitySnapshot(): CapabilitySnapshotRecord | null {
    try {
      const row = this.db
        .prepare(
          `
            SELECT
              capabilities_json,
              degraded_mode_warnings_json,
              started_at,
              completed_at,
              workspace_root,
              refreshed_at
            FROM capability_snapshots
            WHERE snapshot_key = 'latest'
          `,
        )
        .get() as
        | {
            capabilities_json: string;
            degraded_mode_warnings_json: string;
            started_at: string;
            completed_at: string;
            workspace_root: string | null;
            refreshed_at: string;
          }
        | undefined;

      if (!row) {
        return null;
      }

      return {
        capabilities: JSON.parse(row.capabilities_json) as GetCapabilitiesResponsePayload["capabilities"],
        detection_timestamps: {
          started_at: row.started_at,
          completed_at: row.completed_at,
        },
        degraded_mode_warnings: JSON.parse(row.degraded_mode_warnings_json) as string[],
        workspace_root: row.workspace_root,
        refreshed_at: row.refreshed_at,
      };
    } catch (error) {
      throw new InternalError("Failed to load capability snapshot.", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  listAllRuns(): RunSummary[] {
    try {
      const selectRunIds = this.db.prepare(`
        SELECT run_id
        FROM runs
        ORDER BY created_at ASC
      `) as unknown as {
        all(): Array<{ run_id: string }>;
      };
      const runIds = selectRunIds.all();

      return runIds
        .map((row: { run_id: string }) => this.getRunSummary(row.run_id))
        .filter((run: RunSummary | null): run is RunSummary => run !== null);
    } catch (error) {
      throw new InternalError("Failed to list runs from journal.", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  listRunEvents(runId: string): RunJournalEventRecord[] {
    try {
      if (!this.getRunSummary(runId)) {
        throw new NotFoundError(`No run found for ${runId}.`, { run_id: runId });
      }

      const selectEvents = this.db.prepare(
        `
          SELECT sequence, event_type, occurred_at, recorded_at, payload_json
          FROM run_events
          WHERE run_id = ?
          ORDER BY sequence ASC
        `,
      ) as unknown as {
        all(boundRunId: string): Array<{
          sequence: number;
          event_type: string;
          occurred_at: string;
          recorded_at: string;
          payload_json: string;
        }>;
      };
      const rows = selectEvents.all(runId);

      return rows.map((row) => ({
        sequence: row.sequence,
        event_type: row.event_type,
        occurred_at: row.occurred_at,
        recorded_at: row.recorded_at,
        payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      }));
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }

      throw new InternalError("Failed to list run events.", {
        cause: error instanceof Error ? error.message : String(error),
        run_id: runId,
      });
    }
  }

  getRunBudgetUsage(runId: string): RunSummary["budget_usage"] {
    try {
      const selectEvents = this.db.prepare(
        `
          SELECT payload_json
          FROM run_events
          WHERE run_id = ? AND event_type = 'execution.completed'
        `,
      ) as unknown as {
        all(boundRunId: string): Array<{ payload_json: string }>;
      };
      const rows = selectEvents.all(runId);

      let mutatingActions = 0;
      let destructiveActions = 0;

      for (const row of rows) {
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
        const sideEffectLevel = payload.side_effect_level;

        if (sideEffectLevel === "mutating" || sideEffectLevel === "destructive") {
          mutatingActions += 1;
        }

        if (sideEffectLevel === "destructive") {
          destructiveActions += 1;
        }
      }

      return {
        mutating_actions: mutatingActions,
        destructive_actions: destructiveActions,
      };
    } catch (error) {
      throw new InternalError("Failed to compute run budget usage.", {
        cause: error instanceof Error ? error.message : String(error),
        run_id: runId,
      });
    }
  }

  createApprovalRequest(input: {
    run_id: string;
    action: ActionRecord;
    policy_outcome: PolicyOutcomeRecord;
    snapshot_record?: SnapshotRecord | null;
  }): ApprovalRequest {
    try {
      if (!this.getRunSummary(input.run_id)) {
        throw new NotFoundError(`No run found for ${input.run_id}.`, { run_id: input.run_id });
      }

      const approval: ApprovalRequest = {
        approval_id: `apr_${crypto.randomUUID().replaceAll("-", "")}`,
        run_id: input.run_id,
        action_id: input.action.action_id,
        status: "pending",
        requested_at: input.policy_outcome.evaluated_at,
        resolved_at: null,
        resolution_note: null,
        decision_requested: "approve_or_deny",
        action_summary: input.action.operation.display_name ?? input.action.operation.name,
        primary_reason: primaryReasonFromPolicyOutcome(input.policy_outcome),
      };

      this.db
        .prepare(
          `
            INSERT INTO approval_requests (
              approval_id,
              run_id,
              action_id,
              status,
              requested_at,
              resolved_at,
              resolution_note,
              decision_requested,
              action_summary,
              action_json,
              policy_outcome_json,
              snapshot_record_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          approval.approval_id,
          approval.run_id,
          approval.action_id,
          approval.status,
          approval.requested_at,
          approval.resolved_at,
          approval.resolution_note,
          approval.decision_requested,
          approval.action_summary,
          JSON.stringify(input.action),
          JSON.stringify(input.policy_outcome),
          input.snapshot_record ? JSON.stringify(input.snapshot_record) : null,
        );

      return approval;
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }

      throw new InternalError("Failed to create approval request.", {
        cause: error instanceof Error ? error.message : String(error),
        run_id: input.run_id,
        action_id: input.action.action_id,
      });
    }
  }

  listApprovals(filters: { run_id?: string; status?: ApprovalRequest["status"] } = {}): ApprovalRequest[] {
    try {
      const clauses: string[] = [];
      const values: Array<string> = [];

      if (filters.run_id) {
        clauses.push("run_id = ?");
        values.push(filters.run_id);
      }

      if (filters.status) {
        clauses.push("status = ?");
        values.push(filters.status);
      }

      const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const statement = this.db.prepare(
        `
          SELECT
            approval_id,
            run_id,
            action_id,
            status,
            requested_at,
            resolved_at,
            resolution_note,
            decision_requested,
            action_summary,
            policy_outcome_json
          FROM approval_requests
          ${whereClause}
          ORDER BY requested_at ASC
        `,
      ) as unknown as {
        all(...params: Array<string>): Array<
          ApprovalRequest & {
            policy_outcome_json: string;
          }
        >;
      };

      return statement.all(...values).map((row) => {
        const policyOutcome = JSON.parse(row.policy_outcome_json) as PolicyOutcomeRecord;
        return {
          approval_id: row.approval_id,
          run_id: row.run_id,
          action_id: row.action_id,
          status: row.status,
          requested_at: row.requested_at,
          resolved_at: row.resolved_at,
          resolution_note: row.resolution_note,
          decision_requested: row.decision_requested,
          action_summary: row.action_summary,
          primary_reason: primaryReasonFromPolicyOutcome(policyOutcome),
        };
      });
    } catch (error) {
      throw new InternalError("Failed to list approvals.", {
        cause: error instanceof Error ? error.message : String(error),
        run_id: filters.run_id,
      });
    }
  }

  getStoredApproval(approvalId: string): StoredApprovalRecord | null {
    try {
      const row = this.db
        .prepare(
          `
            SELECT
              approval_id,
              run_id,
              action_id,
              status,
              requested_at,
              resolved_at,
              resolution_note,
              decision_requested,
              action_summary,
              action_json,
              policy_outcome_json,
              snapshot_record_json
            FROM approval_requests
            WHERE approval_id = ?
          `,
        )
        .get(approvalId) as
        | {
            approval_id: string;
            run_id: string;
            action_id: string;
            status: ApprovalRequest["status"];
            requested_at: string;
            resolved_at: string | null;
            resolution_note: string | null;
            decision_requested: "approve_or_deny";
            action_summary: string;
            action_json: string;
            policy_outcome_json: string;
            snapshot_record_json: string | null;
          }
        | undefined;

      if (!row) {
        return null;
      }

      return {
        approval_id: row.approval_id,
        run_id: row.run_id,
        action_id: row.action_id,
        status: row.status,
        requested_at: row.requested_at,
        resolved_at: row.resolved_at,
        resolution_note: row.resolution_note,
        decision_requested: row.decision_requested,
        action_summary: row.action_summary,
        primary_reason: primaryReasonFromPolicyOutcome(JSON.parse(row.policy_outcome_json) as PolicyOutcomeRecord),
        action: JSON.parse(row.action_json) as ActionRecord,
        policy_outcome: JSON.parse(row.policy_outcome_json) as PolicyOutcomeRecord,
        snapshot_record: row.snapshot_record_json ? (JSON.parse(row.snapshot_record_json) as SnapshotRecord) : null,
      };
    } catch (error) {
      throw new InternalError("Failed to load approval request.", {
        cause: error instanceof Error ? error.message : String(error),
        approval_id: approvalId,
      });
    }
  }

  resolveApproval(
    approvalId: string,
    resolution: ResolveApprovalRequestPayload["resolution"],
    note?: string,
  ): ApprovalRequest {
    try {
      const existing = this.getStoredApproval(approvalId);
      if (!existing) {
        throw new NotFoundError(`No approval found for ${approvalId}.`, { approval_id: approvalId });
      }

      if (existing.status !== "pending") {
        return {
          approval_id: existing.approval_id,
          run_id: existing.run_id,
          action_id: existing.action_id,
          status: existing.status,
          requested_at: existing.requested_at,
          resolved_at: existing.resolved_at,
          resolution_note: existing.resolution_note,
          decision_requested: existing.decision_requested,
          action_summary: existing.action_summary,
          primary_reason: existing.primary_reason,
        };
      }

      const resolvedAt = new Date().toISOString();
      const status: ApprovalRequest["status"] = resolution === "approved" ? "approved" : "denied";
      this.db
        .prepare(
          `
            UPDATE approval_requests
            SET status = ?, resolved_at = ?, resolution_note = ?
            WHERE approval_id = ?
          `,
        )
        .run(status, resolvedAt, note ?? null, approvalId);

      return {
        approval_id: existing.approval_id,
        run_id: existing.run_id,
        action_id: existing.action_id,
        status,
        requested_at: existing.requested_at,
        resolved_at: resolvedAt,
        resolution_note: note ?? null,
        decision_requested: existing.decision_requested,
        action_summary: existing.action_summary,
        primary_reason: existing.primary_reason,
      };
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }

      throw new InternalError("Failed to resolve approval request.", {
        cause: error instanceof Error ? error.message : String(error),
        approval_id: approvalId,
      });
    }
  }

  private buildPolicyCalibrationEvidence(filters: { run_id?: string } = {}): PolicyCalibrationEvidence {
    const params = filters.run_id ? [filters.run_id] : [];
    const runClause = filters.run_id ? "AND run_id = ?" : "";

    const policyRows = (
      this.db.prepare(
        `
          SELECT run_id, occurred_at, payload_json
          FROM run_events
          WHERE event_type = 'policy.evaluated'
          ${runClause}
          ORDER BY occurred_at ASC, sequence ASC
        `,
      ) as unknown as {
        all(...boundParams: string[]): Array<{
          run_id: string;
          occurred_at: string;
          payload_json: string;
        }>;
      }
    ).all(...params);

    const approvalRows = (
      this.db.prepare(
        `
          SELECT run_id, approval_id, action_id, status, resolved_at
          FROM approval_requests
          ${filters.run_id ? "WHERE run_id = ?" : ""}
          ORDER BY requested_at ASC
        `,
      ) as unknown as {
        all(...boundParams: string[]): Array<{
          run_id: string;
          approval_id: string;
          action_id: string;
          status: ApprovalRequest["status"];
          resolved_at: string | null;
        }>;
      }
    ).all(...params);

    const recoveryRows = (
      this.db.prepare(
        `
          SELECT run_id, payload_json
          FROM run_events
          WHERE event_type = 'recovery.executed'
          ${runClause}
          ORDER BY occurred_at ASC, sequence ASC
        `,
      ) as unknown as {
        all(...boundParams: string[]): Array<{
          run_id: string;
          payload_json: string;
        }>;
      }
    ).all(...params);

    const normalizedRows = (
      this.db.prepare(
        `
          SELECT run_id, occurred_at, payload_json
          FROM run_events
          WHERE event_type = 'action.normalized'
          ${runClause}
          ORDER BY occurred_at ASC, sequence ASC
        `,
      ) as unknown as {
        all(...boundParams: string[]): Array<{
          run_id: string;
          occurred_at: string;
          payload_json: string;
        }>;
      }
    ).all(...params);

    const approvalByActionKey = new Map<
      string,
      {
        approval_id: string;
        status: ApprovalRequest["status"];
        resolved_at: string | null;
      }
    >();
    for (const row of approvalRows) {
      approvalByActionKey.set(policyEvidenceKey(row.run_id, row.action_id), {
        approval_id: row.approval_id,
        status: row.status,
        resolved_at: row.resolved_at,
      });
    }

    const recoveryByActionKey = new Map<
      string,
      {
        recovery_result: PolicyCalibrationSample["recovery_result"];
        recovery_class: PolicyCalibrationSample["recovery_class"];
        recovery_strategy: string | null;
      }
    >();
    for (const row of recoveryRows) {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      const actionId = typeof payload.action_id === "string" ? payload.action_id : "";
      if (actionId.length === 0) {
        continue;
      }

      const outcome = payload.outcome === "restored" || payload.outcome === "compensated" ? payload.outcome : null;
      const recoveryClass =
        payload.recovery_class === "reversible" ||
        payload.recovery_class === "compensatable" ||
        payload.recovery_class === "review_only" ||
        payload.recovery_class === "irreversible"
          ? payload.recovery_class
          : null;
      const recoveryStrategy = typeof payload.strategy === "string" ? payload.strategy : null;

      recoveryByActionKey.set(policyEvidenceKey(row.run_id, actionId), {
        recovery_result: outcome,
        recovery_class: recoveryClass,
        recovery_strategy: recoveryStrategy,
      });
    }

    const normalizedActionByKey = new Map<string, ActionRecord>();
    for (const row of normalizedRows) {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      const nestedAction =
        payload.action && typeof payload.action === "object" ? (payload.action as ActionRecord) : null;
      const actionId =
        typeof payload.action_id === "string"
          ? payload.action_id
          : typeof nestedAction?.action_id === "string"
            ? nestedAction.action_id
            : "";
      if (actionId.length === 0 || !nestedAction) {
        continue;
      }

      normalizedActionByKey.set(policyEvidenceKey(row.run_id, actionId), nestedAction);
    }

    const samples: PolicyCalibrationSample[] = [];
    const replayRecords: PolicyReplayRecord[] = [];

    for (const row of policyRows) {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      const actionId = typeof payload.action_id === "string" ? payload.action_id : "unknown_action";
      const actionKey = policyEvidenceKey(row.run_id, actionId);
      const action = normalizedActionByKey.get(actionKey) ?? null;
      const actionFamily =
        typeof payload.action_family === "string" && payload.action_family.length > 0
          ? payload.action_family
          : action
            ? `${action.operation.domain}/${action.operation.kind}`
            : "unknown/unknown";
      const decision =
        payload.decision === "allow" ||
        payload.decision === "allow_with_snapshot" ||
        payload.decision === "ask" ||
        payload.decision === "deny"
          ? payload.decision
          : "deny";
      const reasons = Array.isArray(payload.reasons) ? payload.reasons : [];
      const reasonCodes = reasons.flatMap((reason) =>
        reason && typeof reason === "object" && typeof (reason as { code?: unknown }).code === "string"
          ? [(reason as { code: string }).code]
          : [],
      );
      const snapshotSelection =
        payload.snapshot_selection && typeof payload.snapshot_selection === "object"
          ? (payload.snapshot_selection as Record<string, unknown>)
          : null;
      const snapshotClass =
        snapshotSelection?.snapshot_class === "metadata_only" ||
        snapshotSelection?.snapshot_class === "journal_only" ||
        snapshotSelection?.snapshot_class === "journal_plus_anchor" ||
        snapshotSelection?.snapshot_class === "exact_anchor"
          ? snapshotSelection.snapshot_class
          : null;
      const matchedRules = Array.isArray(payload.matched_rules)
        ? payload.matched_rules.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
        : [];
      const approval = approvalByActionKey.get(actionKey) ?? null;
      const recovery = recoveryByActionKey.get(actionKey) ?? null;
      const normalizationConfidence =
        typeof payload.normalization_confidence === "number"
          ? payload.normalization_confidence
          : (action?.normalization.normalization_confidence ?? 0);
      const confidenceScore =
        typeof payload.confidence_score === "number"
          ? payload.confidence_score
          : (action?.confidence_assessment.score ?? normalizationConfidence);
      const lowConfidenceThreshold =
        typeof payload.low_confidence_threshold === "number" ? payload.low_confidence_threshold : null;
      const confidenceTriggered =
        typeof payload.confidence_triggered === "boolean"
          ? payload.confidence_triggered
          : lowConfidenceThreshold !== null && confidenceScore < lowConfidenceThreshold;
      const evaluatedAt = typeof payload.evaluated_at === "string" ? payload.evaluated_at : row.occurred_at;
      const approvalRequested = decision === "ask" || approval !== null;

      samples.push({
        sample_id: actionKey,
        run_id: row.run_id,
        action_id: actionId,
        evaluated_at: evaluatedAt,
        action_family: actionFamily,
        decision,
        normalization_confidence: normalizationConfidence,
        confidence_score: confidenceScore,
        matched_rules: matchedRules,
        reason_codes: reasonCodes,
        snapshot_class: snapshotClass,
        approval_requested: approvalRequested,
        approval_id: approval?.approval_id ?? null,
        approval_status: approval?.status ?? null,
        resolved_at: approval?.resolved_at ?? null,
        recovery_attempted: recovery !== null,
        recovery_result: recovery?.recovery_result ?? null,
        recovery_class: recovery?.recovery_class ?? null,
        recovery_strategy: recovery?.recovery_strategy ?? null,
      });

      replayRecords.push({
        run_id: row.run_id,
        action_id: actionId,
        evaluated_at: evaluatedAt,
        action_family: actionFamily,
        recorded_decision: decision,
        approval_status: approval?.status ?? null,
        confidence_score: confidenceScore,
        low_confidence_threshold: lowConfidenceThreshold,
        confidence_triggered: confidenceTriggered,
        action,
      });
    }

    const sortByEvaluatedAtDesc = <T extends { evaluated_at: string; run_id: string; action_id: string }>(
      left: T,
      right: T,
    ): number => {
      const timeDelta = Date.parse(right.evaluated_at) - Date.parse(left.evaluated_at);
      if (!Number.isNaN(timeDelta) && timeDelta !== 0) {
        return timeDelta;
      }
      return policyEvidenceKey(left.run_id, left.action_id).localeCompare(
        policyEvidenceKey(right.run_id, right.action_id),
      );
    };

    return {
      samples: samples.sort(sortByEvaluatedAtDesc),
      replay_records: replayRecords.sort(sortByEvaluatedAtDesc),
    };
  }

  getPolicyCalibrationReport(
    filters: {
      run_id?: string;
      include_samples?: boolean;
      sample_limit?: number | null;
    } = {},
  ): GetPolicyCalibrationReportResponsePayload {
    try {
      if (filters.run_id && !this.getRunSummary(filters.run_id)) {
        throw new NotFoundError(`No run found for ${filters.run_id}.`, { run_id: filters.run_id });
      }

      const includeSamples = filters.include_samples ?? false;
      const sampleLimit = includeSamples ? (filters.sample_limit ?? 200) : null;
      const { samples } = this.buildPolicyCalibrationEvidence({
        run_id: filters.run_id,
      });
      const sortedSamples = samples;

      const totalsDecisionCounts = emptyCalibrationDecisionCounts();
      const totalsApprovalCounts = emptyCalibrationApprovalCounts();
      let confidenceSum = 0;
      let confidenceCount = 0;
      let confidenceMin: number | null = null;
      let confidenceMax: number | null = null;
      let recoveryAttemptedCount = 0;

      const familyAccumulators = new Map<
        string,
        {
          sample_count: number;
          decisions: PolicyCalibrationDecisionCounts;
          approvals: PolicyCalibrationApprovalCounts;
          confidence_sum: number;
          confidence_count: number;
          confidence_min: number | null;
          confidence_max: number | null;
          snapshot_classes: Map<string, number>;
          matched_rules: Map<string, number>;
          reason_codes: Map<string, number>;
          recovery_attempted_count: number;
          samples: PolicyCalibrationSample[];
        }
      >();

      for (const sample of samples) {
        updateCalibrationDecisionCounts(totalsDecisionCounts, sample.decision);
        updateCalibrationApprovalCounts(totalsApprovalCounts, sample);

        confidenceSum += sample.confidence_score;
        confidenceCount += 1;
        confidenceMin =
          confidenceMin === null ? sample.confidence_score : Math.min(confidenceMin, sample.confidence_score);
        confidenceMax =
          confidenceMax === null ? sample.confidence_score : Math.max(confidenceMax, sample.confidence_score);
        if (sample.recovery_attempted) {
          recoveryAttemptedCount += 1;
        }

        const accumulator =
          familyAccumulators.get(sample.action_family) ??
          (() => {
            const created = {
              sample_count: 0,
              decisions: emptyCalibrationDecisionCounts(),
              approvals: emptyCalibrationApprovalCounts(),
              confidence_sum: 0,
              confidence_count: 0,
              confidence_min: null as number | null,
              confidence_max: null as number | null,
              snapshot_classes: new Map<string, number>(),
              matched_rules: new Map<string, number>(),
              reason_codes: new Map<string, number>(),
              recovery_attempted_count: 0,
              samples: [] as PolicyCalibrationSample[],
            };
            familyAccumulators.set(sample.action_family, created);
            return created;
          })();

        accumulator.sample_count += 1;
        accumulator.samples.push(sample);
        updateCalibrationDecisionCounts(accumulator.decisions, sample.decision);
        updateCalibrationApprovalCounts(accumulator.approvals, sample);
        accumulator.confidence_sum += sample.confidence_score;
        accumulator.confidence_count += 1;
        accumulator.confidence_min =
          accumulator.confidence_min === null
            ? sample.confidence_score
            : Math.min(accumulator.confidence_min, sample.confidence_score);
        accumulator.confidence_max =
          accumulator.confidence_max === null
            ? sample.confidence_score
            : Math.max(accumulator.confidence_max, sample.confidence_score);
        if (sample.recovery_attempted) {
          accumulator.recovery_attempted_count += 1;
        }
        incrementCalibrationCount(accumulator.snapshot_classes, sample.snapshot_class);
        for (const ruleId of sample.matched_rules) {
          incrementCalibrationCount(accumulator.matched_rules, ruleId);
        }
        for (const reasonCode of sample.reason_codes) {
          incrementCalibrationCount(accumulator.reason_codes, reasonCode);
        }
      }

      const actionFamilies: PolicyCalibrationActionFamilyBucket[] = [...familyAccumulators.entries()]
        .map(([action_family, accumulator]) => ({
          action_family,
          sample_count: accumulator.sample_count,
          confidence: finalizeCalibrationConfidenceStats(
            accumulator.confidence_sum,
            accumulator.confidence_count,
            accumulator.confidence_min,
            accumulator.confidence_max,
          ),
          decisions: accumulator.decisions,
          approvals: accumulator.approvals,
          snapshot_classes: finalizeCalibrationCounts(accumulator.snapshot_classes),
          top_matched_rules: finalizeCalibrationCounts(accumulator.matched_rules),
          top_reason_codes: finalizeCalibrationCounts(accumulator.reason_codes),
          recovery_attempted_count: accumulator.recovery_attempted_count,
          approval_rate:
            accumulator.sample_count > 0
              ? Number((accumulator.approvals.requested / accumulator.sample_count).toFixed(6))
              : null,
          denial_rate:
            accumulator.approvals.requested > 0
              ? Number((accumulator.approvals.denied / accumulator.approvals.requested).toFixed(6))
              : null,
          calibration: buildCalibrationQuality(accumulator.samples),
        }))
        .sort((left, right) => {
          if (right.sample_count !== left.sample_count) {
            return right.sample_count - left.sample_count;
          }
          return left.action_family.localeCompare(right.action_family);
        });

      const report = {
        generated_at: new Date().toISOString(),
        filters: {
          run_id: filters.run_id ?? null,
          include_samples: includeSamples,
          sample_limit: sampleLimit,
        },
        totals: {
          sample_count: samples.length,
          unique_action_families: actionFamilies.length,
          confidence: finalizeCalibrationConfidenceStats(confidenceSum, confidenceCount, confidenceMin, confidenceMax),
          decisions: totalsDecisionCounts,
          approvals: totalsApprovalCounts,
          recovery_attempted_count: recoveryAttemptedCount,
          calibration: buildCalibrationQuality(samples),
        },
        action_families: actionFamilies,
        samples: includeSamples ? sortedSamples.slice(0, sampleLimit ?? sortedSamples.length) : undefined,
        samples_truncated: includeSamples && sampleLimit !== null ? sortedSamples.length > sampleLimit : false,
      } satisfies GetPolicyCalibrationReportResponsePayload["report"];

      return {
        report,
      };
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }

      throw new InternalError("Failed to build policy calibration report.", {
        cause: error instanceof Error ? error.message : String(error),
        run_id: filters.run_id ?? null,
      });
    }
  }

  getPolicyThresholdReplayRecords(filters: { run_id?: string } = {}): PolicyReplayRecord[] {
    try {
      if (filters.run_id && !this.getRunSummary(filters.run_id)) {
        throw new NotFoundError(`No run found for ${filters.run_id}.`, { run_id: filters.run_id });
      }

      return this.buildPolicyCalibrationEvidence({
        run_id: filters.run_id,
      }).replay_records;
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }

      throw new InternalError("Failed to load policy threshold replay records.", {
        cause: error instanceof Error ? error.message : String(error),
        run_id: filters.run_id ?? null,
      });
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch (error) {
      throw new InternalError("Failed to close run journal.", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function createRunJournal(options: RunJournalOptions): RunJournal {
  return new RunJournal(options);
}

function normalizeBudgetConfig(data: Record<string, unknown>): RunSummary["budget_config"] {
  return {
    max_mutating_actions:
      typeof data.max_mutating_actions === "number" && Number.isInteger(data.max_mutating_actions)
        ? data.max_mutating_actions
        : null,
    max_destructive_actions:
      typeof data.max_destructive_actions === "number" && Number.isInteger(data.max_destructive_actions)
        ? data.max_destructive_actions
        : null,
  };
}
