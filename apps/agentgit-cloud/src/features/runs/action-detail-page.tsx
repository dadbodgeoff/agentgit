"use client";

import Link from "next/link";

import { PageHeader } from "@/components/composites";
import { PageStatePanel } from "@/components/feedback";
import { Badge, Card, CodeBlock } from "@/components/primitives";
import { ApiClientError, getApiErrorMessage } from "@/lib/api/client";
import { repositorySnapshotsRoute, runDetailRoute } from "@/lib/navigation/routes";
import { useActionDetailQuery } from "@/lib/query/hooks";
import { formatAbsoluteDate, formatConfidence, formatNumber, formatRelativeTimestamp } from "@/lib/utils/format";

function decisionTone(decision: string | null): "success" | "warning" | "error" | "neutral" {
  if (decision === "allow" || decision === "allow_with_snapshot") {
    return "success";
  }

  if (decision === "ask") {
    return "warning";
  }

  if (decision === "deny") {
    return "error";
  }

  return "neutral";
}

function approvalTone(status: string | null): "success" | "warning" | "error" | "neutral" {
  if (status === "approved") {
    return "success";
  }

  if (status === "pending") {
    return "warning";
  }

  if (status === "denied" || status === "expired") {
    return "error";
  }

  return "neutral";
}

function executionTone(status: string): "success" | "warning" | "error" | "neutral" {
  if (status === "completed") {
    return "success";
  }

  if (status === "partial" || status === "blocked") {
    return "warning";
  }

  if (status === "failed" || status === "cancelled") {
    return "error";
  }

  return "neutral";
}

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
    const errorMessage =
      actionQuery.error instanceof ApiClientError && actionQuery.error.status === 404
        ? "Action detail was not found. The run may have been trimmed, or this repository is no longer available in your workspace."
        : getApiErrorMessage(actionQuery.error, "Could not load action detail. Retry.");

    return (
      <>
        <PageHeader
          description={`Normalized governed action detail for ${owner}/${name}, run ${runId}, action ${actionId}.`}
          title="Action detail"
        />
        <PageStatePanel errorMessage={errorMessage} state="error" />
      </>
    );
  }

  const action = actionQuery.data;

  return (
    <>
      <PageHeader
        actions={
          <div className="flex flex-wrap gap-2">
            <Link
              className="ag-focus-ring inline-flex h-9 items-center justify-center rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] px-3 text-sm font-medium text-[var(--ag-text-primary)] transition-colors hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-hover)]"
              href={runDetailRoute(owner, name, runId)}
            >
              Open run
            </Link>
            <Link
              className="ag-focus-ring inline-flex h-9 items-center justify-center rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] px-3 text-sm font-medium text-[var(--ag-text-primary)] transition-colors hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-hover)]"
              href={repositorySnapshotsRoute(owner, name)}
            >
              View snapshots
            </Link>
          </div>
        }
        description={`Normalized governed action detail for ${owner}/${name}, run ${runId}, action ${actionId}.`}
        title="Action detail"
      />

      {action.execution.status === "failed" || action.execution.status === "blocked" || action.execution.status === "partial" ? (
        <Card className="space-y-3 border-[var(--ag-color-warning)]/30 bg-[var(--ag-bg-elevated)]">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={executionTone(action.execution.status)}>{action.execution.status}</Badge>
            {action.policyOutcome.decision ? (
              <Badge tone={decisionTone(action.policyOutcome.decision)}>
                {action.policyOutcome.decision.replaceAll("_", " ")}
              </Badge>
            ) : null}
          </div>
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">Investigation summary</h2>
            <p className="text-sm text-[var(--ag-text-secondary)]">{action.execution.summary}</p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-card)] px-4 py-3 text-sm text-[var(--ag-text-secondary)]">
              {action.execution.helperSummary ?? "No execution helper summary is available for this step."}
            </div>
            <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-card)] px-4 py-3 text-sm text-[var(--ag-text-secondary)]">
              {action.execution.policyExplanation ?? "No policy explanation is available for this step."}
            </div>
          </div>
        </Card>
      ) : null}

      <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
        <Card>
          <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-tertiary)]">Confidence</div>
          <div className="mt-2 text-2xl font-semibold">{formatConfidence(action.normalizedAction.confidenceScore)}</div>
          <div className="mt-1 text-sm text-[var(--ag-text-secondary)]">{action.normalizedAction.confidenceBand}</div>
        </Card>
        <Card>
          <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-tertiary)]">Policy decision</div>
          <div className="mt-2">
            <Badge tone={decisionTone(action.policyOutcome.decision)}>
              {action.policyOutcome.decision ?? "unknown"}
            </Badge>
          </div>
          <div className="mt-1 text-sm text-[var(--ag-text-secondary)]">
            {action.policyOutcome.snapshotRequired ? "Snapshot required" : "Snapshot not required"}
          </div>
        </Card>
        <Card>
          <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-tertiary)]">Execution</div>
          <div className="mt-2">
            <Badge tone={executionTone(action.execution.status)}>{action.execution.status}</Badge>
          </div>
          <div className="mt-1 text-sm text-[var(--ag-text-secondary)]">{action.execution.stepType}</div>
        </Card>
        <Card>
          <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-tertiary)]">Impact</div>
          <div className="mt-2 text-2xl font-semibold">{formatNumber(action.execution.laterActionsAffected)}</div>
          <div className="mt-1 text-sm text-[var(--ag-text-secondary)]">later actions affected</div>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.9fr)]">
        <Card className="space-y-4">
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Badge tone={action.policyOutcome.approvalRequired ? "warning" : "neutral"}>
                {action.policyOutcome.approvalRequired ? "approval required" : "no approval"}
              </Badge>
              <Badge tone={action.policyOutcome.snapshotRequired ? "accent" : "neutral"}>
                {action.policyOutcome.snapshotRequired ? "snapshot required" : "no snapshot"}
              </Badge>
              <Badge tone={executionTone(action.execution.status)}>{action.execution.status}</Badge>
            </div>
            <h2 className="text-lg font-semibold">{action.normalizedAction.displayName}</h2>
            <div className="text-sm text-[var(--ag-text-secondary)]">
              {action.normalizedAction.targetLabel ?? action.normalizedAction.targetLocator}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] p-4">
              <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-tertiary)]">Action</div>
              <div className="text-sm font-medium">
                {action.normalizedAction.domain} / {action.normalizedAction.kind}
              </div>
              <div className="text-sm text-[var(--ag-text-secondary)]">
                Surface: {action.normalizedAction.executionSurface}
              </div>
              <div className="text-sm text-[var(--ag-text-secondary)]">
                Mode: {action.normalizedAction.executionMode}
              </div>
              <div className="text-sm text-[var(--ag-text-secondary)]">
                Reversibility: {action.normalizedAction.reversibilityHint}
              </div>
            </div>
            <div className="space-y-2 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] p-4">
              <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-tertiary)]">Timing</div>
              <div className="text-sm text-[var(--ag-text-secondary)]">
                Occurred {formatRelativeTimestamp(action.occurredAt)}
              </div>
              <div className="text-sm text-[var(--ag-text-secondary)]">{formatAbsoluteDate(action.occurredAt)}</div>
              <div className="text-sm text-[var(--ag-text-secondary)]">
                Snapshot: {action.execution.snapshotId ?? "none"}
              </div>
              <div className="text-sm text-[var(--ag-text-secondary)]">Step ID: {action.execution.stepId ?? "n/a"}</div>
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="text-sm font-semibold uppercase tracking-[0.06em] text-[var(--ag-text-tertiary)]">
              Policy reasoning
            </h3>
            <div className="grid gap-3 md:grid-cols-2">
              <Card className="space-y-2">
                <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-tertiary)]">Budget</div>
                <div className="text-sm font-medium">{action.policyOutcome.budgetCheck}</div>
                <div className="text-sm text-[var(--ag-text-secondary)]">
                  {action.policyOutcome.approvalRequired
                    ? "Approval gate was required."
                    : "No approval gate was required."}
                </div>
              </Card>
              <Card className="space-y-2">
                <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-tertiary)]">Matched rules</div>
                <div className="text-sm font-medium">{action.policyOutcome.matchedRules.length}</div>
                <div className="text-sm text-[var(--ag-text-secondary)]">
                  {action.policyOutcome.matchedRules.length > 0
                    ? action.policyOutcome.matchedRules.join(", ")
                    : "No explicit rules matched."}
                </div>
              </Card>
            </div>
            <Card className="space-y-3">
              <div className="text-sm font-semibold">Reason details</div>
              {action.policyOutcome.reasons.length > 0 ? (
                <div className="space-y-2">
                  {action.policyOutcome.reasons.map((reason) => (
                    <div
                      className="rounded-[var(--ag-radius-sm)] border border-[var(--ag-border-subtle)] px-3 py-2"
                      key={`${reason.code}:${reason.message}`}
                    >
                      <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-tertiary)]">
                        {reason.severity}
                      </div>
                      <div className="text-sm font-medium">{reason.code}</div>
                      <div className="text-sm text-[var(--ag-text-secondary)]">{reason.message}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-[var(--ag-text-secondary)]">No detailed policy reasons were recorded.</div>
              )}
            </Card>
          </div>
        </Card>

        <div className="space-y-6">
          <Card className="space-y-3">
            <h2 className="text-lg font-semibold">Run context</h2>
            <div className="space-y-2 text-sm">
              <div>
                Workflow: <span className="font-medium">{action.runContext.workflowName}</span>
              </div>
              <div>
                Agent:{" "}
                <span className="font-medium">
                  {action.runContext.agentFramework} / {action.runContext.agentName}
                </span>
              </div>
              <div>
                Run status:{" "}
                <Badge
                  tone={
                    action.runContext.status === "failed"
                      ? "error"
                      : action.runContext.status === "completed"
                        ? "success"
                        : "warning"
                  }
                >
                  {action.runContext.status}
                </Badge>
              </div>
              <div>
                Started: <span className="font-medium">{formatAbsoluteDate(action.runContext.startedAt)}</span>
              </div>
              <div>
                Latest event:{" "}
                <span className="font-medium">{formatRelativeTimestamp(action.runContext.latestEventAt)}</span>
              </div>
              <div>
                Events recorded: <span className="font-medium">{formatNumber(action.runContext.eventCount)}</span>
              </div>
            </div>
          </Card>

          <Card className="space-y-3">
            <h2 className="text-lg font-semibold">Approval context</h2>
            {action.approvalContext ? (
              <div className="space-y-2 text-sm">
                <div>
                  Status:{" "}
                  <Badge tone={approvalTone(action.approvalContext.status)}>{action.approvalContext.status}</Badge>
                </div>
                <div>
                  Requested:{" "}
                  <span className="font-medium">{formatAbsoluteDate(action.approvalContext.requestedAt)}</span>
                </div>
                <div>
                  Decision path: <span className="font-medium">{action.approvalContext.decisionRequested}</span>
                </div>
                <div>
                  Resolution note:{" "}
                  <span className="font-medium">{action.approvalContext.resolutionNote ?? "none"}</span>
                </div>
                <div>
                  Action summary: <span className="font-medium">{action.approvalContext.actionSummary}</span>
                </div>
                {action.approvalContext.primaryReason ? (
                  <div className="rounded-[var(--ag-radius-sm)] border border-[var(--ag-border-subtle)] px-3 py-2">
                    <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-tertiary)]">
                      Primary reason
                    </div>
                    <div className="text-sm font-medium">{action.approvalContext.primaryReason.code}</div>
                    <div className="text-sm text-[var(--ag-text-secondary)]">
                      {action.approvalContext.primaryReason.message}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="text-sm text-[var(--ag-text-secondary)]">No approval was recorded for this action.</div>
            )}
          </Card>

          <Card className="space-y-3">
            <h2 className="text-lg font-semibold">Execution detail</h2>
            <div className="space-y-2 text-sm">
              <div>
                Status: <span className="font-medium">{action.execution.status}</span>
              </div>
              <div>
                Step type: <span className="font-medium">{action.execution.stepType}</span>
              </div>
              <div>
                Snapshot: <span className="font-mono">{action.execution.snapshotId ?? "none"}</span>
              </div>
              <div>
                Later actions affected:{" "}
                <span className="font-medium">{formatNumber(action.execution.laterActionsAffected)}</span>
              </div>
            </div>
            {action.execution.artifactLabels.length > 0 ? (
              <div className="space-y-2">
                <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-tertiary)]">Artifacts</div>
                <div className="flex flex-wrap gap-2">
                  {action.execution.artifactLabels.map((label) => (
                    <Badge key={label} tone="neutral">
                      {label}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null}
          </Card>

          <Card className="space-y-3">
            <h2 className="text-lg font-semibold">Recovery scope</h2>
            <div className="space-y-2 text-sm">
              <div>
                Overlapping paths:{" "}
                <span className="font-medium">{formatNumber(action.execution.overlappingPaths.length)}</span>
              </div>
              {action.execution.overlappingPaths.length > 0 ? (
                <div className="space-y-1">
                  {action.execution.overlappingPaths.map((item) => (
                    <div className="font-mono text-xs text-[var(--ag-text-secondary)]" key={item}>
                      {item}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-[var(--ag-text-secondary)]">
                  No overlapping paths were recorded for this action.
                </div>
              )}
            </div>
            {action.execution.snapshotId ? (
              <div className="text-sm text-[var(--ag-text-secondary)]">
                Recovery is linked to snapshot{" "}
                <span className="font-mono text-[var(--ag-text-primary)]">{action.execution.snapshotId}</span>.
              </div>
            ) : null}
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

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card className="space-y-3">
          <h2 className="text-lg font-semibold">Execution event trail</h2>
          <div className="space-y-3">
            {action.eventTrail.map((event) => (
              <div
                className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3"
                key={event.id}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="space-y-1">
                    <div className="text-sm font-semibold text-[var(--ag-text-primary)]">
                      {event.eventType.replaceAll(".", " ")}
                    </div>
                    <div className="text-sm text-[var(--ag-text-secondary)]">{event.summary}</div>
                  </div>
                  <div className="text-xs text-[var(--ag-text-tertiary)]">{formatRelativeTimestamp(event.occurredAt)}</div>
                </div>
                <div className="mt-3">
                  <CodeBlock>{JSON.stringify(event.payload, null, 2)}</CodeBlock>
                </div>
              </div>
            ))}
          </div>
        </Card>
        <Card className="space-y-3">
          <h2 className="text-lg font-semibold">Normalized input</h2>
          <div className="text-sm text-[var(--ag-text-secondary)]">
            {action.normalizedAction.displayName} against{" "}
            {action.normalizedAction.targetLabel ?? action.normalizedAction.targetLocator}
          </div>
          <CodeBlock>{JSON.stringify(action.normalizedAction, null, 2)}</CodeBlock>
        </Card>
        <Card className="space-y-3">
          <h2 className="text-lg font-semibold">Policy payload</h2>
          <CodeBlock>{JSON.stringify(action.policyOutcome, null, 2)}</CodeBlock>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card className="space-y-3">
          <h2 className="text-lg font-semibold">Raw input</h2>
          <CodeBlock>{JSON.stringify(action.normalizedAction.rawInput, null, 2)}</CodeBlock>
        </Card>
        <Card className="space-y-3">
          <h2 className="text-lg font-semibold">Redacted input</h2>
          <CodeBlock>{JSON.stringify(action.normalizedAction.redactedInput, null, 2)}</CodeBlock>
        </Card>
      </div>
    </>
  );
}
