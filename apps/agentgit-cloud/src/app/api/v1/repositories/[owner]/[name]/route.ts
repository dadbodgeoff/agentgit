import { NextResponse } from "next/server";

import { requireApiSession } from "@/lib/auth/api-session";
import { hasRepositoryRouteAccess } from "@/lib/backend/workspace/repository-route-access";
import { getRepositoryDetail } from "@/lib/backend/workspace/repository-detail";
import { createRequestId, jsonWithRequestId } from "@/lib/observability/route-response";
import { PreviewStateSchema } from "@/schemas/cloud";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(
  request: Request,
  context: { params: Promise<{ owner: string; name: string }> },
): Promise<NextResponse> {
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
    return jsonWithRequestId({ message: "Could not load repository detail. Retry." }, { status: 500 }, requestId);
  }

  const { owner, name } = await context.params;
  if (!(await hasRepositoryRouteAccess({ owner, name, workspaceId: workspaceSession.activeWorkspace.id }))) {
    return jsonWithRequestId({ message: "Repository not found in the active workspace." }, { status: 404 }, requestId);
  }
  const detail = await getRepositoryDetail(owner, name, workspaceSession.activeWorkspace.id);

  if (!detail) {
    return jsonWithRequestId({ message: "Repository not found in the active workspace." }, { status: 404 }, requestId);
  }

  return jsonWithRequestId(detail, undefined, requestId);
}
