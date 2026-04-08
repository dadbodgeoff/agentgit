"use client";

import { useEffect, useState } from "react";

import { Badge, Button } from "@/components/primitives";
import { formatAbsoluteDate, formatRelativeTimestamp } from "@/lib/utils/format";
import type { ConnectorBootstrapResponse } from "@/schemas/cloud";

type ConnectorBootstrapPanelProps = {
  bootstrapDetails: ConnectorBootstrapResponse;
  waitingForConnection?: boolean;
  connected?: boolean;
};

type CopyState = "idle" | "command" | "token";

async function copyToClipboard(value: string) {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    throw new Error("Clipboard access is unavailable.");
  }

  await navigator.clipboard.writeText(value);
}

export function ConnectorBootstrapPanel({
  bootstrapDetails,
  waitingForConnection = false,
  connected = false,
}: ConnectorBootstrapPanelProps) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [copyError, setCopyError] = useState<string | null>(null);

  useEffect(() => {
    if (copyState === "idle") {
      return;
    }

    const timeout = window.setTimeout(() => {
      setCopyState("idle");
    }, 2200);

    return () => window.clearTimeout(timeout);
  }, [copyState]);

  async function handleCopy(kind: CopyState, value: string) {
    try {
      await copyToClipboard(value);
      setCopyError(null);
      setCopyState(kind);
    } catch {
      setCopyError("Clipboard access failed. Copy the value manually.");
    }
  }

  const statusTone = connected ? "success" : waitingForConnection ? "warning" : "accent";
  const statusLabel = connected ? "Connector active" : waitingForConnection ? "Waiting for heartbeat" : "Bootstrap ready";

  return (
    <div className="space-y-3 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-page)] px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="text-xs uppercase tracking-[0.18em] text-[var(--ag-text-tertiary)]">Connector bootstrap command</div>
          <div className="text-sm text-[var(--ag-text-secondary)]">
            Run this on the machine that hosts the selected repository checkout.
          </div>
        </div>
        <Badge tone={statusTone}>{statusLabel}</Badge>
      </div>

      <div className="overflow-x-auto rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-3 py-3 font-mono text-sm text-[var(--ag-text-primary)]">
        {bootstrapDetails.commandHint}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void handleCopy("command", bootstrapDetails.commandHint)} size="sm" variant="secondary">
          {copyState === "command" ? "Command copied" : "Copy command"}
        </Button>
        <Button onClick={() => void handleCopy("token", bootstrapDetails.bootstrapToken)} size="sm" variant="secondary">
          {copyState === "token" ? "Token copied" : "Copy token"}
        </Button>
      </div>

      <div className="grid gap-3 text-sm text-[var(--ag-text-secondary)] sm:grid-cols-2">
        <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-3 py-3">
          <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--ag-text-tertiary)]">Workspace</div>
          <div className="mt-1 text-[var(--ag-text-primary)]">{bootstrapDetails.workspaceSlug}</div>
        </div>
        <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-3 py-3">
          <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--ag-text-tertiary)]">Expires</div>
          <div className="mt-1 text-[var(--ag-text-primary)]">
            {formatAbsoluteDate(bootstrapDetails.expiresAt)} ({formatRelativeTimestamp(bootstrapDetails.expiresAt)})
          </div>
        </div>
      </div>

      <div className="text-sm text-[var(--ag-text-secondary)]">
        {connected
          ? "A connector is now active for the selected repository scope."
          : waitingForConnection
            ? "The cloud UI is polling for the first connector heartbeat. Leave this page open while the bootstrap command runs."
            : "Generate a token only when you are at the terminal that will run the connector."}
      </div>

      {copyError ? (
        <div className="rounded-[var(--ag-radius-md)] border border-[color:rgb(239_68_68_/_0.25)] bg-[var(--ag-bg-error)] px-3 py-2 text-sm text-[var(--ag-color-error)]">
          {copyError}
        </div>
      ) : null}
    </div>
  );
}
