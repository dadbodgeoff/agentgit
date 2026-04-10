import type { HTMLAttributes } from "react";

import { X } from "lucide-react";

import { Button } from "@/components/primitives/button";
import { useOptionalToast, useToast, type AppToast } from "@/components/providers/toast-provider";
import { cn } from "@/lib/utils/cn";

function toneBorderClass(tone: AppToast["tone"]) {
  switch (tone) {
    case "success":
      return "border-[color:rgb(34_197_94_/_0.28)]";
    case "warning":
      return "border-[color:rgb(245_158_11_/_0.28)]";
    case "error":
      return "border-[color:rgb(239_68_68_/_0.28)]";
    default:
      return "border-[color:rgb(59_130_246_/_0.28)]";
  }
}

function ManagedToast({ toast }: { toast: AppToast }) {
  const { dismissToast } = useToast();

  return (
    <ToastCard className={cn("pointer-events-auto", toneBorderClass(toast.tone))}>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="ag-text-body-sm font-semibold text-[var(--ag-text-primary)]">{toast.title}</div>
          {toast.description ? <p className="ag-text-body-sm text-[var(--ag-text-secondary)]">{toast.description}</p> : null}
          {toast.actionLabel && toast.onAction ? (
            <button
              className="ag-focus-ring ag-text-body-sm font-medium text-[var(--ag-color-brand)]"
              onClick={() => {
                toast.onAction?.();
                dismissToast(toast.id);
              }}
              type="button"
            >
              {toast.actionLabel}
            </button>
          ) : null}
        </div>
        <Button aria-label="Dismiss toast" onClick={() => dismissToast(toast.id)} size="sm" variant="ghost">
          <X aria-hidden="true" className="size-4" strokeWidth={1.75} />
        </Button>
      </div>
    </ToastCard>
  );
}

export function ToastViewport({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const toastContext = useOptionalToast();

  return (
    <div
      className={cn(
        "pointer-events-none fixed inset-x-4 top-4 z-[var(--ag-z-toast)] flex flex-col gap-2 md:inset-x-auto md:right-6 md:top-auto md:bottom-6 md:w-[360px]",
        className,
      )}
      {...props}
    >
      {toastContext?.toasts.map((toast) => <ManagedToast key={toast.id} toast={toast} />)}
      {children}
    </div>
  );
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
