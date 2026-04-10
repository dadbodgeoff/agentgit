import type { HTMLAttributes, TableHTMLAttributes } from "react";

import { cn } from "@/lib/utils/cn";

export function TableRoot({ className, ...props }: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-x-auto rounded-[var(--ag-radius-lg)] border border-[var(--ag-border-subtle)] bg-[var(--ag-surface-base)]">
      <table className={cn("min-w-full border-collapse", className)} {...props} />
    </div>
  );
}

export function TableHead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead className={cn("bg-[var(--ag-surface-raised)] text-[var(--ag-text-secondary)]", className)} {...props} />
  );
}

export function TableBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("bg-[var(--ag-surface-base)]", className)} {...props} />;
}

export function TableRow({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        "border-t border-[var(--ag-border-subtle)] transition-colors duration-[var(--ag-duration-fast)] hover:bg-[var(--ag-surface-hover)]",
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: HTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("px-4 py-3 ag-text-body-sm text-[var(--ag-text-primary)]", className)} {...props} />;
}

export function TableHeaderCell({ className, ...props }: HTMLAttributes<HTMLTableCellElement>) {
  return (
    <th className={cn("px-4 py-3 text-left ag-text-overline text-[var(--ag-text-secondary)]", className)} {...props} />
  );
}
