import type { ReactNode } from "react";

import { Button, Card } from "@/components/primitives";

export function EmptyState({
  actionLabel,
  children,
  description,
  title,
}: {
  actionLabel?: string;
  children?: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <Card className="border-dashed bg-transparent text-center">
      <div className="mx-auto flex max-w-xl flex-col items-center gap-4 py-8">
        <div className="h-12 w-12 rounded-full border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-hover)]" />
        <div className="space-y-2">
          <h2 className="text-xl font-semibold">{title}</h2>
          <p className="text-sm text-[var(--ag-text-secondary)]">{description}</p>
        </div>
        {actionLabel ? <Button variant="primary">{actionLabel}</Button> : null}
        {children}
      </div>
    </Card>
  );
}
