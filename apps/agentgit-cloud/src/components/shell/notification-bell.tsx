"use client";

import { useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";

import { cn } from "@/lib/utils/cn";

interface NotificationBellProps {
  count?: number;
}

/** Notification bell with count badge and dropdown panel. */
export function NotificationBell({ count = 0 }: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const hasCount = count > 0;
  const displayCount = count > 99 ? "99+" : String(count);

  return (
    <div className="relative" ref={containerRef}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={hasCount ? `Notifications (${count} new)` : "Notifications"}
        className="ag-focus-ring relative inline-flex h-8 w-8 items-center justify-center rounded-[var(--ag-radius-md)] text-[var(--ag-text-secondary)] transition-colors hover:bg-[var(--ag-bg-hover)] hover:text-[var(--ag-text-primary)]"
        onClick={() => setOpen((prev) => !prev)}
        type="button"
      >
        <Bell size={18} strokeWidth={1.5} />
        {hasCount ? (
          <span
            aria-hidden="true"
            className={cn(
              "absolute -top-0.5 -right-0.5 flex min-h-[16px] min-w-[16px] items-center justify-center rounded-full bg-[var(--ag-color-error)] px-1 font-mono text-[10px] font-semibold text-white",
            )}
          >
            {displayCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          className="absolute top-full right-0 mt-2 w-80 overflow-hidden rounded-[var(--ag-radius-lg)] border border-[var(--ag-border-default)] bg-[var(--ag-bg-card)] shadow-[var(--ag-shadow-lg)]"
          role="dialog"
        >
          <div className="flex items-center justify-between border-b border-[var(--ag-border-subtle)] px-4 py-3">
            <h3 className="text-[13px] font-semibold text-[var(--ag-text-primary)]">Notifications</h3>
            {hasCount ? (
              <button
                className="ag-focus-ring text-[12px] text-[var(--ag-color-brand)] hover:underline"
                type="button"
              >
                Mark all read
              </button>
            ) : null}
          </div>
          <div className="max-h-80 overflow-y-auto">
            <div className="px-4 py-8 text-center">
              <Bell className="mx-auto mb-2 text-[var(--ag-text-tertiary)]" size={24} strokeWidth={1.5} />
              <p className="text-[13px] font-medium text-[var(--ag-text-primary)]">No notifications</p>
              <p className="mt-1 text-[12px] text-[var(--ag-text-secondary)]">
                You&apos;ll be notified when approvals are requested or runs complete.
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
