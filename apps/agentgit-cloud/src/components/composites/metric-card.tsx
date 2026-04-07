import { Card } from "@/components/primitives";

export function MetricCard({
  label,
  trend,
  value,
}: {
  label: string;
  trend?: string;
  value: string;
}): JSX.Element {
  return (
    <Card className="ag-dot-grid min-h-36">
      <div className="flex h-full flex-col justify-between gap-4">
        <span className="text-sm text-[var(--ag-text-secondary)]">{label}</span>
        <div className="space-y-2">
          <div className="font-mono text-3xl font-medium tracking-[-0.02em]">{value}</div>
          {trend ? <div className="text-xs text-[var(--ag-text-secondary)]">{trend}</div> : null}
        </div>
      </div>
    </Card>
  );
}
