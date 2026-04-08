import { NextResponse } from "next/server";

import { requireApiSession } from "@/lib/auth/api-session";
import { getDashboardSummaryFromWorkspace } from "@/lib/backend/workspace/dashboard-aggregation";
import { loadPreviewFixture, resolvePreviewState } from "@/lib/dev/preview-fixtures";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(request: Request): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const { unauthorized, workspaceSession } = await requireApiSession(request);

  if (unauthorized) {
    return unauthorized;
  }

  const previewState = resolvePreviewState(request);

  if (previewState === "loading") {
    await sleep(1200);
  }

  if (previewState === "error") {
    return jsonWithRequestId({ message: "Could not load dashboard data. Retry." }, { status: 500 }, requestId);
  }

  if (previewState !== "ready") {
    const fixture = await loadPreviewFixture("dashboard", previewState);
    if (fixture) {
      return jsonWithRequestId(fixture, undefined, requestId);
    }
  }

  try {
    return jsonWithRequestId(
      await getDashboardSummaryFromWorkspace(workspaceSession.activeWorkspace.id),
      undefined,
      requestId,
    );
  } catch (error) {
    logRouteError("dashboard_summary", requestId, error);
    return jsonWithRequestId(
      {
        message: "Could not load dashboard data. Retry.",
      },
      { status: 500 },
      requestId,
    );
  }
}
