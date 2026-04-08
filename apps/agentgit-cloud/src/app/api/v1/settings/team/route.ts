import { NextResponse } from "next/server";

import { requireApiRole } from "@/lib/auth/api-session";
import { resolveWorkspaceTeam, saveWorkspaceTeam } from "@/lib/backend/workspace/workspace-team";
import { WorkspaceBillingLimitError } from "@/lib/backend/workspace/workspace-billing";
import { createRequestId, jsonWithRequestId } from "@/lib/observability/route-response";
import { WorkspaceTeamUpdateSchema } from "@/schemas/cloud";

export async function GET(request: Request): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const access = await requireApiRole("admin", request);

  if (access.denied) {
    return access.denied;
  }

  return jsonWithRequestId(await resolveWorkspaceTeam(access.workspaceSession), undefined, requestId);
}

export async function PUT(request: Request): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const access = await requireApiRole("admin", request);

  if (access.denied) {
    return access.denied;
  }

  const body = await request.json().catch(() => null);
  const parsed = WorkspaceTeamUpdateSchema.safeParse(body);

  if (!parsed.success) {
    return jsonWithRequestId(
      { message: "Team update payload is invalid.", issues: parsed.error.flatten() },
      { status: 400 },
      requestId,
    );
  }

  try {
    return jsonWithRequestId(await saveWorkspaceTeam(access.workspaceSession, parsed.data), undefined, requestId);
  } catch (error) {
    if (error instanceof WorkspaceBillingLimitError) {
      return jsonWithRequestId(
        { message: error.message, breaches: error.breaches },
        { status: 409 },
        requestId,
      );
    }

    throw error;
  }
}
