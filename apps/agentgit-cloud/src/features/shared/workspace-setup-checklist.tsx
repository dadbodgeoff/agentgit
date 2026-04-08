"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { useMutation } from "@tanstack/react-query";

import { EmptyState, LoadingSkeleton, PageStatePanel } from "@/components/feedback";
import { Badge, Button, Card, ToastCard, ToastViewport } from "@/components/primitives";
import { getApiErrorMessage } from "@/lib/api/client";
import { issueConnectorBootstrapToken } from "@/lib/api/endpoints/connectors";
import { useWorkspace } from "@/lib/auth/workspace-context";
import { authenticatedRoutes } from "@/lib/navigation/routes";
import { useRepositoryConnectionBootstrapQuery } from "@/lib/query/hooks";
import type { ConnectorBootstrapResponse } from "@/schemas/cloud";
import { RepositoryConnectionDialog } from "@/features/repos/repository-connection-dialog";
import { ConnectorBootstrapPanel } from "@/features/shared/connector-bootstrap-panel";
import { ConnectorInstallGuide } from "@/features/shared/connector-install-guide";

type WorkspaceSetupChecklistProps = {
  title?: string;
  compact?: boolean;
};

function itemTone(status: "complete" | "attention" | "pending"): "success" | "warning" | "neutral" {
  if (status === "complete") {
    return "success";
  }

  if (status === "attention") {
    return "warning";
  }

  return "neutral";
}

export function WorkspaceSetupChecklist({ title = "Setup readiness", compact = false }: WorkspaceSetupChecklistProps) {
  const { activeWorkspace } = useWorkspace();
  const isAdmin = activeWorkspace.role === "admin" || activeWorkspace.role === "owner";
  const readinessQuery = useRepositoryConnectionBootstrapQuery(isAdmin);
  const [bootstrapDetails, setBootstrapDetails] = useState<ConnectorBootstrapResponse | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const bootstrapMutation = useMutation({
    mutationFn: () => issueConnectorBootstrapToken(),
    onSuccess: (result) => {
      setBootstrapDetails(result);
    },
    onError: (error) => {
      setToastMessage(getApiErrorMessage(error, "Could not issue a connector bootstrap token."));
    },
  });

  const setupSummary = useMemo(() => {
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
      connectedCount: connectedRepositories.length,
      uncoveredCount: uncoveredRepositories.length,
      connectedRepositories,
      uncoveredRepositories,
      launched: readinessQuery.data.launchedAt !== null,
    };
  }, [readinessQuery.data]);

  useEffect(() => {
    if (!bootstrapDetails || !setupSummary || setupSummary.uncoveredCount === 0) {
      return;
    }

    const interval = window.setInterval(() => {
      void readinessQuery.refetch();
    }, 5_000);

    return () => window.clearInterval(interval);
  }, [bootstrapDetails, readinessQuery, setupSummary]);

  useEffect(() => {
    if (!toastMessage) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setToastMessage(null);
    }, 4000);

    return () => window.clearTimeout(timeout);
  }, [toastMessage]);

  if (!isAdmin) {
    return null;
  }

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
          errorMessage={getApiErrorMessage(readinessQuery.error, "Could not load workspace setup readiness.")}
          state="error"
        />
      </Card>
    );
  }

  if (!setupSummary) {
    return (
      <Card className="space-y-4">
        <h2 className="text-lg font-semibold">{title}</h2>
        <EmptyState description="Workspace setup context is not available." title="No setup data" />
      </Card>
    );
  }

  const readinessItems = [
    {
      label: "Repository scope selected",
      status: setupSummary.connectedCount > 0 ? "complete" : "attention",
      detail:
        setupSummary.connectedCount > 0
          ? `${setupSummary.connectedCount} repositories connected to this workspace.`
          : "Select at least one repository so the workspace has something to govern.",
    },
    {
      label: "Connector coverage ready",
      status:
        setupSummary.connectedCount === 0 ? "pending" : setupSummary.uncoveredCount === 0 ? "complete" : "attention",
      detail:
        setupSummary.connectedCount === 0
          ? "Choose repositories first, then register a local connector for live sync and writeback."
          : setupSummary.uncoveredCount === 0
            ? "Every selected repository is covered by an active connector."
            : `${setupSummary.uncoveredCount} selected ${setupSummary.uncoveredCount === 1 ? "repository still needs" : "repositories still need"} an active connector.`,
    },
    {
      label: "Workspace launched",
      status: setupSummary.launched ? "complete" : "pending",
      detail: setupSummary.launched
        ? "Workspace launch state is persisted and the main control plane is active."
        : "Finish onboarding to persist the workspace and move into the hosted dashboard flow.",
    },
  ] as const;

  return (
    <Card className={compact ? "space-y-4" : "space-y-5"}>
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-[var(--ag-text-secondary)]">
          {compact
            ? "Track repo scope, connector coverage, and launch state from one place."
            : "Keep repository scope, connector coverage, and launch state aligned so the cloud control plane reflects real governed work."}
        </p>
      </div>

      <div className="space-y-3">
        {readinessItems.map((item) => (
          <div
            className="flex items-start justify-between gap-3 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3"
            key={item.label}
          >
            <div className="space-y-1">
              <div className="text-sm font-semibold text-[var(--ag-text-primary)]">{item.label}</div>
              <div className="text-sm text-[var(--ag-text-secondary)]">{item.detail}</div>
            </div>
            <Badge tone={itemTone(item.status)}>{item.status}</Badge>
          </div>
        ))}
      </div>

      {setupSummary.uncoveredRepositories.length > 0 ? (
        <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-color-warning)]/30 bg-[var(--ag-bg-elevated)] px-4 py-3">
          <div className="text-sm font-semibold text-[var(--ag-text-primary)]">
            Repositories awaiting connector coverage
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {setupSummary.uncoveredRepositories.map((repository) => (
              <Badge key={repository.id} tone="warning">
                {repository.owner}/{repository.name}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <RepositoryConnectionDialog buttonLabel="Manage repository scope" />
        {setupSummary.connectedCount > 0 && setupSummary.uncoveredCount > 0 ? (
          <Button onClick={() => bootstrapMutation.mutate()} variant="secondary">
            {bootstrapMutation.isPending ? "Generating..." : "Generate bootstrap token"}
          </Button>
        ) : null}
        {!setupSummary.launched ? (
          <Link
            className="ag-focus-ring inline-flex h-9 items-center justify-center rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] bg-[var(--ag-bg-card)] px-4 text-sm font-medium text-[var(--ag-text-primary)] transition-colors hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-hover)]"
            href={authenticatedRoutes.onboarding}
          >
            Open onboarding
          </Link>
        ) : (
          <Link
            className="ag-focus-ring inline-flex h-9 items-center justify-center rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] bg-[var(--ag-bg-card)] px-4 text-sm font-medium text-[var(--ag-text-primary)] transition-colors hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-hover)]"
            href={authenticatedRoutes.connectors}
          >
            Open connector fleet
          </Link>
        )}
      </div>

      {bootstrapDetails ? (
        <ConnectorBootstrapPanel
          bootstrapDetails={bootstrapDetails}
          connected={setupSummary.connectedCount > 0 && setupSummary.uncoveredCount === 0}
          waitingForConnection={setupSummary.uncoveredCount > 0}
        />
      ) : null}

      {!compact ? <ConnectorInstallGuide compact /> : null}
      {toastMessage ? (
        <ToastViewport>
          <ToastCard className="border-[color:rgb(239_68_68_/_0.28)]">
            <div className="space-y-1">
              <div className="text-sm font-semibold text-[var(--ag-text-primary)]">Bootstrap failed</div>
              <p className="text-sm text-[var(--ag-text-secondary)]">{toastMessage}</p>
            </div>
          </ToastCard>
        </ToastViewport>
      ) : null}
    </Card>
  );
}
