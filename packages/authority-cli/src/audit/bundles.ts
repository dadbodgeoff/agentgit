import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { AuthorityClient, AuthorityDaemonResponseError } from "@agentgit/authority-sdk";

import { inputError, ioError } from "../cli-contract.js";

type RunSummaryResult = Awaited<ReturnType<AuthorityClient["getRunSummary"]>>;
type TimelineResult = Awaited<ReturnType<AuthorityClient["queryTimeline"]>>;
type ListApprovalsResult = Awaited<ReturnType<AuthorityClient["listApprovals"]>>;
type ApprovalInboxResult = Awaited<ReturnType<AuthorityClient["queryApprovalInbox"]>>;
type DiagnosticsResult = Awaited<ReturnType<AuthorityClient["diagnostics"]>>;
type ArtifactResult = Awaited<ReturnType<AuthorityClient["queryArtifact"]>>;

type AuditBundleManifestVersion = "agentgit.run-audit-bundle.v2";
type AuditShareManifestVersion = "agentgit.run-audit-share.v1";

const RUN_AUDIT_BUNDLE_MANIFEST_VERSION: AuditBundleManifestVersion = "agentgit.run-audit-bundle.v2";
const RUN_AUDIT_SHARE_MANIFEST_VERSION: AuditShareManifestVersion = "agentgit.run-audit-share.v1";

export interface ArtifactExportResult {
  artifact_id: string;
  output_path: string;
  bytes_written: number;
  visibility_scope: ArtifactResult["visibility_scope"];
  artifact_status: ArtifactResult["artifact_status"];
  integrity_digest: string | null;
}

export interface RunAuditExportedArtifact {
  artifact_id: string;
  type: string;
  output_path: string;
  relative_path: string;
  bytes_written: number;
  visibility_scope: ArtifactResult["visibility_scope"];
  sha256: string;
  integrity_digest: string | null;
}

export interface RunAuditSkippedArtifact {
  artifact_id: string;
  type: string;
  reason: string;
  artifact_status: ArtifactResult["artifact_status"] | "not_found";
}

export interface RunAuditExportResult {
  run_id: string;
  output_dir: string;
  manifest_version: string;
  visibility_scope: TimelineResult["visibility_scope"];
  files_written: string[];
  exported_artifacts: RunAuditExportedArtifact[];
  skipped_artifacts: RunAuditSkippedArtifact[];
}

export interface RunAuditVerifyIssue {
  code:
    | "MANIFEST_MISSING"
    | "MANIFEST_INVALID"
    | "MISSING_BUNDLE_FILE"
    | "MISSING_ARTIFACT_FILE"
    | "ARTIFACT_SIZE_MISMATCH"
    | "ARTIFACT_SHA256_MISMATCH"
    | "ARTIFACT_INTEGRITY_MISMATCH";
  message: string;
  file_path?: string;
  artifact_id?: string;
}

export interface RunAuditVerifyResult {
  run_id: string;
  output_dir: string;
  manifest_version: string | null;
  verified: boolean;
  files_checked: number;
  exported_artifacts_checked: number;
  issues: RunAuditVerifyIssue[];
}

export interface RunAuditReportResult {
  run_id: string;
  bundle_dir: string;
  manifest_version: string | null;
  visibility_scope: TimelineResult["visibility_scope"] | "unknown";
  exported_at: string | null;
  verified: boolean;
  verification_issue_count: number;
  run_summary: {
    workflow_name: string | null;
    session_id: string | null;
    event_count: number | null;
    action_count: number | null;
    approval_count: number | null;
    created_at: string | null;
    started_at: string | null;
  };
  timeline: {
    step_count: number;
    approvals_required: number;
    approvals_resolved: number;
    reversible_step_count: number;
    external_effect_step_count: number;
  };
  artifacts: {
    exported_count: number;
    skipped_count: number;
    available_exported_count: number;
    missing_or_withheld_count: number;
  };
}

export interface RunAuditCompareDifference {
  code:
    | "RUN_ID_CHANGED"
    | "VISIBILITY_SCOPE_CHANGED"
    | "EVENT_COUNT_CHANGED"
    | "ACTION_COUNT_CHANGED"
    | "TIMELINE_STEP_COUNT_CHANGED"
    | "APPROVAL_COUNT_CHANGED"
    | "APPROVAL_INBOX_COUNT_CHANGED"
    | "EXPORTED_ARTIFACT_ADDED"
    | "EXPORTED_ARTIFACT_REMOVED"
    | "EXPORTED_ARTIFACT_DIGEST_CHANGED"
    | "SKIPPED_ARTIFACT_ADDED"
    | "SKIPPED_ARTIFACT_REMOVED"
    | "DIAGNOSTICS_CHANGED"
    | "VERIFICATION_STATUS_CHANGED";
  message: string;
  artifact_id?: string;
  left_value?: unknown;
  right_value?: unknown;
}

export interface RunAuditCompareResult {
  left_bundle_dir: string;
  right_bundle_dir: string;
  left_run_id: string;
  right_run_id: string;
  left_manifest_version: string | null;
  right_manifest_version: string | null;
  left_verified: boolean;
  right_verified: boolean;
  comparable: boolean;
  differences: RunAuditCompareDifference[];
}

export interface RunAuditShareArtifactRecord {
  artifact_id: string;
  type: string;
  relative_path: string;
  output_path: string;
}

export interface RunAuditShareResult {
  run_id: string;
  source_bundle_dir: string;
  output_dir: string;
  manifest_version: string;
  include_artifact_content: boolean;
  copied_files: string[];
  copied_artifacts: RunAuditShareArtifactRecord[];
  withheld_artifacts: Array<{
    artifact_id: string;
    type: string;
    reason: string;
    relative_path: string;
  }>;
}

interface RunAuditBundleManifest {
  manifest_version?: string;
  run_id?: string;
  output_dir?: string;
  visibility_scope?: TimelineResult["visibility_scope"];
  exported_at?: string;
  files_written?: string[];
  exported_artifacts?: RunAuditExportedArtifact[];
  skipped_artifacts?: RunAuditSkippedArtifact[];
  counts?: {
    timeline_steps?: number;
    approvals?: number;
    approval_inbox_items?: number;
    exported_artifacts?: number;
    skipped_artifacts?: number;
  };
}

interface LoadedAuditBundle {
  manifest: RunAuditBundleManifest;
  manifest_version: string | null;
  run_id: string;
  bundle_dir: string;
  run_summary: RunSummaryResult | null;
  timeline: TimelineResult | null;
  approvals: ListApprovalsResult | null;
  approval_inbox: ApprovalInboxResult | null;
  diagnostics: DiagnosticsResult | null;
  verify_result: RunAuditVerifyResult;
}

export interface AuditBundleFormatterDeps {
  formatApprovalInbox: (result: ApprovalInboxResult) => string;
  formatApprovalList: (result: ListApprovalsResult) => string;
  formatDiagnostics: (result: DiagnosticsResult) => string;
  formatRunSummary: (result: RunSummaryResult) => string;
  formatTimeline: (result: TimelineResult) => string;
}

function ensurePathDoesNotExist(targetPath: string, commandName: string): void {
  if (fs.existsSync(targetPath)) {
    throw new Error(`${commandName} refuses to overwrite existing path: ${targetPath}`);
  }
}

function writeJsonFile(targetPath: string, value: unknown): void {
  fs.writeFileSync(targetPath, JSON.stringify(value, null, 2), "utf8");
}

function readJsonFile<T>(targetPath: string): T {
  return JSON.parse(fs.readFileSync(targetPath, "utf8")) as T;
}

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeFileComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function copyFileAndTrack(sourcePath: string, targetPath: string, copiedFiles: string[]): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  copiedFiles.push(targetPath);
}

export async function exportArtifactContent(
  client: AuthorityClient,
  artifactId: string,
  destinationPath: string,
  visibilityScope?: ArtifactResult["visibility_scope"],
): Promise<ArtifactExportResult> {
  const result = await client.queryArtifact(artifactId, visibilityScope, {
    fullContent: true,
  });

  if (!result.content_available) {
    throw ioError(`Artifact ${artifactId} content is not available for export (${result.artifact_status}).`);
  }

  if (result.content_truncated) {
    throw ioError(`Artifact ${artifactId} export returned truncated content; export aborted.`);
  }

  if (fs.existsSync(destinationPath)) {
    throw ioError(`artifact-export refuses to overwrite existing file: ${destinationPath}`);
  }

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.writeFileSync(destinationPath, result.content, "utf8");

  return {
    artifact_id: artifactId,
    output_path: destinationPath,
    bytes_written: Buffer.byteLength(result.content, "utf8"),
    visibility_scope: result.visibility_scope,
    artifact_status: result.artifact_status,
    integrity_digest: result.artifact.integrity.digest,
  };
}

export async function exportRunAuditBundle(
  client: AuthorityClient,
  runId: string,
  outputDir: string,
  visibilityScope: TimelineResult["visibility_scope"],
  formatters: AuditBundleFormatterDeps,
): Promise<RunAuditExportResult> {
  const runSummary = await client.getRunSummary(runId);
  const timeline = await client.queryTimeline(runId, visibilityScope);
  const approvals = await client.listApprovals({ run_id: runId });
  const approvalInbox = await client.queryApprovalInbox({ run_id: runId });
  const diagnostics = await client.diagnostics([
    "daemon_health",
    "journal_health",
    "maintenance_backlog",
    "projection_lag",
    "storage_summary",
    "capability_summary",
  ]);

  ensurePathDoesNotExist(outputDir, "run-audit-export");
  fs.mkdirSync(outputDir, { recursive: true });
  const artifactsDir = path.join(outputDir, "artifacts");
  fs.mkdirSync(artifactsDir, { recursive: true });

  const filesWritten: string[] = [];
  const writeAuditFile = (fileName: string, content: string): void => {
    const targetPath = path.join(outputDir, fileName);
    fs.writeFileSync(targetPath, content, "utf8");
    filesWritten.push(targetPath);
  };

  writeAuditFile("run-summary.json", JSON.stringify(runSummary, null, 2));
  writeAuditFile("run-summary.txt", formatters.formatRunSummary(runSummary));
  writeAuditFile("timeline.json", JSON.stringify(timeline, null, 2));
  writeAuditFile("timeline.txt", formatters.formatTimeline(timeline));
  writeAuditFile("approvals.json", JSON.stringify(approvals, null, 2));
  writeAuditFile("approvals.txt", formatters.formatApprovalList(approvals));
  writeAuditFile("approval-inbox.json", JSON.stringify(approvalInbox, null, 2));
  writeAuditFile("approval-inbox.txt", formatters.formatApprovalInbox(approvalInbox));
  writeAuditFile("diagnostics.json", JSON.stringify(diagnostics, null, 2));
  writeAuditFile("diagnostics.txt", formatters.formatDiagnostics(diagnostics));

  const seenArtifactIds = new Set<string>();
  const exportedArtifacts: RunAuditExportedArtifact[] = [];
  const skippedArtifacts: RunAuditSkippedArtifact[] = [];

  for (const step of timeline.steps) {
    for (const artifact of step.primary_artifacts) {
      if (typeof artifact.artifact_id !== "string" || seenArtifactIds.has(artifact.artifact_id)) {
        continue;
      }
      seenArtifactIds.add(artifact.artifact_id);

      try {
        const artifactResult = await client.queryArtifact(artifact.artifact_id, visibilityScope, {
          fullContent: true,
        });

        if (artifactResult.content_truncated) {
          throw new Error(
            `Artifact ${artifact.artifact_id} export returned truncated content even though full export was requested.`,
          );
        }

        if (!artifactResult.content_available) {
          skippedArtifacts.push({
            artifact_id: artifact.artifact_id,
            type: artifact.type,
            reason: "artifact content is not durably available",
            artifact_status: artifactResult.artifact_status,
          });
          continue;
        }

        const artifactPath = path.join(
          artifactsDir,
          `${safeFileComponent(artifact.artifact_id)}.${safeFileComponent(artifact.type)}.txt`,
        );
        fs.writeFileSync(artifactPath, artifactResult.content, "utf8");
        filesWritten.push(artifactPath);
        const contentSha256 = sha256Hex(artifactResult.content);
        exportedArtifacts.push({
          artifact_id: artifact.artifact_id,
          type: artifact.type,
          output_path: artifactPath,
          relative_path: path.relative(outputDir, artifactPath),
          bytes_written: Buffer.byteLength(artifactResult.content, "utf8"),
          visibility_scope: artifactResult.visibility_scope,
          sha256: contentSha256,
          integrity_digest: artifactResult.artifact.integrity.digest,
        });
      } catch (error) {
        if (error instanceof AuthorityDaemonResponseError && error.code === "NOT_FOUND") {
          skippedArtifacts.push({
            artifact_id: artifact.artifact_id,
            type: artifact.type,
            reason: error.message,
            artifact_status: "not_found",
          });
          continue;
        }

        throw error;
      }
    }
  }

  const manifestPath = path.join(outputDir, "manifest.json");
  writeJsonFile(manifestPath, {
    manifest_version: RUN_AUDIT_BUNDLE_MANIFEST_VERSION,
    run_id: runId,
    output_dir: outputDir,
    visibility_scope: visibilityScope,
    exported_at: new Date().toISOString(),
    files_written: filesWritten,
    exported_artifacts: exportedArtifacts,
    skipped_artifacts: skippedArtifacts,
    counts: {
      timeline_steps: timeline.steps.length,
      approvals: approvals.approvals.length,
      approval_inbox_items: approvalInbox.items.length,
      exported_artifacts: exportedArtifacts.length,
      skipped_artifacts: skippedArtifacts.length,
    },
  });
  filesWritten.push(manifestPath);

  return {
    run_id: runId,
    output_dir: outputDir,
    manifest_version: RUN_AUDIT_BUNDLE_MANIFEST_VERSION,
    visibility_scope: visibilityScope,
    files_written: filesWritten,
    exported_artifacts: exportedArtifacts,
    skipped_artifacts: skippedArtifacts,
  };
}

export function verifyRunAuditBundle(outputDir: string): RunAuditVerifyResult {
  const manifestPath = path.join(outputDir, "manifest.json");
  const issues: RunAuditVerifyIssue[] = [];
  const requiredBundleFiles = [
    "manifest.json",
    "run-summary.json",
    "run-summary.txt",
    "timeline.json",
    "timeline.txt",
    "approvals.json",
    "approvals.txt",
    "approval-inbox.json",
    "approval-inbox.txt",
    "diagnostics.json",
    "diagnostics.txt",
  ];

  let filesChecked = 0;
  for (const fileName of requiredBundleFiles) {
    filesChecked += 1;
    const targetPath = path.join(outputDir, fileName);
    if (!fs.existsSync(targetPath)) {
      issues.push({
        code: "MISSING_BUNDLE_FILE",
        message: `Required audit bundle file is missing: ${fileName}`,
        file_path: targetPath,
      });
    }
  }

  if (!fs.existsSync(manifestPath)) {
    return {
      run_id: "unknown",
      output_dir: outputDir,
      manifest_version: null,
      verified: false,
      files_checked: filesChecked,
      exported_artifacts_checked: 0,
      issues: [
        {
          code: "MANIFEST_MISSING",
          message: "Audit bundle manifest.json is missing.",
          file_path: manifestPath,
        },
        ...issues,
      ],
    };
  }

  let manifest: {
    run_id?: unknown;
    manifest_version?: unknown;
    exported_artifacts?: unknown;
  };
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      run_id?: unknown;
      manifest_version?: unknown;
      exported_artifacts?: unknown;
    };
  } catch (error) {
    return {
      run_id: "unknown",
      output_dir: outputDir,
      manifest_version: null,
      verified: false,
      files_checked: filesChecked,
      exported_artifacts_checked: 0,
      issues: [
        {
          code: "MANIFEST_INVALID",
          message: error instanceof Error ? error.message : String(error),
          file_path: manifestPath,
        },
        ...issues,
      ],
    };
  }

  const runId = typeof manifest.run_id === "string" ? manifest.run_id : "unknown";
  const manifestVersion = typeof manifest.manifest_version === "string" ? manifest.manifest_version : null;
  const exportedArtifacts = Array.isArray(manifest.exported_artifacts) ? manifest.exported_artifacts : [];
  let exportedArtifactsChecked = 0;

  for (const record of exportedArtifacts) {
    if (!record || typeof record !== "object") {
      continue;
    }

    const artifact = record as Partial<RunAuditExportedArtifact>;
    if (typeof artifact.artifact_id !== "string" || typeof artifact.type !== "string") {
      continue;
    }

    exportedArtifactsChecked += 1;
    filesChecked += 1;
    const artifactPath =
      typeof artifact.relative_path === "string"
        ? path.resolve(outputDir, artifact.relative_path)
        : typeof artifact.output_path === "string"
          ? artifact.output_path
          : null;

    if (!artifactPath || !fs.existsSync(artifactPath)) {
      issues.push({
        code: "MISSING_ARTIFACT_FILE",
        artifact_id: artifact.artifact_id,
        message: `Exported artifact file is missing for ${artifact.artifact_id}.`,
        file_path: artifactPath ?? undefined,
      });
      continue;
    }

    const content = fs.readFileSync(artifactPath);
    if (typeof artifact.bytes_written === "number" && content.byteLength !== artifact.bytes_written) {
      issues.push({
        code: "ARTIFACT_SIZE_MISMATCH",
        artifact_id: artifact.artifact_id,
        message: `Expected ${artifact.bytes_written} bytes but found ${content.byteLength}.`,
        file_path: artifactPath,
      });
    }

    const digest = sha256Hex(content);
    if (typeof artifact.sha256 === "string" && digest !== artifact.sha256) {
      issues.push({
        code: "ARTIFACT_SHA256_MISMATCH",
        artifact_id: artifact.artifact_id,
        message: `Expected SHA256 ${artifact.sha256} but found ${digest}.`,
        file_path: artifactPath,
      });
    }

    if (typeof artifact.integrity_digest === "string" && digest !== artifact.integrity_digest) {
      issues.push({
        code: "ARTIFACT_INTEGRITY_MISMATCH",
        artifact_id: artifact.artifact_id,
        message: `Expected integrity digest ${artifact.integrity_digest} but found ${digest}.`,
        file_path: artifactPath,
      });
    }
  }

  return {
    run_id: runId,
    output_dir: outputDir,
    manifest_version: manifestVersion,
    verified: issues.length === 0,
    files_checked: filesChecked,
    exported_artifacts_checked: exportedArtifactsChecked,
    issues,
  };
}

function loadRunAuditBundle(outputDir: string): LoadedAuditBundle {
  const verifyResult = verifyRunAuditBundle(outputDir);
  const manifestPath = path.join(outputDir, "manifest.json");
  const manifest = fs.existsSync(manifestPath) ? readJsonFile<RunAuditBundleManifest>(manifestPath) : {};
  const runId = typeof manifest.run_id === "string" ? manifest.run_id : verifyResult.run_id;
  const readOptional = <T>(fileName: string): T | null => {
    const targetPath = path.join(outputDir, fileName);
    if (!fs.existsSync(targetPath)) {
      return null;
    }

    return readJsonFile<T>(targetPath);
  };

  return {
    manifest,
    manifest_version: typeof manifest.manifest_version === "string" ? manifest.manifest_version : null,
    run_id: runId,
    bundle_dir: outputDir,
    run_summary: readOptional<RunSummaryResult>("run-summary.json"),
    timeline: readOptional<TimelineResult>("timeline.json"),
    approvals: readOptional<ListApprovalsResult>("approvals.json"),
    approval_inbox: readOptional<ApprovalInboxResult>("approval-inbox.json"),
    diagnostics: readOptional<DiagnosticsResult>("diagnostics.json"),
    verify_result: verifyResult,
  };
}

export function createRunAuditReport(outputDir: string): RunAuditReportResult {
  const bundle = loadRunAuditBundle(outputDir);
  const timelineSteps = bundle.timeline?.steps ?? [];
  const exportedArtifacts = Array.isArray(bundle.manifest.exported_artifacts) ? bundle.manifest.exported_artifacts : [];
  const skippedArtifacts = Array.isArray(bundle.manifest.skipped_artifacts) ? bundle.manifest.skipped_artifacts : [];
  const actionCount = timelineSteps.length;
  const approvalCount = bundle.approvals?.approvals.length ?? null;

  return {
    run_id: bundle.run_id,
    bundle_dir: outputDir,
    manifest_version: bundle.manifest_version,
    visibility_scope:
      bundle.timeline?.visibility_scope ??
      (typeof bundle.manifest.visibility_scope === "string" ? bundle.manifest.visibility_scope : "unknown"),
    exported_at: typeof bundle.manifest.exported_at === "string" ? bundle.manifest.exported_at : null,
    verified: bundle.verify_result.verified,
    verification_issue_count: bundle.verify_result.issues.length,
    run_summary: {
      workflow_name: bundle.run_summary?.run.workflow_name ?? null,
      session_id: bundle.run_summary?.run.session_id ?? null,
      event_count: bundle.run_summary?.run.event_count ?? null,
      action_count: actionCount,
      approval_count: approvalCount,
      created_at: bundle.run_summary?.run.created_at ?? null,
      started_at: bundle.run_summary?.run.started_at ?? null,
    },
    timeline: {
      step_count: timelineSteps.length,
      approvals_required:
        bundle.approval_inbox?.counts.pending ??
        timelineSteps.filter((step) => step.status === "awaiting_approval").length,
      approvals_resolved:
        bundle.approval_inbox?.counts.approved !== undefined && bundle.approval_inbox?.counts.denied !== undefined
          ? bundle.approval_inbox.counts.approved + bundle.approval_inbox.counts.denied
          : 0,
      reversible_step_count: timelineSteps.filter((step) => step.reversibility_class !== "irreversible").length,
      external_effect_step_count: timelineSteps.filter((step) => step.external_effects.length > 0).length,
    },
    artifacts: {
      exported_count: exportedArtifacts.length,
      skipped_count: skippedArtifacts.length,
      available_exported_count: exportedArtifacts.length,
      missing_or_withheld_count: skippedArtifacts.length,
    },
  };
}

function compareAuditArtifactRecords(
  leftArtifacts: RunAuditExportedArtifact[],
  rightArtifacts: RunAuditExportedArtifact[],
): RunAuditCompareDifference[] {
  const differences: RunAuditCompareDifference[] = [];
  const normalizedRelativePath = (artifact: RunAuditExportedArtifact) => {
    const baseName = path.basename(artifact.relative_path);
    return baseName.replace(/^[^.]+\./, "");
  };
  const signatureFor = (artifact: RunAuditExportedArtifact) =>
    `${artifact.type}:${artifact.visibility_scope}:${normalizedRelativePath(artifact)}`;
  const groupBySignature = (artifacts: RunAuditExportedArtifact[]) => {
    const grouped = new Map<string, RunAuditExportedArtifact[]>();
    for (const artifact of artifacts) {
      const signature = signatureFor(artifact);
      const existing = grouped.get(signature);
      if (existing) {
        existing.push(artifact);
      } else {
        grouped.set(signature, [artifact]);
      }
    }
    return grouped;
  };
  const sortArtifacts = (artifacts: RunAuditExportedArtifact[]) =>
    [...artifacts].sort((left, right) =>
      `${left.sha256}:${left.integrity_digest ?? ""}:${left.artifact_id}`.localeCompare(
        `${right.sha256}:${right.integrity_digest ?? ""}:${right.artifact_id}`,
      ),
    );
  const leftBySignature = groupBySignature(leftArtifacts);
  const rightBySignature = groupBySignature(rightArtifacts);

  for (const [signature, leftGroup] of leftBySignature) {
    const rightGroup = rightBySignature.get(signature) ?? [];
    const sortedLeft = sortArtifacts(leftGroup);
    const sortedRight = sortArtifacts(rightGroup);
    const comparableCount = Math.min(sortedLeft.length, sortedRight.length);

    for (let index = 0; index < comparableCount; index += 1) {
      const artifact = sortedLeft[index]!;
      const other = sortedRight[index]!;
      if (artifact.sha256 !== other.sha256 || artifact.integrity_digest !== other.integrity_digest) {
        differences.push({
          code: "EXPORTED_ARTIFACT_DIGEST_CHANGED",
          artifact_id: artifact.artifact_id,
          message: `Exported artifact ${signature} changed digest between bundles.`,
          left_value: {
            artifact_id: artifact.artifact_id,
            sha256: artifact.sha256,
            integrity_digest: artifact.integrity_digest,
          },
          right_value: {
            artifact_id: other.artifact_id,
            sha256: other.sha256,
            integrity_digest: other.integrity_digest,
          },
        });
      }
    }

    for (const artifact of sortedLeft.slice(comparableCount)) {
      differences.push({
        code: "EXPORTED_ARTIFACT_REMOVED",
        artifact_id: artifact.artifact_id,
        message: `Artifact ${artifact.artifact_id} was exported in the left bundle but not the right bundle.`,
      });
    }
    for (const artifact of sortedRight.slice(comparableCount)) {
      differences.push({
        code: "EXPORTED_ARTIFACT_ADDED",
        artifact_id: artifact.artifact_id,
        message: `Artifact ${artifact.artifact_id} was exported in the right bundle but not the left bundle.`,
      });
    }
  }

  for (const [signature, rightGroup] of rightBySignature) {
    if (leftBySignature.has(signature)) {
      continue;
    }

    for (const artifact of rightGroup) {
      differences.push({
        code: "EXPORTED_ARTIFACT_ADDED",
        artifact_id: artifact.artifact_id,
        message: `Artifact ${artifact.artifact_id} was exported in the right bundle but not the left bundle.`,
      });
    }
  }

  return differences;
}

function compareAuditSkippedArtifactRecords(
  leftArtifacts: RunAuditSkippedArtifact[],
  rightArtifacts: RunAuditSkippedArtifact[],
): RunAuditCompareDifference[] {
  const differences: RunAuditCompareDifference[] = [];
  const serialize = (artifact: RunAuditSkippedArtifact) =>
    `${artifact.artifact_id}:${artifact.type}:${artifact.artifact_status}:${artifact.reason}`;
  const leftSet = new Set(leftArtifacts.map(serialize));
  const rightSet = new Set(rightArtifacts.map(serialize));

  for (const artifact of leftArtifacts) {
    const encoded = serialize(artifact);
    if (!rightSet.has(encoded)) {
      differences.push({
        code: "SKIPPED_ARTIFACT_REMOVED",
        artifact_id: artifact.artifact_id,
        message: `Skipped artifact ${artifact.artifact_id} no longer appears in the right bundle.`,
      });
    }
  }

  for (const artifact of rightArtifacts) {
    const encoded = serialize(artifact);
    if (!leftSet.has(encoded)) {
      differences.push({
        code: "SKIPPED_ARTIFACT_ADDED",
        artifact_id: artifact.artifact_id,
        message: `Skipped artifact ${artifact.artifact_id} appears in the right bundle but not the left bundle.`,
      });
    }
  }

  return differences;
}

export function compareRunAuditBundles(leftOutputDir: string, rightOutputDir: string): RunAuditCompareResult {
  const leftBundle = loadRunAuditBundle(leftOutputDir);
  const rightBundle = loadRunAuditBundle(rightOutputDir);
  const differences: RunAuditCompareDifference[] = [];
  const leftActionCount = leftBundle.timeline?.steps.length ?? null;
  const rightActionCount = rightBundle.timeline?.steps.length ?? null;

  const compareScalar = (
    code: RunAuditCompareDifference["code"],
    message: string,
    leftValue: unknown,
    rightValue: unknown,
  ): void => {
    if (JSON.stringify(leftValue) !== JSON.stringify(rightValue)) {
      differences.push({
        code,
        message,
        left_value: leftValue,
        right_value: rightValue,
      });
    }
  };

  compareScalar("RUN_ID_CHANGED", "Run id changed between audit bundles.", leftBundle.run_id, rightBundle.run_id);
  compareScalar(
    "VISIBILITY_SCOPE_CHANGED",
    "Visibility scope changed between audit bundles.",
    leftBundle.timeline?.visibility_scope ?? leftBundle.manifest.visibility_scope ?? null,
    rightBundle.timeline?.visibility_scope ?? rightBundle.manifest.visibility_scope ?? null,
  );
  compareScalar(
    "EVENT_COUNT_CHANGED",
    "Run event count changed between audit bundles.",
    leftBundle.run_summary?.run.event_count ?? null,
    rightBundle.run_summary?.run.event_count ?? null,
  );
  compareScalar(
    "ACTION_COUNT_CHANGED",
    "Run action count changed between audit bundles.",
    leftActionCount,
    rightActionCount,
  );
  compareScalar(
    "TIMELINE_STEP_COUNT_CHANGED",
    "Timeline step count changed between audit bundles.",
    leftBundle.timeline?.steps.length ?? 0,
    rightBundle.timeline?.steps.length ?? 0,
  );
  compareScalar(
    "APPROVAL_COUNT_CHANGED",
    "Approval count changed between audit bundles.",
    leftBundle.approvals?.approvals.length ?? 0,
    rightBundle.approvals?.approvals.length ?? 0,
  );
  compareScalar(
    "APPROVAL_INBOX_COUNT_CHANGED",
    "Approval inbox item count changed between audit bundles.",
    leftBundle.approval_inbox?.items.length ?? 0,
    rightBundle.approval_inbox?.items.length ?? 0,
  );
  compareScalar(
    "VERIFICATION_STATUS_CHANGED",
    "Bundle verification status changed between audit bundles.",
    leftBundle.verify_result.verified,
    rightBundle.verify_result.verified,
  );

  differences.push(
    ...compareAuditArtifactRecords(
      Array.isArray(leftBundle.manifest.exported_artifacts) ? leftBundle.manifest.exported_artifacts : [],
      Array.isArray(rightBundle.manifest.exported_artifacts) ? rightBundle.manifest.exported_artifacts : [],
    ),
  );
  differences.push(
    ...compareAuditSkippedArtifactRecords(
      Array.isArray(leftBundle.manifest.skipped_artifacts) ? leftBundle.manifest.skipped_artifacts : [],
      Array.isArray(rightBundle.manifest.skipped_artifacts) ? rightBundle.manifest.skipped_artifacts : [],
    ),
  );

  if (JSON.stringify(leftBundle.diagnostics ?? null) !== JSON.stringify(rightBundle.diagnostics ?? null)) {
    differences.push({
      code: "DIAGNOSTICS_CHANGED",
      message: "Diagnostics payload changed between audit bundles.",
    });
  }

  return {
    left_bundle_dir: leftOutputDir,
    right_bundle_dir: rightOutputDir,
    left_run_id: leftBundle.run_id,
    right_run_id: rightBundle.run_id,
    left_manifest_version: leftBundle.manifest_version,
    right_manifest_version: rightBundle.manifest_version,
    left_verified: leftBundle.verify_result.verified,
    right_verified: rightBundle.verify_result.verified,
    comparable: true,
    differences,
  };
}

export function createRunAuditSharePackage(
  bundleDir: string,
  outputDir: string,
  includeArtifactContent: boolean,
): RunAuditShareResult {
  const bundle = loadRunAuditBundle(bundleDir);
  if (!bundle.verify_result.verified) {
    throw inputError(`run-audit-share requires a verified source bundle: ${bundleDir}`, {
      verification_issues: bundle.verify_result.issues,
    });
  }

  ensurePathDoesNotExist(outputDir, "run-audit-share");
  fs.mkdirSync(outputDir, { recursive: true });
  const copiedFiles: string[] = [];

  const reportFiles = [
    "run-summary.json",
    "run-summary.txt",
    "timeline.json",
    "timeline.txt",
    "approvals.json",
    "approvals.txt",
    "approval-inbox.json",
    "approval-inbox.txt",
    "diagnostics.json",
    "diagnostics.txt",
  ];
  for (const fileName of reportFiles) {
    const sourcePath = path.join(bundleDir, fileName);
    if (fs.existsSync(sourcePath)) {
      copyFileAndTrack(sourcePath, path.join(outputDir, fileName), copiedFiles);
    }
  }

  const copiedArtifacts: RunAuditShareArtifactRecord[] = [];
  const withheldArtifacts: RunAuditShareResult["withheld_artifacts"] = [];
  const exportedArtifacts = Array.isArray(bundle.manifest.exported_artifacts) ? bundle.manifest.exported_artifacts : [];

  for (const artifact of exportedArtifacts) {
    const relativePath = artifact.relative_path;
    const sourceArtifactPath = path.resolve(bundleDir, relativePath);
    if (includeArtifactContent) {
      const targetArtifactPath = path.join(outputDir, relativePath);
      copyFileAndTrack(sourceArtifactPath, targetArtifactPath, copiedFiles);
      copiedArtifacts.push({
        artifact_id: artifact.artifact_id,
        type: artifact.type,
        relative_path: relativePath,
        output_path: targetArtifactPath,
      });
      continue;
    }

    withheldArtifacts.push({
      artifact_id: artifact.artifact_id,
      type: artifact.type,
      reason: "artifact content omitted from share package",
      relative_path: relativePath,
    });
  }

  const shareManifest = {
    manifest_version: RUN_AUDIT_SHARE_MANIFEST_VERSION,
    source_bundle_dir: bundleDir,
    source_run_id: bundle.run_id,
    source_manifest_version: bundle.manifest_version,
    output_dir: outputDir,
    shared_at: new Date().toISOString(),
    include_artifact_content: includeArtifactContent,
    copied_files: copiedFiles,
    copied_artifacts: copiedArtifacts,
    withheld_artifacts: withheldArtifacts,
  };
  const shareManifestPath = path.join(outputDir, "share-manifest.json");
  writeJsonFile(shareManifestPath, shareManifest);
  copiedFiles.push(shareManifestPath);

  return {
    run_id: bundle.run_id,
    source_bundle_dir: bundleDir,
    output_dir: outputDir,
    manifest_version: RUN_AUDIT_SHARE_MANIFEST_VERSION,
    include_artifact_content: includeArtifactContent,
    copied_files: copiedFiles,
    copied_artifacts: copiedArtifacts,
    withheld_artifacts: withheldArtifacts,
  };
}
