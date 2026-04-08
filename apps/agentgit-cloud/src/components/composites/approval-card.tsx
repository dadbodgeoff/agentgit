import Link from "next/link";
import type { KeyboardEvent } from "react";

import { Badge, Button, Card } from "@/components/primitives";
import { actionDetailRoute, repositoryRoute, runDetailRoute } from "@/lib/navigation/routes";
import { cn } from "@/lib/utils/cn";
import type { ApprovalListItem } from "@/schemas/cloud";
import { formatRelativeTimestamp } from "@/lib/utils/format";

function getApprovalTone(status: ApprovalListItem["status"]): "warning" | "success" | "error" | "neutral" {
  if (status === "approved") {
    return "success";
  }
  if (status === "rejected") {
    return "error";
  }
  if (status === "pending") {
    return "warning";
  }
  return "neutral";
}

function getConnectorTone(status: ApprovalListItem["connectorStatus"]): "success" | "warning" | "error" | "neutral" {
  if (status === "active") {
    return "success";
  }

  if (status === "stale") {
    return "warning";
  }

  if (status === "revoked") {
    return "error";
  }

  return "neutral";
}

function getDeliveryTone(
  status: ApprovalListItem["decisionCommandStatus"],
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

export function ApprovalCard({
  errorMessage,
  isBusy = false,
  isSelected = false,
  item,
  onApprove,
  onReject,
  onSelect,
}: {
  errorMessage?: string;
  isBusy?: boolean;
  isSelected?: boolean;
  item: ApprovalListItem;
  onApprove?: () => void;
  onReject?: () => void;
  onSelect?: () => void;
}) {
  const repositoryHref =
    item.repositoryOwner && item.repositoryName ? repositoryRoute(item.repositoryOwner, item.repositoryName) : null;
  const runHref =
    item.repositoryOwner && item.repositoryName
      ? runDetailRoute(item.repositoryOwner, item.repositoryName, item.runId)
      : null;
  const actionHref =
    item.repositoryOwner && item.repositoryName
      ? actionDetailRoute(item.repositoryOwner, item.repositoryName, item.runId, item.actionId)
      : null;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect?.();
    }
  }

  return (
    <Card
      className={cn(
        "flex cursor-pointer flex-col gap-4 border transition-colors duration-[var(--ag-duration-fast)]",
        isSelected
          ? "border-[var(--ag-color-brand)] bg-[var(--ag-bg-elevated)] shadow-[var(--ag-shadow-md)]"
          : "border-[var(--ag-border-subtle)] hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-elevated)]",
        item.status === "pending"
          ? "border-l-2 border-l-[var(--ag-color-accent)]"
          : "border-l-2 border-l-[var(--ag-border-default)]",
      )}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold">{item.workflowName}</h2>
          <Badge tone={getApprovalTone(item.status)}>{item.status}</Badge>
          <Badge>{item.domain}</Badge>
          <Badge>{item.sideEffectLevel.replaceAll("_", " ")}</Badge>
          {item.expiresSoon && item.status === "pending" ? <Badge tone="warning">expiring soon</Badge> : null}
          {item.connectorStatus !== "active" ? (
            <Badge tone={getConnectorTone(item.connectorStatus)}>connector {item.connectorStatus}</Badge>
          ) : null}
          {item.decisionCommandStatus && item.status === "pending" ? (
            <Badge tone={getDeliveryTone(item.decisionCommandStatus)}>delivery {item.decisionCommandStatus}</Badge>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--ag-text-secondary)]">
          <span>{formatRelativeTimestamp(item.requestedAt)}</span>
          {item.repositoryOwner && item.repositoryName ? (
            <span>
              {item.repositoryOwner}/{item.repositoryName}
            </span>
          ) : null}
          <span className="font-mono">{item.runId}</span>
          <span>{item.snapshotRequired ? "snapshot required" : "no snapshot required"}</span>
        </div>
        <p className="text-sm text-[var(--ag-text-secondary)]">{item.actionSummary}</p>
        <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-hover)] px-3 py-2 text-sm text-[var(--ag-text-secondary)]">
          <div className="font-mono text-xs text-[var(--ag-text-tertiary)]">Target</div>
          <div className="mt-1">{item.targetLabel ?? item.targetLocator}</div>
        </div>
        {item.reasonSummary ? <p className="text-sm text-[var(--ag-text-secondary)]">{item.reasonSummary}</p> : null}
        {item.connectorStatusReason ? (
          <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-hover)] px-3 py-2 text-sm text-[var(--ag-text-secondary)]">
            {item.connectorStatusReason}
          </div>
        ) : null}
        {item.decisionCommandMessage ? (
          <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-hover)] px-3 py-2 text-sm text-[var(--ag-text-secondary)]">
            {item.decisionCommandMessage}
            {item.decisionCommandNextAttemptAt
              ? ` Retry ${formatRelativeTimestamp(item.decisionCommandNextAttemptAt)}.`
              : ""}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {item.status === "pending" ? (
            <>
              <Button
                disabled={isBusy || item.connectorStatus !== "active"}
                onClick={(event) => {
                  event.stopPropagation();
                  onApprove?.();
                }}
                variant="accent"
              >
                {isBusy ? "Submitting..." : "Approve"}
              </Button>
              <Button
                disabled={isBusy || item.connectorStatus !== "active"}
                onClick={(event) => {
                  event.stopPropagation();
                  onReject?.();
                }}
                variant="destructive"
              >
                Reject
              </Button>
            </>
          ) : null}
          <Button
            onClick={(event) => {
              event.stopPropagation();
              onSelect?.();
            }}
            variant="secondary"
          >
            Review details
          </Button>
          {repositoryHref ? (
            <Link
              className="ag-focus-ring rounded-[var(--ag-radius-md)] px-2 py-1 text-xs font-medium text-[var(--ag-text-secondary)] underline-offset-4 hover:text-[var(--ag-color-brand)] hover:underline"
              href={repositoryHref}
              onClick={(event) => event.stopPropagation()}
            >
              Open repo
            </Link>
          ) : null}
          {runHref ? (
            <Link
              className="ag-focus-ring rounded-[var(--ag-radius-md)] px-2 py-1 text-xs font-medium text-[var(--ag-text-secondary)] underline-offset-4 hover:text-[var(--ag-color-brand)] hover:underline"
              href={runHref}
              onClick={(event) => event.stopPropagation()}
            >
              Open run
            </Link>
          ) : null}
          {actionHref ? (
            <Link
              className="ag-focus-ring rounded-[var(--ag-radius-md)] px-2 py-1 text-xs font-medium text-[var(--ag-text-secondary)] underline-offset-4 hover:text-[var(--ag-color-brand)] hover:underline"
              href={actionHref}
              onClick={(event) => event.stopPropagation()}
            >
              Action detail
            </Link>
          ) : null}
        </div>
        {errorMessage ? (
          <div className="rounded-[var(--ag-radius-md)] border border-[color:rgb(239_68_68_/_0.25)] bg-[var(--ag-bg-error)] px-3 py-2 text-sm text-[var(--ag-color-error)]">
            {errorMessage}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
