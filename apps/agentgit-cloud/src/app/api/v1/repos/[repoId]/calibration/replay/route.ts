import { requireApiRole } from "@/lib/auth/api-session";
import { replayRepositoryCalibrationThresholds } from "@/lib/backend/authority/calibration";
import { readJsonBody, JsonBodyParseError } from "@/lib/http/request-body";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";
import { CalibrationReplayRequestSchema } from "@/schemas/cloud";

export async function POST(
  request: Request,
  context: { params: Promise<{ repoId: string }> },
) {
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

  const payload = CalibrationReplayRequestSchema.safeParse(rawPayload);
  if (!payload.success) {
    return jsonWithRequestId({ message: "Calibration replay payload is invalid." }, { status: 400 }, requestId);
  }

  const { repoId } = await context.params;

  try {
    const replay = await replayRepositoryCalibrationThresholds(
      repoId,
      access.workspaceSession.activeWorkspace.id,
      payload.data.candidateThresholds,
    );
    if (!replay) {
      return jsonWithRequestId({ message: "Repository calibration data was not found." }, { status: 404 }, requestId);
    }

    return jsonWithRequestId(replay, undefined, requestId);
  } catch (error) {
    logRouteError("repository_calibration_replay", requestId, error, { repoId });
    return jsonWithRequestId({ message: "Could not replay calibration thresholds. Retry." }, { status: 500 }, requestId);
  }
}
