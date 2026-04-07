import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils/cn";

export function TabList({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex min-h-10 items-end gap-6 overflow-x-auto border-b border-[var(--ag-border-subtle)]",
        className,
      )}
      role="tablist"
      {...props}
    />
  );
}

export function TabTrigger({
  active = false,
  className,
  ...props
}: HTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      className={cn(
        "ag-focus-ring border-b-2 px-0 pb-3 pt-2 text-[14px] font-medium transition-colors",
        active
          ? "border-[var(--ag-color-brand)] text-[var(--ag-text-primary)]"
          : "border-transparent text-[var(--ag-text-secondary)] hover:text-[var(--ag-text-primary)]",
        className,
      )}
      role="tab"
      type="button"
      {...props}
    />
  );
}
