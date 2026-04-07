import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils/cn";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      className={cn(
        "rounded-[var(--ag-radius-lg)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-card)] p-5 shadow-[var(--ag-shadow-sm)]",
        className,
      )}
      {...props}
    />
  );
}
