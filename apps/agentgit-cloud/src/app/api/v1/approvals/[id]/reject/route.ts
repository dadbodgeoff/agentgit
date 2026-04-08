import { NextResponse } from "next/server";

import { requireApiSession } from "@/lib/auth/api-session";
import {
  ConnectorAccessError,
  findConnectorForRepository,
  getRepositoryConnectorAvailability,
  queueConnectorCommand,
} from "@/lib/backend/control-plane/connectors";
import { getWorkspaceApprovalProjection } from "@/lib/backend/workspace/workspace-approvals";
import { createRequestId, jsonWithRequestId } from "@/lib/observability/route-response";
import { ApprovalDecisionRequestSchema } from "@/schemas/cloud";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const { session, unauthorized, workspaceSession } = await requireApiSession(request);

  if (unauthorized || !session) {
    return unauthorized;
  }

  const { id } = await context.params;
  const payload = ApprovalDecisionRequestSchema.safeParse(await request.json().catch(() => ({})));
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

  if (!approval) {
    return jsonWithRequestId({ message: "Approval request was not found." }, { status: 404 }, requestId);
  }

  if (approval.commandStatus === "pending" || approval.commandStatus === "acked" || approval.commandStatus === "completed") {
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

    return jsonWithRequestId({ message: "Could not submit the rejection decision. Retry." }, { status: 500 }, requestId);
  }
}
