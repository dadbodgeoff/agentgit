import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils/cn";

export function ToastViewport({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("fixed bottom-6 right-6 z-[var(--ag-z-toast)] flex w-[360px] flex-col gap-2", className)} {...props} />;
}

export function ToastCard({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] bg-[var(--ag-bg-elevated)] p-4 shadow-[var(--ag-shadow-md)]",
        className,
      )}
      {...props}
    />
  );
}
