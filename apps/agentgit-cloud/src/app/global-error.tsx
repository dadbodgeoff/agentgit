"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

import { Button, Card } from "@/components/primitives";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error, {
      tags: {
        boundary: "global",
      },
      extra: {
        digest: error.digest,
      },
    });
  }, [error]);

  return (
    <html lang="en">
      <body className="min-h-screen bg-[var(--ag-bg-canvas)] text-[var(--ag-text-primary)]">
        <main className="mx-auto flex min-h-screen max-w-3xl items-center px-6 py-12">
          <Card className="w-full space-y-4">
            <div className="space-y-2">
              <p className="font-mono text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">Global error</p>
              <h1 className="text-3xl font-semibold">The application hit a fatal rendering error.</h1>
              <p className="text-sm text-[var(--ag-text-secondary)]">
                Reset the route to retry. If the issue persists, use the request or error identifiers captured in Sentry.
              </p>
            </div>
            <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3 font-mono text-xs text-[var(--ag-text-secondary)]">
              {error.message || "Unknown application error"}
            </div>
            {error.digest ? <div className="text-xs text-[var(--ag-text-tertiary)]">Digest: {error.digest}</div> : null}
            <Button onClick={reset}>Try again</Button>
          </Card>
        </main>
      </body>
    </html>
  );
}
