"use client";

import type { ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/utils/cn";

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked: boolean;
  label?: string;
  description?: string;
  onCheckedChange: (checked: boolean) => void;
}

export function Switch({ checked, className, description, disabled, label, onCheckedChange, ...props }: SwitchProps) {
  return (
    <button
      aria-checked={checked}
      className={cn("ag-focus-ring flex min-h-11 w-full items-start justify-between gap-4 text-left", className)}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      role="switch"
      type="button"
      {...props}
    >
      <span className="space-y-1">
        {label ? <span className="ag-text-body-sm font-semibold text-[var(--ag-text-primary)]">{label}</span> : null}
        {description ? <span className="ag-text-caption text-[var(--ag-text-secondary)]">{description}</span> : null}
      </span>
      <span
        className={cn(
          "relative mt-0.5 inline-flex h-6 w-11 shrink-0 rounded-full border transition-colors duration-[var(--ag-duration-fast)]",
          checked
            ? "border-[var(--ag-color-brand)] bg-[color:rgb(10_205_207_/_0.22)]"
            : "border-[var(--ag-border-default)] bg-[var(--ag-surface-hover)]",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-4.5 rounded-full bg-[var(--ag-text-primary)] transition-transform duration-[var(--ag-duration-fast)]",
            checked ? "translate-x-[22px]" : "translate-x-[2px]",
          )}
        />
      </span>
    </button>
  );
}
