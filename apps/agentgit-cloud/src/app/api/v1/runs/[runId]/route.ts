import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

import { RunJournal, type RunJournalEventRecord } from "@agentgit/run-journal";

import { requireApiSession } from "@/lib/auth/api-session";
import { withWorkspaceAuthorityClient } from "@/lib/backend/authority/client";
import { mapTimelineToRunDetail } from "@/lib/backend/authority/contracts";
import { toAuthorityRouteErrorResponse } from "@/lib/backend/authority/route-errors";
import { collectWorkspaceRepositoryRuntimeRecords } from "@/lib/backend/workspace/repository-inventory";
import { resolveWorkspaceRoots } from "@/lib/backend/workspace/roots";
import { loadPreviewFixture, resolvePreviewState } from "@/lib/dev/preview-fixtures";
import { createRequestId, jsonWithRequestId } from "@/lib/observability/route-response";
import { RunDetailSchema, type RunStatus, type RunStepStatus, type RunStepType } from "@/schemas/cloud";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function readPayloadString(event: RunJournalEventRecord, key: string): string | null {
  return typeof event.payload?.[key] === "string" ? (event.payload[key] as string) : null;
}

function stepTitle(eventType: string): string {
  return eventType
    .split(".")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function stepType(eventType: string): RunStepType {
  if (eventType.startsWith("approval.")) {
    return "approval_step";
  }
  if (eventType.startsWith("recovery.")) {
    return "recovery_step";
  }
  if (eventType.startsWith("policy.")) {
    return "analysis_step";
  }
  if (eventType.startsWith("action.") || eventType.startsWith("execution.")) {
    return "action_step";
  }
  return "system_step";
}

function stepStatus(eventType: string): RunStepStatus {
  if (eventType === "approval.requested") {
    return "awaiting_approval";
  }
  if (eventType === "execution.failed" || eventType === "execution.outcome_unknown") {
    return "failed";
  }
  return "completed";
}

function runStatus(eventType: string | null | undefined): RunStatus {
  if (!eventType) {
    return "queued";
  }
  if (eventType === "execution.failed" || eventType === "execution.outcome_unknown") {
    return "failed";
  }
  if (eventType === "approval.requested") {
    return "running";
  }
  if (eventType === "execution.completed" || eventType === "recovery.executed") {
    return "completed";
  }
  return "running";
}

async function loadJournalRunDetail(workspaceId: string, runId: string) {
  const repositories = await collectWorkspaceRepositoryRuntimeRecords(workspaceId);
  const roots = [
    ...new Set([...repositories.map((repository) => repository.metadata.root), ...resolveWorkspaceRoots()]),
  ];

  for (const root of roots) {
    const journalPath = path.join(root, ".agentgit", "state", "authority.db");
    if (!fs.existsSync(journalPath)) {
      continue;
    }

    const journal = new RunJournal({ dbPath: journalPath });
    try {
      const run = journal.getRunSummary(runId);
      if (!run) {
        continue;
      }

      const events = journal.listRunEvents(runId);
      const steps = events.map((event, index) => ({
        id: `${runId}:${event.sequence}`,
        sequence: index + 1,
        title: stepTitle(event.event_type),
        stepType: stepType(event.event_type),
        status: stepStatus(event.event_type),
        actionId: readPayloadString(event, "action_id") ?? undefined,
        decision: readPayloadString(event, "decision"),
        summary: `Journal event ${event.event_type}.`,
        occurredAt: event.occurred_at,
        snapshotId: readPayloadString(event, "snapshot_id") ?? undefined,
      }));
      const actionCount = steps.filter((step) => step.stepType === "action_step").length;
      const actionsAsked = steps.filter((step) => step.stepType === "approval_step").length;
      const snapshotsTaken = new Set(steps.map((step) => step.snapshotId).filter(Boolean)).size;
      const endedAt = steps[steps.length - 1]?.occurredAt ?? run.started_at;

      return RunDetailSchema.parse({
        id: run.run_id,
        workflowName: run.workflow_name,
        agentName: run.agent_name,
        agentFramework: run.agent_framework,
        workspaceRoots: run.workspace_roots,
        projectionStatus: "rebuilt",
        runtime: `${run.agent_framework} / ${run.agent_name}`,
        status: runStatus(run.latest_event?.event_type),
        startedAt: run.started_at,
        endedAt,
        actionCount,
        actionsAllowed: steps.filter((step) => step.decision === "allow" || step.decision === "allow_with_snapshot")
          .length,
        actionsDenied: steps.filter((step) => step.decision === "deny").length,
        actionsAsked,
        snapshotsTaken,
        summary: `${run.workflow_name} rebuilt from local journal after authority timeline projection was unavailable.`,
        steps,
      });
    } finally {
      journal.close();
    }
  }

  return null;
}

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const { unauthorized, workspaceSession } = await requireApiSession(request);

  if (unauthorized) {
    return unauthorized;
  }

  const previewState = resolvePreviewState(request);
  const { runId } = await context.params;

  if (previewState === "loading") {
    await sleep(1200);
  }

  if (previewState === "error") {
    return jsonWithRequestId({ message: "Could not load run detail. Retry." }, { status: 500 }, requestId);
  }

  if (previewState !== "ready") {
    const fixture = await loadPreviewFixture("runDetail", previewState, runId);
    if (fixture) {
      return jsonWithRequestId(fixture, undefined, requestId);
    }
  }

  try {
    const runDetail = await withWorkspaceAuthorityClient(workspaceSession.activeWorkspace.id, (client) =>
      client.queryTimeline(runId),
    );
    return jsonWithRequestId(mapTimelineToRunDetail(runDetail), undefined, requestId);
  } catch (error) {
    const fallback = await loadJournalRunDetail(workspaceSession.activeWorkspace.id, runId);
    if (fallback) {
      return jsonWithRequestId(fallback, undefined, requestId);
    }

    return toAuthorityRouteErrorResponse(error, "Could not load run detail. Retry.", {
      requestId,
      route: "run_detail",
    });
  }
}
