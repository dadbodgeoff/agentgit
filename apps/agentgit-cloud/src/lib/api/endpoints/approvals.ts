import { fetchJson } from "@/lib/api/client";
import {
  ApprovalDecisionResponseSchema,
  ApprovalListResponseSchema,
  type ApprovalDecisionResponse,
  type ApprovalListResponse,
  type PreviewState,
} from "@/schemas/cloud";

export async function getApprovalQueue(previewState: PreviewState = "ready"): Promise<ApprovalListResponse> {
  const url = new URL("/api/v1/approvals", "http://localhost");
  if (previewState !== "ready") {
    url.searchParams.set("state", previewState);
  }

  const response = await fetchJson<unknown>(url.pathname + url.search);
  return ApprovalListResponseSchema.parse(response);
}

export async function approveApproval(approvalId: string, comment?: string): Promise<ApprovalDecisionResponse> {
  const response = await fetchJson<unknown>(`/api/v1/approvals/${approvalId}/approve`, {
    method: "POST",
    body: JSON.stringify({ comment }),
  });

  return ApprovalDecisionResponseSchema.parse(response);
}

export async function rejectApproval(approvalId: string, comment?: string): Promise<ApprovalDecisionResponse> {
  const response = await fetchJson<unknown>(`/api/v1/approvals/${approvalId}/reject`, {
    method: "POST",
    body: JSON.stringify({ comment }),
  });

  return ApprovalDecisionResponseSchema.parse(response);
}
