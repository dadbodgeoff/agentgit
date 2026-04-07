import type { ReactNode } from "react";

import { EmptyState, ErrorState, StaleIndicator } from "@/components/feedback";
import { MetricCard, PageHeader } from "@/components/composites";
import { Badge, Button, Card, CodeBlock, TableBody, TableCell, TableHead, TableHeaderCell, TableRoot, TableRow, TabList, TabTrigger } from "@/components/primitives";

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
  sections,
  sidePanel,
  staleLabel = "Spec scaffold",
  title,
}: {
  actions?: ReactNode;
  children?: ReactNode;
  description: string;
  metrics?: ScaffoldMetric[];
  sections: ScaffoldSection[];
  sidePanel?: ReactNode;
  staleLabel?: string;
  title: string;
}) {
  const visibleMetrics = metrics ?? [
    { label: "Connected repositories", trend: "+4 this week", value: "18" },
    { label: "Pending approvals", trend: "1 requires review", value: "3" },
    { label: "Failed runs (24h)", trend: "down 18%", value: "7" },
  ];

  return (
    <>
      <PageHeader actions={actions} description={description} title={title} />
      <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <div className="grid gap-6 md:grid-cols-3">
            {visibleMetrics.map((metric) => (
              <MetricCard key={metric.label} label={metric.label} trend={metric.trend} value={metric.value} />
            ))}
          </div>
          <Card className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">Page sections</h2>
                <p className="text-sm text-[var(--ag-text-secondary)]">
                  This scaffold preserves the planned route shape while we wire in live data and interactions.
                </p>
              </div>
              <StaleIndicator label={staleLabel} />
            </div>
            <TableRoot>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Section</TableHeaderCell>
                  <TableHeaderCell>Intent</TableHeaderCell>
                  <TableHeaderCell>Preview</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {sections.map((section) => (
                  <TableRow key={section.title}>
                    <TableCell className="font-medium">{section.title}</TableCell>
                    <TableCell className="text-[var(--ag-text-secondary)]">{section.description}</TableCell>
                    <TableCell>
                      <Badge tone={section.kind === "approval" ? "accent" : "neutral"}>{section.kind ?? "cards"}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </TableRoot>
          </Card>
          <Card className="space-y-4">
            <TabList>
              <TabTrigger active>Ready</TabTrigger>
              <TabTrigger>Loading</TabTrigger>
              <TabTrigger>Error</TabTrigger>
              <TabTrigger>Empty</TabTrigger>
            </TabList>
            <div className="grid gap-4 md:grid-cols-2">
              <Card className="space-y-2 bg-[var(--ag-bg-elevated)]">
                <h3 className="text-base font-semibold">Standard state rail</h3>
                <p className="text-sm text-[var(--ag-text-secondary)]">
                  Each route now has a defined place to render loading, empty, error, and stale states without inventing
                  new page structure later.
                </p>
              </Card>
              <ErrorState message="This is a scaffolded error block for the page-state contract." />
            </div>
          </Card>
          {children}
        </div>
        <div className="space-y-6">
          {sidePanel ?? (
            <>
              <Card className="space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold">Implementation rail</h2>
                  <Button size="sm" variant="secondary">
                    Open spec
                  </Button>
                </div>
                <CodeBlock>
                  {`Route scaffold
Feature placeholder
Shared schema boundary
Query key reserved
Shell + tokens wired first`}
                </CodeBlock>
              </Card>
              <EmptyState
                actionLabel="Connect repository"
                description="Use this slot to implement the documented empty state for the route before live data is added."
                title="Empty state placeholder"
              />
            </>
          )}
        </div>
      </div>
    </>
  );
}
