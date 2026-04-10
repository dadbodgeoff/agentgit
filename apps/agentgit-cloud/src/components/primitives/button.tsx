import type { ButtonHTMLAttributes, ReactNode } from "react";

import { LoaderCircle } from "lucide-react";

import { cn } from "@/lib/utils/cn";

type ButtonVariant = "primary" | "secondary" | "ghost" | "accent" | "destructive";
type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  loadingLabel?: string;
  children?: ReactNode;
}

const sizeClasses: Record<ButtonSize, string> = {
  sm: "min-h-11 px-3 ag-text-body-sm",
  md: "min-h-11 px-4 ag-text-body",
  lg: "min-h-12 px-5 ag-text-body",
};

const variantClasses: Record<ButtonVariant, string> = {
  primary: "border-transparent bg-[var(--ag-color-brand)] text-[#0b0f14] hover:bg-[var(--ag-color-brand-hover)]",
  secondary:
    "border-[var(--ag-border-default)] bg-transparent text-[var(--ag-text-primary)] hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-hover)]",
  ghost:
    "border-transparent bg-transparent text-[var(--ag-text-secondary)] hover:bg-[var(--ag-bg-hover)] hover:text-[var(--ag-text-primary)]",
  accent: "border-transparent bg-[var(--ag-color-accent)] text-[#0b0f14] hover:bg-[var(--ag-color-accent-hover)]",
  destructive:
    "border-[color:rgb(239_68_68_/_0.25)] bg-transparent text-[var(--ag-color-error)] hover:bg-[color:rgb(239_68_68_/_0.08)]",
};

export function Button({ className, size = "md", type = "button", variant = "primary", ...props }: ButtonProps) {
  const { children, disabled, loading = false, loadingLabel, ...buttonProps } = props;

  return (
    <button
      aria-busy={loading || undefined}
      className={cn(
        "ag-focus-ring relative inline-flex items-center justify-center gap-2 rounded-[var(--ag-radius-md)] border font-medium transition-colors duration-[var(--ag-duration-fast)] ease-[var(--ag-ease-default)] disabled:cursor-not-allowed disabled:opacity-60",
        sizeClasses[size],
        variantClasses[variant],
        className,
      )}
      disabled={disabled || loading}
      type={type}
      {...buttonProps}
    >
      <span className={cn("inline-flex items-center gap-2", loading && "opacity-0")}>{children}</span>
      {loading ? (
        <span className="pointer-events-none absolute inset-0 inline-flex items-center justify-center gap-2">
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin" strokeWidth={1.75} />
          {loadingLabel ? <span>{loadingLabel}</span> : null}
        </span>
      ) : null}
    </button>
  );
}
