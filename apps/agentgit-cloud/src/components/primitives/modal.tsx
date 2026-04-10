"use client";

import { useEffect, useRef, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "@/lib/utils/cn";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const sizeClasses = {
  sm: "max-w-[400px]",
  md: "max-w-[560px]",
  lg: "max-w-[720px]",
} as const;

export interface ModalProps extends HTMLAttributes<HTMLDivElement> {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  size?: keyof typeof sizeClasses;
  preventBackdropClose?: boolean;
  titleId?: string;
}

/** Dialog overlay with focus trap, escape-to-close, and backdrop click. Sizes: sm (400px), md (560px), lg (720px). */
export function Modal({
  children,
  className,
  onClose,
  open,
  preventBackdropClose = false,
  size = "md",
  titleId,
  ...props
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Focus trap + escape handler
  useEffect(() => {
    if (!open) return;

    previousFocusRef.current = document.activeElement as HTMLElement | null;

    const dialog = dialogRef.current;
    if (!dialog) return;

    // Focus first focusable element
    const focusables = dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    focusables[0]?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key === "Tab") {
        const focusableElements = Array.from(
          dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
        ).filter((el) => !el.hasAttribute("disabled"));

        if (focusableElements.length === 0) {
          event.preventDefault();
          return;
        }

        const first = focusableElements[0];
        const last = focusableElements[focusableElements.length - 1];
        const active = document.activeElement as HTMLElement | null;

        if (event.shiftKey) {
          if (active === first || !dialog.contains(active)) {
            event.preventDefault();
            last.focus();
          }
        } else {
          if (active === last) {
            event.preventDefault();
            first.focus();
          }
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    const body = document.body;
    const previousOverflow = body.style.overflow;
    body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  const handleBackdropClick = () => {
    if (!preventBackdropClose) onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[var(--ag-z-modal)] flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className={cn(
          "w-full rounded-[var(--ag-radius-xl)] border border-[var(--ag-border-default)] bg-[var(--ag-bg-card)] p-6 shadow-[var(--ag-shadow-xl)]",
          sizeClasses[size],
          className,
        )}
        onClick={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        {...props}
      >
        {children}
      </div>
    </div>
  );
}

/** Legacy modal frame for compatibility with existing code. */
export function ModalFrame({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-[var(--ag-z-modal)] hidden items-center justify-center bg-black/60 p-6 data-[open=true]:flex"
      data-open="false"
    >
      <div
        aria-modal="true"
        className={cn(
          "w-full max-w-[560px] rounded-[var(--ag-radius-xl)] border border-[var(--ag-border-default)] bg-[var(--ag-surface-overlay)] p-6 shadow-[var(--ag-shadow-xl)]",
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
