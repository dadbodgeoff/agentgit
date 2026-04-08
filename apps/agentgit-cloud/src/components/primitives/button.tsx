import type { ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/utils/cn";

type ButtonVariant = "primary" | "secondary" | "ghost" | "accent" | "destructive";
type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-9 px-4 text-[14px]",
  lg: "h-10 px-5 text-[14px]",
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
  return (
    <button
      className={cn(
        "ag-focus-ring inline-flex items-center justify-center gap-2 rounded-[var(--ag-radius-md)] border font-medium transition-colors duration-[var(--ag-duration-fast)] ease-[var(--ag-ease-default)] disabled:cursor-not-allowed disabled:opacity-60",
        sizeClasses[size],
        variantClasses[variant],
        className,
      )}
      type={type}
      {...props}
    />
  );
}
