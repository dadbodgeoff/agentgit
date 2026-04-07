import { NextResponse } from "next/server";

import { requireApiRole } from "@/lib/auth/api-session";
import { getRepositoryCalibrationReport } from "@/lib/backend/authority/calibration";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";
import { getCalibrationFixture } from "@/mocks/fixtures";
import { PreviewStateSchema } from "@/schemas/cloud";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(
  request: Request,
  context: { params: Promise<{ repoId: string }> },
): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const access = await requireApiRole("admin");

  if (access.denied) {
    return access.denied;
  }

  const url = new URL(request.url);
  const parsed = PreviewStateSchema.safeParse(url.searchParams.get("state") ?? "ready");
  const previewState = parsed.success ? parsed.data : "ready";
  const { repoId } = await context.params;

  if (previewState === "loading") {
    await sleep(1200);
  }

  if (previewState === "error") {
    return jsonWithRequestId({ message: "Could not load calibration data. Retry." }, { status: 500 }, requestId);
  }

  if (previewState !== "ready") {
    return jsonWithRequestId(getCalibrationFixture(previewState), undefined, requestId);
  }

  try {
    const calibration = await getRepositoryCalibrationReport(repoId);
    if (!calibration) {
      return jsonWithRequestId({ message: "Repository calibration data was not found." }, { status: 404 }, requestId);
    }

    return jsonWithRequestId(calibration, undefined, requestId);
  } catch (error) {
    logRouteError("repository_calibration", requestId, error, { repoId });
    return jsonWithRequestId({ message: "Could not load calibration data. Retry." }, { status: 500 }, requestId);
  }
}
