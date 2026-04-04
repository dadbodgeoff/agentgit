import fs from "node:fs";
import path from "node:path";

import type { ApprovalInboxResult, DiagnosticsResult, ListApprovalsResult, LoadedAuditBundle, RunAuditBundleManifest, RunSummaryResult, TimelineResult } from "./common.js";
import { readJsonFile } from "./common.js";
import { verifyRunAuditBundle } from "./verify.js";

export function loadRunAuditBundle(outputDir: string): LoadedAuditBundle {
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
