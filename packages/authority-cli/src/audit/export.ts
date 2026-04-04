import fs from "node:fs";
import path from "node:path";

import { AuthorityClient, AuthorityDaemonResponseError } from "@agentgit/authority-sdk";

import { ioError } from "../cli-contract.js";
import {
  type ArtifactExportResult,
  type AuditBundleFormatterDeps,
  type RunAuditExportResult,
  type RunAuditExportedArtifact,
  type RunAuditSkippedArtifact,
  type TimelineResult,
  RUN_AUDIT_BUNDLE_MANIFEST_VERSION,
  ensurePathDoesNotExist,
  safeFileComponent,
  sha256Hex,
  writeJsonFile,
} from "./common.js";

export async function exportArtifactContent(
  client: AuthorityClient,
  artifactId: string,
  destinationPath: string,
  visibilityScope?: TimelineResult["visibility_scope"],
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
