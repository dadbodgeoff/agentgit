"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import {
  Card,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRoot,
  TableRow,
  TabList,
  TabTrigger,
} from "@/components/primitives";
import { PageStatePanel, StaleIndicator } from "@/components/feedback";
import { RepositoryConnectionDialog } from "@/features/repos/repository-connection-dialog";
import { ScaffoldPage } from "@/features/shared/scaffold-page";
import { WorkspaceSetupChecklist } from "@/features/shared/workspace-setup-checklist";
import { useLiveUpdateStatus } from "@/components/providers/live-update-context";
import { getApiErrorMessage } from "@/lib/api/client";
import { authenticatedRoutes, repositoryRoute, runDetailRoute } from "@/lib/navigation/routes";
import { useDashboardQuery } from "@/lib/query/hooks";
import { sanitizeExternalUrl } from "@/lib/security/external-url";
import type { ActivityEvent, RecentRun } from "@/schemas/cloud";
import type { PreviewState } from "@/schemas/cloud";
import { formatRelativeTimestamp } from "@/lib/utils/format";

type HotspotRepo = {
  repo: string;
  score: number;
  failedRuns: number;
  pendingSignals: number;
  latestTimestamp: string;
};

type DashboardFocus = "all" | "approvals" | "failures" | "recovery" | "fleet";

function repoScoreForRun(run: RecentRun): number {
  if (run.status === "failed") {
    return 4;
  }

  if (run.status === "running") {
    return 2;
  }

  return 1;
}

function repoScoreForActivity(activity: ActivityEvent): number {
  if (activity.tone === "error") {
    return 4;
  }

  if (activity.tone === "warning" || activity.tone === "accent") {
    return 2;
  }

  return 1;
}

function buildHotspotRepos(runs: RecentRun[], activity: ActivityEvent[]): HotspotRepo[] {
  const byRepo = new Map<string, HotspotRepo>();

  for (const run of runs) {
    const existing = byRepo.get(run.repo) ?? {
      repo: run.repo,
      score: 0,
      failedRuns: 0,
      pendingSignals: 0,
      latestTimestamp: run.timestamp,
    };

    existing.score += repoScoreForRun(run);
    existing.latestTimestamp =
      new Date(run.timestamp).getTime() > new Date(existing.latestTimestamp).getTime()
        ? run.timestamp
        : existing.latestTimestamp;

    if (run.status === "failed") {
      existing.failedRuns += 1;
    }

    byRepo.set(run.repo, existing);
  }

  for (const event of activity) {
    const existing = byRepo.get(event.repo) ?? {
      repo: event.repo,
      score: 0,
      failedRuns: 0,
      pendingSignals: 0,
      latestTimestamp: event.createdAt,
    };

    existing.score += repoScoreForActivity(event);
    existing.latestTimestamp =
      new Date(event.createdAt).getTime() > new Date(existing.latestTimestamp).getTime()
        ? event.createdAt
        : existing.latestTimestamp;

    if (event.tone === "warning" || event.tone === "accent" || event.tone === "error") {
      existing.pendingSignals += 1;
    }

    byRepo.set(event.repo, existing);
  }

  return [...byRepo.values()]
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return new Date(right.latestTimestamp).getTime() - new Date(left.latestTimestamp).getTime();
    })
    .slice(0, 5);
}

function buildAttentionQueue(runs: RecentRun[], activity: ActivityEvent[]) {
  const items = [];

  const failedRun = runs.find((run) => run.status === "failed");
  if (failedRun) {
    items.push({
      href: (() => {
        const [owner, name] = failedRun.repo.split("/");
        return owner && name ? runDetailRoute(owner, name, failedRun.id) : authenticatedRoutes.repositories;
      })(),
      label: "Investigate failed run",
      detail: `${failedRun.repo} failed ${formatRelativeTimestamp(failedRun.timestamp)}.`,
      tone: "warning" as const,
    });
  }

  const pendingApproval = activity.find((event) => event.tone === "accent");
  if (pendingApproval) {
    items.push({
      href: authenticatedRoutes.approvals,
      label: "Review approval queue",
      detail: `${pendingApproval.repo} needs human review ${formatRelativeTimestamp(pendingApproval.createdAt)}.`,
      tone: "warning" as const,
    });
  }

  const recovery = activity.find((event) => event.tone === "warning");
  if (recovery) {
    items.push({
      href: authenticatedRoutes.audit,
      label: "Verify recovery outcome",
      detail: `${recovery.repo} recorded a recovery event ${formatRelativeTimestamp(recovery.createdAt)}.`,
      tone: "neutral" as const,
    });
  }

  items.push({
    href: authenticatedRoutes.connectors,
    label: "Inspect connector fleet",
    detail: "Check connector health, leases, and recent command history.",
    tone: liveUpdateStatusTone(activity),
  });

  return items.slice(0, 4);
}

function liveUpdateStatusTone(activity: ActivityEvent[]): "neutral" | "warning" {
  return activity.some((event) => event.tone === "warning" || event.tone === "error") ? "warning" : "neutral";
}

export function DashboardPage({ previewState = "ready" }: { previewState?: PreviewState }) {
  const dashboardQuery = useDashboardQuery(previewState);
  const liveUpdateStatus = useLiveUpdateStatus();
  const [focus, setFocus] = useState<DashboardFocus>("all");

  if (dashboardQuery.isPending) {
    return (
      <>
        <ScaffoldPage
          actions={<RepositoryConnectionDialog />}
          description="Hosted overview for recent runs, approval demand, activity, and environment health."
          sections={[]}
          title="Dashboard"
        >
          <PageStatePanel state="loading" />
        </ScaffoldPage>
      </>
    );
  }

  if (dashboardQuery.isError) {
    const errorMessage = getApiErrorMessage(dashboardQuery.error, "Could not load dashboard data. Retry.");

    return (
      <ScaffoldPage
        actions={<RepositoryConnectionDialog />}
        description="Hosted overview for recent runs, approval demand, activity, and environment health."
        sections={[]}
        title="Dashboard"
      >
        <PageStatePanel errorMessage={errorMessage} state="error" />
      </ScaffoldPage>
    );
  }

  const dashboard = dashboardQuery.data;
  const hotspotRepos = buildHotspotRepos(dashboard.recentRuns, dashboard.recentActivity);
  const attentionQueue = buildAttentionQueue(dashboard.recentRuns, dashboard.recentActivity);
  const focusedActivity = useMemo(() => {
    return dashboard.recentActivity.filter((activity) => {
      if (focus === "all") {
        return true;
      }

      if (focus === "approvals") {
        return activity.kind === "approval_requested" || activity.kind === "approval_resolved";
      }

      if (focus === "failures") {
        return activity.kind === "run_failed" || activity.tone === "error";
      }

      if (focus === "recovery") {
        return activity.kind === "snapshot_restored";
      }

      return activity.kind === "connector_command" || activity.kind === "connector_event";
    });
  }, [dashboard.recentActivity, focus]);
  const writebackCount = dashboard.recentActivity.filter(
    (activity) =>
      activity.kind === "connector_command" &&
      ((activity.title?.toLowerCase().includes("pull request") ?? false) ||
        (activity.title?.toLowerCase().includes("commit") ?? false) ||
        (activity.title?.toLowerCase().includes("branch pushed") ?? false)),
  ).length;
  const recoveryCount = dashboard.recentActivity.filter((activity) => activity.kind === "snapshot_restored").length;
  const approvalCount = dashboard.recentActivity.filter(
    (activity) => activity.kind === "approval_requested" || activity.kind === "approval_resolved",
  ).length;
  const liveLabel =
    liveUpdateStatus.state === "connected"
      ? liveUpdateStatus.lastInvalidatedAt
        ? `live · updated ${formatRelativeTimestamp(liveUpdateStatus.lastInvalidatedAt)}`
        : "live · connected"
      : liveUpdateStatus.state === "degraded"
        ? "live stream degraded"
        : "connecting live stream";
  const liveTone =
    liveUpdateStatus.state === "connected"
      ? ("success" as const)
      : liveUpdateStatus.state === "degraded"
        ? ("warning" as const)
        : ("neutral" as const);

  if (dashboard.metrics.length === 0) {
    return (
      <ScaffoldPage
        actions={<RepositoryConnectionDialog />}
        description="Hosted overview for recent runs, approval demand, activity, and environment health."
        sections={[]}
        title="Dashboard"
      >
        <PageStatePanel
          emptyActionLabel="Connect repository"
          emptyDescription="Connect your first repository to get started."
          emptyTitle="No dashboard data yet"
          state="empty"
        />
      </ScaffoldPage>
    );
  }

  return (
    <ScaffoldPage
      actions={<RepositoryConnectionDialog />}
      description="Hosted overview for recent runs, approval demand, activity, and environment health."
      metrics={dashboard.metrics.map((metric) => ({ label: metric.label, trend: metric.trend, value: metric.value }))}
      sections={[
        { title: "Metric cards", description: "KPI row for repositories, approvals, failures, and deploy posture." },
        {
          title: "Recent runs",
          description: "Table scaffold for repo, branch, status, duration, and timestamp.",
          kind: "table",
        },
        {
          title: "Attention queue",
          description: "Operator checklist for approvals, failures, recoveries, and fleet health.",
          kind: "status",
        },
        {
          title: "Agent activity",
          description: "Timeline rail for live agent actions and escalation events.",
          kind: "status",
        },
      ]}
      sidePanel={
        <div className="space-y-6">
          <WorkspaceSetupChecklist compact />

          <Card className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Control-plane posture</h2>
              <StaleIndicator
                label={dashboard.lastUpdatedAt ? formatRelativeTimestamp(dashboard.lastUpdatedAt) : "just now"}
              />
            </div>
            <div className="space-y-3 text-sm text-[var(--ag-text-secondary)]">
              <div className="flex items-center justify-between gap-3">
                <span>Control-plane pulse</span>
                <StaleIndicator label={liveLabel} tone={liveTone} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Live invalidations</span>
                <span className="font-mono text-[var(--ag-text-primary)]">{liveUpdateStatus.invalidationCount}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Next operator surface</span>
                <Link
                  className="font-medium text-[var(--ag-color-brand)] underline-offset-4 hover:underline"
                  href={authenticatedRoutes.connectors}
                >
                  Open fleet
                </Link>
              </div>
            </div>
          </Card>

          <Card className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Attention queue</h2>
              <Link
                className="text-sm font-medium text-[var(--ag-color-brand)] underline-offset-4 hover:underline"
                href={authenticatedRoutes.audit}
              >
                Open audit
              </Link>
            </div>
            <div className="space-y-3">
              {attentionQueue.map((item) => (
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
                    <StaleIndicator label={item.tone === "warning" ? "needs review" : "ready"} tone={item.tone} />
                  </div>
                </Link>
              ))}
            </div>
          </Card>

          <Card className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Governed execution</h2>
              <Link
                className="text-sm font-medium text-[var(--ag-color-brand)] underline-offset-4 hover:underline"
                href={authenticatedRoutes.connectors}
              >
                Open fleet
              </Link>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3">
                <div className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">Writeback</div>
                <div className="mt-2 text-2xl font-semibold">{writebackCount}</div>
                <div className="mt-1 text-sm text-[var(--ag-text-secondary)]">commit, push, and PR outcomes</div>
              </div>
              <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3">
                <div className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">Recovery</div>
                <div className="mt-2 text-2xl font-semibold">{recoveryCount}</div>
                <div className="mt-1 text-sm text-[var(--ag-text-secondary)]">restore and rollback signals</div>
              </div>
              <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3">
                <div className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">Approvals</div>
                <div className="mt-2 text-2xl font-semibold">{approvalCount}</div>
                <div className="mt-1 text-sm text-[var(--ag-text-secondary)]">operator review touchpoints</div>
              </div>
            </div>
          </Card>
        </div>
      }
      title="Dashboard"
    >
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(320px,0.95fr)]">
        <Card className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Recent runs</h2>
            <Link
              className="text-sm font-medium text-[var(--ag-color-brand)] underline-offset-4 hover:underline"
              href={authenticatedRoutes.repositories}
            >
              Open repositories
            </Link>
          </div>
          <TableRoot>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Repository</TableHeaderCell>
                <TableHeaderCell>Branch</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Duration</TableHeaderCell>
                <TableHeaderCell>Updated</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {dashboard.recentRuns.map((run) => {
                const [owner, name] = run.repo.split("/");

                return (
                  <TableRow key={run.id}>
                    <TableCell className="font-medium">
                      {owner && name ? (
                        <Link
                          className="text-[var(--ag-text-primary)] underline-offset-4 hover:text-[var(--ag-color-brand)] hover:underline"
                          href={repositoryRoute(owner, name)}
                        >
                          {run.repo}
                        </Link>
                      ) : (
                        run.repo
                      )}
                    </TableCell>
                    <TableCell>{run.branch}</TableCell>
                    <TableCell className="capitalize">{run.status}</TableCell>
                    <TableCell className="font-mono">{run.duration}</TableCell>
                    <TableCell className="text-[var(--ag-text-secondary)]">
                      {owner && name ? (
                        <Link
                          className="underline-offset-4 hover:text-[var(--ag-color-brand)] hover:underline"
                          href={runDetailRoute(owner, name, run.id)}
                        >
                          {formatRelativeTimestamp(run.timestamp)}
                        </Link>
                      ) : (
                        formatRelativeTimestamp(run.timestamp)
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </TableRoot>
        </Card>

        <div className="space-y-6">
          <Card className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Hotspot repositories</h2>
              <Link
                className="text-sm font-medium text-[var(--ag-color-brand)] underline-offset-4 hover:underline"
                href={authenticatedRoutes.repositories}
              >
                Open repositories
              </Link>
            </div>
            <div className="space-y-3">
              {hotspotRepos.length > 0 ? (
                hotspotRepos.map((repo) => {
                  const [owner, name] = repo.repo.split("/");

                  return (
                    <div
                      className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3"
                      key={repo.repo}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-1">
                          <div className="text-sm font-medium text-[var(--ag-text-primary)]">
                            {owner && name ? (
                              <Link
                                className="underline-offset-4 hover:text-[var(--ag-color-brand)] hover:underline"
                                href={repositoryRoute(owner, name)}
                              >
                                {repo.repo}
                              </Link>
                            ) : (
                              repo.repo
                            )}
                          </div>
                          <div className="text-sm text-[var(--ag-text-secondary)]">
                            {repo.failedRuns > 0
                              ? `${repo.failedRuns} failed run${repo.failedRuns === 1 ? "" : "s"}`
                              : "No recent failed runs"}
                            {" · "}
                            {repo.pendingSignals} governance signal{repo.pendingSignals === 1 ? "" : "s"}
                          </div>
                        </div>
                        <StaleIndicator
                          label={`score ${repo.score}`}
                          tone={repo.failedRuns > 0 || repo.pendingSignals > 1 ? "warning" : "neutral"}
                        />
                      </div>
                      <div className="mt-2 text-xs text-[var(--ag-text-secondary)]">
                        Latest event {formatRelativeTimestamp(repo.latestTimestamp)}
                      </div>
                    </div>
                  );
                })
              ) : (
                <PageStatePanel
                  emptyDescription="Repository hotspots will appear once governed runs and activity are recorded."
                  emptyTitle="No hotspot repositories yet"
                  state="empty"
                />
              )}
            </div>
          </Card>

          <Card className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Governed activity</h2>
              <Link
                className="text-sm font-medium text-[var(--ag-color-brand)] underline-offset-4 hover:underline"
                href={authenticatedRoutes.activity}
              >
                Open full feed
              </Link>
            </div>
            <TabList>
              {(["all", "approvals", "failures", "recovery", "fleet"] as DashboardFocus[]).map((entry) => (
                <TabTrigger active={focus === entry} key={entry} onClick={() => setFocus(entry)}>
                  {entry}
                </TabTrigger>
              ))}
            </TabList>
            <div className="space-y-3">
              {focusedActivity.length > 0 ? (
                focusedActivity.slice(0, 6).map((activity) => (
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
                      <StaleIndicator
                        label={activity.tone}
                        tone={activity.tone === "warning" || activity.tone === "error" ? "warning" : "success"}
                      />
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-3 text-xs text-[var(--ag-text-secondary)]">
                      <div className="flex flex-wrap items-center gap-3">
                        <span>{activity.repo}</span>
                        {activity.detailPath ? (
                          <Link
                            className="font-medium text-[var(--ag-color-brand)] underline-offset-4 hover:underline"
                            href={activity.detailPath}
                          >
                            Open detail
                          </Link>
                        ) : null}
                        {sanitizeExternalUrl(activity.externalUrl) ? (
                          <a
                            className="font-medium text-[var(--ag-color-brand)] underline-offset-4 hover:underline"
                            href={sanitizeExternalUrl(activity.externalUrl)!}
                            rel="noopener noreferrer"
                            target="_blank"
                          >
                            Open provider
                          </a>
                        ) : null}
                      </div>
                      <span>{formatRelativeTimestamp(activity.createdAt)}</span>
                    </div>
                  </div>
                ))
              ) : (
                <PageStatePanel
                  emptyDescription={`No ${focus === "all" ? "governed" : focus} events are currently visible.`}
                  emptyTitle="No governed activity yet"
                  state="empty"
                />
              )}
            </div>
          </Card>
        </div>
      </div>
    </ScaffoldPage>
  );
}
