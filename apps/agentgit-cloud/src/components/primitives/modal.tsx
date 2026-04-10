"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { X } from "lucide-react";

import { Button } from "@/components/primitives/button";
import { Input } from "@/components/primitives/input";
import { cn } from "@/lib/utils/cn";

/**
 * Modal primitive.
 *
 * Implements Product Design System §1.7 + §3.9 + §13.7:
 *   - 400 / 560 / 720 px width per `size` (confirm / default / wide)
 *   - 80vh max-height with internal scroll
 *   - role="dialog", aria-modal="true", aria-labelledby + aria-describedby
 *   - Focus is trapped inside the panel; Tab and Shift+Tab cycle through
 *     focusable descendants
 *   - First focusable element receives focus on open (or `initialFocusId`
 *     if supplied)
 *   - On close, focus is returned to whichever element opened it
 *   - Escape closes the modal unless `dismissible=false`
 *   - Backdrop click closes the modal unless `backdropCloses=false`
 *     (set false for form modals so unsaved data isn't lost)
 *
 * Animation: enters with fade + scale per spec §1.7. Exit animation is
 * skipped (component unmounts immediately on close) — adding a
 * state-machine for graceful exit is tracked as P2 polish.
 *
 * Reduced motion: the entrance transition is wrapped in
 * `motion-safe:` so it disables under prefers-reduced-motion.
 */

export type ModalSize = "confirm" | "default" | "wide";

const SIZE_CLASSES: Record<ModalSize, string> = {
  confirm: "max-w-[400px]",
  default: "max-w-[560px]",
  wide: "max-w-[720px]",
};

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(",");

export interface ModalProps {
  /**
   * Optional secondary action row rendered in the footer area.
   * Use this for primary/secondary buttons rather than placing them
   * inside `children` so the spec footer treatment stays consistent.
   */
  actions?: ReactNode;
  /**
   * If false, clicking the backdrop does not dismiss the modal.
   * Spec §3.9 — set false for any form modal so unsaved data is preserved.
   * Defaults to true.
   */
  backdropCloses?: boolean;
  children?: ReactNode;
  className?: string;
  /**
   * Short description rendered under the title and wired up via
   * aria-describedby.
   */
  description?: string;
  /**
   * If false, Escape does not dismiss. Defaults to true.
   * Combine with `backdropCloses={false}` for fully blocking confirms.
   */
  dismissible?: boolean;
  /**
   * Optional element id to focus first when the modal opens. If omitted
   * the first focusable element inside the modal receives focus.
   */
  initialFocusId?: string;
  onClose: () => void;
  open: boolean;
  size?: ModalSize;
  title: string;
}

export function Modal({
  actions,
  backdropCloses = true,
  children,
  className,
  description,
  dismissible = true,
  initialFocusId,
  onClose,
  open,
  size = "default",
  title,
}: ModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  // Latest-callback refs so the keydown listener doesn't get torn down
  // every render.
  const onCloseRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);
  useEffect(() => {
    onCloseRef.current = onClose;
    dismissibleRef.current = dismissible;
  }, [dismissible, onClose]);

  // Open / close lifecycle: capture trigger, move focus inside, restore on close.
  useEffect(() => {
    if (!open) {
      return;
    }

    triggerRef.current = (document.activeElement as HTMLElement | null) ?? null;

    // Defer focus until the panel mounts so refs are populated.
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) {
        return;
      }

      const explicit = initialFocusId ? panel.querySelector<HTMLElement>(`#${initialFocusId}`) : null;
      if (explicit) {
        explicit.focus();
        return;
      }

      const firstFocusable = panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      if (firstFocusable) {
        firstFocusable.focus();
        return;
      }

      panel.focus();
    });

    return () => {
      cancelAnimationFrame(frame);
      // Return focus to the element that opened us, if it's still mounted
      // and focusable.
      const trigger = triggerRef.current;
      if (trigger && typeof trigger.focus === "function") {
        // Use a microtask so React can finish unmounting the modal
        // before we shift focus back. Without this we sometimes lose
        // the focus call if the trigger is inside a portal.
        queueMicrotask(() => {
          trigger.focus();
        });
      }
    };
  }, [initialFocusId, open]);

  // Escape + Tab focus trap. Single keydown listener while open.
  useEffect(() => {
    if (!open) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (dismissibleRef.current) {
          event.preventDefault();
          onCloseRef.current();
        }
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const panel = panelRef.current;
      if (!panel) {
        return;
      }

      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) => !element.hasAttribute("disabled") && element.tabIndex !== -1,
      );

      if (focusables.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (active === first || !panel.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !panel.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[var(--ag-z-modal)] flex items-center justify-center bg-black/60 p-6">
      <button
        aria-label="Close modal backdrop"
        className="absolute inset-0 cursor-default"
        onClick={backdropCloses ? onClose : undefined}
        tabIndex={-1}
        type="button"
      />
      <div
        aria-describedby={description ? descriptionId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className={cn(
          "relative flex w-full max-h-[80vh] flex-col rounded-[var(--ag-radius-xl)] border border-[var(--ag-border-default)] bg-[var(--ag-surface-overlay)] shadow-[var(--ag-shadow-xl)]",
          "motion-safe:animate-[ag-modal-enter_var(--ag-duration-slow)_var(--ag-ease-default)_both]",
          SIZE_CLASSES[size],
          className,
        )}
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--ag-border-subtle)] px-5 pb-4 pt-5">
          <div className="space-y-1">
            <h2 className="ag-text-h3 text-[var(--ag-text-primary)]" id={titleId}>
              {title}
            </h2>
            {description ? (
              <p className="ag-text-body-sm text-[var(--ag-text-secondary)]" id={descriptionId}>
                {description}
              </p>
            ) : null}
          </div>
          {dismissible ? (
            <Button aria-label="Close" onClick={onClose} size="sm" variant="ghost">
              <X aria-hidden="true" className="size-4" strokeWidth={1.75} />
            </Button>
          ) : null}
        </div>
        <div className="flex-1 overflow-auto px-5 py-4">{children}</div>
        {actions ? (
          <div className="flex items-center justify-end gap-2 border-t border-[var(--ag-border-subtle)] px-5 py-4">
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Confirmation modal — Design System §4.6 destructive patterns.
 *
 *   Level 1 (low risk):
 *     <ConfirmModal title="Delete tag v1.2.0?" confirmLabel="Delete tag" />
 *
 *   Level 2 (medium risk): require typing a literal word
 *     <ConfirmModal ... typeToConfirm="delete" />
 *
 *   Level 3 (high risk): require typing the entity name
 *     <ConfirmModal ... typeToConfirm="production-us-east" />
 *
 * The destructive flag switches the confirm button to the destructive
 * variant. For non-destructive confirmations leave it off — the confirm
 * button stays primary.
 */
export interface ConfirmModalProps {
  cancelLabel?: string;
  confirmLabel?: string;
  description?: string;
  destructive?: boolean;
  onClose: () => void;
  onConfirm: () => void;
  open: boolean;
  pending?: boolean;
  pendingLabel?: string;
  title: string;
  /** Literal string the user must type to enable the confirm button. */
  typeToConfirm?: string;
}

export function ConfirmModal({
  cancelLabel = "Cancel",
  confirmLabel = "Confirm",
  description,
  destructive = false,
  onClose,
  onConfirm,
  open,
  pending = false,
  pendingLabel,
  title,
  typeToConfirm,
}: ConfirmModalProps) {
  const [confirmText, setConfirmText] = useState("");

  // Reset typed confirmation whenever the modal closes so reopening it
  // requires the user to type again.
  useEffect(() => {
    if (!open) {
      setConfirmText("");
    }
  }, [open]);

  const matched = typeToConfirm == null ? true : confirmText === typeToConfirm;
  const confirmDisabled = pending || !matched;

  const handleConfirm = useCallback(() => {
    if (confirmDisabled) {
      return;
    }
    onConfirm();
  }, [confirmDisabled, onConfirm]);

  return (
    <Modal
      // Form modals never close on backdrop per spec §3.9, and the
      // confirm modal is functionally a form when it has type-to-confirm.
      backdropCloses={typeToConfirm == null}
      description={description}
      onClose={onClose}
      open={open}
      size="confirm"
      title={title}
      actions={
        <>
          <Button disabled={pending} onClick={onClose} variant="secondary">
            {cancelLabel}
          </Button>
          <Button
            disabled={confirmDisabled}
            loading={pending}
            loadingLabel={pendingLabel}
            onClick={handleConfirm}
            variant={destructive ? "destructive" : "primary"}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {typeToConfirm ? (
        <div className="space-y-3">
          <p className="ag-text-body-sm text-[var(--ag-text-secondary)]">
            Type{" "}
            <span className="font-mono text-[var(--ag-text-primary)]">{typeToConfirm}</span>{" "}
            to confirm.
          </p>
          <Input
            aria-label={`Type ${typeToConfirm} to confirm`}
            autoComplete="off"
            id="confirm-modal-input"
            onChange={(event) => setConfirmText(event.target.value)}
            placeholder={typeToConfirm}
            spellCheck={false}
            value={confirmText}
          />
        </div>
      ) : null}
    </Modal>
  );
}
