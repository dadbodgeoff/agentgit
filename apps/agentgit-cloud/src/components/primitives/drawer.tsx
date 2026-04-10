"use client";

import { useEffect, type ReactNode } from "react";

import { X } from "lucide-react";

import { Button } from "@/components/primitives/button";
import { cn } from "@/lib/utils/cn";

export function Drawer({
  actions,
  backdropCloses = true,
  children,
  className,
  description,
  onClose,
  open,
  title,
}: {
  actions?: ReactNode;
  backdropCloses?: boolean;
  children: ReactNode;
  className?: string;
  description?: string;
  onClose: () => void;
  open: boolean;
  title: string;
}) {
  useEffect(() => {
    if (!open) {
      return;
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[var(--ag-z-modal-backdrop)]">
      <button
        aria-label="Close drawer backdrop"
        className="absolute inset-0 bg-black/50"
        onClick={backdropCloses ? onClose : undefined}
        type="button"
      />
      <aside
        className={cn(
          "absolute inset-x-0 right-0 top-0 ml-auto h-full w-full max-w-[480px] border-l border-[var(--ag-border-default)] bg-[var(--ag-surface-overlay)] p-5 shadow-[var(--ag-shadow-xl)] md:inset-y-0 md:inset-x-auto",
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--ag-border-subtle)] pb-4">
          <div className="space-y-1">
            <div className="ag-text-h3 text-[var(--ag-text-primary)]">{title}</div>
            {description ? <p className="ag-text-body-sm text-[var(--ag-text-secondary)]">{description}</p> : null}
          </div>
          <Button aria-label="Close drawer" onClick={onClose} size="sm" variant="ghost">
            <X aria-hidden="true" className="size-4" strokeWidth={1.75} />
          </Button>
        </div>
        {actions ? <div className="flex items-center gap-2 border-b border-[var(--ag-border-subtle)] py-4">{actions}</div> : null}
        <div className="pt-4">{children}</div>
      </aside>
    </div>
  );
}
