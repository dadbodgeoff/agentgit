import { NextResponse } from "next/server";

import { requireApiRole } from "@/lib/auth/api-session";
import {
  resolveWorkspaceIntegrations,
  saveWorkspaceIntegrations,
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

  if (payload.data.slackConnected && payload.data.slackChannelName?.includes("blocked-channel")) {
    return jsonWithRequestId(
      { message: "Slack could not validate that channel. Choose a different destination." },
      { status: 409 },
      requestId,
    );
  }

  return jsonWithRequestId(
    await saveWorkspaceIntegrations(access.workspaceSession, payload.data),
    undefined,
    requestId,
  );
}
