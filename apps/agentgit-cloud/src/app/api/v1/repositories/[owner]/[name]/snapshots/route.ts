import { NextResponse } from "next/server";

import { requireApiSession } from "@/lib/auth/api-session";
import { listRepositorySnapshots } from "@/lib/backend/workspace/repository-snapshots";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";
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
    return jsonWithRequestId({ message: "Could not load repository snapshots. Retry." }, { status: 500 }, requestId);
  }

  const { owner, name } = await context.params;

  try {
    const snapshots = await listRepositorySnapshots(owner, name, workspaceSession.activeWorkspace.id);
    if (!snapshots) {
      return jsonWithRequestId({ message: "Repository not found in the active workspace." }, { status: 404 }, requestId);
    }

    return jsonWithRequestId(snapshots, undefined, requestId);
  } catch (error) {
    logRouteError("repository_snapshots_get", requestId, error, { owner, name });
    return jsonWithRequestId({ message: "Could not load repository snapshots. Retry." }, { status: 500 }, requestId);
  }
}
