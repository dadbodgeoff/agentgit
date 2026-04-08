import { NextResponse } from "next/server";

import { requireApiRole } from "@/lib/auth/api-session";
import { getRepositoryCalibrationReport } from "@/lib/backend/authority/calibration";
import { loadPreviewFixture, resolvePreviewState } from "@/lib/dev/preview-fixtures";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(request: Request, context: { params: Promise<{ repoId: string }> }): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const access = await requireApiRole("admin", request);

  if (access.denied) {
    return access.denied;
  }

  const previewState = resolvePreviewState(request);
  const { repoId } = await context.params;

  if (previewState === "loading") {
    await sleep(1200);
  }

  if (previewState === "error") {
    return jsonWithRequestId({ message: "Could not load calibration data. Retry." }, { status: 500 }, requestId);
  }

  if (previewState !== "ready") {
    const fixture = await loadPreviewFixture("calibration", previewState);
    if (fixture) {
      return jsonWithRequestId(fixture, undefined, requestId);
    }
  }

  try {
    const calibration = await getRepositoryCalibrationReport(repoId, access.workspaceSession.activeWorkspace.id);
    if (!calibration) {
      return jsonWithRequestId({ message: "Repository calibration data was not found." }, { status: 404 }, requestId);
    }

    return jsonWithRequestId(calibration, undefined, requestId);
  } catch (error) {
    logRouteError("repository_calibration", requestId, error, { repoId });
    return jsonWithRequestId({ message: "Could not load calibration data. Retry." }, { status: 500 }, requestId);
  }
}
