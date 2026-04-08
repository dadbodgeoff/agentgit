import type { RequestContext } from "@agentgit/core-ports";
import fs from "node:fs";
import path from "node:path";

import { normalizeActionAttempt } from "@agentgit/action-normalizer";
import { type CachedCapabilityState } from "@agentgit/recovery-engine";
import { evaluatePolicy, resolvePolicyLowConfidenceThreshold } from "@agentgit/policy-engine";
import { type RunJournal } from "@agentgit/run-journal";
import {
  API_VERSION,
  ActionRecordSchema,
  type ApprovalRequest,
  InternalError,
  NotFoundError,
  type PolicyOutcomeRecord,
  PolicyOutcomeRecordSchema,
  PreconditionError,
  type RequestEnvelope,
  type ResponseEnvelope,
  type SubmitActionAttemptRequestPayload,
  SubmitActionAttemptRequestPayloadSchema,
  type SubmitActionAttemptResponsePayload,
  ValidationError,
  type ActionRecord,
  validate,
} from "@agentgit/schemas";
import {
  type AdapterRegistry,
  type OwnedDraftStore,
  type OwnedNoteStore,
  type OwnedTicketStore,
} from "@agentgit/execution-adapters";
import { type McpServerRegistry } from "@agentgit/mcp-registry";
import { type LocalSnapshotEngine, selectSnapshotClass, type SnapshotSelectionResult } from "@agentgit/snapshot-engine";

import { type HostedExecutionQueue } from "../hosted-execution-queue.js";
import { type PolicyRuntimeState } from "../policy-runtime.js";
import { type AuthorityState } from "../state.js";
import { executeGovernedAction } from "../services/action-execution.js";
import type { LatencyMetricsStore } from "../latency-metrics.js";
import { deriveSnapshotCapabilityState, deriveSnapshotRunRiskContext } from "../services/snapshot-risk.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function stringPreview(value: unknown, maxLength = 240): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
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

function appendActionEvents(journal: RunJournal, action: ActionRecord): void {
  const filesystemFacet =
    action.operation.domain === "filesystem" && isObject(action.facets.filesystem) ? action.facets.filesystem : null;
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
      action,
      action_id: action.action_id,
      operation: action.operation,
      provenance_mode: action.provenance.mode,
      provenance_source: action.provenance.source,
      provenance_confidence: action.provenance.confidence,
      target_locator: action.target.primary.locator,
      target_locator_visibility: "user",
      filesystem_operation: typeof filesystemFacet?.operation === "string" ? filesystemFacet.operation : null,
      input_preview: filesystemInputPreview,
      input_preview_visibility: action.input.contains_sensitive_data ? "sensitive_internal" : "user",
      normalization: action.normalization,
      confidence_score: action.confidence_assessment.score,
      confidence_assessment: action.confidence_assessment,
      risk_hints: action.risk_hints,
    },
  });
}

function hydrateMcpAttempt(
  attempt: SubmitActionAttemptRequestPayload["attempt"],
  mcpRegistry: McpServerRegistry,
): SubmitActionAttemptRequestPayload["attempt"] {
  if (attempt.tool_registration.tool_kind !== "mcp" || !isObject(attempt.raw_call)) {
    return attempt;
  }

  const rawCall = attempt.raw_call;
  const candidateId = typeof rawCall.candidate_id === "string" ? rawCall.candidate_id.trim() : "";
  const serverProfileId = typeof rawCall.server_profile_id === "string" ? rawCall.server_profile_id.trim() : "";
  if (candidateId.length > 0 && serverProfileId.length === 0) {
    throw new PreconditionError("Raw MCP candidates are not executable. Resolve and activate a server profile first.", {
      candidate_id: candidateId,
    });
  }

  if (serverProfileId.length === 0) {
    return attempt;
  }

  const profile = mcpRegistry.getProfile(serverProfileId);
  if (!profile) {
    throw new NotFoundError(`No MCP server profile found for ${serverProfileId}.`, {
      server_profile_id: serverProfileId,
    });
  }

  const candidate = profile.candidate_id ? mcpRegistry.getCandidate(profile.candidate_id) : null;
  const binding = mcpRegistry.getActiveCredentialBinding(serverProfileId);
  const executionModeRequested =
    rawCall.execution_mode_requested === "hosted_delegated" ? "hosted_delegated" : "local_proxy";

  return {
    ...attempt,
    raw_call: {
      ...rawCall,
      server_id: serverProfileId,
      server_profile_id: serverProfileId,
      execution_mode_requested: executionModeRequested,
      trust_tier_at_submit: profile.trust_tier,
      drift_state_at_submit: profile.drift_state,
      profile_status: profile.status,
      candidate_source_kind: candidate?.source_kind,
      allowed_execution_modes: profile.allowed_execution_modes,
      ...(binding ? { credential_binding_mode: binding.binding_mode } : {}),
    },
  };
}

function assertLaunchSupportedToolKind(toolRegistration: { tool_kind: string; tool_name: string }): void {
  if (toolRegistration.tool_kind === "browser") {
    throw new PreconditionError("Governed browser/computer execution is not part of the supported runtime surface.", {
      requested_tool_kind: toolRegistration.tool_kind,
      requested_tool_name: toolRegistration.tool_name,
      supported_tool_kinds: ["filesystem", "shell", "function"],
      unsupported_surface: "browser_computer",
    });
  }
}

type RunSummary = NonNullable<ReturnType<RunJournal["getRunSummary"]>>;

function canonicalizeWorkspaceRootForAuthorization(rootPath: string): string {
  try {
    return fs.realpathSync(rootPath);
  } catch {
    return path.resolve(rootPath);
  }
}

function requireAuthorizedRunSummary(journal: RunJournal, sessionWorkspaceRoots: string[], runId: string): RunSummary {
  const runSummary = journal.getRunSummary(runId);
  const authorizedRoots = new Set(sessionWorkspaceRoots.map((root) => canonicalizeWorkspaceRootForAuthorization(root)));

  if (
    !runSummary ||
    !runSummary.workspace_roots
      .map((root) => canonicalizeWorkspaceRootForAuthorization(root))
      .some((root) => authorizedRoots.has(root))
  ) {
    throw new NotFoundError(`No run found for ${runId}.`, {
      run_id: runId,
    });
  }

  return runSummary;
}

export interface SubmitActionRuntimeOptions {
  capabilityRefreshStaleMs?: number | null;
}

export interface PrepareActionAttemptEvaluationParams {
  journal: RunJournal;
  mcpRegistry: McpServerRegistry;
  latencyMetrics: LatencyMetricsStore;
  policyRuntime: PolicyRuntimeState;
  runtimeOptions: SubmitActionRuntimeOptions;
  buildCachedCapabilityState: (
    journal: RunJournal,
    runtimeOptions: SubmitActionRuntimeOptions,
  ) => CachedCapabilityState | null;
  sessionId: string;
  sessionWorkspaceRoots: string[];
  attempt: SubmitActionAttemptRequestPayload["attempt"];
}

export interface PreparedActionAttemptEvaluation {
  action: ActionRecord;
  runSummary: RunSummary;
  policyOutcome: PolicyOutcomeRecord;
  snapshotSelection: SnapshotSelectionResult | null;
  lowConfidenceThreshold: number | null;
  confidenceTriggered: boolean;
}

export function prepareActionAttemptEvaluation(
  params: PrepareActionAttemptEvaluationParams,
): PreparedActionAttemptEvaluation {
  const runSummary = requireAuthorizedRunSummary(params.journal, params.sessionWorkspaceRoots, params.attempt.run_id);

  assertLaunchSupportedToolKind(params.attempt.tool_registration);

  const hydratedAttempt = hydrateMcpAttempt(params.attempt, params.mcpRegistry);
  const action = validateActionRecord(normalizeActionAttempt(hydratedAttempt, params.sessionId));
  const cachedCapabilityState = params.buildCachedCapabilityState(params.journal, params.runtimeOptions);
  const runRiskContext = deriveSnapshotRunRiskContext(params.journal, params.attempt.run_id);
  let rawPolicyOutcome: ReturnType<typeof evaluatePolicy>;
  const policyEvaluationStartedAt = performance.now();
  try {
    rawPolicyOutcome = evaluatePolicy(action, {
      run_summary: {
        budget_config: runSummary.budget_config,
        budget_usage: runSummary.budget_usage,
      },
      mcp_server_registry: {
        servers: params.mcpRegistry.listDefinitions(),
      },
      cached_capability_state: cachedCapabilityState,
      compiled_policy: params.policyRuntime.compiled_policy,
    });
  } finally {
    params.latencyMetrics.recordPolicyEvaluation(performance.now() - policyEvaluationStartedAt);
  }
  const policyOutcome = validatePolicyOutcomeRecord(rawPolicyOutcome);
  const snapshotSelection = policyOutcome.preconditions.snapshot_required
    ? selectSnapshotClass({
        action,
        policy_decision: policyOutcome.decision,
        capability_state: deriveSnapshotCapabilityState(cachedCapabilityState),
        low_disk_pressure_observed: runSummary.maintenance_status.low_disk_pressure_signals > 0,
        journal_chain_depth: runSummary.event_count,
        ...runRiskContext,
      })
    : null;
  const lowConfidenceThreshold = resolvePolicyLowConfidenceThreshold(params.policyRuntime.compiled_policy, action);
  const confidenceTriggered =
    lowConfidenceThreshold !== null && action.confidence_assessment.score < lowConfidenceThreshold;

  return {
    action,
    runSummary,
    policyOutcome,
    snapshotSelection,
    lowConfidenceThreshold,
    confidenceTriggered,
  };
}

export interface HandleSubmitActionAttemptParams {
  state: AuthorityState;
  journal: RunJournal;
  adapterRegistry: AdapterRegistry;
  snapshotEngine: LocalSnapshotEngine;
  draftStore: OwnedDraftStore;
  noteStore: OwnedNoteStore;
  ticketStore: OwnedTicketStore;
  mcpRegistry: McpServerRegistry;
  hostedExecutionQueue: HostedExecutionQueue;
  latencyMetrics: LatencyMetricsStore;
  policyRuntime: PolicyRuntimeState;
  runtimeOptions: SubmitActionRuntimeOptions;
  buildCachedCapabilityState: (
    journal: RunJournal,
    runtimeOptions: SubmitActionRuntimeOptions,
  ) => CachedCapabilityState | null;
  executeHostedDelegatedAction: (params: {
    action: ActionRecord;
    mcpRegistry: McpServerRegistry;
    journal: RunJournal;
    hostedExecutionQueue: HostedExecutionQueue;
  }) => Promise<SubmitActionAttemptResponsePayload["execution_result"]>;
  request: RequestEnvelope<unknown>;
  context: RequestContext;
}

export async function handleSubmitActionAttempt(
  params: HandleSubmitActionAttemptParams,
): Promise<ResponseEnvelope<SubmitActionAttemptResponsePayload>> {
  const payload = validate(SubmitActionAttemptRequestPayloadSchema, params.request.payload);
  const session = params.state.getSession(params.request.session_id);

  if (!session) {
    throw new PreconditionError("A valid session_id is required before submit_action_attempt.", {
      session_id: params.request.session_id,
    });
  }

  const prepared = prepareActionAttemptEvaluation({
    journal: params.journal,
    mcpRegistry: params.mcpRegistry,
    latencyMetrics: params.latencyMetrics,
    policyRuntime: params.policyRuntime,
    runtimeOptions: params.runtimeOptions,
    buildCachedCapabilityState: params.buildCachedCapabilityState,
    sessionId: session.session_id,
    sessionWorkspaceRoots: session.workspace_roots,
    attempt: payload.attempt,
  });

  appendActionEvents(params.journal, prepared.action);
  params.journal.appendRunEvent(prepared.action.run_id, {
    event_type: "policy.evaluated",
    occurred_at: prepared.policyOutcome.evaluated_at,
    recorded_at: prepared.policyOutcome.evaluated_at,
    payload: {
      action_id: prepared.action.action_id,
      policy_outcome_id: prepared.policyOutcome.policy_outcome_id,
      evaluated_at: prepared.policyOutcome.evaluated_at,
      decision: prepared.policyOutcome.decision,
      reasons: prepared.policyOutcome.reasons,
      matched_rules: prepared.policyOutcome.policy_context.matched_rules,
      recoverability_class: prepared.policyOutcome.policy_context.recoverability_class ?? null,
      recovery_proof_kind: prepared.policyOutcome.policy_context.recovery_proof_kind ?? null,
      recovery_proof_source: prepared.policyOutcome.policy_context.recovery_proof_source ?? null,
      recovery_proof_scope: prepared.policyOutcome.policy_context.recovery_proof_scope ?? null,
      normalization_confidence: prepared.action.normalization.normalization_confidence,
      confidence_score: prepared.action.confidence_assessment.score,
      low_confidence_threshold: prepared.lowConfidenceThreshold,
      confidence_triggered: prepared.confidenceTriggered,
      action_family: `${prepared.action.operation.domain}/${prepared.action.operation.kind}`,
      snapshot_required: prepared.policyOutcome.preconditions.snapshot_required,
      snapshot_selection:
        prepared.snapshotSelection === null
          ? null
          : {
              snapshot_class: prepared.snapshotSelection.snapshot_class,
              reason_codes: prepared.snapshotSelection.reason_codes,
              basis: prepared.snapshotSelection.basis,
            },
    },
  });

  let approvalRequest: ApprovalRequest | null = null;
  if (prepared.policyOutcome.decision === "ask") {
    approvalRequest = params.journal.createApprovalRequest({
      run_id: prepared.action.run_id,
      action: prepared.action,
      policy_outcome: prepared.policyOutcome,
    });
    params.journal.appendRunEvent(prepared.action.run_id, {
      event_type: "approval.requested",
      occurred_at: approvalRequest.requested_at,
      recorded_at: approvalRequest.requested_at,
      payload: {
        approval_id: approvalRequest.approval_id,
        action_id: prepared.action.action_id,
        action_summary: approvalRequest.action_summary,
        status: approvalRequest.status,
        primary_reason: approvalRequest.primary_reason,
      },
    });
  }

  let snapshotRecord: SubmitActionAttemptResponsePayload["snapshot_record"] = null;
  let executionResult: SubmitActionAttemptResponsePayload["execution_result"] = null;
  if (prepared.policyOutcome.decision === "allow" || prepared.policyOutcome.decision === "allow_with_snapshot") {
    const execution = await executeGovernedAction({
      action: prepared.action,
      policyOutcome: prepared.policyOutcome,
      snapshotSelection: prepared.snapshotSelection,
      runSummary: prepared.runSummary,
      journal: params.journal,
      adapterRegistry: params.adapterRegistry,
      snapshotEngine: params.snapshotEngine,
      draftStore: params.draftStore,
      noteStore: params.noteStore,
      ticketStore: params.ticketStore,
      latencyMetrics: params.latencyMetrics,
      executeHostedDelegatedAction: (action) =>
        params.executeHostedDelegatedAction({
          action,
          mcpRegistry: params.mcpRegistry,
          journal: params.journal,
          hostedExecutionQueue: params.hostedExecutionQueue,
        }),
    });
    snapshotRecord = execution.snapshotRecord;
    executionResult = execution.executionResult;
  }

  return {
    api_version: API_VERSION,
    request_id: params.request.request_id,
    session_id: params.request.session_id,
    ok: true,
    result: {
      action: prepared.action,
      policy_outcome: prepared.policyOutcome,
      execution_result: executionResult,
      snapshot_record: snapshotRecord,
      approval_request: approvalRequest,
    },
    error: null,
  };
}
