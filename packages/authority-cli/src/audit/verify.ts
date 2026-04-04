import fs from "node:fs";
import path from "node:path";

import {
  type RunAuditExportedArtifact,
  type RunAuditVerifyResult,
  REQUIRED_AUDIT_BUNDLE_FILES,
  sha256Hex,
} from "./common.js";

export function verifyRunAuditBundle(outputDir: string): RunAuditVerifyResult {
  const manifestPath = path.join(outputDir, "manifest.json");
  const issues: RunAuditVerifyResult["issues"] = [];

  let filesChecked = 0;
  for (const fileName of REQUIRED_AUDIT_BUNDLE_FILES) {
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
