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
      {label ? <span className="text-[13px] font-semibold text-[var(--ag-text-primary)]">{label}</span> : null}
      <input
        aria-describedby={describedBy}
        aria-invalid={errorText ? true : undefined}
        className={cn(
          "ag-focus-ring h-9 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] bg-[var(--ag-bg-card)] px-3 text-[14px] text-[var(--ag-text-primary)] placeholder:text-[var(--ag-text-tertiary)] hover:border-[var(--ag-border-strong)]",
          errorText
            ? "border-[var(--ag-color-error)] bg-[var(--ag-bg-error)]"
            : "focus:border-[var(--ag-color-brand)]",
          className,
        )}
        {...props}
      />
      {errorText ? (
        <span className="text-[12px] text-[var(--ag-color-error)]" id={`${props.id}-error`}>
          {errorText}
        </span>
      ) : helpText ? (
        <span className="text-[12px] text-[var(--ag-text-secondary)]" id={`${props.id}-help`}>
          {helpText}
        </span>
      ) : null}
    </label>
  );
}
