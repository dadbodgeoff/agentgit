import type { SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils/cn";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  helpText?: string;
  errorText?: string;
  options: SelectOption[];
  placeholder?: string;
}

/** Styled native select with label and error support. Matches Input field appearance. */
export function Select({
  className,
  errorText,
  helpText,
  label,
  options,
  placeholder,
  ...props
}: SelectProps) {
  const describedBy = errorText ? `${props.id}-error` : helpText ? `${props.id}-help` : undefined;

  return (
    <label className="flex w-full flex-col gap-1">
      {label ? (
        <span className="text-[13px] font-semibold text-[var(--ag-text-primary)]">{label}</span>
      ) : null}
      <div className="relative">
        <select
          aria-describedby={describedBy}
          aria-invalid={errorText ? true : undefined}
          className={cn(
            "ag-focus-ring h-9 w-full appearance-none rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] bg-[var(--ag-bg-card)] px-3 pr-9 text-[14px] text-[var(--ag-text-primary)] hover:border-[var(--ag-border-strong)]",
            errorText
              ? "border-[var(--ag-color-error)] bg-[var(--ag-bg-error)]"
              : "focus:border-[var(--ag-color-brand)]",
            props.disabled && "cursor-not-allowed opacity-60",
            className,
          )}
          {...props}
        >
          {placeholder ? (
            <option disabled value="">
              {placeholder}
            </option>
          ) : null}
          {options.map((option) => (
            <option disabled={option.disabled} key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[var(--ag-text-tertiary)]"
          size={16}
          strokeWidth={1.5}
        />
      </div>
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
