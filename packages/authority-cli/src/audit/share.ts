import fs from "node:fs";
import path from "node:path";

import { inputError } from "../cli-contract.js";
import {
  type RunAuditShareResult,
  AUDIT_SHARE_REPORT_FILES,
  RUN_AUDIT_SHARE_MANIFEST_VERSION,
  copyFileAndTrack,
  ensurePathDoesNotExist,
  writeJsonFile,
} from "./common.js";
import { loadRunAuditBundle } from "./load.js";

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

  for (const fileName of AUDIT_SHARE_REPORT_FILES) {
    const sourcePath = path.join(bundleDir, fileName);
    if (fs.existsSync(sourcePath)) {
      copyFileAndTrack(sourcePath, path.join(outputDir, fileName), copiedFiles);
    }
  }

  const copiedArtifacts: RunAuditShareResult["copied_artifacts"] = [];
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
