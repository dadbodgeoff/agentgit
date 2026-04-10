"use client";

import Link from "next/link";

import { Button, Card } from "@/components/primitives";
import { DataTable } from "@/components/composites";
import { PageStatePanel } from "@/components/feedback";
import { ScaffoldPage } from "@/features/shared/scaffold-page";
import { RepositoryConnectionDialog } from "@/features/repos/repository-connection-dialog";
import { WorkspaceSetupChecklist } from "@/features/shared/workspace-setup-checklist";
import { getApiErrorMessage } from "@/lib/api/client";
import { repositoryRoute } from "@/lib/navigation/routes";
import { useRepositoriesQuery } from "@/lib/query/hooks";
import type { PreviewState } from "@/schemas/cloud";
import { formatRelativeTimestamp } from "@/lib/utils/format";

export function RepositoryListPage({ previewState = "ready" }: { previewState?: PreviewState }) {
  const repositoriesQuery = useRepositoriesQuery(previewState);

  if (repositoriesQuery.isPending) {
    return (
      <ScaffoldPage
        actions={<RepositoryConnectionDialog />}
        description="Searchable repository inventory with status, last run, and agent posture."
        sections={[]}
        title="Repositories"
      >
        <PageStatePanel state="loading" />
      </ScaffoldPage>
    );
  }

  if (repositoriesQuery.isError || !repositoriesQuery.data) {
    const errorMessage = getApiErrorMessage(repositoriesQuery.error, "Could not load repositories. Retry.");

    return (
      <ScaffoldPage
        actions={<RepositoryConnectionDialog />}
        description="Searchable repository inventory with status, last run, and agent posture."
        sections={[]}
        title="Repositories"
      >
        <PageStatePanel errorMessage={errorMessage} state="error" />
      </ScaffoldPage>
    );
  }

  const repositories = repositoriesQuery.data;

  if (repositories.items.length === 0) {
    return (
      <ScaffoldPage
        actions={<RepositoryConnectionDialog />}
        description="Searchable repository inventory with status, last run, and agent posture."
        sections={[]}
        sidePanel={<WorkspaceSetupChecklist compact />}
        title="Repositories"
      >
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
      actions={<RepositoryConnectionDialog />}
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
        {
          title: "Repository table",
          description: "Inventory for connected repositories and their latest state.",
          kind: "table",
        },
        { title: "Empty state", description: "Illustrated empty state with connect CTA.", kind: "empty" },
      ]}
      title="Repositories"
    >
      <Card className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="ag-text-h3 text-[var(--ag-text-primary)]">Connected repositories</h2>
          <div className="ag-text-body-sm text-[var(--ag-text-secondary)]">
            Showing {repositories.items.length} of {repositories.total}
          </div>
        </div>
        <DataTable
          columns={[
            {
              key: "repository",
              header: "Repository",
              cell: (repo) => (
                <Link
                  className="ag-focus-ring rounded-sm font-medium text-[var(--ag-text-primary)] underline-offset-4 hover:text-[var(--ag-color-brand)] hover:underline"
                  href={repositoryRoute(repo.owner, repo.name)}
                >
                  {repo.owner}/{repo.name}
                </Link>
              ),
              sortValue: (repo) => `${repo.owner}/${repo.name}`.toLowerCase(),
            },
            {
              key: "default-branch",
              header: "Default branch",
              cell: (repo) => <span className="ag-text-data text-[var(--ag-text-primary)]">{repo.defaultBranch}</span>,
              sortValue: (repo) => repo.defaultBranch.toLowerCase(),
            },
            {
              key: "provider",
              header: "Provider",
              cell: (repo) => (
                <span className="capitalize text-[var(--ag-text-primary)]">
                  {repo.provider} / {repo.providerIdentityStatus}
                </span>
              ),
              sortValue: (repo) => `${repo.provider}-${repo.providerIdentityStatus}`.toLowerCase(),
            },
            {
              key: "last-run",
              header: "Last run",
              cell: (repo) => <span className="capitalize text-[var(--ag-text-primary)]">{repo.lastRunStatus}</span>,
              sortValue: (repo) => repo.lastRunStatus,
            },
            {
              key: "agent",
              header: "Agent",
              cell: (repo) => <span className="capitalize text-[var(--ag-text-primary)]">{repo.agentStatus}</span>,
              sortValue: (repo) => repo.agentStatus,
            },
            {
              key: "updated",
              header: "Updated",
              cell: (repo) => (
                <span className="text-[var(--ag-text-secondary)]">{formatRelativeTimestamp(repo.lastUpdatedAt)}</span>
              ),
              sortValue: (repo) => new Date(repo.lastUpdatedAt).getTime(),
            },
          ]}
          data={repositories.items}
          getRowId={(repo) => repo.id}
        />
        {repositoriesQuery.hasNextPage ? (
          <div className="flex items-center justify-between gap-3 border-t border-[var(--ag-border-subtle)] pt-4">
            <p className="text-sm text-[var(--ag-text-secondary)]">
              Load the next repository page from the workspace inventory.
            </p>
            <Button
              loading={repositoriesQuery.isFetchingNextPage}
              onClick={() => void repositoriesQuery.fetchNextPage()}
              variant="secondary"
            >
              Load more
            </Button>
          </div>
        ) : null}
      </Card>
    </ScaffoldPage>
  );
}
