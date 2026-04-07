"use client";

import { PageHeader } from "@/components/composites";
import { PageStatePanel } from "@/components/feedback";
import { Card, CodeBlock } from "@/components/primitives";
import { getApiErrorMessage } from "@/lib/api/client";
import { useActionDetailQuery } from "@/lib/query/hooks";

export function ActionDetailPage({
  owner,
  name,
  runId,
  actionId,
}: {
  owner: string;
  name: string;
  runId: string;
  actionId: string;
}) {
  const actionQuery = useActionDetailQuery(owner, name, runId, actionId);

  if (actionQuery.isPending) {
    return (
      <>
        <PageHeader
          description={`Normalized governed action detail for ${owner}/${name}, run ${runId}, action ${actionId}.`}
          title="Action detail"
        />
        <PageStatePanel state="loading" />
      </>
    );
  }

  if (actionQuery.isError) {
    return (
      <>
        <PageHeader
          description={`Normalized governed action detail for ${owner}/${name}, run ${runId}, action ${actionId}.`}
          title="Action detail"
        />
        <PageStatePanel errorMessage={getApiErrorMessage(actionQuery.error, "Could not load action detail. Retry.")} state="error" />
      </>
    );
  }

  const action = actionQuery.data;
  return (
    <>
      <PageHeader
        description={`Normalized governed action detail for ${owner}/${name}, run ${runId}, action ${actionId}.`}
        title="Action detail"
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.8fr)]">
        <Card className="space-y-4">
          <div className="space-y-2">
            <h2 className="text-lg font-semibold">Normalized action</h2>
            <div className="text-sm text-[var(--ag-text-secondary)]">
              {action.normalizedAction.displayName} against {action.normalizedAction.targetLabel ?? action.normalizedAction.targetLocator}
            </div>
          </div>
          <CodeBlock>
            {JSON.stringify(
              {
                normalizedAction: action.normalizedAction,
                policyOutcome: action.policyOutcome,
              },
              null,
              2,
            )}
          </CodeBlock>
        </Card>
        <div className="space-y-6">
          <Card className="space-y-3">
            <h2 className="text-lg font-semibold">Execution detail</h2>
            <div className="space-y-2 text-sm">
              <div>Status: <span className="font-medium">{action.execution.status}</span></div>
              <div>Step type: <span className="font-medium">{action.execution.stepType}</span></div>
              <div>Snapshot: <span className="font-mono">{action.execution.snapshotId ?? "none"}</span></div>
              <div>Later actions affected: <span className="font-medium">{action.execution.laterActionsAffected}</span></div>
            </div>
          </Card>
          <Card className="space-y-3">
            <h2 className="text-lg font-semibold">Helper context</h2>
            <div className="space-y-3 text-sm text-[var(--ag-text-secondary)]">
              <div>{action.execution.helperSummary ?? "No helper explanation is currently available."}</div>
              <div>{action.execution.policyExplanation ?? "No policy explanation is currently available."}</div>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
