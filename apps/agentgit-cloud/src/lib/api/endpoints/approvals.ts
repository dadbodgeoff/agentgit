import { fetchJson } from "@/lib/api/client";
import { ApprovalListResponseSchema, type ApprovalListResponse, type PreviewState } from "@/schemas/cloud";

export async function getApprovalQueue(previewState: PreviewState = "ready"): Promise<ApprovalListResponse> {
  const url = new URL("/api/v1/approvals", "http://localhost");
  if (previewState !== "ready") {
    url.searchParams.set("state", previewState);
  }

  const response = await fetchJson<unknown>(url.pathname + url.search);
  return ApprovalListResponseSchema.parse(response);
}
