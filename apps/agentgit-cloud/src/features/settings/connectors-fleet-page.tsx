"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { MetricCard, PageHeader } from "@/components/composites";
import { EmptyState, LoadingSkeleton, PageStatePanel, StaleIndicator } from "@/components/feedback";
import { useLiveUpdateStatus } from "@/components/providers/live-update-context";
import {
  Badge,
  Button,
  Card,
  Input,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRoot,
  TableRow,
  ToastCard,
  ToastViewport,
} from "@/components/primitives";
import { getApiErrorMessage } from "@/lib/api/client";
import { authenticatedRoutes, repositoryRoute } from "@/lib/navigation/routes";
import { dispatchConnectorCommand, retryConnectorCommand, revokeConnector } from "@/lib/api/endpoints/connectors";
import { useWorkspaceConnectorsQuery } from "@/lib/query/hooks";
import { queryKeys } from "@/lib/query/keys";
import { sanitizeExternalUrl } from "@/lib/security/external-url";
import { formatAbsoluteDate, formatNumber, formatRelativeTimestamp } from "@/lib/utils/format";
import type { WorkspaceConnectorCommandSummary, WorkspaceConnectorSummary } from "@/schemas/cloud";
import { ConnectorInstallGuide } from "@/features/shared/connector-install-guide";

type FleetToast = {
  title: string;
  message: string;
  tone: "success" | "warning" | "error";
};

type CommandHistoryFilter = "all" | "replayable" | "active" | "settled";
type FleetStatusFilter = "all" | "active" | "stale" | "revoked";

const commandHistoryFilters: Array<{ filter: CommandHistoryFilter; label: string }> = [
  { filter: "all", label: "All" },
  { filter: "replayable", label: "Replayable" },
  { filter: "active", label: "Active" },
  { filter: "settled", label: "Settled" },
];

const fleetStatusFilters: Array<{ filter: FleetStatusFilter; label: string }> = [
  { filter: "all", label: "All" },
  { filter: "active", label: "Active" },
  { filter: "stale", label: "Stale" },
  { filter: "revoked", label: "Revoked" },
];

function statusTone(status: WorkspaceConnectorSummary["status"]): "success" | "warning" | "error" {
  if (status === "active") {
    return "success";
  }

  if (status === "stale") {
    return "warning";
  }

  return "error";
}

function providerTone(
  status: WorkspaceConnectorSummary["providerIdentity"]["status"],
): "success" | "warning" | "error" | "neutral" {
  if (status === "verified") {
    return "success";
  }

  if (status === "drifted") {
    return "warning";
  }

  if (status === "unreachable") {
    return "error";
  }

  return "neutral";
}

function commandTone(
  status: WorkspaceConnectorCommandSummary["status"],
): "success" | "warning" | "error" | "accent" | "neutral" {
  if (status === "completed") {
    return "success";
  }

  if (status === "failed") {
    return "error";
  }

  if (status === "expired") {
    return "warning";
  }

  if (status === "acked") {
    return "accent";
  }

  return "neutral";
}

function commandSummary(command: WorkspaceConnectorCommandSummary): string | null {
  if (command.message) {
    return command.message;
  }

  switch (command.type) {
    case "replay_run":
      return "Run replay updated through the local connector.";
    case "create_commit":
      return "Commit creation completed through the local connector.";
    case "push_branch":
      return "Branch push completed through the local connector.";
    case "open_pull_request":
      return "Pull request creation completed through the local connector.";
    case "execute_restore":
      return "Snapshot restore command finished on the local connector.";
    case "refresh_repo_state":
      return "Repository state refresh completed.";
    case "sync_run_history":
      return "Run history synchronization completed.";
    default:
      return null;
  }
}

function commandDisplayState(command: WorkspaceConnectorCommandSummary): string {
  if (command.nextAttemptAt) {
    return "retry scheduled";
  }

  if (command.status === "acked") {
    return "running";
  }

  if (command.status === "pending") {
    return "queued";
  }

  return command.status;
}

function commandReplayTone(command: WorkspaceConnectorCommandSummary): "success" | "warning" | "neutral" {
  if (command.replayable) {
    return "success";
  }

  if (command.status === "acked" || command.status === "pending") {
    return "warning";
  }

  return "neutral";
}

function commandHistoryMatchesFilter(command: WorkspaceConnectorCommandSummary, filter: CommandHistoryFilter): boolean {
  if (filter === "all") {
    return true;
  }

  if (filter === "replayable") {
    return command.replayable ?? (command.status === "failed" || command.status === "expired");
  }

  if (filter === "active") {
    return command.status === "pending" || command.status === "acked";
  }

  return command.status === "completed";
}

function fallbackConnectorSummary(message: string) {
  return (
    <EmptyState description={message} title="No connectors registered yet">
      <Link
        className="ag-focus-ring inline-flex h-9 items-center justify-center rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] bg-[var(--ag-bg-card)] px-4 text-sm font-medium text-[var(--ag-text-primary)] transition-colors hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-hover)]"
        href={authenticatedRoutes.integrations}
      >
        Open integrations
      </Link>
    </EmptyState>
  );
}

function FleetLoadingState() {
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(340px,0.95fr)]">
      <Card className="space-y-4">
        <LoadingSkeleton className="w-48" />
        <LoadingSkeleton className="w-full" lines={10} />
      </Card>
      <Card className="space-y-4">
        <LoadingSkeleton className="w-40" />
        <LoadingSkeleton className="w-full" lines={12} />
      </Card>
    </div>
  );
}

export function ConnectorsFleetPage() {
  const queryClient = useQueryClient();
  const liveUpdateStatus = useLiveUpdateStatus();
  const connectorsQuery = useWorkspaceConnectorsQuery();
  const [selectedConnectorId, setSelectedConnectorId] = useState<string>("");
  const [commandHistoryFilter, setCommandHistoryFilter] = useState<CommandHistoryFilter>("all");
  const [fleetStatusFilter, setFleetStatusFilter] = useState<FleetStatusFilter>("all");
  const [search, setSearch] = useState("");
  const [toast, setToast] = useState<FleetToast | null>(null);
  const liveLabel =
    liveUpdateStatus.lastInvalidatedAt && liveUpdateStatus.invalidationCount > 0
      ? `live ${formatRelativeTimestamp(liveUpdateStatus.lastInvalidatedAt)}`
      : liveUpdateStatus.state === "connected"
        ? "live updates active"
        : liveUpdateStatus.state === "degraded"
          ? "updates delayed"
          : "connecting live updates";

  useEffect(() => {
    if (!connectorsQuery.data?.items.length) {
      setSelectedConnectorId("");
      return;
    }

    if (!selectedConnectorId || !connectorsQuery.data.items.some((item) => item.id === selectedConnectorId)) {
      setSelectedConnectorId(connectorsQuery.data.items[0]!.id);
    }
  }, [connectorsQuery.data, selectedConnectorId]);

  useEffect(() => {
    if (!toast) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setToast(null);
    }, 4_000);

    return () => window.clearTimeout(timeout);
  }, [toast]);

  const refreshFleetMutation = useMutation({
    mutationFn: () => queryClient.invalidateQueries({ queryKey: queryKeys.connectors }),
    onSuccess: () => {
      setToast({
        title: "Fleet refreshed",
        message: "Connector inventory was reloaded from the control plane.",
        tone: "success",
      });
    },
    onError: () => {
      setToast({
        title: "Refresh failed",
        message: "Could not refresh the connector fleet.",
        tone: "warning",
      });
    },
  });

  const commandMutation = useMutation({
    mutationFn: ({
      connectorId,
      request,
    }: {
      connectorId: string;
      request:
        | { type: "refresh_repo_state"; forceFullSync: boolean }
        | { type: "sync_run_history"; includeSnapshots: boolean };
    }) => dispatchConnectorCommand(connectorId, request),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.connectors }).catch(() => undefined);
      setToast({
        title: "Connector command queued",
        message: result.message,
        tone: "success",
      });
    },
    onError: () => {
      setToast({
        title: "Command failed",
        message: "Could not queue the connector command.",
        tone: "warning",
      });
    },
  });

  const retryMutation = useMutation({
    mutationFn: (commandId: string) => retryConnectorCommand(commandId),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.connectors }).catch(() => undefined);
      setToast({
        title: "Command retried",
        message: result.message,
        tone: "success",
      });
    },
    onError: () => {
      setToast({
        title: "Retry failed",
        message: "Could not re-queue the connector command.",
        tone: "warning",
      });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (connectorId: string) => revokeConnector(connectorId),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.connectors }).catch(() => undefined);
      setToast({
        title: "Connector revoked",
        message: result.message,
        tone: "warning",
      });
    },
    onError: () => {
      setToast({
        title: "Revoke failed",
        message: "Could not revoke the connector.",
        tone: "warning",
      });
    },
  });

  if (connectorsQuery.isPending) {
    return (
      <>
        <PageHeader
          actions={
            <StaleIndicator label={liveLabel} tone={liveUpdateStatus.state === "degraded" ? "warning" : "success"} />
          }
          description="Workspace connector fleet health, leases, retries, provider identity, and recent command history."
          title="Connector fleet"
        />
        <FleetLoadingState />
      </>
    );
  }

  if (connectorsQuery.isError || !connectorsQuery.data) {
    return (
      <>
        <PageHeader
          actions={
            <StaleIndicator label={liveLabel} tone={liveUpdateStatus.state === "degraded" ? "warning" : "success"} />
          }
          description="Workspace connector fleet health, leases, retries, provider identity, and recent command history."
          title="Connector fleet"
        />
        <PageStatePanel
          errorMessage={getApiErrorMessage(connectorsQuery.error, "Could not load connector fleet. Retry.")}
          state="error"
        />
      </>
    );
  }

  const inventory = connectorsQuery.data;
  const normalizedSearch = search.trim().toLowerCase();
  const items = inventory.items.filter((connector) => {
    if (fleetStatusFilter !== "all" && connector.status !== fleetStatusFilter) {
      return false;
    }

    if (normalizedSearch.length === 0) {
      return true;
    }

    return (
      connector.connectorName.toLowerCase().includes(normalizedSearch) ||
      connector.machineName.toLowerCase().includes(normalizedSearch) ||
      `${connector.repositoryOwner}/${connector.repositoryName}`.toLowerCase().includes(normalizedSearch)
    );
  });
  const selectedConnector = items.find((connector) => connector.id === selectedConnectorId) ?? items[0] ?? null;
  const selectedConnectorCommands = selectedConnector?.recentCommands ?? [];
  const filteredCommands = selectedConnectorCommands.filter((command) =>
    commandHistoryMatchesFilter(command, commandHistoryFilter),
  );

  const summary = {
    total: inventory.total,
    active: items.filter((connector) => connector.status === "active").length,
    unhealthy: items.filter((connector) => connector.status !== "active").length,
    retryable: items.reduce((total, connector) => total + connector.retryableCommandCount, 0),
    autoRetries: items.reduce((total, connector) => total + connector.automaticRetryCount, 0),
  };
  const selectedReplayableCount = selectedConnectorCommands.filter((command) => command.replayable).length;
  const selectedActiveCommandCount = selectedConnectorCommands.filter(
    (command) => command.status === "pending" || command.status === "acked",
  ).length;
  const selectedSettledCount = selectedConnectorCommands.filter((command) => command.status === "completed").length;
  const selectedScheduledRetryCount = selectedConnectorCommands.filter(
    (command) => command.nextAttemptAt !== null,
  ).length;
  const selectedTimeline = !selectedConnector
    ? []
    : [
        ...selectedConnector.recentCommands.map((command) => ({
          id: `command:${command.commandId}`,
          timestamp: command.updatedAt,
          kind: "command" as const,
          label: `${command.type} / ${commandDisplayState(command)}`,
          detail: commandSummary(command) ?? command.message ?? "No command details recorded.",
          href:
            command.detailPath ?? repositoryRoute(selectedConnector.repositoryOwner, selectedConnector.repositoryName),
          externalUrl: command.externalUrl ?? null,
        })),
        ...selectedConnector.recentEvents.map((event) => ({
          id: `event:${event.eventId}`,
          timestamp: event.occurredAt,
          kind: "event" as const,
          label: event.type,
          detail: "Connector event synchronized into the control plane.",
          href: repositoryRoute(selectedConnector.repositoryOwner, selectedConnector.repositoryName),
          externalUrl: null,
        })),
      ]
        .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())
        .slice(0, 10);

  if (items.length === 0) {
    return (
      <>
        <PageHeader
          actions={
            <Button
              disabled={refreshFleetMutation.isPending}
              onClick={() => refreshFleetMutation.mutate()}
              variant="secondary"
            >
              {refreshFleetMutation.isPending ? "Refreshing..." : "Refresh fleet"}
            </Button>
          }
          description="Workspace connector fleet health, leases, retries, provider identity, and recent command history."
          title="Connector fleet"
        />
        <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="Connected connectors" value="0" trend="no registered machines" />
          <MetricCard label="Active" value="0" trend="no live connectors" />
          <MetricCard label="Retryable commands" value="0" trend="nothing to reclaim" />
          <MetricCard label="Provider verified" value="0" trend="verification appears here" />
        </div>
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.9fr)]">
          {fallbackConnectorSummary(
            "No local connectors have registered for this workspace yet. Generate a bootstrap token or launch the local connector to start observing fleet health.",
          )}
          <ConnectorInstallGuide />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StaleIndicator label={liveLabel} tone={liveUpdateStatus.state === "degraded" ? "warning" : "success"} />
            <Link
              className="ag-focus-ring inline-flex h-9 items-center justify-center rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] px-3 text-sm font-medium text-[var(--ag-text-primary)] transition-colors hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-hover)]"
              href={authenticatedRoutes.integrations}
            >
              Open integrations
            </Link>
            <Button
              disabled={refreshFleetMutation.isPending}
              onClick={() => refreshFleetMutation.mutate()}
              variant="secondary"
            >
              {refreshFleetMutation.isPending ? "Refreshing..." : "Refresh fleet"}
            </Button>
          </div>
        }
        description="Workspace connector fleet health, leases, retries, provider identity, and recent command history."
        title="Connector fleet"
      />

      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Connected connectors" value={String(summary.total)} trend="registered connectors" />
        <MetricCard label="Active" value={String(summary.active)} trend={`${summary.unhealthy} need attention`} />
        <MetricCard
          label="Retryable commands"
          value={String(summary.retryable)}
          trend={`${summary.autoRetries} scheduled retries`}
        />
        <MetricCard
          label="Provider verified"
          value={String(items.filter((connector) => connector.providerIdentity.status === "verified").length)}
          trend="identity drift surfaced"
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(340px,0.95fr)]">
        <Card className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Fleet registry</h2>
              <p className="mt-1 text-sm text-[var(--ag-text-secondary)]">
                Registered connectors, their provider identity, and current operating state.
              </p>
            </div>
            <Badge tone={summary.unhealthy === 0 ? "success" : "warning"}>
              {summary.unhealthy === 0 ? "All healthy" : `${summary.unhealthy} need review`}
            </Badge>
          </div>
          <div className="text-sm text-[var(--ag-text-secondary)]">
            Showing {inventory.items.length} of {inventory.total} registered connectors.
          </div>
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
            <Input
              helpText="Search by connector, machine, repository, or workspace root."
              id="fleet-search"
              label="Search fleet"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search connectors"
              value={search}
            />
            <div className="flex flex-wrap items-end gap-2">
              {fleetStatusFilters.map((entry) => (
                <button
                  className={`ag-focus-ring rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    fleetStatusFilter === entry.filter
                      ? "border-[var(--ag-color-brand)] bg-[color:rgb(72_100_255_/_0.12)] text-[var(--ag-text-primary)]"
                      : "border-[var(--ag-border-subtle)] bg-[var(--ag-bg-card)] text-[var(--ag-text-secondary)] hover:border-[var(--ag-border-default)]"
                  }`}
                  key={entry.filter}
                  onClick={() => setFleetStatusFilter(entry.filter)}
                  type="button"
                >
                  {entry.label}
                </button>
              ))}
            </div>
          </div>

          <TableRoot>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Connector</TableHeaderCell>
                <TableHeaderCell>Provider</TableHeaderCell>
                <TableHeaderCell>Health</TableHeaderCell>
                <TableHeaderCell>Commands</TableHeaderCell>
                <TableHeaderCell>Last seen</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((connector) => {
                const selected = connector.id === selectedConnector?.id;

                return (
                  <TableRow key={connector.id}>
                    <TableCell>
                      <button
                        className="ag-focus-ring rounded-sm text-left"
                        onClick={() => setSelectedConnectorId(connector.id)}
                        type="button"
                      >
                        <div className="font-medium text-[var(--ag-text-primary)]">{connector.connectorName}</div>
                        <div className="mt-1 text-xs text-[var(--ag-text-secondary)]">
                          {connector.machineName} · {connector.workspaceSlug}
                        </div>
                        <div className="mt-2 text-[11px] uppercase tracking-[0.06em] text-[var(--ag-text-secondary)]">
                          {selected ? "Selected" : "Click for diagnostics"}
                        </div>
                      </button>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        <Badge tone={providerTone(connector.providerIdentity.status)}>
                          {connector.providerIdentity.provider} / {connector.providerIdentity.status}
                        </Badge>
                        <div className="text-xs text-[var(--ag-text-secondary)]">
                          {connector.providerIdentity.owner}/{connector.providerIdentity.name}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        <Badge tone={statusTone(connector.status)}>{connector.status}</Badge>
                        <div className="text-xs text-[var(--ag-text-secondary)]">
                          {connector.daemonReachable ? "Daemon reachable" : "Daemon offline"}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-[var(--ag-text-secondary)]">
                      <div>{formatNumber(connector.pendingCommandCount)} pending</div>
                      <div>{formatNumber(connector.retryableCommandCount)} retryable</div>
                    </TableCell>
                    <TableCell className="text-[var(--ag-text-secondary)]">
                      {formatRelativeTimestamp(connector.lastSeenAt)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </TableRoot>
          {connectorsQuery.hasNextPage ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--ag-border-subtle)] pt-4">
              <p className="text-sm text-[var(--ag-text-secondary)]">
                Load the next connector page to inspect more fleet machines and histories.
              </p>
              <Button
                disabled={connectorsQuery.isFetchingNextPage}
                onClick={() => void connectorsQuery.fetchNextPage()}
                variant="secondary"
              >
                {connectorsQuery.isFetchingNextPage ? "Loading..." : "Load more"}
              </Button>
            </div>
          ) : null}
        </Card>

        {selectedConnector ? (
          <div className="space-y-6">
            <ConnectorInstallGuide compact />

            <Card className="space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">{selectedConnector.connectorName}</h2>
                  <p className="mt-1 text-sm text-[var(--ag-text-secondary)]">
                    {selectedConnector.machineName} · last seen {formatRelativeTimestamp(selectedConnector.lastSeenAt)}
                  </p>
                  {selectedConnector.statusReason ? (
                    <p className="mt-2 text-sm text-[var(--ag-text-secondary)]">{selectedConnector.statusReason}</p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={statusTone(selectedConnector.status)}>{selectedConnector.status}</Badge>
                  <Badge tone={providerTone(selectedConnector.providerIdentity.status)}>
                    {selectedConnector.providerIdentity.status}
                  </Badge>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-card)] px-3 py-2 text-sm">
                  <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-secondary)]">Repository</div>
                  <Link
                    className="mt-1 inline-flex font-medium text-[var(--ag-color-brand)] underline-offset-4 hover:underline"
                    href={repositoryRoute(selectedConnector.repositoryOwner, selectedConnector.repositoryName)}
                  >
                    {selectedConnector.repositoryOwner}/{selectedConnector.repositoryName}
                  </Link>
                </div>
                <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-card)] px-3 py-2 text-sm">
                  <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-secondary)]">Sync state</div>
                  <div className="mt-1 text-sm text-[var(--ag-text-secondary)]">
                    {selectedConnector.daemonReachable
                      ? "Local daemon heartbeat is healthy."
                      : "Local daemon heartbeat is unavailable."}
                  </div>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-secondary)]">Provider URL</div>
                  <div className="mt-1 text-sm text-[var(--ag-text-secondary)]">
                    {sanitizeExternalUrl(selectedConnector.providerIdentity.repositoryUrl) ? (
                      <a
                        className="font-medium text-[var(--ag-color-brand)] underline-offset-4 hover:underline"
                        href={sanitizeExternalUrl(selectedConnector.providerIdentity.repositoryUrl)!}
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        {selectedConnector.providerIdentity.repositoryUrl}
                      </a>
                    ) : (
                      "Not verified yet"
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-secondary)]">
                    Provider state
                  </div>
                  <div className="mt-1 text-sm text-[var(--ag-text-secondary)]">
                    {selectedConnector.providerIdentity.statusReason ?? "Verified from the local connector state."}
                  </div>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-2">
                <div>
                  <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-secondary)]">
                    Default branch
                  </div>
                  <div className="mt-1 font-medium">{selectedConnector.providerIdentity.defaultBranch}</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-secondary)]">Visibility</div>
                  <div className="mt-1 font-medium capitalize">{selectedConnector.providerIdentity.visibility}</div>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                <div>
                  <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-secondary)]">Pending</div>
                  <div className="mt-1 font-medium">{formatNumber(selectedConnector.pendingCommandCount)}</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-secondary)]">Leased</div>
                  <div className="mt-1 font-medium">{formatNumber(selectedConnector.leasedCommandCount)}</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-secondary)]">Retryable</div>
                  <div className="mt-1 font-medium">{formatNumber(selectedConnector.retryableCommandCount)}</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-secondary)]">Auto retries</div>
                  <div className="mt-1 font-medium">{formatNumber(selectedConnector.automaticRetryCount)}</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-secondary)]">Events</div>
                  <div className="mt-1 font-medium">{formatNumber(selectedConnector.eventCount)}</div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={
                    commandMutation.isPending ||
                    selectedConnector.status !== "active" ||
                    selectedConnector.daemonReachable === false
                  }
                  onClick={() =>
                    commandMutation.mutate({
                      connectorId: selectedConnector.id,
                      request: {
                        type: "refresh_repo_state",
                        forceFullSync: true,
                      },
                    })
                  }
                  size="sm"
                >
                  Queue refresh
                </Button>
                <Button
                  disabled={
                    commandMutation.isPending ||
                    selectedConnector.status !== "active" ||
                    selectedConnector.daemonReachable === false
                  }
                  onClick={() =>
                    commandMutation.mutate({
                      connectorId: selectedConnector.id,
                      request: {
                        type: "sync_run_history",
                        includeSnapshots: true,
                      },
                    })
                  }
                  size="sm"
                  variant="secondary"
                >
                  Sync run history
                </Button>
                <Button
                  disabled={
                    retryMutation.isPending ||
                    !selectedConnectorCommands.some(
                      (command) => command.status === "failed" || command.status === "expired",
                    )
                  }
                  onClick={() => {
                    const retryable = selectedConnectorCommands.find(
                      (command) => command.status === "failed" || command.status === "expired",
                    );
                    if (retryable) {
                      retryMutation.mutate(retryable.commandId);
                    }
                  }}
                  size="sm"
                  variant="secondary"
                >
                  Retry last failed
                </Button>
                <Button
                  disabled={revokeMutation.isPending || selectedConnector.status === "revoked"}
                  onClick={() => revokeMutation.mutate(selectedConnector.id)}
                  size="sm"
                  variant="destructive"
                >
                  {selectedConnector.status === "revoked" ? "Connector revoked" : "Revoke connector"}
                </Button>
              </div>
            </Card>

            <Card className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">Operational timeline</h2>
                <Badge tone={selectedTimeline.length > 0 ? "accent" : "neutral"}>
                  {formatNumber(selectedTimeline.length)}
                </Badge>
              </div>
              {selectedTimeline.length === 0 ? (
                <div className="text-sm text-[var(--ag-text-secondary)]">
                  No command or event timeline is available yet.
                </div>
              ) : (
                <div className="space-y-3">
                  {selectedTimeline.map((entry) => (
                    <div
                      className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-card)] px-4 py-3"
                      key={entry.id}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-1">
                          <div className="text-sm font-medium text-[var(--ag-text-primary)]">{entry.label}</div>
                          <div className="text-sm text-[var(--ag-text-secondary)]">{entry.detail}</div>
                        </div>
                        <Badge tone={entry.kind === "command" ? "accent" : "neutral"}>{entry.kind}</Badge>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-[var(--ag-text-secondary)]">
                        <span>{formatRelativeTimestamp(entry.timestamp)}</span>
                        <Link
                          className="font-medium text-[var(--ag-color-brand)] underline-offset-4 hover:underline"
                          href={entry.href}
                        >
                          Open context
                        </Link>
                        {sanitizeExternalUrl(entry.externalUrl) ? (
                          <a
                            className="font-medium text-[var(--ag-color-brand)] underline-offset-4 hover:underline"
                            href={sanitizeExternalUrl(entry.externalUrl)!}
                            rel="noopener noreferrer"
                            target="_blank"
                          >
                            Open provider
                          </a>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card className="space-y-4">
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">Command history</h2>
                    <p className="mt-1 text-sm text-[var(--ag-text-secondary)]">
                      Replay and retry history for connector-dispatched work.
                    </p>
                  </div>
                  <Badge tone={selectedReplayableCount > 0 ? "success" : "neutral"}>
                    {formatNumber(selectedReplayableCount)} safe to replay
                  </Badge>
                </div>
                <div className="flex flex-wrap gap-2">
                  {commandHistoryFilters.map((entry) => (
                    <button
                      className={`ag-focus-ring rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                        commandHistoryFilter === entry.filter
                          ? "border-[var(--ag-color-brand)] bg-[color:rgb(72_100_255_/_0.12)] text-[var(--ag-text-primary)]"
                          : "border-[var(--ag-border-subtle)] bg-[var(--ag-bg-card)] text-[var(--ag-text-secondary)] hover:border-[var(--ag-border-default)]"
                      }`}
                      key={entry.filter}
                      onClick={() => setCommandHistoryFilter(entry.filter)}
                      type="button"
                    >
                      {entry.label}
                    </button>
                  ))}
                </div>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-3 py-2">
                    <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-secondary)]">Active</div>
                    <div className="mt-1 text-lg font-semibold">{formatNumber(selectedActiveCommandCount)}</div>
                  </div>
                  <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-3 py-2">
                    <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-secondary)]">Replayable</div>
                    <div className="mt-1 text-lg font-semibold">{formatNumber(selectedReplayableCount)}</div>
                  </div>
                  <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-3 py-2">
                    <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-secondary)]">Settled</div>
                    <div className="mt-1 text-lg font-semibold">{formatNumber(selectedSettledCount)}</div>
                  </div>
                  <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-3 py-2">
                    <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-secondary)]">
                      Scheduled retry
                    </div>
                    <div className="mt-1 text-lg font-semibold">{formatNumber(selectedScheduledRetryCount)}</div>
                  </div>
                </div>
              </div>
              {filteredCommands.length === 0 ? (
                <div className="text-sm text-[var(--ag-text-secondary)]">
                  {selectedConnectorCommands.length === 0
                    ? "No connector commands have been recorded yet."
                    : "No commands match the current history filter."}
                </div>
              ) : (
                <div className="space-y-3">
                  {filteredCommands.map((command) => (
                    <div
                      className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-card)] px-4 py-3"
                      key={command.commandId}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge tone={commandTone(command.status)}>{command.type}</Badge>
                            <Badge tone={commandReplayTone(command)}>
                              {command.replayable
                                ? "replayable"
                                : (command.replayStatus ?? commandDisplayState(command))}
                            </Badge>
                            <span className="text-sm text-[var(--ag-text-secondary)]">
                              {commandDisplayState(command)}
                            </span>
                          </div>
                          <div className="text-sm text-[var(--ag-text-secondary)]">
                            {commandSummary(command) ?? command.message ?? "No command summary available."}
                          </div>
                          {command.replayReason ? (
                            <div className="text-xs text-[var(--ag-text-secondary)]">{command.replayReason}</div>
                          ) : null}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {command.detailPath ? (
                            <Link
                              className="text-xs font-medium text-[var(--ag-color-brand)] underline-offset-4 hover:underline"
                              href={command.detailPath}
                            >
                              Open context
                            </Link>
                          ) : null}
                          {sanitizeExternalUrl(command.externalUrl) ? (
                            <a
                              className="text-xs font-medium text-[var(--ag-color-brand)] underline-offset-4 hover:underline"
                              href={sanitizeExternalUrl(command.externalUrl)!}
                              rel="noopener noreferrer"
                              target="_blank"
                            >
                              Open provider
                            </a>
                          ) : null}
                          {command.replayable ? (
                            <Button
                              disabled={retryMutation.isPending}
                              onClick={() => retryMutation.mutate(command.commandId)}
                              size="sm"
                              variant="secondary"
                            >
                              Replay now
                            </Button>
                          ) : null}
                          <span className="text-xs text-[var(--ag-text-secondary)]">
                            {formatRelativeTimestamp(command.updatedAt)}
                          </span>
                        </div>
                      </div>
                      <div className="mt-3 grid gap-2 text-xs text-[var(--ag-text-secondary)] sm:grid-cols-2 xl:grid-cols-4">
                        <span>{command.commandId}</span>
                        <span>attempt {formatNumber(command.attemptCount)}</span>
                        <span>
                          {command.nextAttemptAt
                            ? `retry at ${formatAbsoluteDate(command.nextAttemptAt)}`
                            : "no scheduled retry"}
                        </span>
                        <span>
                          {command.leaseExpiresAt
                            ? `lease expires ${formatAbsoluteDate(command.leaseExpiresAt)}`
                            : "no active lease"}
                        </span>
                      </div>
                      {command.result ? (
                        <div className="mt-3 rounded-[var(--ag-radius-sm)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-3 py-2 text-sm text-[var(--ag-text-secondary)]">
                          {commandSummary({ ...command, message: command.message }) ??
                            "Result recorded for this command."}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">Recent synced events</h2>
                <Badge tone={selectedConnector.recentEvents.length === 0 ? "neutral" : "accent"}>
                  {formatNumber(selectedConnector.recentEvents.length)}
                </Badge>
              </div>
              {selectedConnector.recentEvents.length === 0 ? (
                <div className="text-sm text-[var(--ag-text-secondary)]">
                  No connector events have been synchronized yet.
                </div>
              ) : (
                <div className="space-y-2">
                  {selectedConnector.recentEvents.map((event) => (
                    <div
                      className="flex items-center justify-between gap-3 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-card)] px-4 py-3"
                      key={event.eventId}
                    >
                      <div>
                        <div className="text-sm font-medium">{event.type}</div>
                        <div className="text-xs text-[var(--ag-text-secondary)]">{event.eventId}</div>
                      </div>
                      <div className="text-xs text-[var(--ag-text-secondary)]">
                        {formatRelativeTimestamp(event.occurredAt)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        ) : (
          fallbackConnectorSummary("Select a connector to inspect its health, commands, and provider identity.")
        )}
      </div>

      {toast ? (
        <ToastViewport>
          <ToastCard
            className={
              toast.tone === "success"
                ? "border-[color:rgb(34_197_94_/_0.28)]"
                : toast.tone === "warning"
                  ? "border-[color:rgb(245_158_11_/_0.28)]"
                  : "border-[color:rgb(239_68_68_/_0.28)]"
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
