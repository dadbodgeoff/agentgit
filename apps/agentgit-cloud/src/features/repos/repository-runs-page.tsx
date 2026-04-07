"use client";

import Link from "next/link";

import { PageStatePanel } from "@/components/feedback";
import {
  Button,
  Card,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRoot,
  TableRow,
} from "@/components/primitives";
import { ScaffoldPage } from "@/features/shared/scaffold-page";
import { getApiErrorMessage } from "@/lib/api/client";
import { runDetailRoute } from "@/lib/navigation/routes";
import { useRepositoryRunsQuery } from "@/lib/query/hooks";
import type { PreviewState } from "@/schemas/cloud";
import { formatRelativeTimestamp } from "@/lib/utils/format";

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

  if (runsQuery.isPending) {
    return (
      <ScaffoldPage
        actions={<Button variant="secondary">Refresh runs</Button>}
        description={`Run history for ${owner}/${name} with route-based navigation into detail.`}
        sections={[]}
        title={`${owner}/${name} runs`}
      >
        <PageStatePanel state="loading" />
      </ScaffoldPage>
    );
  }

  if (runsQuery.isError) {
    const errorMessage = getApiErrorMessage(runsQuery.error, "Could not load repository runs. Retry.");

    return (
      <ScaffoldPage
        actions={<Button variant="secondary">Refresh runs</Button>}
        description={`Run history for ${owner}/${name} with route-based navigation into detail.`}
        sections={[]}
        title={`${owner}/${name} runs`}
      >
        <PageStatePanel errorMessage={errorMessage} state="error" />
      </ScaffoldPage>
    );
  }

  const runs = runsQuery.data;

  return (
    <ScaffoldPage
      actions={<Button variant="secondary">Refresh runs</Button>}
      description={`Run history for ${owner}/${name} with route-based navigation into detail.`}
      metrics={[
        { label: "Tracked runs", value: String(runs.total), trend: "authority journal" },
        {
          label: "Failed runs",
          value: String(runs.items.filter((run) => run.status === "failed").length),
          trend: "latest known state",
        },
        {
          label: "Running now",
          value: String(runs.items.filter((run) => run.status === "running").length),
          trend: "in progress",
        },
      ]}
      sections={[
        { title: "Run filters", description: "Route-ready filtering and sorting rail for repository history." },
        { title: "Run table", description: "Backend-backed run inventory with detail links.", kind: "table" },
      ]}
      title={`${owner}/${name} runs`}
    >
      {runs.items.length === 0 ? (
        <PageStatePanel
          emptyDescription="This repository has not recorded any governed runs yet."
          emptyTitle="No runs yet"
          state="empty"
        />
      ) : (
        <Card className="space-y-4">
          <h2 className="text-lg font-semibold">Run history</h2>
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
                    </div>
                  </TableCell>
                  <TableCell className="capitalize">{run.status}</TableCell>
                  <TableCell>{run.agentName}</TableCell>
                  <TableCell className="text-[var(--ag-text-secondary)]">{formatRelativeTimestamp(run.startedAt)}</TableCell>
                  <TableCell className="text-[var(--ag-text-secondary)]">{formatRelativeTimestamp(run.updatedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </TableRoot>
        </Card>
      )}
    </ScaffoldPage>
  );
}
