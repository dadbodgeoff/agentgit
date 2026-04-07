"use client";

import Link from "next/link";

import { Button, Card, TableBody, TableCell, TableHead, TableHeaderCell, TableRoot, TableRow } from "@/components/primitives";
import { PageStatePanel } from "@/components/feedback";
import { ScaffoldPage } from "@/features/shared/scaffold-page";
import { getApiErrorMessage } from "@/lib/api/client";
import { actionDetailRoute } from "@/lib/navigation/routes";
import { useRunDetailQuery } from "@/lib/query/hooks";
import type { PreviewState } from "@/schemas/cloud";
import { formatAbsoluteDate, formatRelativeTimestamp } from "@/lib/utils/format";

export function RunDetailPage({
  owner,
  name,
  runId,
  previewState = "ready",
}: {
  owner: string;
  name: string;
  runId: string;
  previewState?: PreviewState;
}) {
  const runQuery = useRunDetailQuery(runId, previewState);

  if (runQuery.isPending) {
    return (
      <ScaffoldPage actions={<Button variant="secondary">Restore snapshot</Button>} description={`Detailed run timeline for ${owner}/${name} run ${runId}, including action ordering, policy outcomes, and recovery context.`} sections={[]} title="Run detail">
        <PageStatePanel state="loading" />
      </ScaffoldPage>
    );
  }

  if (runQuery.isError) {
    const errorMessage = getApiErrorMessage(runQuery.error, "Could not load run detail. Retry.");

    return (
      <ScaffoldPage actions={<Button variant="secondary">Restore snapshot</Button>} description={`Detailed run timeline for ${owner}/${name} run ${runId}, including action ordering, policy outcomes, and recovery context.`} sections={[]} title="Run detail">
        <PageStatePanel errorMessage={errorMessage} state="error" />
      </ScaffoldPage>
    );
  }

  const run = runQuery.data;

  return (
    <ScaffoldPage
      actions={<Button variant="secondary">Restore snapshot</Button>}
      description={`Detailed run timeline for ${owner}/${name} run ${runId}, including action ordering, policy outcomes, and recovery context.`}
      metrics={[
        { label: "Actions", value: String(run.actionCount), trend: `${run.actionsAsked} required approval` },
        { label: "Snapshots", value: String(run.snapshotsTaken), trend: "recovery boundaries captured" },
        { label: "Started", value: formatRelativeTimestamp(run.startedAt), trend: run.runtime },
      ]}
      sections={[
        { title: "Run summary", description: "Authority-backed workflow metadata, status, and execution totals." },
        { title: "Timeline steps", description: "Projected step list from the daemon timeline query.", kind: "table" },
        { title: "Authority context", description: "Workspace roots and projection freshness for operator debugging.", kind: "code" },
      ]}
      title="Run detail"
    >
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.8fr)]">
        <Card className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Timeline steps</h2>
            <span className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">
              {run.projectionStatus}
            </span>
          </div>
          <TableRoot>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Step</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Decision</TableHeaderCell>
                <TableHeaderCell>Occurred</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {run.steps.map((step) => (
                <TableRow key={step.id}>
                  <TableCell>
                    <div className="space-y-1">
                      {step.actionId ? (
                        <Link
                          className="ag-focus-ring rounded-sm font-medium text-[var(--ag-text-primary)] underline-offset-4 hover:text-[var(--ag-color-brand)] hover:underline"
                          href={actionDetailRoute(owner, name, runId, step.actionId)}
                        >
                          {step.title}
                        </Link>
                      ) : (
                        <div className="font-medium">{step.title}</div>
                      )}
                      <div className="text-xs text-[var(--ag-text-secondary)]">{step.summary}</div>
                    </div>
                  </TableCell>
                  <TableCell className="capitalize">{step.stepType.replaceAll("_", " ")}</TableCell>
                  <TableCell className="capitalize">{step.status.replaceAll("_", " ")}</TableCell>
                  <TableCell className="capitalize">
                    {step.decision ? step.decision.replaceAll("_", " ") : "n/a"}
                  </TableCell>
                  <TableCell className="text-[var(--ag-text-secondary)]">{formatRelativeTimestamp(step.occurredAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </TableRoot>
        </Card>

        <Card className="space-y-4">
          <h2 className="text-lg font-semibold">Authority context</h2>
          <div className="space-y-3 text-sm">
            <div>
              <div className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">Workflow</div>
              <div className="mt-1 font-medium">{run.workflowName}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">Agent runtime</div>
              <div className="mt-1 font-medium">
                {run.agentFramework} / {run.agentName}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">Completed at</div>
              <div className="mt-1 font-medium">{formatAbsoluteDate(run.endedAt)}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">Summary</div>
              <div className="mt-1 text-[var(--ag-text-secondary)]">{run.summary}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-[0.12em] text-[var(--ag-text-tertiary)]">Workspace roots</div>
              <div className="mt-1 space-y-1">
                {run.workspaceRoots.map((workspaceRoot) => (
                  <div className="font-mono text-xs text-[var(--ag-text-secondary)]" key={workspaceRoot}>
                    {workspaceRoot}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Card>
      </div>
    </ScaffoldPage>
  );
}
