"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ApprovalCard } from "@/components/composites";
import { EmptyState, LoadingSkeleton, PageStatePanel, StaleIndicator } from "@/components/feedback";
import { MetricCard, PageHeader } from "@/components/composites";
import { Badge, Button, Card, CodeBlock, Input, ToastCard, ToastViewport } from "@/components/primitives";
import { ApiClientError, getApiErrorMessage } from "@/lib/api/client";
import { approveApproval, rejectApproval } from "@/lib/api/endpoints/approvals";
import { useWorkspace } from "@/lib/auth/workspace-context";
import { useLiveUpdateStatus } from "@/components/providers/live-update-context";
import { actionDetailRoute, repositoryRoute, repositorySnapshotsRoute, runDetailRoute } from "@/lib/navigation/routes";
import { useApprovalsQuery } from "@/lib/query/hooks";
import { queryKeys } from "@/lib/query/keys";
import type { PreviewState } from "@/schemas/cloud";
import {
  ApprovalDecisionResponseSchema,
  type ApprovalListItem,
  type ApprovalListResponse,
} from "@/schemas/cloud";
import { formatRelativeTimestamp } from "@/lib/utils/format";

type DecisionIntent = "approve" | "reject";
type QueueToast = {
  tone: "success" | "warning" | "error";
  message: string;
};

function describeReviewLoad(items: ApprovalListItem[]): string {
  const snapshotRequired = items.filter((item) => item.snapshotRequired).length;
  if (items.length === 0) {
    return "queue clear";
  }
  if (snapshotRequired === 0) {
    return "no snapshots pending";
  }
  return `${snapshotRequired} snapshot gate${snapshotRequired === 1 ? "" : "s"}`;
}

function getOldestApproval(items: ApprovalListItem[]): ApprovalListItem | null {
  if (items.length === 0) {
    return null;
  }

  return items.reduce((oldest, current) =>
    new Date(current.requestedAt).getTime() < new Date(oldest.requestedAt).getTime() ? current : oldest,
  );
}

function connectorTone(status: ApprovalListItem["connectorStatus"]): "success" | "warning" | "error" | "neutral" {
  if (status === "active") {
    return "success";
  }

  if (status === "stale") {
    return "warning";
  }

  if (status === "revoked") {
    return "error";
  }

  return "neutral";
}

function deliveryTone(
  status: ApprovalListItem["decisionCommandStatus"],
): "success" | "warning" | "error" | "accent" | "neutral" {
  if (status === "completed") {
    return "success";
  }

  if (status === "failed") {
    return "error";
  }

  if (status === "expired") {
    return "warning";
  }

  if (status === "acked") {
    return "accent";
  }

  return "neutral";
}

function ApprovalQueueSkeleton() {
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,1fr)]">
      <Card className="space-y-4">
        <div className="flex items-center justify-between">
          <LoadingSkeleton className="w-40" />
          <LoadingSkeleton className="w-24" />
        </div>
        {Array.from({ length: 3 }).map((_, index) => (
          <Card className="space-y-4 bg-[var(--ag-bg-elevated)]" key={`approval-skeleton-${index}`}>
            <LoadingSkeleton className="w-56" />
            <LoadingSkeleton className="w-80" lines={2} />
            <LoadingSkeleton className="w-full" />
            <LoadingSkeleton className="w-44" />
          </Card>
        ))}
      </Card>
      <Card className="space-y-4">
        <LoadingSkeleton className="w-52" />
        <LoadingSkeleton className="w-full" lines={10} />
      </Card>
    </div>
  );
}

export function ApprovalQueuePage({ previewState = "ready" }: { previewState?: PreviewState }) {
  const queryClient = useQueryClient();
  const { user } = useWorkspace();
  const liveUpdateStatus = useLiveUpdateStatus();
  const approvalsQuery = useApprovalsQuery(previewState);
  const [selectedApprovalId, setSelectedApprovalId] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [decisionComment, setDecisionComment] = useState("");
  const [confirmRejectId, setConfirmRejectId] = useState<string | null>(null);
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<QueueToast | null>(null);
  const approvals = approvalsQuery.data;
  const approvalItems = approvals?.items ?? [];
  const pendingApprovals = approvalItems.filter((item) => item.status === "pending");
  const resolvedApprovals = approvalItems.filter((item) => item.status !== "pending");
  const oldestPendingApproval = getOldestApproval(pendingApprovals);
  const snapshotRequiredCount = pendingApprovals.filter((item) => item.snapshotRequired).length;
  const expiringSoonCount = pendingApprovals.filter((item) => item.expiresSoon).length;
  const selectedApproval =
    approvalItems.find((item) => item.id === selectedApprovalId) ?? pendingApprovals[0] ?? resolvedApprovals[0] ?? null;
  const selectedRepositoryHref =
    selectedApproval?.repositoryOwner && selectedApproval.repositoryName
      ? repositoryRoute(selectedApproval.repositoryOwner, selectedApproval.repositoryName)
      : null;
  const selectedRunHref =
    selectedApproval?.repositoryOwner && selectedApproval.repositoryName
      ? runDetailRoute(selectedApproval.repositoryOwner, selectedApproval.repositoryName, selectedApproval.runId)
      : null;
  const selectedActionHref =
    selectedApproval?.repositoryOwner && selectedApproval.repositoryName
      ? actionDetailRoute(
          selectedApproval.repositoryOwner,
          selectedApproval.repositoryName,
          selectedApproval.runId,
          selectedApproval.actionId,
        )
      : null;
  const selectedSnapshotsHref =
    selectedApproval?.repositoryOwner && selectedApproval.repositoryName
      ? repositorySnapshotsRoute(selectedApproval.repositoryOwner, selectedApproval.repositoryName)
      : null;
  const liveLabel =
    liveUpdateStatus.lastInvalidatedAt && liveUpdateStatus.invalidationCount > 0
      ? `live ${formatRelativeTimestamp(liveUpdateStatus.lastInvalidatedAt)}`
      : liveUpdateStatus.state === "connected"
        ? "live updates active"
      : liveUpdateStatus.state === "degraded"
          ? "updates delayed"
          : "connecting live updates";

  useEffect(() => {
    if (!selectedApprovalId && selectedApproval) {
      setSelectedApprovalId(selectedApproval.id);
      return;
    }

    if (selectedApprovalId && !approvalItems.some((item) => item.id === selectedApprovalId)) {
      setSelectedApprovalId(selectedApproval?.id ?? null);
    }
  }, [approvalItems, selectedApproval, selectedApprovalId]);

  useEffect(() => {
    setDecisionComment("");
    setConfirmRejectId(null);
  }, [selectedApprovalId]);

  useEffect(() => {
    if (!toast) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setToast(null);
    }, 4000);

    return () => window.clearTimeout(timeout);
  }, [toast]);

  function removeApprovalFromCache(approvalId: string) {
    queryClient.setQueryData<ApprovalListResponse>([...queryKeys.approvals, previewState], (current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        items: current.items.filter((item) => item.id !== approvalId),
        total: Math.max(current.total - 1, 0),
      };
    });

    void queryClient.invalidateQueries({ queryKey: queryKeys.approvals });
  }

  const decisionMutation = useMutation({
    mutationFn: async ({
      approvalId,
      comment,
      decision,
    }: {
      approvalId: string;
      comment?: string;
      decision: DecisionIntent;
    }) => {
      if (decision === "approve") {
        return approveApproval(approvalId, comment);
      }

      return rejectApproval(approvalId, comment);
    },
    onSuccess: (result, variables) => {
      setCardErrors((current) => {
        const next = { ...current };
        delete next[variables.approvalId];
        return next;
      });
      setConfirmRejectId(null);
      setDecisionComment("");
      setToast({
        tone: result.status === "approved" ? "success" : "warning",
        message: result.message,
      });
      removeApprovalFromCache(variables.approvalId);
    },
    onError: (error, variables) => {
      if (error instanceof ApiClientError) {
        const parsedConflict = ApprovalDecisionResponseSchema.safeParse(error.details);

        if (error.status === 409 && parsedConflict.success) {
          setToast({
            tone: "warning",
            message: parsedConflict.data.message,
          });
          setConfirmRejectId(null);
          setDecisionComment("");
          removeApprovalFromCache(variables.approvalId);
          return;
        }

        const fallbackMessage =
          typeof error.details === "object" &&
          error.details !== null &&
          "message" in error.details &&
          typeof error.details.message === "string"
            ? error.details.message
            : "Could not submit the decision. Try again.";

        setCardErrors((current) => ({
          ...current,
          [variables.approvalId]: fallbackMessage,
        }));
        return;
      }

      setCardErrors((current) => ({
        ...current,
        [variables.approvalId]: "Could not submit the decision. Try again.",
      }));
    },
  });

  function submitDecision(approvalId: string, decision: DecisionIntent) {
    setCardErrors((current) => {
      const next = { ...current };
      delete next[approvalId];
      return next;
    });

    decisionMutation.mutate({
      approvalId,
      comment: decisionComment.trim() || undefined,
      decision,
    });
  }

  const approvalErrorMessage = approvalsQuery.error
    ? getApiErrorMessage(approvalsQuery.error, "Could not load approvals. Retry.")
    : "Could not load approvals. Retry.";

  if (approvalsQuery.isPending) {
    return (
      <>
        <PageHeader
          description="Agent actions that crossed policy thresholds and require a human decision."
          title="Approval queue"
        />
        <div className="grid gap-6 md:grid-cols-3">
          <MetricCard label="Pending approvals" value="--" />
          <MetricCard label="Expiring soon" value="--" />
          <MetricCard label="Oldest request" value="--" />
        </div>
        <ApprovalQueueSkeleton />
      </>
    );
  }

  if (approvalsQuery.isError || !approvals) {
    return (
      <>
        <PageHeader
          description="Agent actions that crossed policy thresholds and require a human decision."
          title="Approval queue"
        />
        <PageStatePanel errorMessage={approvalErrorMessage} state="error" />
      </>
    );
  }

  return (
    <>
      <PageHeader
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StaleIndicator label={liveLabel} tone={liveUpdateStatus.state === "degraded" ? "warning" : "success"} />
            <Badge tone={pendingApprovals.length > 0 ? "warning" : "success"}>
              {pendingApprovals.length > 0 ? `${pendingApprovals.length} pending` : "Queue clear"}
            </Badge>
          </div>
        }
        description="Agent actions that crossed policy thresholds and require a human decision."
        title="Approval queue"
      />

      <div className="grid gap-6 md:grid-cols-3">
        <MetricCard label="Pending approvals" trend="workspace-wide" value={String(pendingApprovals.length)} />
        <MetricCard label="Expiring soon" trend="within approval TTL" value={String(expiringSoonCount)} />
        <MetricCard
          label="Oldest request"
          trend={oldestPendingApproval ? `oldest ${formatRelativeTimestamp(oldestPendingApproval.requestedAt)}` : "no active requests"}
          value={oldestPendingApproval ? oldestPendingApproval.workflowName : "clear"}
        />
      </div>

      {pendingApprovals.some((item) => item.connectorStatus !== "active") ? (
        <Card className="border border-[color:rgb(245_158_11_/_0.35)] bg-[color:rgb(245_158_11_/_0.08)]">
          <div className="text-sm font-medium text-[var(--ag-text-primary)]">Connector attention required</div>
          <div className="mt-2 text-sm text-[var(--ag-text-secondary)]">
            One or more pending approvals cannot be delivered immediately because the repository connector is missing,
            stale, revoked, or reporting the local daemon as offline.
          </div>
        </Card>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,1fr)]">
        <div className="space-y-6">
          {pendingApprovals.length > 0 ? (
            <Card className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">Pending approvals</h2>
                  <p className="text-sm text-[var(--ag-text-secondary)]">
                    Review the governed action, target scope, and policy rationale before continuing the agent session.
                  </p>
                </div>
                <Badge tone="warning">{describeReviewLoad(pendingApprovals)}</Badge>
              </div>
              <div className="space-y-4">
                {pendingApprovals.map((item) => (
                  <ApprovalCard
                    errorMessage={cardErrors[item.id]}
                    isBusy={decisionMutation.isPending && decisionMutation.variables?.approvalId === item.id}
                    isSelected={selectedApproval?.id === item.id}
                    item={item}
                    key={item.id}
                    onApprove={() => submitDecision(item.id, "approve")}
                    onReject={() => {
                      setSelectedApprovalId(item.id);
                      setConfirmRejectId(item.id);
                    }}
                    onSelect={() => setSelectedApprovalId(item.id)}
                  />
                ))}
              </div>
            </Card>
          ) : (
            <EmptyState
              description="No pending approvals. The agent will notify you when your input is needed."
              title="No pending approvals"
            >
              {resolvedApprovals.length > 0 ? (
                <p className="text-xs text-[var(--ag-text-secondary)]">
                  {resolvedApprovals.length} resolved request{resolvedApprovals.length === 1 ? "" : "s"} remain in the audit rail below.
                </p>
              ) : null}
            </EmptyState>
          )}

          {resolvedApprovals.length > 0 ? (
            <Card className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">Resolved approvals</h2>
                  <p className="text-sm text-[var(--ag-text-secondary)]">
                    Recent decisions from the authority daemon, including approvals and rejections already recorded.
                  </p>
                </div>
                <Button onClick={() => setShowResolved((current) => !current)} size="sm" variant="secondary">
                  {showResolved ? "Hide resolved" : `Show resolved (${resolvedApprovals.length})`}
                </Button>
              </div>
              {showResolved ? (
                <div className="space-y-4">
                  {resolvedApprovals.map((item) => (
                    <ApprovalCard
                      errorMessage={cardErrors[item.id]}
                      isSelected={selectedApproval?.id === item.id}
                      item={item}
                      key={item.id}
                      onSelect={() => setSelectedApprovalId(item.id)}
                    />
                  ))}
                </div>
              ) : null}
            </Card>
          ) : null}
        </div>

        <div className="space-y-6">
          <Card className="space-y-5">
            {selectedApproval ? (
              <>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={selectedApproval.status === "pending" ? "warning" : "neutral"}>
                        {selectedApproval.status}
                      </Badge>
                      <Badge>{selectedApproval.domain}</Badge>
                      <Badge>{selectedApproval.sideEffectLevel.replaceAll("_", " ")}</Badge>
                      {selectedApproval.expiresSoon && selectedApproval.status === "pending" ? (
                        <Badge tone="warning">expiring soon</Badge>
                      ) : null}
                      <Badge tone={connectorTone(selectedApproval.connectorStatus)}>
                        connector {selectedApproval.connectorStatus}
                      </Badge>
                      {selectedApproval.decisionCommandStatus ? (
                        <Badge tone={deliveryTone(selectedApproval.decisionCommandStatus)}>
                          delivery {selectedApproval.decisionCommandStatus}
                        </Badge>
                      ) : null}
                    </div>
                    <h2 className="text-xl font-semibold">{selectedApproval.actionSummary}</h2>
                    <p className="text-sm text-[var(--ag-text-secondary)]">
                      {selectedApproval.reasonSummary ?? "No additional policy rationale was attached to this approval."}
                    </p>
                  </div>
                  <div className="space-y-1 text-right text-xs text-[var(--ag-text-secondary)]">
                    <div>Requested {formatRelativeTimestamp(selectedApproval.requestedAt)}</div>
                    {selectedApproval.expiresAt ? <div>Expires {formatRelativeTimestamp(selectedApproval.expiresAt)}</div> : null}
                    {selectedApproval.resolvedAt ? <div>Resolved {formatRelativeTimestamp(selectedApproval.resolvedAt)}</div> : null}
                  </div>
                </div>

                <div className="grid gap-3 rounded-[var(--ag-radius-lg)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] p-4 text-sm sm:grid-cols-2">
                  <div>
                    <div className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">Workflow</div>
                    <div className="mt-1 font-medium">{selectedApproval.workflowName}</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">Repository</div>
                    <div className="mt-1 font-medium">
                      {selectedApproval.repositoryOwner && selectedApproval.repositoryName
                        ? `${selectedApproval.repositoryOwner}/${selectedApproval.repositoryName}`
                        : "Awaiting repository context"}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">Target</div>
                    <div className="mt-1 font-medium">{selectedApproval.targetLabel ?? selectedApproval.targetLocator}</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">Snapshot gate</div>
                    <div className="mt-1 font-medium">{selectedApproval.snapshotRequired ? "Required before execution" : "Not required"}</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">Run</div>
                    <div className="mt-1 font-mono text-xs text-[var(--ag-text-secondary)]">{selectedApproval.runId}</div>
                  </div>
                </div>

                {selectedApproval.connectorStatusReason ? (
                  <div className="rounded-[var(--ag-radius-md)] border border-[color:rgb(245_158_11_/_0.25)] bg-[color:rgb(245_158_11_/_0.08)] px-3 py-2 text-sm text-[var(--ag-text-secondary)]">
                    {selectedApproval.connectorStatusReason}
                  </div>
                ) : null}

                {selectedApproval.decisionCommandMessage ? (
                  <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-hover)] px-3 py-2 text-sm text-[var(--ag-text-secondary)]">
                    {selectedApproval.decisionCommandMessage}
                    {selectedApproval.decisionCommandNextAttemptAt
                      ? ` Retry ${formatRelativeTimestamp(selectedApproval.decisionCommandNextAttemptAt)}.`
                      : ""}
                  </div>
                ) : null}

                <div className="flex flex-wrap gap-2">
                  {selectedRepositoryHref ? (
                    <Link
                      className="ag-focus-ring inline-flex h-8 items-center justify-center rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] px-3 text-[13px] font-medium text-[var(--ag-text-primary)] transition-colors duration-[var(--ag-duration-fast)] hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-hover)]"
                      href={selectedRepositoryHref}
                    >
                      Open repository
                    </Link>
                  ) : null}
                  {selectedRunHref ? (
                    <Link
                      className="ag-focus-ring inline-flex h-8 items-center justify-center rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] px-3 text-[13px] font-medium text-[var(--ag-text-primary)] transition-colors duration-[var(--ag-duration-fast)] hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-hover)]"
                      href={selectedRunHref}
                    >
                      Open run
                    </Link>
                  ) : null}
                  {selectedActionHref ? (
                    <Link
                      className="ag-focus-ring inline-flex h-8 items-center justify-center rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] px-3 text-[13px] font-medium text-[var(--ag-text-primary)] transition-colors duration-[var(--ag-duration-fast)] hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-hover)]"
                      href={selectedActionHref}
                    >
                      Open action detail
                    </Link>
                  ) : null}
                  {selectedSnapshotsHref ? (
                    <Link
                      className="ag-focus-ring inline-flex h-8 items-center justify-center rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] px-3 text-[13px] font-medium text-[var(--ag-text-primary)] transition-colors duration-[var(--ag-duration-fast)] hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-hover)]"
                      href={selectedSnapshotsHref}
                    >
                      Open snapshots
                    </Link>
                  ) : null}
                </div>

                <div className="space-y-3">
                  <h3 className="text-sm font-semibold uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">Authority target locator</h3>
                  <CodeBlock>{selectedApproval.targetLocator}</CodeBlock>
                </div>

                {selectedApproval.resolutionNote ? (
                  <div className="space-y-3">
                    <h3 className="text-sm font-semibold uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">Resolution note</h3>
                    <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3 text-sm text-[var(--ag-text-secondary)]">
                      {selectedApproval.resolutionNote}
                    </div>
                  </div>
                ) : null}

                {selectedApproval.status === "pending" ? (
                  <div className="space-y-4 border-t border-[var(--ag-border-subtle)] pt-4">
                    <Input
                      helpText={`Recorded as ${user.name}. Add context for the audit trail if useful.`}
                      id="approval-comment"
                      label="Decision note (optional)"
                      onChange={(event) => setDecisionComment(event.target.value)}
                      placeholder="Approved - build step is expected."
                      value={decisionComment}
                    />

                    {cardErrors[selectedApproval.id] ? (
                      <div className="rounded-[var(--ag-radius-md)] border border-[color:rgb(239_68_68_/_0.25)] bg-[var(--ag-bg-error)] px-3 py-2 text-sm text-[var(--ag-color-error)]">
                        {cardErrors[selectedApproval.id]}
                      </div>
                    ) : null}

                    {confirmRejectId === selectedApproval.id ? (
                      <div className="rounded-[var(--ag-radius-md)] border border-[color:rgb(239_68_68_/_0.25)] bg-[color:rgb(239_68_68_/_0.06)] p-4">
                        <p className="text-sm text-[var(--ag-text-primary)]">
                          Rejecting will pause the agent session and keep the run blocked until a new action is submitted.
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          disabled={decisionMutation.isPending || selectedApproval.connectorStatus !== "active"}
                          onClick={() => submitDecision(selectedApproval.id, "reject")}
                          variant="destructive"
                        >
                            {decisionMutation.isPending && decisionMutation.variables?.approvalId === selectedApproval.id
                              ? "Rejecting..."
                              : "Confirm reject"}
                          </Button>
                          <Button
                            disabled={decisionMutation.isPending}
                            onClick={() => setConfirmRejectId(null)}
                            variant="secondary"
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          disabled={decisionMutation.isPending || selectedApproval.connectorStatus !== "active"}
                          onClick={() => submitDecision(selectedApproval.id, "approve")}
                          variant="accent"
                        >
                          {decisionMutation.isPending && decisionMutation.variables?.approvalId === selectedApproval.id
                            ? "Approving..."
                            : "Approve action"}
                        </Button>
                        <Button
                          disabled={decisionMutation.isPending || selectedApproval.connectorStatus !== "active"}
                          onClick={() => setConfirmRejectId(selectedApproval.id)}
                          variant="destructive"
                        >
                          Reject action
                        </Button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3 text-sm text-[var(--ag-text-secondary)]">
                    {selectedApproval.status === "expired"
                      ? "This approval timed out under the workspace TTL and is no longer actionable."
                      : "This approval is no longer actionable. The authority daemon has already recorded the decision and audit trail."}
                  </div>
                )}
              </>
            ) : (
              <EmptyState
                description="Select an approval to review the authority target, policy rationale, and audit details."
                title="No approval selected"
              />
            )}
          </Card>

          <Card className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Build loop backlog</h2>
              <Badge>{user.name}</Badge>
            </div>
            <p className="text-sm text-[var(--ag-text-secondary)]">
              Foundation follow-ups are captured alongside the approval loop so implementation work and cleanup work stay
              in the same operating rhythm.
            </p>
            <CodeBlock>
              {`Backlog file:
engineering-docs/pre-code-specs/cloud-product/05-foundation-loop-backlog.md

Closed in this pass:
- route-level RBAC guard coverage
- root and /app error boundaries
- first RHF + Zod form in settings
- NextAuth session plumbing and /app middleware redirects
- owner-only onboarding stepper with 5-step validation
- owner-only billing form and invoice surface
- admin-only integrations settings with test delivery states
- authority-backed approval inbox and decision mutations via the local daemon
- authority-backed run detail summary and timeline adapter

Preview states:
?state=empty

Local authority prerequisites:
- start the daemon so /api/v1/approvals and /api/v1/runs/[id] can resolve real contracts
- set AGENTGIT_CLOUD_WORKSPACE_ROOTS only if the app should hello a workspace outside this repo`}
            </CodeBlock>
          </Card>
        </div>
      </div>

      {toast ? (
        <ToastViewport>
          <ToastCard
            className={
              toast.tone === "success"
                ? "border-[color:rgb(34_197_94_/_0.28)]"
                : toast.tone === "warning"
                  ? "border-[color:rgb(245_158_11_/_0.28)]"
                  : "border-[color:rgb(239_68_68_/_0.28)]"
            }
          >
            <div className="space-y-1">
              <div className="text-sm font-semibold text-[var(--ag-text-primary)]">
                {toast.tone === "success"
                  ? "Approval recorded"
                  : toast.tone === "warning"
                    ? "Queue updated"
                    : "Decision failed"}
              </div>
              <p className="text-sm text-[var(--ag-text-secondary)]">{toast.message}</p>
            </div>
          </ToastCard>
        </ToastViewport>
      ) : null}
    </>
  );
}
