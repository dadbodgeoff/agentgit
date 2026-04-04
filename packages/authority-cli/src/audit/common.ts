import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { type AuthorityClient } from "@agentgit/authority-sdk";

type RunSummaryResult = Awaited<ReturnType<AuthorityClient["getRunSummary"]>>;
type TimelineResult = Awaited<ReturnType<AuthorityClient["queryTimeline"]>>;
type ListApprovalsResult = Awaited<ReturnType<AuthorityClient["listApprovals"]>>;
type ApprovalInboxResult = Awaited<ReturnType<AuthorityClient["queryApprovalInbox"]>>;
type DiagnosticsResult = Awaited<ReturnType<AuthorityClient["diagnostics"]>>;
type ArtifactResult = Awaited<ReturnType<AuthorityClient["queryArtifact"]>>;

type AuditBundleManifestVersion = "agentgit.run-audit-bundle.v2";
type AuditShareManifestVersion = "agentgit.run-audit-share.v1";

export const RUN_AUDIT_BUNDLE_MANIFEST_VERSION: AuditBundleManifestVersion = "agentgit.run-audit-bundle.v2";
export const RUN_AUDIT_SHARE_MANIFEST_VERSION: AuditShareManifestVersion = "agentgit.run-audit-share.v1";
export const REQUIRED_AUDIT_BUNDLE_FILES = [
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
] as const;
export const AUDIT_SHARE_REPORT_FILES = [
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
] as const;

export type { ApprovalInboxResult, ArtifactResult, DiagnosticsResult, ListApprovalsResult, RunSummaryResult, TimelineResult };

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

export interface RunAuditBundleManifest {
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

export interface LoadedAuditBundle {
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

export function ensurePathDoesNotExist(targetPath: string, commandName: string): void {
  if (fs.existsSync(targetPath)) {
    throw new Error(`${commandName} refuses to overwrite existing path: ${targetPath}`);
  }
}

export function writeJsonFile(targetPath: string, value: unknown): void {
  fs.writeFileSync(targetPath, JSON.stringify(value, null, 2), "utf8");
}

export function readJsonFile<T>(targetPath: string): T {
  return JSON.parse(fs.readFileSync(targetPath, "utf8")) as T;
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeFileComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export function copyFileAndTrack(sourcePath: string, targetPath: string, copiedFiles: string[]): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  copiedFiles.push(targetPath);
}
