import type { AuthorityClient } from "@agentgit/authority-sdk";

import {
  bulletList,
  clipText,
  formatBudget,
  formatConfidence,
  formatTimestamp,
  indentBlock,
  joinOrNone,
  lines,
  maybeLine,
} from "./core.js";

type RunSummaryResult = Awaited<ReturnType<AuthorityClient["getRunSummary"]>>;
type CapabilitiesResult = Awaited<ReturnType<AuthorityClient["getCapabilities"]>>;
type DiagnosticsResult = Awaited<ReturnType<AuthorityClient["diagnostics"]>>;
type MaintenanceResult = Awaited<ReturnType<AuthorityClient["runMaintenance"]>>;
type TimelineResult = Awaited<ReturnType<AuthorityClient["queryTimeline"]>>;
type TimelineStep = TimelineResult["steps"][number];
type TimelineArtifact = TimelineStep["primary_artifacts"][number];
type TimelineArtifactPreview = TimelineStep["artifact_previews"][number];
type SubmitActionResult = Awaited<ReturnType<AuthorityClient["submitActionAttempt"]>>;
type PolicyReason = SubmitActionResult["policy_outcome"]["reasons"][number];
type ListApprovalsResult = Awaited<ReturnType<AuthorityClient["listApprovals"]>>;
type ApprovalRequest = ListApprovalsResult["approvals"][number];
type ApprovalInboxResult = Awaited<ReturnType<AuthorityClient["queryApprovalInbox"]>>;
type ApprovalInboxItem = ApprovalInboxResult["items"][number];
type ResolveApprovalResult = Awaited<ReturnType<AuthorityClient["resolveApproval"]>>;
type HelperResult = Awaited<ReturnType<AuthorityClient["queryHelper"]>>;
type HelperQuestionType = Parameters<AuthorityClient["queryHelper"]>[1];
type HelperEvidence = HelperResult["evidence"][number];
type PlanRecoveryResult = Awaited<ReturnType<AuthorityClient["planRecovery"]>>;
type ExecuteRecoveryResult = Awaited<ReturnType<AuthorityClient["executeRecovery"]>>;
type RecoveryPlan = PlanRecoveryResult["recovery_plan"];
type RecoveryPlanStep = RecoveryPlan["steps"][number];
type CapabilityRecord = CapabilitiesResult["capabilities"][number];
type ReasonDetail = NonNullable<DiagnosticsResult["daemon_health"]>["primary_reason"];

interface TimelineTrustSummary {
  nonGoverned: number;
  imported: number;
  observed: number;
  unknown: number;
}

function formatReasonDetail(reason: ReasonDetail | null | undefined): string | null {
  return reason ? `${reason.code}: ${reason.message}` : null;
}

function summarizeTimelineTrust(steps: TimelineStep[]): TimelineTrustSummary {
  const summary: TimelineTrustSummary = {
    nonGoverned: 0,
    imported: 0,
    observed: 0,
    unknown: 0,
  };

  for (const step of steps) {
    if (step.provenance === "governed") {
      continue;
    }

    summary.nonGoverned += 1;

    if (step.provenance === "imported") {
      summary.imported += 1;
    } else if (step.provenance === "observed") {
      summary.observed += 1;
    } else if (step.provenance === "unknown") {
      summary.unknown += 1;
    }
  }

  return summary;
}

function formatTimelineTrustSummary(steps: TimelineStep[]): string | null {
  const summary = summarizeTimelineTrust(steps);

  if (summary.nonGoverned === 0) {
    return "Trust summary: all projected steps are governed.";
  }

  const parts = [
    summary.imported > 0 ? `${summary.imported} imported` : null,
    summary.observed > 0 ? `${summary.observed} observed` : null,
    summary.unknown > 0 ? `${summary.unknown} unknown` : null,
  ].filter((value): value is string => value !== null);

  return `Trust summary: ${summary.nonGoverned} non-governed step(s) detected${parts.length > 0 ? ` (${parts.join(", ")})` : ""}.`;
}

function formatPreviewBudget(result: {
  preview_budget: {
    preview_chars_used: number;
    max_total_inline_preview_chars: number;
    truncated_previews: number;
    omitted_previews: number;
  };
}): string {
  const budget = result.preview_budget;
  return `Preview budget: ${budget.preview_chars_used}/${budget.max_total_inline_preview_chars} chars used, ${budget.truncated_previews} truncated, ${budget.omitted_previews} omitted`;
}

function formatArtifacts(step: TimelineStep): string | null {
  if (step.primary_artifacts.length === 0) {
    return null;
  }

  const values = step.primary_artifacts.map((artifact: TimelineArtifact) => {
    const suffixParts = [
      artifact.label ?? (typeof artifact.count === "number" ? `x${artifact.count}` : null),
      artifact.artifact_id ?? null,
      artifact.artifact_status ?? null,
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    const suffix = suffixParts.length > 0 ? suffixParts.join(", ") : null;
    return suffix ? `${artifact.type} (${suffix})` : artifact.type;
  });

  return `Artifacts: ${values.join(", ")}`;
}

function formatPreviewBlocks(step: TimelineStep): string | null {
  if (step.artifact_previews.length === 0) {
    return null;
  }

  return step.artifact_previews
    .map((preview: TimelineArtifactPreview) =>
      lines(`Preview ${preview.label ?? preview.type}:`, indentBlock(clipText(preview.preview), 4)),
    )
    .join("\n");
}

export function formatRunSummary(result: RunSummaryResult): string {
  const { run } = result;
  const latestEvent = run.latest_event
    ? `#${run.latest_event.sequence} ${run.latest_event.event_type} at ${run.latest_event.occurred_at}`
    : "none";

  return lines(
    "Run summary",
    `Run: ${run.run_id}`,
    `Workflow: ${run.workflow_name}`,
    `Agent: ${run.agent_name} (${run.agent_framework})`,
    `Session: ${run.session_id}`,
    `Workspace roots: ${joinOrNone(run.workspace_roots)}`,
    `Events: ${run.event_count}`,
    `Latest event: ${latestEvent}`,
    `Mutating budget: ${formatBudget(run.budget_usage.mutating_actions, run.budget_config.max_mutating_actions)}`,
    `Destructive budget: ${formatBudget(run.budget_usage.destructive_actions, run.budget_config.max_destructive_actions)}`,
    `Projection: ${run.maintenance_status.projection_status} (${run.maintenance_status.projection_lag_events} lag events)`,
    `Artifact health: ${run.maintenance_status.artifact_health.available}/${run.maintenance_status.artifact_health.total} available, ${run.maintenance_status.artifact_health.missing} missing, ${run.maintenance_status.artifact_health.expired} expired, ${run.maintenance_status.artifact_health.corrupted} corrupted, ${run.maintenance_status.artifact_health.tampered} tampered`,
    `Degraded artifact captures: ${run.maintenance_status.degraded_artifact_capture_actions}`,
    `Low-disk pressure signals: ${run.maintenance_status.low_disk_pressure_signals}`,
    `Created: ${run.created_at}`,
    `Started: ${run.started_at}`,
  );
}

export function formatCapabilities(result: CapabilitiesResult): string {
  const capabilityLines =
    result.capabilities.length === 0
      ? "No capability records detected."
      : result.capabilities
          .map((capability: CapabilityRecord) =>
            lines(
              `- ${capability.capability_name} [${capability.status}]`,
              `  Scope: ${capability.scope}`,
              `  Source: ${capability.source}`,
              `  Detected: ${capability.detected_at}`,
              `  Details: ${JSON.stringify(capability.details)}`,
            ),
          )
          .join("\n\n");
  const warnings =
    result.degraded_mode_warnings.length === 0 ? "none" : `\n${bulletList(result.degraded_mode_warnings)}`;

  return lines(
    "Capabilities",
    `Detection started: ${result.detection_timestamps.started_at}`,
    `Detection completed: ${result.detection_timestamps.completed_at}`,
    `Degraded mode warnings:${warnings}`,
    "",
    capabilityLines,
  );
}

export function formatDiagnostics(result: DiagnosticsResult): string {
  return lines(
    "Diagnostics",
    result.daemon_health
      ? lines(
          `Daemon health: ${result.daemon_health.status}`,
          `Active sessions: ${result.daemon_health.active_sessions}`,
          `Active runs: ${result.daemon_health.active_runs}`,
          maybeLine("Daemon primary reason", formatReasonDetail(result.daemon_health.primary_reason)),
          result.daemon_health.warnings.length > 0
            ? `Daemon warnings: ${result.daemon_health.warnings.join(" | ")}`
            : null,
        )
      : null,
    result.journal_health
      ? lines(
          `Journal health: ${result.journal_health.status}`,
          `Journal totals: ${result.journal_health.total_runs} runs, ${result.journal_health.total_events} events, ${result.journal_health.pending_approvals} pending approvals`,
          maybeLine("Journal primary reason", formatReasonDetail(result.journal_health.primary_reason)),
          result.journal_health.warnings.length > 0
            ? `Journal warnings: ${result.journal_health.warnings.join(" | ")}`
            : null,
        )
      : null,
    result.maintenance_backlog
      ? lines(
          `Maintenance backlog: ${result.maintenance_backlog.pending_critical_jobs} critical, ${result.maintenance_backlog.pending_maintenance_jobs} maintenance`,
          `Oldest pending critical job: ${result.maintenance_backlog.oldest_pending_critical_job ?? "none"}`,
          `Current heavy job: ${result.maintenance_backlog.current_heavy_job ?? "none"}`,
          `Snapshot compaction debt: ${result.maintenance_backlog.snapshot_compaction_debt ?? "unknown"}`,
          maybeLine("Maintenance primary reason", formatReasonDetail(result.maintenance_backlog.primary_reason)),
          result.maintenance_backlog.warnings.length > 0
            ? `Maintenance warnings: ${result.maintenance_backlog.warnings.join(" | ")}`
            : null,
        )
      : null,
    result.projection_lag
      ? `Projection lag: ${result.projection_lag.projection_status} (${result.projection_lag.lag_events} lag events)`
      : null,
    result.storage_summary
      ? lines(
          `Storage evidence: ${result.storage_summary.artifact_health.available}/${result.storage_summary.artifact_health.total} available, ${result.storage_summary.artifact_health.missing} missing, ${result.storage_summary.artifact_health.expired} expired, ${result.storage_summary.artifact_health.corrupted} corrupted, ${result.storage_summary.artifact_health.tampered} tampered`,
          `Degraded artifact captures: ${result.storage_summary.degraded_artifact_capture_actions}`,
          `Low-disk pressure signals: ${result.storage_summary.low_disk_pressure_signals}`,
          maybeLine("Storage primary reason", formatReasonDetail(result.storage_summary.primary_reason)),
          result.storage_summary.warnings.length > 0
            ? `Storage warnings: ${result.storage_summary.warnings.join(" | ")}`
            : null,
        )
      : null,
    result.capability_summary
      ? lines(
          `Capability summary: ${result.capability_summary.cached ? "cached" : "not cached"}`,
          `Capability refresh age: ${result.capability_summary.refreshed_at ?? "never"}`,
          `Capability workspace root: ${result.capability_summary.workspace_root ?? "none"}`,
          `Capability counts: ${result.capability_summary.capability_count} total, ${result.capability_summary.degraded_capabilities} degraded, ${result.capability_summary.unavailable_capabilities} unavailable`,
          `Capability stale after: ${result.capability_summary.stale_after_ms}ms`,
          `Capability stale: ${result.capability_summary.is_stale ? "yes" : "no"}`,
          maybeLine("Capability primary reason", formatReasonDetail(result.capability_summary.primary_reason)),
          result.capability_summary.warnings.length > 0
            ? `Capability warnings: ${result.capability_summary.warnings.join(" | ")}`
            : null,
        )
      : null,
    result.policy_summary
      ? lines(
          `Policy summary: ${result.policy_summary.profile_name}`,
          `Policy versions: ${joinOrNone(result.policy_summary.policy_versions)}`,
          `Compiled rules: ${result.policy_summary.compiled_rule_count}`,
          result.policy_summary.loaded_sources.length > 0
            ? `Policy sources: ${result.policy_summary.loaded_sources
                .map((source) => `${source.scope}:${source.profile_name}@${source.policy_version}`)
                .join(", ")}`
            : null,
          result.policy_summary.warnings.length > 0
            ? `Policy warnings: ${result.policy_summary.warnings.join(" | ")}`
            : null,
        )
      : null,
    result.security_posture
      ? lines(
          `Security posture: ${result.security_posture.status}`,
          `Secret storage: ${result.security_posture.secret_storage.mode} (${result.security_posture.secret_storage.provider ?? "no provider"})`,
          `Secret storage durable: ${result.security_posture.secret_storage.durable ? "yes" : "no"}`,
          `Secret expiry enforced: ${result.security_posture.secret_storage.secret_expiry_enforced ? "yes" : "no"}`,
          `Stdio sandbox: ${result.security_posture.stdio_sandbox.protected_server_count}/${result.security_posture.stdio_sandbox.registered_server_count} protected`,
          `Stdio production-ready: ${result.security_posture.stdio_sandbox.production_ready_server_count}`,
          `Stdio digest-pinned: ${result.security_posture.stdio_sandbox.digest_pinned_server_count}`,
          `Stdio mutable-tag OCI: ${result.security_posture.stdio_sandbox.mutable_tag_server_count}`,
          `Stdio local-build OCI: ${result.security_posture.stdio_sandbox.local_build_server_count}`,
          `Stdio registry policy-covered: ${result.security_posture.stdio_sandbox.registry_policy_server_count}`,
          `Stdio signature-verification policy: ${result.security_posture.stdio_sandbox.signature_verification_server_count}`,
          `Stdio provenance-attested policy: ${result.security_posture.stdio_sandbox.provenance_attestation_server_count}`,
          `Stdio fallback-only: ${result.security_posture.stdio_sandbox.fallback_server_count}`,
          `Stdio unconfigured: ${result.security_posture.stdio_sandbox.unconfigured_server_count}`,
          `Stdio preferred production mode: ${result.security_posture.stdio_sandbox.preferred_production_mode}`,
          `Stdio local dev fallback: ${result.security_posture.stdio_sandbox.local_dev_fallback_mode ?? "none"}`,
          `Stdio current host mode: ${result.security_posture.stdio_sandbox.current_host_mode}`,
          maybeLine("Stdio current host reason", result.security_posture.stdio_sandbox.current_host_mode_reason),
          `Sandbox runtimes: docker=${result.security_posture.stdio_sandbox.docker_runtime_usable ? "yes" : "no"}, podman=${result.security_posture.stdio_sandbox.podman_runtime_usable ? "yes" : "no"}`,
          `Windows plan: ${result.security_posture.stdio_sandbox.windows_plan.summary}`,
          `Streamable HTTP hardening: dns=${result.security_posture.streamable_http.connect_time_dns_scope_validation ? "on" : "off"}, redirects=${result.security_posture.streamable_http.redirect_chain_revalidation ? "on" : "off"}, sqlite leases=${result.security_posture.streamable_http.shared_sqlite_leases ? "on" : "off"}, heartbeat=${result.security_posture.streamable_http.lease_heartbeat_renewal ? "on" : "off"}`,
          `Streamable HTTP exceptions: legacy env=${result.security_posture.streamable_http.legacy_bearer_env_servers.length}, missing secrets=${result.security_posture.streamable_http.missing_secret_ref_servers.length}, missing host policies=${result.security_posture.streamable_http.missing_public_host_policy_servers.length}`,
          maybeLine("Security primary reason", formatReasonDetail(result.security_posture.primary_reason)),
          result.security_posture.warnings.length > 0
            ? `Security warnings: ${result.security_posture.warnings.join(" | ")}`
            : null,
        )
      : null,
    result.hosted_worker
      ? lines(
          `Hosted worker: ${result.hosted_worker.status}`,
          `Hosted worker reachable: ${result.hosted_worker.reachable ? "yes" : "no"}`,
          `Hosted worker endpoint: ${result.hosted_worker.endpoint}`,
          `Hosted worker managed by daemon: ${result.hosted_worker.managed_by_daemon ? "yes" : "no"}`,
          `Hosted worker runtime: ${result.hosted_worker.runtime_id ?? "unknown"}`,
          `Hosted worker image digest: ${result.hosted_worker.image_digest ?? "unknown"}`,
          `Hosted worker control plane auth: ${result.hosted_worker.control_plane_auth_required ? "required" : "not required"}`,
          maybeLine("Hosted worker last error", result.hosted_worker.last_error),
          maybeLine("Hosted worker primary reason", formatReasonDetail(result.hosted_worker.primary_reason)),
          result.hosted_worker.warnings.length > 0
            ? `Hosted worker warnings: ${result.hosted_worker.warnings.join(" | ")}`
            : null,
        )
      : null,
    result.hosted_queue
      ? lines(
          `Hosted queue: ${result.hosted_queue.status}`,
          `Hosted queue counts: ${result.hosted_queue.queued_jobs} queued, ${result.hosted_queue.running_jobs} running, ${result.hosted_queue.cancel_requested_jobs} cancel requested, ${result.hosted_queue.succeeded_jobs} succeeded, ${result.hosted_queue.failed_jobs} failed, ${result.hosted_queue.canceled_jobs} canceled`,
          `Hosted queue retryable failed: ${result.hosted_queue.retryable_failed_jobs}`,
          `Hosted queue dead-letter: ${result.hosted_queue.dead_letter_retryable_jobs} retryable, ${result.hosted_queue.dead_letter_non_retryable_jobs} non-retryable`,
          `Hosted queue oldest queued: ${result.hosted_queue.oldest_queued_at ?? "none"}`,
          `Hosted queue oldest failed: ${result.hosted_queue.oldest_failed_at ?? "none"}`,
          `Hosted queue active server profiles: ${joinOrNone(result.hosted_queue.active_server_profiles)}`,
          maybeLine("Hosted queue primary reason", formatReasonDetail(result.hosted_queue.primary_reason)),
          result.hosted_queue.warnings.length > 0
            ? `Hosted queue warnings: ${result.hosted_queue.warnings.join(" | ")}`
            : null,
        )
      : null,
  );
}

export function formatMaintenance(result: MaintenanceResult): string {
  return lines(
    `Maintenance accepted at priority ${result.accepted_priority}`,
    `Scope: ${result.scope ? JSON.stringify(result.scope) : "global"}`,
    ...result.jobs.map((job) =>
      lines(
        `${job.job_type}: ${job.status}${job.performed_inline ? " (inline)" : ""}`,
        `  ${job.summary}`,
        job.stats ? `  Stats: ${JSON.stringify(job.stats)}` : null,
      ),
    ),
  );
}

export function formatTimelineStep(step: TimelineStep): string {
  const previewBlocks = formatPreviewBlocks(step);
  const trustAdvisory =
    step.provenance === "governed"
      ? null
      : step.provenance === "imported"
        ? "Trust advisory: imported action from external history; it was not governed pre-execution."
        : step.provenance === "observed"
          ? "Trust advisory: observed-only action; evidence was captured after execution rather than controlled before it."
          : "Trust advisory: insufficient trustworthy provenance to claim governed pre-execution control.";
  const relatedLines = [
    maybeLine("Action", step.action_id),
    maybeLine("Decision", step.decision),
    maybeLine("Reversibility", step.reversibility_class),
    trustAdvisory,
    maybeLine("Target", step.related.target_locator ?? null),
    maybeLine("Snapshot", step.related.snapshot_id ?? null),
    maybeLine("Execution", step.related.execution_id ?? null),
    step.related.recovery_target_type && step.related.recovery_target_label
      ? `Recovery target: ${step.related.recovery_target_type} (${step.related.recovery_target_label})`
      : null,
    step.related.recovery_scope_paths && step.related.recovery_scope_paths.length > 0
      ? `Recovery scope: ${step.related.recovery_scope_paths.join(", ")}`
      : null,
    maybeLine("Recovery strategy", step.related.recovery_strategy ?? null),
    step.related.recovery_downgrade_reason
      ? `Recovery downgrade: ${step.related.recovery_downgrade_reason.code} (${step.related.recovery_downgrade_reason.message})`
      : null,
    step.related.later_actions_affected !== null && step.related.later_actions_affected !== undefined
      ? `Later actions affected: ${step.related.later_actions_affected}`
      : null,
    step.related.overlapping_paths && step.related.overlapping_paths.length > 0
      ? `Overlapping paths: ${step.related.overlapping_paths.join(", ")}`
      : null,
    maybeLine("Data loss risk", step.related.data_loss_risk ?? null),
    step.related.recovery_plan_ids && step.related.recovery_plan_ids.length > 0
      ? `Recovery plans: ${step.related.recovery_plan_ids.join(", ")}`
      : null,
    formatArtifacts(step),
    `External effects: ${step.external_effects.length > 0 ? step.external_effects.join(", ") : "none"}`,
    step.warnings && step.warnings.length > 0 ? `Warnings:\n${bulletList(step.warnings, "     - ")}` : null,
  ].filter((value): value is string => Boolean(value));

  return lines(
    `${step.sequence}. [${step.status}] ${step.title}`,
    `   ${step.summary}`,
    `   Type: ${step.step_type}`,
    `   Provenance: ${step.provenance}`,
    `   Confidence: ${formatConfidence(step.confidence)}`,
    `   Occurred: ${step.occurred_at}`,
    ...(relatedLines.map((line) => `   ${line}`) as string[]),
    previewBlocks ? indentBlock(previewBlocks, 3) : null,
  );
}

export function formatTimeline(result: TimelineResult): string {
  if (result.steps.length === 0) {
    return lines(
      `Timeline for ${result.run_summary.run_id}`,
      `Workflow: ${result.run_summary.workflow_name}`,
      `Projection status: ${result.projection_status}`,
      `Visibility: ${result.visibility_scope}`,
      `Redactions applied: ${result.redactions_applied}`,
      formatPreviewBudget(result),
      "No timeline steps recorded yet.",
    );
  }

  return lines(
    `Timeline for ${result.run_summary.run_id}`,
    `Workflow: ${result.run_summary.workflow_name}`,
    `Projection status: ${result.projection_status}`,
    `Visibility: ${result.visibility_scope}`,
    `Redactions applied: ${result.redactions_applied}`,
    formatPreviewBudget(result),
    `Steps: ${result.steps.length}`,
    formatTimelineTrustSummary(result.steps),
    "",
    result.steps.map((step: TimelineStep) => formatTimelineStep(step)).join("\n\n"),
  );
}

export function formatSubmitAction(result: SubmitActionResult): string {
  const actionName = result.action.operation.display_name ?? result.action.operation.name;
  const reasons = result.policy_outcome.reasons.map((reason: PolicyReason) => `${reason.severity}: ${reason.message}`);
  const execution =
    result.execution_result === null || result.execution_result === undefined
      ? "not executed"
      : `${result.execution_result.mode} ${result.execution_result.success ? "successfully" : "with errors"} (${result.execution_result.execution_id})`;
  const approval =
    result.approval_request === null || result.approval_request === undefined
      ? null
      : `${result.approval_request.status} (${result.approval_request.approval_id})`;
  const approvalPrimaryReason = formatReasonDetail(result.approval_request?.primary_reason);
  const snapshot =
    result.snapshot_record === null || result.snapshot_record === undefined
      ? null
      : `${result.snapshot_record.snapshot_id} (${result.snapshot_record.fidelity})`;
  const artifactCapture =
    result.execution_result?.artifact_capture?.degraded === true
      ? `${result.execution_result.artifact_capture.stored_count}/${result.execution_result.artifact_capture.requested_count} stored; ${result.execution_result.artifact_capture.failures.length} capture failure(s)`
      : null;

  return lines(
    `Action ${result.action.action_id}`,
    `Operation: ${actionName}`,
    `Domain: ${result.action.operation.domain}`,
    `Target: ${result.action.target.primary.locator}`,
    `Tool: ${result.action.actor.tool_name} (${result.action.actor.tool_kind})`,
    `Policy decision: ${result.policy_outcome.decision}`,
    `Side effect level: ${result.action.risk_hints.side_effect_level}`,
    maybeLine("Approval", approval),
    maybeLine("Approval primary reason", approvalPrimaryReason),
    maybeLine("Snapshot", snapshot),
    `Execution: ${execution}`,
    maybeLine("Artifact capture", artifactCapture),
    reasons.length > 0 ? `Reasons:\n${bulletList(reasons)}` : null,
  );
}

export function formatApprovalList(result: ListApprovalsResult): string {
  if (result.approvals.length === 0) {
    return "No approval requests matched.";
  }

  return lines(
    `Approvals: ${result.approvals.length}`,
    "",
    result.approvals
      .map((approval: ApprovalRequest) =>
        lines(
          `- ${approval.approval_id} [${approval.status}] ${approval.action_summary}`,
          `  Run: ${approval.run_id}`,
          `  Action: ${approval.action_id}`,
          `  Requested: ${approval.requested_at}`,
          `  Resolved: ${formatTimestamp(approval.resolved_at)}`,
          maybeLine("  Primary reason", formatReasonDetail(approval.primary_reason)),
          maybeLine("  Note", approval.resolution_note),
        ),
      )
      .join("\n\n"),
  );
}

export function formatApprovalInbox(result: ApprovalInboxResult): string {
  if (result.items.length === 0) {
    return lines(
      "Approval inbox",
      `Counts: pending ${result.counts.pending}, approved ${result.counts.approved}, denied ${result.counts.denied}`,
      "No approval inbox items matched.",
    );
  }

  return lines(
    "Approval inbox",
    `Counts: pending ${result.counts.pending}, approved ${result.counts.approved}, denied ${result.counts.denied}`,
    "",
    result.items
      .map((item: ApprovalInboxItem) =>
        lines(
          `- ${item.approval_id} [${item.status}] ${item.action_summary}`,
          `  Workflow: ${item.workflow_name}`,
          `  Run: ${item.run_id}`,
          `  Action: ${item.action_id}`,
          `  Domain: ${item.action_domain}`,
          `  Side effect level: ${item.side_effect_level}`,
          `  Snapshot required: ${item.snapshot_required ? "yes" : "no"}`,
          `  Target: ${item.target_label ?? item.target_locator}`,
          `  Requested: ${item.requested_at}`,
          `  Resolved: ${formatTimestamp(item.resolved_at)}`,
          maybeLine("  Reason", item.reason_summary),
          maybeLine("  Primary reason", formatReasonDetail(item.primary_reason)),
          maybeLine("  Note", item.resolution_note),
        ),
      )
      .join("\n\n"),
  );
}

export function formatResolveApproval(result: ResolveApprovalResult, resolution: "approved" | "denied"): string {
  const execution =
    result.execution_result === null || result.execution_result === undefined
      ? null
      : `${result.execution_result.mode} ${result.execution_result.success ? "successfully" : "with errors"} (${result.execution_result.execution_id})`;
  const snapshot =
    result.snapshot_record === null || result.snapshot_record === undefined
      ? null
      : `${result.snapshot_record.snapshot_id} (${result.snapshot_record.fidelity})`;
  const artifactCapture =
    result.execution_result?.artifact_capture?.degraded === true
      ? `${result.execution_result.artifact_capture.stored_count}/${result.execution_result.artifact_capture.requested_count} stored; ${result.execution_result.artifact_capture.failures.length} capture failure(s)`
      : null;

  return lines(
    `Approval ${resolution}`,
    `Approval: ${result.approval_request.approval_id}`,
    `Run: ${result.approval_request.run_id}`,
    `Action: ${result.approval_request.action_id}`,
    `Status: ${result.approval_request.status}`,
    `Requested: ${result.approval_request.requested_at}`,
    `Resolved: ${formatTimestamp(result.approval_request.resolved_at)}`,
    maybeLine("Primary reason", formatReasonDetail(result.approval_request.primary_reason)),
    maybeLine("Resolution note", result.approval_request.resolution_note),
    maybeLine("Snapshot", snapshot),
    maybeLine("Execution", execution),
    maybeLine("Artifact capture", artifactCapture),
  );
}

export function formatHelper(result: HelperResult, questionType: HelperQuestionType): string {
  const evidence =
    result.evidence.length === 0
      ? "none"
      : `\n${bulletList(result.evidence.map((item: HelperEvidence) => `#${item.sequence} ${item.title} (${item.step_id})`))}`;
  const uncertainty = result.uncertainty.length === 0 ? "none" : `\n${bulletList(result.uncertainty)}`;
  const primaryReason = formatReasonDetail(result.primary_reason);

  return lines(
    `Helper answer for ${questionType}`,
    `Confidence: ${formatConfidence(result.confidence)}`,
    `Visibility: ${result.visibility_scope}`,
    `Redactions applied: ${result.redactions_applied}`,
    formatPreviewBudget(result),
    maybeLine("Primary reason", primaryReason),
    "",
    result.answer,
    "",
    `Evidence:${evidence}`,
    `Uncertainty:${uncertainty}`,
  );
}

export function formatRecoveryPlan(plan: RecoveryPlan): string {
  const targetLabel =
    plan.target.type === "snapshot_id"
      ? `Target snapshot: ${plan.target.snapshot_id}`
      : plan.target.type === "action_boundary"
        ? `Target action: ${plan.target.action_id}`
        : plan.target.type === "external_object"
          ? `Target external object: ${plan.target.external_object_id}`
          : plan.target.type === "run_checkpoint"
            ? `Target run checkpoint: ${plan.target.run_checkpoint}`
            : plan.target.type === "branch_point"
              ? `Target branch point: ${plan.target.run_id}#${plan.target.sequence}`
              : `Target subset: ${plan.target.snapshot_id} @ ${plan.target.paths.join(", ")}`;
  const steps =
    plan.steps.length === 0
      ? "none"
      : `\n${plan.steps
          .map((step: RecoveryPlanStep, index: number) =>
            lines(
              `${index + 1}. ${step.type} (${step.step_id})`,
              `   Idempotent: ${step.idempotent ? "yes" : "no"}`,
              `   Depends on: ${step.depends_on.length > 0 ? step.depends_on.join(", ") : "none"}`,
            ),
          )
          .join("\n")}`;
  const pathsToChange =
    typeof plan.impact_preview.paths_to_change === "number" ? String(plan.impact_preview.paths_to_change) : "unknown";
  const overlappingPaths =
    plan.impact_preview.overlapping_paths.length > 0 ? plan.impact_preview.overlapping_paths.join(", ") : "none";
  const warnings =
    plan.warnings.length === 0
      ? "none"
      : `\n${bulletList(plan.warnings.map((warning) => `${warning.code}: ${warning.message}`))}`;
  const reviewGuidance = !plan.review_guidance
    ? null
    : lines(
        `Systems touched: ${joinOrNone(plan.review_guidance.systems_touched)}`,
        `Objects touched: ${joinOrNone(plan.review_guidance.objects_touched)}`,
        `Manual steps: ${
          plan.review_guidance.manual_steps.length > 0 ? `\n${bulletList(plan.review_guidance.manual_steps)}` : "none"
        }`,
        `Uncertainty: ${
          plan.review_guidance.uncertainty.length > 0 ? `\n${bulletList(plan.review_guidance.uncertainty)}` : "none"
        }`,
      );
  const downgradeReason = plan.downgrade_reason
    ? `${plan.downgrade_reason.code}: ${plan.downgrade_reason.message}`
    : null;

  return lines(
    `Recovery plan ${plan.recovery_plan_id}`,
    targetLabel,
    `Class: ${plan.recovery_class}`,
    `Strategy: ${plan.strategy}`,
    `Confidence: ${formatConfidence(plan.confidence)}`,
    `Created: ${plan.created_at}`,
    maybeLine("Downgrade reason", downgradeReason),
    `Paths to change: ${pathsToChange}`,
    `Later actions affected: ${plan.impact_preview.later_actions_affected}`,
    `Overlapping paths: ${overlappingPaths}`,
    `Data loss risk: ${plan.impact_preview.data_loss_risk}`,
    `External effects: ${plan.impact_preview.external_effects.length > 0 ? plan.impact_preview.external_effects.join(", ") : "none"}`,
    `Warnings:${warnings}`,
    reviewGuidance ? `Review guidance:\n${indentBlock(reviewGuidance, 2)}` : null,
    `Steps:${steps}`,
  );
}

export function formatPlanRecovery(result: PlanRecoveryResult): string {
  return formatRecoveryPlan(result.recovery_plan);
}

export function formatExecuteRecovery(result: ExecuteRecoveryResult): string {
  return lines(
    `Recovery ${result.outcome === "compensated" ? "completed via compensation" : result.restored ? "completed" : "planned but not restored"}`,
    `Executed at: ${result.executed_at}`,
    `Outcome: ${result.outcome}`,
    `Restored: ${result.restored ? "yes" : "no"}`,
    `Recovery plan: ${result.recovery_plan.recovery_plan_id}`,
    `Recovered target: ${result.recovery_plan.target.type}`,
  );
}
