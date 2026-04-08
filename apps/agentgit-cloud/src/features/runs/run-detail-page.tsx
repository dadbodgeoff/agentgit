"use client";

import Link from "next/link";

import { Button, Card, TableBody, TableCell, TableHead, TableHeaderCell, TableRoot, TableRow, Badge } from "@/components/primitives";
import { PageStatePanel, StaleIndicator } from "@/components/feedback";
import { useLiveUpdateStatus } from "@/components/providers/live-update-context";
import { ScaffoldPage } from "@/features/shared/scaffold-page";
import { getApiErrorMessage } from "@/lib/api/client";
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

  if (runQuery.isPending) {
    return (
      <ScaffoldPage actions={<Button variant="secondary">Restore snapshot</Button>} description={`Detailed run timeline for ${owner}/${name} run ${runId}, including action ordering, policy outcomes, and recovery context.`} sections={[]} title="Run detail">
        <PageStatePanel state="loading" />
      </ScaffoldPage>
    );
  }

  if (runQuery.isError) {
    const errorMessage = getApiErrorMessage(runQuery.error, "Could not load run detail. Retry.");

    return (
      <ScaffoldPage actions={<Button variant="secondary">Restore snapshot</Button>} description={`Detailed run timeline for ${owner}/${name} run ${runId}, including action ordering, policy outcomes, and recovery context.`} sections={[]} title="Run detail">
        <PageStatePanel errorMessage={errorMessage} state="error" />
      </ScaffoldPage>
    );
  }

  const run = runQuery.data;
  const approvalSteps = run.steps.filter((step) => step.stepType === "approval_step");
  const blockedSteps = run.steps.filter((step) => step.status === "blocked" || step.status === "awaiting_approval");
  const snapshotSteps = run.steps.filter((step) => typeof step.snapshotId === "string" && step.snapshotId.length > 0);
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
        { title: "Attention queue", description: "Fast-path operator cues for blocked steps, approvals, and snapshots.", kind: "status" },
        { title: "Timeline steps", description: "Projected step list from the daemon timeline query.", kind: "table" },
        { title: "Authority context", description: "Workspace roots and projection freshness for operator debugging.", kind: "code" },
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
                <div className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">Operator signals</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Badge tone={approvalSteps.length > 0 ? "warning" : "neutral"}>
                    {approvalSteps.length} approval step{approvalSteps.length === 1 ? "" : "s"}
                  </Badge>
                  <Badge tone={blockedSteps.length > 0 ? "warning" : "neutral"}>
                    {blockedSteps.length} blocked
                  </Badge>
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
                    <TableCell className="text-[var(--ag-text-secondary)]">{formatRelativeTimestamp(step.occurredAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </TableRoot>
          </Card>
        </div>

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
              <div className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">Attention queue</div>
              <div className="mt-3 space-y-3">
                <div>
                  <div className="text-sm font-medium text-[var(--ag-text-primary)]">Blocked or approval-gated steps</div>
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
              <div className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">Workspace roots</div>
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
      </div>
    </ScaffoldPage>
  );
}
