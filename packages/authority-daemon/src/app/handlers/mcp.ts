import { createHash } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RequestContext } from "@agentgit/core-ports";
import type { SessionCredentialBroker } from "@agentgit/credential-broker";
import {
  classifyMcpNetworkScope,
  type McpPublicHostPolicyRegistry,
  type McpServerRegistry,
} from "@agentgit/mcp-registry";
import type { RunJournal } from "@agentgit/run-journal";
import {
  ActivateMcpServerProfileRequestPayloadSchema,
  type ActivateMcpServerProfileResponsePayload,
  type ActionRecord,
  type BindMcpServerCredentialsResponsePayload,
  BindMcpServerCredentialsRequestPayloadSchema,
  type CancelHostedMcpJobResponsePayload,
  CancelHostedMcpJobRequestPayloadSchema,
  type ExecutionResult,
  type GetHostedMcpJobResponsePayload,
  GetHostedMcpJobRequestPayloadSchema,
  type GetMcpServerReviewResponsePayload,
  GetMcpServerReviewRequestPayloadSchema,
  type HostedMcpExecutionAttestationRecord,
  type HostedMcpExecutionJobRecord,
  type HostedMcpExecutionLeaseRecord,
  type ImportedMcpToolRecord,
  type ListHostedMcpJobsResponsePayload,
  ListHostedMcpJobsRequestPayloadSchema,
  type ListMcpHostPoliciesResponsePayload,
  ListMcpHostPoliciesRequestPayloadSchema,
  type ListMcpSecretsResponsePayload,
  ListMcpSecretsRequestPayloadSchema,
  type ListMcpServerCandidatesResponsePayload,
  ListMcpServerCandidatesRequestPayloadSchema,
  type ListMcpServerCredentialBindingsResponsePayload,
  ListMcpServerCredentialBindingsRequestPayloadSchema,
  type ListMcpServerProfilesResponsePayload,
  ListMcpServerProfilesRequestPayloadSchema,
  type ListMcpServersResponsePayload,
  ListMcpServersRequestPayloadSchema,
  type ListMcpServerTrustDecisionsResponsePayload,
  ListMcpServerTrustDecisionsRequestPayloadSchema,
  type McpCredentialBindingRecord,
  type McpPublicHostPolicy,
  type McpServerCandidateRecord,
  type McpServerProfileRecord,
  type McpServerTrustDecisionRecord,
  NotFoundError,
  PreconditionError,
  QuarantineMcpServerProfileRequestPayloadSchema,
  type QuarantineMcpServerProfileResponsePayload,
  type RequeueHostedMcpJobResponsePayload,
  RequeueHostedMcpJobRequestPayloadSchema,
  type RequestEnvelope,
  type ResolveMcpServerCandidateResponsePayload,
  ResolveMcpServerCandidateRequestPayloadSchema,
  type ResponseEnvelope,
  type RevokeMcpServerCredentialsResponsePayload,
  RevokeMcpServerCredentialsRequestPayloadSchema,
  type RevokeMcpServerProfileResponsePayload,
  RevokeMcpServerProfileRequestPayloadSchema,
  type RemoveMcpHostPolicyResponsePayload,
  RemoveMcpHostPolicyRequestPayloadSchema,
  type RemoveMcpSecretResponsePayload,
  RemoveMcpSecretRequestPayloadSchema,
  type RemoveMcpServerResponsePayload,
  RemoveMcpServerRequestPayloadSchema,
  type SubmitActionAttemptResponsePayload,
  type SubmitMcpServerCandidateResponsePayload,
  SubmitMcpServerCandidateRequestPayloadSchema,
  type UpsertMcpHostPolicyResponsePayload,
  UpsertMcpHostPolicyRequestPayloadSchema,
  type UpsertMcpSecretResponsePayload,
  UpsertMcpSecretRequestPayloadSchema,
  type UpsertMcpServerResponsePayload,
  UpsertMcpServerRequestPayloadSchema,
  validate,
  ApproveMcpServerProfileRequestPayloadSchema,
  type ApproveMcpServerProfileResponsePayload,
} from "@agentgit/schemas";

import { createPrefixedId } from "../../ids.js";
import type { HostedExecutionQueue } from "../../hosted-execution-queue.js";
import type { HostedMcpWorkerClient } from "../../hosted-worker-client.js";
import type { AuthorityState } from "../../state.js";
import { requireValidSession, sessionCanAccessRun } from "../authorization.js";
import { eventPayloadString } from "../request-helpers.js";
import { makeSuccessResponse } from "../response-helpers.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
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

export function handleListMcpServers(
  mcpRegistry: McpServerRegistry,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
): ResponseEnvelope<ListMcpServersResponsePayload> {
  validate(ListMcpServersRequestPayloadSchema, request.payload);
  return makeSuccessResponse(request.request_id, request.session_id, {
    servers: mcpRegistry.listServers(),
  });
}

export function handleListMcpServerCandidates(
  mcpRegistry: McpServerRegistry,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
): ResponseEnvelope<ListMcpServerCandidatesResponsePayload> {
  validate(ListMcpServerCandidatesRequestPayloadSchema, request.payload);
  return makeSuccessResponse(request.request_id, request.session_id, {
    candidates: mcpRegistry.listCandidates(),
  });
}

export function handleListMcpServerProfiles(
  mcpRegistry: McpServerRegistry,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
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

export function handleGetMcpServerReview(
  mcpRegistry: McpServerRegistry,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
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

export function handleListHostedMcpJobs(
  mcpRegistry: McpServerRegistry,
  hostedExecutionQueue: HostedExecutionQueue,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
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

export function handleGetHostedMcpJob(
  mcpRegistry: McpServerRegistry,
  hostedExecutionQueue: HostedExecutionQueue,
  journal: RunJournal,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
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

export async function executeHostedDelegatedJobAttempt(params: {
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

export function handleSubmitMcpServerCandidate(
  state: AuthorityState,
  mcpRegistry: McpServerRegistry,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
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

export async function handleResolveMcpServerCandidate(
  state: AuthorityState,
  mcpRegistry: McpServerRegistry,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
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

export function handleListMcpServerTrustDecisions(
  mcpRegistry: McpServerRegistry,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
): ResponseEnvelope<ListMcpServerTrustDecisionsResponsePayload> {
  const payload = validate(ListMcpServerTrustDecisionsRequestPayloadSchema, request.payload);
  return makeSuccessResponse(request.request_id, request.session_id, {
    trust_decisions: mcpRegistry.listTrustDecisions(payload.server_profile_id),
  });
}

export function handleListMcpServerCredentialBindings(
  mcpRegistry: McpServerRegistry,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
): ResponseEnvelope<ListMcpServerCredentialBindingsResponsePayload> {
  const payload = validate(ListMcpServerCredentialBindingsRequestPayloadSchema, request.payload);
  return makeSuccessResponse(request.request_id, request.session_id, {
    credential_bindings: mcpRegistry.listCredentialBindings(payload.server_profile_id),
  });
}

export function handleBindMcpServerCredentials(
  state: AuthorityState,
  broker: SessionCredentialBroker,
  mcpRegistry: McpServerRegistry,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
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

export function handleRevokeMcpServerCredentials(
  state: AuthorityState,
  mcpRegistry: McpServerRegistry,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
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

export function handleApproveMcpServerProfile(
  state: AuthorityState,
  mcpRegistry: McpServerRegistry,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
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

export function handleActivateMcpServerProfile(
  state: AuthorityState,
  mcpRegistry: McpServerRegistry,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
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

export function handleQuarantineMcpServerProfile(
  state: AuthorityState,
  mcpRegistry: McpServerRegistry,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
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

export function handleRevokeMcpServerProfile(
  state: AuthorityState,
  mcpRegistry: McpServerRegistry,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
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

export function handleListMcpSecrets(
  broker: SessionCredentialBroker,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
): ResponseEnvelope<ListMcpSecretsResponsePayload> {
  validate(ListMcpSecretsRequestPayloadSchema, request.payload);
  return makeSuccessResponse(request.request_id, request.session_id, {
    secrets: broker.listMcpBearerSecrets(),
  });
}

export function handleUpsertMcpSecret(
  state: AuthorityState,
  broker: SessionCredentialBroker,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
): ResponseEnvelope<UpsertMcpSecretResponsePayload> {
  const payload = validate(UpsertMcpSecretRequestPayloadSchema, request.payload);
  const sessionId = requireValidSession(state, "upsert_mcp_secret", request.session_id);
  const result = broker.upsertMcpBearerSecret(payload.secret);

  return makeSuccessResponse(request.request_id, sessionId, result);
}

export function handleRemoveMcpSecret(
  state: AuthorityState,
  broker: SessionCredentialBroker,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
): ResponseEnvelope<RemoveMcpSecretResponsePayload> {
  const payload = validate(RemoveMcpSecretRequestPayloadSchema, request.payload);
  const sessionId = requireValidSession(state, "remove_mcp_secret", request.session_id);
  const removedSecret = broker.removeMcpBearerSecret(payload.secret_id);

  return makeSuccessResponse(request.request_id, sessionId, {
    removed: removedSecret !== null,
    removed_secret: removedSecret,
  });
}

export function handleListMcpHostPolicies(
  publicHostPolicyRegistry: McpPublicHostPolicyRegistry,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
): ResponseEnvelope<ListMcpHostPoliciesResponsePayload> {
  validate(ListMcpHostPoliciesRequestPayloadSchema, request.payload);
  return makeSuccessResponse(request.request_id, request.session_id, {
    policies: publicHostPolicyRegistry.listPolicies(),
  });
}

export function handleUpsertMcpHostPolicy(
  state: AuthorityState,
  publicHostPolicyRegistry: McpPublicHostPolicyRegistry,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
): ResponseEnvelope<UpsertMcpHostPolicyResponsePayload> {
  const payload = validate(UpsertMcpHostPolicyRequestPayloadSchema, request.payload);
  const sessionId = requireValidSession(state, "upsert_mcp_host_policy", request.session_id);
  const result = publicHostPolicyRegistry.upsertPolicy(payload.policy as McpPublicHostPolicy);

  return makeSuccessResponse(request.request_id, sessionId, result);
}

export function handleRemoveMcpHostPolicy(
  state: AuthorityState,
  publicHostPolicyRegistry: McpPublicHostPolicyRegistry,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
): ResponseEnvelope<RemoveMcpHostPolicyResponsePayload> {
  const payload = validate(RemoveMcpHostPolicyRequestPayloadSchema, request.payload);
  const sessionId = requireValidSession(state, "remove_mcp_host_policy", request.session_id);
  const removedPolicy = publicHostPolicyRegistry.removePolicy(payload.host);

  return makeSuccessResponse(request.request_id, sessionId, {
    removed: removedPolicy !== null,
    removed_policy: removedPolicy,
  });
}

export function handleUpsertMcpServer(
  state: AuthorityState,
  mcpRegistry: McpServerRegistry,
  broker: SessionCredentialBroker,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
): ResponseEnvelope<UpsertMcpServerResponsePayload> {
  const payload = validate(UpsertMcpServerRequestPayloadSchema, request.payload);
  const sessionId = requireValidSession(state, "upsert_mcp_server", request.session_id);
  if (payload.server.transport === "streamable_http" && payload.server.auth?.type === "bearer_secret_ref") {
    broker.resolveMcpBearerSecret(payload.server.auth.secret_id);
  }
  const result = mcpRegistry.upsertServer(payload.server);

  return makeSuccessResponse(request.request_id, sessionId, result);
}

export function handleRemoveMcpServer(
  state: AuthorityState,
  mcpRegistry: McpServerRegistry,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
): ResponseEnvelope<RemoveMcpServerResponsePayload> {
  const payload = validate(RemoveMcpServerRequestPayloadSchema, request.payload);
  const sessionId = requireValidSession(state, "remove_mcp_server", request.session_id);
  const removedServer = mcpRegistry.removeServer(payload.server_id);

  return makeSuccessResponse(request.request_id, sessionId, {
    removed: removedServer !== null,
    removed_server: removedServer,
  });
}

export function handleRequeueHostedMcpJob(
  state: AuthorityState,
  journal: RunJournal,
  hostedExecutionQueue: HostedExecutionQueue,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
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

export function handleCancelHostedMcpJob(
  state: AuthorityState,
  journal: RunJournal,
  hostedExecutionQueue: HostedExecutionQueue,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
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

export async function executeHostedDelegatedMcpAction(params: {
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
