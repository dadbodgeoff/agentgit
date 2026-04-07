import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils/cn";

type BadgeTone = "neutral" | "success" | "warning" | "error" | "accent";

const toneClasses: Record<BadgeTone, string> = {
  neutral: "border-[var(--ag-border-default)] bg-[var(--ag-bg-hover)] text-[var(--ag-text-secondary)]",
  success: "border-transparent bg-[var(--ag-bg-success)] text-[var(--ag-color-success)]",
  warning: "border-transparent bg-[var(--ag-bg-warning)] text-[var(--ag-color-warning)]",
  error: "border-transparent bg-[var(--ag-bg-error)] text-[var(--ag-color-error)]",
  accent: "border-transparent bg-[color:rgb(232_255_89_/_0.18)] text-[var(--ag-color-accent)]",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ className, tone = "neutral", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex min-h-[22px] items-center rounded-full border px-2 py-0.5 font-mono text-[12px] font-medium",
        toneClasses[tone],
        className,
      )}
      {...props}
    />
  );
}
