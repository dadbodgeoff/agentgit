import { Button, Card } from "@/components/primitives";

export function ErrorState({
  message,
  retryLabel = "Retry",
}: {
  message: string;
  retryLabel?: string;
}): JSX.Element {
  return (
    <Card className="border-[color:rgb(239_68_68_/_0.35)] bg-[var(--ag-bg-error)]">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-[var(--ag-color-error)]">Could not load this section</p>
          <p className="text-sm text-[var(--ag-text-secondary)]">{message}</p>
        </div>
        <Button variant="secondary">{retryLabel}</Button>
      </div>
    </Card>
  );
}
