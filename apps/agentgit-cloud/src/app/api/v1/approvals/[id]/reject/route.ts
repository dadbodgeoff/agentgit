import { NextResponse } from "next/server";

import { requireApiSession } from "@/lib/auth/api-session";
import { withWorkspaceAuthorityClient } from "@/lib/backend/authority/client";
import { mapResolvedApprovalToCloud } from "@/lib/backend/authority/contracts";
import { toAuthorityRouteErrorResponse } from "@/lib/backend/authority/route-errors";
import { createRequestId, jsonWithRequestId } from "@/lib/observability/route-response";
import { ApprovalDecisionRequestSchema } from "@/schemas/cloud";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const { session, unauthorized, workspaceSession } = await requireApiSession();

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

  try {
    const result = await withWorkspaceAuthorityClient(workspaceSession.activeWorkspace.id, (client) =>
      client.resolveApproval(id, "denied", payload.data.comment),
    );
    return jsonWithRequestId(
      mapResolvedApprovalToCloud(result, actorName, "Action rejected. The agent has been paused."),
      undefined,
      requestId,
    );
  } catch (error) {
    return toAuthorityRouteErrorResponse(error, "Could not submit the rejection decision. Retry.", { requestId });
  }
}
