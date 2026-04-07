import type { QueryApprovalInboxResponsePayload, QueryTimelineResponsePayload, ResolveApprovalResponsePayload } from "@agentgit/schemas";

import {
  ApprovalDecisionResponseSchema,
  ApprovalListResponseSchema,
  RunDetailSchema,
  type ApprovalListItem,
  type ApprovalResolvedStatus,
  type RunStatus,
} from "@/schemas/cloud";

function mapApprovalStatus(status: "pending" | "approved" | "denied"): ApprovalListItem["status"] {
  return status === "denied" ? "rejected" : status;
}

function mapApprovalResolvedStatus(status: "approved" | "denied"): ApprovalResolvedStatus {
  return status === "denied" ? "rejected" : "approved";
}

function mapApprovalDomain(domain: string): ApprovalListItem["domain"] {
  switch (domain) {
    case "shell":
    case "git":
    case "filesystem":
    case "network":
    case "deploy":
    case "policy":
      return domain;
    default:
      return "policy";
  }
}

function deriveRunStatus(payload: QueryTimelineResponsePayload): RunStatus {
  if (payload.steps.length === 0) {
    return "queued";
  }

  if (payload.steps.some((step) => step.status === "failed")) {
    return "failed";
  }

  if (payload.steps.some((step) => step.status === "cancelled")) {
    return "canceled";
  }

  if (payload.steps.some((step) => step.status === "blocked" || step.status === "awaiting_approval" || step.status === "partial")) {
    return "running";
  }

  return "completed";
}

function buildRunSummaryText(params: {
  actionCount: number;
  actionsAsked: number;
  snapshotsTaken: number;
  workflowName: string;
}): string {
  const parts = [
    `${params.workflowName} recorded ${params.actionCount} governed action${params.actionCount === 1 ? "" : "s"}`,
    `${params.actionsAsked} approval gate${params.actionsAsked === 1 ? "" : "s"}`,
    `${params.snapshotsTaken} snapshot${params.snapshotsTaken === 1 ? "" : "s"}`,
  ];

  return `${parts.join(", ")}.`;
}

export function mapApprovalInboxToCloud(payload: QueryApprovalInboxResponsePayload) {
  return ApprovalListResponseSchema.parse({
    items: payload.items.map((item) => ({
      id: item.approval_id,
      runId: item.run_id,
      actionId: item.action_id,
      workflowName: item.workflow_name,
      domain: mapApprovalDomain(item.action_domain),
      sideEffectLevel: item.side_effect_level,
      status: mapApprovalStatus(item.status),
      requestedAt: item.requested_at,
      resolvedAt: item.resolved_at ?? undefined,
      resolutionNote: item.resolution_note ?? undefined,
      actionSummary: item.action_summary,
      reasonSummary: item.reason_summary,
      targetLocator: item.target_locator,
      targetLabel: item.target_label ?? undefined,
      snapshotRequired: item.snapshot_required,
    })),
    total: payload.items.length,
    page: 1,
    per_page: payload.items.length === 0 ? 25 : payload.items.length,
    has_more: false,
  });
}

export function mapResolvedApprovalToCloud(
  payload: ResolveApprovalResponsePayload,
  actorName: string,
  fallbackMessage: string,
) {
  const status =
    payload.approval_request.status === "approved" || payload.approval_request.status === "denied"
      ? mapApprovalResolvedStatus(payload.approval_request.status)
      : "rejected";

  return ApprovalDecisionResponseSchema.parse({
    id: payload.approval_request.approval_id,
    status,
    resolvedByName: actorName,
    resolvedAt: payload.approval_request.resolved_at ?? new Date().toISOString(),
    message: fallbackMessage,
    comment: payload.approval_request.resolution_note ?? undefined,
  });
}

export function mapTimelineToRunDetail(payload: QueryTimelineResponsePayload) {
  const actionSteps = payload.steps.filter((step) => step.step_type === "action_step");
  const approvalSteps = payload.steps.filter((step) => step.step_type === "approval_step");
  const snapshotIds = new Set(
    payload.steps
      .map((step) => step.related.snapshot_id ?? null)
      .filter((snapshotId): snapshotId is string => typeof snapshotId === "string" && snapshotId.length > 0),
  );

  const actionsAllowed = actionSteps.filter(
    (step) => step.decision === "allow" || step.decision === "allow_with_snapshot",
  ).length;
  const actionsDenied = actionSteps.filter((step) => step.decision === "deny").length;
  const runtime = `${payload.run_summary.agent_framework} / ${payload.run_summary.agent_name}`;
  const endedAt = payload.steps[payload.steps.length - 1]?.occurred_at ?? payload.run_summary.started_at;

  return RunDetailSchema.parse({
    id: payload.run_summary.run_id,
    workflowName: payload.run_summary.workflow_name,
    agentName: payload.run_summary.agent_name,
    agentFramework: payload.run_summary.agent_framework,
    workspaceRoots: payload.run_summary.workspace_roots,
    projectionStatus: payload.projection_status,
    runtime,
    status: deriveRunStatus(payload),
    startedAt: payload.run_summary.started_at,
    endedAt,
    actionCount: actionSteps.length,
    actionsAllowed,
    actionsDenied,
    actionsAsked: approvalSteps.length,
    snapshotsTaken: snapshotIds.size,
    summary: buildRunSummaryText({
      actionCount: actionSteps.length,
      actionsAsked: approvalSteps.length,
      snapshotsTaken: snapshotIds.size,
      workflowName: payload.run_summary.workflow_name,
    }),
    steps: payload.steps.map((step) => ({
      id: step.step_id,
      sequence: step.sequence,
      title: step.title,
      stepType: step.step_type,
      status: step.status,
      actionId: step.action_id ?? undefined,
      decision: step.decision,
      summary: step.summary,
      occurredAt: step.occurred_at,
      snapshotId: step.related.snapshot_id ?? undefined,
    })),
  });
}
