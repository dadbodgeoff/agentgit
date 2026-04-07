"use client";

import Link from "next/link";

import { Card, TableBody, TableCell, TableHead, TableHeaderCell, TableRoot, TableRow } from "@/components/primitives";
import { PageStatePanel } from "@/components/feedback";
import { Button } from "@/components/primitives";
import { ScaffoldPage } from "@/features/shared/scaffold-page";
import { getApiErrorMessage } from "@/lib/api/client";
import { repositoryRoute } from "@/lib/navigation/routes";
import { useRepositoriesQuery } from "@/lib/query/hooks";
import type { PreviewState } from "@/schemas/cloud";
import { formatRelativeTimestamp } from "@/lib/utils/format";

export function RepositoryListPage({ previewState = "ready" }: { previewState?: PreviewState }) {
  const repositoriesQuery = useRepositoriesQuery(previewState);

  if (repositoriesQuery.isPending) {
    return (
      <ScaffoldPage actions={<Button>Connect repository</Button>} description="Searchable repository inventory with status, last run, and agent posture." sections={[]} title="Repositories">
        <PageStatePanel state="loading" />
      </ScaffoldPage>
    );
  }

  if (repositoriesQuery.isError) {
    const errorMessage = getApiErrorMessage(repositoriesQuery.error, "Could not load repositories. Retry.");

    return (
      <ScaffoldPage actions={<Button>Connect repository</Button>} description="Searchable repository inventory with status, last run, and agent posture." sections={[]} title="Repositories">
        <PageStatePanel errorMessage={errorMessage} state="error" />
      </ScaffoldPage>
    );
  }

  const repositories = repositoriesQuery.data;

  if (repositories.items.length === 0) {
    return (
      <ScaffoldPage actions={<Button>Connect repository</Button>} description="Searchable repository inventory with status, last run, and agent posture." sections={[]} title="Repositories">
        <PageStatePanel
          emptyActionLabel="Connect repository"
          emptyDescription="Connect a GitHub, GitLab, or Bitbucket repository."
          emptyTitle="No repositories connected"
          state="empty"
        />
      </ScaffoldPage>
    );
  }

  return (
    <ScaffoldPage
      actions={<Button>Connect repository</Button>}
      description="Searchable repository inventory with status, last run, and agent posture."
      metrics={[
        { label: "Connected repositories", value: String(repositories.total), trend: "workspace inventory" },
        {
          label: "Escalated agents",
          value: String(repositories.items.filter((repo) => repo.agentStatus === "escalated").length),
          trend: "requires review",
        },
        {
          label: "Failing repos",
          value: String(repositories.items.filter((repo) => repo.lastRunStatus === "failed").length),
          trend: "latest run status",
        },
      ]}
      sections={[
        { title: "Filter bar", description: "Search, status, and sort controls live here." },
        { title: "Repository table", description: "Inventory for connected repositories and their latest state.", kind: "table" },
        { title: "Empty state", description: "Illustrated empty state with connect CTA.", kind: "empty" },
      ]}
      title="Repositories"
    >
      <Card className="space-y-4">
        <h2 className="text-lg font-semibold">Connected repositories</h2>
        <TableRoot>
          <TableHead>
            <TableRow>
              <TableHeaderCell>Repository</TableHeaderCell>
              <TableHeaderCell>Default branch</TableHeaderCell>
              <TableHeaderCell>Last run</TableHeaderCell>
              <TableHeaderCell>Agent</TableHeaderCell>
              <TableHeaderCell>Updated</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {repositories.items.map((repo) => (
              <TableRow key={repo.id}>
                <TableCell className="font-medium">
                  <Link
                    className="ag-focus-ring rounded-sm text-[var(--ag-text-primary)] underline-offset-4 hover:text-[var(--ag-color-brand)] hover:underline"
                    href={repositoryRoute(repo.owner, repo.name)}
                  >
                    {repo.owner}/{repo.name}
                  </Link>
                </TableCell>
                <TableCell>{repo.defaultBranch}</TableCell>
                <TableCell className="capitalize">{repo.lastRunStatus}</TableCell>
                <TableCell className="capitalize">{repo.agentStatus}</TableCell>
                <TableCell className="text-[var(--ag-text-secondary)]">{formatRelativeTimestamp(repo.lastUpdatedAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </TableRoot>
      </Card>
    </ScaffoldPage>
  );
}
