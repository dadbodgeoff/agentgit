import { NextResponse } from "next/server";

import { requireApiRole } from "@/lib/auth/api-session";
import {
  resolveWorkspaceIntegrations,
  saveWorkspaceIntegrations,
  WorkspaceIntegrationValidationError,
} from "@/lib/backend/workspace/workspace-integrations";
import { createRequestId, jsonWithRequestId } from "@/lib/observability/route-response";
import { WorkspaceIntegrationUpdateSchema } from "@/schemas/cloud";

export async function GET(request: Request): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const access = await requireApiRole("admin", request);

  if (access.denied) {
    return access.denied;
  }

  return jsonWithRequestId(await resolveWorkspaceIntegrations(access.workspaceSession), undefined, requestId);
}

export async function PUT(request: Request): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const access = await requireApiRole("admin", request);

  if (access.denied) {
    return access.denied;
  }

  const payload = WorkspaceIntegrationUpdateSchema.safeParse(await request.json().catch(() => ({})));

  if (!payload.success) {
    return jsonWithRequestId({ message: "Integration payload is invalid." }, { status: 400 }, requestId);
  }

  try {
    return jsonWithRequestId(
      await saveWorkspaceIntegrations(access.workspaceSession, payload.data),
      undefined,
      requestId,
    );
  } catch (error) {
    if (error instanceof WorkspaceIntegrationValidationError) {
      return jsonWithRequestId(
        {
          message: error.message,
          field: error.field,
        },
        { status: 409 },
        requestId,
      );
    }

    throw error;
  }
}
