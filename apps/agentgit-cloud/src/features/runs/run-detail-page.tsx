"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { useMutation, useQuery } from "@tanstack/react-query";

import {
  Button,
  Card,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRoot,
  TableRow,
  Badge,
  ToastCard,
  ToastViewport,
} from "@/components/primitives";
import { PageStatePanel, StaleIndicator } from "@/components/feedback";
import { useLiveUpdateStatus } from "@/components/providers/live-update-context";
import { ScaffoldPage } from "@/features/shared/scaffold-page";
import { getApiErrorMessage } from "@/lib/api/client";
import { getRepositoryRunReplay, queueRepositoryRunReplay } from "@/lib/api/endpoints/repositories";
import { actionDetailRoute, authenticatedRoutes, repositorySnapshotsRoute } from "@/lib/navigation/routes";
import { useRunDetailQuery } from "@/lib/query/hooks";
import type { PreviewState } from "@/schemas/cloud";
import { formatAbsoluteDate, formatRelativeTimestamp } from "@/lib/utils/format";

function badgeToneForStatus(status: string): "success" | "warning" | "error" | "accent" | "neutral" {
  if (status === "completed" || status === "allow" || status === "allow_with_snapshot") {
    return "success";
  }

  if (status === "failed" || status === "deny") {
    return "error";
  }

  if (status === "blocked" || status === "awaiting_approval" || status === "partial" || status === "ask") {
    return "warning";
  }

  if (status === "running" || status === "pending") {
    return "accent";
  }

  return "neutral";
}

export function RunDetailPage({
  owner,
  name,
  runId,
  previewState = "ready",
}: {
  owner: string;
  name: string;
  runId: string;
  previewState?: PreviewState;
}) {
  const runQuery = useRunDetailQuery(runId, previewState);
  const liveUpdateStatus = useLiveUpdateStatus();
  const [replayMessage, setReplayMessage] = useState<string | null>(null);
  const [replayErrorToast, setReplayErrorToast] = useState<string | null>(null);
  const replayQuery = useQuery({
    queryKey: ["repository-run-replay", owner, name, runId],
    queryFn: () => getRepositoryRunReplay(owner, name, runId),
    enabled: previewState === "ready",
  });
  const replayMutation = useMutation({
    mutationFn: () => queueRepositoryRunReplay(owner, name, runId),
    onSuccess: (result) => {
      setReplayMessage(result.message);
      void replayQuery.refetch();
      void runQuery.refetch();
    },
    onError: (error) => {
      const message = getApiErrorMessage(error, "Could not queue run replay. Retry.");
      setReplayMessage(message);
      setReplayErrorToast(message);
    },
  });

  useEffect(() => {
    if (!replayMessage) {
      return;
    }

    const timeout = window.setTimeout(() => setReplayMessage(null), 5000);
    return () => window.clearTimeout(timeout);
  }, [replayMessage]);

  useEffect(() => {
    if (!replayErrorToast) {
      return;
    }

    const timeout = window.setTimeout(() => setReplayErrorToast(null), 4000);
    return () => window.clearTimeout(timeout);
  }, [replayErrorToast]);

  if (runQuery.isPending) {
    return (
      <ScaffoldPage
        actions={<Button variant="secondary">Restore snapshot</Button>}
        description={`Detailed run timeline for ${owner}/${name} run ${runId}, including action ordering, policy outcomes, and recovery context.`}
        sections={[]}
        title="Run detail"
      >
        <PageStatePanel state="loading" />
      </ScaffoldPage>
    );
  }

  if (runQuery.isError) {
    const errorMessage = getApiErrorMessage(runQuery.error, "Could not load run detail. Retry.");

    return (
      <ScaffoldPage
        actions={<Button variant="secondary">Restore snapshot</Button>}
        description={`Detailed run timeline for ${owner}/${name} run ${runId}, including action ordering, policy outcomes, and recovery context.`}
        sections={[]}
        title="Run detail"
      >
        <PageStatePanel errorMessage={errorMessage} state="error" />
      </ScaffoldPage>
    );
  }

  const run = runQuery.data;
  const approvalSteps = run.steps.filter((step) => step.stepType === "approval_step");
  const blockedSteps = run.steps.filter((step) => step.status === "blocked" || step.status === "awaiting_approval");
  const snapshotSteps = run.steps.filter((step) => typeof step.snapshotId === "string" && step.snapshotId.length > 0);
  const replayPreview = replayQuery.data;
  const liveLabel =
    liveUpdateStatus.state === "connected"
      ? liveUpdateStatus.lastInvalidatedAt
        ? `live · updated ${formatRelativeTimestamp(liveUpdateStatus.lastInvalidatedAt)}`
        : "live · connected"
      : liveUpdateStatus.state === "degraded"
        ? "live stream degraded"
        : "connecting live stream";

  return (
    <ScaffoldPage
      actions={
        <div className="flex flex-wrap gap-2">
          <Link
            className="ag-focus-ring inline-flex h-9 items-center justify-center rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] px-3 text-sm font-medium text-[var(--ag-text-primary)] transition-colors hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-hover)]"
            href={repositorySnapshotsRoute(owner, name)}
          >
            Open snapshots
          </Link>
          <Link
            className="ag-focus-ring inline-flex h-9 items-center justify-center rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] px-3 text-sm font-medium text-[var(--ag-text-primary)] transition-colors hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-hover)]"
            href={authenticatedRoutes.approvals}
          >
            Open approvals
          </Link>
        </div>
      }
      description={`Detailed run timeline for ${owner}/${name} run ${runId}, including action ordering, policy outcomes, and recovery context.`}
      metrics={[
        { label: "Actions", value: String(run.actionCount), trend: `${run.actionsAsked} required approval` },
        { label: "Snapshots", value: String(run.snapshotsTaken), trend: "recovery boundaries captured" },
        { label: "Started", value: formatRelativeTimestamp(run.startedAt), trend: run.runtime },
      ]}
      sections={[
        { title: "Run summary", description: "Authority-backed workflow metadata, status, and execution totals." },
        {
          title: "Attention queue",
          description: "Fast-path operator cues for blocked steps, approvals, and snapshots.",
          kind: "status",
        },
        { title: "Timeline steps", description: "Projected step list from the daemon timeline query.", kind: "table" },
        {
          title: "Authority context",
          description: "Workspace roots and projection freshness for operator debugging.",
          kind: "code",
        },
      ]}
      title="Run detail"
    >
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.8fr)]">
        <div className="space-y-6">
          <Card className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Run posture</h2>
              <StaleIndicator label={liveLabel} tone={liveUpdateStatus.state === "degraded" ? "warning" : "success"} />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3">
                <div className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">Run status</div>
                <div className="mt-2 flex items-center gap-2">
                  <Badge tone={badgeToneForStatus(run.status)}>{run.status}</Badge>
                  <Badge tone="neutral">{run.projectionStatus}</Badge>
                </div>
                <div className="mt-2 text-sm text-[var(--ag-text-secondary)]">{run.summary}</div>
              </div>
              <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3">
                <div className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">
                  Operator signals
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Badge tone={approvalSteps.length > 0 ? "warning" : "neutral"}>
                    {approvalSteps.length} approval step{approvalSteps.length === 1 ? "" : "s"}
                  </Badge>
                  <Badge tone={blockedSteps.length > 0 ? "warning" : "neutral"}>{blockedSteps.length} blocked</Badge>
                  <Badge tone={snapshotSteps.length > 0 ? "accent" : "neutral"}>
                    {snapshotSteps.length} snapshot link{snapshotSteps.length === 1 ? "" : "s"}
                  </Badge>
                </div>
              </div>
            </div>
          </Card>

          <Card className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Timeline steps</h2>
              <span className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">
                {run.projectionStatus}
              </span>
            </div>
            <TableRoot>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Step</TableHeaderCell>
                  <TableHeaderCell>Type</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Decision</TableHeaderCell>
                  <TableHeaderCell>Occurred</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {run.steps.map((step) => (
                  <TableRow key={step.id}>
                    <TableCell>
                      <div className="space-y-2">
                        {step.actionId ? (
                          <Link
                            className="ag-focus-ring rounded-sm font-medium text-[var(--ag-text-primary)] underline-offset-4 hover:text-[var(--ag-color-brand)] hover:underline"
                            href={actionDetailRoute(owner, name, runId, step.actionId)}
                          >
                            {step.title}
                          </Link>
                        ) : (
                          <div className="font-medium">{step.title}</div>
                        )}
                        <div className="text-xs text-[var(--ag-text-secondary)]">{step.summary}</div>
                        <div className="flex flex-wrap gap-2">
                          <Badge tone="neutral">{step.stepType.replaceAll("_", " ")}</Badge>
                          <Badge tone={badgeToneForStatus(step.status)}>{step.status.replaceAll("_", " ")}</Badge>
                          {step.decision ? (
                            <Badge tone={badgeToneForStatus(step.decision)}>{step.decision.replaceAll("_", " ")}</Badge>
                          ) : null}
                          {step.snapshotId ? <Badge tone="accent">snapshot linked</Badge> : null}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="capitalize">{step.stepType.replaceAll("_", " ")}</TableCell>
                    <TableCell className="capitalize">{step.status.replaceAll("_", " ")}</TableCell>
                    <TableCell className="capitalize">
                      {step.decision ? step.decision.replaceAll("_", " ") : "n/a"}
                    </TableCell>
                    <TableCell className="text-[var(--ag-text-secondary)]">
                      {formatRelativeTimestamp(step.occurredAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </TableRoot>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Authority context</h2>
              <Badge tone={badgeToneForStatus(run.status)}>{run.status}</Badge>
            </div>
            <div className="space-y-4 text-sm">
              <div>
                <div className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">Workflow</div>
                <div className="mt-1 font-medium">{run.workflowName}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">Agent runtime</div>
                <div className="mt-1 font-medium">
                  {run.agentFramework} / {run.agentName}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">Completed at</div>
                <div className="mt-1 font-medium">{formatAbsoluteDate(run.endedAt)}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">Summary</div>
                <div className="mt-1 text-[var(--ag-text-secondary)]">{run.summary}</div>
              </div>
              <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3">
                <div className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">
                  Attention queue
                </div>
                <div className="mt-3 space-y-3">
                  <div>
                    <div className="text-sm font-medium text-[var(--ag-text-primary)]">
                      Blocked or approval-gated steps
                    </div>
                    <div className="text-sm text-[var(--ag-text-secondary)]">
                      {blockedSteps.length > 0 || approvalSteps.length > 0
                        ? `${blockedSteps.length} blocked and ${approvalSteps.length} approval step${approvalSteps.length === 1 ? "" : "s"} are visible in this run.`
                        : "No blocked or approval-gated steps are currently visible."}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm font-medium text-[var(--ag-text-primary)]">Snapshot boundaries</div>
                    <div className="text-sm text-[var(--ag-text-secondary)]">
                      {snapshotSteps.length > 0
                        ? `${snapshotSteps.length} step${snapshotSteps.length === 1 ? "" : "s"} reference snapshot boundaries for recovery follow-up.`
                        : "This run has no snapshot-linked steps in the current projection."}
                    </div>
                  </div>
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">
                  Workspace roots
                </div>
                <div className="mt-1 space-y-1">
                  {run.workspaceRoots.map((workspaceRoot) => (
                    <div className="font-mono text-xs text-[var(--ag-text-secondary)]" key={workspaceRoot}>
                      {workspaceRoot}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </Card>

          <Card className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Replay run</h2>
              {replayPreview ? (
                <Badge
                  tone={
                    replayPreview.replayMode === "exact"
                      ? "success"
                      : replayPreview.replayMode === "partial"
                        ? "warning"
                        : "neutral"
                  }
                >
                  {replayPreview.replayMode}
                </Badge>
              ) : null}
            </div>

            {replayQuery.isPending ? (
              <div className="text-sm text-[var(--ag-text-secondary)]">Loading replay preview...</div>
            ) : replayQuery.isError ? (
              <div className="text-sm text-[var(--ag-color-error)]">
                {getApiErrorMessage(replayQuery.error, "Could not load replay preview.")}
              </div>
            ) : replayPreview ? (
              <>
                <p className="text-sm text-[var(--ag-text-secondary)]">{replayPreview.summary}</p>
                {replayPreview.helperSummary ? (
                  <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3 text-sm text-[var(--ag-text-secondary)]">
                    {replayPreview.helperSummary}
                  </div>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={replayPreview.connectorStatus === "active" ? "success" : "warning"}>
                    connector {replayPreview.connectorStatus}
                  </Badge>
                  <Badge>{replayPreview.replayableActionCount} replayable</Badge>
                  <Badge tone="neutral">{replayPreview.skippedActionCount} skipped</Badge>
                  <Badge tone="neutral">{replayPreview.pendingApprovalCount} source approvals</Badge>
                </div>
                {replayPreview.connectorStatusReason || replayPreview.replayReason ? (
                  <div className="text-sm text-[var(--ag-text-secondary)]">
                    {replayPreview.connectorStatusReason ?? replayPreview.replayReason}
                  </div>
                ) : null}
                <div className="space-y-2">
                  {replayPreview.actions.slice(0, 5).map((action) => (
                    <div
                      className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3"
                      key={action.sourceActionId}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-medium text-[var(--ag-text-primary)]">{action.title}</div>
                          <div className="text-xs text-[var(--ag-text-secondary)]">
                            {action.actionFamily} · {action.toolName}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={action.replayable ? "success" : "warning"}>
                            {action.replayable ? "replayable" : "skipped"}
                          </Badge>
                          {action.decision ? <Badge tone="neutral">{action.decision}</Badge> : null}
                        </div>
                      </div>
                      {action.replayReason ? (
                        <div className="mt-2 text-xs text-[var(--ag-text-secondary)]">{action.replayReason}</div>
                      ) : null}
                    </div>
                  ))}
                </div>
                <Button
                  disabled={
                    replayMutation.isPending ||
                    replayPreview.connectorStatus !== "active" ||
                    replayPreview.replayMode === "preview_only"
                  }
                  onClick={() => replayMutation.mutate()}
                  variant="secondary"
                >
                  {replayMutation.isPending ? "Queueing replay..." : "Queue replay through connector"}
                </Button>
                {replayMessage ? <div className="text-sm text-[var(--ag-text-secondary)]">{replayMessage}</div> : null}
              </>
            ) : (
              <div className="text-sm text-[var(--ag-text-secondary)]">
                No replay preview is available for this run yet.
              </div>
            )}
          </Card>
        </div>
      </div>
      {replayErrorToast ? (
        <ToastViewport>
          <ToastCard className="border-[color:rgb(239_68_68_/_0.28)]">
            <div className="space-y-1">
              <div className="text-sm font-semibold text-[var(--ag-text-primary)]">Replay failed</div>
              <p className="text-sm text-[var(--ag-text-secondary)]">{replayErrorToast}</p>
            </div>
          </ToastCard>
        </ToastViewport>
      ) : null}
    </ScaffoldPage>
  );
}
