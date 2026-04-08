import { NextResponse } from "next/server";

import { requireApiSession } from "@/lib/auth/api-session";
import { listWorkspaceApprovalQueue } from "@/lib/backend/workspace/workspace-approvals";
import { getApprovalsFixture } from "@/mocks/fixtures";
import { createRequestId, jsonWithRequestId } from "@/lib/observability/route-response";
import { PreviewStateSchema } from "@/schemas/cloud";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(request: Request): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const { unauthorized, workspaceSession } = await requireApiSession(request);

  if (unauthorized) {
    return unauthorized;
  }

  const url = new URL(request.url);
  const parsed = PreviewStateSchema.safeParse(url.searchParams.get("state") ?? "ready");
  const previewState = parsed.success ? parsed.data : "ready";

  if (previewState === "loading") {
    await sleep(1200);
  }

  if (previewState === "error") {
    return jsonWithRequestId({ message: "Could not load approvals. Retry." }, { status: 500 }, requestId);
  }

  if (previewState !== "ready") {
    return jsonWithRequestId(getApprovalsFixture(previewState), undefined, requestId);
  }

  try {
    return jsonWithRequestId(await listWorkspaceApprovalQueue(workspaceSession.activeWorkspace.id), undefined, requestId);
  } catch {
    return jsonWithRequestId({ message: "Could not load approvals. Retry." }, { status: 500 }, requestId);
  }
}
