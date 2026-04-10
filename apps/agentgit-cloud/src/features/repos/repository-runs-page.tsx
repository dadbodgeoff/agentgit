"use client";

import Link from "next/link";

import { PageHeader, MetricCard } from "@/components/composites";
import { PageStatePanel, StaleIndicator } from "@/components/feedback";
import { useLiveUpdateStatus } from "@/components/providers/live-update-context";
import {
  Badge,
  Button,
  Card,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRoot,
  TableRow,
} from "@/components/primitives";
import { getApiErrorMessage } from "@/lib/api/client";
import {
  repositoryPolicyRoute,
  repositoryRoute,
  repositorySnapshotsRoute,
  runDetailRoute,
} from "@/lib/navigation/routes";
import { useRepositoryRunsQuery } from "@/lib/query/hooks";
import type { PreviewState } from "@/schemas/cloud";
import { formatRelativeTimestamp } from "@/lib/utils/format";

function badgeToneForStatus(
  status: "queued" | "running" | "completed" | "failed" | "canceled",
): "neutral" | "warning" | "success" | "error" {
  switch (status) {
    case "running":
      return "warning";
    case "completed":
      return "success";
    case "failed":
      return "error";
    default:
      return "neutral";
  }
}

export function RepositoryRunsPage({
  owner,
  name,
  previewState = "ready",
}: {
  owner: string;
  name: string;
  previewState?: PreviewState;
}) {
  const runsQuery = useRepositoryRunsQuery(owner, name, previewState);
  const liveUpdateStatus = useLiveUpdateStatus();
  const repositoryHref = repositoryRoute(owner, name);
  const policyHref = repositoryPolicyRoute(owner, name);
  const snapshotsHref = repositorySnapshotsRoute(owner, name);

  const liveLabel =
    liveUpdateStatus.lastInvalidatedAt && liveUpdateStatus.invalidationCount > 0
      ? `live ${formatRelativeTimestamp(liveUpdateStatus.lastInvalidatedAt)}`
      : liveUpdateStatus.state === "connected"
        ? "live updates active"
        : liveUpdateStatus.state === "degraded"
          ? "updates delayed"
          : "connecting live updates";

  if (runsQuery.isPending) {
    return (
      <>
        <PageHeader
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <StaleIndicator label={liveLabel} tone={liveUpdateStatus.state === "degraded" ? "warning" : "success"} />
              <Button disabled variant="secondary">
                Refresh runs
              </Button>
            </div>
          }
          description={`Governed run history for ${owner}/${name}.`}
          title={`${owner}/${name} runs`}
        />
        <div className="grid gap-6 md:grid-cols-3">
          <MetricCard label="Tracked runs" value="--" />
          <MetricCard label="Failed runs" value="--" />
          <MetricCard label="Running now" value="--" />
        </div>
        <PageStatePanel state="loading" />
      </>
    );
  }

  if (runsQuery.isError || !runsQuery.data) {
    const errorMessage = getApiErrorMessage(runsQuery.error, "Could not load repository runs. Retry.");

    return (
      <>
        <PageHeader
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <StaleIndicator label={liveLabel} tone={liveUpdateStatus.state === "degraded" ? "warning" : "success"} />
              <Button onClick={() => void runsQuery.refetch()} variant="secondary">
                Retry
              </Button>
            </div>
          }
          description={`Governed run history for ${owner}/${name}.`}
          title={`${owner}/${name} runs`}
        />
        <PageStatePanel errorMessage={errorMessage} state="error" />
      </>
    );
  }

  const runs = runsQuery.data;
  const failedRuns = runs.items.filter((run) => run.status === "failed").length;
  const runningRuns = runs.items.filter((run) => run.status === "running").length;
  const latestRun = runs.items[0] ?? null;
  const attentionCount = runs.items.filter((run) => run.status === "failed" || run.status === "running").length;

  return (
    <>
      <PageHeader
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StaleIndicator label={liveLabel} tone={liveUpdateStatus.state === "degraded" ? "warning" : "success"} />
            <Button onClick={() => void runsQuery.refetch()} variant="secondary">
              Refresh runs
            </Button>
          </div>
        }
        description={`Governed run history for ${owner}/${name}.`}
        title={`${owner}/${name} runs`}
      />

      <div className="grid gap-6 md:grid-cols-3">
        <MetricCard label="Tracked runs" trend="authority journal" value={String(runs.total)} />
        <MetricCard label="Failed runs" trend="operator review" value={String(failedRuns)} />
        <MetricCard
          label="Running now"
          trend={latestRun ? `latest ${formatRelativeTimestamp(latestRun.updatedAt)}` : "no active runs"}
          value={String(runningRuns)}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.7fr)_minmax(320px,1fr)]">
        <Card className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Run history</h2>
              <p className="text-sm text-[var(--ag-text-secondary)]">
                Follow governed runs from repository context into run and action detail without losing the operator
                trail.
              </p>
            </div>
            <Badge tone={attentionCount > 0 ? "warning" : "success"}>
              {attentionCount > 0 ? `${attentionCount} need attention` : "Healthy backlog"}
            </Badge>
          </div>
          <div className="text-sm text-[var(--ag-text-secondary)]">
            Showing {runs.items.length} of {runs.total} runs loaded for this repository.
          </div>

          {runs.items.length === 0 ? (
            <PageStatePanel
              emptyDescription="This repository has not recorded any governed runs yet."
              emptyTitle="No runs yet"
              state="empty"
            />
          ) : (
            <TableRoot>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Workflow</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Agent</TableHeaderCell>
                  <TableHeaderCell>Started</TableHeaderCell>
                  <TableHeaderCell>Updated</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {runs.items.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell>
                      <div className="space-y-1">
                        <Link
                          className="ag-focus-ring rounded-sm font-medium text-[var(--ag-text-primary)] underline-offset-4 hover:text-[var(--ag-color-brand)] hover:underline"
                          href={runDetailRoute(owner, name, run.id)}
                        >
                          {run.workflowName}
                        </Link>
                        <div className="text-xs text-[var(--ag-text-secondary)]">{run.summary}</div>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--ag-text-secondary)]">
                          <span className="font-mono">{run.id}</span>
                          <span>
                            {run.eventCount} event{run.eventCount === 1 ? "" : "s"}
                          </span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge tone={badgeToneForStatus(run.status)}>{run.status}</Badge>
                    </TableCell>
                    <TableCell>{run.agentName}</TableCell>
                    <TableCell className="text-[var(--ag-text-secondary)]">
                      {formatRelativeTimestamp(run.startedAt)}
                    </TableCell>
                    <TableCell className="text-[var(--ag-text-secondary)]">
                      {formatRelativeTimestamp(run.updatedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </TableRoot>
          )}
          {runsQuery.hasNextPage ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--ag-border-subtle)] pt-4">
              <p className="text-sm text-[var(--ag-text-secondary)]">
                Load older governed runs from the repository journal.
              </p>
              <Button
                disabled={runsQuery.isFetchingNextPage}
                onClick={() => void runsQuery.fetchNextPage()}
                variant="secondary"
              >
                {runsQuery.isFetchingNextPage ? "Loading..." : "Load more"}
              </Button>
            </div>
          ) : null}
        </Card>

        <div className="space-y-6">
          <Card className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Operator shortcuts</h2>
              <Badge>{owner}</Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link
                className="ag-focus-ring inline-flex h-8 items-center justify-center rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] px-3 text-[13px] font-medium text-[var(--ag-text-primary)] transition-colors duration-[var(--ag-duration-fast)] hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-hover)]"
                href={repositoryHref}
              >
                Repository overview
              </Link>
              <Link
                className="ag-focus-ring inline-flex h-8 items-center justify-center rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] px-3 text-[13px] font-medium text-[var(--ag-text-primary)] transition-colors duration-[var(--ag-duration-fast)] hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-hover)]"
                href={policyHref}
              >
                Policy posture
              </Link>
              <Link
                className="ag-focus-ring inline-flex h-8 items-center justify-center rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] px-3 text-[13px] font-medium text-[var(--ag-text-primary)] transition-colors duration-[var(--ag-duration-fast)] hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-hover)]"
                href={snapshotsHref}
              >
                Snapshots
              </Link>
            </div>
            <p className="text-sm text-[var(--ag-text-secondary)]">
              Use this rail to move quickly between posture, recovery, and deep run inspection for the same repository.
            </p>
          </Card>

          <Card className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Run posture</h2>
              <Badge tone={failedRuns > 0 ? "warning" : "success"}>{failedRuns > 0 ? "watch closely" : "steady"}</Badge>
            </div>
            <div className="grid gap-3 rounded-[var(--ag-radius-lg)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] p-4 text-sm">
              <div className="flex items-center justify-between gap-4">
                <span className="text-[var(--ag-text-secondary)]">Latest run</span>
                <span className="font-medium">{latestRun ? latestRun.workflowName : "No runs recorded"}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-[var(--ag-text-secondary)]">Operator attention</span>
                <span className="font-medium">{attentionCount > 0 ? `${attentionCount} runs` : "None right now"}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-[var(--ag-text-secondary)]">Realtime status</span>
                <span className="font-medium">{liveLabel}</span>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
