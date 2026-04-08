import { NextResponse } from "next/server";

import { requireApiSession } from "@/lib/auth/api-session";
import { withWorkspaceAuthorityClient } from "@/lib/backend/authority/client";
import { mapTimelineToRunDetail } from "@/lib/backend/authority/contracts";
import { toAuthorityRouteErrorResponse } from "@/lib/backend/authority/route-errors";
import { getRunFixture } from "@/mocks/fixtures";
import { createRequestId, jsonWithRequestId } from "@/lib/observability/route-response";
import { PreviewStateSchema } from "@/schemas/cloud";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const { unauthorized, workspaceSession } = await requireApiSession(request);

  if (unauthorized) {
    return unauthorized;
  }

  const url = new URL(request.url);
  const parsed = PreviewStateSchema.safeParse(url.searchParams.get("state") ?? "ready");
  const previewState = parsed.success ? parsed.data : "ready";
  const { runId } = await context.params;

  if (previewState === "loading") {
    await sleep(1200);
  }

  if (previewState === "error") {
    return jsonWithRequestId({ message: "Could not load run detail. Retry." }, { status: 500 }, requestId);
  }

  if (previewState !== "ready") {
    return jsonWithRequestId(getRunFixture(runId, previewState), undefined, requestId);
  }

  try {
    const runDetail = await withWorkspaceAuthorityClient(workspaceSession.activeWorkspace.id, (client) =>
      client.queryTimeline(runId),
    );
    return jsonWithRequestId(mapTimelineToRunDetail(runDetail), undefined, requestId);
  } catch (error) {
    return toAuthorityRouteErrorResponse(error, "Could not load run detail. Retry.", {
      requestId,
      route: "run_detail",
    });
  }
}
