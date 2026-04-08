import type { ReactNode } from "react";

import { Breadcrumbs, type BreadcrumbItem } from "@/components/composites/breadcrumbs";

/** Page title, description, optional breadcrumbs, stale indicator, and action buttons. */
export function PageHeader({
  actions,
  breadcrumbs,
  description,
  staleIndicator,
  title,
}: {
  actions?: ReactNode;
  breadcrumbs?: BreadcrumbItem[];
  description?: string;
  staleIndicator?: ReactNode;
  title: string;
}) {
  return (
    <div className="flex flex-col gap-4 border-b border-[var(--ag-border-subtle)] pb-6">
      {breadcrumbs && breadcrumbs.length > 0 ? <Breadcrumbs items={breadcrumbs} /> : null}
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="space-y-2">
          <h1 className="text-[32px] font-semibold tracking-[-0.02em]">{title}</h1>
          {description ? (
            <p className="max-w-3xl text-sm text-[var(--ag-text-secondary)]">{description}</p>
          ) : null}
          {staleIndicator ? <div className="mt-1">{staleIndicator}</div> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
