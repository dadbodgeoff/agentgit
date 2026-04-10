"use client";

import { useId, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils/cn";

export function Tooltip({
  children,
  className,
  content,
}: {
  children: ReactNode;
  className?: string;
  content: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const tooltipId = useId();

  return (
    <span
      className={cn("relative inline-flex", className)}
      onBlur={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <span aria-describedby={open ? tooltipId : undefined}>{children}</span>
      <span
        className={cn(
          "pointer-events-none absolute left-1/2 top-full z-[var(--ag-z-tooltip)] mt-2 w-max max-w-[240px] -translate-x-1/2 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] bg-[var(--ag-surface-overlay)] px-2.5 py-2 ag-text-caption text-[var(--ag-text-primary)] shadow-[var(--ag-shadow-lg)] transition-opacity duration-[var(--ag-duration-fast)]",
          open ? "opacity-100" : "opacity-0",
        )}
        id={tooltipId}
        role="tooltip"
      >
        {content}
      </span>
    </span>
  );
}
