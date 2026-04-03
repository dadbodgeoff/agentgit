import { type RunJournal, type RunJournalEventRecord } from "@agentgit/run-journal";
import { type CachedCapabilityState } from "@agentgit/recovery-engine";
import { ActionRecordSchema, type ActionRecord } from "@agentgit/schemas";

export interface SnapshotRunRiskContext {
  recent_ambiguous_shell_mutations: number;
  recent_broad_mutation_actions: number;
  recent_review_or_blocked_mutations: number;
  recent_failed_mutations: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function eventPayloadRecord(event: RunJournalEventRecord): Record<string, unknown> {
  return isObject(event.payload) ? event.payload : {};
}

function eventPayloadString(event: RunJournalEventRecord, key: string): string | null {
  const value = eventPayloadRecord(event)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function eventActionId(event: RunJournalEventRecord): string | null {
  return eventPayloadString(event, "action_id");
}

function eventPayloadAction(event: RunJournalEventRecord): ActionRecord | null {
  const candidate = eventPayloadRecord(event).action;
  const parsed = ActionRecordSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function isMutatingAction(action: ActionRecord): boolean {
  return action.risk_hints.side_effect_level === "mutating" || action.risk_hints.side_effect_level === "destructive";
}

function isBroadMutationAction(action: ActionRecord): boolean {
  return (
    isMutatingAction(action) &&
    (action.target.scope.breadth === "workspace" ||
      action.target.scope.breadth === "repository" ||
      action.target.scope.breadth === "origin" ||
      action.target.scope.breadth === "external" ||
      action.target.scope.breadth === "unknown" ||
      action.target.scope.unknowns.length > 0)
  );
}

function isAmbiguousShellMutation(action: ActionRecord): boolean {
  if (action.operation.domain !== "shell" || !isMutatingAction(action)) {
    return false;
  }

  const shellFacet = typeof action.facets.shell === "object" && action.facets.shell !== null ? action.facets.shell : {};
  const commandFamily =
    typeof (shellFacet as { command_family?: unknown }).command_family === "string"
      ? (shellFacet as { command_family: string }).command_family
      : "unclassified";

  return (
    action.confidence_assessment.score < 0.8 ||
    action.normalization.normalization_confidence < 0.85 ||
    action.target.scope.breadth !== "single" ||
    action.target.scope.unknowns.length > 0 ||
    commandFamily === "unclassified" ||
    commandFamily === "package_manager" ||
    commandFamily === "build_tool"
  );
}

export function deriveSnapshotRunRiskContext(
  journal: RunJournal,
  runId: string,
  options: {
    exclude_action_id?: string;
  } = {},
): SnapshotRunRiskContext {
  const events = journal.listRunEvents(runId);
  const normalizedByActionId = new Map<string, ActionRecord>();
  let recentAmbiguousShellMutations = 0;
  let recentBroadMutationActions = 0;
  let recentReviewOrBlockedMutations = 0;
  let recentFailedMutations = 0;

  for (const event of events) {
    const actionId = eventActionId(event);
    if (actionId && options.exclude_action_id && actionId === options.exclude_action_id) {
      continue;
    }

    if (event.event_type === "action.normalized") {
      const action = eventPayloadAction(event);
      if (!action || !isMutatingAction(action)) {
        continue;
      }

      normalizedByActionId.set(action.action_id, action);
      if (isAmbiguousShellMutation(action)) {
        recentAmbiguousShellMutations += 1;
      }
      if (isBroadMutationAction(action)) {
        recentBroadMutationActions += 1;
      }
      continue;
    }

    if (event.event_type === "policy.evaluated") {
      const decision = eventPayloadString(event, "decision");
      if (decision !== "ask" && decision !== "deny") {
        continue;
      }

      const action = actionId ? normalizedByActionId.get(actionId) : null;
      if (action && isMutatingAction(action)) {
        recentReviewOrBlockedMutations += 1;
      }
      continue;
    }

    if (event.event_type === "execution.failed") {
      const action = actionId ? normalizedByActionId.get(actionId) : null;
      if (action && isMutatingAction(action)) {
        recentFailedMutations += 1;
      }
    }
  }

  return {
    recent_ambiguous_shell_mutations: recentAmbiguousShellMutations,
    recent_broad_mutation_actions: recentBroadMutationActions,
    recent_review_or_blocked_mutations: recentReviewOrBlockedMutations,
    recent_failed_mutations: recentFailedMutations,
  };
}

export function deriveSnapshotCapabilityState(
  cachedCapabilityState: CachedCapabilityState | null,
): "healthy" | "stale" | "degraded" {
  if (!cachedCapabilityState) {
    return "degraded";
  }

  if (cachedCapabilityState.is_stale) {
    return "stale";
  }

  const hasUnavailableCapability = cachedCapabilityState.capabilities.some(
    (capability) => capability.status === "unavailable",
  );
  if (hasUnavailableCapability || cachedCapabilityState.degraded_mode_warnings.length > 0) {
    return "degraded";
  }

  return "healthy";
}
