import path from "node:path";

import type {
  RunAuditCompareDifference,
  RunAuditCompareResult,
  RunAuditExportedArtifact,
  RunAuditSkippedArtifact,
} from "./common.js";
import { loadRunAuditBundle } from "./load.js";

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
