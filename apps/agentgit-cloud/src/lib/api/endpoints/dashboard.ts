import { fetchJson } from "@/lib/api/client";
import { DashboardSummarySchema, type DashboardSummary, type PreviewState } from "@/schemas/cloud";

export async function getDashboardSummary(previewState: PreviewState = "ready"): Promise<DashboardSummary> {
  const url = new URL("/api/v1/dashboard", "http://localhost");
  if (previewState !== "ready") {
    url.searchParams.set("state", previewState);
  }

  const response = await fetchJson<unknown>(url.pathname + url.search);
  return DashboardSummarySchema.parse(response);
}
