import type { ReactNode } from "react";

export function PageHeader({
  actions,
  description,
  title,
}: {
  actions?: ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <div className="flex flex-col gap-4 border-b border-[var(--ag-border-subtle)] pb-6 md:flex-row md:items-end md:justify-between">
      <div className="space-y-2">
        <h1 className="text-[32px] font-semibold tracking-[-0.02em]">{title}</h1>
        {description ? <p className="max-w-3xl text-sm text-[var(--ag-text-secondary)]">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
