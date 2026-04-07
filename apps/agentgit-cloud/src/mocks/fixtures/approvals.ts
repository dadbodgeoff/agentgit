import {
  ApprovalDecisionResponseSchema,
  ApprovalListResponseSchema,
  type ApprovalDecisionResponse,
  type ApprovalListItem,
  type ApprovalListResponse,
  type ApprovalResolvedStatus,
  type PreviewState,
} from "@/schemas/cloud";

const approvalsReadyFixture = ApprovalListResponseSchema.parse({
  items: [
    {
      id: "appr_x8k2m",
      runId: "run_7f3a2b",
      actionId: "act_b3f7e2",
      workflowName: "repo-fix-auth-refactor",
      domain: "shell",
      sideEffectLevel: "mutating",
      status: "pending",
      requestedAt: "2026-04-06T14:31:45Z",
      actionSummary: "Rebuild clears deployment artifacts before a production build step.",
      reasonSummary:
        "The action clears generated output before a production build step, so the shell threshold requires human review.",
      targetLocator: "workspace://acme/api-gateway",
      targetLabel: "acme/api-gateway",
      snapshotRequired: true,
    },
    {
      id: "appr_q2a7z",
      runId: "run_1m4k8c",
      actionId: "act_91b3ad",
      workflowName: "platform-ui-release",
      domain: "deploy",
      sideEffectLevel: "destructive",
      status: "pending",
      requestedAt: "2026-04-06T13:52:00Z",
      actionSummary: "Production deploy includes a config change and environment variable sync.",
      reasonSummary:
        "This action touches a production environment, and deploy policy requires a named reviewer to confirm intent.",
      targetLocator: "deploy://platform-ui/production",
      targetLabel: "platform-ui production",
      snapshotRequired: false,
    },
    {
      id: "appr_legacy7",
      runId: "run_92aaef",
      actionId: "act_2be901",
      workflowName: "terraform-notifications-rollout",
      domain: "policy",
      sideEffectLevel: "destructive",
      status: "rejected",
      requestedAt: "2026-04-06T11:02:00Z",
      resolvedAt: "2026-04-06T11:18:00Z",
      resolutionNote: "Deployment paused pending a narrower change window.",
      actionSummary: "Terraform notification-module apply waited past the review window.",
      reasonSummary: "Infrastructure policy blocked the rollout until an operator confirms the target scope.",
      targetLocator: "terraform://module.notifications",
      targetLabel: "module.notifications",
      snapshotRequired: false,
    },
  ],
  total: 3,
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

export function findApprovalFixture(approvalId: string): ApprovalListItem | undefined {
  return approvalsReadyFixture.items.find((item) => item.id === approvalId);
}

export function resolveApprovalFixtureDecision({
  actorName,
  approvalId,
  comment,
  decision,
}: {
  actorName: string;
  approvalId: string;
  comment?: string;
  decision: "approve" | "reject";
}):
  | { status: 200; body: ApprovalDecisionResponse }
  | { status: 404 | 409 | 500; body: { message: string } | ApprovalDecisionResponse } {
  const approval = findApprovalFixture(approvalId);

  if (!approval) {
    return {
      status: 404,
      body: {
        message: "Approval not found.",
      },
    };
  }

  if (comment?.toLowerCase().includes("force-error")) {
    return {
      status: 500,
      body: {
        message: "The approval relay could not be reached. Try again.",
      },
    };
  }

  if (approval.status === "expired") {
    return {
      status: 409,
      body: ApprovalDecisionResponseSchema.parse({
        id: approval.id,
        status: "rejected",
        resolvedByName: "System",
        resolvedAt: approval.resolvedAt ?? new Date().toISOString(),
        message: "Approval was already closed before this decision was submitted.",
        comment,
      }),
    };
  }

  if (approval.id === "appr_q2a7z") {
    return {
      status: 409,
      body: ApprovalDecisionResponseSchema.parse({
        id: approval.id,
        status: "approved",
        resolvedByName: "Avery Chen",
        resolvedAt: "2026-04-06T14:02:14Z",
        message: "Approved by Avery Chen while you were reviewing.",
        comment,
      }),
    };
  }

  const status: ApprovalResolvedStatus = decision === "approve" ? "approved" : "rejected";
  const message =
    status === "approved"
      ? "Action approved. The agent is continuing."
      : "Action rejected. The agent has been paused.";

  return {
    status: 200,
    body: ApprovalDecisionResponseSchema.parse({
      id: approval.id,
      status,
      resolvedByName: actorName,
      resolvedAt: "2026-04-06T14:32:01Z",
      message,
      comment,
    }),
  };
}
