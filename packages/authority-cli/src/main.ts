#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { AuthorityClient } from "@agentgit/authority-sdk";

const USAGE = [
  "Usage: agentgit-authority [--json] <command> [args]",
  "",
  "Commands:",
  "  ping",
  "  register-run [workflow-name] [max-mutating] [max-destructive]",
  "  run-summary <run-id>",
  "  capabilities [workspace-root]",
  "  diagnostics [daemon_health|journal_health|maintenance_backlog|projection_lag|storage_summary|capability_summary...]",
  "  maintenance <job-type...>",
  "  timeline <run-id> [user|model|internal|sensitive_internal]",
  "  artifact <artifact-id> [user|model|internal|sensitive_internal]",
  "  list-approvals [run-id] [pending|approved|denied]",
  "  approval-inbox [run-id] [pending|approved|denied]",
  "  approve <approval-id> [note]",
  "  deny <approval-id> [note]",
  "  helper <run-id> <run_summary|what_happened|summarize_after_boundary|step_details|explain_policy_decision|reversible_steps|why_blocked|likely_cause|suggest_likely_cause|what_changed_after_step|revert_impact|preview_revert_loss|what_would_i_lose_if_i_revert_here|external_side_effects|identify_external_effects|list_actions_touching_scope|compare_steps> [focus-step-id] [compare-step-id] [user|model|internal|sensitive_internal]",
  "  submit-filesystem-write <run-id> <path> <content>",
  "  submit-filesystem-delete <run-id> <path>",
  "  submit-shell <run-id> <command...>",
  "  submit-draft-create <run-id> <subject> <body>",
  "  submit-draft-archive <run-id> <draft-id>",
  "  submit-draft-delete <run-id> <draft-id>",
  "  submit-draft-unarchive <run-id> <draft-id>",
  "  submit-draft-update <run-id> <draft-id> <subject> <body>",
  "  submit-draft-add-label <run-id> <draft-id> <label>",
  "  submit-draft-remove-label <run-id> <draft-id> <label>",
  "  submit-draft-restore <run-id> <draft-id> <state-json>",
  "  submit-note-create <run-id> <title> <body>",
  "  submit-note-archive <run-id> <note-id>",
  "  submit-note-unarchive <run-id> <note-id>",
  "  submit-note-delete <run-id> <note-id>",
  "  submit-note-update <run-id> <note-id> <title> <body>",
  "  submit-note-restore <run-id> <note-id> <state-json>",
  "  submit-ticket-create <run-id> <title> <body>",
  "  submit-ticket-update <run-id> <ticket-id> <title> <body>",
  "  submit-ticket-delete <run-id> <ticket-id>",
  "  submit-ticket-restore <run-id> <ticket-id> <state-json>",
  "  submit-ticket-close <run-id> <ticket-id>",
  "  submit-ticket-reopen <run-id> <ticket-id>",
  "  submit-ticket-add-label <run-id> <ticket-id> <label>",
  "  submit-ticket-remove-label <run-id> <ticket-id> <label>",
  "  submit-ticket-assign-user <run-id> <ticket-id> <user-id>",
  "  submit-ticket-unassign-user <run-id> <ticket-id> <user-id>",
  "  plan-recovery <snapshot-id|action-id>",
  "  execute-recovery <snapshot-id|action-id>",
].join("\n");

type HelloResult = Awaited<ReturnType<AuthorityClient["hello"]>>;
type RegisterRunResult = Awaited<ReturnType<AuthorityClient["registerRun"]>>;
type RunSummaryResult = Awaited<ReturnType<AuthorityClient["getRunSummary"]>>;
type CapabilitiesResult = Awaited<ReturnType<AuthorityClient["getCapabilities"]>>;
type DiagnosticsResult = Awaited<ReturnType<AuthorityClient["diagnostics"]>>;
type MaintenanceResult = Awaited<ReturnType<AuthorityClient["runMaintenance"]>>;
type SubmitActionResult = Awaited<ReturnType<AuthorityClient["submitActionAttempt"]>>;
type ListApprovalsResult = Awaited<ReturnType<AuthorityClient["listApprovals"]>>;
type ApprovalInboxResult = Awaited<ReturnType<AuthorityClient["queryApprovalInbox"]>>;
type ResolveApprovalResult = Awaited<ReturnType<AuthorityClient["resolveApproval"]>>;
type TimelineResult = Awaited<ReturnType<AuthorityClient["queryTimeline"]>>;
type HelperResult = Awaited<ReturnType<AuthorityClient["queryHelper"]>>;
type ArtifactResult = Awaited<ReturnType<AuthorityClient["queryArtifact"]>>;
type PlanRecoveryResult = Awaited<ReturnType<AuthorityClient["planRecovery"]>>;
type ExecuteRecoveryResult = Awaited<ReturnType<AuthorityClient["executeRecovery"]>>;
type HelperQuestionType = Parameters<AuthorityClient["queryHelper"]>[1];
type TimelineStep = TimelineResult["steps"][number];
type RecoveryPlan = PlanRecoveryResult["recovery_plan"];
type TimelineArtifact = TimelineStep["primary_artifacts"][number];
type TimelineArtifactPreview = TimelineStep["artifact_previews"][number];
type PolicyReason = SubmitActionResult["policy_outcome"]["reasons"][number];
type ApprovalRequest = ListApprovalsResult["approvals"][number];
type ApprovalInboxItem = ApprovalInboxResult["items"][number];
type HelperEvidence = HelperResult["evidence"][number];
type RecoveryPlanStep = RecoveryPlan["steps"][number];
type DiagnosticsSection = NonNullable<Parameters<AuthorityClient["diagnostics"]>[0]>[number];
type MaintenanceJobType = Parameters<AuthorityClient["runMaintenance"]>[0][number];
type CapabilityRecord = CapabilitiesResult["capabilities"][number];
type ReasonDetail = NonNullable<DiagnosticsResult["daemon_health"]>["primary_reason"];

interface TimelineTrustSummary {
  nonGoverned: number;
  imported: number;
  observed: number;
  unknown: number;
}

const VISIBILITY_SCOPES = new Set(["user", "model", "internal", "sensitive_internal"]);
const DIAGNOSTICS_SECTIONS = new Set<DiagnosticsSection>([
  "daemon_health",
  "journal_health",
  "maintenance_backlog",
  "projection_lag",
  "storage_summary",
  "capability_summary",
]);
const MAINTENANCE_JOB_TYPES = new Set<MaintenanceJobType>([
  "startup_reconcile_runs",
  "startup_reconcile_recoveries",
  "sqlite_wal_checkpoint",
  "projection_refresh",
  "projection_rebuild",
  "snapshot_gc",
  "snapshot_compaction",
  "snapshot_rebase_anchor",
  "artifact_expiry",
  "artifact_orphan_cleanup",
  "capability_refresh",
  "helper_fact_warm",
]);

function normalizeArgv(argv: string[]): string[] {
  return argv[0] === "--" ? argv.slice(1) : argv;
}

function wantsJsonOutput(argv: string[]): boolean {
  const normalizedArgv = normalizeArgv(argv);
  return normalizedArgv[0] === "--json";
}

function parseCliArgs(argv: string[]): {
  jsonOutput: boolean;
  command: string | undefined;
  rest: string[];
} {
  const normalizedArgv = normalizeArgv(argv);
  const jsonOutput = wantsJsonOutput(normalizedArgv);
  const args = jsonOutput ? normalizedArgv.slice(1) : normalizedArgv;
  const [command, ...rest] = args;

  return {
    jsonOutput,
    command,
    rest,
  };
}

function parseDiagnosticsSections(args: string[]): DiagnosticsSection[] {
  return args.filter((value): value is DiagnosticsSection => DIAGNOSTICS_SECTIONS.has(value as DiagnosticsSection));
}

function parseMaintenanceJobTypes(args: string[]): MaintenanceJobType[] {
  return args.filter((value): value is MaintenanceJobType => MAINTENANCE_JOB_TYPES.has(value as MaintenanceJobType));
}

function printResult<T>(result: T, jsonOutput: boolean, format: (value: T) => string): void {
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(format(result));
}

function lines(...values: Array<string | null | undefined | false>): string {
  return values.filter((value): value is string => typeof value === "string" && value.length > 0).join("\n");
}

function bulletList(items: string[], indent = "  "): string {
  return items.map((item) => `${indent}- ${item}`).join("\n");
}

function clipText(value: string, maxChars = 320, maxLines = 4): string {
  const clippedChars = value.length > maxChars ? `${value.slice(0, maxChars - 3)}...` : value;
  const lineParts = clippedChars.split(/\r?\n/);

  if (lineParts.length <= maxLines) {
    return clippedChars;
  }

  return `${lineParts.slice(0, maxLines).join("\n")}\n...`;
}

function indentBlock(value: string, spaces = 2): string {
  const prefix = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatBudget(used: number, limit: number | null): string {
  return limit === null ? `${used} / unlimited` : `${used} / ${limit}`;
}

function joinOrNone(items: string[]): string {
  return items.length > 0 ? items.join(", ") : "none";
}

function maybeLine(label: string, value: string | null | undefined): string | null {
  return value ? `${label}: ${value}` : null;
}

function formatReasonDetail(reason: ReasonDetail | null | undefined): string | null {
  return reason ? `${reason.code}: ${reason.message}` : null;
}

function parseVisibilityScopeArg(value: string | undefined): "user" | "model" | "internal" | "sensitive_internal" | undefined {
  return value && VISIBILITY_SCOPES.has(value)
    ? (value as "user" | "model" | "internal" | "sensitive_internal")
    : undefined;
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

function formatTimestamp(value: string | null | undefined): string {
  return value ?? "unknown";
}

function formatHello(result: HelloResult): string {
  return lines(
    "Authority daemon reachable",
    `Session: ${result.session_id}`,
    `Accepted API version: ${result.accepted_api_version}`,
    `Runtime version: ${result.runtime_version}`,
    `Schema pack: ${result.schema_pack_version}`,
    `Local only: ${result.capabilities.local_only ? "yes" : "no"}`,
    `Capabilities: ${joinOrNone(result.capabilities.methods)}`,
  );
}

function formatRegisterRun(result: RegisterRunResult): string {
  return lines(
    `Registered run ${result.run_id}`,
    `Workflow: ${result.run_handle.workflow_name}`,
    `Session: ${result.run_handle.session_id}`,
    `Effective policy profile: ${result.effective_policy_profile}`,
  );
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
    result.degraded_mode_warnings.length === 0
      ? "none"
      : `\n${bulletList(result.degraded_mode_warnings)}`;

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
          result.daemon_health.warnings.length > 0 ? `Daemon warnings: ${result.daemon_health.warnings.join(" | ")}` : null,
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
      lines(
        `Preview ${preview.label ?? preview.type}:`,
        indentBlock(clipText(preview.preview), 4),
      ),
    )
    .join("\n");
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
    step.warnings && step.warnings.length > 0
      ? `Warnings:\n${bulletList(step.warnings, "     - ")}`
      : null,
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

function formatSubmitAction(result: SubmitActionResult): string {
  const actionName = result.action.operation.display_name ?? result.action.operation.name;
  const reasons = result.policy_outcome.reasons.map(
    (reason: PolicyReason) => `${reason.severity}: ${reason.message}`,
  );
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

function formatApprovalList(result: ListApprovalsResult): string {
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

function formatApprovalInbox(result: ApprovalInboxResult): string {
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

function formatResolveApproval(result: ResolveApprovalResult, resolution: "approved" | "denied"): string {
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
  const uncertainty =
    result.uncertainty.length === 0
      ? "none"
      : `\n${bulletList(result.uncertainty)}`;
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
    typeof plan.impact_preview.paths_to_change === "number"
      ? String(plan.impact_preview.paths_to_change)
      : "unknown";
  const overlappingPaths =
    plan.impact_preview.overlapping_paths.length > 0
      ? plan.impact_preview.overlapping_paths.join(", ")
      : "none";
  const warnings =
    plan.warnings.length === 0
      ? "none"
      : `\n${bulletList(plan.warnings.map((warning) => `${warning.code}: ${warning.message}`))}`;
  const reviewGuidance =
    !plan.review_guidance
      ? null
      : lines(
          `Systems touched: ${joinOrNone(plan.review_guidance.systems_touched)}`,
          `Objects touched: ${joinOrNone(plan.review_guidance.objects_touched)}`,
          `Manual steps: ${
            plan.review_guidance.manual_steps.length > 0
              ? `\n${bulletList(plan.review_guidance.manual_steps)}`
              : "none"
          }`,
          `Uncertainty: ${
            plan.review_guidance.uncertainty.length > 0
              ? `\n${bulletList(plan.review_guidance.uncertainty)}`
              : "none"
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

function formatPlanRecovery(result: PlanRecoveryResult): string {
  return formatRecoveryPlan(result.recovery_plan);
}

function formatExecuteRecovery(result: ExecuteRecoveryResult): string {
  return lines(
    `Recovery ${result.outcome === "compensated" ? "completed via compensation" : result.restored ? "completed" : "planned but not restored"}`,
    `Executed at: ${result.executed_at}`,
    `Outcome: ${result.outcome}`,
    "",
    formatRecoveryPlan(result.recovery_plan),
  );
}

async function main(): Promise<void> {
  const { jsonOutput, command, rest } = parseCliArgs(process.argv.slice(2));
  const client = new AuthorityClient({ clientType: "cli" });
  const workspaceRoot = process.env.AGENTGIT_ROOT ?? process.env.INIT_CWD ?? process.cwd();

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }

  switch (command) {
    case "ping": {
      const result = await client.hello([workspaceRoot]);
      printResult(result, jsonOutput, formatHello);
      return;
    }
    case "register-run": {
      const workflowName = rest[0] ?? "cli-run";
      const maxMutatingActions = rest[1] ? Number(rest[1]) : null;
      const maxDestructiveActions = rest[2] ? Number(rest[2]) : null;
      const result = await client.registerRun({
        workflow_name: workflowName,
        agent_framework: "cli",
        agent_name: "agentgit-cli",
        workspace_roots: [workspaceRoot],
        client_metadata: {
          invoked_from: "authority-cli",
        },
        budget_config:
          maxMutatingActions !== null || maxDestructiveActions !== null
            ? {
                max_mutating_actions: Number.isFinite(maxMutatingActions) ? maxMutatingActions : null,
                max_destructive_actions: Number.isFinite(maxDestructiveActions) ? maxDestructiveActions : null,
              }
            : undefined,
      });
      printResult(result, jsonOutput, formatRegisterRun);
      return;
    }
    case "run-summary": {
      const runId = rest[0];

      if (!runId) {
        console.error("Usage: agentgit-authority [--json] run-summary <run-id>");
        process.exitCode = 1;
        return;
      }

      const result = await client.getRunSummary(runId);
      printResult(result, jsonOutput, formatRunSummary);
      return;
    }
    case "capabilities": {
      const result = await client.getCapabilities(rest[0]);
      printResult(result, jsonOutput, formatCapabilities);
      return;
    }
    case "diagnostics": {
      const sections = rest.length > 0 ? parseDiagnosticsSections(rest) : undefined;
      const result = await client.diagnostics(sections && sections.length > 0 ? sections : undefined);
      printResult(result, jsonOutput, formatDiagnostics);
      return;
    }
    case "maintenance": {
      if (rest.length < 1) {
        console.error("Usage: agentgit-authority [--json] maintenance <job-type...>");
        process.exitCode = 1;
        return;
      }

      const jobTypes = parseMaintenanceJobTypes(rest);
      if (jobTypes.length === 0) {
        console.error("No valid maintenance job types were provided.");
        process.exitCode = 1;
        return;
      }

      const result = await client.runMaintenance(jobTypes);
      printResult(result, jsonOutput, formatMaintenance);
      return;
    }
    case "timeline": {
      const runId = rest[0];
      const visibilityScope = parseVisibilityScopeArg(rest[1]);

      if (!runId) {
        console.error("Usage: agentgit-authority [--json] timeline <run-id> [user|model|internal|sensitive_internal]");
        process.exitCode = 1;
        return;
      }

      const result = await client.queryTimeline(runId, visibilityScope);
      printResult(result, jsonOutput, formatTimeline);
      return;
    }
    case "list-approvals": {
      const [runId, status] = rest;
      const result = await client.listApprovals({
        ...(runId ? { run_id: runId } : {}),
        ...(status ? { status: status as "pending" | "approved" | "denied" } : {}),
      });
      printResult(result, jsonOutput, formatApprovalList);
      return;
    }
    case "approval-inbox": {
      const [runId, status] = rest;
      const result = await client.queryApprovalInbox({
        ...(runId ? { run_id: runId } : {}),
        ...(status ? { status: status as "pending" | "approved" | "denied" } : {}),
      });
      printResult(result, jsonOutput, formatApprovalInbox);
      return;
    }
    case "approve": {
      const approvalId = rest[0];

      if (!approvalId) {
        console.error("Usage: agentgit-authority [--json] approve <approval-id> [note]");
        process.exitCode = 1;
        return;
      }

      const note = rest.slice(1).join(" ") || undefined;
      const result = await client.resolveApproval(approvalId, "approved", note);
      printResult(result, jsonOutput, (value) => formatResolveApproval(value, "approved"));
      return;
    }
    case "deny": {
      const approvalId = rest[0];

      if (!approvalId) {
        console.error("Usage: agentgit-authority [--json] deny <approval-id> [note]");
        process.exitCode = 1;
        return;
      }

      const note = rest.slice(1).join(" ") || undefined;
      const result = await client.resolveApproval(approvalId, "denied", note);
      printResult(result, jsonOutput, (value) => formatResolveApproval(value, "denied"));
      return;
    }
    case "artifact": {
      if (rest.length < 1) {
        throw new Error("artifact requires <artifact-id> [visibility-scope].");
      }
      const artifactId = rest[0]!;
      const visibilityScope = parseVisibilityScopeArg(rest[1]);
      const result = await client.queryArtifact(artifactId, visibilityScope);
      printResult(result, jsonOutput, formatArtifact);
      return;
    }
    case "helper": {
      const [runId, questionType, rawFocusStepId, rawCompareStepId, rawVisibilityScope] = rest;
      const visibilityScope =
        parseVisibilityScopeArg(rawVisibilityScope) ??
        parseVisibilityScopeArg(rawCompareStepId) ??
        parseVisibilityScopeArg(rawFocusStepId);
      const focusStepId = parseVisibilityScopeArg(rawFocusStepId) ? undefined : rawFocusStepId;
      const compareStepId = parseVisibilityScopeArg(rawCompareStepId) ? undefined : rawCompareStepId;

      if (!runId || !questionType) {
        console.error(
          "Usage: agentgit-authority [--json] helper <run-id> <run_summary|what_happened|summarize_after_boundary|step_details|explain_policy_decision|reversible_steps|why_blocked|likely_cause|suggest_likely_cause|what_changed_after_step|revert_impact|preview_revert_loss|what_would_i_lose_if_i_revert_here|external_side_effects|identify_external_effects|list_actions_touching_scope|compare_steps> [focus-step-id] [compare-step-id] [user|model|internal|sensitive_internal]",
        );
        process.exitCode = 1;
        return;
      }

      const result = await client.queryHelper(
        runId,
        questionType as HelperQuestionType,
        focusStepId,
        compareStepId,
        visibilityScope,
      );
      printResult(result, jsonOutput, (value) => formatHelper(value, questionType as HelperQuestionType));
      return;
    }
    case "submit-filesystem-write": {
      const [runId, targetPath, ...contentParts] = rest;

      if (!runId || !targetPath) {
        console.error("Usage: agentgit-authority [--json] submit-filesystem-write <run-id> <path> <content>");
        process.exitCode = 1;
        return;
      }

      const content = contentParts.join(" ");
      const result = await client.submitActionAttempt({
        run_id: runId,
        tool_registration: {
          tool_name: "write_file",
          tool_kind: "filesystem",
        },
        raw_call: {
          operation: "write",
          path: targetPath,
          content,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-filesystem-delete": {
      const [runId, targetPath] = rest;

      if (!runId || !targetPath) {
        console.error("Usage: agentgit-authority [--json] submit-filesystem-delete <run-id> <path>");
        process.exitCode = 1;
        return;
      }

      const result = await client.submitActionAttempt({
        run_id: runId,
        tool_registration: {
          tool_name: "delete_file",
          tool_kind: "filesystem",
        },
        raw_call: {
          operation: "delete",
          path: targetPath,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-shell": {
      const [runId, ...commandParts] = rest;

      if (!runId || commandParts.length === 0) {
        console.error("Usage: agentgit-authority [--json] submit-shell <run-id> <command...>");
        process.exitCode = 1;
        return;
      }

      const result = await client.submitActionAttempt({
        run_id: runId,
        tool_registration: {
          tool_name: "exec_command",
          tool_kind: "shell",
        },
        raw_call: {
          command: commandParts.join(" "),
          argv: commandParts,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-draft-create": {
      const [runId, subject, ...bodyParts] = rest;

      if (!runId || !subject) {
        console.error("Usage: agentgit-authority [--json] submit-draft-create <run-id> <subject> <body>");
        process.exitCode = 1;
        return;
      }

      const body = bodyParts.join(" ");
      const result = await client.submitActionAttempt({
        run_id: runId,
        tool_registration: {
          tool_name: "drafts_create",
          tool_kind: "function",
        },
        raw_call: {
          integration: "drafts",
          operation: "create_draft",
          subject,
          body,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-draft-archive": {
      const [runId, draftId] = rest;

      if (!runId || !draftId) {
        console.error("Usage: agentgit-authority [--json] submit-draft-archive <run-id> <draft-id>");
        process.exitCode = 1;
        return;
      }

      const result = await client.submitActionAttempt({
        run_id: runId,
        tool_registration: {
          tool_name: "drafts_archive",
          tool_kind: "function",
        },
        raw_call: {
          integration: "drafts",
          operation: "archive_draft",
          draft_id: draftId,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-draft-delete": {
      const [runId, draftId] = rest;

      if (!runId || !draftId) {
        console.error("Usage: agentgit-authority [--json] submit-draft-delete <run-id> <draft-id>");
        process.exitCode = 1;
        return;
      }

      const result = await client.submitActionAttempt({
        run_id: runId,
        tool_registration: {
          tool_name: "drafts_delete",
          tool_kind: "function",
        },
        raw_call: {
          integration: "drafts",
          operation: "delete_draft",
          draft_id: draftId,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-draft-unarchive": {
      const [runId, draftId] = rest;

      if (!runId || !draftId) {
        console.error("Usage: agentgit-authority [--json] submit-draft-unarchive <run-id> <draft-id>");
        process.exitCode = 1;
        return;
      }

      const result = await client.submitActionAttempt({
        run_id: runId,
        tool_registration: {
          tool_name: "drafts_unarchive",
          tool_kind: "function",
        },
        raw_call: {
          integration: "drafts",
          operation: "unarchive_draft",
          draft_id: draftId,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-draft-update": {
      const [runId, draftId, subject, ...bodyParts] = rest;

      if (!runId || !draftId || !subject) {
        console.error("Usage: agentgit-authority [--json] submit-draft-update <run-id> <draft-id> <subject> <body>");
        process.exitCode = 1;
        return;
      }

      const body = bodyParts.join(" ");
      const result = await client.submitActionAttempt({
        run_id: runId,
        tool_registration: {
          tool_name: "drafts_update",
          tool_kind: "function",
        },
        raw_call: {
          integration: "drafts",
          operation: "update_draft",
          draft_id: draftId,
          subject,
          body,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-draft-add-label": {
      const [runId, draftId, label] = rest;

      if (!runId || !draftId || !label) {
        console.error("Usage: agentgit-authority [--json] submit-draft-add-label <run-id> <draft-id> <label>");
        process.exitCode = 1;
        return;
      }

      const result = await client.submitActionAttempt({
        run_id: runId,
        tool_registration: {
          tool_name: "drafts_add_label",
          tool_kind: "function",
        },
        raw_call: {
          integration: "drafts",
          operation: "add_label",
          draft_id: draftId,
          label,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-draft-remove-label": {
      const [runId, draftId, label] = rest;

      if (!runId || !draftId || !label) {
        console.error("Usage: agentgit-authority [--json] submit-draft-remove-label <run-id> <draft-id> <label>");
        process.exitCode = 1;
        return;
      }

      const result = await client.submitActionAttempt({
        run_id: runId,
        tool_registration: {
          tool_name: "drafts_remove_label",
          tool_kind: "function",
        },
        raw_call: {
          integration: "drafts",
          operation: "remove_label",
          draft_id: draftId,
          label,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-draft-restore": {
      const [runId, draftId, ...stateParts] = rest;

      if (!runId || !draftId || stateParts.length === 0) {
        console.error("Usage: agentgit-authority [--json] submit-draft-restore <run-id> <draft-id> <state-json>");
        process.exitCode = 1;
        return;
      }

      let state: Record<string, unknown>;
      try {
        const parsed = JSON.parse(stateParts.join(" "));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("state must be an object");
        }
        state = parsed as Record<string, unknown>;
      } catch (error) {
        console.error(
          `submit-draft-restore expects JSON like {"subject":"...","body":"...","status":"active|archived|deleted","labels":[]}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        process.exitCode = 1;
        return;
      }

      const result = await client.submitActionAttempt({
        run_id: runId,
        tool_registration: {
          tool_name: "drafts_restore",
          tool_kind: "function",
        },
        raw_call: {
          integration: "drafts",
          operation: "restore_draft",
          draft_id: draftId,
          ...state,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-note-create": {
      const [runId, title, ...bodyParts] = rest;

      if (!runId || !title) {
        console.error("Usage: agentgit-authority [--json] submit-note-create <run-id> <title> <body>");
        process.exitCode = 1;
        return;
      }

      const body = bodyParts.join(" ");
      const result = await client.submitActionAttempt({
        run_id: runId,
        tool_registration: {
          tool_name: "notes_create",
          tool_kind: "function",
        },
        raw_call: {
          integration: "notes",
          operation: "create_note",
          title,
          body,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-note-archive": {
      const [runId, noteId] = rest;

      if (!runId || !noteId) {
        console.error("Usage: agentgit-authority [--json] submit-note-archive <run-id> <note-id>");
        process.exitCode = 1;
        return;
      }

      const result = await client.submitActionAttempt({
        run_id: runId,
        tool_registration: {
          tool_name: "notes_archive",
          tool_kind: "function",
        },
        raw_call: {
          integration: "notes",
          operation: "archive_note",
          note_id: noteId,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-note-unarchive": {
      const [runId, noteId] = rest;

      if (!runId || !noteId) {
        console.error("Usage: agentgit-authority [--json] submit-note-unarchive <run-id> <note-id>");
        process.exitCode = 1;
        return;
      }

      const result = await client.submitActionAttempt({
        run_id: runId,
        tool_registration: {
          tool_name: "notes_unarchive",
          tool_kind: "function",
        },
        raw_call: {
          integration: "notes",
          operation: "unarchive_note",
          note_id: noteId,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-note-delete": {
      const [runId, noteId] = rest;

      if (!runId || !noteId) {
        console.error("Usage: agentgit-authority [--json] submit-note-delete <run-id> <note-id>");
        process.exitCode = 1;
        return;
      }

      const result = await client.submitActionAttempt({
        run_id: runId,
        tool_registration: {
          tool_name: "notes_delete",
          tool_kind: "function",
        },
        raw_call: {
          integration: "notes",
          operation: "delete_note",
          note_id: noteId,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-note-update": {
      const [runId, noteId, title, ...bodyParts] = rest;

      if (!runId || !noteId || !title) {
        console.error("Usage: agentgit-authority [--json] submit-note-update <run-id> <note-id> <title> <body>");
        process.exitCode = 1;
        return;
      }

      const body = bodyParts.join(" ");
      const result = await client.submitActionAttempt({
        run_id: runId,
        tool_registration: {
          tool_name: "notes_update",
          tool_kind: "function",
        },
        raw_call: {
          integration: "notes",
          operation: "update_note",
          note_id: noteId,
          title,
          ...(body.length > 0 ? { body } : {}),
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-note-restore": {
      const [runId, noteId, ...stateParts] = rest;

      if (!runId || !noteId || stateParts.length === 0) {
        console.error("Usage: agentgit-authority [--json] submit-note-restore <run-id> <note-id> <state-json>");
        process.exitCode = 1;
        return;
      }

      let state: Record<string, unknown>;
      try {
        const parsed = JSON.parse(stateParts.join(" "));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("state must be an object");
        }
        state = parsed as Record<string, unknown>;
      } catch (error) {
        console.error(
          `submit-note-restore expects JSON like {"title":"...","body":"...","status":"active|archived|deleted"}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        process.exitCode = 1;
        return;
      }

      const result = await client.submitActionAttempt({
        run_id: runId,
        tool_registration: {
          tool_name: "notes_restore",
          tool_kind: "function",
        },
        raw_call: {
          integration: "notes",
          operation: "restore_note",
          note_id: noteId,
          ...state,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-ticket-create": {
      const [runId, title, ...bodyParts] = rest;

      if (!runId || !title) {
        console.error("Usage: agentgit-authority [--json] submit-ticket-create <run-id> <title> <body>");
        process.exitCode = 1;
        return;
      }

      const body = bodyParts.join(" ");
      const result = await client.submitActionAttempt({
        run_id: runId,
        tool_registration: {
          tool_name: "tickets_create",
          tool_kind: "function",
        },
        raw_call: {
          integration: "tickets",
          operation: "create_ticket",
          title,
          body,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "brokered",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-ticket-update": {
      const [runId, ticketId, title, ...bodyParts] = rest;

      if (!runId || !ticketId || !title) {
        console.error("Usage: agentgit-authority [--json] submit-ticket-update <run-id> <ticket-id> <title> <body>");
        process.exitCode = 1;
        return;
      }

      const body = bodyParts.join(" ");
      const result = await client.submitActionAttempt({
        run_id: runId,
        tool_registration: {
          tool_name: "tickets_update",
          tool_kind: "function",
        },
        raw_call: {
          integration: "tickets",
          operation: "update_ticket",
          ticket_id: ticketId,
          title,
          body,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "brokered",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-ticket-delete": {
      const [runId, ticketId] = rest;

      if (!runId || !ticketId) {
        console.error("Usage: agentgit-authority [--json] submit-ticket-delete <run-id> <ticket-id>");
        process.exitCode = 1;
        return;
      }

      const result = await client.submitActionAttempt({
        run_id: runId,
        tool_registration: {
          tool_name: "tickets_delete",
          tool_kind: "function",
        },
        raw_call: {
          integration: "tickets",
          operation: "delete_ticket",
          ticket_id: ticketId,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "brokered",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-ticket-restore": {
      const [runId, ticketId, ...stateParts] = rest;

      if (!runId || !ticketId || stateParts.length === 0) {
        console.error("Usage: agentgit-authority [--json] submit-ticket-restore <run-id> <ticket-id> <state-json>");
        process.exitCode = 1;
        return;
      }

      let state: Record<string, unknown>;
      try {
        const parsed = JSON.parse(stateParts.join(" "));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("state must be an object");
        }
        state = parsed as Record<string, unknown>;
      } catch (error) {
        console.error(
          `submit-ticket-restore expects JSON like {"title":"...","body":"...","status":"active","labels":[],"assigned_users":[]}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        process.exitCode = 1;
        return;
      }

      const result = await client.submitActionAttempt({
        run_id: runId,
        tool_registration: {
          tool_name: "tickets_restore",
          tool_kind: "function",
        },
        raw_call: {
          integration: "tickets",
          operation: "restore_ticket",
          ticket_id: ticketId,
          ...state,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "brokered",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-ticket-close": {
      const [runId, ticketId] = rest;

      if (!runId || !ticketId) {
        console.error("Usage: agentgit-authority [--json] submit-ticket-close <run-id> <ticket-id>");
        process.exitCode = 1;
        return;
      }

      const result = await client.submitActionAttempt({
        run_id: runId,
        tool_registration: {
          tool_name: "tickets_close",
          tool_kind: "function",
        },
        raw_call: {
          integration: "tickets",
          operation: "close_ticket",
          ticket_id: ticketId,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "brokered",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-ticket-reopen": {
      const [runId, ticketId] = rest;

      if (!runId || !ticketId) {
        console.error("Usage: agentgit-authority [--json] submit-ticket-reopen <run-id> <ticket-id>");
        process.exitCode = 1;
        return;
      }

      const result = await client.submitActionAttempt({
        run_id: runId,
        tool_registration: {
          tool_name: "tickets_reopen",
          tool_kind: "function",
        },
        raw_call: {
          integration: "tickets",
          operation: "reopen_ticket",
          ticket_id: ticketId,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "brokered",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-ticket-add-label": {
      const [runId, ticketId, label] = rest;

      if (!runId || !ticketId || !label) {
        console.error("Usage: agentgit-authority [--json] submit-ticket-add-label <run-id> <ticket-id> <label>");
        process.exitCode = 1;
        return;
      }

      const result = await client.submitActionAttempt({
        run_id: runId,
        tool_registration: {
          tool_name: "tickets_add_label",
          tool_kind: "function",
        },
        raw_call: {
          integration: "tickets",
          operation: "add_label",
          ticket_id: ticketId,
          label,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "brokered",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-ticket-remove-label": {
      const [runId, ticketId, label] = rest;

      if (!runId || !ticketId || !label) {
        console.error("Usage: agentgit-authority [--json] submit-ticket-remove-label <run-id> <ticket-id> <label>");
        process.exitCode = 1;
        return;
      }

      const result = await client.submitActionAttempt({
        run_id: runId,
        tool_registration: {
          tool_name: "tickets_remove_label",
          tool_kind: "function",
        },
        raw_call: {
          integration: "tickets",
          operation: "remove_label",
          ticket_id: ticketId,
          label,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "brokered",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-ticket-assign-user": {
      const [runId, ticketId, userId] = rest;

      if (!runId || !ticketId || !userId) {
        console.error("Usage: agentgit-authority [--json] submit-ticket-assign-user <run-id> <ticket-id> <user-id>");
        process.exitCode = 1;
        return;
      }

      const result = await client.submitActionAttempt({
        run_id: runId,
        tool_registration: {
          tool_name: "tickets_assign_user",
          tool_kind: "function",
        },
        raw_call: {
          integration: "tickets",
          operation: "assign_user",
          ticket_id: ticketId,
          user_id: userId,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "brokered",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-ticket-unassign-user": {
      const [runId, ticketId, userId] = rest;

      if (!runId || !ticketId || !userId) {
        console.error("Usage: agentgit-authority [--json] submit-ticket-unassign-user <run-id> <ticket-id> <user-id>");
        process.exitCode = 1;
        return;
      }

      const result = await client.submitActionAttempt({
        run_id: runId,
        tool_registration: {
          tool_name: "tickets_unassign_user",
          tool_kind: "function",
        },
        raw_call: {
          integration: "tickets",
          operation: "unassign_user",
          ticket_id: ticketId,
          user_id: userId,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "brokered",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "plan-recovery": {
      const boundaryId = rest[0];

      if (!boundaryId) {
        console.error("Usage: agentgit-authority [--json] plan-recovery <snapshot-id|action-id>");
        process.exitCode = 1;
        return;
      }

      const result = await client.planRecovery(boundaryId);
      printResult(result, jsonOutput, formatPlanRecovery);
      return;
    }
    case "execute-recovery": {
      const boundaryId = rest[0];

      if (!boundaryId) {
        console.error("Usage: agentgit-authority [--json] execute-recovery <snapshot-id|action-id>");
        process.exitCode = 1;
        return;
      }

      const result = await client.executeRecovery(boundaryId);
      printResult(result, jsonOutput, formatExecuteRecovery);
      return;
    }
    default: {
      console.error(USAGE);
      process.exitCode = 1;
    }
  }
}

const invokedPath = process.argv[1];
const isDirectExecution =
  typeof invokedPath === "string" && import.meta.url === pathToFileURL(invokedPath).href;

if (isDirectExecution) {
  main().catch((error: unknown) => {
    const jsonOutput = wantsJsonOutput(process.argv.slice(2));

    if (jsonOutput) {
      console.error(
        JSON.stringify(
          {
            error: error instanceof Error ? error.message : String(error),
          },
          null,
          2,
        ),
      );
    } else {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }

    process.exit(1);
  });
}
