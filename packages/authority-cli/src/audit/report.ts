import type { RunAuditReportResult } from "./common.js";
import { loadRunAuditBundle } from "./load.js";

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
