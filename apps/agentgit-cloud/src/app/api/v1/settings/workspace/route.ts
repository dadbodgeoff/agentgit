import { NextResponse } from "next/server";

import { requireApiRole } from "@/lib/auth/api-session";
import { findWorkspaceConnectionStateBySlug } from "@/lib/backend/workspace/cloud-state";
import {
  resolveWorkspaceSettings,
  saveWorkspaceSettings,
  WorkspaceSettingsValidationError,
} from "@/lib/backend/workspace/workspace-settings";
import { readJsonBody, JsonBodyParseError } from "@/lib/http/request-body";
import { createRequestId, jsonWithRequestId } from "@/lib/observability/route-response";
import { WorkspaceSettingsUpdateSchema } from "@/schemas/cloud";

export async function GET(request: Request): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const access = await requireApiRole("admin", request);

  if (access.denied) {
    return access.denied;
  }

  return jsonWithRequestId(await resolveWorkspaceSettings(access.workspaceSession), undefined, requestId);
}

export async function PUT(request: Request): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const access = await requireApiRole("admin", request);

  if (access.denied) {
    return access.denied;
  }

  let rawPayload: unknown;
  try {
    rawPayload = await readJsonBody(request);
  } catch (error) {
    if (error instanceof JsonBodyParseError) {
      return jsonWithRequestId({ message: error.message }, { status: 400 }, requestId);
    }

    throw error;
  }

  const payload = WorkspaceSettingsUpdateSchema.safeParse(rawPayload);

  if (!payload.success) {
    return jsonWithRequestId({ message: "Settings payload is invalid." }, { status: 400 }, requestId);
  }

  const matchingWorkspace = await findWorkspaceConnectionStateBySlug(payload.data.workspaceSlug);
  if (matchingWorkspace && matchingWorkspace.workspaceId !== access.workspaceSession.activeWorkspace.id) {
    return jsonWithRequestId({ message: "Workspace slug is already in use." }, { status: 409 }, requestId);
  }

  try {
    return jsonWithRequestId(await saveWorkspaceSettings(access.workspaceSession, payload.data), undefined, requestId);
  } catch (error) {
    if (error instanceof WorkspaceSettingsValidationError) {
      return jsonWithRequestId(
        {
          message: error.message,
          field: error.field,
        },
        { status: 400 },
        requestId,
      );
    }

    return jsonWithRequestId(
      {
        message: "Could not save workspace settings.",
      },
      { status: 400 },
      requestId,
    );
  }
}
