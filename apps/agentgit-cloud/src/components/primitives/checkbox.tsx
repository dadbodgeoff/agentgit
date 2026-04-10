"use client";

import { useEffect, useRef, type InputHTMLAttributes } from "react";

import { Check } from "lucide-react";

import { cn } from "@/lib/utils/cn";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: string;
  description?: string;
  indeterminate?: boolean;
}

export function Checkbox({ className, description, id, indeterminate = false, label, ...props }: CheckboxProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  return (
    <label className={cn("flex min-h-11 items-start gap-3 text-left", className)}>
      <span className="relative mt-0.5 inline-flex">
        <input {...props} className="peer sr-only" id={id} ref={inputRef} role="checkbox" type="checkbox" />
        <span className="ag-focus-ring inline-flex size-5 items-center justify-center rounded-[6px] border border-[var(--ag-border-default)] bg-[var(--ag-surface-overlay)] text-transparent transition-colors duration-[var(--ag-duration-fast)] peer-checked:border-[var(--ag-color-brand)] peer-checked:bg-[var(--ag-color-brand)] peer-checked:text-[#0b0f14] peer-disabled:opacity-50">
          <Check aria-hidden="true" className="size-3.5" strokeWidth={2.25} />
        </span>
      </span>
      <span className="space-y-1">
        {label ? <span className="ag-text-body-sm font-semibold text-[var(--ag-text-primary)]">{label}</span> : null}
        {description ? <span className="ag-text-caption text-[var(--ag-text-secondary)]">{description}</span> : null}
      </span>
    </label>
  );
}
