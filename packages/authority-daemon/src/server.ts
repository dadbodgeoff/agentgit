import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { normalizeActionAttempt } from "@agentgit/action-normalizer";
import { LocalEncryptedSecretStore, SessionCredentialBroker } from "@agentgit/credential-broker";
import {
  AdapterRegistry,
  FilesystemExecutionAdapter,
  FunctionExecutionAdapter,
  McpExecutionAdapter,
  OwnedDraftStore,
  OwnedNoteStore,
  OwnedTicketIntegration,
  OwnedTicketStore,
  parseDraftLabelLocator,
  parseDraftLocator,
  parseNoteLocator,
  parseTicketAssigneeLocator,
  parseTicketLabelLocator,
  parseTicketLocator,
  ShellExecutionAdapter,
} from "@agentgit/execution-adapters";
import {
  McpPublicHostPolicyRegistry,
  McpServerRegistry,
  validateMcpServerDefinitions,
} from "@agentgit/mcp-registry";
import { evaluatePolicy } from "@agentgit/policy-engine";
import {
  type CachedCapabilityState,
  StaticCompensationRegistry,
  createActionBoundaryReviewPlan,
  executePathSubsetRecovery,
  executeSnapshotRecovery,
  loadRecoverySnapshotManifest,
  planPathSubsetRecovery,
  planSnapshotRecovery,
} from "@agentgit/recovery-engine";
import { createRunJournal, type RunJournal, type RunJournalEventRecord } from "@agentgit/run-journal";
import { answerHelperQuery, projectTimelineView } from "@agentgit/timeline-helper";
import {
  API_VERSION,
  type ActionRecord,
  ActionRecordSchema,
  AgentGitError,
  type ApprovalRequest,
  type ApprovalInboxItem,
  type DaemonMethod,
  DiagnosticsRequestPayloadSchema,
  type DiagnosticsResponsePayload,
  type ErrorEnvelope,
  ExecuteRecoveryRequestPayloadSchema,
  type ExecuteRecoveryResponsePayload,
  GetCapabilitiesRequestPayloadSchema,
  type GetCapabilitiesResponsePayload,
  ListMcpHostPoliciesRequestPayloadSchema,
  type ListMcpHostPoliciesResponsePayload,
  ListMcpSecretsRequestPayloadSchema,
  type ListMcpSecretsResponsePayload,
  ListMcpServersRequestPayloadSchema,
  type ListMcpServersResponsePayload,
  type HelperQuestionType,
  GetRunSummaryRequestPayloadSchema,
  type GetRunSummaryResponsePayload,
  HelloRequestPayloadSchema,
  type HelloResponsePayload,
  InternalError,
  ListApprovalsRequestPayloadSchema,
  type ListApprovalsResponsePayload,
  RunMaintenanceRequestPayloadSchema,
  type RunMaintenanceResponsePayload,
  QueryApprovalInboxRequestPayloadSchema,
  type QueryApprovalInboxResponsePayload,
  NotFoundError,
  QueryHelperRequestPayloadSchema,
  type QueryHelperResponsePayload,
  QueryArtifactRequestPayloadSchema,
  type QueryArtifactResponsePayload,
  QueryTimelineRequestPayloadSchema,
  type QueryTimelineResponsePayload,
  PlanRecoveryRequestPayloadSchema,
  type PlanRecoveryResponsePayload,
  McpServerDefinitionSchema,
  type McpPublicHostPolicy,
  type McpServerDefinition,
  type McpSecretMetadata,
  RemoveMcpHostPolicyRequestPayloadSchema,
  type RemoveMcpHostPolicyResponsePayload,
  RemoveMcpSecretRequestPayloadSchema,
  type RemoveMcpSecretResponsePayload,
  RemoveMcpServerRequestPayloadSchema,
  type RemoveMcpServerResponsePayload,
  type PolicyOutcomeRecord,
  PolicyOutcomeRecordSchema,
  PreconditionError,
  type ReasonDetail,
  type RecoveryPlan,
  type RecoveryTarget,
  RegisterRunRequestPayloadSchema,
  type RegisterRunResponsePayload,
  ResolveApprovalRequestPayloadSchema,
  type ResolveApprovalResponsePayload,
  type RequestEnvelope,
  RequestEnvelopeSchema,
  type ResponseEnvelope,
  SCHEMA_PACK_VERSION,
  SubmitActionAttemptRequestPayloadSchema,
  type ExecutionArtifact,
  type TimelineStep,
  type SubmitActionAttemptResponsePayload,
  UpsertMcpHostPolicyRequestPayloadSchema,
  type UpsertMcpHostPolicyResponsePayload,
  UpsertMcpSecretRequestPayloadSchema,
  type UpsertMcpSecretResponsePayload,
  UpsertMcpServerRequestPayloadSchema,
  type UpsertMcpServerResponsePayload,
  ValidationError,
  validate,
  type VisibilityScope,
} from "@agentgit/schemas";
import { LocalSnapshotEngine } from "@agentgit/snapshot-engine";

import { AuthorityState } from "./state.js";

const METHODS: DaemonMethod[] = [
  "hello",
  "register_run",
  "get_run_summary",
  "get_capabilities",
  "list_mcp_servers",
  "upsert_mcp_server",
  "remove_mcp_server",
  "list_mcp_secrets",
  "upsert_mcp_secret",
  "remove_mcp_secret",
  "list_mcp_host_policies",
  "upsert_mcp_host_policy",
  "remove_mcp_host_policy",
  "diagnostics",
  "run_maintenance",
  "submit_action_attempt",
  "list_approvals",
  "query_approval_inbox",
  "resolve_approval",
  "query_timeline",
  "query_helper",
  "query_artifact",
  "plan_recovery",
  "execute_recovery",
];
const IDEMPOTENT_MUTATION_METHODS = new Set<DaemonMethod>([
  "register_run",
  "upsert_mcp_server",
  "remove_mcp_server",
  "upsert_mcp_secret",
  "remove_mcp_secret",
  "upsert_mcp_host_policy",
  "remove_mcp_host_policy",
  "run_maintenance",
  "submit_action_attempt",
  "resolve_approval",
  "execute_recovery",
]);
const RUNTIME_VERSION = "0.1.0";
const MAX_ARTIFACT_RESPONSE_CHARS = 8_192;
const CAPABILITY_REFRESH_STALE_MS = 5 * 60 * 1_000;
const HELPER_FACT_WARM_VISIBILITY_SCOPES: VisibilityScope[] = [
  "user",
  "model",
  "internal",
  "sensitive_internal",
];
const HELPER_FACT_WARM_RUN_QUESTIONS: HelperQuestionType[] = [
  "run_summary",
  "what_happened",
  "reversible_steps",
  "why_blocked",
  "likely_cause",
  "suggest_likely_cause",
  "identify_external_effects",
  "external_side_effects",
];
const HELPER_FACT_WARM_STEP_QUESTIONS: HelperQuestionType[] = [
  "step_details",
  "explain_policy_decision",
  "summarize_after_boundary",
  "what_changed_after_step",
  "revert_impact",
  "preview_revert_loss",
  "what_would_i_lose_if_i_revert_here",
  "list_actions_touching_scope",
];

interface HelperProjectionContext {
  visibility_scope: VisibilityScope;
  redactions_applied: number;
  preview_budget: QueryHelperResponsePayload["preview_budget"];
  steps: TimelineStep[];
  unavailable_artifacts_present: boolean;
  artifact_state_digest: string;
}

function resolveCapabilityRefreshStaleMs(options?: { capabilityRefreshStaleMs?: number | null }): number {
  if (typeof options?.capabilityRefreshStaleMs === "number") {
    return Math.max(0, options.capabilityRefreshStaleMs);
  }

  const configured = process.env.AGENTGIT_CAPABILITY_REFRESH_STALE_MS?.trim();
  if (!configured) {
    return CAPABILITY_REFRESH_STALE_MS;
  }

  const parsed = Number.parseInt(configured, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new InternalError("Capability refresh stale threshold must be a non-negative integer.", {
      configured_value: configured,
      env_var: "AGENTGIT_CAPABILITY_REFRESH_STALE_MS",
    });
  }

  return parsed;
}

function buildCachedCapabilityState(
  journal: RunJournal,
  runtimeOptions: Pick<StartServerOptions, "capabilityRefreshStaleMs">,
): CachedCapabilityState | null {
  const capabilitySnapshot = journal.getCapabilitySnapshot();
  if (capabilitySnapshot === null) {
    return null;
  }

  const capabilityRefreshStaleMs = resolveCapabilityRefreshStaleMs(runtimeOptions);
  const refreshedAtMillis = Date.parse(capabilitySnapshot.refreshed_at);

  return {
    capabilities: capabilitySnapshot.capabilities,
    degraded_mode_warnings: capabilitySnapshot.degraded_mode_warnings,
    refreshed_at: capabilitySnapshot.refreshed_at,
    stale_after_ms: capabilityRefreshStaleMs,
    is_stale: !Number.isNaN(refreshedAtMillis) && Date.now() - refreshedAtMillis > capabilityRefreshStaleMs,
  };
}

function capabilityReasonForRecord(capability: GetCapabilitiesResponsePayload["capabilities"][number]): ReasonDetail {
  switch (capability.capability_name) {
    case "workspace.root_access":
      return {
        code: capability.status === "unavailable" ? "WORKSPACE_CAPABILITY_UNAVAILABLE" : "WORKSPACE_CAPABILITY_DEGRADED",
        message: `Cached workspace access capability is ${capability.status}; governed workspace guarantees are not currently trustworthy.`,
      };
    case "host.runtime_storage":
      return {
        code:
          capability.status === "unavailable"
            ? "RUNTIME_STORAGE_CAPABILITY_UNAVAILABLE"
            : "RUNTIME_STORAGE_CAPABILITY_DEGRADED",
        message: `Cached runtime storage capability is ${capability.status}; durable snapshot and artifact guarantees are weakened.`,
      };
    case "adapter.tickets_brokered_credentials":
      return {
        code:
          capability.status === "unavailable"
            ? "BROKERED_CAPABILITY_UNAVAILABLE"
            : "BROKERED_CAPABILITY_DEGRADED",
        message: `Cached ticket broker capability is ${capability.status}; trusted brokered ticket execution is not currently available.`,
      };
    case "host.credential_broker_mode":
      return {
        code: "CREDENTIAL_BROKER_MODE_DEGRADED",
        message: "Credential brokering is operating in a degraded mode, so durable secure-store guarantees are reduced.",
      };
    default:
      return {
        code: capability.status === "unavailable" ? "CAPABILITY_UNAVAILABLE" : "CAPABILITY_DEGRADED",
        message: `Cached capability ${capability.capability_name} is ${capability.status}.`,
      };
  }
}

function primaryCapabilityReason(
  capabilitySnapshot: ReturnType<RunJournal["getCapabilitySnapshot"]>,
  capabilityRefreshStaleMs: number,
): ReasonDetail | null {
  if (!capabilitySnapshot) {
    return {
      code: "CAPABILITY_STATE_UNCACHED",
      message: "Capability state has not been refreshed durably yet.",
    };
  }

  const refreshedAtMillis = Date.parse(capabilitySnapshot.refreshed_at);
  if (!Number.isNaN(refreshedAtMillis) && Date.now() - refreshedAtMillis > capabilityRefreshStaleMs) {
    return {
      code: "CAPABILITY_STATE_STALE",
      message: "Latest capability refresh is stale; rerun capability_refresh if the host or workspace may have changed.",
    };
  }

  const firstUnavailable = capabilitySnapshot.capabilities.find((capability) => capability.status === "unavailable");
  if (firstUnavailable) {
    return capabilityReasonForRecord(firstUnavailable);
  }

  const firstDegraded = capabilitySnapshot.capabilities.find((capability) => capability.status === "degraded");
  if (firstDegraded) {
    return capabilityReasonForRecord(firstDegraded);
  }

  const firstWarning = capabilitySnapshot.degraded_mode_warnings[0];
  return firstWarning
    ? {
        code: "CAPABILITY_WARNING",
        message: firstWarning,
      }
    : null;
}

function primaryStorageReason(overview: ReturnType<RunJournal["getDiagnosticsOverview"]>): ReasonDetail | null {
  if (overview.maintenance_status.degraded_artifact_capture_actions > 0) {
    return {
      code: "DEGRADED_ARTIFACT_CAPTURE",
      message: `${overview.maintenance_status.degraded_artifact_capture_actions} action(s) completed with degraded durable evidence capture.`,
    };
  }

  if (overview.maintenance_status.low_disk_pressure_signals > 0) {
    return {
      code: "LOW_DISK_PRESSURE_OBSERVED",
      message: `${overview.maintenance_status.low_disk_pressure_signals} low-disk pressure signal(s) were recorded while storing evidence.`,
    };
  }

  if (overview.maintenance_status.artifact_health.missing > 0) {
    return {
      code: "ARTIFACT_BLOB_MISSING",
      message: `${overview.maintenance_status.artifact_health.missing} artifact blob(s) are missing.`,
    };
  }

  if (overview.maintenance_status.artifact_health.expired > 0) {
    return {
      code: "ARTIFACT_BLOB_EXPIRED",
      message: `${overview.maintenance_status.artifact_health.expired} artifact blob(s) have expired by retention policy.`,
    };
  }

  if (overview.maintenance_status.artifact_health.corrupted > 0) {
    return {
      code: "ARTIFACT_BLOB_CORRUPTED",
      message: `${overview.maintenance_status.artifact_health.corrupted} artifact blob(s) are structurally corrupted.`,
    };
  }

  if (overview.maintenance_status.artifact_health.tampered > 0) {
    return {
      code: "ARTIFACT_BLOB_TAMPERED",
      message: `${overview.maintenance_status.artifact_health.tampered} artifact blob(s) failed integrity verification.`,
    };
  }

  return null;
}

function makeSuccessResponse<TResult>(
  requestId: string,
  sessionId: string | undefined,
  result: TResult,
): ResponseEnvelope<TResult> {
  return {
    api_version: API_VERSION,
    request_id: requestId,
    session_id: sessionId,
    ok: true,
    result,
    error: null,
  };
}

function toErrorEnvelope(error: unknown): ErrorEnvelope {
  if (error instanceof AgentGitError) {
    return {
      ...error.toErrorEnvelope(),
      error_class: error instanceof ValidationError ? "validation_error" : error.name,
    };
  }

  const internalError = new InternalError("Unhandled daemon error.", {
    cause: error instanceof Error ? error.message : String(error),
  });

  return internalError.toErrorEnvelope();
}

function makeErrorResponse(
  requestId: string,
  sessionId: string | undefined,
  error: unknown,
): ResponseEnvelope<never> {
  return {
    api_version: API_VERSION,
    request_id: requestId,
    session_id: sessionId,
    ok: false,
    result: null,
    error: toErrorEnvelope(error),
  };
}

function replayStoredSuccessResponse(
  requestId: string,
  sessionId: string | undefined,
  response: ResponseEnvelope<unknown>,
): ResponseEnvelope<unknown> {
  return {
    ...response,
    request_id: requestId,
    session_id: sessionId ?? response.session_id,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function getRequestContext(rawRequest: unknown): {
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
    typeof rawRequest.session_id === "string" && rawRequest.session_id.length > 0
      ? rawRequest.session_id
      : undefined;

  return {
    request_id: requestId,
    session_id: sessionId,
  };
}

function validateActionRecord(data: unknown): ActionRecord {
  try {
    return validate(ActionRecordSchema, data);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new InternalError("Normalized action failed schema validation.", error.details);
    }

    throw error;
  }
}

function validatePolicyOutcomeRecord(data: unknown): PolicyOutcomeRecord {
  try {
    return validate(PolicyOutcomeRecordSchema, data);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new InternalError("Policy outcome failed schema validation.", error.details);
    }

    throw error;
  }
}

function normalizeRecoveryTarget(payload: {
  snapshot_id?: string;
  target?: RecoveryTarget;
}): RecoveryTarget {
  if (payload.target) {
    return payload.target;
  }

  return {
    type: "snapshot_id",
    snapshot_id: payload.snapshot_id as string,
  };
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

function parseEventTimestampMillis(value: string): number {
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? 0 : millis;
}

function parseRunCheckpointToken(runCheckpoint: string): { runId: string; sequence: number } {
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

function canonicalExternalObject(locator: string): { externalObjectId: string; canonicalLocator: string } | null {
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

interface ActionBoundaryContext {
  runId: string;
  actionId: string;
  normalizedEvent: RunJournalEventRecord;
  snapshotId: string | null;
  laterActionsAffected: number;
  overlappingPaths: string[];
}

interface RunCheckpointContext {
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

function findActionBoundaryContext(journal: RunJournal, actionId: string): ActionBoundaryContext {
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

function findExternalObjectBoundaryContext(journal: RunJournal, externalObjectId: string): ActionBoundaryContext {
  let latestMatch:
    | {
        actionId: string;
        occurredAtMillis: number;
        recordedAtMillis: number;
        sequence: number;
      }
    | null = null;
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

function findRunCheckpointContext(journal: RunJournal, runCheckpoint: string): RunCheckpointContext {
  const parsed = parseRunCheckpointToken(runCheckpoint);
  return findSnapshotBoundaryContext(journal, parsed.runId, parsed.sequence, {
    run_checkpoint: runCheckpoint,
  });
}

function findBranchPointContext(
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

function retargetRecoveryPlan(plan: RecoveryPlan, target: RecoveryTarget): RecoveryPlan {
  return {
    ...plan,
    target,
  };
}

function createActionBoundaryPlan(journal: RunJournal, actionId: string): RecoveryPlan {
  const context = findActionBoundaryContext(journal, actionId);
  const operation = eventPayloadRecord(context.normalizedEvent).operation;
  const riskHints = eventPayloadRecord(context.normalizedEvent).risk_hints;
  const displayName =
    operation && typeof operation === "object" && typeof (operation as Record<string, unknown>).display_name === "string"
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
      riskHints && typeof riskHints === "object" && typeof (riskHints as Record<string, unknown>).side_effect_level === "string"
        ? ((riskHints as Record<string, unknown>).side_effect_level as string)
        : null,
    external_effects:
      riskHints && typeof riskHints === "object" && typeof (riskHints as Record<string, unknown>).external_effects === "string"
        ? ((riskHints as Record<string, unknown>).external_effects as string)
        : null,
    reversibility_hint:
      riskHints && typeof riskHints === "object" && typeof (riskHints as Record<string, unknown>).reversibility_hint === "string"
        ? ((riskHints as Record<string, unknown>).reversibility_hint as string)
        : null,
    later_actions_affected: context.laterActionsAffected,
    overlapping_paths: context.overlappingPaths,
  });
}

function createCredentialBroker(options: {
  env?: NodeJS.ProcessEnv;
  mcpSecretStorePath?: string;
  mcpSecretKeyPath?: string;
} = {}): SessionCredentialBroker {
  const env = options.env ?? process.env;
  const mcpSecretStore =
    options.mcpSecretStorePath && options.mcpSecretKeyPath
      ? new LocalEncryptedSecretStore({
          dbPath: options.mcpSecretStorePath,
          keyPath: options.mcpSecretKeyPath,
        })
      : null;
  const broker = new SessionCredentialBroker({
    mcpSecretStore,
  });
  const ticketsBaseUrl = env.AGENTGIT_TICKETS_BASE_URL?.trim() ?? "";
  const ticketsToken = env.AGENTGIT_TICKETS_BEARER_TOKEN?.trim() ?? "";

  if (ticketsBaseUrl.length === 0 && ticketsToken.length === 0) {
    return broker;
  }

  if (ticketsBaseUrl.length === 0 || ticketsToken.length === 0) {
    throw new InternalError("Tickets broker configuration is incomplete.", {
      requires: ["AGENTGIT_TICKETS_BASE_URL", "AGENTGIT_TICKETS_BEARER_TOKEN"],
    });
  }

  broker.registerBearerProfile({
    integration: "tickets",
    profile_id: "credprof_tickets",
    base_url: ticketsBaseUrl,
    token: ticketsToken,
    scopes: ["tickets:write"],
  });
  return broker;
}

function createMcpServerRegistryFromEnv(env: NodeJS.ProcessEnv = process.env): McpServerDefinition[] {
  const rawConfig = env.AGENTGIT_MCP_SERVERS_JSON?.trim() ?? "";
  if (rawConfig.length === 0) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig);
  } catch (error) {
    throw new InternalError("MCP server registry configuration is not valid JSON.", {
      env_var: "AGENTGIT_MCP_SERVERS_JSON",
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    return validateMcpServerDefinitions(validate(McpServerDefinitionSchema.array(), parsed));
  } catch (error) {
    if (error instanceof AgentGitError) {
      throw new InternalError(error.message, {
        env_var: "AGENTGIT_MCP_SERVERS_JSON",
        ...(error.details ?? {}),
      });
    }

    throw error;
  }
}

function createOwnedCompensationRegistry(
  draftStore: OwnedDraftStore,
  noteStore: OwnedNoteStore,
  ticketIntegration: OwnedTicketIntegration,
): StaticCompensationRegistry {
  return new StaticCompensationRegistry([
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          (manifest.operation_kind === "update_ticket" || manifest.operation_kind === "restore_ticket") &&
          manifest.target_path.startsWith("tickets://issue/") &&
          Boolean(manifest.captured_preimage)
        );
      },
      buildCandidate({ manifest }) {
        const ticketId = parseTicketLocator(manifest.target_path) ?? `ticket_${manifest.action_id}`;

        return {
          strategy: "restore_owned_ticket_preimage",
          confidence: 0.84,
          steps: [
            {
              step_id: `step_restore_ticket_${ticketId}`,
              type: "restore_owned_ticket_preimage",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["ticket_restore"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned tickets integration"],
            objects_touched: [manifest.target_path],
            manual_steps: ["Verify the external ticket status, title, body, labels, and assignees match the captured preimage after recovery executes."],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const ticketId = parseTicketLocator(manifest.target_path) ?? `ticket_${manifest.action_id}`;
        if (!manifest.captured_preimage) {
          throw new PreconditionError("Owned ticket update recovery requires captured preimage metadata.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            ticket_id: ticketId,
          });
        }

        await ticketIntegration.restoreTicketFromSnapshot(ticketId, manifest.captured_preimage);
        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "delete_ticket" &&
          manifest.target_path.startsWith("tickets://issue/") &&
          Boolean(manifest.captured_preimage)
        );
      },
      buildCandidate({ manifest }) {
        const ticketId = parseTicketLocator(manifest.target_path) ?? `ticket_${manifest.action_id}`;

        return {
          strategy: "restore_owned_ticket_preimage",
          confidence: 0.85,
          steps: [
            {
              step_id: `step_restore_deleted_ticket_${ticketId}`,
              type: "restore_owned_ticket_preimage",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["ticket_restore"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned tickets integration"],
            objects_touched: [manifest.target_path],
            manual_steps: ["Verify the external ticket has been recreated with its prior status, labels, and assignees after recovery executes."],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const ticketId = parseTicketLocator(manifest.target_path) ?? `ticket_${manifest.action_id}`;
        if (!manifest.captured_preimage) {
          throw new PreconditionError("Owned ticket delete recovery requires captured preimage metadata.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            ticket_id: ticketId,
          });
        }

        await ticketIntegration.restoreTicketFromSnapshot(ticketId, manifest.captured_preimage);
        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "create_ticket" &&
          manifest.target_path.startsWith("tickets://issue/")
        );
      },
      buildCandidate({ manifest }) {
        const ticketId = parseTicketLocator(manifest.target_path) ?? `ticket_${manifest.action_id}`;

        return {
          strategy: "delete_owned_ticket",
          confidence: 0.83,
          steps: [
            {
              step_id: `step_delete_ticket_${ticketId}`,
              type: "delete_owned_ticket",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["ticket_delete"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned tickets integration"],
            objects_touched: [manifest.target_path],
            manual_steps: ["Verify the external ticket no longer exists after recovery executes."],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const ticketId = parseTicketLocator(manifest.target_path) ?? `ticket_${manifest.action_id}`;
        await ticketIntegration.deleteTicket(ticketId);
        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "close_ticket" &&
          manifest.target_path.startsWith("tickets://issue/")
        );
      },
      buildCandidate({ manifest }) {
        const ticketId = parseTicketLocator(manifest.target_path) ?? `ticket_${manifest.action_id}`;

        return {
          strategy: "reopen_owned_ticket",
          confidence: 0.82,
          steps: [
            {
              step_id: `step_reopen_ticket_${ticketId}`,
              type: "reopen_owned_ticket",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["ticket_reopen"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned tickets integration"],
            objects_touched: [manifest.target_path],
            manual_steps: ["Verify the external ticket is active again after recovery executes."],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const ticketId = parseTicketLocator(manifest.target_path) ?? `ticket_${manifest.action_id}`;
        await ticketIntegration.reopenTicket(ticketId);
        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "reopen_ticket" &&
          manifest.target_path.startsWith("tickets://issue/")
        );
      },
      buildCandidate({ manifest }) {
        const ticketId = parseTicketLocator(manifest.target_path) ?? `ticket_${manifest.action_id}`;

        return {
          strategy: "close_owned_ticket",
          confidence: 0.82,
          steps: [
            {
              step_id: `step_close_ticket_${ticketId}`,
              type: "close_owned_ticket",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["ticket_close"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned tickets integration"],
            objects_touched: [manifest.target_path],
            manual_steps: ["Verify the external ticket is closed after recovery executes."],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const ticketId = parseTicketLocator(manifest.target_path) ?? `ticket_${manifest.action_id}`;
        await ticketIntegration.closeTicket(ticketId);
        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "add_label" &&
          Boolean(parseTicketLabelLocator(manifest.target_path))
        );
      },
      buildCandidate({ manifest }) {
        const labelTarget = parseTicketLabelLocator(manifest.target_path);
        const ticketId = labelTarget?.ticketId ?? `ticket_${manifest.action_id}`;
        const label = labelTarget?.label ?? "unknown";

        return {
          strategy: "remove_owned_ticket_label",
          confidence: 0.88,
          steps: [
            {
              step_id: `step_remove_ticket_label_${ticketId}`,
              type: "remove_owned_ticket_label",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["ticket_label_remove"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned tickets integration"],
            objects_touched: [manifest.target_path],
            manual_steps: [`Verify label "${label}" is absent from the external ticket after recovery executes.`],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const labelTarget = parseTicketLabelLocator(manifest.target_path);
        if (!labelTarget) {
          throw new PreconditionError("Owned ticket label recovery requires a concrete label target.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            target_path: manifest.target_path,
          });
        }

        await ticketIntegration.removeLabel(labelTarget.ticketId, labelTarget.label);
        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "remove_label" &&
          Boolean(parseTicketLabelLocator(manifest.target_path))
        );
      },
      buildCandidate({ manifest }) {
        const labelTarget = parseTicketLabelLocator(manifest.target_path);
        const ticketId = labelTarget?.ticketId ?? `ticket_${manifest.action_id}`;
        const label = labelTarget?.label ?? "unknown";

        return {
          strategy: "add_owned_ticket_label",
          confidence: 0.88,
          steps: [
            {
              step_id: `step_add_ticket_label_${ticketId}`,
              type: "add_owned_ticket_label",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["ticket_label_add"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned tickets integration"],
            objects_touched: [manifest.target_path],
            manual_steps: [`Verify label "${label}" is present on the external ticket after recovery executes.`],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const labelTarget = parseTicketLabelLocator(manifest.target_path);
        if (!labelTarget) {
          throw new PreconditionError("Owned ticket label removal recovery requires a concrete label target.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            target_path: manifest.target_path,
          });
        }

        await ticketIntegration.addLabel(labelTarget.ticketId, labelTarget.label);
        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "assign_user" &&
          Boolean(parseTicketAssigneeLocator(manifest.target_path))
        );
      },
      buildCandidate({ manifest }) {
        const assigneeTarget = parseTicketAssigneeLocator(manifest.target_path);
        const ticketId = assigneeTarget?.ticketId ?? `ticket_${manifest.action_id}`;
        const userId = assigneeTarget?.userId ?? "unknown";

        return {
          strategy: "unassign_owned_ticket_user",
          confidence: 0.88,
          steps: [
            {
              step_id: `step_unassign_ticket_user_${ticketId}`,
              type: "unassign_owned_ticket_user",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["ticket_user_unassign"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned tickets integration"],
            objects_touched: [manifest.target_path],
            manual_steps: [`Verify user "${userId}" is no longer assigned to the external ticket after recovery executes.`],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const assigneeTarget = parseTicketAssigneeLocator(manifest.target_path);
        if (!assigneeTarget) {
          throw new PreconditionError("Owned ticket assignment recovery requires a concrete assignee target.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            target_path: manifest.target_path,
          });
        }

        await ticketIntegration.unassignUser(assigneeTarget.ticketId, assigneeTarget.userId);
        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "unassign_user" &&
          Boolean(parseTicketAssigneeLocator(manifest.target_path))
        );
      },
      buildCandidate({ manifest }) {
        const assigneeTarget = parseTicketAssigneeLocator(manifest.target_path);
        const ticketId = assigneeTarget?.ticketId ?? `ticket_${manifest.action_id}`;
        const userId = assigneeTarget?.userId ?? "unknown";

        return {
          strategy: "assign_owned_ticket_user",
          confidence: 0.88,
          steps: [
            {
              step_id: `step_assign_ticket_user_${ticketId}`,
              type: "assign_owned_ticket_user",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["ticket_user_assign"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned tickets integration"],
            objects_touched: [manifest.target_path],
            manual_steps: [`Verify user "${userId}" is assigned to the external ticket after recovery executes.`],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const assigneeTarget = parseTicketAssigneeLocator(manifest.target_path);
        if (!assigneeTarget) {
          throw new PreconditionError("Owned ticket unassignment recovery requires a concrete assignee target.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            target_path: manifest.target_path,
          });
        }

        await ticketIntegration.assignUser(assigneeTarget.ticketId, assigneeTarget.userId);
        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "create_note" &&
          manifest.target_path.startsWith("notes://workspace_note/")
        );
      },
      buildCandidate({ manifest }) {
        const noteId = parseNoteLocator(manifest.target_path) ?? `note_${manifest.action_id}`;

        return {
          strategy: "archive_owned_note",
          confidence: 0.79,
          steps: [
            {
              step_id: `step_archive_note_${noteId}`,
              type: "archive_owned_note",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["note_archive"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned notes integration"],
            objects_touched: [manifest.target_path],
            manual_steps: ["Verify the workspace note is archived in the owned notes store after recovery executes."],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const noteId = parseNoteLocator(manifest.target_path) ?? `note_${manifest.action_id}`;
        const archived = await noteStore.archiveNote(noteId);
        if (!archived) {
          throw new NotFoundError("Owned note no longer exists for compensating recovery.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            note_id: noteId,
          });
        }

        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "archive_note" &&
          manifest.target_path.startsWith("notes://workspace_note/")
        );
      },
      buildCandidate({ manifest }) {
        const noteId = parseNoteLocator(manifest.target_path) ?? `note_${manifest.action_id}`;

        return {
          strategy: "unarchive_owned_note",
          confidence: 0.8,
          steps: [
            {
              step_id: `step_unarchive_note_${noteId}`,
              type: "unarchive_owned_note",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["note_unarchive"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned notes integration"],
            objects_touched: [manifest.target_path],
            manual_steps: ["Verify the workspace note returns to active status after recovery executes."],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const noteId = parseNoteLocator(manifest.target_path) ?? `note_${manifest.action_id}`;
        const unarchived = await noteStore.unarchiveNote(noteId);
        if (!unarchived) {
          throw new NotFoundError("Owned note no longer exists for compensating recovery.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            note_id: noteId,
          });
        }

        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "unarchive_note" &&
          manifest.target_path.startsWith("notes://workspace_note/")
        );
      },
      buildCandidate({ manifest }) {
        const noteId = parseNoteLocator(manifest.target_path) ?? `note_${manifest.action_id}`;

        return {
          strategy: "archive_owned_note",
          confidence: 0.8,
          steps: [
            {
              step_id: `step_archive_note_${noteId}`,
              type: "archive_owned_note",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["note_archive"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned notes integration"],
            objects_touched: [manifest.target_path],
            manual_steps: ["Verify the workspace note is archived after recovery executes."],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const noteId = parseNoteLocator(manifest.target_path) ?? `note_${manifest.action_id}`;
        const archived = await noteStore.archiveNote(noteId);
        if (!archived) {
          throw new NotFoundError("Owned note no longer exists for compensating recovery.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            note_id: noteId,
          });
        }

        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          (manifest.operation_kind === "update_note" ||
            manifest.operation_kind === "restore_note" ||
            manifest.operation_kind === "delete_note") &&
          manifest.target_path.startsWith("notes://workspace_note/") &&
          Boolean(manifest.captured_preimage)
        );
      },
      buildCandidate({ manifest }) {
        const noteId = parseNoteLocator(manifest.target_path) ?? `note_${manifest.action_id}`;

        return {
          strategy: "restore_owned_note_preimage",
          confidence: 0.84,
          steps: [
            {
              step_id: `step_restore_note_${noteId}`,
              type: "restore_owned_note_preimage",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["note_restore"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned notes integration"],
            objects_touched: [manifest.target_path],
            manual_steps: ["Verify the workspace note title and body match the pre-update version after recovery executes."],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const noteId = parseNoteLocator(manifest.target_path) ?? `note_${manifest.action_id}`;
        if (!manifest.captured_preimage) {
          throw new PreconditionError("Owned note recovery requires captured preimage metadata.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            note_id: noteId,
          });
        }

        await noteStore.restoreNoteFromSnapshot(noteId, manifest.captured_preimage);
        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "add_label" &&
          Boolean(parseDraftLabelLocator(manifest.target_path))
        );
      },
      buildCandidate({ manifest }) {
        const labelTarget = parseDraftLabelLocator(manifest.target_path);
        const draftId = labelTarget?.draftId ?? `draft_${manifest.action_id}`;
        const label = labelTarget?.label ?? "unknown";

        return {
          strategy: "remove_owned_draft_label",
          confidence: 0.89,
          steps: [
            {
              step_id: `step_remove_label_${draftId}`,
              type: "remove_owned_draft_label",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["draft_label_remove"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned drafts integration"],
            objects_touched: [manifest.target_path],
            manual_steps: [`Verify label "${label}" is absent from the owned draft after recovery executes.`],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const labelTarget = parseDraftLabelLocator(manifest.target_path);
        if (!labelTarget) {
          throw new PreconditionError("Owned draft label recovery requires a concrete label target.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            target_path: manifest.target_path,
          });
        }

        const updated = await draftStore.removeLabel(labelTarget.draftId, labelTarget.label);
        if (!updated) {
          throw new NotFoundError("Owned draft no longer exists for compensating recovery.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            draft_id: labelTarget.draftId,
            label: labelTarget.label,
          });
        }

        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "remove_label" &&
          Boolean(parseDraftLabelLocator(manifest.target_path))
        );
      },
      buildCandidate({ manifest }) {
        const labelTarget = parseDraftLabelLocator(manifest.target_path);
        const draftId = labelTarget?.draftId ?? `draft_${manifest.action_id}`;
        const label = labelTarget?.label ?? "unknown";

        return {
          strategy: "add_owned_draft_label",
          confidence: 0.89,
          steps: [
            {
              step_id: `step_add_label_${draftId}`,
              type: "add_owned_draft_label",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["draft_label_add"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned drafts integration"],
            objects_touched: [manifest.target_path],
            manual_steps: [`Verify label "${label}" is present on the owned draft after recovery executes.`],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const labelTarget = parseDraftLabelLocator(manifest.target_path);
        if (!labelTarget) {
          throw new PreconditionError("Owned draft label removal recovery requires a concrete label target.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            target_path: manifest.target_path,
          });
        }

        const updated = await draftStore.addLabel(labelTarget.draftId, labelTarget.label);
        if (!updated) {
          throw new NotFoundError("Owned draft no longer exists for compensating recovery.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            draft_id: labelTarget.draftId,
            label: labelTarget.label,
          });
        }

        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "create_draft" &&
          manifest.target_path.startsWith("drafts://message_draft/")
        );
      },
      buildCandidate({ manifest }) {
        const draftId = parseDraftLocator(manifest.target_path) ?? `draft_${manifest.action_id}`;

        return {
          strategy: "archive_owned_draft",
          confidence: 0.78,
          steps: [
            {
              step_id: `step_archive_${draftId}`,
              type: "archive_owned_draft",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["draft_archive"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned drafts integration"],
            objects_touched: [manifest.target_path],
            manual_steps: ["Verify the draft remains archived in the owned drafts store after recovery executes."],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const draftId = parseDraftLocator(manifest.target_path) ?? `draft_${manifest.action_id}`;
        const archived = await draftStore.archiveDraft(draftId);
        if (!archived) {
          throw new NotFoundError("Owned draft no longer exists for compensating recovery.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            draft_id: draftId,
          });
        }

        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "archive_draft" &&
          manifest.target_path.startsWith("drafts://message_draft/")
        );
      },
      buildCandidate({ manifest }) {
        const draftId = parseDraftLocator(manifest.target_path) ?? `draft_${manifest.action_id}`;

        return {
          strategy: "unarchive_owned_draft",
          confidence: 0.81,
          steps: [
            {
              step_id: `step_unarchive_${draftId}`,
              type: "unarchive_owned_draft",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["draft_unarchive"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned drafts integration"],
            objects_touched: [manifest.target_path],
            manual_steps: ["Verify the draft returns to active status in the owned drafts store after recovery executes."],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const draftId = parseDraftLocator(manifest.target_path) ?? `draft_${manifest.action_id}`;
        const unarchived = await draftStore.unarchiveDraft(draftId);
        if (!unarchived) {
          throw new NotFoundError("Owned draft no longer exists for compensating recovery.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            draft_id: draftId,
          });
        }

        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "unarchive_draft" &&
          manifest.target_path.startsWith("drafts://message_draft/")
        );
      },
      buildCandidate({ manifest }) {
        const draftId = parseDraftLocator(manifest.target_path) ?? `draft_${manifest.action_id}`;

        return {
          strategy: "archive_owned_draft",
          confidence: 0.81,
          steps: [
            {
              step_id: `step_archive_${draftId}`,
              type: "archive_owned_draft",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["draft_archive"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned drafts integration"],
            objects_touched: [manifest.target_path],
            manual_steps: ["Verify the draft returns to archived status in the owned drafts store after recovery executes."],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const draftId = parseDraftLocator(manifest.target_path) ?? `draft_${manifest.action_id}`;
        const archived = await draftStore.archiveDraft(draftId);
        if (!archived) {
          throw new NotFoundError("Owned draft no longer exists for compensating recovery.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            draft_id: draftId,
          });
        }

        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "delete_draft" &&
          manifest.target_path.startsWith("drafts://message_draft/") &&
          Boolean(manifest.captured_preimage)
        );
      },
      buildCandidate({ manifest }) {
        const draftId = parseDraftLocator(manifest.target_path) ?? `draft_${manifest.action_id}`;

        return {
          strategy: "restore_owned_draft_preimage",
          confidence: 0.85,
          steps: [
            {
              step_id: `step_restore_deleted_${draftId}`,
              type: "restore_owned_draft_preimage",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["draft_restore"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned drafts integration"],
            objects_touched: [manifest.target_path],
            manual_steps: ["Verify the draft has been restored with its prior subject, body, labels, and status after recovery executes."],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const draftId = parseDraftLocator(manifest.target_path) ?? `draft_${manifest.action_id}`;
        if (!manifest.captured_preimage) {
          throw new PreconditionError("Owned draft delete recovery requires captured preimage metadata.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            draft_id: draftId,
          });
        }

        await draftStore.restoreDraftFromSnapshot(draftId, manifest.captured_preimage);
        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          (manifest.operation_kind === "update_draft" || manifest.operation_kind === "restore_draft") &&
          manifest.target_path.startsWith("drafts://message_draft/") &&
          Boolean(manifest.captured_preimage)
        );
      },
      buildCandidate({ manifest }) {
        const draftId = parseDraftLocator(manifest.target_path) ?? `draft_${manifest.action_id}`;

        return {
          strategy: "restore_owned_draft_preimage",
          confidence: 0.84,
          steps: [
            {
              step_id: `step_restore_${draftId}`,
              type: "restore_owned_draft_preimage",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["draft_restore"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned drafts integration"],
            objects_touched: [manifest.target_path],
            manual_steps: ["Verify the draft subject and body match the pre-update version after recovery executes."],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const draftId = parseDraftLocator(manifest.target_path) ?? `draft_${manifest.action_id}`;
        if (!manifest.captured_preimage) {
          throw new PreconditionError("Owned draft update recovery requires captured preimage metadata.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            draft_id: draftId,
          });
        }

        await draftStore.restoreDraftFromSnapshot(draftId, manifest.captured_preimage);
        return true;
      },
    },
  ]);
}

async function captureOwnedPreimage(
  action: ActionRecord,
  draftStore: OwnedDraftStore,
  noteStore: OwnedNoteStore,
  ticketStore: OwnedTicketStore,
): Promise<Record<string, unknown> | null> {
  if (action.operation.domain !== "function") {
    return null;
  }

  if (action.operation.kind === "update_draft") {
    const draftId = parseDraftLocator(action.target.primary.locator);
    if (!draftId) {
      return null;
    }

    const existing = await draftStore.getDraft(draftId);
    return existing ? { ...existing } : null;
  }

  if (action.operation.kind === "restore_draft" || action.operation.kind === "delete_draft") {
    const draftId = parseDraftLocator(action.target.primary.locator);
    if (!draftId) {
      return null;
    }

    const existing = await draftStore.getDraft(draftId);
    return existing ? { ...existing } : null;
  }

  if (
    action.operation.kind === "update_note" ||
    action.operation.kind === "restore_note" ||
    action.operation.kind === "delete_note"
  ) {
    const noteId = parseNoteLocator(action.target.primary.locator);
    if (!noteId) {
      return null;
    }

    const existing = await noteStore.getNote(noteId);
    return existing ? { ...existing } : null;
  }

  if (
    action.operation.kind === "update_ticket" ||
    action.operation.kind === "delete_ticket" ||
    action.operation.kind === "restore_ticket"
  ) {
    const ticketId = parseTicketLocator(action.target.primary.locator);
    if (!ticketId) {
      return null;
    }

    const existing = await ticketStore.getTicket(ticketId);
    return existing ? { ...existing } : null;
  }

  return null;
}

function handleHello(
  state: AuthorityState,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<HelloResponsePayload> {
  const payload = validate(HelloRequestPayloadSchema, request.payload);

  if (payload.requested_api_version !== API_VERSION) {
    throw new ValidationError(`Unsupported API version: ${payload.requested_api_version}`, {
      requested_api_version: payload.requested_api_version,
    });
  }

  const session = state.createSession(payload);

  return makeSuccessResponse(request.request_id, session.session_id, {
    session_id: session.session_id,
    accepted_api_version: API_VERSION,
    runtime_version: RUNTIME_VERSION,
    schema_pack_version: SCHEMA_PACK_VERSION,
    capabilities: {
      local_only: true,
      methods: METHODS,
    },
  });
}

function handleRegisterRun(
  state: AuthorityState,
  journal: RunJournal,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<RegisterRunResponsePayload> {
  const payload = validate(RegisterRunRequestPayloadSchema, request.payload);
  const session = state.getSession(request.session_id);

  if (!session) {
    throw new PreconditionError("A valid session_id is required before register_run.", {
      session_id: request.session_id,
    });
  }

  const run = state.createRun(session.session_id, payload);
  journal.registerRunLifecycle(run);

  return makeSuccessResponse(request.request_id, session.session_id, {
    run_id: run.run_id,
    run_handle: state.toRunHandle(run),
    effective_policy_profile: "local-default",
  });
}

function handleGetRunSummary(
  journal: RunJournal,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<GetRunSummaryResponsePayload> {
  const payload = validate(GetRunSummaryRequestPayloadSchema, request.payload);
  const runSummary = journal.getRunSummary(payload.run_id);

  if (!runSummary) {
    throw new NotFoundError(`No run found for ${payload.run_id}.`, {
      run_id: payload.run_id,
    });
  }

  return makeSuccessResponse(request.request_id, request.session_id, {
    run: runSummary,
  });
}

function canAccessPath(targetPath: string, mode: number): boolean {
  try {
    fs.accessSync(targetPath, mode);
    return true;
  } catch {
    return false;
  }
}

function canWriteDirectoryOrCreate(targetPath: string): boolean {
  if (fs.existsSync(targetPath)) {
    try {
      return fs.statSync(targetPath).isDirectory() && canAccessPath(targetPath, fs.constants.W_OK);
    } catch {
      return false;
    }
  }

  return canAccessPath(path.dirname(targetPath), fs.constants.W_OK);
}

function detectCapabilities(
  broker: SessionCredentialBroker,
  runtimeOptions: Pick<StartServerOptions, "socketPath" | "journalPath" | "snapshotRootPath">,
  mcpRegistry: McpServerRegistry,
  publicHostPolicyRegistry: McpPublicHostPolicyRegistry,
  workspaceRoot?: string,
): GetCapabilitiesResponsePayload {
  const startedAt = new Date().toISOString();
  const capabilities: GetCapabilitiesResponsePayload["capabilities"] = [];
  const degradedModeWarnings: string[] = [];

  const runtimeStorageWritable =
    canAccessPath(path.dirname(runtimeOptions.socketPath), fs.constants.W_OK) &&
    canAccessPath(path.dirname(runtimeOptions.journalPath), fs.constants.W_OK) &&
    canWriteDirectoryOrCreate(runtimeOptions.snapshotRootPath);
  capabilities.push({
    capability_name: "host.runtime_storage",
    status: runtimeStorageWritable ? "available" : "degraded",
    scope: "host",
    detected_at: startedAt,
    source: "authority_daemon",
    details: {
      socket_path: runtimeOptions.socketPath,
      journal_path: runtimeOptions.journalPath,
      snapshot_root_path: runtimeOptions.snapshotRootPath,
      writable: runtimeStorageWritable,
    },
  });
  if (!runtimeStorageWritable) {
    degradedModeWarnings.push("Local runtime storage is not fully writable; daemon behavior may degrade or fail closed.");
  }

  const credentialStoreDetails = broker.durableSecretStorageDetails();
  const credentialBrokerMode = broker.durableSecretStorageMode();
  const durableSecretStorageAvailable = broker.supportsDurableSecretStorage();
  capabilities.push({
    capability_name: "host.credential_broker_mode",
    status: durableSecretStorageAvailable ? "available" : "degraded",
    scope: "host",
    detected_at: startedAt,
    source: "authority_daemon",
    details: {
      mode: credentialBrokerMode,
      secure_store: durableSecretStorageAvailable,
      encrypted_at_rest: durableSecretStorageAvailable,
      key_path: credentialStoreDetails?.key_path ?? null,
      legacy_session_env_profiles_enabled: true,
    },
  });
  if (!durableSecretStorageAvailable) {
    degradedModeWarnings.push("Credential brokering is operating without durable MCP secret storage; only legacy session environment profiles are available.");
  }

  const ticketsConfigured = broker.hasProfile("tickets");
  capabilities.push({
    capability_name: "adapter.tickets_brokered_credentials",
    status: ticketsConfigured ? "available" : "unavailable",
    scope: "adapter",
    detected_at: startedAt,
    source: "session_env",
    details: {
      integration: "tickets",
      brokered_profile_configured: ticketsConfigured,
      required_env: ["AGENTGIT_TICKETS_BASE_URL", "AGENTGIT_TICKETS_BEARER_TOKEN"],
    },
  });
  if (!ticketsConfigured) {
    degradedModeWarnings.push("Owned ticket mutations are unavailable until brokered ticket credentials are configured.");
  }

  const registeredMcpServers = mcpRegistry.listServers();
  const registeredMcpToolCount = registeredMcpServers.reduce((total, record) => total + record.server.tools.length, 0);
  const transportCounts = {
    stdio: registeredMcpServers.filter((record) => record.server.transport === "stdio").length,
    streamable_http: registeredMcpServers.filter((record) => record.server.transport === "streamable_http").length,
  };
  const streamableHttpNetworkScopes = [
    ...new Set(
      registeredMcpServers
        .filter((record) => record.server.transport === "streamable_http")
        .map((record) => (record.server.transport === "streamable_http" ? record.server.network_scope ?? "loopback" : "loopback")),
    ),
  ];
  const bootstrapEnvServerCount = registeredMcpServers.filter((record) => record.source === "bootstrap_env").length;
  const operatorManagedServerCount = registeredMcpServers.filter((record) => record.source === "operator_api").length;
  const streamableHttpMissingAuth = registeredMcpServers
    .filter((record) => {
      if (record.server.transport !== "streamable_http") {
        return false;
      }

      return record.server.auth?.type === "bearer_env";
    })
    .filter((record) => {
      if (record.server.transport !== "streamable_http") {
        return false;
      }

      const envVar = record.server.auth?.type === "bearer_env" ? record.server.auth.bearer_env_var.trim() : "";
      return envVar.length > 0 && (process.env[envVar]?.trim() ?? "").length === 0;
    });
  const streamableHttpLegacyEnvAuthServers = registeredMcpServers.filter((record) => {
    return record.server.transport === "streamable_http" && record.server.auth?.type === "bearer_env";
  });
  const streamableHttpSecretRefServers = registeredMcpServers.filter((record) => {
    return record.server.transport === "streamable_http" && record.server.auth?.type === "bearer_secret_ref";
  });
  const streamableHttpMissingSecretRefs = streamableHttpSecretRefServers.filter((record) => {
    const server = record.server;
    const auth = server.transport === "streamable_http" ? server.auth : undefined;
    if (server.transport !== "streamable_http" || auth?.type !== "bearer_secret_ref") {
      return false;
    }

    return !broker.listMcpBearerSecrets().some((secret) => secret.secret_id === auth.secret_id);
  });
  const publicHttpsPolicyMismatches = registeredMcpServers.filter((record) => {
    if (record.server.transport !== "streamable_http" || (record.server.network_scope ?? "loopback") !== "public_https") {
      return false;
    }

    return publicHostPolicyRegistry.findPolicyForUrl(new URL(record.server.url)) === null;
  });

  capabilities.push({
    capability_name: "adapter.mcp_registry",
    status: "available",
    scope: "adapter",
    detected_at: startedAt,
    source: "mcp_registry",
    details: {
      registered_server_count: registeredMcpServers.length,
      registered_tool_count: registeredMcpToolCount,
      bootstrap_env_servers: bootstrapEnvServerCount,
      operator_managed_servers: operatorManagedServerCount,
      launch_scope: "local_operator_owned",
      transport_counts: transportCounts,
      streamable_http_network_scopes: streamableHttpNetworkScopes,
      registered_secret_count: broker.listMcpBearerSecrets().length,
      public_host_policy_count: publicHostPolicyRegistry.listPolicies().length,
      public_https_requirements: {
        https_only: true,
        bearer_secret_ref_recommended: true,
        supported_auth_types: ["bearer_secret_ref", "bearer_env"],
        disallowed_custom_headers: ["authorization", "proxy-authorization", "cookie"],
      },
    },
  });

  capabilities.push({
    capability_name: "adapter.mcp_streamable_http",
    status:
      streamableHttpMissingAuth.length > 0 ||
      streamableHttpMissingSecretRefs.length > 0 ||
      publicHttpsPolicyMismatches.length > 0 ||
      (streamableHttpSecretRefServers.length > 0 && !durableSecretStorageAvailable) ||
      streamableHttpLegacyEnvAuthServers.length > 0
        ? "degraded"
        : "available",
    scope: "adapter",
    detected_at: startedAt,
    source: "mcp_registry",
    details: {
      supported: true,
      launch_scope: "local_operator_owned",
      supported_network_scopes: ["loopback", "private", "public_https"],
      concurrency_limits_enforced: true,
      supported_auth_types: ["none", "bearer_secret_ref", "bearer_env"],
      durable_secret_storage_available: durableSecretStorageAvailable,
      public_https_requirements: {
        https_only: true,
        explicit_host_policy_required: true,
        bearer_secret_ref_recommended: true,
        disallowed_custom_headers: ["authorization", "proxy-authorization", "cookie"],
      },
      legacy_bearer_env_servers: streamableHttpLegacyEnvAuthServers.map((record) => record.server.server_id),
      missing_secret_ref_servers: streamableHttpMissingSecretRefs.map((record) => record.server.server_id),
      missing_public_host_policy_servers: publicHttpsPolicyMismatches.map((record) => record.server.server_id),
      registered_server_count: transportCounts.streamable_http,
      missing_bearer_env_servers: streamableHttpMissingAuth.map((record) => {
        if (record.server.transport !== "streamable_http") {
          return {
            server_id: record.server.server_id,
            bearer_env_var: null,
            network_scope: null,
            max_concurrent_calls: null,
          };
        }

        return {
          server_id: record.server.server_id,
          bearer_env_var: record.server.auth?.type === "bearer_env" ? record.server.auth.bearer_env_var : null,
          network_scope: record.server.network_scope ?? "loopback",
          max_concurrent_calls: record.server.max_concurrent_calls ?? 1,
        };
      }),
    },
  });

  if (streamableHttpMissingAuth.length > 0) {
    degradedModeWarnings.push(
      `Some registered streamable_http MCP servers are missing required bearer token env vars: ${streamableHttpMissingAuth
        .map((record) => record.server.server_id)
        .join(", ")}.`,
    );
  }
  if (streamableHttpLegacyEnvAuthServers.length > 0) {
    degradedModeWarnings.push(
      `Some registered streamable_http MCP servers still use legacy bearer_env authentication instead of durable secret references: ${streamableHttpLegacyEnvAuthServers
        .map((record) => record.server.server_id)
        .join(", ")}.`,
    );
  }
  if (streamableHttpMissingSecretRefs.length > 0) {
    degradedModeWarnings.push(
      `Some registered streamable_http MCP servers reference missing durable secret records: ${streamableHttpMissingSecretRefs
        .map((record) => record.server.server_id)
        .join(", ")}.`,
    );
  }
  if (publicHttpsPolicyMismatches.length > 0) {
    degradedModeWarnings.push(
      `Some registered public_https MCP servers are missing an active host allowlist policy: ${publicHttpsPolicyMismatches
        .map((record) => record.server.server_id)
        .join(", ")}.`,
    );
  }

  if (workspaceRoot) {
    const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
    const exists = fs.existsSync(resolvedWorkspaceRoot);
    const isDirectory = exists ? fs.statSync(resolvedWorkspaceRoot).isDirectory() : false;
    const readable = exists && isDirectory ? canAccessPath(resolvedWorkspaceRoot, fs.constants.R_OK) : false;
    const writable = exists && isDirectory ? canAccessPath(resolvedWorkspaceRoot, fs.constants.W_OK) : false;
    const status = exists && isDirectory && readable && writable ? "available" : "unavailable";

    capabilities.push({
      capability_name: "workspace.root_access",
      status,
      scope: "workspace",
      detected_at: startedAt,
      source: "filesystem_probe",
      details: {
        workspace_root: resolvedWorkspaceRoot,
        exists,
        is_directory: isDirectory,
        readable,
        writable,
      },
    });
    if (status !== "available") {
      degradedModeWarnings.push(`Workspace root ${resolvedWorkspaceRoot} is not available for governed read/write access.`);
    }
  }

  return {
    capabilities,
    detection_timestamps: {
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    },
    degraded_mode_warnings: [...new Set(degradedModeWarnings)],
  };
}

function handleGetCapabilities(
  broker: SessionCredentialBroker,
  runtimeOptions: Pick<StartServerOptions, "socketPath" | "journalPath" | "snapshotRootPath">,
  mcpRegistry: McpServerRegistry,
  publicHostPolicyRegistry: McpPublicHostPolicyRegistry,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<GetCapabilitiesResponsePayload> {
  const payload = validate(GetCapabilitiesRequestPayloadSchema, request.payload);
  return makeSuccessResponse(
    request.request_id,
    request.session_id,
    detectCapabilities(broker, runtimeOptions, mcpRegistry, publicHostPolicyRegistry, payload.workspace_root),
  );
}

function handleListMcpServers(
  mcpRegistry: McpServerRegistry,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<ListMcpServersResponsePayload> {
  validate(ListMcpServersRequestPayloadSchema, request.payload);
  return makeSuccessResponse(request.request_id, request.session_id, {
    servers: mcpRegistry.listServers(),
  });
}

function requireValidSession(
  state: AuthorityState,
  method:
    | "upsert_mcp_server"
    | "remove_mcp_server"
    | "upsert_mcp_secret"
    | "remove_mcp_secret"
    | "upsert_mcp_host_policy"
    | "remove_mcp_host_policy",
  sessionId: string | undefined,
): string {
  const session = state.getSession(sessionId);
  if (!session) {
    throw new PreconditionError(`A valid session_id is required before ${method}.`, {
      session_id: sessionId,
    });
  }

  return session.session_id;
}

function handleListMcpSecrets(
  broker: SessionCredentialBroker,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<ListMcpSecretsResponsePayload> {
  validate(ListMcpSecretsRequestPayloadSchema, request.payload);
  return makeSuccessResponse(request.request_id, request.session_id, {
    secrets: broker.listMcpBearerSecrets(),
  });
}

function handleUpsertMcpSecret(
  state: AuthorityState,
  broker: SessionCredentialBroker,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<UpsertMcpSecretResponsePayload> {
  const payload = validate(UpsertMcpSecretRequestPayloadSchema, request.payload);
  const sessionId = requireValidSession(state, "upsert_mcp_secret", request.session_id);
  const result = broker.upsertMcpBearerSecret(payload.secret);

  return makeSuccessResponse(request.request_id, sessionId, result);
}

function handleRemoveMcpSecret(
  state: AuthorityState,
  broker: SessionCredentialBroker,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<RemoveMcpSecretResponsePayload> {
  const payload = validate(RemoveMcpSecretRequestPayloadSchema, request.payload);
  const sessionId = requireValidSession(state, "remove_mcp_secret", request.session_id);
  const removedSecret = broker.removeMcpBearerSecret(payload.secret_id);

  return makeSuccessResponse(request.request_id, sessionId, {
    removed: removedSecret !== null,
    removed_secret: removedSecret,
  });
}

function handleListMcpHostPolicies(
  publicHostPolicyRegistry: McpPublicHostPolicyRegistry,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<ListMcpHostPoliciesResponsePayload> {
  validate(ListMcpHostPoliciesRequestPayloadSchema, request.payload);
  return makeSuccessResponse(request.request_id, request.session_id, {
    policies: publicHostPolicyRegistry.listPolicies(),
  });
}

function handleUpsertMcpHostPolicy(
  state: AuthorityState,
  publicHostPolicyRegistry: McpPublicHostPolicyRegistry,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<UpsertMcpHostPolicyResponsePayload> {
  const payload = validate(UpsertMcpHostPolicyRequestPayloadSchema, request.payload);
  const sessionId = requireValidSession(state, "upsert_mcp_host_policy", request.session_id);
  const result = publicHostPolicyRegistry.upsertPolicy(payload.policy as McpPublicHostPolicy);

  return makeSuccessResponse(request.request_id, sessionId, result);
}

function handleRemoveMcpHostPolicy(
  state: AuthorityState,
  publicHostPolicyRegistry: McpPublicHostPolicyRegistry,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<RemoveMcpHostPolicyResponsePayload> {
  const payload = validate(RemoveMcpHostPolicyRequestPayloadSchema, request.payload);
  const sessionId = requireValidSession(state, "remove_mcp_host_policy", request.session_id);
  const removedPolicy = publicHostPolicyRegistry.removePolicy(payload.host);

  return makeSuccessResponse(request.request_id, sessionId, {
    removed: removedPolicy !== null,
    removed_policy: removedPolicy,
  });
}

function handleUpsertMcpServer(
  state: AuthorityState,
  mcpRegistry: McpServerRegistry,
  broker: SessionCredentialBroker,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<UpsertMcpServerResponsePayload> {
  const payload = validate(UpsertMcpServerRequestPayloadSchema, request.payload);
  const sessionId = requireValidSession(state, "upsert_mcp_server", request.session_id);
  if (payload.server.transport === "streamable_http" && payload.server.auth?.type === "bearer_secret_ref") {
    broker.resolveMcpBearerSecret(payload.server.auth.secret_id);
  }
  const result = mcpRegistry.upsertServer(payload.server);

  return makeSuccessResponse(request.request_id, sessionId, result);
}

function handleRemoveMcpServer(
  state: AuthorityState,
  mcpRegistry: McpServerRegistry,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<RemoveMcpServerResponsePayload> {
  const payload = validate(RemoveMcpServerRequestPayloadSchema, request.payload);
  const sessionId = requireValidSession(state, "remove_mcp_server", request.session_id);
  const removedServer = mcpRegistry.removeServer(payload.server_id);

  return makeSuccessResponse(request.request_id, sessionId, {
    removed: removedServer !== null,
    removed_server: removedServer,
  });
}

function handleDiagnostics(
  state: AuthorityState,
  journal: RunJournal,
  runtimeOptions: Pick<StartServerOptions, "capabilityRefreshStaleMs">,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<DiagnosticsResponsePayload> {
  const payload = validate(DiagnosticsRequestPayloadSchema, request.payload);
  const requestedSections = new Set(
    payload.sections ?? ["daemon_health", "journal_health", "maintenance_backlog", "projection_lag", "storage_summary"],
  );
  const overview = journal.getDiagnosticsOverview();
  const capabilityHealthWarnings: string[] = [];
  const capabilityMaintenanceWarnings: string[] = [];
  const capabilitySnapshot = overview.capability_snapshot;
  const capabilityRefreshStaleMs = resolveCapabilityRefreshStaleMs(runtimeOptions);
  const capabilityPrimaryReason = primaryCapabilityReason(capabilitySnapshot, capabilityRefreshStaleMs);
  const storagePrimaryReason = primaryStorageReason(overview);
  let capabilitySummaryWarnings: string[] = [];
  let capabilitySummaryRefreshedAt: string | null = null;
  let capabilitySummaryWorkspaceRoot: string | null = null;
  let capabilitySummaryCount = 0;
  let capabilitySummaryDegraded = 0;
  let capabilitySummaryUnavailable = 0;
  let capabilitySummaryIsStale = false;

  if (!capabilitySnapshot) {
    capabilityMaintenanceWarnings.push(
      "Capability state has not been refreshed durably yet; run capability_refresh to cache current host and workspace capability state.",
    );
  } else {
    const degradedCount = capabilitySnapshot.capabilities.filter((capability) => capability.status === "degraded").length;
    const unavailableCount = capabilitySnapshot.capabilities.filter((capability) => capability.status === "unavailable").length;
    const refreshedAtMillis = Date.parse(capabilitySnapshot.refreshed_at);
    capabilitySummaryWarnings = [...capabilitySnapshot.degraded_mode_warnings];
    capabilitySummaryRefreshedAt = capabilitySnapshot.refreshed_at;
    capabilitySummaryWorkspaceRoot = capabilitySnapshot.workspace_root;
    capabilitySummaryCount = capabilitySnapshot.capabilities.length;
    capabilitySummaryDegraded = degradedCount;
    capabilitySummaryUnavailable = unavailableCount;

    if (!Number.isNaN(refreshedAtMillis) && Date.now() - refreshedAtMillis > capabilityRefreshStaleMs) {
      capabilitySummaryIsStale = true;
      capabilityHealthWarnings.push("Latest capability refresh is stale; rerun capability_refresh if the host or workspace may have changed.");
    }

    if (degradedCount > 0 || unavailableCount > 0) {
      capabilityHealthWarnings.push(
        `Latest capability refresh reported ${degradedCount} degraded and ${unavailableCount} unavailable capability record(s).`,
      );
    }

    capabilityHealthWarnings.push(...capabilitySnapshot.degraded_mode_warnings);
  }

  const storageWarnings: string[] = [];
  if (overview.maintenance_status.degraded_artifact_capture_actions > 0) {
    storageWarnings.push(
      `${overview.maintenance_status.degraded_artifact_capture_actions} action(s) completed with degraded durable evidence capture.`,
    );
  }
  if (overview.maintenance_status.low_disk_pressure_signals > 0) {
    storageWarnings.push(
      `${overview.maintenance_status.low_disk_pressure_signals} low-disk pressure signal(s) were recorded while storing evidence.`,
    );
  }
  if (overview.maintenance_status.artifact_health.missing > 0) {
    storageWarnings.push(`${overview.maintenance_status.artifact_health.missing} artifact blob(s) are missing.`);
  }
  if (overview.maintenance_status.artifact_health.expired > 0) {
    storageWarnings.push(`${overview.maintenance_status.artifact_health.expired} artifact blob(s) have expired by retention policy.`);
  }
  if (overview.maintenance_status.artifact_health.corrupted > 0) {
    storageWarnings.push(`${overview.maintenance_status.artifact_health.corrupted} artifact blob(s) are structurally corrupted.`);
  }
  if (overview.maintenance_status.artifact_health.tampered > 0) {
    storageWarnings.push(`${overview.maintenance_status.artifact_health.tampered} artifact blob(s) failed integrity verification.`);
  }

  const journalWarnings: string[] = [];
  if (storageWarnings.length > 0) {
    journalWarnings.push("Journal metadata is intact, but some durable execution evidence is unavailable or degraded.");
  }
  if (overview.pending_approvals > 0) {
    journalWarnings.push(`${overview.pending_approvals} approval request(s) remain unresolved.`);
  }

  const maintenanceWarnings: string[] = [];
  if (overview.maintenance_status.low_disk_pressure_signals > 0) {
    maintenanceWarnings.push(
      "Storage pressure has been observed, but no queued maintenance worker is tracking disk recovery at launch.",
    );
  }
  maintenanceWarnings.push(...capabilityMaintenanceWarnings, ...capabilityHealthWarnings);

  return makeSuccessResponse(request.request_id, request.session_id, {
    daemon_health: requestedSections.has("daemon_health")
      ? {
          status: storageWarnings.length > 0 || capabilityHealthWarnings.length > 0 ? "degraded" : "healthy",
          active_sessions: state.getSessionCount(),
          active_runs: state.getRunCount(),
          primary_reason: storagePrimaryReason ?? capabilityPrimaryReason,
          warnings: [
            ...(storageWarnings.length > 0
              ? ["Runtime is healthy enough to serve requests, but durable evidence health is degraded."]
              : []),
            ...capabilityHealthWarnings,
          ],
        }
      : null,
    journal_health: requestedSections.has("journal_health")
      ? {
          status: journalWarnings.length > 0 ? "degraded" : "healthy",
          total_runs: overview.total_runs,
          total_events: overview.total_events,
          pending_approvals: overview.pending_approvals,
          primary_reason:
            overview.pending_approvals > 0
              ? {
                  code: "PENDING_APPROVALS",
                  message: `${overview.pending_approvals} approval request(s) remain unresolved.`,
                }
              : storagePrimaryReason,
          warnings: journalWarnings,
        }
      : null,
    maintenance_backlog: requestedSections.has("maintenance_backlog")
      ? {
          pending_critical_jobs: 0,
          pending_maintenance_jobs: 0,
          oldest_pending_critical_job: null,
          current_heavy_job: null,
          snapshot_compaction_debt: null,
          primary_reason:
            overview.maintenance_status.low_disk_pressure_signals > 0
              ? {
                  code: "LOW_DISK_PRESSURE_OBSERVED",
                  message: `${overview.maintenance_status.low_disk_pressure_signals} low-disk pressure signal(s) were recorded while storing evidence.`,
                }
              : capabilityPrimaryReason,
          warnings: maintenanceWarnings,
        }
      : null,
    projection_lag: requestedSections.has("projection_lag")
      ? {
          projection_status: "fresh",
          lag_events: 0,
        }
      : null,
    storage_summary: requestedSections.has("storage_summary")
      ? {
          artifact_health: overview.maintenance_status.artifact_health,
          degraded_artifact_capture_actions: overview.maintenance_status.degraded_artifact_capture_actions,
          low_disk_pressure_signals: overview.maintenance_status.low_disk_pressure_signals,
          primary_reason: storagePrimaryReason,
          warnings: storageWarnings,
        }
      : null,
    capability_summary: requestedSections.has("capability_summary")
      ? {
          cached: capabilitySnapshot !== null,
          refreshed_at: capabilitySummaryRefreshedAt,
          workspace_root: capabilitySummaryWorkspaceRoot,
          capability_count: capabilitySummaryCount,
          degraded_capabilities: capabilitySummaryDegraded,
          unavailable_capabilities: capabilitySummaryUnavailable,
          stale_after_ms: capabilityRefreshStaleMs,
          is_stale: capabilitySummaryIsStale,
          primary_reason: capabilityPrimaryReason,
          warnings: capabilitySnapshot === null ? capabilityMaintenanceWarnings : capabilitySummaryWarnings,
        }
      : null,
  });
}

async function handleRunMaintenance(
  state: AuthorityState,
  journal: RunJournal,
  snapshotEngine: LocalSnapshotEngine,
  broker: SessionCredentialBroker,
  mcpRegistry: McpServerRegistry,
  publicHostPolicyRegistry: McpPublicHostPolicyRegistry,
  draftStore: OwnedDraftStore,
  noteStore: OwnedNoteStore,
  ticketStore: OwnedTicketStore,
  runtimeOptions: Pick<StartServerOptions, "socketPath" | "journalPath" | "snapshotRootPath">,
  request: RequestEnvelope<unknown>,
): Promise<ResponseEnvelope<RunMaintenanceResponsePayload>> {
  const payload = validate(RunMaintenanceRequestPayloadSchema, request.payload);
  const acceptedPriority = payload.priority_override ?? "administrative";
  const workspaceRoots = payload.scope?.workspace_root ? [payload.scope.workspace_root] : undefined;
  const jobs: RunMaintenanceResponsePayload["jobs"] = [];

  for (const jobType of payload.job_types) {
    switch (jobType) {
      case "startup_reconcile_runs": {
        const result = reconcilePersistedRuns(state, journal);
        jobs.push({
          job_type: jobType,
          status: "completed",
          performed_inline: true,
          summary:
            result.runs_considered > 0
              ? `Reconciled ${result.runs_considered} persisted run(s); rehydrated ${result.runs_rehydrated} run record(s) and ${result.sessions_rehydrated} session record(s).`
              : "No persisted runs were available for reconciliation.",
          stats: result,
        });
        break;
      }
      case "startup_reconcile_recoveries": {
        const reconciledActions = recoverInterruptedActions(journal);
        jobs.push({
          job_type: jobType,
          status: "completed",
          performed_inline: true,
          summary:
            reconciledActions > 0
              ? `Marked ${reconciledActions} interrupted action(s) as outcome_unknown for manual reconciliation.`
              : "No interrupted actions required recovery reconciliation.",
          stats: {
            reconciled_actions: reconciledActions,
          },
        });
        break;
      }
      case "artifact_expiry": {
        const expiredArtifacts = journal.enforceArtifactRetention();
        jobs.push({
          job_type: jobType,
          status: "completed",
          performed_inline: true,
          summary:
            expiredArtifacts > 0
              ? `Expired ${expiredArtifacts} durable artifact blob(s) by retention policy.`
              : "No durable artifacts were eligible for expiry.",
          stats: {
            expired_artifacts: expiredArtifacts,
          },
        });
        break;
      }
      case "artifact_orphan_cleanup": {
        const result = journal.cleanupOrphanedArtifacts();
        jobs.push({
          job_type: jobType,
          status: "completed",
          performed_inline: true,
          summary:
            result.orphaned_files_removed > 0
              ? `Removed ${result.orphaned_files_removed} orphaned artifact blob(s) and reclaimed ${result.bytes_freed} byte(s).`
              : result.files_scanned > 0
                ? `Scanned ${result.files_scanned} artifact blob(s) and found no orphaned files to remove.`
                : "No durable artifact blobs were present for orphan cleanup.",
          stats: {
            ...result,
          },
        });
        break;
      }
      case "snapshot_compaction": {
        const result = await snapshotEngine.compactSnapshots(workspaceRoots);
        jobs.push({
          job_type: jobType,
          status: "completed",
          performed_inline: true,
          summary:
            result.snaps_removed > 0
              ? `Compaction removed ${result.snaps_removed} snapshot layer(s) across ${result.workspaces_considered} workspace(s).`
              : result.workspaces_considered > 0
                ? `Snapshot compaction ran across ${result.workspaces_considered} workspace(s) and found nothing to flatten.`
                : "No workspace indexes were available for snapshot compaction.",
          stats: {
            ...result,
          },
        });
        break;
      }
      case "snapshot_rebase_anchor": {
        const result = await snapshotEngine.rebaseSyntheticAnchors(workspaceRoots);
        jobs.push({
          job_type: jobType,
          status: "completed",
          performed_inline: true,
          summary:
            result.anchors_rebased > 0
              ? `Rebased ${result.anchors_rebased} synthetic anchor reference(s) across ${result.workspaces_considered} workspace(s) and reclaimed ${result.bytes_freed} byte(s).`
              : result.workspaces_considered > 0
                ? `Synthetic anchor rebasing scanned ${result.snapshots_scanned} snapshot(s) across ${result.workspaces_considered} workspace(s) and found no duplicate anchors to rebase.`
                : "No workspace indexes were available for synthetic anchor rebasing.",
          stats: {
            ...result,
          },
        });
        break;
      }
      case "sqlite_wal_checkpoint": {
        const journalCheckpoint = journal.checkpointWal();
        const snapshotCheckpoint = snapshotEngine.checkpointWal(workspaceRoots);
        const draftCheckpoint = draftStore.checkpointWal();
        const noteCheckpoint = noteStore.checkpointWal();
        const ticketCheckpoint = ticketStore.checkpointWal();
        const mcpRegistryCheckpoint = mcpRegistry.checkpointWal();
        const mcpHostPolicyCheckpoint = publicHostPolicyRegistry.checkpointWal();
        const mcpSecretStoreCheckpoint = broker.checkpointMcpSecretStore();
        const checkpointedDatabases =
          (journalCheckpoint.checkpointed ? 1 : 0) +
          snapshotCheckpoint.checkpointed_databases +
          (mcpRegistryCheckpoint.checkpointed ? 1 : 0) +
          (mcpHostPolicyCheckpoint.checkpointed ? 1 : 0) +
          (mcpSecretStoreCheckpoint?.checkpointed ? 1 : 0) +
          (draftCheckpoint.checkpointed ? 1 : 0) +
          (noteCheckpoint.checkpointed ? 1 : 0) +
          (ticketCheckpoint.checkpointed ? 1 : 0);
        const skippedDatabases =
          (journalCheckpoint.checkpointed ? 0 : 1) +
          snapshotCheckpoint.skipped_databases +
          (mcpRegistryCheckpoint.checkpointed ? 0 : 1) +
          (mcpHostPolicyCheckpoint.checkpointed ? 0 : 1) +
          (mcpSecretStoreCheckpoint?.checkpointed ? 0 : 1) +
          (draftCheckpoint.checkpointed ? 0 : 1) +
          (noteCheckpoint.checkpointed ? 0 : 1) +
          (ticketCheckpoint.checkpointed ? 0 : 1);

        jobs.push({
          job_type: jobType,
          status: "completed",
          performed_inline: true,
          summary:
            checkpointedDatabases > 0
              ? `Checkpointed ${checkpointedDatabases} SQLite WAL database(s); skipped ${skippedDatabases} non-WAL database(s).`
              : `No SQLite databases required WAL checkpointing; skipped ${skippedDatabases} non-WAL database(s).`,
          stats: {
            checkpointed_databases: checkpointedDatabases,
            skipped_databases: skippedDatabases,
            journal: journalCheckpoint,
            snapshots: snapshotCheckpoint,
            mcp_registry: mcpRegistryCheckpoint,
            mcp_host_policies: mcpHostPolicyCheckpoint,
            mcp_secrets: mcpSecretStoreCheckpoint,
            drafts: draftCheckpoint,
            notes: noteCheckpoint,
            tickets: ticketCheckpoint,
          },
        });
        break;
      }
      case "projection_refresh":
      case "projection_rebuild": {
        jobs.push({
          job_type: jobType,
          status: "completed",
          performed_inline: true,
          summary: "Timeline and helper projections are derived fresh from the journal on read at launch, so no queued rebuild was required.",
          stats: {
            projection_status: "fresh",
            lag_events: 0,
          },
        });
        break;
      }
      case "snapshot_gc": {
        const result = await snapshotEngine.garbageCollectSnapshots(workspaceRoots);
        jobs.push({
          job_type: jobType,
          status: "completed",
          performed_inline: true,
          summary:
            result.layered_snapshots_removed > 0 || result.legacy_snapshots_removed > 0 || result.stray_entries_removed > 0
              ? `Removed ${result.layered_snapshots_removed + result.legacy_snapshots_removed} orphaned snapshot container(s), ${result.stray_entries_removed} stray snapshot entry(s), and reclaimed ${result.bytes_freed} byte(s).`
              : result.workspaces_considered > 0
                ? `Scanned ${result.workspaces_considered} workspace snapshot index(es) and found no orphaned snapshot storage to remove.`
                : "No persisted workspace snapshot indexes were available for snapshot garbage collection.",
          stats: {
            ...result,
          },
        });
        break;
      }
      case "helper_fact_warm": {
        journal.enforceArtifactRetention();
        const targetRuns = payload.scope?.run_id
          ? (() => {
              const runSummary = journal.getRunSummary(payload.scope.run_id);
              if (!runSummary) {
                throw new NotFoundError(`No run found for ${payload.scope.run_id}.`, {
                  run_id: payload.scope.run_id,
                });
              }

              return [runSummary];
            })()
          : journal.listAllRuns();
        let runsWarmed = 0;
        let visibilityScopesWarmed = 0;
        let stepsScanned = 0;
        let helperAnswersCached = 0;

        for (const runSummary of targetRuns) {
          const currentLatestSequence = latestRunSequence(runSummary);
          const artifactStateDigest = journal.getRunArtifactStateDigest(runSummary.run_id);

          for (const visibilityScope of HELPER_FACT_WARM_VISIBILITY_SCOPES) {
            const context = buildHelperProjectionContext(
              journal,
              runSummary.run_id,
              visibilityScope,
              artifactStateDigest,
            );
            visibilityScopesWarmed += 1;
            stepsScanned += context.steps.length;

            for (const questionType of HELPER_FACT_WARM_RUN_QUESTIONS) {
              journal.storeHelperFactCache({
                run_id: runSummary.run_id,
                question_type: questionType,
                focus_step_id: null,
                compare_step_id: null,
                visibility_scope: visibilityScope,
                event_count: runSummary.event_count,
                latest_sequence: currentLatestSequence,
                artifact_state_digest: artifactStateDigest,
                response: buildHelperResponseFromContext(questionType, context),
                warmed_at: new Date().toISOString(),
              });
              helperAnswersCached += 1;
            }

            for (const step of context.steps) {
              for (const questionType of HELPER_FACT_WARM_STEP_QUESTIONS) {
                journal.storeHelperFactCache({
                  run_id: runSummary.run_id,
                  question_type: questionType,
                  focus_step_id: step.step_id,
                  compare_step_id: null,
                  visibility_scope: visibilityScope,
                  event_count: runSummary.event_count,
                  latest_sequence: currentLatestSequence,
                  artifact_state_digest: artifactStateDigest,
                  response: buildHelperResponseFromContext(questionType, context, step.step_id),
                  warmed_at: new Date().toISOString(),
                });
                helperAnswersCached += 1;
              }
            }
          }

          runsWarmed += 1;
        }

        jobs.push({
          job_type: jobType,
          status: "completed",
          performed_inline: true,
          summary:
            targetRuns.length > 0
              ? `Warmed ${helperAnswersCached} helper answer(s) across ${runsWarmed} run(s) and ${visibilityScopesWarmed} visibility projection(s).`
              : "No runs were available for helper fact warming.",
          stats: {
            runs_considered: targetRuns.length,
            runs_warmed: runsWarmed,
            visibility_scopes_warmed: visibilityScopesWarmed,
            steps_scanned: stepsScanned,
            helper_answers_cached: helperAnswersCached,
          },
        });
        break;
      }
      case "capability_refresh": {
        const snapshot = detectCapabilities(
          broker,
          runtimeOptions,
          mcpRegistry,
          publicHostPolicyRegistry,
          payload.scope?.workspace_root,
        );
        const degradedCount = snapshot.capabilities.filter((capability) => capability.status === "degraded").length;
        const unavailableCount = snapshot.capabilities.filter((capability) => capability.status === "unavailable").length;
        journal.storeCapabilitySnapshot({
          ...snapshot,
          workspace_root: payload.scope?.workspace_root ?? null,
          refreshed_at: snapshot.detection_timestamps.completed_at,
        });
        jobs.push({
          job_type: jobType,
          status: "completed",
          performed_inline: true,
          summary: `Refreshed ${snapshot.capabilities.length} capability record(s); ${degradedCount} degraded and ${unavailableCount} unavailable.`,
          stats: {
            capability_count: snapshot.capabilities.length,
            degraded_capabilities: degradedCount,
            unavailable_capabilities: unavailableCount,
            refreshed_at: snapshot.detection_timestamps.completed_at,
            workspace_root: payload.scope?.workspace_root ?? null,
          },
        });
        break;
      }
      default: {
        jobs.push({
          job_type: jobType,
          status: "not_supported",
          performed_inline: false,
          summary: "This maintenance job is documented but not yet owned by the launch runtime.",
        });
        break;
      }
    }
  }

  return makeSuccessResponse(request.request_id, request.session_id, {
    accepted_priority: acceptedPriority,
    scope: payload.scope ?? null,
    jobs,
    stream_id: null,
  });
}

function enrichTimelineArtifactHealth(journal: RunJournal, steps: TimelineStep[]): TimelineStep[] {
  return steps.map((step) => {
    const primaryArtifacts = step.primary_artifacts.map((artifact) => {
      if (!artifact.artifact_id) {
        return artifact;
      }

      try {
        const storedArtifact = journal.getArtifact(artifact.artifact_id);
        return {
          ...artifact,
          artifact_status: storedArtifact.artifact_status,
          integrity: storedArtifact.integrity,
        };
      } catch (error) {
        if (error instanceof NotFoundError) {
          return {
            ...artifact,
            artifact_status: "missing" as const,
          };
        }

        throw error;
      }
    });

    const availabilityWarnings = primaryArtifacts
      .filter((artifact) => artifact.artifact_id && artifact.artifact_status && artifact.artifact_status !== "available")
      .map((artifact) =>
        artifact.artifact_status === "expired"
          ? `Artifact ${artifact.artifact_id} expired under the configured retention policy and is no longer available.`
          : artifact.artifact_status === "tampered"
            ? `Artifact ${artifact.artifact_id} failed content integrity verification and may have been tampered with.`
          : artifact.artifact_status === "corrupted"
            ? `Artifact ${artifact.artifact_id} is corrupted in durable storage and can no longer be read safely.`
          : `Artifact ${artifact.artifact_id} is missing from durable storage.`,
      );

    return {
      ...step,
      primary_artifacts: primaryArtifacts,
      warnings: [...(step.warnings ?? []), ...availabilityWarnings],
    };
  });
}

function latestRunSequence(runSummary: ReturnType<RunJournal["getRunSummary"]>): number {
  return runSummary?.latest_event?.sequence ?? 0;
}

function buildHelperProjectionContext(
  journal: RunJournal,
  runId: string,
  visibilityScope: VisibilityScope,
  artifactStateDigest?: string,
): HelperProjectionContext {
  const events = journal.listRunEvents(runId);
  const projection = projectTimelineView(runId, events, visibilityScope);
  const steps = enrichTimelineArtifactHealth(journal, projection.steps);

  return {
    visibility_scope: projection.visibility_scope,
    redactions_applied: projection.redactions_applied,
    preview_budget: projection.preview_budget,
    steps,
    unavailable_artifacts_present: steps.some((step) =>
      step.primary_artifacts.some((artifact) => artifact.artifact_status && artifact.artifact_status !== "available"),
    ),
    artifact_state_digest: artifactStateDigest ?? journal.getRunArtifactStateDigest(runId),
  };
}

function buildHelperResponseFromContext(
  questionType: HelperQuestionType,
  context: HelperProjectionContext,
  focusStepId?: string,
  compareStepId?: string,
): QueryHelperResponsePayload {
  const answer = answerHelperQuery(
    questionType,
    context.steps,
    focusStepId,
    compareStepId,
  );

  return {
    ...answer,
    visibility_scope: context.visibility_scope,
    redactions_applied: context.redactions_applied,
    preview_budget: context.preview_budget,
    uncertainty: [
      ...answer.uncertainty,
      ...(context.redactions_applied > 0
        ? [
            `Some details were redacted for ${context.visibility_scope} visibility.`,
          ]
        : []),
      ...(context.preview_budget.truncated_previews > 0 || context.preview_budget.omitted_previews > 0
        ? [
            `Some inline previews were truncated or omitted to stay within the response preview budget (${context.preview_budget.preview_chars_used}/${context.preview_budget.max_total_inline_preview_chars} chars used).`,
          ]
        : []),
      ...(context.unavailable_artifacts_present
        ? [
            "Some referenced artifacts are no longer available in durable storage because they expired, failed integrity verification, became corrupted, or went missing, so parts of the supporting evidence may be unavailable.",
          ]
        : []),
    ],
  };
}

function handleQueryTimeline(
  journal: RunJournal,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<QueryTimelineResponsePayload> {
  const payload = validate(QueryTimelineRequestPayloadSchema, request.payload);
  const runSummary = journal.getRunSummary(payload.run_id);

  if (!runSummary) {
    throw new NotFoundError(`No run found for ${payload.run_id}.`, {
      run_id: payload.run_id,
    });
  }

  journal.enforceArtifactRetention();
  const events = journal.listRunEvents(payload.run_id);
  const projection = projectTimelineView(payload.run_id, events, payload.visibility_scope ?? "user");
  const steps = enrichTimelineArtifactHealth(journal, projection.steps);

  return makeSuccessResponse(request.request_id, request.session_id, {
    run_summary: runSummary,
    steps,
    projection_status: "fresh",
    visibility_scope: projection.visibility_scope,
    redactions_applied: projection.redactions_applied,
    preview_budget: projection.preview_budget,
  });
}

function handleQueryHelper(
  journal: RunJournal,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<QueryHelperResponsePayload> {
  const payload = validate(QueryHelperRequestPayloadSchema, request.payload);
  const runSummary = journal.getRunSummary(payload.run_id);

  if (!runSummary) {
    throw new NotFoundError(`No run found for ${payload.run_id}.`, {
      run_id: payload.run_id,
    });
  }

  journal.enforceArtifactRetention();
  const visibilityScope = payload.visibility_scope ?? "user";
  const artifactStateDigest = journal.getRunArtifactStateDigest(payload.run_id);
  const cached = journal.getHelperFactCache({
    run_id: payload.run_id,
    question_type: payload.question_type,
    focus_step_id: payload.focus_step_id,
    compare_step_id: payload.compare_step_id,
    visibility_scope: visibilityScope,
  });
  const currentEventCount = runSummary.event_count;
  const currentLatestSequence = latestRunSequence(runSummary);

  if (
    cached &&
    cached.event_count === currentEventCount &&
    cached.latest_sequence === currentLatestSequence &&
    cached.artifact_state_digest === artifactStateDigest
  ) {
    return makeSuccessResponse(request.request_id, request.session_id, cached.response);
  }

  const context = buildHelperProjectionContext(journal, payload.run_id, visibilityScope, artifactStateDigest);
  const response = buildHelperResponseFromContext(
    payload.question_type,
    context,
    payload.focus_step_id,
    payload.compare_step_id,
  );
  journal.storeHelperFactCache({
    run_id: payload.run_id,
    question_type: payload.question_type,
    focus_step_id: payload.focus_step_id ?? null,
    compare_step_id: payload.compare_step_id ?? null,
    visibility_scope: visibilityScope,
    event_count: currentEventCount,
    latest_sequence: currentLatestSequence,
    artifact_state_digest: artifactStateDigest,
    response,
    warmed_at: new Date().toISOString(),
  });

  return makeSuccessResponse(request.request_id, request.session_id, response);
}

function handleQueryArtifact(
  journal: RunJournal,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<QueryArtifactResponsePayload> {
  const payload = validate(QueryArtifactRequestPayloadSchema, request.payload);
  const visibilityScope = payload.visibility_scope ?? "user";
  journal.enforceArtifactRetention();
  const artifact = journal.getArtifact(payload.artifact_id);

  const visibilityRank = (scope: QueryArtifactResponsePayload["visibility_scope"]): number => {
    switch (scope) {
      case "user":
        return 0;
      case "model":
        return 1;
      case "internal":
        return 2;
      case "sensitive_internal":
        return 3;
    }

    return 0;
  };

  if (visibilityRank(visibilityScope) < visibilityRank(artifact.visibility)) {
    throw new NotFoundError(`No artifact found for ${payload.artifact_id}.`, {
      artifact_id: payload.artifact_id,
    });
  }

  const content =
    artifact.content === null
      ? {
          content: "",
          content_truncated: false,
          returned_chars: 0,
          max_inline_chars: MAX_ARTIFACT_RESPONSE_CHARS,
        }
      : payload.full_content
        ? {
            content: artifact.content,
            content_truncated: false,
            returned_chars: artifact.content.length,
            max_inline_chars: MAX_ARTIFACT_RESPONSE_CHARS,
          }
        : clipArtifactContent(artifact.content);
  return makeSuccessResponse(request.request_id, request.session_id, {
    artifact: {
      artifact_id: artifact.artifact_id,
      run_id: artifact.run_id,
      action_id: artifact.action_id,
      execution_id: artifact.execution_id,
      type: artifact.type,
      content_ref: artifact.content_ref,
      byte_size: artifact.byte_size,
      integrity: artifact.integrity,
      visibility: artifact.visibility,
      expires_at: artifact.expires_at,
      expired_at: artifact.expired_at,
      created_at: artifact.created_at,
    },
    artifact_status: artifact.artifact_status,
    visibility_scope: visibilityScope,
    content_available: artifact.content !== null,
    content: content.content,
    content_truncated: content.content_truncated,
    returned_chars: content.returned_chars,
    max_inline_chars: content.max_inline_chars,
  });
}

function handleListApprovals(
  journal: RunJournal,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<ListApprovalsResponsePayload> {
  const payload = validate(ListApprovalsRequestPayloadSchema, request.payload);
  const approvals = journal.listApprovals({
    run_id: payload.run_id,
    status: payload.status,
  });

  return makeSuccessResponse(request.request_id, request.session_id, {
    approvals,
  });
}

function handleQueryApprovalInbox(
  journal: RunJournal,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<QueryApprovalInboxResponsePayload> {
  const payload = validate(QueryApprovalInboxRequestPayloadSchema, request.payload);
  const approvals = journal.listApprovals({
    run_id: payload.run_id,
    status: payload.status,
  });

  const items: ApprovalInboxItem[] = [];
  for (const approval of approvals) {
    const stored = journal.getStoredApproval(approval.approval_id);
    const run = journal.getRunSummary(approval.run_id);

    if (!stored || !run) {
      continue;
    }

    const firstReason = stored.policy_outcome.reasons[0];
    const reasonSummary = firstReason?.message ?? null;
    const target = stored.action.target.primary;

    items.push({
      approval_id: approval.approval_id,
      run_id: approval.run_id,
      workflow_name: run.workflow_name,
      action_id: approval.action_id,
      action_summary: approval.action_summary,
      action_domain: stored.action.operation.domain,
      side_effect_level: stored.action.risk_hints.side_effect_level,
      status: approval.status,
      requested_at: approval.requested_at,
      resolved_at: approval.resolved_at,
      resolution_note: approval.resolution_note,
      decision_requested: approval.decision_requested,
      snapshot_required: stored.policy_outcome.preconditions.snapshot_required,
      reason_summary: reasonSummary,
      primary_reason: firstReason
        ? {
            code: firstReason.code,
            message: firstReason.message,
          }
        : null,
      target_locator: target.locator,
      target_label: target.label ?? null,
    });
  }

  items.sort((left, right) => {
    if (left.status !== right.status) {
      if (left.status === "pending") return -1;
      if (right.status === "pending") return 1;
    }

    return right.requested_at.localeCompare(left.requested_at);
  });

  const counts = items.reduce(
    (accumulator, item) => {
      accumulator[item.status] += 1;
      return accumulator;
    },
    {
      pending: 0,
      approved: 0,
      denied: 0,
    },
  );

  return makeSuccessResponse(request.request_id, request.session_id, {
    items,
    counts,
  });
}

async function handleResolveApproval(
  journal: RunJournal,
  adapterRegistry: AdapterRegistry,
  snapshotEngine: LocalSnapshotEngine,
  draftStore: OwnedDraftStore,
  noteStore: OwnedNoteStore,
  ticketStore: OwnedTicketStore,
  request: RequestEnvelope<unknown>,
): Promise<ResponseEnvelope<ResolveApprovalResponsePayload>> {
  const payload = validate(ResolveApprovalRequestPayloadSchema, request.payload);
  const storedApproval = journal.getStoredApproval(payload.approval_id);

  if (!storedApproval) {
    throw new NotFoundError(`No approval found for ${payload.approval_id}.`, {
      approval_id: payload.approval_id,
    });
  }

  const approvalRequest = journal.resolveApproval(payload.approval_id, payload.resolution, payload.note);
  const resolvedAt = approvalRequest.resolved_at ?? new Date().toISOString();

  journal.appendRunEvent(storedApproval.run_id, {
    event_type: "approval.resolved",
    occurred_at: resolvedAt,
    recorded_at: resolvedAt,
    payload: {
      approval_id: approvalRequest.approval_id,
      action_id: approvalRequest.action_id,
      action_summary: approvalRequest.action_summary,
      resolution: approvalRequest.status,
      resolution_note: approvalRequest.resolution_note,
    },
  });

  if (approvalRequest.status !== "approved") {
    return makeSuccessResponse(request.request_id, request.session_id, {
      approval_request: approvalRequest,
      execution_result: null,
      snapshot_record: storedApproval.snapshot_record,
    });
  }

  const runSummary = journal.getRunSummary(storedApproval.run_id);
  if (!runSummary) {
    throw new NotFoundError(`No run found for ${storedApproval.run_id}.`, {
      run_id: storedApproval.run_id,
    });
  }

  const approvedPolicyOutcome: PolicyOutcomeRecord = {
    ...storedApproval.policy_outcome,
    decision: storedApproval.policy_outcome.preconditions.snapshot_required ? "allow_with_snapshot" : "allow",
    preconditions: {
      ...storedApproval.policy_outcome.preconditions,
      approval_required: false,
    },
  };

  const execution = await executeGovernedAction({
    action: storedApproval.action,
    policyOutcome: approvedPolicyOutcome,
    runSummary,
    journal,
    adapterRegistry,
    snapshotEngine,
    draftStore,
    noteStore,
    ticketStore,
  });

  return makeSuccessResponse(request.request_id, request.session_id, {
    approval_request: approvalRequest,
    execution_result: execution.executionResult,
    snapshot_record: execution.snapshotRecord,
  });
}

async function handlePlanRecovery(
  journal: RunJournal,
  snapshotEngine: LocalSnapshotEngine,
  compensationRegistry: StaticCompensationRegistry,
  runtimeOptions: Pick<StartServerOptions, "capabilityRefreshStaleMs">,
  request: RequestEnvelope<unknown>,
): Promise<ResponseEnvelope<PlanRecoveryResponsePayload>> {
  const payload = validate(PlanRecoveryRequestPayloadSchema, request.payload);
  const target = normalizeRecoveryTarget(payload);
  const cachedCapabilityState = buildCachedCapabilityState(journal, runtimeOptions);
  let recoveryPlan: RecoveryPlan;
  let runId: string;
  let snapshotIdForJournal: string | null = null;
  let actionIdForJournal: string | null = null;
  let runCheckpointForJournal: string | null = null;
  let branchPointRunIdForJournal: string | null = null;
  let branchPointSequenceForJournal: number | null = null;
  let subsetPathsForJournal: string[] | null = null;

  if (target.type === "snapshot_id") {
    recoveryPlan = await planSnapshotRecovery(snapshotEngine, target.snapshot_id, {
      compensation_registry: compensationRegistry,
      cached_capability_state: cachedCapabilityState,
    });
    const manifest = await loadRecoverySnapshotManifest(snapshotEngine, target.snapshot_id);
    runId = manifest.run_id;
    snapshotIdForJournal = target.snapshot_id;
  } else if (target.type === "path_subset") {
    recoveryPlan = await planPathSubsetRecovery(snapshotEngine, target, {
      cached_capability_state: cachedCapabilityState,
    });
    const manifest = await loadRecoverySnapshotManifest(snapshotEngine, target.snapshot_id);
    runId = manifest.run_id;
    snapshotIdForJournal = target.snapshot_id;
    actionIdForJournal = manifest.action_id;
    subsetPathsForJournal = [...target.paths];
  } else if (target.type === "branch_point") {
    const branchPointContext = findBranchPointContext(journal, target);
    recoveryPlan = retargetRecoveryPlan(
      await planSnapshotRecovery(snapshotEngine, branchPointContext.snapshotId, {
        compensation_registry: compensationRegistry,
        cached_capability_state: cachedCapabilityState,
      }),
      target,
    );
    runId = branchPointContext.runId;
    snapshotIdForJournal = branchPointContext.snapshotId;
    actionIdForJournal = branchPointContext.actionId;
    branchPointRunIdForJournal = target.run_id;
    branchPointSequenceForJournal = target.sequence;
  } else if (target.type === "run_checkpoint") {
    const checkpointContext = findRunCheckpointContext(journal, target.run_checkpoint);
    recoveryPlan = retargetRecoveryPlan(
      await planSnapshotRecovery(snapshotEngine, checkpointContext.snapshotId, {
        compensation_registry: compensationRegistry,
        cached_capability_state: cachedCapabilityState,
      }),
      target,
    );
    runId = checkpointContext.runId;
    snapshotIdForJournal = checkpointContext.snapshotId;
    actionIdForJournal = checkpointContext.actionId;
    runCheckpointForJournal = target.run_checkpoint;
  } else {
    const actionContext =
      target.type === "action_boundary"
        ? findActionBoundaryContext(journal, target.action_id)
        : findExternalObjectBoundaryContext(journal, target.external_object_id);
    actionIdForJournal = actionContext.actionId;

    if (actionContext.snapshotId) {
      recoveryPlan = retargetRecoveryPlan(
        await planSnapshotRecovery(snapshotEngine, actionContext.snapshotId, {
          compensation_registry: compensationRegistry,
          cached_capability_state: cachedCapabilityState,
        }),
        target,
      );
      snapshotIdForJournal = actionContext.snapshotId;
    } else {
      recoveryPlan = retargetRecoveryPlan(createActionBoundaryPlan(journal, actionContext.actionId), target);
    }

    runId = actionContext.runId;
  }

  journal.appendRunEvent(runId, {
    event_type: "recovery.planned",
    occurred_at: recoveryPlan.created_at,
    recorded_at: recoveryPlan.created_at,
    payload: {
      recovery_plan_id: recoveryPlan.recovery_plan_id,
      target_type: target.type,
      snapshot_id: snapshotIdForJournal,
      action_id: actionIdForJournal,
      external_object_id: target.type === "external_object" ? target.external_object_id : null,
      run_checkpoint: runCheckpointForJournal,
      branch_point_run_id: branchPointRunIdForJournal,
      branch_point_sequence: branchPointSequenceForJournal,
      target_paths: subsetPathsForJournal,
      recovery_class: recoveryPlan.recovery_class,
      strategy: recoveryPlan.strategy,
      downgrade_reason_code: recoveryPlan.downgrade_reason?.code ?? null,
      downgrade_reason_message: recoveryPlan.downgrade_reason?.message ?? null,
      target_locator: recoveryPlan.review_guidance?.objects_touched[0] ?? null,
      later_actions_affected: recoveryPlan.impact_preview.later_actions_affected,
      overlapping_paths: recoveryPlan.impact_preview.overlapping_paths,
      data_loss_risk: recoveryPlan.impact_preview.data_loss_risk,
      external_effects: recoveryPlan.impact_preview.external_effects,
      warnings: recoveryPlan.warnings.map((warning) => warning.message),
    },
  });

  return makeSuccessResponse(request.request_id, request.session_id, {
    recovery_plan: recoveryPlan,
  });
}

async function handleExecuteRecovery(
  journal: RunJournal,
  snapshotEngine: LocalSnapshotEngine,
  compensationRegistry: StaticCompensationRegistry,
  runtimeOptions: Pick<StartServerOptions, "capabilityRefreshStaleMs">,
  request: RequestEnvelope<unknown>,
): Promise<ResponseEnvelope<ExecuteRecoveryResponsePayload>> {
  const payload = validate(ExecuteRecoveryRequestPayloadSchema, request.payload);
  const target = normalizeRecoveryTarget(payload);
  const cachedCapabilityState = buildCachedCapabilityState(journal, runtimeOptions);
  let result: ExecuteRecoveryResponsePayload;
  let runId: string;
  let targetPath: string | null = null;
  let existedBefore: boolean | null = null;
  let entryKind: string | null = null;
  let snapshotIdForJournal: string | null = null;
  let actionIdForJournal: string | null = null;
  let runCheckpointForJournal: string | null = null;
  let branchPointRunIdForJournal: string | null = null;
  let branchPointSequenceForJournal: number | null = null;
  let subsetPathsForJournal: string[] | null = null;

  if (target.type === "snapshot_id") {
    const manifest = await loadRecoverySnapshotManifest(snapshotEngine, target.snapshot_id);
    result = await executeSnapshotRecovery(snapshotEngine, target.snapshot_id, {
      compensation_registry: compensationRegistry,
      cached_capability_state: cachedCapabilityState,
    });
    runId = manifest.run_id;
    targetPath = manifest.target_path;
    existedBefore = manifest.existed_before;
    entryKind = manifest.entry_kind;
    snapshotIdForJournal = target.snapshot_id;
  } else if (target.type === "path_subset") {
    const manifest = await loadRecoverySnapshotManifest(snapshotEngine, target.snapshot_id);
    result = await executePathSubsetRecovery(snapshotEngine, target, {
      cached_capability_state: cachedCapabilityState,
    });
    runId = manifest.run_id;
    targetPath = manifest.target_path;
    existedBefore = manifest.existed_before;
    entryKind = manifest.entry_kind;
    snapshotIdForJournal = target.snapshot_id;
    actionIdForJournal = manifest.action_id;
    subsetPathsForJournal = [...target.paths];
  } else if (target.type === "branch_point") {
    const branchPointContext = findBranchPointContext(journal, target);
    const manifest = await loadRecoverySnapshotManifest(snapshotEngine, branchPointContext.snapshotId);
    const branchPointResult = await executeSnapshotRecovery(snapshotEngine, branchPointContext.snapshotId, {
      compensation_registry: compensationRegistry,
      cached_capability_state: cachedCapabilityState,
    });
    result = {
      ...branchPointResult,
      recovery_plan: retargetRecoveryPlan(branchPointResult.recovery_plan, target),
    };
    runId = branchPointContext.runId;
    targetPath = manifest.target_path;
    existedBefore = manifest.existed_before;
    entryKind = manifest.entry_kind;
    snapshotIdForJournal = branchPointContext.snapshotId;
    actionIdForJournal = branchPointContext.actionId;
    branchPointRunIdForJournal = target.run_id;
    branchPointSequenceForJournal = target.sequence;
  } else if (target.type === "run_checkpoint") {
    const checkpointContext = findRunCheckpointContext(journal, target.run_checkpoint);
    const manifest = await loadRecoverySnapshotManifest(snapshotEngine, checkpointContext.snapshotId);
    const checkpointResult = await executeSnapshotRecovery(snapshotEngine, checkpointContext.snapshotId, {
      compensation_registry: compensationRegistry,
      cached_capability_state: cachedCapabilityState,
    });
    result = {
      ...checkpointResult,
      recovery_plan: retargetRecoveryPlan(checkpointResult.recovery_plan, target),
    };
    runId = checkpointContext.runId;
    targetPath = manifest.target_path;
    existedBefore = manifest.existed_before;
    entryKind = manifest.entry_kind;
    snapshotIdForJournal = checkpointContext.snapshotId;
    actionIdForJournal = checkpointContext.actionId;
    runCheckpointForJournal = target.run_checkpoint;
  } else {
    const actionContext =
      target.type === "action_boundary"
        ? findActionBoundaryContext(journal, target.action_id)
        : findExternalObjectBoundaryContext(journal, target.external_object_id);
    runId = actionContext.runId;
    actionIdForJournal = actionContext.actionId;

    if (!actionContext.snapshotId) {
      throw new PreconditionError("This action boundary has no persisted snapshot, so execution is manual-review only.", {
        action_id: actionContext.actionId,
      });
    }

    const manifest = await loadRecoverySnapshotManifest(snapshotEngine, actionContext.snapshotId);
    const snapshotResult = await executeSnapshotRecovery(snapshotEngine, actionContext.snapshotId, {
      compensation_registry: compensationRegistry,
      cached_capability_state: cachedCapabilityState,
    });
    result = {
      ...snapshotResult,
      recovery_plan: retargetRecoveryPlan(snapshotResult.recovery_plan, target),
    };
    targetPath = manifest.target_path;
    existedBefore = manifest.existed_before;
    entryKind = manifest.entry_kind;
    snapshotIdForJournal = actionContext.snapshotId;
  }

  journal.appendRunEvent(runId, {
    event_type: "recovery.executed",
    occurred_at: result.executed_at,
    recorded_at: result.executed_at,
    payload: {
      recovery_plan_id: result.recovery_plan.recovery_plan_id,
      target_type: target.type,
      snapshot_id: snapshotIdForJournal,
      action_id: actionIdForJournal,
      external_object_id: target.type === "external_object" ? target.external_object_id : null,
      run_checkpoint: runCheckpointForJournal,
      branch_point_run_id: branchPointRunIdForJournal,
      branch_point_sequence: branchPointSequenceForJournal,
      target_paths: subsetPathsForJournal,
      recovery_class: result.recovery_plan.recovery_class,
      strategy: result.recovery_plan.strategy,
      downgrade_reason_code: result.recovery_plan.downgrade_reason?.code ?? null,
      downgrade_reason_message: result.recovery_plan.downgrade_reason?.message ?? null,
      restored: result.restored,
      outcome: result.outcome,
      target_path: targetPath,
      target_locator: result.recovery_plan.review_guidance?.objects_touched[0] ?? targetPath,
      existed_before: existedBefore,
      entry_kind: entryKind,
      later_actions_affected: result.recovery_plan.impact_preview.later_actions_affected,
      overlapping_paths: result.recovery_plan.impact_preview.overlapping_paths,
      data_loss_risk: result.recovery_plan.impact_preview.data_loss_risk,
      external_effects: result.recovery_plan.impact_preview.external_effects,
      warnings: result.recovery_plan.warnings.map((warning) => warning.message),
    },
  });

  return makeSuccessResponse(request.request_id, request.session_id, result);
}

function appendActionEvents(journal: RunJournal, action: ActionRecord): void {
  const filesystemFacet =
    action.operation.domain === "filesystem" && isObject(action.facets.filesystem)
      ? action.facets.filesystem
      : null;
  const rawInput = isObject(action.input.raw) ? action.input.raw : null;
  const filesystemInputPreview =
    action.operation.domain === "filesystem" && typeof rawInput?.content === "string"
      ? stringPreview(rawInput.content, 160)
      : null;

  journal.appendRunEvent(action.run_id, {
    event_type: "action.normalized",
    occurred_at: action.timestamps.normalized_at,
    recorded_at: action.timestamps.normalized_at,
    payload: {
      action_id: action.action_id,
      operation: action.operation,
      provenance_mode: action.provenance.mode,
      provenance_source: action.provenance.source,
      provenance_confidence: action.provenance.confidence,
      target_locator: action.target.primary.locator,
      target_locator_visibility: "user",
      filesystem_operation:
        typeof filesystemFacet?.operation === "string" ? filesystemFacet.operation : null,
      input_preview: filesystemInputPreview,
      input_preview_visibility: action.input.contains_sensitive_data ? "sensitive_internal" : "user",
      normalization: action.normalization,
      risk_hints: action.risk_hints,
    },
  });
}

function stringPreview(value: unknown, maxLength = 240): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function artifactContentFromExecutionResult(
  artifact: ExecutionArtifact,
  action: ActionRecord,
  executionResult: {
    output: Record<string, unknown>;
  },
): string | null {
  switch (artifact.type) {
    case "stdout":
      return typeof executionResult.output.stdout === "string" ? executionResult.output.stdout : null;
    case "stderr":
      return typeof executionResult.output.stderr === "string" ? executionResult.output.stderr : null;
    case "diff":
      return typeof executionResult.output.diff_preview === "string" ? executionResult.output.diff_preview : null;
    case "request_response":
      return typeof executionResult.output.preview === "string" ? executionResult.output.preview : null;
    case "file_content": {
      const rawInput = isObject(action.input.raw) ? action.input.raw : null;
      return typeof rawInput?.content === "string" ? rawInput.content : null;
    }
    case "screenshot":
      return null;
  }
}

function artifactVisibilityForAction(
  artifact: ExecutionArtifact,
  action: ActionRecord,
): ExecutionArtifact["visibility"] {
  if ((artifact.type === "stdout" || artifact.type === "stderr") && action.operation.domain === "shell") {
    return "internal";
  }

  if (
    action.input.contains_sensitive_data &&
    (artifact.type === "file_content" || artifact.type === "diff" || artifact.type === "request_response")
  ) {
    return "sensitive_internal";
  }

  return artifact.visibility;
}

function clipArtifactContent(value: string): {
  content: string;
  content_truncated: boolean;
  returned_chars: number;
  max_inline_chars: number;
} {
  if (value.length <= MAX_ARTIFACT_RESPONSE_CHARS) {
    return {
      content: value,
      content_truncated: false,
      returned_chars: value.length,
      max_inline_chars: MAX_ARTIFACT_RESPONSE_CHARS,
    };
  }

  const content = `${value.slice(0, MAX_ARTIFACT_RESPONSE_CHARS - 1)}…`;
  return {
    content,
    content_truncated: true,
    returned_chars: content.length,
    max_inline_chars: MAX_ARTIFACT_RESPONSE_CHARS,
  };
}

function getWorkspaceRoot(locator: string, fallbackRoots: string[]): string {
  return fallbackRoots.find((root) => locator.startsWith(path.resolve(root))) ?? fallbackRoots[0] ?? process.cwd();
}

function assertLaunchSupportedToolKind(toolRegistration: {
  tool_kind: string;
  tool_name: string;
}): void {
  if (toolRegistration.tool_kind === "browser") {
    throw new PreconditionError(
      "Governed browser/computer execution is not part of the supported runtime surface.",
      {
        requested_tool_kind: toolRegistration.tool_kind,
        requested_tool_name: toolRegistration.tool_name,
        supported_tool_kinds: ["filesystem", "shell", "function"],
        unsupported_surface: "browser_computer",
      },
    );
  }
}

async function executeGovernedAction(params: {
  action: ActionRecord;
  policyOutcome: PolicyOutcomeRecord;
  runSummary: {
    workspace_roots: string[];
  };
  journal: RunJournal;
  adapterRegistry: AdapterRegistry;
  snapshotEngine: LocalSnapshotEngine;
  draftStore: OwnedDraftStore;
  noteStore: OwnedNoteStore;
  ticketStore: OwnedTicketStore;
}): Promise<{
  executionResult: SubmitActionAttemptResponsePayload["execution_result"];
  snapshotRecord: SubmitActionAttemptResponsePayload["snapshot_record"];
}> {
  const workspaceRoot = getWorkspaceRoot(params.action.target.primary.locator, params.runSummary.workspace_roots);
  let snapshotRecord: SubmitActionAttemptResponsePayload["snapshot_record"] = null;

  if (params.policyOutcome.preconditions.snapshot_required) {
    const requestedClass = params.action.operation.domain === "filesystem" ? "journal_plus_anchor" : "metadata_only";
    const capturedPreimage =
      requestedClass === "metadata_only"
        ? await captureOwnedPreimage(params.action, params.draftStore, params.noteStore, params.ticketStore)
        : null;
    snapshotRecord = await params.snapshotEngine.createSnapshot({
      action: params.action,
      requested_class: requestedClass,
      workspace_root: workspaceRoot,
      captured_preimage: capturedPreimage,
    });
    const createdSnapshot = snapshotRecord;
    params.journal.appendRunEvent(params.action.run_id, {
      event_type: "snapshot.created",
      occurred_at: createdSnapshot.created_at,
      recorded_at: createdSnapshot.created_at,
      payload: {
        action_id: params.action.action_id,
        snapshot_id: createdSnapshot.snapshot_id,
        snapshot_class: createdSnapshot.snapshot_class,
        fidelity: createdSnapshot.fidelity,
      },
    });
  }

  let executionResult: SubmitActionAttemptResponsePayload["execution_result"] = null;
  if (params.policyOutcome.decision === "allow" || params.policyOutcome.decision === "allow_with_snapshot") {
    const adapter = params.adapterRegistry.findAdapter(params.action);
    if (!adapter) {
      throw new AgentGitError("No governed execution adapter is available for this action domain.", "CAPABILITY_UNAVAILABLE", {
        requested_domain: params.action.operation.domain,
        requested_operation: params.action.operation.name,
        supported_domains: params.adapterRegistry.supportedDomains(),
      });
    }

    if (
      snapshotRecord &&
      params.action.operation.domain === "filesystem" &&
      !(await params.snapshotEngine.verifyTargetUnchanged(
        snapshotRecord.snapshot_id,
        params.action.target.primary.locator,
      ))
    ) {
      throw new PreconditionError(
        "File modified between snapshot and execution. Another agent may have changed it.",
        {
          path: params.action.target.primary.locator,
          snapshot_id: snapshotRecord.snapshot_id,
        },
      );
    }

    await adapter.verifyPreconditions({
      action: params.action,
      policy_outcome: params.policyOutcome,
      snapshot_record: snapshotRecord,
      workspace_root: workspaceRoot,
    });

    const executionStartedAt = new Date().toISOString();
    params.journal.appendRunEvent(params.action.run_id, {
      event_type: "execution.started",
      occurred_at: executionStartedAt,
      recorded_at: executionStartedAt,
      payload: {
        action_id: params.action.action_id,
        adapter_domains: adapter.supported_domains,
      },
    });

    try {
      executionResult = await adapter.execute({
        action: params.action,
        policy_outcome: params.policyOutcome,
        snapshot_record: snapshotRecord,
        workspace_root: workspaceRoot,
      });
      const completedExecutionResult = executionResult;
      const artifactCaptureFailures: Array<{
        artifact_id: string;
        type: string;
        code: ErrorEnvelope["code"];
        retryable: boolean;
        low_disk_pressure: boolean;
      }> = [];

      const storedArtifacts = completedExecutionResult.artifacts.flatMap((artifact) => {
        const content = artifactContentFromExecutionResult(artifact, params.action, completedExecutionResult);
        const visibility = artifactVisibilityForAction(artifact, params.action);
        if (content === null) {
          return [];
        }

        try {
          const integrity = params.journal.storeArtifact({
            artifact_id: artifact.artifact_id,
            run_id: params.action.run_id,
            action_id: params.action.action_id,
            execution_id: completedExecutionResult.execution_id,
            type: artifact.type,
            content_ref: artifact.content_ref,
            byte_size: artifact.byte_size,
            visibility,
            expires_at: null,
            expired_at: null,
            created_at: completedExecutionResult.completed_at,
            content,
          });
          return [
            {
              artifact_id: artifact.artifact_id,
              type: artifact.type,
              byte_size: artifact.byte_size,
              visibility,
              integrity,
            },
          ];
        } catch (error) {
          const normalizedError =
            error instanceof AgentGitError
              ? error
              : new InternalError("Artifact capture failed during execution completion.", {
                  artifact_id: artifact.artifact_id,
                  cause: error instanceof Error ? error.message : String(error),
                });
          artifactCaptureFailures.push({
            artifact_id: artifact.artifact_id,
            type: artifact.type,
            code: normalizedError.code,
            retryable: normalizedError.retryable,
            low_disk_pressure: normalizedError.details?.low_disk_pressure === true,
          });
          return [];
        }
      });
      const artifactCaptureWarnings =
        artifactCaptureFailures.length > 0
          ? [
              artifactCaptureFailures.some((failure) => failure.low_disk_pressure)
                ? `Supporting evidence capture degraded: ${artifactCaptureFailures.length} artifact(s) could not be stored because local storage was unavailable.`
                : `Supporting evidence capture degraded: ${artifactCaptureFailures.length} artifact(s) could not be stored durably.`,
            ]
          : [];
      executionResult = {
        ...completedExecutionResult,
        artifact_capture: {
          requested_count: completedExecutionResult.artifacts.length,
          stored_count: storedArtifacts.length,
          degraded: artifactCaptureFailures.length > 0,
          failures: artifactCaptureFailures,
        },
      };

      params.journal.appendRunEvent(params.action.run_id, {
        event_type: "execution.completed",
        occurred_at: completedExecutionResult.completed_at,
        recorded_at: completedExecutionResult.completed_at,
        payload: {
          action_id: params.action.action_id,
          execution_id: completedExecutionResult.execution_id,
          mode: completedExecutionResult.mode,
          success: completedExecutionResult.success,
          side_effect_level: params.action.risk_hints.side_effect_level,
          artifact_types: completedExecutionResult.artifacts.map((artifact) => artifact.type),
          artifact_count: completedExecutionResult.artifacts.length,
          stored_artifact_count: storedArtifacts.length,
          artifact_capture_failed_count: artifactCaptureFailures.length,
          artifact_capture_failures: artifactCaptureFailures,
          warnings: artifactCaptureWarnings,
          artifacts: storedArtifacts,
          target_path:
            typeof completedExecutionResult.output.target === "string" ? completedExecutionResult.output.target : null,
          target_path_visibility: "user",
          operation:
            typeof completedExecutionResult.output.operation === "string" ? completedExecutionResult.output.operation : null,
          bytes_written:
            typeof completedExecutionResult.output.bytes_written === "number"
              ? completedExecutionResult.output.bytes_written
              : null,
          before_preview: stringPreview(completedExecutionResult.output.before_preview),
          before_preview_visibility: params.action.input.contains_sensitive_data ? "sensitive_internal" : "user",
          after_preview: stringPreview(completedExecutionResult.output.after_preview),
          after_preview_visibility: params.action.input.contains_sensitive_data ? "sensitive_internal" : "user",
          diff_preview: stringPreview(completedExecutionResult.output.diff_preview),
          diff_preview_visibility: params.action.input.contains_sensitive_data ? "sensitive_internal" : "user",
          deleted:
            typeof completedExecutionResult.output.deleted === "boolean" ? completedExecutionResult.output.deleted : null,
          exit_code:
            typeof completedExecutionResult.output.exit_code === "number" ? completedExecutionResult.output.exit_code : null,
          stdout_excerpt: stringPreview(completedExecutionResult.output.stdout),
          stdout_excerpt_visibility: params.action.operation.domain === "shell" ? "internal" : "user",
          stderr_excerpt: stringPreview(completedExecutionResult.output.stderr),
          stderr_excerpt_visibility: params.action.operation.domain === "shell" ? "internal" : "user",
        },
      });
    } catch (error) {
      const now = new Date().toISOString();
      const details =
        error instanceof AgentGitError && error.details ? error.details : undefined;
      params.journal.appendRunEvent(params.action.run_id, {
        event_type: "execution.failed",
        occurred_at: now,
        recorded_at: now,
        payload: {
          action_id: params.action.action_id,
          error_code: error instanceof AgentGitError ? error.code : "INTERNAL_ERROR",
          error: error instanceof Error ? error.message : String(error),
          error_visibility: "user",
          exit_code: typeof details?.exit_code === "number" ? details.exit_code : null,
          signal: typeof details?.signal === "string" ? details.signal : null,
          stdout_excerpt: stringPreview(details?.stdout),
          stdout_excerpt_visibility: params.action.operation.domain === "shell" ? "internal" : "user",
          stderr_excerpt: stringPreview(details?.stderr),
          stderr_excerpt_visibility: params.action.operation.domain === "shell" ? "internal" : "user",
        },
      });
      throw error;
    }
  }

  return {
    executionResult,
    snapshotRecord,
  };
}

async function handleSubmitActionAttempt(
  state: AuthorityState,
  journal: RunJournal,
  adapterRegistry: AdapterRegistry,
  snapshotEngine: LocalSnapshotEngine,
  draftStore: OwnedDraftStore,
  noteStore: OwnedNoteStore,
  ticketStore: OwnedTicketStore,
  mcpRegistry: McpServerRegistry,
  runtimeOptions: Pick<StartServerOptions, "capabilityRefreshStaleMs">,
  request: RequestEnvelope<unknown>,
): Promise<ResponseEnvelope<SubmitActionAttemptResponsePayload>> {
  const payload = validate(SubmitActionAttemptRequestPayloadSchema, request.payload);
  const session = state.getSession(request.session_id);

  if (!session) {
    throw new PreconditionError("A valid session_id is required before submit_action_attempt.", {
      session_id: request.session_id,
    });
  }

  const runSummary = journal.getRunSummary(payload.attempt.run_id);

  if (!runSummary) {
    throw new NotFoundError(`No run found for ${payload.attempt.run_id}.`, {
      run_id: payload.attempt.run_id,
    });
  }

  assertLaunchSupportedToolKind(payload.attempt.tool_registration);

  const action = validateActionRecord(normalizeActionAttempt(payload.attempt, runSummary.session_id));
  const cachedCapabilityState = buildCachedCapabilityState(journal, runtimeOptions);
  const policyOutcome = validatePolicyOutcomeRecord(
    evaluatePolicy(action, {
      run_summary: {
        budget_config: runSummary.budget_config,
        budget_usage: runSummary.budget_usage,
      },
      mcp_server_registry: {
        servers: mcpRegistry.listDefinitions(),
      },
      cached_capability_state: cachedCapabilityState,
    }),
  );

  appendActionEvents(journal, action);
  journal.appendRunEvent(action.run_id, {
    event_type: "policy.evaluated",
    occurred_at: policyOutcome.evaluated_at,
    recorded_at: policyOutcome.evaluated_at,
    payload: {
      action_id: action.action_id,
      policy_outcome_id: policyOutcome.policy_outcome_id,
      decision: policyOutcome.decision,
      reasons: policyOutcome.reasons,
    },
  });

  let approvalRequest: ApprovalRequest | null = null;
  if (policyOutcome.decision === "ask") {
    approvalRequest = journal.createApprovalRequest({
      run_id: action.run_id,
      action,
      policy_outcome: policyOutcome,
    });
    journal.appendRunEvent(action.run_id, {
      event_type: "approval.requested",
      occurred_at: approvalRequest.requested_at,
      recorded_at: approvalRequest.requested_at,
      payload: {
        approval_id: approvalRequest.approval_id,
        action_id: action.action_id,
        action_summary: approvalRequest.action_summary,
        status: approvalRequest.status,
        primary_reason: approvalRequest.primary_reason,
      },
    });
  }

  let snapshotRecord: SubmitActionAttemptResponsePayload["snapshot_record"] = null;
  let executionResult: SubmitActionAttemptResponsePayload["execution_result"] = null;
  if (policyOutcome.decision === "allow" || policyOutcome.decision === "allow_with_snapshot") {
    const execution = await executeGovernedAction({
      action,
      policyOutcome: policyOutcome,
      runSummary,
      journal,
      adapterRegistry,
      snapshotEngine,
      draftStore,
      noteStore,
      ticketStore,
    });
    snapshotRecord = execution.snapshotRecord;
    executionResult = execution.executionResult;
  }

  return makeSuccessResponse(request.request_id, request.session_id, {
    action,
    policy_outcome: policyOutcome,
    execution_result: executionResult,
    snapshot_record: snapshotRecord,
    approval_request: approvalRequest,
  });
}

function canUseIdempotency(request: RequestEnvelope<unknown>): boolean {
  return IDEMPOTENT_MUTATION_METHODS.has(request.method) && typeof request.idempotency_key === "string" && request.idempotency_key.length > 0;
}

async function handleRequest(
  state: AuthorityState,
  journal: RunJournal,
  adapterRegistry: AdapterRegistry,
  snapshotEngine: LocalSnapshotEngine,
  compensationRegistry: StaticCompensationRegistry,
  broker: SessionCredentialBroker,
  mcpRegistry: McpServerRegistry,
  publicHostPolicyRegistry: McpPublicHostPolicyRegistry,
  draftStore: OwnedDraftStore,
  noteStore: OwnedNoteStore,
  ticketStore: OwnedTicketStore,
  runtimeOptions: Pick<StartServerOptions, "socketPath" | "journalPath" | "snapshotRootPath" | "capabilityRefreshStaleMs">,
  rawRequest: unknown,
): Promise<ResponseEnvelope<unknown>> {
  const requestContext = getRequestContext(rawRequest);

  try {
    const request = validate(RequestEnvelopeSchema, rawRequest);
    const idempotencyClaim =
      canUseIdempotency(request) && request.session_id
        ? journal.claimIdempotentMutation({
            session_id: request.session_id,
            idempotency_key: request.idempotency_key!,
            method: request.method,
            payload: request.payload,
            stored_at: new Date().toISOString(),
          })
        : null;

    if (idempotencyClaim?.status === "replay") {
      return replayStoredSuccessResponse(request.request_id, request.session_id, idempotencyClaim.record.response);
    }

    if (idempotencyClaim?.status === "conflict") {
      throw new PreconditionError("Idempotency key has already been used for a different mutating request.", {
        session_id: request.session_id,
        idempotency_key: request.idempotency_key,
        recorded_method: idempotencyClaim.record?.method ?? request.method,
        request_method: idempotencyClaim.request_method,
        recorded_payload_digest: idempotencyClaim.record?.payload_digest ?? null,
        request_payload_digest: idempotencyClaim.request_payload_digest,
      });
    }

    if (idempotencyClaim?.status === "in_progress") {
      throw new AgentGitError(
        "An idempotent request with the same key is already in progress. Retry after the original request finishes.",
        "PRECONDITION_FAILED",
        {
          session_id: request.session_id,
          idempotency_key: request.idempotency_key,
          method: request.method,
          stored_at: idempotencyClaim.stored_at,
        },
        true,
      );
    }

    try {
      let response: ResponseEnvelope<unknown>;

      switch (request.method) {
        case "hello":
          response = handleHello(state, request);
          break;
        case "register_run":
          response = handleRegisterRun(state, journal, request);
          break;
        case "get_run_summary":
          response = handleGetRunSummary(journal, request);
          break;
        case "get_capabilities":
          response = handleGetCapabilities(broker, runtimeOptions, mcpRegistry, publicHostPolicyRegistry, request);
          break;
        case "list_mcp_servers":
          response = handleListMcpServers(mcpRegistry, request);
          break;
        case "upsert_mcp_server":
          response = handleUpsertMcpServer(state, mcpRegistry, broker, request);
          break;
        case "remove_mcp_server":
          response = handleRemoveMcpServer(state, mcpRegistry, request);
          break;
        case "list_mcp_secrets":
          response = handleListMcpSecrets(broker, request);
          break;
        case "upsert_mcp_secret":
          response = handleUpsertMcpSecret(state, broker, request);
          break;
        case "remove_mcp_secret":
          response = handleRemoveMcpSecret(state, broker, request);
          break;
        case "list_mcp_host_policies":
          response = handleListMcpHostPolicies(publicHostPolicyRegistry, request);
          break;
        case "upsert_mcp_host_policy":
          response = handleUpsertMcpHostPolicy(state, publicHostPolicyRegistry, request);
          break;
        case "remove_mcp_host_policy":
          response = handleRemoveMcpHostPolicy(state, publicHostPolicyRegistry, request);
          break;
        case "diagnostics":
          response = handleDiagnostics(state, journal, runtimeOptions, request);
          break;
        case "run_maintenance":
          response = await handleRunMaintenance(
            state,
            journal,
            snapshotEngine,
            broker,
            mcpRegistry,
            publicHostPolicyRegistry,
            draftStore,
            noteStore,
            ticketStore,
            runtimeOptions,
            request,
          );
          break;
        case "list_approvals":
          response = handleListApprovals(journal, request);
          break;
        case "query_approval_inbox":
          response = handleQueryApprovalInbox(journal, request);
          break;
        case "resolve_approval":
          response = await handleResolveApproval(
            journal,
            adapterRegistry,
            snapshotEngine,
            draftStore,
            noteStore,
            ticketStore,
            request,
          );
          break;
        case "query_timeline":
          response = handleQueryTimeline(journal, request);
          break;
        case "query_helper":
          response = handleQueryHelper(journal, request);
          break;
        case "query_artifact":
          response = handleQueryArtifact(journal, request);
          break;
        case "submit_action_attempt":
          response = await handleSubmitActionAttempt(
            state,
            journal,
            adapterRegistry,
            snapshotEngine,
            draftStore,
            noteStore,
            ticketStore,
            mcpRegistry,
            runtimeOptions,
            request,
          );
          break;
        case "plan_recovery":
          response = await handlePlanRecovery(journal, snapshotEngine, compensationRegistry, runtimeOptions, request);
          break;
        case "execute_recovery":
          response = await handleExecuteRecovery(journal, snapshotEngine, compensationRegistry, runtimeOptions, request);
          break;
        default:
          throw new ValidationError(`Unknown method: ${request.method}`);
      }

      if (idempotencyClaim?.status === "claimed" && request.session_id && request.idempotency_key && response.ok) {
        journal.completeIdempotentMutation({
          session_id: request.session_id,
          idempotency_key: request.idempotency_key,
          response,
          completed_at: new Date().toISOString(),
        });
      }

      return response;
    } catch (error) {
      if (idempotencyClaim?.status === "claimed" && request.session_id && request.idempotency_key) {
        journal.releaseIdempotentMutation(request.session_id, request.idempotency_key);
      }

      throw error;
    }
  } catch (error) {
    return makeErrorResponse(requestContext.request_id, requestContext.session_id, error);
  }
}

function rehydrateState(state: AuthorityState, journal: RunJournal): void {
  const result = reconcilePersistedRuns(state, journal);

  console.log(
    JSON.stringify({
      status: "rehydrated",
      sessions: result.total_sessions,
      runs: result.total_runs,
    }),
  );
}

function reconcilePersistedRuns(
  state: AuthorityState,
  journal: RunJournal,
): {
  runs_considered: number;
  sessions_rehydrated: number;
  runs_rehydrated: number;
  total_sessions: number;
  total_runs: number;
} {
  const runs = journal.listAllRuns();
  const sessionsBefore = state.getSessionCount();
  const runsBefore = state.getRunCount();

  for (const run of runs) {
    state.rehydrateSession(run.session_id, run.workspace_roots);
    state.rehydrateRun(run);
  }

  return {
    runs_considered: runs.length,
    sessions_rehydrated: state.getSessionCount() - sessionsBefore,
    runs_rehydrated: state.getRunCount() - runsBefore,
    total_sessions: state.getSessionCount(),
    total_runs: state.getRunCount(),
  };
}

function recoverInterruptedActions(journal: RunJournal): number {
  const runs = journal.listAllRuns();
  let reconciledActions = 0;

  for (const run of runs) {
    const events = journal.listRunEvents(run.run_id);
    const snapshotEvents = events.filter((event) => event.event_type === "snapshot.created");

    for (const snapshotEvent of snapshotEvents) {
      const actionId =
        typeof snapshotEvent.payload?.action_id === "string" ? snapshotEvent.payload.action_id : null;
      if (!actionId) {
        continue;
      }

      const alreadyReconciled = events.some(
        (event) =>
          event.payload?.action_id === actionId &&
          event.event_type === "execution.outcome_unknown",
      );
      if (alreadyReconciled) {
        continue;
      }

      const hasTerminalEvent = events.some(
        (event) =>
          event.payload?.action_id === actionId &&
          (
            event.event_type === "execution.completed" ||
            event.event_type === "execution.failed" ||
            event.event_type === "execution.simulated"
          ),
      );
      if (hasTerminalEvent) {
        continue;
      }

      const now = new Date().toISOString();
      journal.appendRunEvent(run.run_id, {
        event_type: "execution.outcome_unknown",
        occurred_at: now,
        recorded_at: now,
        payload: {
          action_id: actionId,
          reason: "daemon_crash_recovery",
          message:
            "Daemon restarted before a terminal execution event was recorded. Workspace may have changed; snapshot preserved for reconciliation or manual recovery.",
        },
      });
      reconciledActions += 1;
    }
  }

  return reconciledActions;
}

export interface StartServerOptions {
  socketPath: string;
  journalPath: string;
  snapshotRootPath: string;
  mcpRegistryPath?: string;
  mcpSecretStorePath?: string;
  mcpSecretKeyPath?: string;
  mcpHostPolicyPath?: string;
  artifactRetentionMs?: number | null;
  capabilityRefreshStaleMs?: number | null;
}

export function startServer(options: StartServerOptions): Promise<net.Server> {
  const state = new AuthorityState();
  const journal = createRunJournal({
    dbPath: options.journalPath,
    artifactRetentionMs: options.artifactRetentionMs,
  });
  const adapterRegistry = new AdapterRegistry();
  const snapshotEngine = new LocalSnapshotEngine({
    rootDir: options.snapshotRootPath,
  });
  const integrationsDbPath = path.join(path.dirname(options.snapshotRootPath), "integrations", "state.db");
  const mcpRegistryPath = options.mcpRegistryPath ?? path.join(path.dirname(options.snapshotRootPath), "mcp", "registry.db");
  const mcpSecretStorePath =
    options.mcpSecretStorePath ?? path.join(path.dirname(options.snapshotRootPath), "mcp", "secret-store.db");
  const mcpSecretKeyPath =
    options.mcpSecretKeyPath ?? path.join(path.dirname(options.snapshotRootPath), "mcp", "secret-store.key");
  const mcpHostPolicyPath =
    options.mcpHostPolicyPath ?? path.join(path.dirname(options.snapshotRootPath), "mcp", "host-policies.db");
  const credentialBroker = createCredentialBroker({
    mcpSecretStorePath,
    mcpSecretKeyPath,
  });
  const publicHostPolicyRegistry = new McpPublicHostPolicyRegistry({
    dbPath: mcpHostPolicyPath,
  });
  const mcpRegistry = new McpServerRegistry({
    dbPath: mcpRegistryPath,
    publicHostPolicyRegistry,
  });
  const bootstrapMcpServers = createMcpServerRegistryFromEnv();
  mcpRegistry.bootstrapServers(bootstrapMcpServers);
  const draftStore = new OwnedDraftStore(integrationsDbPath);
  const noteStore = new OwnedNoteStore(integrationsDbPath);
  const ticketStore = new OwnedTicketStore(integrationsDbPath);
  const ticketIntegration = new OwnedTicketIntegration(ticketStore, credentialBroker);
  const compensationRegistry = createOwnedCompensationRegistry(draftStore, noteStore, ticketIntegration);
  const socketDir = path.dirname(options.socketPath);

  adapterRegistry.register(new FilesystemExecutionAdapter());
  adapterRegistry.register(new ShellExecutionAdapter());
  adapterRegistry.register(
    new McpExecutionAdapter(mcpRegistry, {
      credentialBroker,
      publicHostPolicyRegistry,
    }),
  );
  adapterRegistry.register(new FunctionExecutionAdapter(draftStore, noteStore, ticketIntegration));
  rehydrateState(state, journal);
  recoverInterruptedActions(journal);
  journal.enforceArtifactRetention();

  fs.mkdirSync(socketDir, { recursive: true });
  if (fs.existsSync(options.socketPath)) {
    fs.rmSync(options.socketPath, { force: true });
  }

  const server = net.createServer((socket) => {
    let buffer = "";

    socket.setEncoding("utf8");

    socket.on("data", async (chunk) => {
      buffer += chunk;

      while (buffer.includes("\n")) {
        const newlineIndex = buffer.indexOf("\n");
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (!line) {
          continue;
        }

        let parsed: unknown;

        try {
          parsed = JSON.parse(line);
        } catch (error) {
          const response = makeErrorResponse(
            "req_parse_error",
            undefined,
            new ValidationError("Request body was not valid JSON.", {
              cause: error instanceof Error ? error.message : String(error),
            }),
          );
          socket.write(`${JSON.stringify(response)}\n`);
          socket.end();
          return;
        }

        const response = await handleRequest(
          state,
          journal,
          adapterRegistry,
          snapshotEngine,
          compensationRegistry,
          credentialBroker,
          mcpRegistry,
          publicHostPolicyRegistry,
          draftStore,
          noteStore,
          ticketStore,
          {
            socketPath: options.socketPath,
            journalPath: options.journalPath,
            snapshotRootPath: options.snapshotRootPath,
            capabilityRefreshStaleMs: options.capabilityRefreshStaleMs ?? null,
          },
          parsed,
        );
        socket.write(`${JSON.stringify(response)}\n`);
        socket.end();
      }
    });
  });

  server.on("close", () => {
    draftStore.close();
    noteStore.close();
    ticketStore.close();
    mcpRegistry.close();
    journal.close();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
