import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
  classifyMcpNetworkScope,
  extractContainerRegistryHost,
  isContainerRegistryAllowed,
  isDigestPinnedContainerImage,
  McpPublicHostPolicyRegistry,
  McpServerRegistry,
  validateMcpServerDefinitions,
} from "@agentgit/mcp-registry";
import {
  replayPolicyThresholds,
  recommendPolicyThresholds,
  validatePolicyConfigDocument,
} from "@agentgit/policy-engine";
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
  type ApprovalInboxItem,
  type DaemonMethod,
  ActivateMcpServerProfileRequestPayloadSchema,
  type ActivateMcpServerProfileResponsePayload,
  ApproveMcpServerProfileRequestPayloadSchema,
  type ApproveMcpServerProfileResponsePayload,
  BindMcpServerCredentialsRequestPayloadSchema,
  type BindMcpServerCredentialsResponsePayload,
  DiagnosticsRequestPayloadSchema,
  type DiagnosticsResponsePayload,
  ExplainPolicyActionRequestPayloadSchema,
  type ExplainPolicyActionResponsePayload,
  CreateRunCheckpointRequestPayloadSchema,
  type CreateRunCheckpointResponsePayload,
  type ErrorEnvelope,
  ExecuteRecoveryRequestPayloadSchema,
  type ExecuteRecoveryResponsePayload,
  type ExecutionResult,
  GetEffectivePolicyRequestPayloadSchema,
  type GetEffectivePolicyResponsePayload,
  GetPolicyCalibrationReportRequestPayloadSchema,
  type GetPolicyCalibrationReportResponsePayload,
  GetPolicyThresholdReplayRequestPayloadSchema,
  type GetPolicyThresholdReplayResponsePayload,
  GetPolicyThresholdRecommendationsRequestPayloadSchema,
  type GetPolicyThresholdRecommendationsResponsePayload,
  GetCapabilitiesRequestPayloadSchema,
  type GetCapabilitiesResponsePayload,
  ListMcpServerTrustDecisionsRequestPayloadSchema,
  type ListMcpServerTrustDecisionsResponsePayload,
  ListMcpServerCredentialBindingsRequestPayloadSchema,
  type ListMcpServerCredentialBindingsResponsePayload,
  ListMcpServerCandidatesRequestPayloadSchema,
  type ListMcpServerCandidatesResponsePayload,
  ListMcpServerProfilesRequestPayloadSchema,
  type ListMcpServerProfilesResponsePayload,
  ListHostedMcpJobsRequestPayloadSchema,
  type ListHostedMcpJobsResponsePayload,
  ListMcpHostPoliciesRequestPayloadSchema,
  type ListMcpHostPoliciesResponsePayload,
  ListMcpSecretsRequestPayloadSchema,
  type ListMcpSecretsResponsePayload,
  ListMcpServersRequestPayloadSchema,
  type ListMcpServersResponsePayload,
  type HostedMcpExecutionAttestationRecord,
  type HostedMcpExecutionJobRecord,
  type HostedMcpExecutionLeaseRecord,
  type ImportedMcpToolRecord,
  type McpCredentialBindingRecord,
  type McpServerCandidateRecord,
  type McpServerRegistrationRecord,
  type McpServerProfileRecord,
  type McpServerTrustDecisionRecord,
  type HelperQuestionType,
  GetRunSummaryRequestPayloadSchema,
  type GetRunSummaryResponsePayload,
  GetMcpServerReviewRequestPayloadSchema,
  type GetMcpServerReviewResponsePayload,
  GetHostedMcpJobRequestPayloadSchema,
  type GetHostedMcpJobResponsePayload,
  HelloRequestPayloadSchema,
  type HelloResponsePayload,
  InternalError,
  ListApprovalsRequestPayloadSchema,
  type ListApprovalsResponsePayload,
  RunMaintenanceRequestPayloadSchema,
  type RunMaintenanceResponsePayload,
  QueryApprovalInboxRequestPayloadSchema,
  type QueryApprovalInboxResponsePayload,
  QuarantineMcpServerProfileRequestPayloadSchema,
  type QuarantineMcpServerProfileResponsePayload,
  CancelHostedMcpJobRequestPayloadSchema,
  type CancelHostedMcpJobResponsePayload,
  RequeueHostedMcpJobRequestPayloadSchema,
  type RequeueHostedMcpJobResponsePayload,
  ResolveMcpServerCandidateRequestPayloadSchema,
  type ResolveMcpServerCandidateResponsePayload,
  RevokeMcpServerProfileRequestPayloadSchema,
  type RevokeMcpServerProfileResponsePayload,
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
  RevokeMcpServerCredentialsRequestPayloadSchema,
  type RevokeMcpServerCredentialsResponsePayload,
  RemoveMcpHostPolicyRequestPayloadSchema,
  type RemoveMcpHostPolicyResponsePayload,
  RemoveMcpSecretRequestPayloadSchema,
  type RemoveMcpSecretResponsePayload,
  RemoveMcpServerRequestPayloadSchema,
  type RemoveMcpServerResponsePayload,
  type PolicyOutcomeRecord,
  PreconditionError,
  type ReasonDetail,
  type RecoveryPlan,
  type RecoveryTarget,
  type RunCheckpointKind,
  RegisterRunRequestPayloadSchema,
  type RegisterRunResponsePayload,
  ResolveApprovalRequestPayloadSchema,
  type ResolveApprovalResponsePayload,
  type RequestEnvelope,
  RequestEnvelopeSchema,
  type ResponseEnvelope,
  SCHEMA_PACK_VERSION,
  SubmitMcpServerCandidateRequestPayloadSchema,
  type TimelineStep,
  type SubmitMcpServerCandidateResponsePayload,
  type SubmitActionAttemptResponsePayload,
  UpsertMcpHostPolicyRequestPayloadSchema,
  type UpsertMcpHostPolicyResponsePayload,
  UpsertMcpSecretRequestPayloadSchema,
  type UpsertMcpSecretResponsePayload,
  UpsertMcpServerRequestPayloadSchema,
  type UpsertMcpServerResponsePayload,
  ValidatePolicyConfigRequestPayloadSchema,
  type ValidatePolicyConfigResponsePayload,
  ValidationError,
  validate,
  type VisibilityScope,
} from "@agentgit/schemas";
import { LocalSnapshotEngine } from "@agentgit/snapshot-engine";
import { selectSnapshotClass } from "@agentgit/snapshot-engine";

import { createPrefixedId } from "./ids.js";
import {
  handleSubmitActionAttempt as handleSubmitActionAttemptFlow,
  prepareActionAttemptEvaluation,
} from "./handlers/submit-action.js";
import { HostedExecutionQueue } from "./hosted-execution-queue.js";
import { HostedMcpWorkerClient } from "./hosted-worker-client.js";
import {
  loadPolicyRuntime,
  reloadPolicyRuntime,
  type LoadPolicyRuntimeOptions,
  type PolicyRuntimeState,
} from "./policy-runtime.js";
import { executeGovernedAction as executeGovernedActionFlow } from "./services/action-execution.js";
import {
  deriveSnapshotCapabilityState as deriveSnapshotCapabilityStateService,
  deriveSnapshotRunRiskContext as deriveSnapshotRunRiskContextService,
} from "./services/snapshot-risk.js";
import { AuthorityState } from "./state.js";

const METHODS: DaemonMethod[] = [
  "hello",
  "register_run",
  "get_run_summary",
  "get_capabilities",
  "get_effective_policy",
  "validate_policy_config",
  "get_policy_calibration_report",
  "explain_policy_action",
  "get_policy_threshold_recommendations",
  "replay_policy_thresholds",
  "list_mcp_servers",
  "list_mcp_server_candidates",
  "submit_mcp_server_candidate",
  "list_mcp_server_profiles",
  "resolve_mcp_server_candidate",
  "list_mcp_server_trust_decisions",
  "approve_mcp_server_profile",
  "list_mcp_server_credential_bindings",
  "bind_mcp_server_credentials",
  "revoke_mcp_server_credentials",
  "activate_mcp_server_profile",
  "quarantine_mcp_server_profile",
  "revoke_mcp_server_profile",
  "upsert_mcp_server",
  "remove_mcp_server",
  "list_mcp_secrets",
  "upsert_mcp_secret",
  "remove_mcp_secret",
  "list_mcp_host_policies",
  "upsert_mcp_host_policy",
  "remove_mcp_host_policy",
  "get_hosted_mcp_job",
  "list_hosted_mcp_jobs",
  "requeue_hosted_mcp_job",
  "cancel_hosted_mcp_job",
  "get_mcp_server_review",
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
  "submit_mcp_server_candidate",
  "resolve_mcp_server_candidate",
  "approve_mcp_server_profile",
  "bind_mcp_server_credentials",
  "revoke_mcp_server_credentials",
  "activate_mcp_server_profile",
  "quarantine_mcp_server_profile",
  "revoke_mcp_server_profile",
  "upsert_mcp_server",
  "remove_mcp_server",
  "upsert_mcp_secret",
  "remove_mcp_secret",
  "upsert_mcp_host_policy",
  "remove_mcp_host_policy",
  "requeue_hosted_mcp_job",
  "cancel_hosted_mcp_job",
  "run_maintenance",
  "submit_action_attempt",
  "resolve_approval",
  "execute_recovery",
]);
const RUNTIME_VERSION = "0.1.0";

type RegisteredStdioMcpServer = McpServerRegistrationRecord & {
  server: Extract<McpServerDefinition, { transport: "stdio" }>;
};

type RegisteredStreamableHttpMcpServer = McpServerRegistrationRecord & {
  server: Extract<McpServerDefinition, { transport: "streamable_http" }>;
};

function isRegisteredStdioMcpServer(record: McpServerRegistrationRecord): record is RegisteredStdioMcpServer {
  return record.server.transport === "stdio";
}

function isRegisteredStreamableHttpMcpServer(
  record: McpServerRegistrationRecord,
): record is RegisteredStreamableHttpMcpServer {
  return record.server.transport === "streamable_http";
}
const MAX_ARTIFACT_RESPONSE_CHARS = 8_192;
const CAPABILITY_REFRESH_STALE_MS = 5 * 60 * 1_000;
const HELPER_FACT_WARM_VISIBILITY_SCOPES: VisibilityScope[] = ["user", "model", "internal", "sensitive_internal"];
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
const POLICY_CALIBRATION_MIN_SAMPLES = 5;

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
        code:
          capability.status === "unavailable" ? "WORKSPACE_CAPABILITY_UNAVAILABLE" : "WORKSPACE_CAPABILITY_DEGRADED",
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
        code: capability.status === "unavailable" ? "BROKERED_CAPABILITY_UNAVAILABLE" : "BROKERED_CAPABILITY_DEGRADED",
        message: `Cached ticket broker capability is ${capability.status}; trusted brokered ticket execution is not currently available.`,
      };
    case "host.credential_broker_mode":
      return {
        code: "CREDENTIAL_BROKER_MODE_DEGRADED",
        message:
          "Credential brokering is operating in a degraded mode, so durable secure-store guarantees are reduced.",
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
      message:
        "Latest capability refresh is stale; rerun capability_refresh if the host or workspace may have changed.",
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

function makeErrorResponse(requestId: string, sessionId: string | undefined, error: unknown): ResponseEnvelope<never> {
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
    typeof rawRequest.session_id === "string" && rawRequest.session_id.length > 0 ? rawRequest.session_id : undefined;

  return {
    request_id: requestId,
    session_id: sessionId,
  };
}

function normalizeRecoveryTarget(payload: { snapshot_id?: string; target?: RecoveryTarget }): RecoveryTarget {
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

function buildSyntheticCheckpointAction(params: {
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

function createCredentialBroker(
  options: {
    env?: NodeJS.ProcessEnv;
    mcpSecretStorePath?: string;
    mcpSecretKeyPath?: string;
  } = {},
): SessionCredentialBroker {
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
            manual_steps: [
              "Verify the external ticket status, title, body, labels, and assignees match the captured preimage after recovery executes.",
            ],
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
            manual_steps: [
              "Verify the external ticket has been recreated with its prior status, labels, and assignees after recovery executes.",
            ],
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
            manual_steps: [
              `Verify user "${userId}" is no longer assigned to the external ticket after recovery executes.`,
            ],
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
            manual_steps: [
              "Verify the workspace note title and body match the pre-update version after recovery executes.",
            ],
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
            manual_steps: [
              "Verify the draft returns to active status in the owned drafts store after recovery executes.",
            ],
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
            manual_steps: [
              "Verify the draft returns to archived status in the owned drafts store after recovery executes.",
            ],
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
            manual_steps: [
              "Verify the draft has been restored with its prior subject, body, labels, and status after recovery executes.",
            ],
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

function handleHello(state: AuthorityState, request: RequestEnvelope<unknown>): ResponseEnvelope<HelloResponsePayload> {
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
  policyRuntime: PolicyRuntimeState,
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
    effective_policy_profile: policyRuntime.effective_policy.summary.profile_name,
  });
}

function handleGetEffectivePolicy(
  request: RequestEnvelope<unknown>,
  policyRuntime: PolicyRuntimeState,
): ResponseEnvelope<GetEffectivePolicyResponsePayload> {
  validate(GetEffectivePolicyRequestPayloadSchema, request.payload);

  return makeSuccessResponse(request.request_id, request.session_id, policyRuntime.effective_policy);
}

function handleValidatePolicyConfig(
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<ValidatePolicyConfigResponsePayload> {
  const payload: { config: unknown } = validate(ValidatePolicyConfigRequestPayloadSchema, request.payload);
  const validation = validatePolicyConfigDocument(payload.config);

  return makeSuccessResponse(request.request_id, request.session_id, {
    valid: validation.valid,
    issues: validation.issues,
    normalized_config: validation.normalized_config,
    compiled_profile_name: validation.compiled_policy?.profile_name ?? null,
    compiled_rule_count: validation.compiled_policy?.rules.length ?? null,
  });
}

function handleGetPolicyCalibrationReport(
  state: AuthorityState,
  journal: RunJournal,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<GetPolicyCalibrationReportResponsePayload> {
  const sessionId = requireValidSession(state, "get_policy_calibration_report", request.session_id);
  const payload = validate(GetPolicyCalibrationReportRequestPayloadSchema, request.payload);
  if (payload.run_id) {
    requireAuthorizedRunSummary(state, journal, sessionId, payload.run_id);
  }

  return makeSuccessResponse(
    request.request_id,
    request.session_id,
    journal.getPolicyCalibrationReport({
      run_id: payload.run_id,
      include_samples: payload.include_samples,
      sample_limit: payload.sample_limit ?? null,
    }),
  );
}

function handleExplainPolicyAction(
  state: AuthorityState,
  journal: RunJournal,
  policyRuntime: PolicyRuntimeState,
  runtimeOptions: Pick<StartServerOptions, "capabilityRefreshStaleMs">,
  mcpRegistry: McpServerRegistry,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<ExplainPolicyActionResponsePayload> {
  const sessionId = requireValidSession(state, "explain_policy_action", request.session_id);
  const session = state.getSession(sessionId);
  const payload = validate(ExplainPolicyActionRequestPayloadSchema, request.payload);
  const prepared = prepareActionAttemptEvaluation({
    journal,
    mcpRegistry,
    policyRuntime,
    runtimeOptions,
    buildCachedCapabilityState,
    sessionId,
    sessionWorkspaceRoots: session?.workspace_roots ?? [],
    attempt: payload.attempt,
  });
  const confidenceScore = prepared.action.confidence_assessment.score;

  return makeSuccessResponse(request.request_id, request.session_id, {
    action: prepared.action,
    policy_outcome: prepared.policyOutcome,
    action_family: `${prepared.action.operation.domain}/${prepared.action.operation.kind}`,
    effective_policy_profile: policyRuntime.effective_policy.summary.profile_name,
    low_confidence_threshold: prepared.lowConfidenceThreshold,
    confidence_score: confidenceScore,
    confidence_triggered: prepared.confidenceTriggered,
    snapshot_selection: prepared.snapshotSelection,
  });
}

function handleGetPolicyThresholdRecommendations(
  state: AuthorityState,
  journal: RunJournal,
  policyRuntime: PolicyRuntimeState,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<GetPolicyThresholdRecommendationsResponsePayload> {
  const sessionId = requireValidSession(state, "get_policy_threshold_recommendations", request.session_id);
  const payload = validate(GetPolicyThresholdRecommendationsRequestPayloadSchema, request.payload);
  if (payload.run_id) {
    requireAuthorizedRunSummary(state, journal, sessionId, payload.run_id);
  }
  const minSamples = payload.min_samples ?? 5;
  const calibrationReport = journal.getPolicyCalibrationReport({
    run_id: payload.run_id,
    include_samples: true,
    sample_limit: null,
  });

  return makeSuccessResponse(request.request_id, request.session_id, {
    generated_at: calibrationReport.report.generated_at,
    filters: {
      run_id: payload.run_id ?? null,
      min_samples: minSamples,
    },
    effective_policy_profile: policyRuntime.effective_policy.summary.profile_name,
    recommendations: recommendPolicyThresholds(calibrationReport.report, policyRuntime.compiled_policy, {
      min_samples: minSamples,
    }),
  });
}

function handleReplayPolicyThresholds(
  state: AuthorityState,
  journal: RunJournal,
  policyRuntime: PolicyRuntimeState,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<GetPolicyThresholdReplayResponsePayload> {
  const sessionId = requireValidSession(state, "replay_policy_thresholds", request.session_id);
  const payload = validate(GetPolicyThresholdReplayRequestPayloadSchema, request.payload);
  if (payload.run_id) {
    requireAuthorizedRunSummary(state, journal, sessionId, payload.run_id);
  }
  const replay = replayPolicyThresholds(
    journal.getPolicyThresholdReplayRecords({
      run_id: payload.run_id,
    }),
    policyRuntime.compiled_policy,
    payload.candidate_thresholds,
    {
      include_changed_samples: payload.include_changed_samples,
      sample_limit: payload.sample_limit ?? null,
    },
  );

  return makeSuccessResponse(request.request_id, request.session_id, {
    generated_at: new Date().toISOString(),
    filters: {
      run_id: payload.run_id ?? null,
      include_changed_samples: payload.include_changed_samples ?? false,
      sample_limit: payload.include_changed_samples ? (payload.sample_limit ?? 200) : null,
    },
    effective_policy_profile: policyRuntime.effective_policy.summary.profile_name,
    ...replay,
  });
}

function buildPolicyRuntimeLoadOptions(
  runtimeOptions: Pick<
    StartServerOptions,
    "policyGlobalConfigPath" | "policyWorkspaceConfigPath" | "policyCalibrationConfigPath" | "policyConfigPath"
  >,
): LoadPolicyRuntimeOptions {
  return {
    globalConfigPath: runtimeOptions.policyGlobalConfigPath,
    workspaceConfigPath: runtimeOptions.policyWorkspaceConfigPath,
    generatedConfigPath: runtimeOptions.policyCalibrationConfigPath,
    explicitConfigPath: runtimeOptions.policyConfigPath,
  };
}

function buildCalibrationThresholdUpdates(recommendations: ReturnType<typeof recommendPolicyThresholds>): Array<{
  action_family: string;
  current_ask_below: number | null;
  recommended_ask_below: number;
  direction: string;
}> {
  return recommendations
    .filter(
      (recommendation) =>
        recommendation.requires_policy_update &&
        recommendation.recommended_ask_below !== null &&
        recommendation.recommended_ask_below !== recommendation.current_ask_below,
    )
    .map((recommendation) => ({
      action_family: recommendation.action_family,
      current_ask_below: recommendation.current_ask_below,
      recommended_ask_below: recommendation.recommended_ask_below as number,
      direction: recommendation.direction,
    }));
}

function handleGetRunSummary(
  state: AuthorityState,
  journal: RunJournal,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<GetRunSummaryResponsePayload> {
  const sessionId = requireValidSession(state, "get_run_summary", request.session_id);
  const payload = validate(GetRunSummaryRequestPayloadSchema, request.payload);
  const runSummary = requireAuthorizedRunSummary(state, journal, sessionId, payload.run_id);

  return makeSuccessResponse(request.request_id, request.session_id, {
    run: runSummary,
  });
}

async function handleCreateRunCheckpoint(
  state: AuthorityState,
  journal: RunJournal,
  snapshotEngine: LocalSnapshotEngine,
  runtimeOptions: Pick<StartServerOptions, "capabilityRefreshStaleMs">,
  request: RequestEnvelope<unknown>,
): Promise<ResponseEnvelope<CreateRunCheckpointResponsePayload>> {
  const payload = validate(CreateRunCheckpointRequestPayloadSchema, request.payload);
  const sessionId = requireValidSession(state, "create_run_checkpoint", request.session_id);
  const runSummary = requireAuthorizedRunSummary(state, journal, sessionId, payload.run_id);

  const workspaceRoot = payload.workspace_root ?? runSummary.workspace_roots[0];
  if (!workspaceRoot || !runSummary.workspace_roots.includes(workspaceRoot)) {
    throw new PreconditionError("Checkpoint workspace root is not registered on this run.", {
      run_id: payload.run_id,
      workspace_root: payload.workspace_root ?? null,
      registered_workspace_roots: runSummary.workspace_roots,
    });
  }

  const checkpointKind = payload.checkpoint_kind ?? "branch_point";
  const action = buildSyntheticCheckpointAction({
    run_id: payload.run_id,
    session_id: sessionId,
    workspace_root: workspaceRoot,
    checkpoint_kind: checkpointKind,
    reason: payload.reason,
  });
  const cachedCapabilityState = buildCachedCapabilityState(journal, runtimeOptions);
  const runRiskContext = deriveSnapshotRunRiskContextService(journal, payload.run_id);
  const snapshotSelection = selectSnapshotClass({
    action,
    policy_decision: "allow_with_snapshot",
    capability_state: deriveSnapshotCapabilityStateService(cachedCapabilityState),
    low_disk_pressure_observed: runSummary.maintenance_status.low_disk_pressure_signals > 0,
    journal_chain_depth: runSummary.event_count,
    ...runRiskContext,
    explicit_branch_point: checkpointKind === "branch_point",
    explicit_hard_checkpoint: checkpointKind === "hard_checkpoint",
  });
  const snapshotRecord = await snapshotEngine.createSnapshot({
    action,
    requested_class: snapshotSelection.snapshot_class,
    workspace_root: workspaceRoot,
  });
  const snapshotSequence = journal.appendRunEvent(payload.run_id, {
    event_type: "snapshot.created",
    occurred_at: snapshotRecord.created_at,
    recorded_at: snapshotRecord.created_at,
    payload: {
      action_id: action.action_id,
      snapshot_id: snapshotRecord.snapshot_id,
      snapshot_class: snapshotRecord.snapshot_class,
      fidelity: snapshotRecord.fidelity,
      selection_reason_codes: snapshotSelection.reason_codes,
      selection_basis: snapshotSelection.basis,
      checkpoint_kind: checkpointKind,
      checkpoint_reason: payload.reason ?? null,
      synthetic_checkpoint: true,
    },
  });
  const runCheckpoint = `${payload.run_id}#${snapshotSequence}`;
  journal.appendRunEvent(payload.run_id, {
    event_type: "checkpoint.created",
    occurred_at: snapshotRecord.created_at,
    recorded_at: snapshotRecord.created_at,
    payload: {
      action_id: action.action_id,
      run_checkpoint: runCheckpoint,
      snapshot_id: snapshotRecord.snapshot_id,
      checkpoint_kind: checkpointKind,
      checkpoint_reason: payload.reason ?? null,
    },
  });

  return makeSuccessResponse(request.request_id, request.session_id, {
    run_checkpoint: runCheckpoint,
    branch_point: {
      run_id: payload.run_id,
      sequence: snapshotSequence,
    },
    checkpoint_kind: checkpointKind,
    snapshot_record: snapshotRecord,
    snapshot_selection: snapshotSelection,
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

function commandExists(command: string): boolean {
  const searchPath = (process.env.PATH ?? "").split(path.delimiter);
  for (const candidateDir of searchPath) {
    if (candidateDir.trim().length === 0) {
      continue;
    }

    if (fs.existsSync(path.join(candidateDir, command))) {
      return true;
    }
  }

  return false;
}

function probeContainerRuntime(runtime: "docker" | "podman"): { usable: boolean; reason: string | null } {
  if (!commandExists(runtime)) {
    return {
      usable: false,
      reason: `${runtime} CLI is not installed.`,
    };
  }

  const result = spawnSync(runtime, ["info"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 2_000,
  });
  if (result.error) {
    return {
      usable: false,
      reason: result.error.message,
    };
  }

  if (result.status !== 0) {
    return {
      usable: false,
      reason: result.stderr.trim() || `${runtime} info exited with status ${result.status}.`,
    };
  }

  return {
    usable: true,
    reason: null,
  };
}

function detectMcpSecurityState(
  broker: SessionCredentialBroker,
  runtimeOptions: Pick<StartServerOptions, "mcpConcurrencyLeasePath">,
  mcpRegistry: McpServerRegistry,
  publicHostPolicyRegistry: McpPublicHostPolicyRegistry,
) {
  const credentialStoreDetails = broker.durableSecretStorageDetails();
  const credentialBrokerMode = broker.durableSecretStorageMode();
  const durableSecretStorageAvailable = broker.supportsDurableSecretStorage();
  const registeredMcpServers = mcpRegistry.listServers();
  const registeredStdioServers = registeredMcpServers.filter(isRegisteredStdioMcpServer);
  const registeredStreamableHttpServers = registeredMcpServers.filter(isRegisteredStreamableHttpMcpServer);
  const dockerRuntime = probeContainerRuntime("docker");
  const podmanRuntime = probeContainerRuntime("podman");
  const stdioSandboxIssues: string[] = [];
  const stdioDegradedServers: string[] = [];
  const stdioFallbackServers: string[] = [];
  const stdioProductionReadyServers: string[] = [];
  const stdioUnconfiguredServers: string[] = [];
  const stdioDigestPinnedServers: string[] = [];
  const stdioMutableTagServers: string[] = [];
  const stdioLocalBuildServers: string[] = [];
  const stdioRegistryPolicyServers: string[] = [];
  const stdioSignatureVerificationServers: string[] = [];
  const stdioProvenanceAttestationServers: string[] = [];
  const ociRuntimeUsable = dockerRuntime.usable || podmanRuntime.usable;
  const preferredProductionMode = "oci_container";
  const localDevFallbackMode = null;

  const currentHostMode = ociRuntimeUsable ? "oci_container_ready" : "oci_runtime_required";
  const currentHostModeReason = ociRuntimeUsable
    ? dockerRuntime.usable
      ? "Docker is usable on this host for OCI sandboxing."
      : "Podman is usable on this host for OCI sandboxing."
    : process.platform === "win32"
      ? "Windows requires Docker Desktop with WSL2 or Podman machine for OCI sandboxing; no native host-process fallback is supported."
      : "No usable OCI runtime is available on this host. Governed stdio MCP execution requires OCI sandboxing.";

  for (const record of registeredStdioServers) {
    const sandbox = record.server.sandbox;
    const sandboxType = sandbox?.type ?? "none";
    if (sandboxType === "oci_container") {
      const runtime = sandbox?.type === "oci_container" ? (sandbox.runtime ?? "docker") : "docker";
      const runtimeProbe = runtime === "podman" ? podmanRuntime : dockerRuntime;
      if (!runtimeProbe.usable) {
        stdioDegradedServers.push(record.server.server_id);
        stdioSandboxIssues.push(
          `${record.server.server_id} requires ${runtime} OCI sandboxing, but the runtime is not usable${runtimeProbe.reason ? `: ${runtimeProbe.reason}` : "."}`,
        );
      } else {
        if (sandbox?.type === "oci_container" && sandbox.build) {
          stdioLocalBuildServers.push(record.server.server_id);
          stdioSandboxIssues.push(
            `${record.server.server_id} is configured with oci_container.build for local development; publish a pinned, signed image from an allowed registry before production rollout.`,
          );
        } else if (sandbox?.type === "oci_container" && isDigestPinnedContainerImage(sandbox.image)) {
          stdioDigestPinnedServers.push(record.server.server_id);
          const allowedRegistries = sandbox.allowed_registries ?? [];
          if (allowedRegistries.length > 0 && isContainerRegistryAllowed(sandbox.image, allowedRegistries)) {
            stdioRegistryPolicyServers.push(record.server.server_id);
            if (sandbox.signature_verification) {
              stdioSignatureVerificationServers.push(record.server.server_id);
              if (sandbox.signature_verification.require_slsa_provenance !== false) {
                stdioProvenanceAttestationServers.push(record.server.server_id);
                stdioProductionReadyServers.push(record.server.server_id);
              } else {
                stdioSandboxIssues.push(
                  `${record.server.server_id} verifies OCI signatures but does not require SLSA provenance attestations; enable provenance verification before production rollout.`,
                );
              }
            } else {
              stdioSandboxIssues.push(
                `${record.server.server_id} is missing OCI signature_verification policy and cannot meet the production trust bar.`,
              );
            }
          } else {
            stdioSandboxIssues.push(
              `${record.server.server_id} is missing an allowed_registries policy for ${extractContainerRegistryHost(sandbox.image)}.`,
            );
          }
        } else {
          stdioMutableTagServers.push(record.server.server_id);
          stdioSandboxIssues.push(
            `${record.server.server_id} uses an OCI image without a pinned sha256 digest; pin container images before production rollout.`,
          );
        }
      }
      continue;
    }

    stdioDegradedServers.push(record.server.server_id);
    stdioUnconfiguredServers.push(record.server.server_id);
    stdioSandboxIssues.push(
      `${record.server.server_id} has no explicit stdio sandbox configuration; configure oci_container before registering it for governed execution.`,
    );
  }

  const protectedStdioServerCount = registeredStdioServers.length - stdioDegradedServers.length;
  const streamableHttpMissingAuth = registeredStreamableHttpServers
    .filter((record) => record.server.auth?.type === "bearer_env")
    .filter((record) => {
      const envVar = record.server.auth?.type === "bearer_env" ? record.server.auth.bearer_env_var.trim() : "";
      return envVar.length > 0 && (process.env[envVar]?.trim() ?? "").length === 0;
    });
  const streamableHttpLegacyEnvAuthServers = registeredStreamableHttpServers.filter(
    (record) => record.server.auth?.type === "bearer_env",
  );
  const streamableHttpSecretRefServers = registeredStreamableHttpServers.filter(
    (record) => record.server.auth?.type === "bearer_secret_ref",
  );
  const streamableHttpMissingSecretRefs = streamableHttpSecretRefServers.filter((record) => {
    const auth = record.server.auth;
    return (
      auth?.type === "bearer_secret_ref" &&
      !broker.listMcpBearerSecrets().some((secret) => secret.secret_id === auth.secret_id)
    );
  });
  const publicHttpsPolicyMismatches = registeredStreamableHttpServers.filter((record) => {
    return (
      (record.server.network_scope ?? "loopback") === "public_https" &&
      publicHostPolicyRegistry.findPolicyForUrl(new URL(record.server.url)) === null
    );
  });

  return {
    credentialStoreDetails,
    credentialBrokerMode,
    durableSecretStorageAvailable,
    registeredMcpServers,
    registeredStdioServers,
    registeredStreamableHttpServers,
    dockerRuntime,
    podmanRuntime,
    ociRuntimeUsable,
    preferredProductionMode,
    localDevFallbackMode,
    currentHostMode,
    currentHostModeReason,
    stdioDegradedServers,
    stdioSandboxIssues,
    stdioFallbackServers,
    stdioProductionReadyServers,
    stdioUnconfiguredServers,
    stdioDigestPinnedServers,
    stdioMutableTagServers,
    stdioLocalBuildServers,
    stdioRegistryPolicyServers,
    stdioSignatureVerificationServers,
    stdioProvenanceAttestationServers,
    protectedStdioServerCount,
    streamableHttpMissingAuth,
    streamableHttpLegacyEnvAuthServers,
    streamableHttpSecretRefServers,
    streamableHttpMissingSecretRefs,
    publicHttpsPolicyMismatches,
    concurrencyLeasePath: runtimeOptions.mcpConcurrencyLeasePath ?? null,
  };
}

function detectCapabilities(
  broker: SessionCredentialBroker,
  runtimeOptions: Pick<
    StartServerOptions,
    "socketPath" | "journalPath" | "snapshotRootPath" | "mcpConcurrencyLeasePath"
  >,
  mcpRegistry: McpServerRegistry,
  publicHostPolicyRegistry: McpPublicHostPolicyRegistry,
  hostedWorkerClient: HostedMcpWorkerClient,
  workspaceRoot?: string,
): GetCapabilitiesResponsePayload {
  const startedAt = new Date().toISOString();
  const capabilities: GetCapabilitiesResponsePayload["capabilities"] = [];
  const degradedModeWarnings: string[] = [];
  const securityState = detectMcpSecurityState(broker, runtimeOptions, mcpRegistry, publicHostPolicyRegistry);

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
    degradedModeWarnings.push(
      "Local runtime storage is not fully writable; daemon behavior may degrade or fail closed.",
    );
  }

  capabilities.push({
    capability_name: "host.credential_broker_mode",
    status: securityState.durableSecretStorageAvailable ? "available" : "degraded",
    scope: "host",
    detected_at: startedAt,
    source: "authority_daemon",
    details: {
      mode: securityState.credentialBrokerMode,
      secure_store: securityState.durableSecretStorageAvailable,
      encrypted_at_rest: securityState.durableSecretStorageAvailable,
      secret_expiry_enforced: true,
      rotation_metadata_tracked: true,
      key_provider: securityState.credentialStoreDetails?.provider ?? null,
      key_identifier: securityState.credentialStoreDetails?.key_identifier ?? null,
      legacy_key_path: securityState.credentialStoreDetails?.legacy_key_path ?? null,
      legacy_session_env_profiles_enabled: true,
    },
  });
  if (!securityState.durableSecretStorageAvailable) {
    degradedModeWarnings.push(
      "Credential brokering is operating without durable MCP secret storage; only legacy session environment profiles are available.",
    );
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
    degradedModeWarnings.push(
      "Owned ticket mutations are unavailable until brokered ticket credentials are configured.",
    );
  }

  const mcpProfiles = mcpRegistry.listProfiles();
  const mcpBindings = mcpRegistry.listCredentialBindings();
  const registeredMcpToolCount = securityState.registeredMcpServers.reduce(
    (total, record) => total + record.server.tools.length,
    0,
  );
  const transportCounts = {
    stdio: securityState.registeredStdioServers.length,
    streamable_http: securityState.registeredStreamableHttpServers.length,
  };
  const streamableHttpNetworkScopes = [
    ...new Set(
      securityState.registeredStreamableHttpServers.map((record) =>
        record.server.transport === "streamable_http" ? (record.server.network_scope ?? "loopback") : "loopback",
      ),
    ),
  ];
  const bootstrapEnvServerCount = securityState.registeredMcpServers.filter(
    (record) => record.source === "bootstrap_env",
  ).length;
  const operatorManagedServerCount = securityState.registeredMcpServers.filter(
    (record) => record.source === "operator_api",
  ).length;

  capabilities.push({
    capability_name: "adapter.mcp_registry",
    status: "available",
    scope: "adapter",
    detected_at: startedAt,
    source: "mcp_registry",
    details: {
      registered_server_count: securityState.registeredMcpServers.length,
      registered_tool_count: registeredMcpToolCount,
      bootstrap_env_servers: bootstrapEnvServerCount,
      operator_managed_servers: operatorManagedServerCount,
      candidate_registry_available: true,
      server_profile_count: mcpProfiles.length,
      hosted_profile_count: mcpProfiles.filter((profile) =>
        profile.allowed_execution_modes.includes("hosted_delegated"),
      ).length,
      launch_scope: "local_operator_owned",
      transport_counts: transportCounts,
      streamable_http_network_scopes: streamableHttpNetworkScopes,
      registered_secret_count: broker.listMcpBearerSecrets().length,
      supported_auth_binding_modes: [
        "oauth_session",
        "derived_token",
        "bearer_secret_ref",
        "session_token",
        "hosted_token_exchange",
      ],
      degraded_credential_binding_ids: mcpBindings
        .filter((binding) => binding.status === "degraded")
        .map((binding) => binding.credential_binding_id),
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
    capability_name: "adapter.mcp_hosted_delegated",
    status: hostedWorkerClient.available ? "available" : "degraded",
    scope: "adapter",
    detected_at: startedAt,
    source: "mcp_registry",
    details: {
      supported: true,
      hosted_delegated_execution_available: hostedWorkerClient.available,
      hosted_attestation_verification_available: hostedWorkerClient.available,
      worker_runtime_id: hostedWorkerClient.workerRuntimeId,
      worker_image_digest: hostedWorkerClient.workerImageDigest,
      worker_endpoint_kind: hostedWorkerClient.endpointKind,
      worker_endpoint: hostedWorkerClient.endpointLabel,
      worker_managed_by_daemon: hostedWorkerClient.managed,
      worker_control_plane_auth_required: hostedWorkerClient.controlPlaneAuthRequired,
      worker_last_error: hostedWorkerClient.lastError,
      active_profile_count: mcpProfiles.filter(
        (profile) => profile.status === "active" && profile.allowed_execution_modes.includes("hosted_delegated"),
      ).length,
      supported_auth_binding_modes: ["oauth_session", "derived_token", "bearer_secret_ref", "hosted_token_exchange"],
      degraded_binding_modes: ["session_token"],
    },
  });

  capabilities.push({
    capability_name: "adapter.mcp_streamable_http",
    status:
      securityState.streamableHttpMissingAuth.length > 0 ||
      securityState.streamableHttpMissingSecretRefs.length > 0 ||
      securityState.publicHttpsPolicyMismatches.length > 0 ||
      (securityState.streamableHttpSecretRefServers.length > 0 && !securityState.durableSecretStorageAvailable) ||
      securityState.streamableHttpLegacyEnvAuthServers.length > 0
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
      connect_time_dns_scope_validation: true,
      redirect_chain_revalidation: true,
      shared_sqlite_leases: true,
      lease_heartbeat_renewal: true,
      supported_auth_types: ["none", "bearer_secret_ref", "bearer_env"],
      durable_secret_storage_available: securityState.durableSecretStorageAvailable,
      public_https_requirements: {
        https_only: true,
        explicit_host_policy_required: true,
        bearer_secret_ref_recommended: true,
        disallowed_custom_headers: ["authorization", "proxy-authorization", "cookie"],
      },
      concurrency_lease_path: securityState.concurrencyLeasePath,
      legacy_bearer_env_servers: securityState.streamableHttpLegacyEnvAuthServers.map(
        (record) => record.server.server_id,
      ),
      missing_secret_ref_servers: securityState.streamableHttpMissingSecretRefs.map(
        (record) => record.server.server_id,
      ),
      missing_public_host_policy_servers: securityState.publicHttpsPolicyMismatches.map(
        (record) => record.server.server_id,
      ),
      registered_server_count: transportCounts.streamable_http,
      missing_bearer_env_servers: securityState.streamableHttpMissingAuth.map((record) => {
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

  capabilities.push({
    capability_name: "adapter.mcp_stdio_sandbox",
    status:
      securityState.stdioDegradedServers.length > 0 ||
      securityState.stdioMutableTagServers.length > 0 ||
      securityState.stdioLocalBuildServers.length > 0 ||
      securityState.stdioRegistryPolicyServers.length < securityState.stdioDigestPinnedServers.length ||
      securityState.stdioSignatureVerificationServers.length < securityState.stdioDigestPinnedServers.length ||
      securityState.stdioProvenanceAttestationServers.length < securityState.stdioSignatureVerificationServers.length
        ? "degraded"
        : "available",
    scope: "adapter",
    detected_at: startedAt,
    source: "mcp_registry",
    details: {
      protected_execution_required: true,
      preferred_production_mode: securityState.preferredProductionMode,
      local_dev_fallback_mode: securityState.localDevFallbackMode,
      current_host_mode: securityState.currentHostMode,
      current_host_mode_reason: securityState.currentHostModeReason,
      registered_server_count: securityState.registeredStdioServers.length,
      protected_server_count: securityState.protectedStdioServerCount,
      production_ready_server_count: securityState.stdioProductionReadyServers.length,
      digest_pinned_server_count: securityState.stdioDigestPinnedServers.length,
      mutable_tag_server_count: securityState.stdioMutableTagServers.length,
      local_build_server_count: securityState.stdioLocalBuildServers.length,
      registry_policy_server_count: securityState.stdioRegistryPolicyServers.length,
      signature_verification_server_count: securityState.stdioSignatureVerificationServers.length,
      provenance_attestation_server_count: securityState.stdioProvenanceAttestationServers.length,
      fallback_server_count: securityState.stdioFallbackServers.length,
      unconfigured_server_count: securityState.stdioUnconfiguredServers.length,
      macos_seatbelt_available: false,
      docker_runtime_usable: securityState.dockerRuntime.usable,
      podman_runtime_usable: securityState.podmanRuntime.usable,
      windows_plan: {
        supported_via_oci: true,
        recommended_runtime: "docker_desktop_wsl2_or_podman_machine",
        native_fallback_available: false,
        summary:
          "On Windows, use Docker Desktop with WSL2 or Podman machine for OCI sandboxing. No native host-process fallback is supported.",
      },
      degraded_servers: securityState.stdioDegradedServers,
    },
  });

  if (securityState.streamableHttpMissingAuth.length > 0) {
    degradedModeWarnings.push(
      `Some registered streamable_http MCP servers are missing required bearer token env vars: ${securityState.streamableHttpMissingAuth
        .map((record) => record.server.server_id)
        .join(", ")}.`,
    );
  }
  if (securityState.stdioMutableTagServers.length > 0) {
    degradedModeWarnings.push(
      `Some registered stdio MCP servers use OCI images without pinned digests: ${securityState.stdioMutableTagServers.join(", ")}.`,
    );
  }
  if (securityState.streamableHttpLegacyEnvAuthServers.length > 0) {
    degradedModeWarnings.push(
      `Some registered streamable_http MCP servers still use legacy bearer_env authentication instead of durable secret references: ${securityState.streamableHttpLegacyEnvAuthServers
        .map((record) => record.server.server_id)
        .join(", ")}.`,
    );
  }
  if (securityState.streamableHttpMissingSecretRefs.length > 0) {
    degradedModeWarnings.push(
      `Some registered streamable_http MCP servers reference missing durable secret records: ${securityState.streamableHttpMissingSecretRefs
        .map((record) => record.server.server_id)
        .join(", ")}.`,
    );
  }
  if (securityState.publicHttpsPolicyMismatches.length > 0) {
    degradedModeWarnings.push(
      `Some registered public_https MCP servers are missing an active host allowlist policy: ${securityState.publicHttpsPolicyMismatches
        .map((record) => record.server.server_id)
        .join(", ")}.`,
    );
  }
  degradedModeWarnings.push(...securityState.stdioSandboxIssues);

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
      degradedModeWarnings.push(
        `Workspace root ${resolvedWorkspaceRoot} is not available for governed read/write access.`,
      );
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
  runtimeOptions: Pick<
    StartServerOptions,
    "socketPath" | "journalPath" | "snapshotRootPath" | "mcpConcurrencyLeasePath"
  >,
  mcpRegistry: McpServerRegistry,
  publicHostPolicyRegistry: McpPublicHostPolicyRegistry,
  hostedWorkerClient: HostedMcpWorkerClient,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<GetCapabilitiesResponsePayload> {
  const payload = validate(GetCapabilitiesRequestPayloadSchema, request.payload);
  return makeSuccessResponse(
    request.request_id,
    request.session_id,
    detectCapabilities(
      broker,
      runtimeOptions,
      mcpRegistry,
      publicHostPolicyRegistry,
      hostedWorkerClient,
      payload.workspace_root,
    ),
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

function handleListMcpServerCandidates(
  mcpRegistry: McpServerRegistry,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<ListMcpServerCandidatesResponsePayload> {
  validate(ListMcpServerCandidatesRequestPayloadSchema, request.payload);
  return makeSuccessResponse(request.request_id, request.session_id, {
    candidates: mcpRegistry.listCandidates(),
  });
}

function handleListMcpServerProfiles(
  mcpRegistry: McpServerRegistry,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<ListMcpServerProfilesResponsePayload> {
  validate(ListMcpServerProfilesRequestPayloadSchema, request.payload);
  return makeSuccessResponse(request.request_id, request.session_id, {
    profiles: mcpRegistry.listProfiles(),
  });
}

function buildMcpServerReview(params: {
  candidate: McpServerCandidateRecord | null;
  profile: McpServerProfileRecord | null;
  mcpRegistry: McpServerRegistry;
}): GetMcpServerReviewResponsePayload {
  const activeTrustDecision = params.profile
    ? params.mcpRegistry.getActiveTrustDecision(params.profile.server_profile_id)
    : null;
  const activeCredentialBinding = params.profile
    ? params.mcpRegistry.getActiveCredentialBinding(params.profile.server_profile_id)
    : null;
  const requiresResolution = params.candidate !== null && params.profile === null;
  const requiresApproval = params.profile !== null && (!activeTrustDecision || activeTrustDecision.decision === "deny");
  const requiresCredentials =
    params.profile !== null && params.profile.auth_descriptor.mode !== "none" && !activeCredentialBinding;
  const requiresReapproval =
    params.profile !== null &&
    (params.profile.drift_state !== "clean" ||
      params.profile.status === "quarantined" ||
      (activeTrustDecision?.valid_until !== null && activeTrustDecision?.valid_until !== undefined
        ? Date.parse(activeTrustDecision.valid_until) <= Date.now()
        : false));
  const executable =
    params.profile !== null &&
    params.profile.status === "active" &&
    params.profile.drift_state === "clean" &&
    activeTrustDecision !== null &&
    activeTrustDecision.decision !== "deny" &&
    (!requiresCredentials || activeCredentialBinding !== null);
  const localProxySupported = params.profile?.allowed_execution_modes.includes("local_proxy") ?? false;
  const hostedExecutionSupported = params.profile?.allowed_execution_modes.includes("hosted_delegated") ?? false;
  const warnings: string[] = [];
  const recommendedActions: string[] = [];

  if (requiresResolution) {
    warnings.push("Candidate has not been resolved into a durable profile yet.");
    recommendedActions.push("Resolve the candidate before attempting review or activation.");
  }
  if (requiresApproval) {
    warnings.push("Profile does not have an active non-deny trust decision.");
    recommendedActions.push("Approve the profile with explicit trust tier and execution mode limits.");
  }
  if (requiresCredentials) {
    warnings.push("Profile requires brokered credentials before activation.");
    recommendedActions.push("Bind brokered credentials that match the profile auth descriptor.");
  }
  if (params.profile?.drift_state === "drifted") {
    warnings.push(
      `Profile drift is detected: ${params.profile.quarantine_reason_codes.join(", ") || "unknown reasons"}.`,
    );
    recommendedActions.push("Review drift, then re-approve or quarantine permanently before reactivation.");
  }
  if (params.profile?.status === "quarantined") {
    warnings.push("Profile is quarantined and cannot execute.");
  }
  if (params.profile?.status === "revoked") {
    warnings.push("Profile is revoked and cannot execute.");
  }
  if (params.candidate?.resolution_state === "failed") {
    warnings.push(`Candidate resolution failed: ${params.candidate.resolution_error ?? "unknown error"}.`);
    recommendedActions.push("Fix the upstream endpoint or resolution inputs, then resolve again.");
  }
  if (activeTrustDecision?.valid_until && Date.parse(activeTrustDecision.valid_until) <= Date.now()) {
    warnings.push("Active trust decision has expired.");
    recommendedActions.push("Record a fresh trust decision before activation.");
  }
  if (!localProxySupported && !hostedExecutionSupported && params.profile) {
    warnings.push("Profile currently allows no execution modes.");
    recommendedActions.push("Set at least one execution mode during trust approval.");
  }
  if (recommendedActions.length === 0 && executable) {
    recommendedActions.push("Profile is ready for governed execution.");
  }

  return {
    candidate: params.candidate,
    profile: params.profile,
    active_trust_decision: activeTrustDecision,
    active_credential_binding: activeCredentialBinding,
    review: {
      review_target:
        params.candidate && params.profile ? "candidate_profile" : params.profile ? "profile" : "candidate",
      executable,
      activation_ready:
        params.profile !== null &&
        params.profile.drift_state === "clean" &&
        params.profile.status !== "quarantined" &&
        params.profile.status !== "revoked" &&
        !requiresApproval &&
        !requiresCredentials,
      requires_approval: requiresApproval,
      requires_resolution: requiresResolution,
      requires_credentials: requiresCredentials,
      requires_reapproval: requiresReapproval,
      hosted_execution_supported: hostedExecutionSupported,
      local_proxy_supported: localProxySupported,
      drift_detected: params.profile?.drift_state === "drifted",
      quarantined: params.profile?.status === "quarantined",
      revoked: params.profile?.status === "revoked",
      warnings,
      recommended_actions: [...new Set(recommendedActions)],
    },
  };
}

function handleGetMcpServerReview(
  mcpRegistry: McpServerRegistry,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<GetMcpServerReviewResponsePayload> {
  const payload = validate(GetMcpServerReviewRequestPayloadSchema, request.payload);
  const directCandidate = payload.candidate_id ? mcpRegistry.getCandidate(payload.candidate_id) : null;
  const profile = payload.server_profile_id
    ? mcpRegistry.getProfile(payload.server_profile_id)
    : directCandidate
      ? mcpRegistry.getProfileByCandidateId(directCandidate.candidate_id)
      : null;
  const candidate = directCandidate ?? (profile?.candidate_id ? mcpRegistry.getCandidate(profile.candidate_id) : null);

  if (payload.candidate_id && !directCandidate) {
    throw new NotFoundError(`No MCP server candidate found for ${payload.candidate_id}.`, {
      candidate_id: payload.candidate_id,
    });
  }
  if (payload.server_profile_id && !profile) {
    throw new NotFoundError(`No MCP server profile found for ${payload.server_profile_id}.`, {
      server_profile_id: payload.server_profile_id,
    });
  }

  return makeSuccessResponse(
    request.request_id,
    request.session_id,
    buildMcpServerReview({ candidate, profile, mcpRegistry }),
  );
}

function handleListHostedMcpJobs(
  mcpRegistry: McpServerRegistry,
  hostedExecutionQueue: HostedExecutionQueue,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<ListHostedMcpJobsResponsePayload> {
  const payload = validate(ListHostedMcpJobsRequestPayloadSchema, request.payload);
  const jobs = mcpRegistry
    .listHostedExecutionJobs(payload.server_profile_id)
    .filter((job) => (payload.status ? job.status === payload.status : true))
    .filter((job) =>
      payload.lifecycle_state ? hostedExecutionQueue.lifecycle(job).state === payload.lifecycle_state : true,
    )
    .sort((left, right) => {
      const updatedAtComparison = right.updated_at.localeCompare(left.updated_at);
      if (updatedAtComparison !== 0) {
        return updatedAtComparison;
      }
      return right.created_at.localeCompare(left.created_at);
    });
  return makeSuccessResponse(request.request_id, request.session_id, {
    jobs,
    summary: hostedExecutionQueue.summarizeJobs(jobs),
  });
}

function inspectHostedMcpJob(
  job: HostedMcpExecutionJobRecord,
  mcpRegistry: McpServerRegistry,
  hostedExecutionQueue: HostedExecutionQueue,
  journal: RunJournal,
): GetHostedMcpJobResponsePayload {
  const leases = mcpRegistry
    .listHostedExecutionLeases(job.server_profile_id)
    .filter(
      (lease) =>
        lease.run_id === job.run_id &&
        lease.action_id === job.action_id &&
        lease.server_profile_id === job.server_profile_id &&
        lease.tool_name === job.tool_name,
    )
    .sort((left, right) => left.issued_at.localeCompare(right.issued_at));
  const attestations = leases
    .flatMap((lease) => mcpRegistry.listHostedExecutionAttestations(lease.lease_id))
    .sort((left, right) =>
      (left.verified_at ?? left.completed_at).localeCompare(right.verified_at ?? right.completed_at),
    );
  const recentEvents = journal
    .listRunEvents(job.run_id)
    .filter((event) => eventPayloadString(event, "job_id") === job.job_id)
    .map((event) => ({
      sequence: event.sequence,
      event_type: event.event_type,
      occurred_at: event.occurred_at,
      recorded_at: event.recorded_at,
      payload: event.payload ?? null,
    }));

  return {
    job,
    lifecycle: hostedExecutionQueue.lifecycle(job),
    leases,
    attestations,
    recent_events: recentEvents,
  };
}

function handleGetHostedMcpJob(
  mcpRegistry: McpServerRegistry,
  hostedExecutionQueue: HostedExecutionQueue,
  journal: RunJournal,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<GetHostedMcpJobResponsePayload> {
  const payload = validate(GetHostedMcpJobRequestPayloadSchema, request.payload);
  const job = hostedExecutionQueue.inspectJob(payload.job_id);
  if (!job) {
    throw new NotFoundError("Hosted MCP execution job was not found.", {
      job_id: payload.job_id,
    });
  }

  return makeSuccessResponse(
    request.request_id,
    request.session_id,
    inspectHostedMcpJob(job, mcpRegistry, hostedExecutionQueue, journal),
  );
}

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJsonStringify(entryValue)}`).join(",")}}`;
  }

  return JSON.stringify(value);
}

const HOSTED_MCP_LEASE_TTL_MS = 60_000;
const HOSTED_MCP_DEFAULT_ARTIFACT_BUDGET = {
  max_artifacts: 8,
  max_total_bytes: 256 * 1024,
} as const;

function resolveHostedActionHash(value: unknown): string {
  return createHash("sha256").update(stableJsonStringify(value), "utf8").digest("hex");
}

function buildBindingAuthContextRef(binding: McpCredentialBindingRecord): string {
  return `${binding.binding_mode}:${binding.credential_binding_id}:${binding.broker_profile_id}`;
}

function parseBindingAuthContextRef(authContextRef: string): {
  binding_mode: McpCredentialBindingRecord["binding_mode"];
  credential_binding_id: string;
  broker_profile_id: string;
} {
  const [bindingMode, credentialBindingId, ...brokerProfileParts] = authContextRef.split(":");
  const brokerProfileId = brokerProfileParts.join(":").trim();
  if (
    !(
      bindingMode === "oauth_session" ||
      bindingMode === "derived_token" ||
      bindingMode === "bearer_secret_ref" ||
      bindingMode === "session_token" ||
      bindingMode === "hosted_token_exchange"
    ) ||
    credentialBindingId.trim().length === 0 ||
    brokerProfileId.length === 0
  ) {
    throw new PreconditionError("Hosted MCP auth context reference is malformed.", {
      auth_context_ref: authContextRef,
    });
  }

  return {
    binding_mode: bindingMode,
    credential_binding_id: credentialBindingId.trim(),
    broker_profile_id: brokerProfileId,
  };
}

interface HostedDelegatedExecutionContext {
  serverProfileId: string;
  toolName: string;
  profile: McpServerProfileRecord;
  binding: McpCredentialBindingRecord | null;
  endpoint: URL;
  arguments: Record<string, unknown>;
  authContextRef: string;
}

function resolveHostedDelegatedExecutionContext(params: {
  action: ActionRecord;
  mcpRegistry: McpServerRegistry;
}): HostedDelegatedExecutionContext {
  const mcpFacet = isObject(params.action.facets.mcp) ? params.action.facets.mcp : {};
  const serverProfileId = typeof mcpFacet.server_profile_id === "string" ? mcpFacet.server_profile_id.trim() : "";
  const toolName = typeof mcpFacet.tool_name === "string" ? mcpFacet.tool_name.trim() : "";
  if (serverProfileId.length === 0 || toolName.length === 0) {
    throw new PreconditionError("Hosted delegated MCP execution requires a resolved server profile and tool name.", {
      action_id: params.action.action_id,
      server_profile_id: serverProfileId || null,
      tool_name: toolName || null,
    });
  }

  const profile = params.mcpRegistry.getProfile(serverProfileId);
  if (!profile || profile.status !== "active") {
    throw new PreconditionError("Hosted delegated MCP execution requires an active server profile.", {
      action_id: params.action.action_id,
      server_profile_id: serverProfileId,
      profile_status: profile?.status ?? null,
    });
  }
  if (profile.drift_state !== "clean") {
    throw new PreconditionError(
      "Hosted delegated MCP execution is blocked while the server profile has unresolved drift.",
      {
        action_id: params.action.action_id,
        server_profile_id: serverProfileId,
        drift_state: profile.drift_state,
      },
    );
  }
  if (!profile.allowed_execution_modes.includes("hosted_delegated")) {
    throw new PreconditionError("Hosted delegated MCP execution is not enabled for this server profile.", {
      action_id: params.action.action_id,
      server_profile_id: serverProfileId,
      allowed_execution_modes: profile.allowed_execution_modes,
    });
  }

  const trustDecision = params.mcpRegistry.getActiveTrustDecision(serverProfileId);
  if (
    !trustDecision ||
    trustDecision.decision === "deny" ||
    !trustDecision.allowed_execution_modes.includes("hosted_delegated")
  ) {
    throw new PreconditionError(
      "Hosted delegated MCP execution requires an active trust decision that explicitly allows hosted_delegated mode.",
      {
        action_id: params.action.action_id,
        server_profile_id: serverProfileId,
        active_trust_decision_id: profile.active_trust_decision_id,
      },
    );
  }

  const binding = params.mcpRegistry.getActiveCredentialBinding(serverProfileId);
  if (
    profile.auth_descriptor.mode !== "none" &&
    (!binding || !bindingStatusAllowsExecution(binding, "hosted_delegated") || !bindingSupportsHostedExecution(binding))
  ) {
    throw new PreconditionError("Hosted delegated MCP execution requires a lease-safe active credential binding.", {
      action_id: params.action.action_id,
      server_profile_id: serverProfileId,
      credential_binding_id: binding?.credential_binding_id ?? null,
      credential_binding_mode: binding?.binding_mode ?? null,
      credential_binding_status: binding?.status ?? null,
    });
  }

  const rawInput = isObject(params.action.input.raw) ? params.action.input.raw : {};
  return {
    serverProfileId,
    toolName,
    profile,
    binding: binding ?? null,
    endpoint: new URL(profile.canonical_endpoint),
    arguments: isObject(rawInput.arguments) ? (rawInput.arguments as Record<string, unknown>) : {},
    authContextRef: binding ? buildBindingAuthContextRef(binding) : "none",
  };
}

function buildHostedExecutionJobRecord(
  action: ActionRecord,
  context: HostedDelegatedExecutionContext,
): HostedMcpExecutionJobRecord {
  const now = new Date().toISOString();
  return {
    job_id: createPrefixedId("mcpjob_"),
    run_id: action.run_id,
    action_id: action.action_id,
    server_profile_id: context.serverProfileId,
    tool_name: context.toolName,
    server_display_name: context.profile.display_name ?? context.profile.server_profile_id,
    canonical_endpoint: context.profile.canonical_endpoint,
    network_scope: context.profile.network_scope,
    allowed_hosts: [context.endpoint.hostname],
    auth_context_ref: context.authContextRef,
    arguments: context.arguments,
    status: "queued",
    attempt_count: 0,
    max_attempts: 4,
    current_lease_id: null,
    claimed_by: null,
    claimed_at: null,
    last_heartbeat_at: null,
    cancel_requested_at: null,
    cancel_requested_by_session_id: null,
    cancel_reason: null,
    canceled_at: null,
    next_attempt_at: now,
    created_at: now,
    updated_at: now,
    completed_at: null,
    last_error: null,
    execution_result: null,
  };
}

function validateHostedExecutionJobState(
  job: HostedMcpExecutionJobRecord,
  mcpRegistry: McpServerRegistry,
): {
  profile: McpServerProfileRecord;
  binding: McpCredentialBindingRecord | null;
} {
  const profile = mcpRegistry.getProfile(job.server_profile_id);
  if (!profile || profile.status !== "active") {
    throw new PreconditionError("Hosted delegated MCP execution job no longer has an active server profile.", {
      action_id: job.action_id,
      server_profile_id: job.server_profile_id,
      profile_status: profile?.status ?? null,
      job_id: job.job_id,
    });
  }
  if (profile.drift_state !== "clean") {
    throw new PreconditionError(
      "Hosted delegated MCP execution job is blocked while the server profile has unresolved drift.",
      {
        action_id: job.action_id,
        server_profile_id: job.server_profile_id,
        drift_state: profile.drift_state,
        job_id: job.job_id,
      },
    );
  }
  if (profile.canonical_endpoint !== job.canonical_endpoint) {
    throw new PreconditionError(
      "Hosted delegated MCP execution job target no longer matches the active server profile.",
      {
        action_id: job.action_id,
        server_profile_id: job.server_profile_id,
        expected_endpoint: job.canonical_endpoint,
        current_endpoint: profile.canonical_endpoint,
        job_id: job.job_id,
      },
    );
  }

  const trustDecision = mcpRegistry.getActiveTrustDecision(job.server_profile_id);
  if (
    !trustDecision ||
    trustDecision.decision === "deny" ||
    !trustDecision.allowed_execution_modes.includes("hosted_delegated")
  ) {
    throw new PreconditionError(
      "Hosted delegated MCP execution job requires an active trust decision for hosted_delegated mode.",
      {
        action_id: job.action_id,
        server_profile_id: job.server_profile_id,
        active_trust_decision_id: profile.active_trust_decision_id,
        job_id: job.job_id,
      },
    );
  }

  if (job.auth_context_ref === "none") {
    return {
      profile,
      binding: null,
    };
  }

  const authContext = parseBindingAuthContextRef(job.auth_context_ref);
  const binding = mcpRegistry.getCredentialBinding(authContext.credential_binding_id);
  if (
    !binding ||
    binding.broker_profile_id !== authContext.broker_profile_id ||
    binding.binding_mode !== authContext.binding_mode ||
    !bindingStatusAllowsExecution(binding, "hosted_delegated") ||
    !bindingSupportsHostedExecution(binding)
  ) {
    throw new PreconditionError(
      "Hosted delegated MCP execution job no longer has a lease-safe active credential binding.",
      {
        action_id: job.action_id,
        server_profile_id: job.server_profile_id,
        credential_binding_id: binding?.credential_binding_id ?? authContext.credential_binding_id,
        credential_binding_mode: binding?.binding_mode ?? authContext.binding_mode,
        credential_binding_status: binding?.status ?? null,
        job_id: job.job_id,
      },
    );
  }

  return {
    profile,
    binding,
  };
}

function issueHostedDelegatedLease(params: {
  job: HostedMcpExecutionJobRecord;
  binding: McpCredentialBindingRecord | null;
  mcpRegistry: McpServerRegistry;
  journal: RunJournal;
}): HostedMcpExecutionLeaseRecord {
  const issuedAt = new Date().toISOString();
  const leaseRecord: HostedMcpExecutionLeaseRecord = {
    lease_id: createPrefixedId("mcplease_"),
    run_id: params.job.run_id,
    action_id: params.job.action_id,
    server_profile_id: params.job.server_profile_id,
    tool_name: params.job.tool_name,
    auth_context_ref: params.binding ? buildBindingAuthContextRef(params.binding) : "none",
    allowed_hosts: params.job.allowed_hosts,
    issued_at: issuedAt,
    expires_at: new Date(Date.now() + HOSTED_MCP_LEASE_TTL_MS).toISOString(),
    artifact_budget: { ...HOSTED_MCP_DEFAULT_ARTIFACT_BUDGET },
    single_use: true,
    status: "issued",
    consumed_at: null,
    revoked_at: null,
  };
  params.mcpRegistry.upsertHostedExecutionLease(leaseRecord);
  params.journal.appendRunEvent(params.job.run_id, {
    event_type: "mcp_hosted_lease_issued",
    occurred_at: issuedAt,
    recorded_at: issuedAt,
    payload: {
      action_id: params.job.action_id,
      job_id: params.job.job_id,
      lease_id: leaseRecord.lease_id,
      server_profile_id: params.job.server_profile_id,
      tool_name: params.job.tool_name,
      allowed_hosts: leaseRecord.allowed_hosts,
      auth_context_ref: leaseRecord.auth_context_ref,
      expires_at: leaseRecord.expires_at,
    },
  });
  return leaseRecord;
}

function revokeHostedDelegatedLease(leaseRecord: HostedMcpExecutionLeaseRecord, mcpRegistry: McpServerRegistry): void {
  const storedLease = mcpRegistry.getHostedExecutionLease(leaseRecord.lease_id);
  if (!storedLease || storedLease.status !== "issued") {
    return;
  }

  mcpRegistry.upsertHostedExecutionLease({
    ...storedLease,
    status: "revoked",
    revoked_at: new Date().toISOString(),
  });
}

async function executeHostedDelegatedJobAttempt(params: {
  job: HostedMcpExecutionJobRecord;
  broker: SessionCredentialBroker;
  mcpRegistry: McpServerRegistry;
  journal: RunJournal;
  hostedWorkerClient: HostedMcpWorkerClient;
  signalHeartbeat: () => void;
  cancelSignal: AbortSignal;
}): Promise<ExecutionResult> {
  const { profile, binding } = validateHostedExecutionJobState(params.job, params.mcpRegistry);
  const endpoint = new URL(params.job.canonical_endpoint);
  const leaseRecord = issueHostedDelegatedLease({
    job: params.job,
    binding,
    mcpRegistry: params.mcpRegistry,
    journal: params.journal,
  });

  params.mcpRegistry.upsertHostedExecutionJob({
    ...params.job,
    current_lease_id: leaseRecord.lease_id,
    updated_at: new Date().toISOString(),
  });
  params.signalHeartbeat();

  try {
    let authorizationHeader: string | null = null;
    if (binding) {
      const authContext = parseBindingAuthContextRef(leaseRecord.auth_context_ref);
      if (
        authContext.credential_binding_id !== binding.credential_binding_id ||
        authContext.binding_mode !== binding.binding_mode
      ) {
        throw new PreconditionError(
          "Hosted delegated MCP lease auth scope does not match the active credential binding.",
          {
            action_id: params.job.action_id,
            lease_id: leaseRecord.lease_id,
            credential_binding_id: binding.credential_binding_id,
            auth_context_ref: leaseRecord.auth_context_ref,
            job_id: params.job.job_id,
          },
        );
      }
      authorizationHeader = params.broker.resolveMcpBearerSecret(authContext.broker_profile_id).authorization_header;
    }

    const storedLease = params.mcpRegistry.getHostedExecutionLease(leaseRecord.lease_id);
    if (!storedLease || storedLease.status !== "issued" || Date.parse(storedLease.expires_at) <= Date.now()) {
      throw new PreconditionError("Hosted delegated MCP lease is invalid or expired before worker execution started.", {
        action_id: params.job.action_id,
        lease_id: leaseRecord.lease_id,
        job_id: params.job.job_id,
      });
    }
    if (!storedLease.allowed_hosts.includes(endpoint.hostname)) {
      throw new PreconditionError("Hosted delegated MCP lease does not allow the resolved endpoint host.", {
        action_id: params.job.action_id,
        lease_id: leaseRecord.lease_id,
        hostname: endpoint.hostname,
        allowed_hosts: storedLease.allowed_hosts,
        job_id: params.job.job_id,
      });
    }
    if (storedLease.single_use && storedLease.consumed_at) {
      throw new PreconditionError("Hosted delegated MCP lease has already been consumed.", {
        action_id: params.job.action_id,
        lease_id: leaseRecord.lease_id,
        consumed_at: storedLease.consumed_at,
        job_id: params.job.job_id,
      });
    }

    params.mcpRegistry.upsertHostedExecutionLease({
      ...storedLease,
      status: "consumed",
      consumed_at: new Date().toISOString(),
    });

    const executionResponse = await params.hostedWorkerClient.executeHostedMcp(
      {
        job_id: params.job.job_id,
        lease: leaseRecord,
        action_id: params.job.action_id,
        server_id: profile.server_profile_id,
        server_display_name: profile.display_name ?? profile.server_profile_id,
        canonical_endpoint: profile.canonical_endpoint,
        network_scope: profile.network_scope,
        max_concurrent_calls: 1,
        tool_name: params.job.tool_name,
        arguments: params.job.arguments,
        auth:
          authorizationHeader === null
            ? { type: "none" }
            : { type: "delegated_bearer", authorization_header: authorizationHeader },
      },
      params.cancelSignal,
    );
    const executionResult = executionResponse.execution_result;
    const artifactManifest = executionResult.artifacts.map((artifact) => ({
      artifact_id: artifact.artifact_id,
      type: artifact.type,
      content_ref: artifact.content_ref,
      byte_size: artifact.byte_size,
      visibility: artifact.visibility,
    }));
    const attestationPayload = executionResponse.attestation.payload;
    if (
      attestationPayload.lease_id !== leaseRecord.lease_id ||
      attestationPayload.result_hash !== resolveHostedActionHash(executionResult.output) ||
      attestationPayload.artifact_manifest_hash !== resolveHostedActionHash(artifactManifest) ||
      !params.hostedWorkerClient.verifyBundle(attestationPayload, executionResponse.attestation.signature)
    ) {
      throw new PreconditionError("Hosted delegated MCP attestation verification failed.", {
        action_id: params.job.action_id,
        lease_id: leaseRecord.lease_id,
        job_id: params.job.job_id,
      });
    }

    const attestation: HostedMcpExecutionAttestationRecord = {
      attestation_id: createPrefixedId("mcpattest_"),
      lease_id: leaseRecord.lease_id,
      worker_runtime_id: attestationPayload.worker_runtime_id,
      worker_image_digest: attestationPayload.worker_image_digest,
      started_at: executionResponse.attestation.started_at,
      completed_at: executionResponse.attestation.completed_at,
      result_hash: attestationPayload.result_hash,
      artifact_manifest_hash: attestationPayload.artifact_manifest_hash,
      signature: executionResponse.attestation.signature,
      verified_at: new Date().toISOString(),
    };
    params.mcpRegistry.upsertHostedExecutionAttestation(attestation);
    params.journal.appendRunEvent(params.job.run_id, {
      event_type: "mcp_hosted_result_ingested",
      occurred_at: attestation.completed_at,
      recorded_at: attestation.completed_at,
      payload: {
        action_id: params.job.action_id,
        job_id: params.job.job_id,
        lease_id: leaseRecord.lease_id,
        attestation_id: attestation.attestation_id,
        worker_runtime_id: attestation.worker_runtime_id,
        worker_image_digest: attestation.worker_image_digest,
        result_hash: attestation.result_hash,
        artifact_manifest_hash: attestation.artifact_manifest_hash,
        attestation_verified: true,
      },
    });

    return {
      ...executionResult,
      output: {
        ...executionResult.output,
        execution_mode: "hosted_delegated",
        lease_id: leaseRecord.lease_id,
        attestation_id: attestation.attestation_id,
        attestation_verified: true,
        worker_runtime_id: attestation.worker_runtime_id,
        worker_image_digest: attestation.worker_image_digest,
        credential_binding_mode: binding?.binding_mode ?? "none",
      },
    };
  } catch (error) {
    revokeHostedDelegatedLease(leaseRecord, params.mcpRegistry);
    throw error;
  }
}

function bindingStatusAllowsExecution(
  binding: McpCredentialBindingRecord,
  executionMode: "local_proxy" | "hosted_delegated",
): boolean {
  if (binding.status === "active") {
    return true;
  }

  return binding.status === "degraded" && binding.binding_mode === "session_token" && executionMode === "local_proxy";
}

function bindingSupportsHostedExecution(binding: McpCredentialBindingRecord): boolean {
  return binding.binding_mode !== "session_token";
}

function inferCandidateTransport(candidate: McpServerCandidateRecord): "streamable_http" {
  if (candidate.transport_hint && candidate.transport_hint !== "streamable_http") {
    throw new PreconditionError(
      "Phase-1 remote MCP candidate resolution currently supports only streamable_http endpoints.",
      {
        candidate_id: candidate.candidate_id,
        transport_hint: candidate.transport_hint,
      },
    );
  }

  const url = new URL(candidate.raw_endpoint);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PreconditionError("Remote MCP candidate resolution requires an http or https endpoint.", {
      candidate_id: candidate.candidate_id,
      raw_endpoint: candidate.raw_endpoint,
      protocol: url.protocol,
    });
  }

  return "streamable_http";
}

async function listRemoteMcpTools(url: URL): Promise<Array<Record<string, unknown>>> {
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client({
    name: "agentgit-mcp-candidate-resolver",
    version: "0.1.0",
  });

  try {
    await client.connect(transport);
    const listedTools: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;

    do {
      const listed = await client.listTools(cursor ? { cursor } : undefined);
      listedTools.push(
        ...listed.tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? null,
          inputSchema: tool.inputSchema ?? null,
          outputSchema: "outputSchema" in tool ? ((tool as Record<string, unknown>).outputSchema ?? null) : null,
          annotations: tool.annotations ?? null,
        })),
      );
      cursor = typeof listed.nextCursor === "string" && listed.nextCursor.length > 0 ? listed.nextCursor : undefined;
    } while (cursor);

    return listedTools.sort((left, right) => String(left.name ?? "").localeCompare(String(right.name ?? "")));
  } finally {
    await transport.close().catch(() => undefined);
  }
}

function buildToolInventoryHash(tools: Array<Record<string, unknown>>): string {
  return createHash("sha256").update(stableJsonStringify(tools), "utf8").digest("hex");
}

function hashToolSchema(schema: unknown): string | null {
  return schema && typeof schema === "object"
    ? createHash("sha256").update(stableJsonStringify(schema), "utf8").digest("hex")
    : null;
}

function inferImportedToolSideEffect(tool: Record<string, unknown>): ImportedMcpToolRecord["side_effect_level"] {
  const annotations = tool.annotations;
  if (annotations && typeof annotations === "object") {
    const record = annotations as Record<string, unknown>;
    if (record.destructiveHint === true || record.destructive_hint === true) {
      return "destructive";
    }
    if (record.readOnlyHint === true || record.read_only_hint === true) {
      return "read_only";
    }
  }

  return "unknown";
}

function deriveImportedTools(tools: Array<Record<string, unknown>>, importedAt: string): ImportedMcpToolRecord[] {
  return tools.map((tool) => ({
    tool_name: String(tool.name ?? "").trim(),
    side_effect_level: inferImportedToolSideEffect(tool),
    approval_mode: undefined,
    input_schema_hash: hashToolSchema(tool.inputSchema ?? null),
    output_schema_hash: hashToolSchema(tool.outputSchema ?? null),
    annotations:
      tool.annotations && typeof tool.annotations === "object" ? (tool.annotations as Record<string, unknown>) : null,
    imported_at: importedAt,
  }));
}

function detectProfileDrift(existingProfile: McpServerProfileRecord, nextProfile: McpServerProfileRecord): string[] {
  const reasonCodes: string[] = [];

  if (existingProfile.canonical_endpoint !== nextProfile.canonical_endpoint) {
    reasonCodes.push("MCP_REMOTE_IDENTITY_CHANGED");
  }
  if (existingProfile.identity_baseline.auth_issuer !== nextProfile.identity_baseline.auth_issuer) {
    reasonCodes.push("MCP_REMOTE_AUTH_ISSUER_CHANGED");
  }
  if (existingProfile.identity_baseline.tool_inventory_hash !== nextProfile.identity_baseline.tool_inventory_hash) {
    reasonCodes.push("MCP_TOOL_INVENTORY_CHANGED");
  }

  return [...new Set(reasonCodes)];
}

function defaultTrustTier(candidate: McpServerCandidateRecord): McpServerProfileRecord["trust_tier"] {
  return candidate.source_kind === "operator_seeded" ? "operator_owned" : "operator_approved_public";
}

function deriveApprovalModeForImportedTool(
  tool: ImportedMcpToolRecord,
  profile: McpServerProfileRecord,
  trustDecision: McpServerTrustDecisionRecord,
): "allow" | "ask" {
  if (trustDecision.decision === "deny") {
    return "ask";
  }

  if (tool.side_effect_level === "read_only") {
    return "allow";
  }

  if (trustDecision.decision === "allow_policy_managed" && profile.trust_tier === "operator_owned") {
    return "allow";
  }

  return "ask";
}

function buildDerivedServerFromProfile(
  profile: McpServerProfileRecord,
  trustDecision: McpServerTrustDecisionRecord,
  binding: McpCredentialBindingRecord | null,
) {
  if (profile.transport !== "streamable_http") {
    throw new PreconditionError(
      "Phase-2 governed remote MCP profiles currently support only streamable_http execution.",
      {
        server_profile_id: profile.server_profile_id,
        transport: profile.transport,
      },
    );
  }

  const auth =
    binding && bindingStatusAllowsExecution(binding, "local_proxy")
      ? {
          type: "bearer_secret_ref" as const,
          secret_id: binding.broker_profile_id,
        }
      : undefined;

  return {
    server_id: profile.server_profile_id,
    display_name: profile.display_name ?? profile.server_profile_id,
    transport: "streamable_http" as const,
    url: profile.canonical_endpoint,
    network_scope: profile.network_scope,
    max_concurrent_calls: 1,
    ...(auth ? { auth } : {}),
    tools: profile.imported_tools.map((tool) => ({
      tool_name: tool.tool_name,
      side_effect_level: tool.side_effect_level,
      approval_mode: deriveApprovalModeForImportedTool(tool, profile, trustDecision),
    })),
  };
}

function syncDerivedProfileServer(mcpRegistry: McpServerRegistry, profile: McpServerProfileRecord): void {
  const trustDecision = mcpRegistry.getActiveTrustDecision(profile.server_profile_id);
  const binding = mcpRegistry.getActiveCredentialBinding(profile.server_profile_id);

  if (
    profile.status !== "active" ||
    profile.drift_state !== "clean" ||
    !trustDecision ||
    trustDecision.decision === "deny"
  ) {
    mcpRegistry.removeServer(profile.server_profile_id);
    return;
  }

  if (binding && !bindingStatusAllowsExecution(binding, "local_proxy")) {
    mcpRegistry.removeServer(profile.server_profile_id);
    return;
  }

  const derivedServer = buildDerivedServerFromProfile(profile, trustDecision, binding);
  mcpRegistry.upsertServer(derivedServer, "remote_profile");
}

function requireValidSession(state: AuthorityState, method: string, sessionId: string | undefined): string {
  const session = state.getSession(sessionId);
  if (!session) {
    throw new PreconditionError(`A valid session_id is required before ${method}.`, {
      session_id: sessionId,
    });
  }

  return session.session_id;
}

type RunSummaryRecord = NonNullable<ReturnType<RunJournal["getRunSummary"]>>;

function canonicalizeWorkspaceRootForAuthorization(rootPath: string): string {
  try {
    return fs.realpathSync(rootPath);
  } catch {
    return path.resolve(rootPath);
  }
}

function sessionCanAccessRun(
  state: AuthorityState,
  sessionId: string,
  runSummary: { workspace_roots: string[] },
): boolean {
  const session = state.getSession(sessionId);
  if (!session) {
    return false;
  }

  const sessionRoots = new Set(session.workspace_roots.map((root) => canonicalizeWorkspaceRootForAuthorization(root)));
  return runSummary.workspace_roots
    .map((root) => canonicalizeWorkspaceRootForAuthorization(root))
    .some((root) => sessionRoots.has(root));
}

function requireAuthorizedRunSummary(
  state: AuthorityState,
  journal: RunJournal,
  sessionId: string,
  runId: string,
  referenceField = "run_id",
): RunSummaryRecord {
  const runSummary = journal.getRunSummary(runId);

  if (!runSummary || !sessionCanAccessRun(state, sessionId, runSummary)) {
    throw new NotFoundError(`No run found for ${runId}.`, {
      [referenceField]: runId,
    });
  }

  return runSummary;
}

function handleSubmitMcpServerCandidate(
  state: AuthorityState,
  mcpRegistry: McpServerRegistry,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<SubmitMcpServerCandidateResponsePayload> {
  const payload = validate(SubmitMcpServerCandidateRequestPayloadSchema, request.payload);
  const sessionId = requireValidSession(state, "submit_mcp_server_candidate", request.session_id);
  if (payload.candidate.submitted_by_run_id) {
    const run = state.getRun(payload.candidate.submitted_by_run_id);
    if (!run || !sessionCanAccessRun(state, sessionId, run)) {
      throw new NotFoundError(`No run found for ${payload.candidate.submitted_by_run_id}.`, {
        run_id: payload.candidate.submitted_by_run_id,
      });
    }
  }

  const now = new Date().toISOString();
  const candidate: McpServerCandidateRecord = {
    candidate_id: createPrefixedId("mcpcand_"),
    source_kind: payload.candidate.source_kind,
    raw_endpoint: payload.candidate.raw_endpoint,
    transport_hint: payload.candidate.transport_hint ?? null,
    workspace_id: payload.candidate.workspace_id ?? null,
    submitted_by_session_id: sessionId,
    submitted_by_run_id: payload.candidate.submitted_by_run_id ?? null,
    notes: payload.candidate.notes ?? null,
    resolution_state: "pending",
    resolution_error: null,
    submitted_at: now,
    updated_at: now,
  };

  return makeSuccessResponse(request.request_id, sessionId, {
    candidate: mcpRegistry.submitCandidate(candidate),
  });
}

async function handleResolveMcpServerCandidate(
  state: AuthorityState,
  mcpRegistry: McpServerRegistry,
  request: RequestEnvelope<unknown>,
): Promise<ResponseEnvelope<ResolveMcpServerCandidateResponsePayload>> {
  const payload = validate(ResolveMcpServerCandidateRequestPayloadSchema, request.payload);
  const sessionId = requireValidSession(state, "resolve_mcp_server_candidate", request.session_id);
  const existingCandidate = mcpRegistry.getCandidate(payload.candidate_id);
  if (!existingCandidate) {
    throw new NotFoundError(`No MCP server candidate found for ${payload.candidate_id}.`, {
      candidate_id: payload.candidate_id,
    });
  }

  const now = new Date().toISOString();

  try {
    const transport = inferCandidateTransport(existingCandidate);
    const url = new URL(existingCandidate.raw_endpoint);
    const tools = await listRemoteMcpTools(url);
    const toolInventoryHash = buildToolInventoryHash(tools);
    const existingProfile = mcpRegistry.getProfileByCandidateId(existingCandidate.candidate_id);
    const importedAt = now;
    const importedTools = deriveImportedTools(tools, importedAt);
    const nextProfile: McpServerProfileRecord = {
      server_profile_id: existingProfile?.server_profile_id ?? createPrefixedId("mcpprof_"),
      candidate_id: existingCandidate.candidate_id,
      display_name: payload.display_name ?? existingProfile?.display_name ?? url.hostname,
      transport,
      canonical_endpoint: url.toString(),
      network_scope: classifyMcpNetworkScope(url),
      trust_tier: existingProfile?.trust_tier ?? defaultTrustTier(existingCandidate),
      status: existingProfile?.status ?? "draft",
      drift_state: "clean",
      quarantine_reason_codes: [],
      allowed_execution_modes: existingProfile?.allowed_execution_modes ?? ["local_proxy"],
      active_trust_decision_id: existingProfile?.active_trust_decision_id ?? null,
      active_credential_binding_id: existingProfile?.active_credential_binding_id ?? null,
      auth_descriptor: existingProfile?.auth_descriptor ?? {
        mode: "none",
        audience: null,
        scope_labels: [],
      },
      identity_baseline: {
        canonical_host: url.hostname,
        canonical_port: url.port.length > 0 ? Number.parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80,
        tls_identity_summary: url.protocol === "https:" ? "platform_tls_validated" : null,
        auth_issuer: null,
        publisher_identity: null,
        tool_inventory_hash: toolInventoryHash,
        fetched_at: now,
      },
      imported_tools: importedTools,
      tool_inventory_version: toolInventoryHash,
      last_resolved_at: now,
      created_at: existingProfile?.created_at ?? now,
      updated_at: now,
    };

    const driftReasonCodes = existingProfile ? detectProfileDrift(existingProfile, nextProfile) : [];
    const resolvedProfile: McpServerProfileRecord =
      driftReasonCodes.length > 0
        ? {
            ...nextProfile,
            drift_state: "drifted",
            quarantine_reason_codes: driftReasonCodes,
            status:
              existingProfile && existingProfile.status !== "draft" && existingProfile.status !== "revoked"
                ? "quarantined"
                : nextProfile.status,
          }
        : nextProfile;

    const resolvedCandidate = mcpRegistry.upsertCandidate({
      ...existingCandidate,
      resolution_state: "resolved",
      resolution_error: null,
      updated_at: now,
    });
    const upsertedProfile = mcpRegistry.upsertProfile(resolvedProfile);
    syncDerivedProfileServer(mcpRegistry, upsertedProfile.profile);

    return makeSuccessResponse(request.request_id, sessionId, {
      candidate: resolvedCandidate,
      profile: upsertedProfile.profile,
      created_profile: upsertedProfile.created,
      drift_detected: driftReasonCodes.length > 0,
    });
  } catch (error) {
    mcpRegistry.upsertCandidate({
      ...existingCandidate,
      resolution_state: "failed",
      resolution_error: error instanceof Error ? error.message : String(error),
      updated_at: now,
    });
    throw error;
  }
}

function handleListMcpServerTrustDecisions(
  mcpRegistry: McpServerRegistry,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<ListMcpServerTrustDecisionsResponsePayload> {
  const payload = validate(ListMcpServerTrustDecisionsRequestPayloadSchema, request.payload);
  return makeSuccessResponse(request.request_id, request.session_id, {
    trust_decisions: mcpRegistry.listTrustDecisions(payload.server_profile_id),
  });
}

function handleListMcpServerCredentialBindings(
  mcpRegistry: McpServerRegistry,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<ListMcpServerCredentialBindingsResponsePayload> {
  const payload = validate(ListMcpServerCredentialBindingsRequestPayloadSchema, request.payload);
  return makeSuccessResponse(request.request_id, request.session_id, {
    credential_bindings: mcpRegistry.listCredentialBindings(payload.server_profile_id),
  });
}

function handleBindMcpServerCredentials(
  state: AuthorityState,
  broker: SessionCredentialBroker,
  mcpRegistry: McpServerRegistry,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<BindMcpServerCredentialsResponsePayload> {
  const payload = validate(BindMcpServerCredentialsRequestPayloadSchema, request.payload);
  requireValidSession(state, "bind_mcp_server_credentials", request.session_id);
  const profile = mcpRegistry.getProfile(payload.server_profile_id);
  if (!profile) {
    throw new NotFoundError(`No MCP server profile found for ${payload.server_profile_id}.`, {
      server_profile_id: payload.server_profile_id,
    });
  }

  broker.resolveMcpBearerSecret(payload.broker_profile_id);
  const now = new Date().toISOString();
  const existingBinding = mcpRegistry.getActiveCredentialBinding(profile.server_profile_id);
  const bindingResult = mcpRegistry.upsertCredentialBinding({
    credential_binding_id: existingBinding?.credential_binding_id ?? createPrefixedId("mcpbind_"),
    server_profile_id: profile.server_profile_id,
    binding_mode: payload.binding_mode,
    broker_profile_id: payload.broker_profile_id,
    scope_labels: payload.scope_labels ?? [],
    audience: payload.audience ?? null,
    status: payload.binding_mode === "session_token" ? "degraded" : "active",
    created_at: existingBinding?.created_at ?? now,
    updated_at: now,
    revoked_at: null,
  });
  const updatedProfile = mcpRegistry.upsertProfile({
    ...profile,
    active_credential_binding_id: bindingResult.credential_binding.credential_binding_id,
    auth_descriptor: {
      mode: payload.binding_mode,
      audience: payload.audience ?? null,
      scope_labels: payload.scope_labels ?? [],
    },
    updated_at: now,
  });
  syncDerivedProfileServer(mcpRegistry, updatedProfile.profile);

  return makeSuccessResponse(request.request_id, request.session_id, {
    profile: updatedProfile.profile,
    credential_binding: bindingResult.credential_binding,
    created: bindingResult.created,
  });
}

function handleRevokeMcpServerCredentials(
  state: AuthorityState,
  mcpRegistry: McpServerRegistry,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<RevokeMcpServerCredentialsResponsePayload> {
  const payload = validate(RevokeMcpServerCredentialsRequestPayloadSchema, request.payload);
  requireValidSession(state, "revoke_mcp_server_credentials", request.session_id);
  const binding = mcpRegistry.getCredentialBinding(payload.credential_binding_id);
  if (!binding) {
    throw new NotFoundError(`No MCP credential binding found for ${payload.credential_binding_id}.`, {
      credential_binding_id: payload.credential_binding_id,
    });
  }

  const now = new Date().toISOString();
  const updatedBinding = mcpRegistry.upsertCredentialBinding({
    ...binding,
    status: "revoked",
    updated_at: now,
    revoked_at: now,
  });
  const profile = mcpRegistry.getProfile(binding.server_profile_id);
  if (!profile) {
    return makeSuccessResponse(request.request_id, request.session_id, {
      profile: null,
      credential_binding: updatedBinding.credential_binding,
    });
  }

  const nextStatus = profile.status === "active" ? "draft" : profile.status;
  const updatedProfile = mcpRegistry.upsertProfile({
    ...profile,
    status: nextStatus,
    active_credential_binding_id:
      profile.active_credential_binding_id === binding.credential_binding_id
        ? null
        : profile.active_credential_binding_id,
    updated_at: now,
  });
  syncDerivedProfileServer(mcpRegistry, updatedProfile.profile);

  return makeSuccessResponse(request.request_id, request.session_id, {
    profile: updatedProfile.profile,
    credential_binding: updatedBinding.credential_binding,
  });
}

function handleApproveMcpServerProfile(
  state: AuthorityState,
  mcpRegistry: McpServerRegistry,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<ApproveMcpServerProfileResponsePayload> {
  const payload = validate(ApproveMcpServerProfileRequestPayloadSchema, request.payload);
  const sessionId = requireValidSession(state, "approve_mcp_server_profile", request.session_id);
  const profile = mcpRegistry.getProfile(payload.server_profile_id);
  if (!profile) {
    throw new NotFoundError(`No MCP server profile found for ${payload.server_profile_id}.`, {
      server_profile_id: payload.server_profile_id,
    });
  }

  const now = new Date().toISOString();
  const trustDecision: McpServerTrustDecisionRecord = {
    trust_decision_id: createPrefixedId("mcptrust_"),
    server_profile_id: profile.server_profile_id,
    decision: payload.decision,
    trust_tier: payload.trust_tier,
    allowed_execution_modes: payload.allowed_execution_modes ?? profile.allowed_execution_modes,
    max_side_effect_level_without_approval: payload.max_side_effect_level_without_approval ?? "read_only",
    reason_codes: payload.reason_codes ?? [],
    approved_by_session_id: sessionId,
    approved_at: now,
    valid_until: payload.valid_until ?? null,
    reapproval_triggers: payload.reapproval_triggers ?? [],
  };
  const trustDecisionResult = mcpRegistry.upsertTrustDecision(trustDecision);
  const updatedProfile = mcpRegistry.upsertProfile({
    ...profile,
    trust_tier: payload.trust_tier,
    allowed_execution_modes: trustDecision.allowed_execution_modes,
    active_trust_decision_id: trustDecision.trust_decision_id,
    status:
      payload.decision === "deny"
        ? "draft"
        : profile.drift_state === "clean" && profile.status !== "quarantined"
          ? "pending_approval"
          : profile.status,
    updated_at: now,
  });

  return makeSuccessResponse(request.request_id, sessionId, {
    profile: updatedProfile.profile,
    trust_decision: trustDecisionResult.trust_decision,
    created: trustDecisionResult.created,
  });
}

function handleActivateMcpServerProfile(
  state: AuthorityState,
  mcpRegistry: McpServerRegistry,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<ActivateMcpServerProfileResponsePayload> {
  const payload = validate(ActivateMcpServerProfileRequestPayloadSchema, request.payload);
  const sessionId = requireValidSession(state, "activate_mcp_server_profile", request.session_id);
  const profile = mcpRegistry.getProfile(payload.server_profile_id);
  if (!profile) {
    throw new NotFoundError(`No MCP server profile found for ${payload.server_profile_id}.`, {
      server_profile_id: payload.server_profile_id,
    });
  }

  const trustDecision = mcpRegistry.getActiveTrustDecision(profile.server_profile_id);
  if (!trustDecision || trustDecision.decision === "deny") {
    throw new PreconditionError("MCP server profile requires an active non-deny trust decision before activation.", {
      server_profile_id: profile.server_profile_id,
      active_trust_decision_id: profile.active_trust_decision_id,
    });
  }
  if (profile.drift_state !== "clean" || profile.status === "quarantined" || profile.status === "revoked") {
    throw new PreconditionError("MCP server profile cannot be activated while drifted, quarantined, or revoked.", {
      server_profile_id: profile.server_profile_id,
      drift_state: profile.drift_state,
      status: profile.status,
    });
  }
  if (profile.allowed_execution_modes.length === 0) {
    throw new PreconditionError("MCP server profile must allow at least one execution mode before activation.", {
      server_profile_id: profile.server_profile_id,
    });
  }
  if (profile.auth_descriptor.mode !== "none" && !profile.active_credential_binding_id) {
    throw new PreconditionError(
      "MCP server profile activation requires a credential binding for non-none auth modes.",
      {
        server_profile_id: profile.server_profile_id,
        auth_mode: profile.auth_descriptor.mode,
      },
    );
  }
  if (profile.active_credential_binding_id) {
    const credentialBinding = mcpRegistry.getCredentialBinding(profile.active_credential_binding_id);
    if (
      !credentialBinding ||
      (!bindingStatusAllowsExecution(credentialBinding, "local_proxy") &&
        !bindingSupportsHostedExecution(credentialBinding))
    ) {
      throw new PreconditionError(
        "MCP server profile activation requires an active credential binding when one is configured.",
        {
          server_profile_id: profile.server_profile_id,
          credential_binding_id: profile.active_credential_binding_id,
          credential_binding_status: credentialBinding?.status ?? null,
        },
      );
    }

    if (
      credentialBinding.binding_mode === "session_token" &&
      profile.allowed_execution_modes.includes("hosted_delegated")
    ) {
      throw new PreconditionError(
        "MCP server profile activation cannot enable hosted_delegated execution with a degraded session_token binding.",
        {
          server_profile_id: profile.server_profile_id,
          credential_binding_id: credentialBinding.credential_binding_id,
          binding_mode: credentialBinding.binding_mode,
        },
      );
    }
  }

  const updatedProfile = mcpRegistry.upsertProfile({
    ...profile,
    status: "active",
    updated_at: new Date().toISOString(),
  });
  syncDerivedProfileServer(mcpRegistry, updatedProfile.profile);
  return makeSuccessResponse(request.request_id, sessionId, {
    profile: updatedProfile.profile,
  });
}

function handleQuarantineMcpServerProfile(
  state: AuthorityState,
  mcpRegistry: McpServerRegistry,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<QuarantineMcpServerProfileResponsePayload> {
  const payload = validate(QuarantineMcpServerProfileRequestPayloadSchema, request.payload);
  const sessionId = requireValidSession(state, "quarantine_mcp_server_profile", request.session_id);
  const profile = mcpRegistry.getProfile(payload.server_profile_id);
  if (!profile) {
    throw new NotFoundError(`No MCP server profile found for ${payload.server_profile_id}.`, {
      server_profile_id: payload.server_profile_id,
    });
  }

  const updatedProfile = mcpRegistry.upsertProfile({
    ...profile,
    status: "quarantined",
    drift_state: "drifted",
    quarantine_reason_codes: payload.reason_codes,
    updated_at: new Date().toISOString(),
  });
  syncDerivedProfileServer(mcpRegistry, updatedProfile.profile);
  return makeSuccessResponse(request.request_id, sessionId, {
    profile: updatedProfile.profile,
  });
}

function handleRevokeMcpServerProfile(
  state: AuthorityState,
  mcpRegistry: McpServerRegistry,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<RevokeMcpServerProfileResponsePayload> {
  const payload = validate(RevokeMcpServerProfileRequestPayloadSchema, request.payload);
  const sessionId = requireValidSession(state, "revoke_mcp_server_profile", request.session_id);
  const profile = mcpRegistry.getProfile(payload.server_profile_id);
  if (!profile) {
    throw new NotFoundError(`No MCP server profile found for ${payload.server_profile_id}.`, {
      server_profile_id: payload.server_profile_id,
    });
  }

  const updatedProfile = mcpRegistry.upsertProfile({
    ...profile,
    status: "revoked",
    quarantine_reason_codes: payload.reason_codes ?? profile.quarantine_reason_codes,
    updated_at: new Date().toISOString(),
  });
  syncDerivedProfileServer(mcpRegistry, updatedProfile.profile);
  return makeSuccessResponse(request.request_id, sessionId, {
    profile: updatedProfile.profile,
  });
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

function handleRequeueHostedMcpJob(
  state: AuthorityState,
  journal: RunJournal,
  hostedExecutionQueue: HostedExecutionQueue,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<RequeueHostedMcpJobResponsePayload> {
  const payload = validate(RequeueHostedMcpJobRequestPayloadSchema, request.payload);
  const sessionId = requireValidSession(state, "requeue_hosted_mcp_job", request.session_id);
  const previousJob = hostedExecutionQueue.inspectJob(payload.job_id);
  const result = hostedExecutionQueue.requeueFailedJobWithOptions({
    job_id: payload.job_id,
    reset_attempt_count: payload.reset_attempt_count,
    max_attempts: payload.max_attempts,
  });
  journal.appendRunEvent(result.job.run_id, {
    event_type: "mcp_hosted_job_requeued",
    occurred_at: result.job.updated_at,
    recorded_at: result.job.updated_at,
    payload: {
      action_id: result.job.action_id,
      job_id: result.job.job_id,
      previous_status: result.previous_status,
      previous_attempt_count: previousJob?.attempt_count ?? null,
      new_attempt_count: result.job.attempt_count,
      previous_max_attempts: previousJob?.max_attempts ?? null,
      new_max_attempts: result.job.max_attempts,
      attempt_count_reset: result.attempt_count_reset,
      max_attempts_updated: result.max_attempts_updated,
      requeued_by_session_id: sessionId,
      reason: payload.reason ?? null,
    },
  });
  return makeSuccessResponse(request.request_id, sessionId, result);
}

function handleCancelHostedMcpJob(
  state: AuthorityState,
  journal: RunJournal,
  hostedExecutionQueue: HostedExecutionQueue,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<CancelHostedMcpJobResponsePayload> {
  const payload = validate(CancelHostedMcpJobRequestPayloadSchema, request.payload);
  const sessionId = requireValidSession(state, "cancel_hosted_mcp_job", request.session_id);
  const result = hostedExecutionQueue.cancelJob({
    job_id: payload.job_id,
    requested_by_session_id: sessionId,
    reason: payload.reason ?? null,
  });
  journal.appendRunEvent(result.job.run_id, {
    event_type: result.terminal ? "mcp_hosted_job_canceled" : "mcp_hosted_job_cancel_requested",
    occurred_at: result.job.updated_at,
    recorded_at: result.job.updated_at,
    payload: {
      action_id: result.job.action_id,
      job_id: result.job.job_id,
      previous_status: result.previous_status,
      current_status: result.job.status,
      cancel_requested_by_session_id: sessionId,
      reason: payload.reason ?? null,
    },
  });
  return makeSuccessResponse(request.request_id, sessionId, result);
}

function handleDiagnostics(
  state: AuthorityState,
  journal: RunJournal,
  broker: SessionCredentialBroker,
  mcpRegistry: McpServerRegistry,
  publicHostPolicyRegistry: McpPublicHostPolicyRegistry,
  hostedWorkerClient: HostedMcpWorkerClient,
  hostedExecutionQueue: HostedExecutionQueue,
  policyRuntime: PolicyRuntimeState,
  runtimeOptions: Pick<
    StartServerOptions,
    "capabilityRefreshStaleMs" | "socketPath" | "journalPath" | "snapshotRootPath" | "mcpConcurrencyLeasePath"
  >,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<DiagnosticsResponsePayload> {
  const payload = validate(DiagnosticsRequestPayloadSchema, request.payload);
  const requestedSections = new Set(
    payload.sections ?? [
      "daemon_health",
      "journal_health",
      "maintenance_backlog",
      "projection_lag",
      "storage_summary",
      "capability_summary",
      "policy_summary",
      "security_posture",
      "hosted_worker",
      "hosted_queue",
    ],
  );
  const overview = journal.getDiagnosticsOverview();
  const liveSecurityState = detectMcpSecurityState(broker, runtimeOptions, mcpRegistry, publicHostPolicyRegistry);
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
    const degradedCount = capabilitySnapshot.capabilities.filter(
      (capability) => capability.status === "degraded",
    ).length;
    const unavailableCount = capabilitySnapshot.capabilities.filter(
      (capability) => capability.status === "unavailable",
    ).length;
    const refreshedAtMillis = Date.parse(capabilitySnapshot.refreshed_at);
    capabilitySummaryWarnings = [...capabilitySnapshot.degraded_mode_warnings];
    capabilitySummaryRefreshedAt = capabilitySnapshot.refreshed_at;
    capabilitySummaryWorkspaceRoot = capabilitySnapshot.workspace_root;
    capabilitySummaryCount = capabilitySnapshot.capabilities.length;
    capabilitySummaryDegraded = degradedCount;
    capabilitySummaryUnavailable = unavailableCount;

    if (!Number.isNaN(refreshedAtMillis) && Date.now() - refreshedAtMillis > capabilityRefreshStaleMs) {
      capabilitySummaryIsStale = true;
      capabilityHealthWarnings.push(
        "Latest capability refresh is stale; rerun capability_refresh if the host or workspace may have changed.",
      );
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
    storageWarnings.push(
      `${overview.maintenance_status.artifact_health.expired} artifact blob(s) have expired by retention policy.`,
    );
  }
  if (overview.maintenance_status.artifact_health.corrupted > 0) {
    storageWarnings.push(
      `${overview.maintenance_status.artifact_health.corrupted} artifact blob(s) are structurally corrupted.`,
    );
  }
  if (overview.maintenance_status.artifact_health.tampered > 0) {
    storageWarnings.push(
      `${overview.maintenance_status.artifact_health.tampered} artifact blob(s) failed integrity verification.`,
    );
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

  const securityWarnings: string[] = [];
  if (!liveSecurityState.durableSecretStorageAvailable) {
    securityWarnings.push(
      "Durable MCP secret storage is unavailable on this host; streamable_http secret references cannot meet the production storage bar.",
    );
  }
  securityWarnings.push(...liveSecurityState.stdioSandboxIssues);
  if (liveSecurityState.stdioMutableTagServers.length > 0) {
    securityWarnings.push(
      `${liveSecurityState.stdioMutableTagServers.length} stored stdio MCP server registration(s) still use OCI images without pinned sha256 digests and must be updated before governed execution can meet the production bar.`,
    );
  }
  if (liveSecurityState.stdioLocalBuildServers.length > 0) {
    securityWarnings.push(
      `${liveSecurityState.stdioLocalBuildServers.length} stdio MCP server(s) rely on oci_container.build and are suitable for local development only, not production rollout.`,
    );
  }
  if (liveSecurityState.stdioRegistryPolicyServers.length < liveSecurityState.stdioDigestPinnedServers.length) {
    securityWarnings.push(
      `Some digest-pinned stdio MCP server registrations are missing allowed_registries coverage and cannot meet the OCI supply-chain trust bar.`,
    );
  }
  if (liveSecurityState.stdioSignatureVerificationServers.length < liveSecurityState.stdioDigestPinnedServers.length) {
    securityWarnings.push(
      `Some digest-pinned stdio MCP server registrations are missing cosign signature verification policy and cannot meet the OCI supply-chain trust bar.`,
    );
  }
  if (
    liveSecurityState.stdioProvenanceAttestationServers.length <
    liveSecurityState.stdioSignatureVerificationServers.length
  ) {
    securityWarnings.push(
      `Some stdio MCP server registrations verify OCI signatures but do not require SLSA provenance attestations.`,
    );
  }
  if (liveSecurityState.streamableHttpLegacyEnvAuthServers.length > 0) {
    securityWarnings.push(
      `Legacy bearer_env auth is still configured for ${liveSecurityState.streamableHttpLegacyEnvAuthServers.length} streamable_http MCP server(s).`,
    );
  }
  if (liveSecurityState.streamableHttpMissingSecretRefs.length > 0) {
    securityWarnings.push(
      `Missing durable secret references were detected for ${liveSecurityState.streamableHttpMissingSecretRefs.length} streamable_http MCP server(s).`,
    );
  }
  if (liveSecurityState.publicHttpsPolicyMismatches.length > 0) {
    securityWarnings.push(
      `Missing public host allowlist policies were detected for ${liveSecurityState.publicHttpsPolicyMismatches.length} public_https MCP server(s).`,
    );
  }
  if (liveSecurityState.streamableHttpMissingAuth.length > 0) {
    securityWarnings.push(
      `Missing bearer_env values were detected for ${liveSecurityState.streamableHttpMissingAuth.length} streamable_http MCP server(s).`,
    );
  }
  const securityPrimaryReason = (() => {
    if (!liveSecurityState.durableSecretStorageAvailable) {
      return {
        code: "MCP_SECRET_STORAGE_UNAVAILABLE",
        message: "Durable MCP secret storage is unavailable on this host.",
      };
    }

    if (liveSecurityState.stdioDegradedServers.length > 0) {
      return {
        code: "STDIO_SANDBOX_DEGRADED",
        message: `${liveSecurityState.stdioDegradedServers.length} governed stdio MCP server(s) do not have a usable sandbox on this host.`,
      };
    }

    if (liveSecurityState.stdioLocalBuildServers.length > 0) {
      return {
        code: "STDIO_OCI_LOCAL_BUILD_ONLY",
        message: "Some governed stdio MCP servers are configured for local OCI builds instead of production images.",
      };
    }

    if (liveSecurityState.stdioMutableTagServers.length > 0) {
      return {
        code: "STDIO_OCI_IMAGE_NOT_PINNED",
        message: "Some stored governed stdio MCP registrations still use OCI images without pinned sha256 digests.",
      };
    }

    if (liveSecurityState.stdioRegistryPolicyServers.length < liveSecurityState.stdioDigestPinnedServers.length) {
      return {
        code: "STDIO_OCI_REGISTRY_POLICY_MISSING",
        message: "Some digest-pinned governed stdio MCP registrations are missing allowed_registries coverage.",
      };
    }

    if (
      liveSecurityState.stdioSignatureVerificationServers.length < liveSecurityState.stdioDigestPinnedServers.length
    ) {
      return {
        code: "STDIO_OCI_SIGNATURE_POLICY_MISSING",
        message:
          "Some digest-pinned governed stdio MCP registrations are missing cosign signature verification policy.",
      };
    }

    if (
      liveSecurityState.stdioProvenanceAttestationServers.length <
      liveSecurityState.stdioSignatureVerificationServers.length
    ) {
      return {
        code: "STDIO_OCI_PROVENANCE_POLICY_MISSING",
        message: "Some governed stdio MCP registrations do not require SLSA provenance attestations.",
      };
    }

    if (liveSecurityState.streamableHttpLegacyEnvAuthServers.length > 0) {
      return {
        code: "LEGACY_STREAMABLE_HTTP_AUTH",
        message: "Some streamable_http MCP servers still rely on legacy bearer_env authentication.",
      };
    }

    if (liveSecurityState.streamableHttpMissingSecretRefs.length > 0) {
      return {
        code: "MISSING_STREAMABLE_HTTP_SECRET_REF",
        message: "Some streamable_http MCP servers reference missing durable secrets.",
      };
    }

    if (liveSecurityState.publicHttpsPolicyMismatches.length > 0) {
      return {
        code: "MISSING_PUBLIC_HOST_POLICY",
        message: "Some public_https MCP servers are missing an allowlisted host policy.",
      };
    }

    return null;
  })();
  const hostedWorkerWarnings: string[] = [];
  if (!hostedWorkerClient.available) {
    hostedWorkerWarnings.push(
      hostedWorkerClient.lastError
        ? `Hosted MCP worker is unreachable: ${hostedWorkerClient.lastError}`
        : "Hosted MCP worker is unreachable.",
    );
  }
  const hostedWorkerPrimaryReason = hostedWorkerClient.available
    ? null
    : {
        code: "HOSTED_WORKER_UNREACHABLE",
        message: hostedWorkerClient.lastError ?? "Hosted MCP worker is unreachable.",
      };

  const hostedQueueSnapshot = hostedExecutionQueue.diagnostics();
  const hostedQueueWarnings: string[] = [];
  if (hostedQueueSnapshot.failed_jobs > 0) {
    hostedQueueWarnings.push(
      `${hostedQueueSnapshot.failed_jobs} hosted MCP execution job(s) are in a failed terminal state and require operator action.`,
    );
  }
  if (!hostedWorkerClient.available && hostedQueueSnapshot.queued_jobs > 0) {
    hostedQueueWarnings.push(
      `${hostedQueueSnapshot.queued_jobs} queued hosted MCP execution job(s) are waiting for the worker to become reachable.`,
    );
  }
  const hostedQueuePrimaryReason =
    hostedQueueSnapshot.failed_jobs > 0
      ? {
          code: "HOSTED_QUEUE_FAILED_JOBS",
          message: `${hostedQueueSnapshot.failed_jobs} hosted MCP execution job(s) are in a failed terminal state.`,
        }
      : !hostedWorkerClient.available && hostedQueueSnapshot.queued_jobs > 0
        ? {
            code: "HOSTED_QUEUE_BLOCKED_ON_WORKER",
            message: `${hostedQueueSnapshot.queued_jobs} queued hosted MCP execution job(s) are blocked on worker reachability.`,
          }
        : null;

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
    policy_summary: requestedSections.has("policy_summary") ? policyRuntime.effective_policy.summary : null,
    security_posture: requestedSections.has("security_posture")
      ? {
          status: securityWarnings.length > 0 ? "degraded" : "healthy",
          secret_storage: {
            mode: liveSecurityState.credentialBrokerMode,
            provider: liveSecurityState.credentialStoreDetails?.provider ?? null,
            durable: liveSecurityState.durableSecretStorageAvailable,
            encrypted_at_rest: liveSecurityState.durableSecretStorageAvailable,
            secret_expiry_enforced: true,
            rotation_metadata_tracked: true,
            legacy_key_path: liveSecurityState.credentialStoreDetails?.legacy_key_path ?? null,
          },
          stdio_sandbox: {
            registered_server_count: liveSecurityState.registeredStdioServers.length,
            protected_server_count: liveSecurityState.protectedStdioServerCount,
            production_ready_server_count: liveSecurityState.stdioProductionReadyServers.length,
            digest_pinned_server_count: liveSecurityState.stdioDigestPinnedServers.length,
            mutable_tag_server_count: liveSecurityState.stdioMutableTagServers.length,
            local_build_server_count: liveSecurityState.stdioLocalBuildServers.length,
            registry_policy_server_count: liveSecurityState.stdioRegistryPolicyServers.length,
            signature_verification_server_count: liveSecurityState.stdioSignatureVerificationServers.length,
            provenance_attestation_server_count: liveSecurityState.stdioProvenanceAttestationServers.length,
            fallback_server_count: liveSecurityState.stdioFallbackServers.length,
            unconfigured_server_count: liveSecurityState.stdioUnconfiguredServers.length,
            preferred_production_mode: liveSecurityState.preferredProductionMode,
            local_dev_fallback_mode: liveSecurityState.localDevFallbackMode,
            current_host_mode: liveSecurityState.currentHostMode,
            current_host_mode_reason: liveSecurityState.currentHostModeReason,
            macos_seatbelt_available: false,
            docker_runtime_usable: liveSecurityState.dockerRuntime.usable,
            podman_runtime_usable: liveSecurityState.podmanRuntime.usable,
            windows_plan: {
              supported_via_oci: true,
              recommended_runtime: "docker_desktop_wsl2_or_podman_machine",
              native_fallback_available: false,
              summary:
                "On Windows, use Docker Desktop with WSL2 or Podman machine for OCI sandboxing. No native host-process fallback is supported.",
            },
            degraded_servers: liveSecurityState.stdioDegradedServers,
          },
          streamable_http: {
            registered_server_count: liveSecurityState.registeredStreamableHttpServers.length,
            connect_time_dns_scope_validation: true,
            redirect_chain_revalidation: true,
            concurrency_limits_enforced: true,
            shared_sqlite_leases: true,
            lease_heartbeat_renewal: true,
            legacy_bearer_env_servers: liveSecurityState.streamableHttpLegacyEnvAuthServers.map(
              (record) => record.server.server_id,
            ),
            missing_secret_ref_servers: liveSecurityState.streamableHttpMissingSecretRefs.map(
              (record) => record.server.server_id,
            ),
            missing_public_host_policy_servers: liveSecurityState.publicHttpsPolicyMismatches.map(
              (record) => record.server.server_id,
            ),
          },
          primary_reason: securityPrimaryReason,
          warnings: [...new Set(securityWarnings)],
        }
      : null,
    hosted_worker: requestedSections.has("hosted_worker")
      ? {
          status: hostedWorkerWarnings.length > 0 ? "degraded" : "healthy",
          reachable: hostedWorkerClient.available,
          managed_by_daemon: hostedWorkerClient.managed,
          endpoint_kind: hostedWorkerClient.endpointKind,
          endpoint: hostedWorkerClient.endpointLabel,
          runtime_id: hostedWorkerClient.workerRuntimeId,
          image_digest: hostedWorkerClient.workerImageDigest,
          control_plane_auth_required: hostedWorkerClient.controlPlaneAuthRequired,
          last_error: hostedWorkerClient.lastError,
          primary_reason: hostedWorkerPrimaryReason,
          warnings: hostedWorkerWarnings,
        }
      : null,
    hosted_queue: requestedSections.has("hosted_queue")
      ? {
          status: hostedQueueWarnings.length > 0 ? "degraded" : "healthy",
          queued_jobs: hostedQueueSnapshot.queued_jobs,
          running_jobs: hostedQueueSnapshot.running_jobs,
          cancel_requested_jobs: hostedQueueSnapshot.cancel_requested_jobs,
          succeeded_jobs: hostedQueueSnapshot.succeeded_jobs,
          failed_jobs: hostedQueueSnapshot.failed_jobs,
          canceled_jobs: hostedQueueSnapshot.canceled_jobs,
          retryable_failed_jobs: hostedQueueSnapshot.retryable_failed_jobs,
          dead_letter_retryable_jobs: hostedQueueSnapshot.dead_letter_retryable_jobs,
          dead_letter_non_retryable_jobs: hostedQueueSnapshot.dead_letter_non_retryable_jobs,
          oldest_queued_at: hostedQueueSnapshot.oldest_queued_at,
          oldest_failed_at: hostedQueueSnapshot.oldest_failed_at,
          active_server_profiles: hostedQueueSnapshot.active_server_profiles,
          primary_reason: hostedQueuePrimaryReason,
          warnings: hostedQueueWarnings,
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
  hostedWorkerClient: HostedMcpWorkerClient,
  draftStore: OwnedDraftStore,
  noteStore: OwnedNoteStore,
  ticketStore: OwnedTicketStore,
  policyRuntime: PolicyRuntimeState,
  runtimeOptions: Pick<
    StartServerOptions,
    | "socketPath"
    | "journalPath"
    | "snapshotRootPath"
    | "mcpConcurrencyLeasePath"
    | "policyGlobalConfigPath"
    | "policyWorkspaceConfigPath"
    | "policyCalibrationConfigPath"
    | "policyConfigPath"
  >,
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
          summary:
            "Timeline and helper projections are derived fresh from the journal on read at launch, so no queued rebuild was required.",
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
            result.layered_snapshots_removed > 0 ||
            result.legacy_snapshots_removed > 0 ||
            result.stray_entries_removed > 0
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
          hostedWorkerClient,
          payload.scope?.workspace_root,
        );
        const degradedCount = snapshot.capabilities.filter((capability) => capability.status === "degraded").length;
        const unavailableCount = snapshot.capabilities.filter(
          (capability) => capability.status === "unavailable",
        ).length;
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
      case "policy_threshold_calibration": {
        const calibrationReport = journal.getPolicyCalibrationReport({
          run_id: payload.scope?.run_id,
          include_samples: true,
          sample_limit: null,
        });
        const recommendations = recommendPolicyThresholds(calibrationReport.report, policyRuntime.compiled_policy, {
          min_samples: POLICY_CALIBRATION_MIN_SAMPLES,
        });
        const thresholdUpdates = buildCalibrationThresholdUpdates(recommendations);

        if (thresholdUpdates.length === 0) {
          jobs.push({
            job_type: jobType,
            status: "completed",
            performed_inline: true,
            summary:
              calibrationReport.report.totals.sample_count > 0
                ? `No policy threshold updates were applied; ${calibrationReport.report.totals.sample_count} calibration sample(s) did not justify a change.`
                : "No policy threshold updates were applied because no calibration samples were available yet.",
            stats: {
              run_id: payload.scope?.run_id ?? null,
              min_samples: POLICY_CALIBRATION_MIN_SAMPLES,
              sample_count: calibrationReport.report.totals.sample_count,
              action_families_considered: calibrationReport.report.action_families.length,
              recommendations_considered: recommendations.length,
              thresholds_applied: 0,
              generated_config_path: runtimeOptions.policyCalibrationConfigPath,
            },
          });
          break;
        }

        const generatedConfigPath = runtimeOptions.policyCalibrationConfigPath;
        if (!generatedConfigPath) {
          throw new InternalError("Policy calibration config path is not configured.", {
            job_type: jobType,
          });
        }
        const generatedPolicyVersion = `workspace-generated-calibration@${new Date().toISOString()}`;
        const generatedPolicyDocument = {
          profile_name: policyRuntime.effective_policy.policy.profile_name,
          policy_version: generatedPolicyVersion,
          thresholds: {
            low_confidence: thresholdUpdates.map((update) => ({
              action_family: update.action_family,
              ask_below: update.recommended_ask_below,
            })),
          },
          rules: [],
        };
        const generatedValidation = validatePolicyConfigDocument(generatedPolicyDocument);
        if (!generatedValidation.valid || !generatedValidation.normalized_config) {
          throw new InternalError("Generated calibration policy document failed validation.", {
            issues: generatedValidation.issues,
          });
        }

        fs.mkdirSync(path.dirname(generatedConfigPath), { recursive: true });
        fs.writeFileSync(
          generatedConfigPath,
          `${JSON.stringify(generatedValidation.normalized_config, null, 2)}\n`,
          "utf8",
        );
        reloadPolicyRuntime(policyRuntime, buildPolicyRuntimeLoadOptions(runtimeOptions));

        jobs.push({
          job_type: jobType,
          status: "completed",
          performed_inline: true,
          summary: `Applied ${thresholdUpdates.length} policy low-confidence threshold update(s) from ${calibrationReport.report.totals.sample_count} calibration sample(s).`,
          stats: {
            run_id: payload.scope?.run_id ?? null,
            min_samples: POLICY_CALIBRATION_MIN_SAMPLES,
            sample_count: calibrationReport.report.totals.sample_count,
            action_families_considered: calibrationReport.report.action_families.length,
            recommendations_considered: recommendations.length,
            thresholds_applied: thresholdUpdates.length,
            generated_policy_version: generatedPolicyVersion,
            generated_config_path: generatedConfigPath,
            updates: thresholdUpdates,
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
      .filter(
        (artifact) => artifact.artifact_id && artifact.artifact_status && artifact.artifact_status !== "available",
      )
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
  const answer = answerHelperQuery(questionType, context.steps, focusStepId, compareStepId);

  return {
    ...answer,
    visibility_scope: context.visibility_scope,
    redactions_applied: context.redactions_applied,
    preview_budget: context.preview_budget,
    uncertainty: [
      ...answer.uncertainty,
      ...(context.redactions_applied > 0
        ? [`Some details were redacted for ${context.visibility_scope} visibility.`]
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
  state: AuthorityState,
  journal: RunJournal,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<QueryTimelineResponsePayload> {
  const sessionId = requireValidSession(state, "query_timeline", request.session_id);
  const payload = validate(QueryTimelineRequestPayloadSchema, request.payload);
  const runSummary = requireAuthorizedRunSummary(state, journal, sessionId, payload.run_id);

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
  state: AuthorityState,
  journal: RunJournal,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<QueryHelperResponsePayload> {
  const sessionId = requireValidSession(state, "query_helper", request.session_id);
  const payload = validate(QueryHelperRequestPayloadSchema, request.payload);
  const runSummary = requireAuthorizedRunSummary(state, journal, sessionId, payload.run_id);

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
  state: AuthorityState,
  journal: RunJournal,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<QueryArtifactResponsePayload> {
  const sessionId = requireValidSession(state, "query_artifact", request.session_id);
  const payload = validate(QueryArtifactRequestPayloadSchema, request.payload);
  const visibilityScope = payload.visibility_scope ?? "user";
  journal.enforceArtifactRetention();
  const artifact = journal.getArtifact(payload.artifact_id);
  requireAuthorizedRunSummary(state, journal, sessionId, artifact.run_id);

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
  state: AuthorityState,
  journal: RunJournal,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<ListApprovalsResponsePayload> {
  const sessionId = requireValidSession(state, "list_approvals", request.session_id);
  const payload = validate(ListApprovalsRequestPayloadSchema, request.payload);
  if (payload.run_id) {
    requireAuthorizedRunSummary(state, journal, sessionId, payload.run_id);
  }
  const approvals = journal
    .listApprovals({
      run_id: payload.run_id,
      status: payload.status,
    })
    .filter((approval) => {
      const runSummary = journal.getRunSummary(approval.run_id);
      return runSummary !== null && sessionCanAccessRun(state, sessionId, runSummary);
    });

  return makeSuccessResponse(request.request_id, request.session_id, {
    approvals,
  });
}

function handleQueryApprovalInbox(
  state: AuthorityState,
  journal: RunJournal,
  request: RequestEnvelope<unknown>,
): ResponseEnvelope<QueryApprovalInboxResponsePayload> {
  const sessionId = requireValidSession(state, "query_approval_inbox", request.session_id);
  const payload = validate(QueryApprovalInboxRequestPayloadSchema, request.payload);
  if (payload.run_id) {
    requireAuthorizedRunSummary(state, journal, sessionId, payload.run_id);
  }
  const approvals = journal
    .listApprovals({
      run_id: payload.run_id,
      status: payload.status,
    })
    .filter((approval) => {
      const runSummary = journal.getRunSummary(approval.run_id);
      return runSummary !== null && sessionCanAccessRun(state, sessionId, runSummary);
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
  state: AuthorityState,
  journal: RunJournal,
  adapterRegistry: AdapterRegistry,
  snapshotEngine: LocalSnapshotEngine,
  draftStore: OwnedDraftStore,
  noteStore: OwnedNoteStore,
  ticketStore: OwnedTicketStore,
  mcpRegistry: McpServerRegistry,
  hostedExecutionQueue: HostedExecutionQueue,
  runtimeOptions: Pick<StartServerOptions, "capabilityRefreshStaleMs">,
  request: RequestEnvelope<unknown>,
): Promise<ResponseEnvelope<ResolveApprovalResponsePayload>> {
  const sessionId = requireValidSession(state, "resolve_approval", request.session_id);
  const payload = validate(ResolveApprovalRequestPayloadSchema, request.payload);
  const storedApproval = journal.getStoredApproval(payload.approval_id);

  if (!storedApproval) {
    throw new NotFoundError(`No approval found for ${payload.approval_id}.`, {
      approval_id: payload.approval_id,
    });
  }
  requireAuthorizedRunSummary(state, journal, sessionId, storedApproval.run_id);

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
  const cachedCapabilityState = buildCachedCapabilityState(journal, runtimeOptions);
  const approvalSnapshotSelection = approvedPolicyOutcome.preconditions.snapshot_required
    ? selectSnapshotClass({
        action: storedApproval.action,
        policy_decision: approvedPolicyOutcome.decision,
        capability_state: deriveSnapshotCapabilityStateService(cachedCapabilityState),
        low_disk_pressure_observed: runSummary.maintenance_status.low_disk_pressure_signals > 0,
        journal_chain_depth: runSummary.event_count,
        ...deriveSnapshotRunRiskContextService(journal, storedApproval.run_id, {
          exclude_action_id: storedApproval.action.action_id,
        }),
      })
    : null;

  const execution = await executeGovernedActionFlow({
    action: storedApproval.action,
    policyOutcome: approvedPolicyOutcome,
    snapshotSelection: approvalSnapshotSelection,
    runSummary,
    journal,
    adapterRegistry,
    snapshotEngine,
    draftStore,
    noteStore,
    ticketStore,
    executeHostedDelegatedAction: (action) =>
      executeHostedDelegatedMcpAction({
        action,
        mcpRegistry,
        journal,
        hostedExecutionQueue,
      }),
  });

  return makeSuccessResponse(request.request_id, request.session_id, {
    approval_request: approvalRequest,
    execution_result: execution.executionResult,
    snapshot_record: execution.snapshotRecord,
  });
}

async function handlePlanRecovery(
  state: AuthorityState,
  journal: RunJournal,
  snapshotEngine: LocalSnapshotEngine,
  compensationRegistry: StaticCompensationRegistry,
  runtimeOptions: Pick<StartServerOptions, "capabilityRefreshStaleMs">,
  request: RequestEnvelope<unknown>,
): Promise<ResponseEnvelope<PlanRecoveryResponsePayload>> {
  const sessionId = requireValidSession(state, "plan_recovery", request.session_id);
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
    const manifest = await loadRecoverySnapshotManifest(snapshotEngine, target.snapshot_id);
    requireAuthorizedRunSummary(state, journal, sessionId, manifest.run_id);
    recoveryPlan = await planSnapshotRecovery(snapshotEngine, target.snapshot_id, {
      compensation_registry: compensationRegistry,
      cached_capability_state: cachedCapabilityState,
    });
    runId = manifest.run_id;
    snapshotIdForJournal = target.snapshot_id;
  } else if (target.type === "path_subset") {
    const manifest = await loadRecoverySnapshotManifest(snapshotEngine, target.snapshot_id);
    requireAuthorizedRunSummary(state, journal, sessionId, manifest.run_id);
    recoveryPlan = await planPathSubsetRecovery(snapshotEngine, target, {
      cached_capability_state: cachedCapabilityState,
    });
    runId = manifest.run_id;
    snapshotIdForJournal = target.snapshot_id;
    actionIdForJournal = manifest.action_id;
    subsetPathsForJournal = [...target.paths];
  } else if (target.type === "branch_point") {
    const branchPointContext = findBranchPointContext(journal, target);
    requireAuthorizedRunSummary(state, journal, sessionId, branchPointContext.runId);
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
    requireAuthorizedRunSummary(state, journal, sessionId, checkpointContext.runId);
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
    requireAuthorizedRunSummary(state, journal, sessionId, actionContext.runId);
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
  state: AuthorityState,
  journal: RunJournal,
  snapshotEngine: LocalSnapshotEngine,
  compensationRegistry: StaticCompensationRegistry,
  runtimeOptions: Pick<StartServerOptions, "capabilityRefreshStaleMs">,
  request: RequestEnvelope<unknown>,
): Promise<ResponseEnvelope<ExecuteRecoveryResponsePayload>> {
  const sessionId = requireValidSession(state, "execute_recovery", request.session_id);
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
    requireAuthorizedRunSummary(state, journal, sessionId, manifest.run_id);
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
    requireAuthorizedRunSummary(state, journal, sessionId, manifest.run_id);
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
    requireAuthorizedRunSummary(state, journal, sessionId, branchPointContext.runId);
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
    requireAuthorizedRunSummary(state, journal, sessionId, checkpointContext.runId);
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
    requireAuthorizedRunSummary(state, journal, sessionId, actionContext.runId);
    runId = actionContext.runId;
    actionIdForJournal = actionContext.actionId;

    if (!actionContext.snapshotId) {
      throw new PreconditionError(
        "This action boundary has no persisted snapshot, so execution is manual-review only.",
        {
          action_id: actionContext.actionId,
        },
      );
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

async function executeHostedDelegatedMcpAction(params: {
  action: ActionRecord;
  mcpRegistry: McpServerRegistry;
  journal: RunJournal;
  hostedExecutionQueue: HostedExecutionQueue;
}): Promise<SubmitActionAttemptResponsePayload["execution_result"]> {
  const context = resolveHostedDelegatedExecutionContext({
    action: params.action,
    mcpRegistry: params.mcpRegistry,
  });
  const job = buildHostedExecutionJobRecord(params.action, context);
  params.journal.appendRunEvent(params.action.run_id, {
    event_type: "mcp_hosted_job_enqueued",
    occurred_at: job.created_at,
    recorded_at: job.created_at,
    payload: {
      action_id: params.action.action_id,
      job_id: job.job_id,
      server_profile_id: job.server_profile_id,
      tool_name: job.tool_name,
      max_attempts: job.max_attempts,
      next_attempt_at: job.next_attempt_at,
    },
  });
  return params.hostedExecutionQueue.submitAndWait(job);
}
function canUseIdempotency(request: RequestEnvelope<unknown>): boolean {
  return (
    IDEMPOTENT_MUTATION_METHODS.has(request.method) &&
    typeof request.idempotency_key === "string" &&
    request.idempotency_key.length > 0
  );
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
  hostedWorkerClient: HostedMcpWorkerClient,
  hostedExecutionQueue: HostedExecutionQueue,
  policyRuntime: PolicyRuntimeState,
  draftStore: OwnedDraftStore,
  noteStore: OwnedNoteStore,
  ticketStore: OwnedTicketStore,
  runtimeOptions: Pick<
    StartServerOptions,
    | "socketPath"
    | "journalPath"
    | "snapshotRootPath"
    | "capabilityRefreshStaleMs"
    | "mcpConcurrencyLeasePath"
    | "policyGlobalConfigPath"
    | "policyWorkspaceConfigPath"
    | "policyCalibrationConfigPath"
    | "policyConfigPath"
  >,
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
          response = handleRegisterRun(state, journal, policyRuntime, request);
          break;
        case "get_run_summary":
          response = handleGetRunSummary(state, journal, request);
          break;
        case "get_capabilities":
          response = handleGetCapabilities(
            broker,
            runtimeOptions,
            mcpRegistry,
            publicHostPolicyRegistry,
            hostedWorkerClient,
            request,
          );
          break;
        case "get_effective_policy":
          response = handleGetEffectivePolicy(request, policyRuntime);
          break;
        case "validate_policy_config":
          response = handleValidatePolicyConfig(request);
          break;
        case "get_policy_calibration_report":
          response = handleGetPolicyCalibrationReport(state, journal, request);
          break;
        case "explain_policy_action":
          response = handleExplainPolicyAction(state, journal, policyRuntime, runtimeOptions, mcpRegistry, request);
          break;
        case "get_policy_threshold_recommendations":
          response = handleGetPolicyThresholdRecommendations(state, journal, policyRuntime, request);
          break;
        case "replay_policy_thresholds":
          response = handleReplayPolicyThresholds(state, journal, policyRuntime, request);
          break;
        case "list_mcp_servers":
          response = handleListMcpServers(mcpRegistry, request);
          break;
        case "list_mcp_server_candidates":
          response = handleListMcpServerCandidates(mcpRegistry, request);
          break;
        case "submit_mcp_server_candidate":
          response = handleSubmitMcpServerCandidate(state, mcpRegistry, request);
          break;
        case "list_mcp_server_profiles":
          response = handleListMcpServerProfiles(mcpRegistry, request);
          break;
        case "get_mcp_server_review":
          response = handleGetMcpServerReview(mcpRegistry, request);
          break;
        case "resolve_mcp_server_candidate":
          response = await handleResolveMcpServerCandidate(state, mcpRegistry, request);
          break;
        case "list_mcp_server_trust_decisions":
          response = handleListMcpServerTrustDecisions(mcpRegistry, request);
          break;
        case "approve_mcp_server_profile":
          response = handleApproveMcpServerProfile(state, mcpRegistry, request);
          break;
        case "list_mcp_server_credential_bindings":
          response = handleListMcpServerCredentialBindings(mcpRegistry, request);
          break;
        case "bind_mcp_server_credentials":
          response = handleBindMcpServerCredentials(state, broker, mcpRegistry, request);
          break;
        case "revoke_mcp_server_credentials":
          response = handleRevokeMcpServerCredentials(state, mcpRegistry, request);
          break;
        case "activate_mcp_server_profile":
          response = handleActivateMcpServerProfile(state, mcpRegistry, request);
          break;
        case "quarantine_mcp_server_profile":
          response = handleQuarantineMcpServerProfile(state, mcpRegistry, request);
          break;
        case "revoke_mcp_server_profile":
          response = handleRevokeMcpServerProfile(state, mcpRegistry, request);
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
        case "get_hosted_mcp_job":
          response = handleGetHostedMcpJob(mcpRegistry, hostedExecutionQueue, journal, request);
          break;
        case "list_hosted_mcp_jobs":
          response = handleListHostedMcpJobs(mcpRegistry, hostedExecutionQueue, request);
          break;
        case "requeue_hosted_mcp_job":
          response = handleRequeueHostedMcpJob(state, journal, hostedExecutionQueue, request);
          break;
        case "cancel_hosted_mcp_job":
          response = handleCancelHostedMcpJob(state, journal, hostedExecutionQueue, request);
          break;
        case "diagnostics":
          response = handleDiagnostics(
            state,
            journal,
            broker,
            mcpRegistry,
            publicHostPolicyRegistry,
            hostedWorkerClient,
            hostedExecutionQueue,
            policyRuntime,
            runtimeOptions,
            request,
          );
          break;
        case "run_maintenance":
          response = await handleRunMaintenance(
            state,
            journal,
            snapshotEngine,
            broker,
            mcpRegistry,
            publicHostPolicyRegistry,
            hostedWorkerClient,
            draftStore,
            noteStore,
            ticketStore,
            policyRuntime,
            runtimeOptions,
            request,
          );
          break;
        case "list_approvals":
          response = handleListApprovals(state, journal, request);
          break;
        case "query_approval_inbox":
          response = handleQueryApprovalInbox(state, journal, request);
          break;
        case "resolve_approval":
          response = await handleResolveApproval(
            state,
            journal,
            adapterRegistry,
            snapshotEngine,
            draftStore,
            noteStore,
            ticketStore,
            mcpRegistry,
            hostedExecutionQueue,
            runtimeOptions,
            request,
          );
          break;
        case "query_timeline":
          response = handleQueryTimeline(state, journal, request);
          break;
        case "query_helper":
          response = handleQueryHelper(state, journal, request);
          break;
        case "query_artifact":
          response = handleQueryArtifact(state, journal, request);
          break;
        case "submit_action_attempt":
          response = await handleSubmitActionAttemptFlow({
            state,
            journal,
            adapterRegistry,
            snapshotEngine,
            draftStore,
            noteStore,
            ticketStore,
            mcpRegistry,
            hostedExecutionQueue,
            policyRuntime,
            runtimeOptions,
            buildCachedCapabilityState,
            executeHostedDelegatedAction: executeHostedDelegatedMcpAction,
            request,
          });
          break;
        case "plan_recovery":
          response = await handlePlanRecovery(
            state,
            journal,
            snapshotEngine,
            compensationRegistry,
            runtimeOptions,
            request,
          );
          break;
        case "create_run_checkpoint":
          response = await handleCreateRunCheckpoint(state, journal, snapshotEngine, runtimeOptions, request);
          break;
        case "execute_recovery":
          response = await handleExecuteRecovery(
            state,
            journal,
            snapshotEngine,
            compensationRegistry,
            runtimeOptions,
            request,
          );
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
      const actionId = typeof snapshotEvent.payload?.action_id === "string" ? snapshotEvent.payload.action_id : null;
      if (!actionId) {
        continue;
      }

      const alreadyReconciled = events.some(
        (event) => event.payload?.action_id === actionId && event.event_type === "execution.outcome_unknown",
      );
      if (alreadyReconciled) {
        continue;
      }

      const hasTerminalEvent = events.some(
        (event) =>
          event.payload?.action_id === actionId &&
          (event.event_type === "execution.completed" ||
            event.event_type === "execution.failed" ||
            event.event_type === "execution.simulated"),
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
  workspaceRootPath?: string;
  journalPath: string;
  snapshotRootPath: string;
  mcpRegistryPath?: string;
  mcpSecretStorePath?: string;
  mcpSecretKeyPath?: string;
  mcpHostPolicyPath?: string;
  mcpConcurrencyLeasePath?: string;
  mcpHostedWorkerEndpoint?: string;
  mcpHostedWorkerAutostart?: boolean;
  mcpHostedWorkerControlToken?: string;
  mcpHostedWorkerAttestationKeyPath?: string;
  mcpHostedWorkerCommand?: string;
  mcpHostedWorkerArgs?: string[];
  policyGlobalConfigPath?: string | null;
  policyWorkspaceConfigPath?: string | null;
  policyCalibrationConfigPath?: string | null;
  policyConfigPath?: string | null;
  artifactRetentionMs?: number | null;
  capabilityRefreshStaleMs?: number | null;
}

export async function startServer(options: StartServerOptions): Promise<net.Server> {
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
  const mcpRegistryPath =
    options.mcpRegistryPath ?? path.join(path.dirname(options.snapshotRootPath), "mcp", "registry.db");
  const mcpSecretStorePath =
    options.mcpSecretStorePath ?? path.join(path.dirname(options.snapshotRootPath), "mcp", "secret-store.db");
  const mcpSecretKeyPath =
    options.mcpSecretKeyPath ?? path.join(path.dirname(options.snapshotRootPath), "mcp", "secret-store.key");
  const mcpHostPolicyPath =
    options.mcpHostPolicyPath ?? path.join(path.dirname(options.snapshotRootPath), "mcp", "host-policies.db");
  const mcpConcurrencyLeasePath =
    options.mcpConcurrencyLeasePath ??
    path.join(path.dirname(options.snapshotRootPath), "mcp", "concurrency-leases.db");
  const mcpHostedWorkerEndpoint =
    options.mcpHostedWorkerEndpoint ??
    `unix:${path.join(path.dirname(options.snapshotRootPath), "mcp", "hosted-worker.sock")}`;
  const mcpHostedWorkerAttestationKeyPath =
    options.mcpHostedWorkerAttestationKeyPath ??
    path.join(path.dirname(options.snapshotRootPath), "mcp", "hosted-worker-attestation-key.json");
  const workspaceRootPath = options.workspaceRootPath ?? process.cwd();
  const policyGlobalConfigPath = options.policyGlobalConfigPath ?? null;
  const policyWorkspaceConfigPath =
    options.policyWorkspaceConfigPath ?? path.join(workspaceRootPath, ".agentgit", "policy.toml");
  const policyCalibrationConfigPath =
    options.policyCalibrationConfigPath ??
    path.join(workspaceRootPath, ".agentgit", "policy.calibration.generated.json");
  const policyConfigPath = options.policyConfigPath ?? null;
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
  const policyRuntimeLoadOptions = buildPolicyRuntimeLoadOptions({
    policyGlobalConfigPath,
    policyWorkspaceConfigPath,
    policyCalibrationConfigPath,
    policyConfigPath,
  });
  const policyRuntime = loadPolicyRuntime(policyRuntimeLoadOptions);
  const hostedWorkerClient = new HostedMcpWorkerClient({
    endpoint: mcpHostedWorkerEndpoint,
    autostart: options.mcpHostedWorkerAutostart ?? true,
    controlToken:
      options.mcpHostedWorkerControlToken ??
      ((options.mcpHostedWorkerAutostart ?? true)
        ? createHash("sha256").update(`${process.pid}:${Date.now()}:${options.socketPath}`).digest("hex")
        : null),
    attestationKeyPath: mcpHostedWorkerAttestationKeyPath,
    command: options.mcpHostedWorkerCommand,
    args: options.mcpHostedWorkerArgs,
  });
  const hostedExecutionQueue = new HostedExecutionQueue({
    registry: mcpRegistry,
    instanceId: `daemon:${process.pid}:${randomUUID()}`,
    onTerminalFailure: (job, error) => {
      const now = new Date().toISOString();
      journal.appendRunEvent(job.run_id, {
        event_type: "mcp_hosted_job_dead_lettered",
        occurred_at: now,
        recorded_at: now,
        payload: {
          action_id: job.action_id,
          job_id: job.job_id,
          server_profile_id: job.server_profile_id,
          tool_name: job.tool_name,
          attempt_count: job.attempt_count,
          max_attempts: job.max_attempts,
          current_lease_id: job.current_lease_id,
          error_code: error.code,
          error_message: error.message,
          retryable: error.retryable,
        },
      });
    },
    processor: (job, signalHeartbeat, cancelSignal) =>
      executeHostedDelegatedJobAttempt({
        job,
        broker: credentialBroker,
        mcpRegistry,
        journal,
        hostedWorkerClient,
        signalHeartbeat,
        cancelSignal,
      }),
  });
  await hostedWorkerClient.warmup().catch(() => undefined);
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
      concurrencyLeaseDbPath: mcpConcurrencyLeasePath,
    }),
  );
  adapterRegistry.register(new FunctionExecutionAdapter(draftStore, noteStore, ticketIntegration));
  rehydrateState(state, journal);
  recoverInterruptedActions(journal);
  journal.enforceArtifactRetention();
  hostedExecutionQueue.start();

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
          hostedWorkerClient,
          hostedExecutionQueue,
          policyRuntime,
          draftStore,
          noteStore,
          ticketStore,
          {
            socketPath: options.socketPath,
            journalPath: options.journalPath,
            snapshotRootPath: options.snapshotRootPath,
            capabilityRefreshStaleMs: options.capabilityRefreshStaleMs ?? null,
            mcpConcurrencyLeasePath,
            policyGlobalConfigPath,
            policyWorkspaceConfigPath,
            policyCalibrationConfigPath,
            policyConfigPath,
          },
          parsed,
        );
        socket.write(`${JSON.stringify(response)}\n`);
        socket.end();
      }
    });
  });

  server.on("close", () => {
    hostedExecutionQueue.close();
    void hostedWorkerClient.close();
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
