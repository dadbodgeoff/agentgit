import type { ReactNode } from "react";

import { MetricCard, PageHeader } from "@/components/composites";

export interface ScaffoldSection {
  title: string;
  description: string;
  kind?: "cards" | "table" | "approval" | "code" | "empty" | "status";
}

export interface ScaffoldMetric {
  label: string;
  value: string;
  trend?: string;
}

export function ScaffoldPage({
  actions,
  children,
  description,
  metrics,
  sidePanel,
  title,
}: {
  actions?: ReactNode;
  children?: ReactNode;
  description: string;
  metrics?: ScaffoldMetric[];
  sections?: ScaffoldSection[];
  sidePanel?: ReactNode;
  title: string;
}) {
  const visibleMetrics = metrics ?? [];

  return (
    <>
      <PageHeader actions={actions} description={description} title={title} />
      <div className="space-y-6">
        {visibleMetrics.length > 0 ? (
          <div className="grid gap-6 md:grid-cols-3">
            {visibleMetrics.map((metric) => (
              <MetricCard key={metric.label} label={metric.label} trend={metric.trend} value={metric.value} />
            ))}
          </div>
        ) : null}

        {sidePanel ? (
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.7fr)_minmax(320px,1fr)]">
            <div>{children}</div>
            <div className="space-y-6">{sidePanel}</div>
          </div>
        ) : (
          children
        )}
      </div>
    </>
  );
}
