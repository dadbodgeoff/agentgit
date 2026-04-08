"use client";

import Link from "next/link";
import { useState } from "react";

import { PageHeader } from "@/components/composites";
import { PageStatePanel } from "@/components/feedback";
import { Badge, Card, Input, TabList, TabTrigger, TableBody, TableCell, TableHead, TableHeaderCell, TableRoot, TableRow } from "@/components/primitives";
import { MetricCard } from "@/components/composites";
import { getApiErrorMessage } from "@/lib/api/client";
import { actionDetailRoute, repositoryRoute, runDetailRoute } from "@/lib/navigation/routes";
import { useAuditQuery } from "@/lib/query/hooks";
import { formatRelativeTimestamp } from "@/lib/utils/format";

type AuditFilter = "all" | "approval" | "connector" | "run" | "recovery" | "policy" | "fleet";

function auditFilterForCategory(category: string): Exclude<AuditFilter, "all"> {
  switch (category) {
    case "approval":
    case "connector":
    case "run":
    case "recovery":
    case "policy":
    case "fleet":
      return category;
    default:
      return "run";
  }
}

function auditOutcomeTone(outcome: string): "success" | "warning" | "error" | "neutral" {
  if (outcome === "success") {
    return "success";
  }

  if (outcome === "warning") {
    return "warning";
  }

  if (outcome === "failure") {
    return "error";
  }

  return "neutral";
}

function splitRepoLabel(repo: string | null): { owner: string; name: string } | null {
  if (!repo) {
    return null;
  }

  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    return null;
  }

  return { owner, name };
}

export function AuditPage() {
  const auditQuery = useAuditQuery();
  const [selectedFilter, setSelectedFilter] = useState<AuditFilter>("all");
  const [search, setSearch] = useState("");

  if (auditQuery.isPending) {
    return (
      <>
        <PageHeader
          description="Immutable-ish operator-facing trail across approvals, recoveries, connector commands, and policy sync."
          title="Audit log"
        />
        <PageStatePanel state="loading" />
      </>
    );
  }

  if (auditQuery.isError) {
    return (
      <>
        <PageHeader
          description="Immutable-ish operator-facing trail across approvals, recoveries, connector commands, and policy sync."
          title="Audit log"
        />
        <PageStatePanel errorMessage={getApiErrorMessage(auditQuery.error, "Could not load audit log. Retry.")} state="error" />
      </>
    );
  }

  const audit = auditQuery.data;
  const normalizedSearch = search.trim().toLowerCase();
  const filteredItems =
    (selectedFilter === "all" ? audit.items : audit.items.filter((entry) => auditFilterForCategory(entry.category) === selectedFilter)).filter(
      (entry) =>
        normalizedSearch.length === 0 ||
        entry.action.toLowerCase().includes(normalizedSearch) ||
        entry.target.toLowerCase().includes(normalizedSearch) ||
        entry.details.toLowerCase().includes(normalizedSearch) ||
        entry.actorLabel.toLowerCase().includes(normalizedSearch) ||
        (entry.repo?.toLowerCase().includes(normalizedSearch) ?? false) ||
        (entry.runId?.toLowerCase().includes(normalizedSearch) ?? false),
    );

  const counts = audit.items.reduce(
    (acc, entry) => {
      acc[entry.category] += 1;
      acc[entry.outcome] += 1;
      return acc;
    },
    {
      approval: 0,
      connector: 0,
      run: 0,
      recovery: 0,
      policy: 0,
      fleet: 0,
      success: 0,
      warning: 0,
      failure: 0,
      info: 0,
    } satisfies Record<Exclude<AuditFilter, "all"> | "success" | "warning" | "failure" | "info", number>,
  );

  if (audit.items.length === 0) {
    return (
      <>
        <PageHeader
          description="Immutable-ish operator-facing trail across approvals, recoveries, connector commands, and policy sync."
          title="Audit log"
        />
        <PageStatePanel
          emptyTitle="No audit entries yet"
          emptyDescription="Audit entries will appear as governed operations are recorded."
          state="empty"
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        description="Immutable-ish operator-facing trail across approvals, recoveries, connector commands, and policy sync."
        title="Audit log"
      />
      <div className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="Approvals" value={String(counts.approval)} trend="human review and policy gates" />
          <MetricCard label="Connector actions" value={String(counts.connector)} trend="sync, commits, pushes, PRs" />
          <MetricCard label="Warnings" value={String(counts.warning)} trend="manual follow-up and retries" />
          <MetricCard label="Failures" value={String(counts.failure)} trend="operator attention required" />
        </div>

        <Card className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">Audit filters</h2>
              <p className="text-sm text-[var(--ag-text-secondary)]">
                Focus the log by control-plane category while preserving the related repo, run, and action links.
              </p>
            </div>
            <Badge tone="accent">{filteredItems.length} visible</Badge>
          </div>
          <Input
            helpText="Search by repo, action, details, actor, or run id."
            id="audit-search"
            label="Search audit log"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search audit entries"
            value={search}
          />
          <TabList>
            {(["all", "approval", "connector", "run", "recovery", "policy", "fleet"] as AuditFilter[]).map((filter) => (
              <TabTrigger active={selectedFilter === filter} key={filter} onClick={() => setSelectedFilter(filter)}>
                {filter}
              </TabTrigger>
            ))}
          </TabList>
        </Card>

        {filteredItems.length === 0 ? (
          <PageStatePanel
            emptyDescription={
              selectedFilter === "all"
                ? "Audit entries will appear as governed operations are recorded."
                : `No ${selectedFilter} audit entries are currently visible.`
            }
            emptyTitle="No matching audit entries"
            state="empty"
          />
        ) : (
          <Card className="space-y-4">
            <TableRoot>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>When</TableHeaderCell>
                  <TableHeaderCell>Actor</TableHeaderCell>
                  <TableHeaderCell>Category</TableHeaderCell>
                  <TableHeaderCell>Action</TableHeaderCell>
                  <TableHeaderCell>Target</TableHeaderCell>
                  <TableHeaderCell>Outcome</TableHeaderCell>
                  <TableHeaderCell>Context</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {filteredItems.map((entry) => {
                  const repoParts = splitRepoLabel(entry.repo);
                  const repoHref = repoParts ? repositoryRoute(repoParts.owner, repoParts.name) : null;
                  const runHref = repoParts && entry.runId ? runDetailRoute(repoParts.owner, repoParts.name, entry.runId) : null;
                  const actionHref = repoParts && entry.runId && entry.actionId ? actionDetailRoute(repoParts.owner, repoParts.name, entry.runId, entry.actionId) : null;

                  return (
                    <TableRow key={entry.id}>
                      <TableCell className="text-[var(--ag-text-secondary)]">{formatRelativeTimestamp(entry.occurredAt)}</TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          <div className="font-medium">{entry.actorLabel}</div>
                          <div className="text-xs text-[var(--ag-text-secondary)]">{entry.actorType}</div>
                        </div>
                      </TableCell>
                      <TableCell className="capitalize">{entry.category}</TableCell>
                      <TableCell>{entry.action}</TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          <div>{entry.target}</div>
                          <div className="text-xs text-[var(--ag-text-secondary)]">{entry.details}</div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge tone={auditOutcomeTone(entry.outcome)}>{entry.outcome}</Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-2">
                          {repoHref ? (
                            <Link className="font-medium text-[var(--ag-color-brand)] underline-offset-4 hover:underline" href={repoHref}>
                              Repo
                            </Link>
                          ) : null}
                          {runHref ? (
                            <Link className="font-medium text-[var(--ag-color-brand)] underline-offset-4 hover:underline" href={runHref}>
                              Run
                            </Link>
                          ) : null}
                          {actionHref ? (
                            <Link className="font-medium text-[var(--ag-color-brand)] underline-offset-4 hover:underline" href={actionHref}>
                              Action
                            </Link>
                          ) : null}
                          {entry.detailPath ? (
                            <Link className="font-medium text-[var(--ag-color-brand)] underline-offset-4 hover:underline" href={entry.detailPath}>
                              Detail
                            </Link>
                          ) : null}
                          {entry.externalUrl ? (
                            <a
                              className="font-medium text-[var(--ag-color-brand)] underline-offset-4 hover:underline"
                              href={entry.externalUrl}
                              rel="noreferrer"
                              target="_blank"
                            >
                              Provider
                            </a>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </TableRoot>
          </Card>
        )}
      </div>
    </>
  );
}
