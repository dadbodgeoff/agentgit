import type { RequestContext } from "@agentgit/core-ports";
import type { McpServerRegistry } from "@agentgit/mcp-registry";
import {
  replayPolicyThresholds,
  recommendPolicyThresholds,
  validatePolicyConfigDocument,
} from "@agentgit/policy-engine";
import type { RunJournal } from "@agentgit/run-journal";
import {
  API_VERSION,
  type DaemonMethod,
  type ExplainPolicyActionResponsePayload,
  ExplainPolicyActionRequestPayloadSchema,
  type GetEffectivePolicyResponsePayload,
  GetEffectivePolicyRequestPayloadSchema,
  type GetPolicyCalibrationReportResponsePayload,
  GetPolicyCalibrationReportRequestPayloadSchema,
  type GetPolicyThresholdRecommendationsResponsePayload,
  GetPolicyThresholdRecommendationsRequestPayloadSchema,
  type GetPolicyThresholdReplayResponsePayload,
  GetPolicyThresholdReplayRequestPayloadSchema,
  type HelloResponsePayload,
  HelloRequestPayloadSchema,
  type RegisterRunResponsePayload,
  RegisterRunRequestPayloadSchema,
  type RequestEnvelope,
  type ResponseEnvelope,
  SCHEMA_PACK_VERSION,
  type ValidatePolicyConfigResponsePayload,
  ValidatePolicyConfigRequestPayloadSchema,
  ValidationError,
  validate,
} from "@agentgit/schemas";

import { requireAuthorizedRunSummary, requireValidSession } from "../authorization.js";
import { buildCachedCapabilityState } from "../capabilities.js";
import { makeSuccessResponse } from "../response-helpers.js";
import type { ServiceOptions } from "../types.js";
import type { PolicyRuntimeState } from "../../policy-runtime.js";
import type { AuthorityState } from "../../state.js";
import { prepareActionAttemptEvaluation } from "../../handlers/submit-action.js";
import type { LatencyMetricsStore } from "../../latency-metrics.js";

export function handleHello(
  state: AuthorityState,
  methods: readonly DaemonMethod[],
  runtimeVersion: string,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
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
    runtime_version: runtimeVersion,
    schema_pack_version: SCHEMA_PACK_VERSION,
    capabilities: {
      local_only: true,
      methods: [...methods],
    },
  });
}

export function handleRegisterRun(
  state: AuthorityState,
  journal: RunJournal,
  policyRuntime: PolicyRuntimeState,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
): ResponseEnvelope<RegisterRunResponsePayload> {
  const payload = validate(RegisterRunRequestPayloadSchema, request.payload);
  const session = state.getSession(request.session_id);

  if (!session) {
    throw new ValidationError("A valid session_id is required before register_run.", {
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

export function handleGetEffectivePolicy(
  request: RequestEnvelope<unknown>,
  policyRuntime: PolicyRuntimeState,
  _context: RequestContext,
): ResponseEnvelope<GetEffectivePolicyResponsePayload> {
  validate(GetEffectivePolicyRequestPayloadSchema, request.payload);

  return makeSuccessResponse(request.request_id, request.session_id, policyRuntime.effective_policy);
}

export function handleValidatePolicyConfig(
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
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

export function handleGetPolicyCalibrationReport(
  state: AuthorityState,
  journal: RunJournal,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
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

export function handleExplainPolicyAction(
  state: AuthorityState,
  journal: RunJournal,
  policyRuntime: PolicyRuntimeState,
  latencyMetrics: LatencyMetricsStore,
  runtimeOptions: Pick<ServiceOptions, "capabilityRefreshStaleMs">,
  mcpRegistry: McpServerRegistry,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
): ResponseEnvelope<ExplainPolicyActionResponsePayload> {
  const sessionId = requireValidSession(state, "explain_policy_action", request.session_id);
  const session = state.getSession(sessionId);
  const payload = validate(ExplainPolicyActionRequestPayloadSchema, request.payload);
  const prepared = prepareActionAttemptEvaluation({
    journal,
    mcpRegistry,
    latencyMetrics,
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

export function handleGetPolicyThresholdRecommendations(
  state: AuthorityState,
  journal: RunJournal,
  policyRuntime: PolicyRuntimeState,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
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

export function handleReplayPolicyThresholds(
  state: AuthorityState,
  journal: RunJournal,
  policyRuntime: PolicyRuntimeState,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
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
