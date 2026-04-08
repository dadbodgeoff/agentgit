"use client";

import Link from "next/link";

import { PageStatePanel, StaleIndicator } from "@/components/feedback";
import { Badge, Button, Card } from "@/components/primitives";
import { useLiveUpdateStatus } from "@/components/providers/live-update-context";
import { ScaffoldPage } from "@/features/shared/scaffold-page";
import { getApiErrorMessage } from "@/lib/api/client";
import {
  authenticatedRoutes,
  repositoryPolicyRoute,
  repositoryRunsRoute,
  repositorySnapshotsRoute,
  runDetailRoute,
} from "@/lib/navigation/routes";
import { useRepositoryDetailQuery } from "@/lib/query/hooks";
import type { PreviewState } from "@/schemas/cloud";
import { formatAbsoluteDate, formatRelativeTimestamp } from "@/lib/utils/format";

function statusTone(status: string): "success" | "warning" | "error" | "neutral" {
  if (status === "healthy" || status === "completed" || status === "verified") {
    return "success";
  }

  if (status === "escalated" || status === "failed" || status === "drifted" || status === "unreachable") {
    return "warning";
  }

  return "neutral";
}

export function RepositoryDetailPage({
  owner,
  name,
  previewState = "ready",
}: {
  owner: string;
  name: string;
  previewState?: PreviewState;
}) {
  const repositoryQuery = useRepositoryDetailQuery(owner, name, previewState);
  const liveUpdateStatus = useLiveUpdateStatus();

  if (repositoryQuery.isPending) {
    return (
      <ScaffoldPage
        actions={<Button variant="secondary">Open run history</Button>}
        description={`Repository detail for ${owner}/${name}, including health, activity, and run posture.`}
        sections={[]}
        title={`${owner}/${name}`}
      >
        <PageStatePanel state="loading" />
      </ScaffoldPage>
    );
  }

  if (repositoryQuery.isError) {
    const errorMessage = getApiErrorMessage(repositoryQuery.error, "Could not load repository detail. Retry.");

    return (
      <ScaffoldPage
        actions={<Button variant="secondary">Open run history</Button>}
        description={`Repository detail for ${owner}/${name}, including health, activity, and run posture.`}
        sections={[]}
        title={`${owner}/${name}`}
      >
        <PageStatePanel errorMessage={errorMessage} state="error" />
      </ScaffoldPage>
    );
  }

  const repository = repositoryQuery.data;
  const liveLabel =
    liveUpdateStatus.state === "connected"
      ? liveUpdateStatus.lastInvalidatedAt
        ? `live · updated ${formatRelativeTimestamp(liveUpdateStatus.lastInvalidatedAt)}`
        : "live · connected"
      : liveUpdateStatus.state === "degraded"
        ? "live stream degraded"
        : "connecting live stream";
  const attentionItems = [
    repository.pendingApprovalCount > 0
      ? {
          href: authenticatedRoutes.approvals,
          label: "Pending approvals",
          detail: `${repository.pendingApprovalCount} approval gate${repository.pendingApprovalCount === 1 ? "" : "s"} need review for this repository.`,
          tone: "warning" as const,
        }
      : null,
    repository.failedRuns24h > 0
      ? {
          href: repository.latestRunId
            ? runDetailRoute(owner, name, repository.latestRunId)
            : repositoryRunsRoute(owner, name),
          label: "Failed run follow-up",
          detail: `${repository.failedRuns24h} failed run${repository.failedRuns24h === 1 ? "" : "s"} recorded in the last 24 hours.`,
          tone: "warning" as const,
        }
      : null,
    repository.latestRunId
      ? {
          href: runDetailRoute(owner, name, repository.latestRunId),
          label: "Open latest run",
          detail: `${repository.latestWorkflowName ?? "Latest workflow"} is the best place to inspect recent governed execution.`,
          tone: "neutral" as const,
        }
      : {
          href: repositoryPolicyRoute(owner, name),
          label: "Review repository policy",
          detail: "Confirm the repo-level policy and thresholds before the next governed run.",
          tone: "neutral" as const,
        },
  ].filter((item): item is NonNullable<typeof item> => item !== null);

  return (
    <ScaffoldPage
      actions={
        <div className="flex flex-wrap gap-2">
          <Link
            className="ag-focus-ring inline-flex h-9 items-center justify-center rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] px-3 text-sm font-medium text-[var(--ag-text-primary)] transition-colors hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-hover)]"
            href={repositoryRunsRoute(owner, name)}
          >
            Open run history
          </Link>
          <Link
            className="ag-focus-ring inline-flex h-9 items-center justify-center rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] px-3 text-sm font-medium text-[var(--ag-text-primary)] transition-colors hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-hover)]"
            href={repositoryPolicyRoute(owner, name)}
          >
            Open policy
          </Link>
          <Link
            className="ag-focus-ring inline-flex h-9 items-center justify-center rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] px-3 text-sm font-medium text-[var(--ag-text-primary)] transition-colors hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-hover)]"
            href={repositorySnapshotsRoute(owner, name)}
          >
            Open snapshots
          </Link>
        </div>
      }
      description={`Repository detail for ${owner}/${name}, including health, activity, and run posture.`}
      metrics={[
        { label: "Agent posture", value: repository.agentStatus, trend: repository.lastRunStatus },
        { label: "Pending approvals", value: String(repository.pendingApprovalCount), trend: "active review load" },
        {
          label: "Runs tracked",
          value: String(repository.totalRuns),
          trend: `${repository.failedRuns24h} failed in 24h`,
        },
      ]}
      sections={[
        { title: "Repository posture", description: "Live repository metadata and current governed status." },
        {
          title: "Attention queue",
          description: "Fast-path operator actions for approvals, failures, and policy review.",
          kind: "status",
        },
        {
          title: "Recent activity",
          description: "Latest authority events associated with the repository.",
          kind: "status",
        },
        {
          title: "Runtime context",
          description: "Repository root and latest workflow pointers for debugging.",
          kind: "code",
        },
      ]}
      title={`${owner}/${name}`}
    >
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.9fr)]">
        <div className="space-y-6">
          <Card className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Repository posture</h2>
              <StaleIndicator label={liveLabel} tone={liveUpdateStatus.state === "degraded" ? "warning" : "success"} />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3">
                <div className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">Agent status</div>
                <div className="mt-2 flex items-center gap-2">
                  <Badge tone={statusTone(repository.agentStatus)}>{repository.agentStatus}</Badge>
                  <Badge tone={statusTone(repository.lastRunStatus)}>{repository.lastRunStatus}</Badge>
                </div>
                <div className="mt-2 text-sm text-[var(--ag-text-secondary)]">
                  Last updated {formatRelativeTimestamp(repository.lastUpdatedAt)}.
                </div>
              </div>
              <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3">
                <div className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">
                  Provider identity
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <Badge tone="neutral">{repository.providerIdentity.provider}</Badge>
                  <Badge tone={statusTone(repository.providerIdentity.status)}>
                    {repository.providerIdentity.status}
                  </Badge>
                </div>
                <div className="mt-2 text-sm text-[var(--ag-text-secondary)]">
                  {repository.providerIdentity.statusReason ??
                    "Repository provider identity matches the local workspace."}
                </div>
              </div>
            </div>
          </Card>

          <Card className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Attention queue</h2>
              <Link
                className="text-sm font-medium text-[var(--ag-color-brand)] underline-offset-4 hover:underline"
                href={repositoryRunsRoute(owner, name)}
              >
                Open run history
              </Link>
            </div>
            <div className="space-y-3">
              {attentionItems.map((item) => (
                <Link
                  className="block rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3 transition-colors hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-hover)]"
                  href={item.href}
                  key={`${item.label}:${item.href}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="text-sm font-medium text-[var(--ag-text-primary)]">{item.label}</div>
                      <div className="text-sm text-[var(--ag-text-secondary)]">{item.detail}</div>
                    </div>
                    <StaleIndicator label={item.tone === "warning" ? "review" : "ready"} tone={item.tone} />
                  </div>
                </Link>
              ))}
            </div>
          </Card>

          <Card className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Recent activity</h2>
              {repository.latestRunId ? (
                <Link
                  className="text-sm font-medium text-[var(--ag-color-brand)] underline-offset-4 hover:underline"
                  href={runDetailRoute(owner, name, repository.latestRunId)}
                >
                  Open latest run
                </Link>
              ) : null}
            </div>
            <div className="space-y-3">
              {repository.recentActivity.length > 0 ? (
                repository.recentActivity.map((activity) => (
                  <div
                    className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3"
                    key={activity.id}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="text-sm font-medium text-[var(--ag-text-primary)]">
                          {activity.title ?? activity.message}
                        </div>
                        <div className="text-sm text-[var(--ag-text-secondary)]">{activity.message}</div>
                      </div>
                      <Badge tone={statusTone(activity.tone)}>{activity.tone}</Badge>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-[var(--ag-text-secondary)]">
                      <span>{formatRelativeTimestamp(activity.createdAt)}</span>
                      {activity.detailPath ? (
                        <Link
                          className="font-medium text-[var(--ag-color-brand)] underline-offset-4 hover:underline"
                          href={activity.detailPath}
                        >
                          Open detail
                        </Link>
                      ) : null}
                    </div>
                  </div>
                ))
              ) : (
                <PageStatePanel
                  emptyDescription="No governed run activity has been recorded for this repository yet."
                  emptyTitle="No activity yet"
                  state="empty"
                />
              )}
            </div>
          </Card>
        </div>

        <Card className="space-y-4">
          <h2 className="text-lg font-semibold">Runtime context</h2>
          <div className="space-y-3 text-sm">
            <div>
              <div className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">Default branch</div>
              <div className="mt-1 font-medium">{repository.defaultBranch}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">
                Provider identity
              </div>
              <div className="mt-1 flex items-center gap-2">
                <Badge tone="neutral">{repository.providerIdentity.provider}</Badge>
                <Badge tone={statusTone(repository.providerIdentity.status)}>
                  {repository.providerIdentity.status}
                </Badge>
              </div>
              {repository.providerIdentity.statusReason ? (
                <div className="mt-1 text-xs text-[var(--ag-text-secondary)]">
                  {repository.providerIdentity.statusReason}
                </div>
              ) : null}
            </div>
            <div>
              <div className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">Latest workflow</div>
              <div className="mt-1 font-medium">{repository.latestWorkflowName ?? "No governed runs yet"}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">Last updated</div>
              <div className="mt-1 font-medium">{formatAbsoluteDate(repository.lastUpdatedAt)}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">Workspace root</div>
              <div className="mt-1 font-mono text-xs text-[var(--ag-text-secondary)]">{repository.rootPath}</div>
            </div>
          </div>
        </Card>
      </div>
    </ScaffoldPage>
  );
}
