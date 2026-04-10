import type { ReactNode, SelectHTMLAttributes } from "react";

import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils/cn";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  helpText?: string;
  errorText?: string;
  children: ReactNode;
}

export function Select({ children, className, errorText, helpText, label, ...props }: SelectProps) {
  const describedBy = errorText ? `${props.id}-error` : helpText ? `${props.id}-help` : undefined;

  return (
    <label className="flex w-full flex-col gap-1">
      {label ? <span className="ag-text-body-sm font-semibold text-[var(--ag-text-primary)]">{label}</span> : null}
      <span className="relative">
        <select
          aria-describedby={describedBy}
          aria-invalid={errorText ? true : undefined}
          className={cn(
            "ag-focus-ring min-h-11 w-full appearance-none rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] bg-[var(--ag-surface-overlay)] px-3 pr-10 ag-text-body text-[var(--ag-text-primary)] hover:border-[var(--ag-border-strong)]",
            errorText
              ? "border-[var(--ag-color-error)] bg-[var(--ag-bg-error)]"
              : "focus:border-[var(--ag-color-brand)]",
            className,
          )}
          {...props}
        >
          {children}
        </select>
        <ChevronDown
          aria-hidden="true"
          className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-[var(--ag-text-secondary)]"
          strokeWidth={1.5}
        />
      </span>
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
