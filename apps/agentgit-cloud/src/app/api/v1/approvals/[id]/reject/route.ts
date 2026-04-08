import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { requireApiSession } from "@/lib/auth/api-session";
import {
  ConnectorAccessError,
  findConnectorForRepository,
  getRepositoryConnectorAvailability,
  queueConnectorCommand,
} from "@/lib/backend/control-plane/connectors";
import { readJsonBody, JsonBodyParseError } from "@/lib/http/request-body";
import { getWorkspaceApprovalProjection } from "@/lib/backend/workspace/workspace-approvals";
import { appendWorkspaceAuditEntry } from "@/lib/backend/workspace/workspace-audit-events";
import { createRequestId, jsonWithRequestId } from "@/lib/observability/route-response";
import { validateCsrfRequest } from "@/lib/security/csrf";
import { ApprovalDecisionRequestSchema } from "@/schemas/cloud";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const { session, unauthorized, workspaceSession } = await requireApiSession(request);

  if (unauthorized || !session) {
    return unauthorized;
  }

  const csrfError = validateCsrfRequest(request);
  if (csrfError) {
    return jsonWithRequestId({ message: csrfError }, { status: 403 }, requestId);
  }

  const { id } = await context.params;
  let rawPayload: unknown;
  try {
    rawPayload = await readJsonBody(request);
  } catch (error) {
    if (error instanceof JsonBodyParseError) {
      return jsonWithRequestId({ message: error.message }, { status: 400 }, requestId);
    }

    throw error;
  }

  const payload = ApprovalDecisionRequestSchema.safeParse(rawPayload);
  if (!payload.success) {
    return jsonWithRequestId(
      { message: "Approval decision payload is invalid.", issues: payload.error.flatten() },
      { status: 400 },
      requestId,
    );
  }
  const actorName = session.user.name ?? session.user.email ?? "Workspace reviewer";
  const queuedAt = new Date().toISOString();
  const approval = await getWorkspaceApprovalProjection(workspaceSession.activeWorkspace.id, id);
  const appendDuplicateDecisionAudit = async (details: string) =>
    appendWorkspaceAuditEntry({
      workspaceId: workspaceSession.activeWorkspace.id,
      id: `approval:${id}:reject:${randomUUID()}`,
      occurredAt: queuedAt,
      actorLabel: actorName,
      actorType: "human",
      category: "approval",
      action: "approval_rejected_duplicate",
      target: approval?.actionSummary ?? id,
      outcome: "warning",
      repo: approval ? `${approval.repositoryOwner}/${approval.repositoryName}` : null,
      runId: approval?.runId ?? null,
      actionId: approval?.actionId ?? null,
      detailPath:
        approval?.runId && approval?.actionId
          ? `/repositories/${approval.repositoryOwner}/${approval.repositoryName}/runs/${approval.runId}/actions/${approval.actionId}`
          : null,
      externalUrl: null,
      details,
    });

  if (!approval) {
    return jsonWithRequestId({ message: "Approval request was not found." }, { status: 404 }, requestId);
  }

  if (
    approval.decisionCommandStatus === "pending" ||
    approval.decisionCommandStatus === "acked" ||
    approval.decisionCommandStatus === "completed"
  ) {
    await appendDuplicateDecisionAudit("Approval reject replay was rejected because the decision is already queued.");
    return jsonWithRequestId(
      {
        id,
        status: "rejected",
        resolvedByName: actorName,
        resolvedAt: approval.resolvedAt ?? queuedAt,
        message: "Approval is already queued for connector delivery.",
        comment: approval.resolutionNote,
      },
      { status: 409 },
      requestId,
    );
  }

  if (approval.status !== "pending") {
    await appendDuplicateDecisionAudit("Approval reject replay was rejected because the decision is already settled.");
    return jsonWithRequestId(
      {
        id,
        status: approval.status === "approved" ? "approved" : approval.status === "expired" ? "expired" : "rejected",
        resolvedByName: actorName,
        resolvedAt: approval.resolvedAt ?? queuedAt,
        message:
          approval.status === "expired"
            ? "This approval timed out before the connector could deliver a reviewer decision."
            : "This approval has already been resolved in the workspace control plane.",
        comment: approval.resolutionNote,
      },
      { status: 409 },
      requestId,
    );
  }

  try {
    const connector = findConnectorForRepository(
      workspaceSession.activeWorkspace.id,
      approval.repositoryOwner,
      approval.repositoryName,
    );
    if (!connector) {
      const availability = getRepositoryConnectorAvailability(
        workspaceSession.activeWorkspace.id,
        approval.repositoryOwner,
        approval.repositoryName,
      );
      return jsonWithRequestId(
        {
          message:
            availability.reason ??
            "No active connector is available for this repository. Reconnect the workspace agent and retry.",
        },
        { status: 409 },
        requestId,
      );
    }

    queueConnectorCommand(
      workspaceSession,
      connector.id,
      {
        type: "resolve_approval",
        approvalId: id,
        resolution: "denied",
        note: payload.data.comment,
      },
      queuedAt,
    );

    return jsonWithRequestId(
      {
        id,
        status: "rejected",
        resolvedByName: actorName,
        resolvedAt: queuedAt,
        message: `Rejection queued for ${connector.machineName}. The connector will deliver it locally and keep the run paused.`,
        comment: payload.data.comment,
      },
      { status: 202 },
      requestId,
    );
  } catch (error) {
    if (error instanceof ConnectorAccessError) {
      return jsonWithRequestId({ message: error.message }, { status: error.statusCode }, requestId);
    }

    return jsonWithRequestId(
      { message: "Could not submit the rejection decision. Retry." },
      { status: 500 },
      requestId,
    );
  }
}
