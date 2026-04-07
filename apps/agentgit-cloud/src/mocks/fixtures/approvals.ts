import { ApprovalListResponseSchema, type ApprovalListResponse, type PreviewState } from "@/schemas/cloud";

const approvalsReadyFixture = ApprovalListResponseSchema.parse({
  items: [
    {
      id: "appr_x8k2m",
      repo: "acme/api-gateway",
      branch: "feature/auth-refactor",
      status: "pending",
      requestedAt: "2026-04-06T14:31:45Z",
      confidence: 0.28,
      actionSummary: "Shell command rebuild touches deployment output and requires review.",
    },
    {
      id: "appr_q2a7z",
      repo: "acme/platform-ui",
      branch: "main",
      status: "pending",
      requestedAt: "2026-04-06T13:52:00Z",
      confidence: 0.41,
      actionSummary: "Policy asked for approval before updating production environment settings.",
    },
  ],
  total: 2,
  page: 1,
  per_page: 25,
  has_more: false,
});

const approvalsEmptyFixture = ApprovalListResponseSchema.parse({
  items: [],
  total: 0,
  page: 1,
  per_page: 25,
  has_more: false,
});

export function getApprovalsFixture(previewState: PreviewState): ApprovalListResponse {
  return previewState === "empty" ? approvalsEmptyFixture : approvalsReadyFixture;
}
