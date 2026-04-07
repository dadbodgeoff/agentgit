import { fetchJson } from "@/lib/api/client";
import { RunDetailSchema, type PreviewState, type RunDetail } from "@/schemas/cloud";

export async function getRunDetail(runId: string, previewState: PreviewState = "ready"): Promise<RunDetail> {
  const url = new URL(`/api/v1/runs/${runId}`, "http://localhost");
  if (previewState !== "ready") {
    url.searchParams.set("state", previewState);
  }

  const response = await fetchJson<unknown>(url.pathname + url.search);
  return RunDetailSchema.parse(response);
}
