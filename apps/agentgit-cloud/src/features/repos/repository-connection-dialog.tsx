"use client";

import { useEffect, useMemo, useState } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { EmptyState, LoadingSkeleton, PageStatePanel } from "@/components/feedback";
import { Badge, Button, Card } from "@/components/primitives";
import { ApiClientError, getApiErrorMessage } from "@/lib/api/client";
import { issueConnectorBootstrapToken } from "@/lib/api/endpoints/connectors";
import { updateWorkspaceRepositories } from "@/lib/api/endpoints/repositories";
import { useWorkspace } from "@/lib/auth/workspace-context";
import { useRepositoryConnectionBootstrapQuery } from "@/lib/query/hooks";
import { queryKeys } from "@/lib/query/keys";
import type { ConnectorBootstrapResponse } from "@/schemas/cloud";

function checkboxClassName() {
  return "h-4 w-4 rounded border border-[var(--ag-border-default)] bg-[var(--ag-bg-card)] text-[var(--ag-color-brand)]";
}

type RepositoryConnectionDialogProps = {
  buttonClassName?: string;
  buttonLabel?: string;
};

export function RepositoryConnectionDialog({
  buttonClassName,
  buttonLabel = "Connect repository",
}: RepositoryConnectionDialogProps) {
  const queryClient = useQueryClient();
  const { activeWorkspace } = useWorkspace();
  const isAdmin = activeWorkspace.role === "admin" || activeWorkspace.role === "owner";
  const [isOpen, setIsOpen] = useState(false);
  const [selectedRepositoryIds, setSelectedRepositoryIds] = useState<string[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [bootstrapDetails, setBootstrapDetails] = useState<ConnectorBootstrapResponse | null>(null);
  const connectionQuery = useRepositoryConnectionBootstrapQuery(isOpen && isAdmin);

  useEffect(() => {
    if (!connectionQuery.data || !isOpen) {
      return;
    }

    setSelectedRepositoryIds(connectionQuery.data.connectedRepositoryIds);
  }, [connectionQuery.data, isOpen]);

  const saveMutation = useMutation({
    mutationFn: (repositoryIds: string[]) => updateWorkspaceRepositories({ repositoryIds }),
    onSuccess: async (result) => {
      setSubmitError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.repositories }),
        queryClient.invalidateQueries({ queryKey: queryKeys.repositoryConnection }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard }),
        queryClient.invalidateQueries({ queryKey: queryKeys.onboarding }),
      ]);

      if (!result.connectorBootstrapSuggested) {
        setBootstrapDetails(null);
      }
    },
    onError: (error) => {
      if (error instanceof ApiClientError) {
        setSubmitError(getApiErrorMessage(error, "Could not update repository connections. Retry."));
        return;
      }

      setSubmitError("Could not update repository connections. Retry.");
    },
  });

  const bootstrapMutation = useMutation({
    mutationFn: () => issueConnectorBootstrapToken(),
    onSuccess: (result) => {
      setBootstrapDetails(result);
    },
    onError: (error) => {
      setSubmitError(getApiErrorMessage(error, "Could not issue a connector bootstrap token."));
    },
  });

  const activeCoverageCount = useMemo(() => {
    if (!connectionQuery.data) {
      return 0;
    }

    return selectedRepositoryIds.filter((repositoryId) =>
      connectionQuery.data.activeConnectorRepositoryIds.includes(repositoryId),
    ).length;
  }, [connectionQuery.data, selectedRepositoryIds]);

  function toggleRepository(repositoryId: string) {
    setSelectedRepositoryIds((current) =>
      current.includes(repositoryId) ? current.filter((value) => value !== repositoryId) : [...current, repositoryId],
    );
  }

  return (
    <>
      <Button className={buttonClassName} disabled={!isAdmin} onClick={() => setIsOpen(true)}>
        {buttonLabel}
      </Button>
      {isOpen ? (
        <div className="fixed inset-0 z-[var(--ag-z-modal)] flex items-center justify-center overflow-y-auto bg-black/60 p-6">
          <div
            aria-modal="true"
            className="max-h-[calc(100vh-3rem)] w-full max-w-[760px] overflow-y-auto rounded-[var(--ag-radius-xl)] border border-[var(--ag-border-default)] bg-[var(--ag-bg-card)] p-6 shadow-[var(--ag-shadow-xl)]"
            role="dialog"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-2">
                <h2 className="text-xl font-semibold text-[var(--ag-text-primary)]">Connect repositories</h2>
                <p className="text-sm text-[var(--ag-text-secondary)]">
                  Choose which governed repositories should be visible in this workspace and bootstrap a local connector if no active machine covers them yet.
                </p>
              </div>
              <Button onClick={() => setIsOpen(false)} variant="ghost">
                Close
              </Button>
            </div>

            {!isAdmin ? (
              <div className="mt-6">
                <PageStatePanel
                  errorMessage="You need admin or owner access to change repository connections."
                  state="error"
                />
              </div>
            ) : connectionQuery.isPending ? (
              <div className="mt-6 space-y-4">
                <LoadingSkeleton className="w-full" lines={2} />
                <LoadingSkeleton className="w-full" lines={8} />
              </div>
            ) : connectionQuery.isError ? (
              <div className="mt-6">
                <PageStatePanel
                  errorMessage={getApiErrorMessage(connectionQuery.error, "Could not load repository connection setup. Retry.")}
                  state="error"
                />
              </div>
            ) : connectionQuery.data ? (
              <div className="mt-6 space-y-6">
                <div className="grid gap-4 md:grid-cols-4">
                  <Card className="space-y-1">
                    <div className="text-xs uppercase tracking-[0.18em] text-[var(--ag-text-tertiary)]">Available</div>
                    <div className="text-2xl font-semibold text-[var(--ag-text-primary)]">
                      {connectionQuery.data.availableRepositories.length}
                    </div>
                    <div className="text-sm text-[var(--ag-text-secondary)]">Repositories discovered from configured workspace roots</div>
                  </Card>
                  <Card className="space-y-1">
                    <div className="text-xs uppercase tracking-[0.18em] text-[var(--ag-text-tertiary)]">Connected</div>
                    <div className="text-2xl font-semibold text-[var(--ag-text-primary)]">{selectedRepositoryIds.length}</div>
                    <div className="text-sm text-[var(--ag-text-secondary)]">Repositories that will appear in this workspace</div>
                  </Card>
                  <Card className="space-y-1">
                    <div className="text-xs uppercase tracking-[0.18em] text-[var(--ag-text-tertiary)]">Live coverage</div>
                    <div className="text-2xl font-semibold text-[var(--ag-text-primary)]">{activeCoverageCount}</div>
                    <div className="text-sm text-[var(--ag-text-secondary)]">Selected repositories with an active registered connector</div>
                  </Card>
                  <Card className="space-y-1">
                    <div className="text-xs uppercase tracking-[0.18em] text-[var(--ag-text-tertiary)]">Connector fleet</div>
                    <div className="text-2xl font-semibold text-[var(--ag-text-primary)]">{connectionQuery.data.totalConnectorCount}</div>
                    <div className="text-sm text-[var(--ag-text-secondary)]">
                      {connectionQuery.data.activeConnectorCount} active, {connectionQuery.data.staleConnectorCount} stale, {connectionQuery.data.revokedConnectorCount} revoked
                    </div>
                  </Card>
                </div>

                {connectionQuery.data.availableRepositories.length === 0 ? (
                  <EmptyState
                    description="No Git repositories were discovered in the configured workspace roots yet."
                    title="No repositories discovered"
                  >
                    <Button onClick={() => setIsOpen(false)} variant="secondary">
                      Close
                    </Button>
                  </EmptyState>
                ) : (
                  <Card className="space-y-4">
                    <div className="space-y-1">
                      <h3 className="text-lg font-semibold text-[var(--ag-text-primary)]">Workspace repository scope</h3>
                      <p className="text-sm text-[var(--ag-text-secondary)]">
                        Repository selection controls which repos appear across dashboard, approvals, runs, snapshots, and audit for this workspace.
                      </p>
                    </div>
                    <div className="space-y-3">
                      {connectionQuery.data.availableRepositories.map((repository) => {
                        const isSelected = selectedRepositoryIds.includes(repository.id);
                        const hasActiveCoverage = connectionQuery.data.activeConnectorRepositoryIds.includes(repository.id);

                        return (
                          <label
                            className="flex items-start gap-3 rounded-[var(--ag-radius-lg)] border border-[var(--ag-border-default)] p-4 hover:border-[var(--ag-border-strong)]"
                            key={repository.id}
                          >
                            <input
                              checked={isSelected}
                              className={checkboxClassName()}
                              onChange={() => toggleRepository(repository.id)}
                              type="checkbox"
                            />
                            <div className="min-w-0 flex-1 space-y-2">
                              <div className="flex flex-wrap items-center gap-2">
                                <div className="font-semibold text-[var(--ag-text-primary)]">
                                  {repository.owner}/{repository.name}
                                </div>
                                <Badge tone={hasActiveCoverage ? "success" : "warning"}>
                                  {hasActiveCoverage ? "Connector active" : "Needs connector"}
                                </Badge>
                                <Badge tone="neutral">Default branch: {repository.defaultBranch}</Badge>
                              </div>
                              <div className="text-sm text-[var(--ag-text-secondary)]">{repository.description}</div>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </Card>
                )}

                {submitError ? (
                  <div className="rounded-[var(--ag-radius-lg)] border border-[var(--ag-color-error)]/40 bg-[color-mix(in_srgb,var(--ag-color-error)_10%,transparent)] p-4 text-sm text-[var(--ag-text-primary)]">
                    {submitError}
                  </div>
                ) : null}

                {saveMutation.data?.connectorBootstrapSuggested ? (
                  <Card className="space-y-4 border-[var(--ag-color-warning)]/40">
                    <div className="space-y-1">
                      <h3 className="text-lg font-semibold text-[var(--ag-text-primary)]">Bootstrap a local connector</h3>
                      <p className="text-sm text-[var(--ag-text-secondary)]">
                        Repository scope is saved, but at least one selected repo still needs an active local connector to sync live state, commands, and governed writeback.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-3">
                      <Button onClick={() => bootstrapMutation.mutate()} variant="secondary">
                        {bootstrapMutation.isPending ? "Generating..." : "Generate bootstrap token"}
                      </Button>
                      <div className="text-sm text-[var(--ag-text-secondary)]">
                        Use this when the selected repos live on a machine that has not registered with this workspace yet.
                      </div>
                    </div>
                    {bootstrapDetails ? (
                      <div className="space-y-2 rounded-[var(--ag-radius-lg)] border border-[var(--ag-border-default)] bg-[var(--ag-bg-page)] p-4">
                        <div className="text-xs uppercase tracking-[0.18em] text-[var(--ag-text-tertiary)]">Bootstrap command</div>
                        <code className="block overflow-x-auto text-sm text-[var(--ag-text-primary)]">
                          {bootstrapDetails.commandHint}
                        </code>
                      </div>
                    ) : null}
                  </Card>
                ) : null}

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm text-[var(--ag-text-secondary)]">
                    {selectedRepositoryIds.length === 0
                      ? "No repositories will be visible in this workspace until you select at least one."
                      : `${selectedRepositoryIds.length} repositories selected for this workspace.`}
                  </div>
                  <div className="flex gap-3">
                    <Button onClick={() => setIsOpen(false)} variant="ghost">
                      Cancel
                    </Button>
                    <Button
                      disabled={saveMutation.isPending || connectionQuery.data.availableRepositories.length === 0}
                      onClick={() => saveMutation.mutate(selectedRepositoryIds)}
                    >
                      {saveMutation.isPending ? "Saving..." : "Save repository scope"}
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
