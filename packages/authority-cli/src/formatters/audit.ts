import type { AuthorityClient } from "@agentgit/authority-sdk";

import type {
  ArtifactExportResult,
  RunAuditCompareResult,
  RunAuditExportResult,
  RunAuditReportResult,
  RunAuditShareResult,
  RunAuditVerifyResult,
} from "../audit/common.js";
import { bulletList, lines, maybeLine } from "./core.js";

type ArtifactResult = Awaited<ReturnType<AuthorityClient["queryArtifact"]>>;

export function formatArtifact(result: ArtifactResult): string {
  return lines(
    `Artifact ${result.artifact.artifact_id}`,
    `Type: ${result.artifact.type}`,
    `Status: ${result.artifact_status}`,
    `Visibility: ${result.visibility_scope}`,
    `Stored visibility: ${result.artifact.visibility}`,
    `Run: ${result.artifact.run_id}`,
    `Action: ${result.artifact.action_id}`,
    `Execution: ${result.artifact.execution_id}`,
    `Bytes: ${result.artifact.byte_size}`,
    `Content ref: ${result.artifact.content_ref}`,
    `Integrity: ${result.artifact.integrity.schema_version} ${result.artifact.integrity.digest_algorithm}`,
    maybeLine("Integrity digest", result.artifact.integrity.digest),
    maybeLine("Expires", result.artifact.expires_at),
    maybeLine("Expired", result.artifact.expired_at),
    `Content available: ${result.content_available ? "yes" : "no"}`,
    `Returned chars: ${result.returned_chars}/${result.max_inline_chars}`,
    `Truncated: ${result.content_truncated ? "yes" : "no"}`,
    "",
    result.content,
  );
}

export function formatArtifactExport(result: ArtifactExportResult): string {
  return lines(
    `Exported artifact ${result.artifact_id}`,
    `Output path: ${result.output_path}`,
    `Bytes written: ${result.bytes_written}`,
    `Visibility: ${result.visibility_scope}`,
    `Status: ${result.artifact_status}`,
    maybeLine("Integrity digest", result.integrity_digest),
  );
}

export function formatRunAuditExport(result: RunAuditExportResult): string {
  const exportedArtifacts =
    result.exported_artifacts.length === 0
      ? "none"
      : `\n${bulletList(
          result.exported_artifacts.map(
            (artifact) =>
              `${artifact.artifact_id} [${artifact.type}] -> ${artifact.output_path} (${artifact.bytes_written} bytes)`,
          ),
        )}`;
  const skippedArtifacts =
    result.skipped_artifacts.length === 0
      ? "none"
      : `\n${bulletList(
          result.skipped_artifacts.map(
            (artifact) => `${artifact.artifact_id} [${artifact.type}] ${artifact.artifact_status}: ${artifact.reason}`,
          ),
        )}`;

  return lines(
    `Exported run audit bundle for ${result.run_id}`,
    `Output dir: ${result.output_dir}`,
    `Visibility: ${result.visibility_scope}`,
    `Files written: ${result.files_written.length}`,
    `Artifacts exported: ${result.exported_artifacts.length}`,
    `Artifacts skipped: ${result.skipped_artifacts.length}`,
    `Exported artifacts:${exportedArtifacts}`,
    `Skipped artifacts:${skippedArtifacts}`,
  );
}

export function formatRunAuditVerify(result: RunAuditVerifyResult): string {
  const issues =
    result.issues.length === 0
      ? "none"
      : `\n${bulletList(
          result.issues.map(
            (issue) => `${issue.code}: ${issue.message}${issue.file_path ? ` [${issue.file_path}]` : ""}`,
          ),
        )}`;

  return lines(
    `Verified run audit bundle for ${result.run_id}`,
    `Output dir: ${result.output_dir}`,
    `Audit bundle verified: ${result.verified ? "yes" : "no"}`,
    `Files checked: ${result.files_checked}`,
    `Exported artifacts checked: ${result.exported_artifacts_checked}`,
    `Issues:${issues}`,
  );
}

export function formatRunAuditReport(result: RunAuditReportResult): string {
  return lines(
    `Audit report for ${result.run_id}`,
    `Bundle dir: ${result.bundle_dir}`,
    `Manifest version: ${result.manifest_version ?? "unknown"}`,
    `Visibility: ${result.visibility_scope}`,
    `Exported at: ${result.exported_at ?? "unknown"}`,
    `Verified: ${result.verified ? "yes" : "no"}`,
    `Verification issues: ${result.verification_issue_count}`,
    `Workflow: ${result.run_summary.workflow_name ?? "unknown"}`,
    `Session: ${result.run_summary.session_id ?? "unknown"}`,
    `Events: ${result.run_summary.event_count ?? "unknown"}`,
    `Actions: ${result.run_summary.action_count ?? "unknown"}`,
    `Approvals: ${result.run_summary.approval_count ?? "unknown"}`,
    `Timeline steps: ${result.timeline.step_count}`,
    `Approvals required: ${result.timeline.approvals_required}`,
    `Approvals resolved: ${result.timeline.approvals_resolved}`,
    `Reversible steps: ${result.timeline.reversible_step_count}`,
    `External-effect steps: ${result.timeline.external_effect_step_count}`,
    `Artifacts exported: ${result.artifacts.exported_count}`,
    `Artifacts skipped: ${result.artifacts.skipped_count}`,
    `Artifacts available in bundle: ${result.artifacts.available_exported_count}`,
    `Artifacts missing or withheld: ${result.artifacts.missing_or_withheld_count}`,
  );
}

export function formatRunAuditCompare(result: RunAuditCompareResult): string {
  const differences =
    result.differences.length === 0
      ? "none"
      : `\n${bulletList(
          result.differences.map(
            (difference) =>
              `${difference.code}: ${difference.message}${difference.artifact_id ? ` [${difference.artifact_id}]` : ""}`,
          ),
        )}`;

  return lines(
    `Compared audit bundles ${result.left_run_id} -> ${result.right_run_id}`,
    `Left bundle: ${result.left_bundle_dir}`,
    `Right bundle: ${result.right_bundle_dir}`,
    `Comparable: ${result.comparable ? "yes" : "no"}`,
    `Left verified: ${result.left_verified ? "yes" : "no"}`,
    `Right verified: ${result.right_verified ? "yes" : "no"}`,
    `Differences: ${result.differences.length}`,
    `Difference details:${differences}`,
  );
}

export function formatRunAuditShare(result: RunAuditShareResult): string {
  const copiedArtifacts =
    result.copied_artifacts.length === 0
      ? "none"
      : `\n${bulletList(
          result.copied_artifacts.map(
            (artifact) => `${artifact.artifact_id} [${artifact.type}] -> ${artifact.output_path}`,
          ),
        )}`;
  const withheldArtifacts =
    result.withheld_artifacts.length === 0
      ? "none"
      : `\n${bulletList(
          result.withheld_artifacts.map((artifact) => `${artifact.artifact_id} [${artifact.type}] ${artifact.reason}`),
        )}`;

  return lines(
    `Created audit share package for ${result.run_id}`,
    `Source bundle: ${result.source_bundle_dir}`,
    `Output dir: ${result.output_dir}`,
    `Manifest version: ${result.manifest_version}`,
    `Include artifact content: ${result.include_artifact_content ? "yes" : "no"}`,
    `Files copied: ${result.copied_files.length}`,
    `Artifacts copied: ${result.copied_artifacts.length}`,
    `Artifacts withheld: ${result.withheld_artifacts.length}`,
    `Copied artifacts:${copiedArtifacts}`,
    `Withheld artifacts:${withheldArtifacts}`,
  );
}
