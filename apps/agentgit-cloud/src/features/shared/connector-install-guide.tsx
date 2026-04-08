"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { useMutation } from "@tanstack/react-query";

import { EmptyState, LoadingSkeleton, PageStatePanel } from "@/components/feedback";
import { Badge, Button, Card } from "@/components/primitives";
import { getApiErrorMessage } from "@/lib/api/client";
import { issueConnectorBootstrapToken } from "@/lib/api/endpoints/connectors";
import { authenticatedRoutes } from "@/lib/navigation/routes";
import { useRepositoryConnectionBootstrapQuery } from "@/lib/query/hooks";
import type { ConnectorBootstrapResponse } from "@/schemas/cloud";
import { ConnectorBootstrapPanel } from "@/features/shared/connector-bootstrap-panel";

type ConnectorInstallGuideProps = {
  title?: string;
  compact?: boolean;
};

type StepStatus = "complete" | "active" | "pending";

function stepTone(status: StepStatus): "success" | "accent" | "neutral" {
  if (status === "complete") {
    return "success";
  }

  if (status === "active") {
    return "accent";
  }

  return "neutral";
}

export function ConnectorInstallGuide({
  title = "Install local connector",
  compact = false,
}: ConnectorInstallGuideProps) {
  const readinessQuery = useRepositoryConnectionBootstrapQuery(true);
  const [bootstrapDetails, setBootstrapDetails] = useState<ConnectorBootstrapResponse | null>(null);
  const bootstrapMutation = useMutation({
    mutationFn: () => issueConnectorBootstrapToken(),
    onSuccess: (result) => {
      setBootstrapDetails(result);
    },
  });

  const summary = useMemo(() => {
    if (!readinessQuery.data) {
      return null;
    }

    const connectedRepositories = readinessQuery.data.availableRepositories.filter((repository) =>
      readinessQuery.data.connectedRepositoryIds.includes(repository.id),
    );
    const uncoveredRepositories = connectedRepositories.filter(
      (repository) => !readinessQuery.data.activeConnectorRepositoryIds.includes(repository.id),
    );

    return {
      connectedRepositories,
      uncoveredRepositories,
      activeConnectorCount: readinessQuery.data.activeConnectorCount,
      launched: readinessQuery.data.launchedAt !== null,
    };
  }, [readinessQuery.data]);

  useEffect(() => {
    if (!bootstrapDetails || !summary || summary.uncoveredRepositories.length === 0) {
      return;
    }

    const interval = window.setInterval(() => {
      void readinessQuery.refetch();
    }, 5_000);

    return () => window.clearInterval(interval);
  }, [bootstrapDetails, readinessQuery, summary]);

  if (readinessQuery.isPending) {
    return (
      <Card className="space-y-4">
        <LoadingSkeleton className="w-40" lines={1} />
        <LoadingSkeleton className="w-full" lines={compact ? 4 : 6} />
      </Card>
    );
  }

  if (readinessQuery.isError) {
    return (
      <Card className="space-y-4">
        <h2 className="text-lg font-semibold">{title}</h2>
        <PageStatePanel
          errorMessage={getApiErrorMessage(readinessQuery.error, "Could not load connector install guidance.")}
          state="error"
        />
      </Card>
    );
  }

  if (!summary) {
    return (
      <Card className="space-y-4">
        <h2 className="text-lg font-semibold">{title}</h2>
        <EmptyState description="Connector guidance is not available yet." title="No setup context" />
      </Card>
    );
  }

  const stepOneStatus: StepStatus =
    summary.connectedRepositories.length > 0 ? "complete" : "active";
  const stepTwoStatus: StepStatus =
    summary.connectedRepositories.length === 0
      ? "pending"
      : bootstrapDetails || summary.uncoveredRepositories.length > 0
        ? "active"
        : "complete";
  const stepThreeStatus: StepStatus =
    summary.uncoveredRepositories.length === 0 && summary.connectedRepositories.length > 0 ? "complete" : "pending";

  return (
    <Card className="space-y-4">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-[var(--ag-text-secondary)]">
          {summary.uncoveredRepositories.length === 0 && summary.connectedRepositories.length > 0
            ? "Connector coverage is live for the selected repositories."
            : "Follow this path to move from selected repositories to a live local connector and first governed work."}
        </p>
      </div>

      <div className="space-y-3">
        <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="text-sm font-semibold text-[var(--ag-text-primary)]">1. Select repository scope</div>
              <div className="text-sm text-[var(--ag-text-secondary)]">
                Choose which repositories belong in this workspace before registering a local machine.
              </div>
            </div>
            <Badge tone={stepTone(stepOneStatus)}>{stepOneStatus}</Badge>
          </div>
        </div>

        <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="text-sm font-semibold text-[var(--ag-text-primary)]">2. Bootstrap the connector on the right machine</div>
              <div className="text-sm text-[var(--ag-text-secondary)]">
                Generate a workspace-scoped bootstrap token, then run the local connector on the machine that holds the selected repos.
              </div>
            </div>
            <Badge tone={stepTone(stepTwoStatus)}>{stepTwoStatus}</Badge>
          </div>
        </div>

        <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="text-sm font-semibold text-[var(--ag-text-primary)]">3. Verify first governed run readiness</div>
              <div className="text-sm text-[var(--ag-text-secondary)]">
                Once the connector is active, the workspace is ready to sync repo state, approvals, snapshots, and writeback commands.
              </div>
            </div>
            <Badge tone={stepTone(stepThreeStatus)}>{stepThreeStatus}</Badge>
          </div>
        </div>
      </div>

      {summary.uncoveredRepositories.length > 0 ? (
        <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-page)] px-4 py-3">
          <div className="text-xs uppercase tracking-[0.18em] text-[var(--ag-text-tertiary)]">Install target</div>
          <div className="mt-2 text-sm text-[var(--ag-text-secondary)]">
            Run the bootstrap command on the exact machine that has the repository checkout and local AgentGit daemon state for:
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {summary.uncoveredRepositories.map((repository) => (
              <Badge key={repository.id} tone="warning">
                {repository.owner}/{repository.name}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}

      {summary.connectedRepositories.length > 0 ? (
        <div className="space-y-2">
          <div className="text-xs uppercase tracking-[0.18em] text-[var(--ag-text-tertiary)]">Selected repositories</div>
          <div className="flex flex-wrap gap-2">
            {summary.connectedRepositories.map((repository) => (
              <Badge
                key={repository.id}
                tone={summary.uncoveredRepositories.some((entry) => entry.id === repository.id) ? "warning" : "success"}
              >
                {repository.owner}/{repository.name}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}

      {summary.uncoveredRepositories.length > 0 ? (
        <div className="flex flex-wrap gap-3">
          <Button onClick={() => bootstrapMutation.mutate()} variant="secondary">
            {bootstrapMutation.isPending ? "Generating..." : "Generate bootstrap token"}
          </Button>
          <Link
            className="ag-focus-ring inline-flex h-9 items-center justify-center rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] bg-[var(--ag-bg-card)] px-4 text-sm font-medium text-[var(--ag-text-primary)] transition-colors hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-hover)]"
            href={authenticatedRoutes.connectors}
          >
            Open connector fleet
          </Link>
        </div>
      ) : summary.connectedRepositories.length > 0 ? (
        <div className="flex flex-wrap gap-3">
          <Link
            className="ag-focus-ring inline-flex h-9 items-center justify-center rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] bg-[var(--ag-bg-card)] px-4 text-sm font-medium text-[var(--ag-text-primary)] transition-colors hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-hover)]"
            href={authenticatedRoutes.repositories}
          >
            Open repositories
          </Link>
          <Link
            className="ag-focus-ring inline-flex h-9 items-center justify-center rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] bg-[var(--ag-bg-card)] px-4 text-sm font-medium text-[var(--ag-text-primary)] transition-colors hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-hover)]"
            href={authenticatedRoutes.approvals}
          >
            Open approvals
          </Link>
        </div>
      ) : null}

      {bootstrapDetails ? (
        <ConnectorBootstrapPanel
          bootstrapDetails={bootstrapDetails}
          connected={summary.uncoveredRepositories.length === 0 && summary.connectedRepositories.length > 0}
          waitingForConnection={summary.uncoveredRepositories.length > 0}
        />
      ) : null}
    </Card>
  );
}
