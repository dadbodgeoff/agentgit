import { NextResponse } from "next/server";

import { requireApiRole } from "@/lib/auth/api-session";
import {
  findWorkspaceConnectionStateBySlug,
} from "@/lib/backend/workspace/cloud-state";
import { resolveWorkspaceSettings, saveWorkspaceSettings } from "@/lib/backend/workspace/workspace-settings";
import { createRequestId, jsonWithRequestId } from "@/lib/observability/route-response";
import { WorkspaceSettingsSchema } from "@/schemas/cloud";

export async function GET(request: Request): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const access = await requireApiRole("admin");

  if (access.denied) {
    return access.denied;
  }

  return jsonWithRequestId(resolveWorkspaceSettings(access.workspaceSession), undefined, requestId);
}

export async function PUT(request: Request): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const access = await requireApiRole("admin");

  if (access.denied) {
    return access.denied;
  }

  const payload = WorkspaceSettingsSchema.safeParse(await request.json().catch(() => ({})));

  if (!payload.success) {
    return jsonWithRequestId({ message: "Settings payload is invalid." }, { status: 400 }, requestId);
  }

  const matchingWorkspace = findWorkspaceConnectionStateBySlug(payload.data.workspaceSlug);
  if (matchingWorkspace && matchingWorkspace.workspaceId !== access.workspaceSession.activeWorkspace.id) {
    return jsonWithRequestId({ message: "Workspace slug is already in use." }, { status: 409 }, requestId);
  }

  return jsonWithRequestId(
    saveWorkspaceSettings(access.workspaceSession, payload.data),
    undefined,
    requestId,
  );
}
