import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils/cn";

export function ModalFrame({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode }): JSX.Element {
  return (
    <div
      className="fixed inset-0 z-[var(--ag-z-modal)] hidden items-center justify-center bg-black/60 p-6 data-[open=true]:flex"
      data-open="false"
    >
      <div
        aria-modal="true"
        className={cn(
          "w-full max-w-[560px] rounded-[var(--ag-radius-xl)] border border-[var(--ag-border-default)] bg-[var(--ag-bg-card)] p-6 shadow-[var(--ag-shadow-xl)]",
          className,
        )}
        role="dialog"
        {...props}
      >
        {children}
      </div>
    </div>
  );
}
