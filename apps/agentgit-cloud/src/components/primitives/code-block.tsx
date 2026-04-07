import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils/cn";

export function CodeBlock({ className, ...props }: HTMLAttributes<HTMLPreElement>) {
  return (
    <pre
      className={cn(
        "overflow-x-auto rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] p-4 font-mono text-[13px] text-[var(--ag-text-primary)]",
        className,
      )}
      {...props}
    />
  );
}
