"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import { cn } from "@/lib/utils/cn";

function formatSince(updatedAt: Date): string {
  const diffMs = Date.now() - updatedAt.getTime();
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Shows "Last updated Xm ago" with a refresh button. Auto-updates every 30s. */
export function StaleIndicator({
  label,
  lastUpdatedAt,
  onRefresh,
  isRefreshing = false,
  tone = "neutral",
}: {
  label?: string;
  lastUpdatedAt?: string | number | Date | null;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  tone?: "neutral" | "success" | "warning";
}) {
  // Tick every 30s so the relative timestamp stays fresh
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!lastUpdatedAt) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 30000);
    return () => window.clearInterval(id);
  }, [lastUpdatedAt]);

  // Legacy label-only mode for backward compatibility
  if (label && !lastUpdatedAt) {
    const toneClassName =
      tone === "success"
        ? "border-[color:rgb(16_185_129_/_0.25)] text-[var(--ag-color-success)]"
        : tone === "warning"
          ? "border-[color:rgb(245_158_11_/_0.25)] text-[var(--ag-color-warning)]"
          : "border-[var(--ag-border-default)] text-[var(--ag-text-secondary)]";

    return (
      <span className={cn("inline-flex items-center rounded-full border px-2 py-1 text-[12px]", toneClassName)}>
        {label}
      </span>
    );
  }

  if (!lastUpdatedAt) return null;

  const updatedDate =
    lastUpdatedAt instanceof Date ? lastUpdatedAt : new Date(lastUpdatedAt);
  if (Number.isNaN(updatedDate.getTime())) return null;

  return (
    <div className="inline-flex items-center gap-2 text-[12px] text-[var(--ag-text-tertiary)]">
      <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--ag-color-success)]" />
      <span>Updated {formatSince(updatedDate)}</span>
      {onRefresh ? (
        <button
          aria-label="Refresh data"
          className="ag-focus-ring inline-flex h-6 w-6 items-center justify-center rounded-[var(--ag-radius-sm)] text-[var(--ag-text-tertiary)] transition-colors hover:bg-[var(--ag-bg-hover)] hover:text-[var(--ag-text-primary)] disabled:cursor-not-allowed"
          disabled={isRefreshing}
          onClick={onRefresh}
          type="button"
        >
          <RefreshCw
            className={isRefreshing ? "animate-spin" : undefined}
            size={13}
            strokeWidth={1.5}
          />
        </button>
      ) : null}
    </div>
  );
}
