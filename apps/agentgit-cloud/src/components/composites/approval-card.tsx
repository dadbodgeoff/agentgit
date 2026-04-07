import type { KeyboardEvent } from "react";

import { Badge, Button, Card } from "@/components/primitives";
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
        item.status === "pending" ? "border-l-2 border-l-[var(--ag-color-accent)]" : "border-l-2 border-l-[var(--ag-border-default)]",
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
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--ag-text-secondary)]">
          <span>{formatRelativeTimestamp(item.requestedAt)}</span>
          <span className="font-mono">{item.runId}</span>
          <span>{item.snapshotRequired ? "snapshot required" : "no snapshot required"}</span>
        </div>
        <p className="text-sm text-[var(--ag-text-secondary)]">{item.actionSummary}</p>
        <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-hover)] px-3 py-2 text-sm text-[var(--ag-text-secondary)]">
          <div className="font-mono text-xs text-[var(--ag-text-tertiary)]">Target</div>
          <div className="mt-1">{item.targetLabel ?? item.targetLocator}</div>
        </div>
        {item.reasonSummary ? <p className="text-sm text-[var(--ag-text-secondary)]">{item.reasonSummary}</p> : null}
        <div className="flex flex-wrap items-center gap-2">
          {item.status === "pending" ? (
            <>
              <Button
                disabled={isBusy}
                onClick={(event) => {
                  event.stopPropagation();
                  onApprove?.();
                }}
                variant="accent"
              >
                {isBusy ? "Submitting..." : "Approve"}
              </Button>
              <Button
                disabled={isBusy}
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
