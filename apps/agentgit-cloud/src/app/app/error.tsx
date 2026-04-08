"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

import { Button, Card } from "@/components/primitives";

export default function AppSegmentError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error, {
      tags: {
        boundary: "app_segment",
      },
      extra: {
        digest: error.digest,
      },
    });
    console.error("agentgit_cloud_route_error", {
      digest: error.digest,
      message: error.message,
    });
  }, [error]);

  return (
    <div className="space-y-6">
      <div className="space-y-2 border-b border-[var(--ag-border-subtle)] pb-6">
        <p className="font-mono text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">Route boundary</p>
        <h1 className="text-[32px] font-semibold tracking-[-0.02em]">This workspace view crashed.</h1>
        <p className="max-w-2xl text-sm text-[var(--ag-text-secondary)]">
          The shell is still running. Reset this route to recover without dropping the rest of the session.
        </p>
      </div>
      <Card className="space-y-4">
        <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3 font-mono text-xs text-[var(--ag-text-secondary)]">
          {error.message || "Unknown route error"}
        </div>
        {error.digest ? <div className="text-xs text-[var(--ag-text-tertiary)]">Digest: {error.digest}</div> : null}
        <Button onClick={reset}>Reset route</Button>
      </Card>
    </div>
  );
}
