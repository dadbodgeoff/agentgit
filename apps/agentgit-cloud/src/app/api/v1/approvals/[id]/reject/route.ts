import { NextResponse } from "next/server";

import { requireApiSession } from "@/lib/auth/api-session";
import { withAuthorityClient } from "@/lib/backend/authority/client";
import { mapResolvedApprovalToCloud } from "@/lib/backend/authority/contracts";
import { toAuthorityRouteErrorResponse } from "@/lib/backend/authority/route-errors";
import { ApprovalDecisionRequestSchema } from "@/schemas/cloud";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { session, unauthorized } = await requireApiSession();

  if (unauthorized || !session) {
    return unauthorized;
  }

  const { id } = await context.params;
  const payload = ApprovalDecisionRequestSchema.parse(await request.json().catch(() => ({})));
  const actorName = session.user.name ?? session.user.email ?? "Workspace reviewer";

  try {
    const result = await withAuthorityClient((client) => client.resolveApproval(id, "denied", payload.comment));
    return NextResponse.json(
      mapResolvedApprovalToCloud(result, actorName, "Action rejected. The agent has been paused."),
    );
  } catch (error) {
    return toAuthorityRouteErrorResponse(error, "Could not submit the rejection decision. Retry.");
  }
}
