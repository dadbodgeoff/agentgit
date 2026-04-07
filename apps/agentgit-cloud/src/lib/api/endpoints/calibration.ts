import { fetchJson } from "@/lib/api/client";
import { CalibrationReportSchema, type CalibrationReport, type PreviewState } from "@/schemas/cloud";

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
