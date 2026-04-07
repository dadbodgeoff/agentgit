"use client";

import Link from "next/link";

import { PageStatePanel } from "@/components/feedback";
import { Button, Card } from "@/components/primitives";
import { ScaffoldPage } from "@/features/shared/scaffold-page";
import { getApiErrorMessage } from "@/lib/api/client";
import { repositoryRunsRoute } from "@/lib/navigation/routes";
import { useRepositoryDetailQuery } from "@/lib/query/hooks";
import type { PreviewState } from "@/schemas/cloud";
import { formatAbsoluteDate, formatRelativeTimestamp } from "@/lib/utils/format";

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

  return (
    <ScaffoldPage
      actions={
        <Link
          className="ag-focus-ring inline-flex h-9 items-center justify-center rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] px-3 text-sm font-medium text-[var(--ag-text-primary)] transition-colors hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-hover)]"
          href={repositoryRunsRoute(owner, name)}
        >
          Open run history
        </Link>
      }
      description={`Repository detail for ${owner}/${name}, including health, activity, and run posture.`}
      metrics={[
        { label: "Agent posture", value: repository.agentStatus, trend: repository.lastRunStatus },
        { label: "Pending approvals", value: String(repository.pendingApprovalCount), trend: "active review load" },
        { label: "Runs tracked", value: String(repository.totalRuns), trend: `${repository.failedRuns24h} failed in 24h` },
      ]}
      sections={[
        { title: "Repository posture", description: "Live repository metadata and current governed status." },
        { title: "Recent activity", description: "Latest authority events associated with the repository.", kind: "status" },
        { title: "Runtime context", description: "Repository root and latest workflow pointers for debugging.", kind: "code" },
      ]}
      title={`${owner}/${name}`}
    >
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.9fr)]">
        <Card className="space-y-4">
          <h2 className="text-lg font-semibold">Recent activity</h2>
          <div className="space-y-3">
            {repository.recentActivity.length > 0 ? (
              repository.recentActivity.map((activity) => (
                <div
                  className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3"
                  key={activity.id}
                >
                  <div className="text-sm font-medium text-[var(--ag-text-primary)]">{activity.message}</div>
                  <div className="mt-1 text-xs text-[var(--ag-text-secondary)]">
                    {formatRelativeTimestamp(activity.createdAt)} · {activity.tone}
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

        <Card className="space-y-4">
          <h2 className="text-lg font-semibold">Runtime context</h2>
          <div className="space-y-3 text-sm">
            <div>
              <div className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">Default branch</div>
              <div className="mt-1 font-medium">{repository.defaultBranch}</div>
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
