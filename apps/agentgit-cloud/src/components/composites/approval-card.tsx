import { Badge, Button, Card } from "@/components/primitives";

export function ApprovalCard({
  confidence,
  repo,
  summary,
}: {
  confidence: number;
  repo: string;
  summary: string;
}): JSX.Element {
  return (
    <Card className="border-l-2 border-l-[var(--ag-color-accent)]">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold">{repo}</h2>
          <Badge tone="accent">Agent review</Badge>
          <span className="font-mono text-xs text-[var(--ag-text-secondary)]">confidence {confidence.toFixed(2)}</span>
        </div>
        <p className="text-sm text-[var(--ag-text-secondary)]">{summary}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="accent">Approve action</Button>
          <Button variant="destructive">Reject</Button>
          <Button variant="secondary">View diff</Button>
        </div>
      </div>
    </Card>
  );
}
