import "server-only";

import fs from "node:fs";
import path from "node:path";

import { ActionRecordSchema, type ActionRecord } from "@agentgit/schemas";
import { RunJournal } from "@agentgit/run-journal";

import { withWorkspaceAuthorityClient } from "@/lib/backend/authority/client";
import { getRepositoryConnectorAvailability, queueConnectorCommand } from "@/lib/backend/control-plane/connectors";
import { findRepositoryRuntimeRecord } from "@/lib/backend/workspace/repository-inventory";
import {
  RunReplayPreviewSchema,
  RunReplayQueuedResponseSchema,
  type RunReplayAction,
  type RunReplayPreview,
  type RunReplayQueuedResponse,
  type WorkspaceSession,
} from "@/schemas/cloud";

export class RunReplayAccessError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "RunReplayAccessError";
  }
}

function getJournalPath(repoRoot: string): string {
  return path.join(repoRoot, ".agentgit", "state", "authority.db");
}

function getActionReplayReason(action: ActionRecord): string | null {
  if (action.provenance.mode === "governed") {
    return null;
  }

  switch (action.provenance.mode) {
    case "observed":
      return "Observed post-execution activity cannot be re-executed faithfully.";
    case "imported":
      return "Imported external history cannot be replayed as a governed action.";
    default:
      return "This action does not have trustworthy governed provenance for replay.";
  }
}

function buildRunReplaySummary(params: {
  workflowName: string;
  sourceActionCount: number;
  replayableActionCount: number;
  skippedActionCount: number;
  pendingApprovalCount: number;
}): string {
  return `${params.workflowName} recorded ${params.sourceActionCount} normalized action${
    params.sourceActionCount === 1 ? "" : "s"
  }; ${params.replayableActionCount} can be replayed, ${params.skippedActionCount} will be skipped, and ${
    params.pendingApprovalCount
  } source approval step${params.pendingApprovalCount === 1 ? "" : "s"} were observed.`;
}

async function loadRunReplaySource(owner: string, name: string, workspaceId: string, runId: string) {
  const repository = await findRepositoryRuntimeRecord(owner, name, workspaceId);
  if (!repository) {
    return null;
  }

  const journalPath = getJournalPath(repository.metadata.root);
  if (!fs.existsSync(journalPath)) {
    return null;
  }

  const journal = new RunJournal({ dbPath: journalPath });
  try {
    const runSummary = journal.getRunSummary(runId);
    if (!runSummary) {
      return null;
    }

    const events = journal.listRunEvents(runId);
    return {
      repository,
      runSummary,
      events,
    };
  } finally {
    journal.close();
  }
}

export async function getRunReplayPreview(
  owner: string,
  name: string,
  workspaceId: string,
  runId: string,
): Promise<RunReplayPreview | null> {
  const source = await loadRunReplaySource(owner, name, workspaceId, runId);
  if (!source) {
    return null;
  }

  const rawDecisions = new Map<string, RunReplayAction["decision"]>();
  for (const event of source.events) {
    if (event.event_type !== "policy.evaluated") {
      continue;
    }

    const payload = event.payload ?? {};
    const actionId = typeof payload.action_id === "string" ? payload.action_id : null;
    if (!actionId) {
      continue;
    }

    const decision =
      payload.decision === "allow" ||
      payload.decision === "deny" ||
      payload.decision === "ask" ||
      payload.decision === "simulate" ||
      payload.decision === "allow_with_snapshot"
        ? payload.decision
        : null;

    rawDecisions.set(actionId, decision);
  }

  const actions = source.events
    .filter((event) => event.event_type === "action.normalized")
    .map((event) => {
      const parsed = ActionRecordSchema.safeParse((event.payload ?? {}).action);
      return parsed.success ? parsed.data : null;
    })
    .filter((action): action is ActionRecord => action !== null)
    .map((action) => ({
      sourceActionId: action.action_id,
      title: action.operation.display_name ?? action.operation.name,
      actionFamily: `${action.operation.domain}/${action.operation.kind}`,
      toolName: action.actor.tool_name,
      provenance: action.provenance.mode,
      sideEffectLevel: action.risk_hints.side_effect_level,
      decision: rawDecisions.get(action.action_id) ?? null,
      confidenceScore: action.confidence_assessment.score,
      replayable: action.provenance.mode === "governed",
      replayReason: getActionReplayReason(action),
    }));

  const sourceActionCount = actions.length;
  const replayableActionCount = actions.filter((action) => action.replayable).length;
  const skippedActionCount = sourceActionCount - replayableActionCount;
  const pendingApprovalCount = source.events.filter((event) => event.event_type === "approval.requested").length;
  const connectorAvailability = getRepositoryConnectorAvailability(
    workspaceId,
    owner,
    name,
    source.repository.metadata.root,
  );

  let replayMode: RunReplayPreview["replayMode"] = "exact";
  let replayReason: string | null = null;
  if (sourceActionCount === 0 || replayableActionCount === 0) {
    replayMode = "preview_only";
    replayReason = "This run has no governed action inputs that can be re-executed safely.";
  } else if (replayableActionCount < sourceActionCount) {
    replayMode = "partial";
    replayReason = "Only governed actions can be replayed. Observed or imported steps will be skipped.";
  }

  let helperSummary: string | null = null;
  try {
    const helper = await withWorkspaceAuthorityClient(workspaceId, (client) =>
      client.queryHelper(runId, "run_summary"),
    );
    helperSummary = helper.answer;
  } catch {
    helperSummary = null;
  }

  return RunReplayPreviewSchema.parse({
    sourceRunId: runId,
    workflowName: source.runSummary.workflow_name,
    connectorStatus: connectorAvailability.status,
    connectorStatusReason: connectorAvailability.reason,
    connectorId: connectorAvailability.connectorId,
    connectorMachineName: connectorAvailability.machineName,
    replayMode,
    sourceActionCount,
    replayableActionCount,
    skippedActionCount,
    pendingApprovalCount,
    summary: buildRunReplaySummary({
      workflowName: source.runSummary.workflow_name,
      sourceActionCount,
      replayableActionCount,
      skippedActionCount,
      pendingApprovalCount,
    }),
    helperSummary,
    replayReason,
    actions,
  });
}

export async function queueRunReplay(
  workspaceSession: WorkspaceSession,
  owner: string,
  name: string,
  runId: string,
): Promise<RunReplayQueuedResponse | null> {
  const preview = await getRunReplayPreview(owner, name, workspaceSession.activeWorkspace.id, runId);
  if (!preview) {
    return null;
  }

  if (!preview.connectorId || preview.connectorStatus !== "active") {
    throw new RunReplayAccessError(
      preview.connectorStatusReason ?? "An active connector is required before this run can be replayed.",
      409,
    );
  }

  if (preview.replayMode === "preview_only" || preview.replayableActionCount === 0) {
    throw new RunReplayAccessError(preview.replayReason ?? "This run cannot be replayed.", 409);
  }

  const queuedAt = new Date().toISOString();
  const response = queueConnectorCommand(
    workspaceSession,
    preview.connectorId,
    {
      type: "replay_run",
      sourceRunId: runId,
      replayWorkflowName: `${preview.workflowName} replay`,
    },
    queuedAt,
  );

  return RunReplayQueuedResponseSchema.parse({
    sourceRunId: runId,
    connectorId: response.connectorId,
    commandId: response.commandId,
    queuedAt: response.queuedAt,
    message: response.message,
  });
}
