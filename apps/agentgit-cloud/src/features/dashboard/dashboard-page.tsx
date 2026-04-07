"use client";

import { Card, TableBody, TableCell, TableHead, TableHeaderCell, TableRoot, TableRow } from "@/components/primitives";
import { PageStatePanel, StaleIndicator } from "@/components/feedback";
import { Button } from "@/components/primitives";
import { ScaffoldPage } from "@/features/shared/scaffold-page";
import { useDashboardQuery } from "@/lib/query/hooks";
import { parsePreviewState } from "@/lib/navigation/search-params";
import { formatRelativeTimestamp } from "@/lib/utils/format";
import { useSearchParams } from "next/navigation";

export function DashboardPage(): JSX.Element {
  const searchParams = useSearchParams();
  const previewState = parsePreviewState(searchParams);
  const dashboardQuery = useDashboardQuery(previewState);

  if (dashboardQuery.isPending) {
    return (
      <>
        <ScaffoldPage
          actions={<Button>Connect repository</Button>}
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
    return (
      <ScaffoldPage
        actions={<Button>Connect repository</Button>}
        description="Hosted overview for recent runs, approval demand, activity, and environment health."
        sections={[]}
        title="Dashboard"
      >
        <PageStatePanel errorMessage="Could not load dashboard data. Retry." state="error" />
      </ScaffoldPage>
    );
  }

  const dashboard = dashboardQuery.data;

  if (dashboard.metrics.length === 0) {
    return (
      <ScaffoldPage
        actions={<Button>Connect repository</Button>}
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
      actions={<Button>Connect repository</Button>}
      description="Hosted overview for recent runs, approval demand, activity, and environment health."
      metrics={dashboard.metrics.map((metric) => ({ label: metric.label, trend: metric.trend, value: metric.value }))}
      sections={[
        { title: "Metric cards", description: "KPI row for repositories, approvals, failures, and deploy posture." },
        { title: "Recent runs", description: "Table scaffold for repo, branch, status, duration, and timestamp.", kind: "table" },
        { title: "Agent activity", description: "Timeline rail for live agent actions and escalation events.", kind: "status" },
      ]}
      sidePanel={
        <Card className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Data freshness</h2>
            <StaleIndicator label={dashboard.lastUpdatedAt ? formatRelativeTimestamp(dashboard.lastUpdatedAt) : "just now"} />
          </div>
          <p className="text-sm text-[var(--ag-text-secondary)]">
            Use <code>?state=empty</code> or <code>?state=error</code> on this route to preview the standard page-state
            rail.
          </p>
        </Card>
      }
      title="Dashboard"
    >
      <Card className="space-y-4">
        <h2 className="text-lg font-semibold">Recent runs</h2>
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
            {dashboard.recentRuns.map((run) => (
              <TableRow key={run.id}>
                <TableCell className="font-medium">{run.repo}</TableCell>
                <TableCell>{run.branch}</TableCell>
                <TableCell className="capitalize">{run.status}</TableCell>
                <TableCell className="font-mono">{run.duration}</TableCell>
                <TableCell className="text-[var(--ag-text-secondary)]">{formatRelativeTimestamp(run.timestamp)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </TableRoot>
      </Card>
    </ScaffoldPage>
  );
}
