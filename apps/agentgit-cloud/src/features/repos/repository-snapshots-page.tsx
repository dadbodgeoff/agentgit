"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { MetricCard, PageHeader } from "@/components/composites";
import { LoadingSkeleton, PageStatePanel, StaleIndicator } from "@/components/feedback";
import { useLiveUpdateStatus } from "@/components/providers/live-update-context";
import {
  Badge,
  Button,
  Card,
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
import { executeSnapshotRestore, previewSnapshotRestore } from "@/lib/api/endpoints/repositories";
import { useWorkspace } from "@/lib/auth/workspace-context";
import { actionDetailRoute, repositoryRoute, runDetailRoute } from "@/lib/navigation/routes";
import { useRepositorySnapshotsQuery } from "@/lib/query/hooks";
import { queryKeys } from "@/lib/query/keys";
import { hasAtLeastRole } from "@/lib/rbac/roles";
import type {
  PreviewState,
  RepositorySnapshotListItem,
  SnapshotRestoreExecutionResult,
  SnapshotRestorePreview,
} from "@/schemas/cloud";
import { formatAbsoluteDate, formatConfidence, formatNumber, formatRelativeTimestamp } from "@/lib/utils/format";

type SnapshotToast = {
  message: string;
  tone: "success" | "warning" | "error";
};

function SnapshotPageSkeleton() {
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(340px,0.95fr)]">
      <Card className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <LoadingSkeleton className="w-48" />
          <LoadingSkeleton className="w-24" />
        </div>
        <LoadingSkeleton className="w-full" lines={8} />
      </Card>
      <Card className="space-y-4">
        <LoadingSkeleton className="w-44" />
        <LoadingSkeleton className="w-full" lines={10} />
      </Card>
    </div>
  );
}

function integrityTone(status: RepositorySnapshotListItem["integrityStatus"]): "success" | "warning" {
  return status === "verified" ? "success" : "warning";
}

function restoreTone(snapshot: RepositorySnapshotListItem): "accent" | "warning" | "neutral" {
  if (snapshot.latestRecovery?.outcome === "compensated") {
    return "warning";
  }

  return snapshot.latestRecovery ? "accent" : "neutral";
}

function restoreCommandDisplayState(snapshot: RepositorySnapshotListItem): string | null {
  if (!snapshot.latestRestoreCommandStatus) {
    return null;
  }

  if (snapshot.latestRestoreCommandStatus === "acked") {
    return "running";
  }

  if (snapshot.latestRestoreCommandStatus === "pending") {
    return "queued";
  }

  return snapshot.latestRestoreCommandStatus;
}

export function RepositorySnapshotsPage({
  owner,
  name,
  previewState = "ready",
}: {
  owner: string;
  name: string;
  previewState?: PreviewState;
}) {
  const queryClient = useQueryClient();
  const { activeWorkspace } = useWorkspace();
  const liveUpdateStatus = useLiveUpdateStatus();
  const snapshotsQuery = useRepositorySnapshotsQuery(owner, name, previewState);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const [restorePreview, setRestorePreview] = useState<SnapshotRestorePreview | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [toast, setToast] = useState<SnapshotToast | null>(null);
  const canRestore = hasAtLeastRole(activeWorkspace.role, "admin");
  const liveLabel =
    liveUpdateStatus.lastInvalidatedAt && liveUpdateStatus.invalidationCount > 0
      ? `live ${formatRelativeTimestamp(liveUpdateStatus.lastInvalidatedAt)}`
      : liveUpdateStatus.state === "connected"
        ? "live updates active"
        : liveUpdateStatus.state === "degraded"
          ? "updates delayed"
          : "connecting live updates";
  const snapshots = snapshotsQuery.data;
  const items = snapshots?.items ?? [];
  const selectedSnapshot = items.find((snapshot) => snapshot.snapshotId === selectedSnapshotId) ?? items[0] ?? null;
  const activePreview =
    selectedSnapshot && restorePreview?.snapshotId === selectedSnapshot.snapshotId ? restorePreview : null;

  useEffect(() => {
    if (!selectedSnapshotId && items[0]) {
      setSelectedSnapshotId(items[0].snapshotId);
      return;
    }

    if (selectedSnapshotId && !items.some((item) => item.snapshotId === selectedSnapshotId)) {
      setSelectedSnapshotId(items[0]?.snapshotId ?? null);
    }
  }, [items, selectedSnapshotId]);

  useEffect(() => {
    setPanelError(null);
    setRestorePreview((current) => (current?.snapshotId === selectedSnapshotId ? current : null));
  }, [selectedSnapshotId]);

  useEffect(() => {
    if (!toast) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setToast(null);
    }, 4000);

    return () => window.clearTimeout(timeout);
  }, [toast]);

  const previewMutation = useMutation({
    mutationFn: (snapshotId: string) => previewSnapshotRestore(owner, name, snapshotId),
    onSuccess: (result) => {
      setPanelError(null);
      setRestorePreview(result);
    },
    onError: (error) => {
      const message = getApiErrorMessage(error, "Could not plan snapshot recovery. Try again.");
      setPanelError(message);
      setToast({
        tone: "error",
        message,
      });
    },
  });

  const restoreMutation = useMutation({
    mutationFn: (snapshotId: string) => executeSnapshotRestore(owner, name, snapshotId),
    onSuccess: (result: SnapshotRestoreExecutionResult) => {
      setPanelError(null);
      if ("plan" in result) {
        setRestorePreview({
          snapshotId: result.snapshotId,
          plan: result.plan,
        });
        setToast({
          tone: result.outcome === "compensated" ? "warning" : "success",
          message: result.message,
        });
      } else {
        setToast({
          tone: "success",
          message: result.message,
        });
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.repositorySnapshots(owner, name) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.repository(owner, name) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs(owner, name) });
    },
    onError: (error) => {
      const message = getApiErrorMessage(error, "Could not restore snapshot. Try again.");
      setPanelError(message);
      setToast({
        tone: "error",
        message,
      });
    },
  });

  const latestRestoreLabel = useMemo(() => {
    const restored = items
      .filter((snapshot) => snapshot.latestRecovery)
      .sort((left, right) => {
        const leftDate = left.latestRecovery ? new Date(left.latestRecovery.executedAt).getTime() : 0;
        const rightDate = right.latestRecovery ? new Date(right.latestRecovery.executedAt).getTime() : 0;
        return rightDate - leftDate;
      })[0];

    return restored?.latestRecovery ? formatRelativeTimestamp(restored.latestRecovery.executedAt) : "none yet";
  }, [items]);

  if (snapshotsQuery.isPending) {
    return (
      <>
        <PageHeader
          actions={
            <StaleIndicator label={liveLabel} tone={liveUpdateStatus.state === "degraded" ? "warning" : "success"} />
          }
          description={`Restore boundaries and recovery history for governed activity in ${owner}/${name}.`}
          title="Snapshots"
        />
        <div className="grid gap-6 md:grid-cols-3">
          <MetricCard label="Snapshots tracked" value="--" />
          <MetricCard label="Restorable now" value="--" />
          <MetricCard label="Latest restore" value="--" />
        </div>
        <SnapshotPageSkeleton />
      </>
    );
  }

  if (snapshotsQuery.isError) {
    return (
      <>
        <PageHeader
          actions={
            <StaleIndicator label={liveLabel} tone={liveUpdateStatus.state === "degraded" ? "warning" : "success"} />
          }
          description={`Restore boundaries and recovery history for governed activity in ${owner}/${name}.`}
          title="Snapshots"
        />
        <PageStatePanel
          errorMessage={getApiErrorMessage(snapshotsQuery.error, "Could not load repository snapshots. Retry.")}
          state="error"
        />
      </>
    );
  }

  if (!snapshots || items.length === 0) {
    return (
      <>
        <PageHeader
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <StaleIndicator label={liveLabel} tone={liveUpdateStatus.state === "degraded" ? "warning" : "success"} />
              <Badge tone={snapshots?.authorityReachable ? "accent" : "warning"}>
                {snapshots?.authorityReachable ? "Authority reachable" : "Authority offline"}
              </Badge>
            </div>
          }
          description={`Restore boundaries and recovery history for governed activity in ${owner}/${name}.`}
          title="Snapshots"
        />
        <div className="grid gap-6 md:grid-cols-3">
          <MetricCard label="Snapshots tracked" value="0" trend="no boundaries captured" />
          <MetricCard label="Restorable now" value="0" trend="manifest-backed points" />
          <MetricCard label="Latest restore" value="none" trend="history appears here" />
        </div>
        <PageStatePanel
          emptyDescription="Snapshots appear after governed actions capture restore boundaries or explicit checkpoints."
          emptyTitle="No snapshots recorded"
          state="empty"
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StaleIndicator label={liveLabel} tone={liveUpdateStatus.state === "degraded" ? "warning" : "success"} />
            <Badge tone={snapshots.authorityReachable ? "accent" : "warning"}>
              {snapshots.authorityReachable ? "Authority reachable" : "Authority offline"}
            </Badge>
          </div>
        }
        description={`Restore boundaries and recovery history for governed activity in ${owner}/${name}.`}
        title="Snapshots"
      />
      <div className="grid gap-6 md:grid-cols-3">
        <MetricCard label="Snapshots tracked" value={String(snapshots.total)} trend={`${items.length} listed`} />
        <MetricCard label="Restorable now" value={String(snapshots.restorableCount)} trend="manifest-backed points" />
        <MetricCard label="Latest restore" value={latestRestoreLabel} trend={`${snapshots.restoredCount} executed`} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(340px,0.95fr)]">
        <Card className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Snapshot inventory</h2>
              <p className="mt-1 text-sm text-[var(--ag-text-secondary)]">
                Governed restore points captured for this repository.
              </p>
            </div>
            <Link
              className="ag-focus-ring inline-flex h-9 items-center justify-center rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] px-3 text-sm font-medium text-[var(--ag-text-primary)] transition-colors hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-hover)]"
              href={repositoryRoute(owner, name)}
            >
              Repository detail
            </Link>
          </div>
          <div className="text-sm text-[var(--ag-text-secondary)]">
            Showing {items.length} of {snapshots.total} snapshots loaded for recovery review.
          </div>

          <TableRoot>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Snapshot</TableHeaderCell>
                <TableHeaderCell>Action</TableHeaderCell>
                <TableHeaderCell>Integrity</TableHeaderCell>
                <TableHeaderCell>Created</TableHeaderCell>
                <TableHeaderCell>Restore</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((snapshot) => {
                const selected = selectedSnapshot?.snapshotId === snapshot.snapshotId;

                return (
                  <TableRow key={snapshot.snapshotId}>
                    <TableCell>
                      <button
                        className="ag-focus-ring rounded-sm text-left"
                        onClick={() => setSelectedSnapshotId(snapshot.snapshotId)}
                        type="button"
                      >
                        <div className="font-medium text-[var(--ag-text-primary)]">{snapshot.snapshotId}</div>
                        <div className="mt-1 text-xs text-[var(--ag-text-secondary)]">
                          {snapshot.snapshotClass} / {snapshot.fidelity}
                        </div>
                        {selected ? (
                          <div className="mt-2 text-xs uppercase tracking-[0.06em] text-[var(--ag-color-brand)]">
                            Selected
                          </div>
                        ) : null}
                      </button>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        <div className="font-medium">{snapshot.actionSummary}</div>
                        <div className="text-xs text-[var(--ag-text-secondary)]">{snapshot.targetLocator}</div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge tone={integrityTone(snapshot.integrityStatus)}>{snapshot.integrityStatus}</Badge>
                    </TableCell>
                    <TableCell className="text-[var(--ag-text-secondary)]">
                      {formatRelativeTimestamp(snapshot.createdAt)}
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        <Badge tone={restoreTone(snapshot)}>
                          {snapshot.latestRecovery
                            ? `${snapshot.latestRecovery.outcome} ${formatRelativeTimestamp(snapshot.latestRecovery.executedAt)}`
                            : "Not restored"}
                        </Badge>
                        {restoreCommandDisplayState(snapshot) ? (
                          <div className="text-xs text-[var(--ag-text-secondary)]">
                            {restoreCommandDisplayState(snapshot)}
                          </div>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </TableRoot>
          {snapshotsQuery.hasNextPage ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--ag-border-subtle)] pt-4">
              <p className="text-sm text-[var(--ag-text-secondary)]">
                Load older snapshot boundaries and restore history.
              </p>
              <Button
                disabled={snapshotsQuery.isFetchingNextPage}
                onClick={() => void snapshotsQuery.fetchNextPage()}
                variant="secondary"
              >
                {snapshotsQuery.isFetchingNextPage ? "Loading..." : "Load more"}
              </Button>
            </div>
          ) : null}
        </Card>

        <Card className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Restore detail</h2>
            {selectedSnapshot ? (
              <Badge tone={integrityTone(selectedSnapshot.integrityStatus)}>{selectedSnapshot.integrityStatus}</Badge>
            ) : null}
          </div>

          {selectedSnapshot ? (
            <div className="space-y-4">
              <div className="space-y-3 text-sm">
                <div>
                  <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-tertiary)]">Workflow</div>
                  <div className="mt-1 font-medium">{selectedSnapshot.workflowName}</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-tertiary)]">Action</div>
                  <div className="mt-1 font-medium">{selectedSnapshot.actionSummary}</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-tertiary)]">Target</div>
                  <div className="mt-1 font-mono text-xs text-[var(--ag-text-secondary)]">
                    {selectedSnapshot.targetLocator}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-tertiary)]">Captured</div>
                  <div className="mt-1 font-medium">
                    {formatAbsoluteDate(selectedSnapshot.createdAt)} ·{" "}
                    {formatRelativeTimestamp(selectedSnapshot.createdAt)}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-tertiary)]">Scope</div>
                  <div className="mt-1 space-y-1">
                    {selectedSnapshot.scopePaths.map((scopePath) => (
                      <div className="font-mono text-xs text-[var(--ag-text-secondary)]" key={scopePath}>
                        {scopePath}
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-tertiary)]">Linked run</div>
                  <Link
                    className="mt-1 inline-flex text-sm font-medium text-[var(--ag-color-brand)] underline-offset-4 hover:underline"
                    href={runDetailRoute(owner, name, selectedSnapshot.runId)}
                  >
                    Open run {selectedSnapshot.runId}
                  </Link>
                </div>
              </div>

              {selectedSnapshot.latestRecovery ? (
                <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3">
                  <div className="text-sm font-medium text-[var(--ag-text-primary)]">Latest recovery</div>
                  <div className="mt-2 text-sm text-[var(--ag-text-secondary)]">
                    {selectedSnapshot.latestRecovery.outcome} via {selectedSnapshot.latestRecovery.strategy}
                  </div>
                  <div className="mt-1 text-xs text-[var(--ag-text-tertiary)]">
                    {formatAbsoluteDate(selectedSnapshot.latestRecovery.executedAt)} ·{" "}
                    {selectedSnapshot.latestRecovery.recoveryClass}
                  </div>
                </div>
              ) : null}

              {selectedSnapshot.latestRestoreCommandId ? (
                <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3">
                  <div className="text-sm font-medium text-[var(--ag-text-primary)]">Latest restore command</div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Badge
                      tone={
                        selectedSnapshot.latestRestoreCommandStatus === "completed"
                          ? "success"
                          : selectedSnapshot.latestRestoreCommandStatus === "failed" ||
                              selectedSnapshot.latestRestoreCommandStatus === "expired"
                            ? "warning"
                            : "accent"
                      }
                    >
                      {restoreCommandDisplayState(selectedSnapshot) ?? "unknown"}
                    </Badge>
                    <span className="font-mono text-xs text-[var(--ag-text-secondary)]">
                      {selectedSnapshot.latestRestoreCommandId}
                    </span>
                  </div>
                  {selectedSnapshot.latestRestoreCommandUpdatedAt ? (
                    <div className="mt-1 text-xs text-[var(--ag-text-tertiary)]">
                      {formatAbsoluteDate(selectedSnapshot.latestRestoreCommandUpdatedAt)} ·{" "}
                      {formatRelativeTimestamp(selectedSnapshot.latestRestoreCommandUpdatedAt)}
                    </div>
                  ) : null}
                  {selectedSnapshot.latestRestoreCommandMessage ? (
                    <div className="mt-1 text-xs text-[var(--ag-text-secondary)]">
                      {selectedSnapshot.latestRestoreCommandMessage}
                    </div>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {selectedSnapshot.latestRestoreRunId ? (
                      <Link
                        className="ag-focus-ring inline-flex h-8 items-center justify-center rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] px-3 text-[13px] font-medium text-[var(--ag-text-primary)] transition-colors duration-[var(--ag-duration-fast)] hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-hover)]"
                        href={runDetailRoute(owner, name, selectedSnapshot.latestRestoreRunId)}
                      >
                        Open restored run
                      </Link>
                    ) : null}
                    {selectedSnapshot.latestRestoreRunId && selectedSnapshot.latestRestoreActionId ? (
                      <Link
                        className="ag-focus-ring inline-flex h-8 items-center justify-center rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] px-3 text-[13px] font-medium text-[var(--ag-text-primary)] transition-colors duration-[var(--ag-duration-fast)] hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-hover)]"
                        href={actionDetailRoute(
                          owner,
                          name,
                          selectedSnapshot.latestRestoreRunId,
                          selectedSnapshot.latestRestoreActionId,
                        )}
                      >
                        Open restored action
                      </Link>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {canRestore ? (
                <div className="space-y-3 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-4">
                  <div>
                    <div className="text-sm font-medium text-[var(--ag-text-primary)]">Admin restore controls</div>
                    <div className="mt-1 text-sm text-[var(--ag-text-secondary)]">
                      Preview the recovery plan before queueing a governed restore onto the local connector.
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <Button
                      disabled={
                        !snapshots.authorityReachable ||
                        selectedSnapshot.integrityStatus !== "verified" ||
                        previewMutation.isPending ||
                        restoreMutation.isPending
                      }
                      onClick={() => {
                        setPanelError(null);
                        setRestorePreview(null);
                        previewMutation.mutate(selectedSnapshot.snapshotId);
                      }}
                      variant="secondary"
                    >
                      {previewMutation.isPending && activePreview === null ? "Planning..." : "Preview restore"}
                    </Button>
                    <Button
                      disabled={
                        !snapshots.authorityReachable ||
                        selectedSnapshot.integrityStatus !== "verified" ||
                        !activePreview ||
                        restoreMutation.isPending
                      }
                      onClick={() => {
                        setPanelError(null);
                        restoreMutation.mutate(selectedSnapshot.snapshotId);
                      }}
                    >
                      {restoreMutation.isPending ? "Queueing restore..." : "Execute restore"}
                    </Button>
                  </div>
                  {!snapshots.authorityReachable ? (
                    <div className="text-sm text-[var(--ag-status-warning)]">
                      The authority daemon is offline, so restore planning and connector execution are temporarily
                      unavailable.
                    </div>
                  ) : null}
                  {selectedSnapshot.integrityStatus !== "verified" ? (
                    <div className="text-sm text-[var(--ag-status-warning)]">
                      This snapshot no longer has a verifiable manifest, so it cannot be restored safely.
                    </div>
                  ) : null}
                  {panelError ? <div className="text-sm text-[var(--ag-status-danger)]">{panelError}</div> : null}
                </div>
              ) : (
                <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3 text-sm text-[var(--ag-text-secondary)]">
                  Admins and owners can preview and execute restores from this panel.
                </div>
              )}

              {activePreview ? (
                <div className="space-y-3 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-medium text-[var(--ag-text-primary)]">Recovery plan</div>
                    <Badge tone="accent">{activePreview.plan.recovery_class}</Badge>
                  </div>
                  <div className="text-sm text-[var(--ag-text-secondary)]">{activePreview.plan.strategy}</div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div>
                      <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-tertiary)]">
                        Confidence
                      </div>
                      <div className="mt-1 font-medium">{formatConfidence(activePreview.plan.confidence)}</div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-tertiary)]">
                        Paths to change
                      </div>
                      <div className="mt-1 font-medium">
                        {formatNumber(activePreview.plan.impact_preview.paths_to_change ?? 0)}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-tertiary)]">
                        Later actions affected
                      </div>
                      <div className="mt-1 font-medium">
                        {formatNumber(activePreview.plan.impact_preview.later_actions_affected)}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-tertiary)]">
                        Data loss risk
                      </div>
                      <div className="mt-1 font-medium capitalize">
                        {activePreview.plan.impact_preview.data_loss_risk}
                      </div>
                    </div>
                  </div>
                  {activePreview.plan.warnings.length > 0 ? (
                    <div className="space-y-2">
                      <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-tertiary)]">Warnings</div>
                      {activePreview.plan.warnings.map((warning) => (
                        <div
                          className="text-sm text-[var(--ag-status-warning)]"
                          key={`${warning.code}:${warning.message}`}
                        >
                          {warning.code}: {warning.message}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : (
            <PageStatePanel
              emptyDescription="Select a snapshot to inspect its restore metadata."
              emptyTitle="No snapshot selected"
              state="empty"
            />
          )}
        </Card>
      </div>

      {toast ? (
        <ToastViewport>
          <ToastCard
            className={
              toast.tone === "warning"
                ? "border-[color:rgb(245_158_11_/_0.28)]"
                : "border-[color:rgb(34_197_94_/_0.28)]"
            }
          >
            {toast.message}
          </ToastCard>
        </ToastViewport>
      ) : null}
    </>
  );
}
