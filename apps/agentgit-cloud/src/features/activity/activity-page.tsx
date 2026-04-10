"use client";

import Link from "next/link";
import { useState } from "react";

import { MetricCard, PageHeader } from "@/components/composites";
import { PageStatePanel } from "@/components/feedback";
import { Badge, Button, Card, Input, TabList, TabTrigger } from "@/components/primitives";
import { getApiErrorMessage } from "@/lib/api/client";
import { useWorkspace } from "@/lib/auth/workspace-context";
import { authenticatedRoutes, repositoryRoute, runDetailRoute } from "@/lib/navigation/routes";
import { useActivityQuery } from "@/lib/query/hooks";
import { hasAtLeastRole } from "@/lib/rbac/roles";
import { sanitizeExternalUrl } from "@/lib/security/external-url";
import { formatRelativeTimestamp } from "@/lib/utils/format";

type ActivityGroup = "all" | "approvals" | "runs" | "recovery" | "connector" | "policy";

function activityGroupForKind(kind: string | undefined): ActivityGroup {
  switch (kind) {
    case "approval_requested":
    case "approval_resolved":
      return "approvals";
    case "run_started":
    case "run_completed":
    case "run_failed":
      return "runs";
    case "snapshot_restored":
      return "recovery";
    case "connector_command":
    case "connector_event":
      return "connector";
    case "policy_changed":
      return "policy";
    default:
      return "runs";
  }
}

function activityToneLabel(tone: string) {
  return tone === "neutral" ? "stable" : tone;
}

function splitRepoLabel(repo: string): { owner: string; name: string } | null {
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    return null;
  }

  return { owner, name };
}

export function ActivityPage() {
  const activityQuery = useActivityQuery();
  const { activeWorkspace } = useWorkspace();
  const [selectedGroup, setSelectedGroup] = useState<ActivityGroup>("all");
  const [search, setSearch] = useState("");
  const canAccessAudit = hasAtLeastRole(activeWorkspace.role, "admin");
  const headerAction = canAccessAudit ? (
    <Link
      className="ag-focus-ring inline-flex h-9 items-center justify-center rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] px-3 text-sm font-medium text-[var(--ag-text-primary)] transition-colors hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-hover)]"
      href={authenticatedRoutes.audit}
    >
      Open audit log
    </Link>
  ) : null;

  if (activityQuery.isPending) {
    return (
      <>
        <PageHeader
          actions={headerAction}
          description="Workspace-wide governed activity from runs, approvals, recoveries, and connector commands."
          title="Activity"
        />
        <PageStatePanel state="loading" />
      </>
    );
  }

  if (activityQuery.isError || !activityQuery.data) {
    return (
      <>
        <PageHeader
          actions={headerAction}
          description="Workspace-wide governed activity from runs, approvals, recoveries, and connector commands."
          title="Activity"
        />
        <PageStatePanel
          errorMessage={getApiErrorMessage(activityQuery.error, "Could not load activity. Retry.")}
          state="error"
        />
      </>
    );
  }

  const activity = activityQuery.data;
  const normalizedSearch = search.trim().toLowerCase();
  const filteredItems = (
    selectedGroup === "all"
      ? activity.items
      : activity.items.filter((item) => activityGroupForKind(item.kind) === selectedGroup)
  ).filter(
    (item) =>
      normalizedSearch.length === 0 ||
      item.message.toLowerCase().includes(normalizedSearch) ||
      item.repo.toLowerCase().includes(normalizedSearch) ||
      (item.title?.toLowerCase().includes(normalizedSearch) ?? false) ||
      (item.actorLabel?.toLowerCase().includes(normalizedSearch) ?? false) ||
      (item.runId?.toLowerCase().includes(normalizedSearch) ?? false),
  );

  const counts = activity.items.reduce(
    (acc, item) => {
      const group = activityGroupForKind(item.kind);
      acc[group] += 1;
      acc.all += 1;
      return acc;
    },
    {
      all: 0,
      approvals: 0,
      runs: 0,
      recovery: 0,
      connector: 0,
      policy: 0,
    } satisfies Record<ActivityGroup, number>,
  );

  if (activity.items.length === 0) {
    return (
      <>
        <PageHeader
          actions={headerAction}
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
        actions={headerAction}
        description="Workspace-wide governed activity from runs, approvals, recoveries, and connector commands."
        title="Activity"
      />
      <div className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <MetricCard label="Approvals" value={String(counts.approvals)} trend="review gates and resolutions" />
          <MetricCard label="Runs" value={String(counts.runs)} trend="executions and failures" />
          <MetricCard label="Recoveries" value={String(counts.recovery)} trend="snapshot restore events" />
          <MetricCard label="Connector activity" value={String(counts.connector)} trend="local connector commands" />
          <MetricCard label="Policy events" value={String(counts.policy)} trend="policy sync and evaluation" />
        </div>

        <Card className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">Activity filters</h2>
              <p className="text-sm text-[var(--ag-text-secondary)]">
                Narrow the feed by governed event family without losing the repo and action context.
              </p>
            </div>
            <Badge tone="accent">{filteredItems.length} visible</Badge>
          </div>
          <Input
            helpText="Search by repository, message, actor, or run id."
            id="activity-search"
            label="Search activity"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search governed events"
            value={search}
          />
          <TabList>
            {(["all", "approvals", "runs", "recovery", "connector", "policy"] as ActivityGroup[]).map((group) => (
              <TabTrigger active={selectedGroup === group} key={group} onClick={() => setSelectedGroup(group)}>
                {group === "all" ? "All" : group}
              </TabTrigger>
            ))}
          </TabList>
        </Card>

        {filteredItems.length === 0 ? (
          <PageStatePanel
            emptyDescription={
              selectedGroup === "all"
                ? "Governed events will appear here as runs, approvals, recoveries, and connector actions are recorded."
                : `No ${selectedGroup} activity is currently visible.`
            }
            emptyTitle="No matching activity"
            state="empty"
          />
        ) : (
          <div className="space-y-4">
            {filteredItems.map((item) => {
              const repoParts = splitRepoLabel(item.repo);

              return (
                <Card className="space-y-3" key={item.id}>
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          tone={
                            item.tone === "error"
                              ? "error"
                              : item.tone === "warning"
                                ? "warning"
                                : item.tone === "accent"
                                  ? "accent"
                                  : "neutral"
                          }
                        >
                          {activityToneLabel(item.tone)}
                        </Badge>
                        <Badge tone="neutral">{activityGroupForKind(item.kind ?? undefined)}</Badge>
                        {item.kind ? <Badge tone="neutral">{item.kind.replace(/_/g, " ")}</Badge> : null}
                      </div>
                      <div className="text-sm font-semibold text-[var(--ag-text-primary)]">
                        {item.title ?? item.message}
                      </div>
                      <div className="text-sm text-[var(--ag-text-secondary)]">{item.message}</div>
                    </div>
                    <div className="text-xs text-[var(--ag-text-tertiary)]">
                      {formatRelativeTimestamp(item.createdAt)}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--ag-text-secondary)]">
                    <span>{item.repo}</span>
                    {item.actorLabel ? <span>{item.actorLabel}</span> : null}
                    {item.runId ? <span className="font-mono">{item.runId}</span> : null}
                    {repoParts ? (
                      <Link
                        className="font-medium text-[var(--ag-color-brand)] underline-offset-4 hover:underline"
                        href={repositoryRoute(repoParts.owner, repoParts.name)}
                      >
                        Open repo
                      </Link>
                    ) : null}
                    {item.runId && repoParts ? (
                      <Link
                        className="font-medium text-[var(--ag-color-brand)] underline-offset-4 hover:underline"
                        href={runDetailRoute(repoParts.owner, repoParts.name, item.runId)}
                      >
                        Open run
                      </Link>
                    ) : null}
                    {item.detailPath ? (
                      <Link
                        className="font-medium text-[var(--ag-color-brand)] underline-offset-4 hover:underline"
                        href={item.detailPath}
                      >
                        Open detail
                      </Link>
                    ) : null}
                    {sanitizeExternalUrl(item.externalUrl) ? (
                      <a
                        className="font-medium text-[var(--ag-color-brand)] underline-offset-4 hover:underline"
                        href={sanitizeExternalUrl(item.externalUrl)!}
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        Open provider
                      </a>
                    ) : null}
                  </div>
                </Card>
              );
            })}
            {activityQuery.hasNextPage ? (
              <Card className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">More activity available</h2>
                  <p className="text-sm text-[var(--ag-text-secondary)]">
                    Showing {activity.items.length} of {activity.total} events loaded into the feed.
                  </p>
                </div>
                <Button
                  disabled={activityQuery.isFetchingNextPage}
                  onClick={() => void activityQuery.fetchNextPage()}
                  variant="secondary"
                >
                  {activityQuery.isFetchingNextPage ? "Loading..." : "Load more"}
                </Button>
              </Card>
            ) : null}
          </div>
        )}
      </div>
    </>
  );
}
