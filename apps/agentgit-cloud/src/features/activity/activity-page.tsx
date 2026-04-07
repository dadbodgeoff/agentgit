"use client";

import Link from "next/link";

import { Card } from "@/components/primitives";
import { PageStatePanel } from "@/components/feedback";
import { PageHeader } from "@/components/composites";
import { useActivityQuery } from "@/lib/query/hooks";
import { getApiErrorMessage } from "@/lib/api/client";
import { formatRelativeTimestamp } from "@/lib/utils/format";

export function ActivityPage() {
  const activityQuery = useActivityQuery();

  if (activityQuery.isPending) {
    return (
      <>
        <PageHeader
          description="Workspace-wide governed activity from runs, approvals, recoveries, and connector commands."
          title="Activity"
        />
        <PageStatePanel state="loading" />
      </>
    );
  }

  if (activityQuery.isError) {
    return (
      <>
        <PageHeader
          description="Workspace-wide governed activity from runs, approvals, recoveries, and connector commands."
          title="Activity"
        />
        <PageStatePanel errorMessage={getApiErrorMessage(activityQuery.error, "Could not load activity. Retry.")} state="error" />
      </>
    );
  }

  const activity = activityQuery.data;
  if (activity.items.length === 0) {
    return (
      <>
        <PageHeader
          description="Workspace-wide governed activity from runs, approvals, recoveries, and connector commands."
          title="Activity"
        />
        <PageStatePanel
          emptyTitle="No activity yet"
          emptyDescription="Activity will appear here as governed runs, approvals, and connector actions are recorded."
          state="empty"
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        description="Workspace-wide governed activity from runs, approvals, recoveries, and connector commands."
        title="Activity"
      />
      <div className="space-y-4">
        {activity.items.map((item) => (
          <Card className="space-y-3" key={item.id}>
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <div className="text-sm font-semibold text-[var(--ag-text-primary)]">{item.title ?? item.message}</div>
                <div className="text-sm text-[var(--ag-text-secondary)]">{item.message}</div>
              </div>
              <div className="text-xs text-[var(--ag-text-tertiary)]">{formatRelativeTimestamp(item.createdAt)}</div>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--ag-text-secondary)]">
              <span>{item.repo}</span>
              {item.actorLabel ? <span>{item.actorLabel}</span> : null}
              {item.runId ? <span className="font-mono">{item.runId}</span> : null}
              {item.detailPath ? (
                <Link className="font-medium text-[var(--ag-color-brand)] underline-offset-4 hover:underline" href={item.detailPath}>
                  Open detail
                </Link>
              ) : null}
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
