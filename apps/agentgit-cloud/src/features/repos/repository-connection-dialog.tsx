"use client";

import { useEffect, useMemo, useState } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { EmptyState, LoadingSkeleton, PageStatePanel, StaleIndicator } from "@/components/feedback";
import { Badge, Button, Card, Input, ToastCard, ToastViewport } from "@/components/primitives";
import { getApiErrorMessage } from "@/lib/api/client";
import { issueConnectorBootstrapToken } from "@/lib/api/endpoints/connectors";
import { updateWorkspaceRepositories } from "@/lib/api/endpoints/repositories";
import { useWorkspace } from "@/lib/auth/workspace-context";
import { authenticatedRoutes } from "@/lib/navigation/routes";
import { useRepositoryConnectionBootstrapQuery } from "@/lib/query/hooks";
import { queryKeys } from "@/lib/query/keys";
import type {
  ConnectorBootstrapResponse,
  NotificationChannel,
  OnboardingRepositoryOption,
  PolicyPack,
} from "@/schemas/cloud";
import { ConnectorBootstrapPanel } from "@/features/shared/connector-bootstrap-panel";

type RepositoryConnectionDialogProps = {
  buttonClassName?: string;
  buttonLabel?: string;
};

type RepositoryConnectionStep = "select" | "configure" | "review" | "launch";

type RepositoryConnectionToast = {
  title: string;
  message: string;
  tone: "success" | "warning" | "error";
};

const stepOrder: RepositoryConnectionStep[] = ["select", "configure", "review", "launch"];

const notificationOptions: Array<{ value: NotificationChannel; label: string; description: string }> = [
  {
    value: "slack",
    label: "Slack",
    description: "Recommended when the workspace already routes approvals and failures into Slack.",
  },
  {
    value: "email",
    label: "Email",
    description: "Send repository connection and approval follow-up through workspace email notifications.",
  },
  {
    value: "in_app",
    label: "In-app",
    description: "Keep the first loop contained to the hosted operator UI and notification center.",
  },
];

const policyPackDescriptions: Record<PolicyPack, string> = {
  balanced: "Move quickly on low-risk repository changes while still surfacing meaningful approval gates.",
  guarded: "Recommended. Require more review around shell, deploy, connector, and policy changes.",
  strict: "Maximize review and recovery coverage for sensitive repositories and launch-day caution.",
};

function stepTitle(step: RepositoryConnectionStep, needsBootstrap: boolean) {
  switch (step) {
    case "select":
      return "Select";
    case "configure":
      return "Configure";
    case "review":
      return "Review";
    case "launch":
      return needsBootstrap ? "Start governance" : "Connected";
  }
}

function selectClassName() {
  return "ag-focus-ring h-9 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] bg-[var(--ag-bg-card)] px-3 text-[14px] text-[var(--ag-text-primary)] hover:border-[var(--ag-border-strong)] focus:border-[var(--ag-color-brand)]";
}

function toneForPolicyPack(policyPack: PolicyPack): "success" | "warning" | "accent" {
  if (policyPack === "balanced") {
    return "accent";
  }

  if (policyPack === "strict") {
    return "warning";
  }

  return "success";
}

function formatNotificationLabel(channel: NotificationChannel) {
  return channel.replace("_", " ");
}

function RepositoryConnectionStepper({
  activeStep,
  needsBootstrap,
}: {
  activeStep: RepositoryConnectionStep;
  needsBootstrap: boolean;
}) {
  const activeIndex = stepOrder.indexOf(activeStep);

  return (
    <div className="grid gap-3 md:grid-cols-4">
      {stepOrder.map((step, index) => {
        const complete = index < activeIndex;
        const current = index === activeIndex;

        return (
          <div className="space-y-2" key={step}>
            <div className="flex items-center gap-3">
              <div
                className={
                  complete
                    ? "flex h-9 w-9 items-center justify-center rounded-full border border-[var(--ag-color-brand)] text-sm font-semibold text-[var(--ag-color-brand)]"
                    : current
                      ? "flex h-9 w-9 items-center justify-center rounded-full bg-[var(--ag-color-brand)] text-sm font-semibold text-[#0b0f14]"
                      : "flex h-9 w-9 items-center justify-center rounded-full border border-[var(--ag-border-default)] text-sm font-semibold text-[var(--ag-text-secondary)]"
                }
              >
                {complete ? "✓" : index + 1}
              </div>
              {index < stepOrder.length - 1 ? (
                <div
                  className={
                    complete ? "h-px flex-1 bg-[var(--ag-color-brand)]" : "h-px flex-1 bg-[var(--ag-border-default)]"
                  }
                />
              ) : null}
            </div>
            <div className="space-y-1">
              <div className="text-sm font-semibold text-[var(--ag-text-primary)]">
                {stepTitle(step, needsBootstrap)}
              </div>
              <div className="text-xs text-[var(--ag-text-secondary)]">
                {step === "select"
                  ? "Pick the repositories this workspace should govern."
                  : step === "configure"
                    ? "Choose launch defaults for the newly connected scope."
                    : step === "review"
                      ? "Confirm repo scope, policy, notifications, and connector coverage."
                      : needsBootstrap
                        ? "Generate the bootstrap command and wait for the first connector heartbeat."
                        : "Governance is ready for the connected repositories."}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RepositorySelectionCard({
  repository,
  selected,
  covered,
  onToggle,
}: {
  repository: OnboardingRepositoryOption;
  selected: boolean;
  covered: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      className={
        selected
          ? "ag-focus-ring flex w-full flex-col gap-3 rounded-[var(--ag-radius-lg)] border border-[var(--ag-color-brand)] bg-[var(--ag-bg-elevated)] p-4 text-left"
          : "ag-focus-ring flex w-full flex-col gap-3 rounded-[var(--ag-radius-lg)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-card)] p-4 text-left transition-colors hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-elevated)]"
      }
      onClick={onToggle}
      type="button"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="text-base font-semibold text-[var(--ag-text-primary)]">
            {repository.owner}/{repository.name}
          </div>
          <div className="text-sm text-[var(--ag-text-secondary)]">{repository.description}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge tone={selected ? "success" : "neutral"}>{selected ? "Selected" : "Available"}</Badge>
          <Badge tone={covered ? "success" : "warning"}>{covered ? "Connector active" : "Needs connector"}</Badge>
          <Badge tone="neutral">Default branch: {repository.defaultBranch}</Badge>
          {repository.requiresOrgApproval ? <Badge tone="warning">Org approval required</Badge> : null}
        </div>
      </div>
    </button>
  );
}

export function RepositoryConnectionDialog({
  buttonClassName,
  buttonLabel = "Connect repository",
}: RepositoryConnectionDialogProps) {
  const queryClient = useQueryClient();
  const { activeWorkspace } = useWorkspace();
  const isAdmin = activeWorkspace.role === "admin" || activeWorkspace.role === "owner";
  const [isOpen, setIsOpen] = useState(false);
  const [activeStep, setActiveStep] = useState<RepositoryConnectionStep>("select");
  const [search, setSearch] = useState("");
  const [selectedRepositoryIds, setSelectedRepositoryIds] = useState<string[]>([]);
  const [defaultNotificationChannel, setDefaultNotificationChannel] = useState<NotificationChannel>("slack");
  const [policyPack, setPolicyPack] = useState<PolicyPack>("guarded");
  const [bootstrapDetails, setBootstrapDetails] = useState<ConnectorBootstrapResponse | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [toast, setToast] = useState<RepositoryConnectionToast | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [saveSuggestedBootstrap, setSaveSuggestedBootstrap] = useState(false);
  const connectionQuery = useRepositoryConnectionBootstrapQuery(isOpen && isAdmin);

  useEffect(() => {
    if (!connectionQuery.data || !isOpen) {
      return;
    }

    setSelectedRepositoryIds(connectionQuery.data.connectedRepositoryIds);
    setDefaultNotificationChannel(connectionQuery.data.defaultNotificationChannel);
    setPolicyPack(connectionQuery.data.policyPack);
    setSelectionError(null);
    setSubmitError(null);
    setBootstrapDetails(null);
    setSavedMessage(null);
    setSaveSuggestedBootstrap(false);
    setActiveStep("select");
  }, [connectionQuery.data, isOpen]);

  useEffect(() => {
    if (!toast) {
      return;
    }

    const timeout = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const selectedRepositories = useMemo(
    () =>
      connectionQuery.data?.availableRepositories.filter((repository) =>
        selectedRepositoryIds.includes(repository.id),
      ) ?? [],
    [connectionQuery.data?.availableRepositories, selectedRepositoryIds],
  );
  const uncoveredSelectedRepositories = useMemo(
    () =>
      selectedRepositories.filter(
        (repository) => !connectionQuery.data?.activeConnectorRepositoryIds.includes(repository.id),
      ),
    [connectionQuery.data?.activeConnectorRepositoryIds, selectedRepositories],
  );
  const filteredRepositories = useMemo(() => {
    if (!connectionQuery.data) {
      return [];
    }

    const normalizedSearch = search.trim().toLowerCase();
    return connectionQuery.data.availableRepositories.filter((repository) => {
      if (normalizedSearch.length === 0) {
        return true;
      }

      return (
        `${repository.owner}/${repository.name}`.toLowerCase().includes(normalizedSearch) ||
        repository.description.toLowerCase().includes(normalizedSearch) ||
        repository.defaultBranch.toLowerCase().includes(normalizedSearch)
      );
    });
  }, [connectionQuery.data, search]);
  const selectedNeedsOrgApproval = selectedRepositories.filter((repository) => repository.requiresOrgApproval).length;
  const connectorCoverageReady = uncoveredSelectedRepositories.length === 0 && selectedRepositories.length > 0;

  useEffect(() => {
    if (!bootstrapDetails || connectorCoverageReady || !isOpen) {
      return;
    }

    const interval = window.setInterval(() => {
      void connectionQuery.refetch();
    }, 5_000);

    return () => window.clearInterval(interval);
  }, [bootstrapDetails, connectionQuery, connectorCoverageReady, isOpen]);

  useEffect(() => {
    if (!bootstrapDetails || !connectorCoverageReady || activeStep !== "launch") {
      return;
    }

    setToast({
      title: "Governance is live",
      message: "The first connector heartbeat is active for the selected repository scope.",
      tone: "success",
    });
  }, [activeStep, bootstrapDetails, connectorCoverageReady]);

  function closeDialog() {
    setIsOpen(false);
    setSearch("");
    setSelectionError(null);
    setSubmitError(null);
  }

  function toggleRepository(repositoryId: string) {
    setSelectionError(null);
    setSelectedRepositoryIds((current) =>
      current.includes(repositoryId) ? current.filter((value) => value !== repositoryId) : [...current, repositoryId],
    );
  }

  const saveMutation = useMutation({
    mutationFn: () =>
      updateWorkspaceRepositories({
        repositoryIds: selectedRepositoryIds,
        defaultNotificationChannel,
        policyPack,
      }),
    onSuccess: async (result) => {
      setSubmitError(null);
      setSavedMessage(result.message);
      setSaveSuggestedBootstrap(result.connectorBootstrapSuggested);
      setActiveStep("launch");
      setToast({
        title: "Repositories connected",
        message: result.message,
        tone: result.connectorBootstrapSuggested ? "warning" : "success",
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.repositories }),
        queryClient.invalidateQueries({ queryKey: queryKeys.repositoryConnection }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard }),
        queryClient.invalidateQueries({ queryKey: queryKeys.onboarding }),
        queryClient.invalidateQueries({ queryKey: queryKeys.activity }),
      ]);
      if (!result.connectorBootstrapSuggested) {
        setBootstrapDetails(null);
      }
    },
    onError: (error) => {
      const message = getApiErrorMessage(error, "Could not connect repositories. Retry.");
      setSubmitError(message);
      setToast({
        title: "Connection failed",
        message,
        tone: "error",
      });
    },
  });

  const bootstrapMutation = useMutation({
    mutationFn: () => issueConnectorBootstrapToken(),
    onSuccess: (result) => {
      setSubmitError(null);
      setBootstrapDetails(result);
      setToast({
        title: "Bootstrap command ready",
        message: "Run the command on the machine that hosts the selected repository checkout.",
        tone: "success",
      });
    },
    onError: (error) => {
      const message = getApiErrorMessage(error, "Could not issue a connector bootstrap token.");
      setSubmitError(message);
      setToast({
        title: "Bootstrap failed",
        message,
        tone: "error",
      });
    },
  });

  function goToNextStep() {
    if (activeStep === "select") {
      if (selectedRepositoryIds.length === 0) {
        setSelectionError("Select at least one repository before continuing.");
        return;
      }

      setActiveStep("configure");
      return;
    }

    if (activeStep === "configure") {
      setActiveStep("review");
    }
  }

  function goToPreviousStep() {
    if (activeStep === "configure") {
      setActiveStep("select");
      return;
    }

    if (activeStep === "review") {
      setActiveStep("configure");
      return;
    }

    if (activeStep === "launch" && saveSuggestedBootstrap) {
      setActiveStep("review");
    }
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
            className="max-h-[80vh] w-full max-w-[720px] overflow-y-auto rounded-[var(--ag-radius-xl)] border border-[var(--ag-border-default)] bg-[var(--ag-bg-card)] p-6 shadow-[var(--ag-shadow-xl)]"
            role="dialog"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-semibold text-[var(--ag-text-primary)]">Connect repositories</h2>
                  {connectionQuery.isFetching && connectionQuery.data ? (
                    <StaleIndicator label="Refreshing" tone="warning" />
                  ) : null}
                </div>
                <p className="text-sm text-[var(--ag-text-secondary)]">
                  Connect real repository scope for this workspace, choose the launch defaults that govern it, and
                  bring the connector online before you expect approvals, run detail, snapshots, and writeback to sync.
                </p>
              </div>
              <Button onClick={closeDialog} variant="ghost">
                Close
              </Button>
            </div>

            {!isAdmin ? (
              <div className="mt-6">
                <PageStatePanel
                  errorMessage="You need admin or owner access to connect repositories in this workspace."
                  state="error"
                />
              </div>
            ) : connectionQuery.isPending ? (
              <div className="mt-6 space-y-4">
                <LoadingSkeleton className="w-full" lines={2} />
                <LoadingSkeleton className="w-full" lines={10} />
              </div>
            ) : connectionQuery.isError ? (
              <div className="mt-6">
                <PageStatePanel
                  errorMessage={getApiErrorMessage(
                    connectionQuery.error,
                    "Could not load repository connection setup. Retry.",
                  )}
                  state="error"
                />
              </div>
            ) : connectionQuery.data ? (
              <div className="mt-6 space-y-6">
                <RepositoryConnectionStepper
                  activeStep={activeStep}
                  needsBootstrap={saveSuggestedBootstrap || uncoveredSelectedRepositories.length > 0}
                />

                <div className="grid gap-4 md:grid-cols-4">
                  <Card className="space-y-1">
                    <div className="text-xs uppercase tracking-[0.18em] text-[var(--ag-text-tertiary)]">
                      Available
                    </div>
                    <div className="text-2xl font-semibold text-[var(--ag-text-primary)]">
                      {connectionQuery.data.availableRepositories.length}
                    </div>
                    <div className="text-sm text-[var(--ag-text-secondary)]">Repositories this workspace can claim</div>
                  </Card>
                  <Card className="space-y-1">
                    <div className="text-xs uppercase tracking-[0.18em] text-[var(--ag-text-tertiary)]">
                      Selected
                    </div>
                    <div className="text-2xl font-semibold text-[var(--ag-text-primary)]">
                      {selectedRepositoryIds.length}
                    </div>
                    <div className="text-sm text-[var(--ag-text-secondary)]">Repositories that will appear in cloud</div>
                  </Card>
                  <Card className="space-y-1">
                    <div className="text-xs uppercase tracking-[0.18em] text-[var(--ag-text-tertiary)]">
                      Covered now
                    </div>
                    <div className="text-2xl font-semibold text-[var(--ag-text-primary)]">
                      {selectedRepositories.length - uncoveredSelectedRepositories.length}
                    </div>
                    <div className="text-sm text-[var(--ag-text-secondary)]">Selected repos with an active connector</div>
                  </Card>
                  <Card className="space-y-1">
                    <div className="text-xs uppercase tracking-[0.18em] text-[var(--ag-text-tertiary)]">Fleet</div>
                    <div className="text-2xl font-semibold text-[var(--ag-text-primary)]">
                      {connectionQuery.data.totalConnectorCount}
                    </div>
                    <div className="text-sm text-[var(--ag-text-secondary)]">
                      {connectionQuery.data.activeConnectorCount} active, {connectionQuery.data.staleConnectorCount} stale,{" "}
                      {connectionQuery.data.revokedConnectorCount} revoked
                    </div>
                  </Card>
                </div>

                {activeStep === "select" ? (
                  connectionQuery.data.availableRepositories.length === 0 ? (
                    <EmptyState
                      description="No repositories are currently available to connect in this workspace. They may still need to be discovered locally, approved at the org level, or may already be claimed by another workspace."
                      title="No repositories available"
                    >
                      <Button onClick={closeDialog} variant="secondary">
                        Close
                      </Button>
                    </EmptyState>
                  ) : (
                    <Card className="space-y-4">
                      <div className="space-y-1">
                        <h3 className="text-lg font-semibold text-[var(--ag-text-primary)]">Select repository scope</h3>
                        <p className="text-sm text-[var(--ag-text-secondary)]">
                          Search the repositories this workspace can govern, then select the ones that should appear on
                          dashboard, runs, approvals, activity, snapshots, and policy surfaces.
                        </p>
                      </div>
                      <Input
                        helpText="Search by owner, repository name, branch, or description."
                        id="repository-connect-search"
                        label="Search repositories"
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Search repositories"
                        value={search}
                      />
                      {filteredRepositories.length === 0 ? (
                        <PageStatePanel
                          emptyDescription="No repositories matched your current search. Clear the search or try a different term."
                          emptyTitle="No repositories match"
                          state="empty"
                        />
                      ) : (
                        <div className="space-y-3">
                          {filteredRepositories.map((repository) => (
                            <RepositorySelectionCard
                              covered={connectionQuery.data.activeConnectorRepositoryIds.includes(repository.id)}
                              key={repository.id}
                              onToggle={() => toggleRepository(repository.id)}
                              repository={repository}
                              selected={selectedRepositoryIds.includes(repository.id)}
                            />
                          ))}
                        </div>
                      )}
                      {selectionError ? (
                        <div className="rounded-[var(--ag-radius-md)] border border-[color:rgb(239_68_68_/_0.25)] bg-[var(--ag-bg-error)] px-3 py-2 text-sm text-[var(--ag-color-error)]">
                          {selectionError}
                        </div>
                      ) : null}
                    </Card>
                  )
                ) : null}

                {activeStep === "configure" ? (
                  <div className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(280px,0.85fr)]">
                    <Card className="space-y-5">
                      <div className="space-y-1">
                        <h3 className="text-lg font-semibold text-[var(--ag-text-primary)]">Configure launch defaults</h3>
                        <p className="text-sm text-[var(--ag-text-secondary)]">
                          These defaults apply to the repository scope you are connecting now so the first governed loop
                          is coherent from policy, notification, and connector-readiness perspectives.
                        </p>
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-semibold text-[var(--ag-text-primary)]" htmlFor="repo-connect-notifications">
                          Notification channel
                        </label>
                        <select
                          className={selectClassName()}
                          id="repo-connect-notifications"
                          onChange={(event) => setDefaultNotificationChannel(event.target.value as NotificationChannel)}
                          value={defaultNotificationChannel}
                        >
                          {notificationOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                        <p className="text-sm text-[var(--ag-text-secondary)]">
                          {
                            notificationOptions.find((option) => option.value === defaultNotificationChannel)
                              ?.description
                          }
                        </p>
                      </div>

                      <div className="space-y-3">
                        <div className="text-sm font-semibold text-[var(--ag-text-primary)]">Policy pack</div>
                        <div className="space-y-3">
                          {(Object.keys(policyPackDescriptions) as PolicyPack[]).map((candidate) => {
                            const selected = policyPack === candidate;

                            return (
                              <label
                                className={
                                  selected
                                    ? "flex cursor-pointer items-start gap-3 rounded-[var(--ag-radius-lg)] border border-[var(--ag-color-brand)] bg-[var(--ag-bg-elevated)] p-4"
                                    : "flex cursor-pointer items-start gap-3 rounded-[var(--ag-radius-lg)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-card)] p-4 transition-colors hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-elevated)]"
                                }
                                key={candidate}
                              >
                                <input
                                  checked={selected}
                                  className="mt-1"
                                  name="repository-connect-policy-pack"
                                  onChange={() => setPolicyPack(candidate)}
                                  type="radio"
                                />
                                <div className="space-y-2">
                                  <div className="flex items-center gap-2">
                                    <span className="text-base font-semibold capitalize text-[var(--ag-text-primary)]">
                                      {candidate}
                                    </span>
                                    <Badge tone={toneForPolicyPack(candidate)}>{candidate}</Badge>
                                  </div>
                                  <p className="text-sm text-[var(--ag-text-secondary)]">
                                    {policyPackDescriptions[candidate]}
                                  </p>
                                </div>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    </Card>

                    <Card className="space-y-4">
                      <h3 className="text-lg font-semibold text-[var(--ag-text-primary)]">Runtime binding</h3>
                      <div className="space-y-3 text-sm">
                        <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3">
                          <div className="font-semibold text-[var(--ag-text-primary)]">Connector coverage</div>
                          <div className="mt-1 text-[var(--ag-text-secondary)]">
                            {connectorCoverageReady
                              ? "Every selected repository already has an active connector heartbeat."
                              : `${uncoveredSelectedRepositories.length} selected ${uncoveredSelectedRepositories.length === 1 ? "repository still needs" : "repositories still need"} a live connector after you save this scope.`}
                          </div>
                        </div>
                        {selectedNeedsOrgApproval > 0 ? (
                          <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-color-warning)]/30 bg-[var(--ag-bg-elevated)] px-4 py-3">
                            <div className="font-semibold text-[var(--ag-text-primary)]">Org approval still required</div>
                            <div className="mt-1 text-[var(--ag-text-secondary)]">
                              {selectedNeedsOrgApproval} selected {selectedNeedsOrgApproval === 1 ? "repository is" : "repositories are"} flagged for org-level approval before governance can begin.
                            </div>
                          </div>
                        ) : null}
                        <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3">
                          <div className="font-semibold text-[var(--ag-text-primary)]">What happens after save</div>
                          <div className="mt-1 text-[var(--ag-text-secondary)]">
                            Repository scope becomes visible across the hosted product immediately, but governed runs,
                            approvals, snapshots, and writeback only begin once an active connector heartbeat covers the
                            local checkout.
                          </div>
                        </div>
                      </div>
                    </Card>
                  </div>
                ) : null}

                {activeStep === "review" ? (
                  <div className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(280px,0.85fr)]">
                    <Card className="space-y-4">
                      <div className="space-y-1">
                        <h3 className="text-lg font-semibold text-[var(--ag-text-primary)]">Review repository connection</h3>
                        <p className="text-sm text-[var(--ag-text-secondary)]">
                          Confirm the repo scope, launch defaults, and connector state before you replace the current
                          workspace connection configuration.
                        </p>
                      </div>

                      <div className="space-y-2">
                        {selectedRepositories.map((repository) => (
                          <div
                            className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3"
                            key={repository.id}
                          >
                            <div>
                              <div className="font-semibold text-[var(--ag-text-primary)]">
                                {repository.owner}/{repository.name}
                              </div>
                              <div className="text-sm text-[var(--ag-text-secondary)]">{repository.description}</div>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <Badge
                                tone={
                                  connectionQuery.data.activeConnectorRepositoryIds.includes(repository.id)
                                    ? "success"
                                    : "warning"
                                }
                              >
                                {connectionQuery.data.activeConnectorRepositoryIds.includes(repository.id)
                                  ? "Connector active"
                                  : "Needs connector"}
                              </Badge>
                              {repository.requiresOrgApproval ? <Badge tone="warning">Org approval</Badge> : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    </Card>

                    <Card className="space-y-4">
                      <h3 className="text-lg font-semibold text-[var(--ag-text-primary)]">Launch summary</h3>
                      <div className="space-y-3 text-sm">
                        <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3">
                          <div className="font-semibold text-[var(--ag-text-primary)]">Defaults</div>
                          <div className="mt-1 text-[var(--ag-text-secondary)]">
                            {formatNotificationLabel(defaultNotificationChannel)} notifications · {policyPack} policy pack
                          </div>
                        </div>
                        <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3">
                          <div className="font-semibold text-[var(--ag-text-primary)]">Governance start condition</div>
                          <div className="mt-1 text-[var(--ag-text-secondary)]">
                            {connectorCoverageReady
                              ? "Governance can begin immediately because every selected repository already has connector coverage."
                              : "The connector bootstrap handoff will open next because at least one selected repository still needs a live connector."}
                          </div>
                        </div>
                        {selectedNeedsOrgApproval > 0 ? (
                          <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-color-warning)]/30 bg-[var(--ag-bg-elevated)] px-4 py-3">
                            <div className="font-semibold text-[var(--ag-text-primary)]">Approval blocker</div>
                            <div className="mt-1 text-[var(--ag-text-secondary)]">
                              Org-level provider approval is still required for part of this repository selection.
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </Card>
                  </div>
                ) : null}

                {activeStep === "launch" ? (
                  saveSuggestedBootstrap ? (
                    <div className="space-y-6">
                      <Card className="space-y-4">
                        <div className="space-y-1">
                          <h3 className="text-lg font-semibold text-[var(--ag-text-primary)]">Start governance</h3>
                          <p className="text-sm text-[var(--ag-text-secondary)]">
                            Repository scope is saved. Governance begins after the first connector heartbeat covers the
                            local checkout for the selected repositories.
                          </p>
                        </div>
                        {savedMessage ? (
                          <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-color-warning)]/30 bg-[var(--ag-bg-elevated)] px-4 py-3 text-sm text-[var(--ag-text-primary)]">
                            {savedMessage}
                          </div>
                        ) : null}
                        <div className="flex flex-wrap gap-2">
                          {uncoveredSelectedRepositories.map((repository) => (
                            <Badge key={repository.id} tone="warning">
                              {repository.owner}/{repository.name}
                            </Badge>
                          ))}
                        </div>
                        {bootstrapDetails ? (
                          <ConnectorBootstrapPanel
                            bootstrapDetails={bootstrapDetails}
                            connected={connectorCoverageReady}
                            waitingForConnection={!connectorCoverageReady}
                          />
                        ) : (
                          <div className="flex flex-wrap gap-3">
                            <Button onClick={() => bootstrapMutation.mutate()} variant="secondary">
                              {bootstrapMutation.isPending ? "Generating..." : "Generate bootstrap token"}
                            </Button>
                            <a
                              className="ag-focus-ring inline-flex h-9 items-center justify-center rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] bg-[var(--ag-bg-card)] px-4 text-sm font-medium text-[var(--ag-text-primary)] transition-colors hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-hover)]"
                              href={authenticatedRoutes.connectors}
                            >
                              Open connector fleet
                            </a>
                          </div>
                        )}
                      </Card>
                    </div>
                  ) : (
                    <Card className="space-y-4">
                      <div className="space-y-1">
                        <h3 className="text-lg font-semibold text-[var(--ag-text-primary)]">Repositories connected</h3>
                        <p className="text-sm text-[var(--ag-text-secondary)]">
                          The selected repositories are now part of this workspace and already have the connector
                          coverage needed for governed work.
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {selectedRepositories.map((repository) => (
                          <Badge key={repository.id} tone="success">
                            {repository.owner}/{repository.name}
                          </Badge>
                        ))}
                      </div>
                      {savedMessage ? (
                        <div className="rounded-[var(--ag-radius-md)] border border-[color:rgb(34_197_94_/_0.25)] bg-[var(--ag-bg-elevated)] px-4 py-3 text-sm text-[var(--ag-text-primary)]">
                          {savedMessage}
                        </div>
                      ) : null}
                    </Card>
                  )
                ) : null}

                {submitError ? (
                  <div className="rounded-[var(--ag-radius-md)] border border-[color:rgb(239_68_68_/_0.25)] bg-[var(--ag-bg-error)] px-3 py-2 text-sm text-[var(--ag-color-error)]">
                    {submitError}
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--ag-border-subtle)] pt-4">
                  <div className="text-sm text-[var(--ag-text-secondary)]">
                    {activeStep === "launch"
                      ? saveSuggestedBootstrap
                        ? connectorCoverageReady
                          ? "Connector coverage is live. You can close this flow and continue from repositories or dashboard."
                          : "Keep this open while the connector starts and the first heartbeat arrives."
                        : "Repository scope is connected and ready for governed work."
                      : `${selectedRepositoryIds.length} repositories selected · ${formatNotificationLabel(
                          defaultNotificationChannel,
                        )} notifications · ${policyPack} policy pack`}
                  </div>
                  <div className="flex flex-wrap gap-3">
                    {activeStep !== "select" && activeStep !== "launch" ? (
                      <Button onClick={goToPreviousStep} variant="ghost">
                        Back
                      </Button>
                    ) : null}
                    {activeStep === "launch" && saveSuggestedBootstrap ? (
                      <Button onClick={closeDialog} variant="ghost">
                        {connectorCoverageReady ? "Close" : "Close for now"}
                      </Button>
                    ) : null}
                    {activeStep === "launch" && !saveSuggestedBootstrap ? (
                      <Button onClick={closeDialog} variant="secondary">
                        Close
                      </Button>
                    ) : null}
                    {activeStep === "select" ? (
                      <>
                        <Button onClick={closeDialog} variant="ghost">
                          Cancel
                        </Button>
                        <Button
                          disabled={connectionQuery.data.availableRepositories.length === 0}
                          onClick={goToNextStep}
                        >
                          Continue
                        </Button>
                      </>
                    ) : null}
                    {activeStep === "configure" ? (
                      <>
                        <Button onClick={goToPreviousStep} variant="ghost">
                          Back
                        </Button>
                        <Button onClick={goToNextStep}>Review connection</Button>
                      </>
                    ) : null}
                    {activeStep === "review" ? (
                      <>
                        <Button onClick={goToPreviousStep} variant="ghost">
                          Back
                        </Button>
                        <Button disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>
                          {saveMutation.isPending ? "Connecting..." : "Connect repositories"}
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {toast ? (
        <ToastViewport>
          <ToastCard
            className={
              toast.tone === "success"
                ? "pointer-events-none border-[color:rgb(34_197_94_/_0.28)]"
                : toast.tone === "warning"
                  ? "pointer-events-none border-[color:rgb(245_158_11_/_0.28)]"
                  : "pointer-events-none border-[color:rgb(239_68_68_/_0.28)]"
            }
          >
            <div className="space-y-1">
              <div className="text-sm font-semibold text-[var(--ag-text-primary)]">{toast.title}</div>
              <p className="text-sm text-[var(--ag-text-secondary)]">{toast.message}</p>
            </div>
          </ToastCard>
        </ToastViewport>
      ) : null}
    </>
  );
}
