import { fetchJson } from "@/lib/api/client";
import {
  CalibrationReplayPreviewSchema,
  CalibrationReplayRequestSchema,
  CalibrationReportSchema,
  type CalibrationReplayPreview,
  type CalibrationReplayRequest,
  type CalibrationReport,
  type PreviewState,
} from "@/schemas/cloud";

export async function getCalibrationReport(
  repoId: string,
  previewState: PreviewState = "ready",
): Promise<CalibrationReport> {
  const url = new URL(`/api/v1/repos/${repoId}/calibration`, "http://localhost");
  if (previewState !== "ready") {
    url.searchParams.set("state", previewState);
  }

  const response = await fetchJson<unknown>(url.pathname + url.search);
  return CalibrationReportSchema.parse(response);
}

export async function replayCalibrationThresholds(
  repoId: string,
  values: CalibrationReplayRequest,
): Promise<CalibrationReplayPreview> {
  const response = await fetchJson<unknown>(`/api/v1/repos/${encodeURIComponent(repoId)}/calibration/replay`, {
    method: "POST",
    body: JSON.stringify(CalibrationReplayRequestSchema.parse(values)),
  });

  return CalibrationReplayPreviewSchema.parse(response);
}
