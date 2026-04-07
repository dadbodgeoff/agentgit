import type { ReactNode } from "react";

import { Card } from "@/components/primitives";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorState } from "@/components/feedback/error-state";
import { LoadingSkeleton } from "@/components/feedback/loading-skeleton";

export function PageStatePanel({
  children,
  emptyActionLabel,
  emptyDescription,
  emptyTitle,
  errorMessage,
  state,
}: {
  children?: ReactNode;
  emptyActionLabel?: string;
  emptyDescription?: string;
  emptyTitle?: string;
  errorMessage?: string;
  state: "loading" | "empty" | "error" | "ready";
}): JSX.Element {
  if (state === "loading") {
    return (
      <Card className="space-y-4">
        <LoadingSkeleton lines={3} />
        <div className="grid gap-4 md:grid-cols-2">
          <LoadingSkeleton lines={6} />
          <LoadingSkeleton lines={6} />
        </div>
      </Card>
    );
  }

  if (state === "error") {
    return <ErrorState message={errorMessage ?? "The request failed. Retry after checking the mocked API state."} />;
  }

  if (state === "empty") {
    return (
      <EmptyState
        actionLabel={emptyActionLabel}
        description={emptyDescription ?? "This route has no data yet."}
        title={emptyTitle ?? "Nothing to show"}
      />
    );
  }

  return <>{children}</>;
}
