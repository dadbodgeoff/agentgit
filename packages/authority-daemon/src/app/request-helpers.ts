import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  parseDraftLabelLocator,
  parseDraftLocator,
  parseNoteLocator,
  parseTicketAssigneeLocator,
  parseTicketLabelLocator,
  parseTicketLocator,
} from "@agentgit/execution-adapters";
import { createActionBoundaryReviewPlan } from "@agentgit/recovery-engine";
import type { RunJournal, RunJournalEventRecord } from "@agentgit/run-journal";
import {
  type ActionRecord,
  ActionRecordSchema,
  NotFoundError,
  PreconditionError,
  type RecoveryPlan,
  type RecoveryTarget,
  type RunCheckpointKind,
} from "@agentgit/schemas";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function getRequestContext(rawRequest: unknown): {
  request_id: string;
  session_id: string | undefined;
} {
  if (!isObject(rawRequest)) {
    return {
      request_id: "req_unknown",
      session_id: undefined,
    };
  }

  const requestId =
    typeof rawRequest.request_id === "string" && rawRequest.request_id.length > 0
      ? rawRequest.request_id
      : "req_unknown";
  const sessionId =
    typeof rawRequest.session_id === "string" && rawRequest.session_id.length > 0 ? rawRequest.session_id : undefined;

  return {
    request_id: requestId,
    session_id: sessionId,
  };
}

export function normalizeRecoveryTarget(payload: { snapshot_id?: string; target?: RecoveryTarget }): RecoveryTarget {
  if (payload.target) {
    return payload.target;
  }

  return {
    type: "snapshot_id",
    snapshot_id: payload.snapshot_id as string,
  };
}

export function eventPayloadRecord(event: RunJournalEventRecord): Record<string, unknown> {
  return isObject(event.payload) ? event.payload : {};
}

export function eventPayloadString(event: RunJournalEventRecord, key: string): string | null {
  const value = eventPayloadRecord(event)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function eventActionId(event: RunJournalEventRecord): string | null {
  return eventPayloadString(event, "action_id");
}

export function parseEventTimestampMillis(value: string): number {
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? 0 : millis;
}

export function parseRunCheckpointToken(runCheckpoint: string): { runId: string; sequence: number } {
  const separatorIndex = runCheckpoint.lastIndexOf("#");
  if (separatorIndex <= 0 || separatorIndex === runCheckpoint.length - 1) {
    throw new PreconditionError("Malformed run checkpoint target.", {
      run_checkpoint: runCheckpoint,
      expected_format: "<run_id>#<snapshot_sequence>",
    });
  }

  const runId = runCheckpoint.slice(0, separatorIndex);
  const sequence = Number.parseInt(runCheckpoint.slice(separatorIndex + 1), 10);
  if (!Number.isInteger(sequence) || sequence <= 0) {
    throw new PreconditionError("Malformed run checkpoint target.", {
      run_checkpoint: runCheckpoint,
      expected_format: "<run_id>#<snapshot_sequence>",
    });
  }

  return { runId, sequence };
}

export function buildSyntheticCheckpointAction(params: {
  run_id: string;
  session_id: string;
  workspace_root: string;
  checkpoint_kind: RunCheckpointKind;
  reason?: string;
}): ActionRecord {
  const now = new Date().toISOString();
  const checkpointLabel = params.checkpoint_kind === "hard_checkpoint" ? "hard checkpoint" : "checkpoint";
  return ActionRecordSchema.parse({
    schema_version: "action.v1",
    action_id: `act_checkpoint_${randomUUID().replaceAll("-", "")}`,
    run_id: params.run_id,
    session_id: params.session_id,
    status: "normalized",
    timestamps: {
      requested_at: now,
      normalized_at: now,
    },
    provenance: {
      mode: "governed",
      source: "authority_daemon.checkpoint",
      confidence: 1,
    },
    actor: {
      type: "system",
      tool_name: "agentgit_checkpoint",
      tool_kind: "function",
    },
    operation: {
      domain: "filesystem",
      kind: "checkpoint_workspace",
      name: "checkpoint_workspace",
      display_name: `Create ${checkpointLabel}`,
    },
    execution_path: {
      surface: "observer",
      mode: "imported",
      credential_mode: "none",
    },
    target: {
      primary: {
        type: "workspace",
        locator: params.workspace_root,
        label: path.basename(params.workspace_root),
      },
      scope: {
        breadth: "workspace",
        estimated_count: 1,
        unknowns: [],
      },
    },
    input: {
      raw: {
        checkpoint_kind: params.checkpoint_kind,
        ...(params.reason ? { reason: params.reason } : {}),
      },
      redacted: {
        checkpoint_kind: params.checkpoint_kind,
        ...(params.reason ? { reason: params.reason } : {}),
      },
      schema_ref: null,
      contains_sensitive_data: false,
    },
    risk_hints: {
      side_effect_level: "read_only",
      external_effects: "none",
      reversibility_hint: "reversible",
      sensitivity_hint: "moderate",
      batch: false,
    },
    facets: {
      checkpoint_kind: params.checkpoint_kind,
      ...(params.reason ? { checkpoint_reason: params.reason } : {}),
    },
    normalization: {
      mapper: "authority_daemon.synthetic_checkpoint",
      inferred_fields: [],
      warnings: [],
      normalization_confidence: 1,
    },
    confidence_assessment: {
      engine_version: "authority_daemon.synthetic_checkpoint.v1",
      score: 1,
      band: "high",
      requires_human_review: false,
      factors: [
        {
          factor_id: "synthetic_checkpoint",
          label: "Synthetic checkpoint request",
          kind: "baseline",
          delta: 1,
          rationale: "AgentGit created this deliberate recovery boundary directly.",
        },
      ],
    },
  });
}

export function canonicalExternalObject(locator: string): { externalObjectId: string; canonicalLocator: string } | null {
  const draftLabel = parseDraftLabelLocator(locator);
  if (draftLabel) {
    return {
      externalObjectId: draftLabel.draftId,
      canonicalLocator: `drafts://message_draft/${draftLabel.draftId}`,
    };
  }

  const draftId = parseDraftLocator(locator);
  if (draftId) {
    return {
      externalObjectId: draftId,
      canonicalLocator: `drafts://message_draft/${draftId}`,
    };
  }

  const noteId = parseNoteLocator(locator);
  if (noteId) {
    return {
      externalObjectId: noteId,
      canonicalLocator: `notes://workspace_note/${noteId}`,
    };
  }

  const ticketLabel = parseTicketLabelLocator(locator);
  if (ticketLabel) {
    return {
      externalObjectId: ticketLabel.ticketId,
      canonicalLocator: `tickets://issue/${ticketLabel.ticketId}`,
    };
  }

  const ticketAssignee = parseTicketAssigneeLocator(locator);
  if (ticketAssignee) {
    return {
      externalObjectId: ticketAssignee.ticketId,
      canonicalLocator: `tickets://issue/${ticketAssignee.ticketId}`,
    };
  }

  const ticketId = parseTicketLocator(locator);
  if (ticketId) {
    return {
      externalObjectId: ticketId,
      canonicalLocator: `tickets://issue/${ticketId}`,
    };
  }

  return null;
}

export interface ActionBoundaryContext {
  runId: string;
  actionId: string;
  normalizedEvent: RunJournalEventRecord;
  snapshotId: string | null;
  laterActionsAffected: number;
  overlappingPaths: string[];
}

export interface RunCheckpointContext {
  runId: string;
  actionId: string | null;
  snapshotId: string;
  sequence: number;
}

function findSnapshotBoundaryContext(
  journal: RunJournal,
  runId: string,
  sequence: number,
  errorContext: Record<string, unknown>,
): RunCheckpointContext {
  const runSummary = journal.getRunSummary(runId);
  if (!runSummary) {
    throw new NotFoundError(`No run found for ${runId}.`, {
      run_id: runId,
      ...errorContext,
    });
  }

  const checkpointEvent = journal
    .listRunEvents(runId)
    .find((event) => event.sequence === sequence && event.event_type === "snapshot.created");
  if (!checkpointEvent) {
    throw new NotFoundError(`No persisted checkpoint found for run ${runId} at sequence ${sequence}.`, {
      run_id: runId,
      sequence,
      ...errorContext,
    });
  }

  const snapshotId = eventPayloadString(checkpointEvent, "snapshot_id");
  if (!snapshotId) {
    throw new PreconditionError("Checkpoint does not reference a persisted snapshot.", {
      run_id: runId,
      sequence,
      ...errorContext,
    });
  }

  return {
    runId,
    actionId: eventActionId(checkpointEvent),
    snapshotId,
    sequence,
  };
}

export function findActionBoundaryContext(journal: RunJournal, actionId: string): ActionBoundaryContext {
  for (const run of journal.listAllRuns()) {
    const events = journal.listRunEvents(run.run_id);
    const normalizedEvent = events.find(
      (event) => event.event_type === "action.normalized" && eventActionId(event) === actionId,
    );

    if (!normalizedEvent) {
      continue;
    }

    const snapshotCreatedEvent =
      events.find((event) => event.event_type === "snapshot.created" && eventActionId(event) === actionId) ?? null;
    const snapshotId = snapshotCreatedEvent ? eventPayloadString(snapshotCreatedEvent, "snapshot_id") : null;
    const targetLocator = eventPayloadString(normalizedEvent, "target_locator");
    const laterActionIds = new Set<string>();

    for (const event of events) {
      if (event.sequence <= normalizedEvent.sequence || event.event_type !== "action.normalized") {
        continue;
      }

      const laterActionId = eventActionId(event);
      if (!laterActionId || laterActionId === actionId) {
        continue;
      }

      const laterTargetLocator = eventPayloadString(event, "target_locator");
      if (targetLocator && laterTargetLocator === targetLocator) {
        laterActionIds.add(laterActionId);
      }
    }

    return {
      runId: run.run_id,
      actionId,
      normalizedEvent,
      snapshotId,
      laterActionsAffected: laterActionIds.size,
      overlappingPaths: targetLocator && laterActionIds.size > 0 ? [targetLocator] : [],
    };
  }

  throw new NotFoundError(`No recovery boundary found for action ${actionId}.`, {
    action_id: actionId,
  });
}

export function findExternalObjectBoundaryContext(journal: RunJournal, externalObjectId: string): ActionBoundaryContext {
  let latestMatch: {
    actionId: string;
    occurredAtMillis: number;
    recordedAtMillis: number;
    sequence: number;
  } | null = null;
  const matchingLocators = new Set<string>();

  for (const run of journal.listAllRuns()) {
    const events = journal.listRunEvents(run.run_id);

    for (const event of events) {
      if (event.event_type !== "action.normalized") {
        continue;
      }

      const actionId = eventActionId(event);
      const targetLocator = eventPayloadString(event, "target_locator");
      if (!actionId || !targetLocator) {
        continue;
      }

      const resolvedObject = canonicalExternalObject(targetLocator);
      if (!resolvedObject || resolvedObject.externalObjectId !== externalObjectId) {
        continue;
      }

      matchingLocators.add(resolvedObject.canonicalLocator);

      const candidate = {
        actionId,
        occurredAtMillis: parseEventTimestampMillis(event.occurred_at),
        recordedAtMillis: parseEventTimestampMillis(event.recorded_at),
        sequence: event.sequence,
      };

      if (
        !latestMatch ||
        candidate.occurredAtMillis > latestMatch.occurredAtMillis ||
        (candidate.occurredAtMillis === latestMatch.occurredAtMillis &&
          candidate.recordedAtMillis > latestMatch.recordedAtMillis) ||
        (candidate.occurredAtMillis === latestMatch.occurredAtMillis &&
          candidate.recordedAtMillis === latestMatch.recordedAtMillis &&
          candidate.sequence > latestMatch.sequence)
      ) {
        latestMatch = candidate;
      }
    }
  }

  if (!latestMatch) {
    throw new NotFoundError(`No recovery boundary found for external object ${externalObjectId}.`, {
      external_object_id: externalObjectId,
    });
  }

  if (matchingLocators.size > 1) {
    throw new PreconditionError("External object recovery target is ambiguous across multiple object families.", {
      external_object_id: externalObjectId,
      matching_locators: Array.from(matchingLocators).sort(),
    });
  }

  return findActionBoundaryContext(journal, latestMatch.actionId);
}

export function findRunCheckpointContext(journal: RunJournal, runCheckpoint: string): RunCheckpointContext {
  const parsed = parseRunCheckpointToken(runCheckpoint);
  return findSnapshotBoundaryContext(journal, parsed.runId, parsed.sequence, {
    run_checkpoint: runCheckpoint,
  });
}

export function findBranchPointContext(
  journal: RunJournal,
  target: Extract<RecoveryTarget, { type: "branch_point" }>,
): RunCheckpointContext {
  return findSnapshotBoundaryContext(journal, target.run_id, target.sequence, {
    branch_point: {
      run_id: target.run_id,
      sequence: target.sequence,
    },
  });
}

export function retargetRecoveryPlan(plan: RecoveryPlan, target: RecoveryTarget): RecoveryPlan {
  return {
    ...plan,
    target,
  };
}

export function createActionBoundaryPlan(journal: RunJournal, actionId: string): RecoveryPlan {
  const context = findActionBoundaryContext(journal, actionId);
  const operation = eventPayloadRecord(context.normalizedEvent).operation;
  const riskHints = eventPayloadRecord(context.normalizedEvent).risk_hints;
  const displayName =
    operation &&
    typeof operation === "object" &&
    typeof (operation as Record<string, unknown>).display_name === "string"
      ? ((operation as Record<string, unknown>).display_name as string)
      : null;

  return createActionBoundaryReviewPlan({
    action_id: actionId,
    target_locator: eventPayloadString(context.normalizedEvent, "target_locator") ?? `action:${actionId}`,
    operation_domain:
      operation && typeof operation === "object" && typeof (operation as Record<string, unknown>).domain === "string"
        ? ((operation as Record<string, unknown>).domain as string)
        : "unknown",
    display_name: displayName,
    side_effect_level:
      riskHints &&
      typeof riskHints === "object" &&
      typeof (riskHints as Record<string, unknown>).side_effect_level === "string"
        ? ((riskHints as Record<string, unknown>).side_effect_level as string)
        : null,
    external_effects:
      riskHints &&
      typeof riskHints === "object" &&
      typeof (riskHints as Record<string, unknown>).external_effects === "string"
        ? ((riskHints as Record<string, unknown>).external_effects as string)
        : null,
    reversibility_hint:
      riskHints &&
      typeof riskHints === "object" &&
      typeof (riskHints as Record<string, unknown>).reversibility_hint === "string"
        ? ((riskHints as Record<string, unknown>).reversibility_hint as string)
        : null,
    later_actions_affected: context.laterActionsAffected,
    overlapping_paths: context.overlappingPaths,
  });
}
