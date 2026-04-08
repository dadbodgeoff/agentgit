import type { HTMLAttributes, TableHTMLAttributes } from "react";

import { cn } from "@/lib/utils/cn";

export function TableRoot({ className, ...props }: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-x-auto rounded-[var(--ag-radius-lg)] border border-[var(--ag-border-subtle)]">
      <table className={cn("min-w-full border-collapse", className)} {...props} />
    </div>
  );
}

export function TableHead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("bg-[var(--ag-bg-elevated)] text-[var(--ag-text-secondary)]", className)} {...props} />;
}

export function TableBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("bg-[var(--ag-bg-base)]", className)} {...props} />;
}

export function TableRow({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("border-t border-[var(--ag-border-subtle)]", className)} {...props} />;
}

export function TableCell({ className, ...props }: HTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("px-4 py-3 text-[13px] text-[var(--ag-text-primary)]", className)} {...props} />;
}

export function TableHeaderCell({ className, ...props }: HTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn("px-4 py-3 text-left text-[12px] font-semibold uppercase tracking-[0.06em]", className)}
      {...props}
    />
  );
}
