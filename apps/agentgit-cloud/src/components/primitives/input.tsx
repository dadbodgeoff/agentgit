import type { InputHTMLAttributes } from "react";

import { cn } from "@/lib/utils/cn";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  helpText?: string;
  errorText?: string;
}

export function Input({ className, errorText, helpText, label, ...props }: InputProps) {
  const describedBy = errorText ? `${props.id}-error` : helpText ? `${props.id}-help` : undefined;

  return (
    <label className="flex w-full flex-col gap-1">
      {label ? <span className="ag-text-body-sm font-semibold text-[var(--ag-text-primary)]">{label}</span> : null}
      <input
        aria-describedby={describedBy}
        aria-invalid={errorText ? true : undefined}
        className={cn(
          "ag-focus-ring min-h-11 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] bg-[var(--ag-surface-overlay)] px-3 ag-text-body text-[var(--ag-text-primary)] placeholder:text-[var(--ag-text-tertiary)] hover:border-[var(--ag-border-strong)]",
          errorText ? "border-[var(--ag-color-error)] bg-[var(--ag-bg-error)]" : "focus:border-[var(--ag-color-brand)]",
          className,
        )}
        {...props}
      />
      {errorText ? (
        <span aria-live="polite" className="ag-text-caption text-[var(--ag-color-error)]" id={`${props.id}-error`}>
          {errorText}
        </span>
      ) : helpText ? (
        <span className="ag-text-caption text-[var(--ag-text-secondary)]" id={`${props.id}-help`}>
          {helpText}
        </span>
      ) : null}
    </label>
  );
}
