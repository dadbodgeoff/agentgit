import net from "node:net";
import path from "node:path";

import {
  API_VERSION,
  type ApprovalRequest,
  type RecoveryTarget,
  type ExecuteRecoveryRequestPayload,
  type ExecuteRecoveryResponsePayload,
  type DiagnosticsRequestPayload,
  type DiagnosticsResponsePayload,
  type ExplainPolicyActionRequestPayload,
  type ExplainPolicyActionResponsePayload,
  type GetEffectivePolicyRequestPayload,
  type GetEffectivePolicyResponsePayload,
  type GetPolicyCalibrationReportRequestPayload,
  type GetPolicyCalibrationReportResponsePayload,
  type GetPolicyThresholdReplayRequestPayload,
  type GetPolicyThresholdReplayResponsePayload,
  type GetPolicyThresholdRecommendationsRequestPayload,
  type GetPolicyThresholdRecommendationsResponsePayload,
  type GetCapabilitiesRequestPayload,
  type GetCapabilitiesResponsePayload,
  type GetRunSummaryRequestPayload,
  type GetRunSummaryResponsePayload,
  type GetMcpServerReviewRequestPayload,
  type GetMcpServerReviewResponsePayload,
  type GetHostedMcpJobRequestPayload,
  type GetHostedMcpJobResponsePayload,
  type ListMcpServerCredentialBindingsRequestPayload,
  type ListMcpServerCredentialBindingsResponsePayload,
  type ListMcpServerTrustDecisionsRequestPayload,
  type ListMcpServerTrustDecisionsResponsePayload,
  type ListMcpServerCandidatesRequestPayload,
  type ListMcpServerCandidatesResponsePayload,
  type ListHostedMcpJobsRequestPayload,
  type ListHostedMcpJobsResponsePayload,
  type ListMcpServerProfilesRequestPayload,
  type ListMcpServerProfilesResponsePayload,
  type ListMcpHostPoliciesRequestPayload,
  type ListMcpHostPoliciesResponsePayload,
  type ListMcpSecretsRequestPayload,
  type ListMcpSecretsResponsePayload,
  type ListMcpServersRequestPayload,
  type ListMcpServersResponsePayload,
  type ListApprovalsRequestPayload,
  type ListApprovalsResponsePayload,
  type McpPublicHostPolicy,
  type McpServerCandidateInput,
  type McpSecretInput,
  type McpServerDefinition,
  type RemoveMcpHostPolicyRequestPayload,
  type RemoveMcpHostPolicyResponsePayload,
  type RemoveMcpSecretRequestPayload,
  type RemoveMcpSecretResponsePayload,
  type QueryApprovalInboxRequestPayload,
  type QueryApprovalInboxResponsePayload,
  type QueryArtifactRequestPayload,
  type QueryArtifactResponsePayload,
  type RawActionAttempt,
  type CancelHostedMcpJobRequestPayload,
  type CancelHostedMcpJobResponsePayload,
  type RequeueHostedMcpJobRequestPayload,
  type RequeueHostedMcpJobResponsePayload,
  type RunMaintenanceRequestPayload,
  type RunMaintenanceResponsePayload,
  type PlanRecoveryRequestPayload,
  type PlanRecoveryResponsePayload,
  type QueryHelperRequestPayload,
  type QueryHelperResponsePayload,
  type QueryTimelineRequestPayload,
  type QueryTimelineResponsePayload,
  type ResolveMcpServerCandidateRequestPayload,
  type ResolveMcpServerCandidateResponsePayload,
  type BindMcpServerCredentialsRequestPayload,
  type BindMcpServerCredentialsResponsePayload,
  type CreateRunCheckpointRequestPayload,
  type CreateRunCheckpointResponsePayload,
  type SubmitActionAttemptRequestPayload,
  type SubmitActionAttemptResponsePayload,
  type ClientType,
  type HelloRequestPayload,
  type HelloResponsePayload,
  type RegisterRunRequestPayload,
  type RegisterRunResponsePayload,
  type RemoveMcpServerRequestPayload,
  type RemoveMcpServerResponsePayload,
  type ResolveApprovalRequestPayload,
  type ResolveApprovalResponsePayload,
  type RequestEnvelope,
  type ResponseEnvelope,
  type SubmitMcpServerCandidateRequestPayload,
  type SubmitMcpServerCandidateResponsePayload,
  type ValidatePolicyConfigRequestPayload,
  type ValidatePolicyConfigResponsePayload,
  type ApproveMcpServerProfileRequestPayload,
  type ApproveMcpServerProfileResponsePayload,
  type ActivateMcpServerProfileRequestPayload,
  type ActivateMcpServerProfileResponsePayload,
  type QuarantineMcpServerProfileRequestPayload,
  type QuarantineMcpServerProfileResponsePayload,
  type RevokeMcpServerProfileRequestPayload,
  type RevokeMcpServerProfileResponsePayload,
  type RevokeMcpServerCredentialsRequestPayload,
  type RevokeMcpServerCredentialsResponsePayload,
  type UpsertMcpHostPolicyRequestPayload,
  type UpsertMcpHostPolicyResponsePayload,
  type UpsertMcpSecretRequestPayload,
  type UpsertMcpSecretResponsePayload,
  type UpsertMcpServerRequestPayload,
  type UpsertMcpServerResponsePayload,
  isResponseEnvelope,
} from "@agentgit/schemas";
import { v7 as uuidv7 } from "uuid";

export interface AuthorityClientOptions {
  socketPath?: string;
  clientType?: ClientType;
  clientVersion?: string;
  connectTimeoutMs?: number;
  responseTimeoutMs?: number;
  maxConnectRetries?: number;
  connectRetryDelayMs?: number;
}

export type AuthorityClientTransportErrorCode =
  | "SOCKET_CONNECT_FAILED"
  | "SOCKET_CONNECT_TIMEOUT"
  | "SOCKET_RESPONSE_TIMEOUT"
  | "SOCKET_CLOSED"
  | "INVALID_RESPONSE";

export class AuthorityClientTransportError extends Error {
  constructor(
    message: string,
    public readonly code: AuthorityClientTransportErrorCode,
    public readonly retryable: boolean,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AuthorityClientTransportError";
  }
}

export class AuthorityDaemonResponseError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly errorClass: string,
    public readonly retryable: boolean,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AuthorityDaemonResponseError";
  }
}

interface TransportOptions {
  connectTimeoutMs: number;
  responseTimeoutMs: number;
  maxConnectRetries: number;
  connectRetryDelayMs: number;
}

export interface MutatingRequestOptions {
  idempotencyKey?: string;
}

export class AuthorityClient {
  private readonly socketPath: string;
  private readonly clientType: ClientType;
  private readonly clientVersion: string;
  private readonly transport: TransportOptions;
  private sessionId: string | undefined;

  constructor(options: AuthorityClientOptions = {}) {
    const projectRoot = process.env.AGENTGIT_ROOT ?? process.env.INIT_CWD ?? process.cwd();
    this.socketPath =
      options.socketPath ??
      process.env.AGENTGIT_SOCKET_PATH ??
      path.resolve(projectRoot, ".agentgit", "authority.sock");
    this.clientType = options.clientType ?? "sdk_ts";
    this.clientVersion = options.clientVersion ?? "0.1.0";
    this.transport = {
      connectTimeoutMs: options.connectTimeoutMs ?? 1_000,
      responseTimeoutMs: options.responseTimeoutMs ?? 5_000,
      maxConnectRetries: options.maxConnectRetries ?? 1,
      connectRetryDelayMs: options.connectRetryDelayMs ?? 50,
    };
  }

  async hello(workspaceRoots: string[] = []): Promise<HelloResponsePayload> {
    const payload: HelloRequestPayload = {
      client_type: this.clientType,
      client_version: this.clientVersion,
      requested_api_version: API_VERSION,
      workspace_roots: workspaceRoots,
    };

    const response = await this.sendRequest<HelloRequestPayload, HelloResponsePayload>("hello", payload);
    this.sessionId = response.session_id;
    return response;
  }

  async registerRun(
    payload: RegisterRunRequestPayload,
    options: MutatingRequestOptions = {},
  ): Promise<RegisterRunResponsePayload> {
    if (!this.sessionId) {
      await this.hello(payload.workspace_roots);
    }

    return this.sendRequest<RegisterRunRequestPayload, RegisterRunResponsePayload>(
      "register_run",
      payload,
      this.sessionId,
      options.idempotencyKey,
    );
  }

  async getRunSummary(runId: string): Promise<GetRunSummaryResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: GetRunSummaryRequestPayload = {
      run_id: runId,
    };

    return this.sendRequest<GetRunSummaryRequestPayload, GetRunSummaryResponsePayload>(
      "get_run_summary",
      payload,
      this.sessionId,
    );
  }

  async createRunCheckpoint(
    payload: CreateRunCheckpointRequestPayload,
    options: MutatingRequestOptions = {},
  ): Promise<CreateRunCheckpointResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    return this.sendRequest<CreateRunCheckpointRequestPayload, CreateRunCheckpointResponsePayload>(
      "create_run_checkpoint",
      payload,
      this.sessionId,
      options.idempotencyKey,
    );
  }

  async getCapabilities(workspaceRoot?: string): Promise<GetCapabilitiesResponsePayload> {
    if (!this.sessionId) {
      await this.hello(workspaceRoot ? [workspaceRoot] : []);
    }

    const payload: GetCapabilitiesRequestPayload = workspaceRoot ? { workspace_root: workspaceRoot } : {};
    return this.sendRequest<GetCapabilitiesRequestPayload, GetCapabilitiesResponsePayload>(
      "get_capabilities",
      payload,
      this.sessionId,
    );
  }

  async getEffectivePolicy(): Promise<GetEffectivePolicyResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: GetEffectivePolicyRequestPayload = {};
    return this.sendRequest<GetEffectivePolicyRequestPayload, GetEffectivePolicyResponsePayload>(
      "get_effective_policy",
      payload,
      this.sessionId,
    );
  }

  async validatePolicyConfig(config: unknown): Promise<ValidatePolicyConfigResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: ValidatePolicyConfigRequestPayload = {
      config,
    };
    return this.sendRequest<ValidatePolicyConfigRequestPayload, ValidatePolicyConfigResponsePayload>(
      "validate_policy_config",
      payload,
      this.sessionId,
    );
  }

  async getPolicyCalibrationReport(
    options: {
      run_id?: string;
      include_samples?: boolean;
      sample_limit?: number;
    } = {},
  ): Promise<GetPolicyCalibrationReportResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: GetPolicyCalibrationReportRequestPayload = {
      ...(options.run_id ? { run_id: options.run_id } : {}),
      ...(options.include_samples !== undefined ? { include_samples: options.include_samples } : {}),
      ...(options.sample_limit !== undefined ? { sample_limit: options.sample_limit } : {}),
    };
    return this.sendRequest<GetPolicyCalibrationReportRequestPayload, GetPolicyCalibrationReportResponsePayload>(
      "get_policy_calibration_report",
      payload,
      this.sessionId,
    );
  }

  async explainPolicyAction(attempt: RawActionAttempt): Promise<ExplainPolicyActionResponsePayload> {
    if (!this.sessionId) {
      await this.hello(attempt.environment_context.workspace_roots);
    }

    const payload: ExplainPolicyActionRequestPayload = {
      attempt,
    };
    return this.sendRequest<ExplainPolicyActionRequestPayload, ExplainPolicyActionResponsePayload>(
      "explain_policy_action",
      payload,
      this.sessionId,
    );
  }

  async getPolicyThresholdRecommendations(
    options: {
      run_id?: string;
      min_samples?: number;
    } = {},
  ): Promise<GetPolicyThresholdRecommendationsResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: GetPolicyThresholdRecommendationsRequestPayload = {
      ...(options.run_id ? { run_id: options.run_id } : {}),
      ...(options.min_samples !== undefined ? { min_samples: options.min_samples } : {}),
    };
    return this.sendRequest<
      GetPolicyThresholdRecommendationsRequestPayload,
      GetPolicyThresholdRecommendationsResponsePayload
    >("get_policy_threshold_recommendations", payload, this.sessionId);
  }

  async replayPolicyThresholds(
    payload: GetPolicyThresholdReplayRequestPayload,
  ): Promise<GetPolicyThresholdReplayResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    return this.sendRequest<GetPolicyThresholdReplayRequestPayload, GetPolicyThresholdReplayResponsePayload>(
      "replay_policy_thresholds",
      payload,
      this.sessionId,
    );
  }

  async listMcpServers(): Promise<ListMcpServersResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: ListMcpServersRequestPayload = {};
    return this.sendRequest<ListMcpServersRequestPayload, ListMcpServersResponsePayload>(
      "list_mcp_servers",
      payload,
      this.sessionId,
    );
  }

  async listMcpServerCandidates(): Promise<ListMcpServerCandidatesResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: ListMcpServerCandidatesRequestPayload = {};
    return this.sendRequest<ListMcpServerCandidatesRequestPayload, ListMcpServerCandidatesResponsePayload>(
      "list_mcp_server_candidates",
      payload,
      this.sessionId,
    );
  }

  async submitMcpServerCandidate(
    candidate: McpServerCandidateInput,
    options: MutatingRequestOptions = {},
  ): Promise<SubmitMcpServerCandidateResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: SubmitMcpServerCandidateRequestPayload = {
      candidate,
    };
    return this.sendRequest<SubmitMcpServerCandidateRequestPayload, SubmitMcpServerCandidateResponsePayload>(
      "submit_mcp_server_candidate",
      payload,
      this.sessionId,
      options.idempotencyKey,
    );
  }

  async listMcpServerProfiles(): Promise<ListMcpServerProfilesResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: ListMcpServerProfilesRequestPayload = {};
    return this.sendRequest<ListMcpServerProfilesRequestPayload, ListMcpServerProfilesResponsePayload>(
      "list_mcp_server_profiles",
      payload,
      this.sessionId,
    );
  }

  async getMcpServerReview(payload: GetMcpServerReviewRequestPayload): Promise<GetMcpServerReviewResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    return this.sendRequest<GetMcpServerReviewRequestPayload, GetMcpServerReviewResponsePayload>(
      "get_mcp_server_review",
      payload,
      this.sessionId,
    );
  }

  async resolveMcpServerCandidate(
    payload: ResolveMcpServerCandidateRequestPayload,
    options: MutatingRequestOptions = {},
  ): Promise<ResolveMcpServerCandidateResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    return this.sendRequest<ResolveMcpServerCandidateRequestPayload, ResolveMcpServerCandidateResponsePayload>(
      "resolve_mcp_server_candidate",
      payload,
      this.sessionId,
      options.idempotencyKey,
    );
  }

  async listMcpServerTrustDecisions(serverProfileId?: string): Promise<ListMcpServerTrustDecisionsResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: ListMcpServerTrustDecisionsRequestPayload = serverProfileId
      ? { server_profile_id: serverProfileId }
      : {};
    return this.sendRequest<ListMcpServerTrustDecisionsRequestPayload, ListMcpServerTrustDecisionsResponsePayload>(
      "list_mcp_server_trust_decisions",
      payload,
      this.sessionId,
    );
  }

  async listMcpServerCredentialBindings(
    serverProfileId?: string,
  ): Promise<ListMcpServerCredentialBindingsResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: ListMcpServerCredentialBindingsRequestPayload = serverProfileId
      ? { server_profile_id: serverProfileId }
      : {};
    return this.sendRequest<
      ListMcpServerCredentialBindingsRequestPayload,
      ListMcpServerCredentialBindingsResponsePayload
    >("list_mcp_server_credential_bindings", payload, this.sessionId);
  }

  async bindMcpServerCredentials(
    payload: BindMcpServerCredentialsRequestPayload,
    options: MutatingRequestOptions = {},
  ): Promise<BindMcpServerCredentialsResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    return this.sendRequest<BindMcpServerCredentialsRequestPayload, BindMcpServerCredentialsResponsePayload>(
      "bind_mcp_server_credentials",
      payload,
      this.sessionId,
      options.idempotencyKey,
    );
  }

  async revokeMcpServerCredentials(
    credentialBindingId: string,
    options: MutatingRequestOptions = {},
  ): Promise<RevokeMcpServerCredentialsResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: RevokeMcpServerCredentialsRequestPayload = {
      credential_binding_id: credentialBindingId,
    };
    return this.sendRequest<RevokeMcpServerCredentialsRequestPayload, RevokeMcpServerCredentialsResponsePayload>(
      "revoke_mcp_server_credentials",
      payload,
      this.sessionId,
      options.idempotencyKey,
    );
  }

  async approveMcpServerProfile(
    payload: ApproveMcpServerProfileRequestPayload,
    options: MutatingRequestOptions = {},
  ): Promise<ApproveMcpServerProfileResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    return this.sendRequest<ApproveMcpServerProfileRequestPayload, ApproveMcpServerProfileResponsePayload>(
      "approve_mcp_server_profile",
      payload,
      this.sessionId,
      options.idempotencyKey,
    );
  }

  async activateMcpServerProfile(
    serverProfileId: string,
    options: MutatingRequestOptions = {},
  ): Promise<ActivateMcpServerProfileResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: ActivateMcpServerProfileRequestPayload = {
      server_profile_id: serverProfileId,
    };
    return this.sendRequest<ActivateMcpServerProfileRequestPayload, ActivateMcpServerProfileResponsePayload>(
      "activate_mcp_server_profile",
      payload,
      this.sessionId,
      options.idempotencyKey,
    );
  }

  async quarantineMcpServerProfile(
    payload: QuarantineMcpServerProfileRequestPayload,
    options: MutatingRequestOptions = {},
  ): Promise<QuarantineMcpServerProfileResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    return this.sendRequest<QuarantineMcpServerProfileRequestPayload, QuarantineMcpServerProfileResponsePayload>(
      "quarantine_mcp_server_profile",
      payload,
      this.sessionId,
      options.idempotencyKey,
    );
  }

  async revokeMcpServerProfile(
    payload: RevokeMcpServerProfileRequestPayload,
    options: MutatingRequestOptions = {},
  ): Promise<RevokeMcpServerProfileResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    return this.sendRequest<RevokeMcpServerProfileRequestPayload, RevokeMcpServerProfileResponsePayload>(
      "revoke_mcp_server_profile",
      payload,
      this.sessionId,
      options.idempotencyKey,
    );
  }

  async listMcpSecrets(): Promise<ListMcpSecretsResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: ListMcpSecretsRequestPayload = {};
    return this.sendRequest<ListMcpSecretsRequestPayload, ListMcpSecretsResponsePayload>(
      "list_mcp_secrets",
      payload,
      this.sessionId,
    );
  }

  async upsertMcpSecret(
    secret: McpSecretInput,
    options: MutatingRequestOptions = {},
  ): Promise<UpsertMcpSecretResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: UpsertMcpSecretRequestPayload = {
      secret,
    };
    return this.sendRequest<UpsertMcpSecretRequestPayload, UpsertMcpSecretResponsePayload>(
      "upsert_mcp_secret",
      payload,
      this.sessionId,
      options.idempotencyKey,
    );
  }

  async removeMcpSecret(
    secretId: string,
    options: MutatingRequestOptions = {},
  ): Promise<RemoveMcpSecretResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: RemoveMcpSecretRequestPayload = {
      secret_id: secretId,
    };
    return this.sendRequest<RemoveMcpSecretRequestPayload, RemoveMcpSecretResponsePayload>(
      "remove_mcp_secret",
      payload,
      this.sessionId,
      options.idempotencyKey,
    );
  }

  async listMcpHostPolicies(): Promise<ListMcpHostPoliciesResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: ListMcpHostPoliciesRequestPayload = {};
    return this.sendRequest<ListMcpHostPoliciesRequestPayload, ListMcpHostPoliciesResponsePayload>(
      "list_mcp_host_policies",
      payload,
      this.sessionId,
    );
  }

  async upsertMcpHostPolicy(
    policy: McpPublicHostPolicy,
    options: MutatingRequestOptions = {},
  ): Promise<UpsertMcpHostPolicyResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: UpsertMcpHostPolicyRequestPayload = {
      policy,
    };
    return this.sendRequest<UpsertMcpHostPolicyRequestPayload, UpsertMcpHostPolicyResponsePayload>(
      "upsert_mcp_host_policy",
      payload,
      this.sessionId,
      options.idempotencyKey,
    );
  }

  async removeMcpHostPolicy(
    host: string,
    options: MutatingRequestOptions = {},
  ): Promise<RemoveMcpHostPolicyResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: RemoveMcpHostPolicyRequestPayload = {
      host,
    };
    return this.sendRequest<RemoveMcpHostPolicyRequestPayload, RemoveMcpHostPolicyResponsePayload>(
      "remove_mcp_host_policy",
      payload,
      this.sessionId,
      options.idempotencyKey,
    );
  }

  async upsertMcpServer(
    server: McpServerDefinition,
    options: MutatingRequestOptions = {},
  ): Promise<UpsertMcpServerResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: UpsertMcpServerRequestPayload = {
      server,
    };
    return this.sendRequest<UpsertMcpServerRequestPayload, UpsertMcpServerResponsePayload>(
      "upsert_mcp_server",
      payload,
      this.sessionId,
      options.idempotencyKey,
    );
  }

  async removeMcpServer(
    serverId: string,
    options: MutatingRequestOptions = {},
  ): Promise<RemoveMcpServerResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: RemoveMcpServerRequestPayload = {
      server_id: serverId,
    };
    return this.sendRequest<RemoveMcpServerRequestPayload, RemoveMcpServerResponsePayload>(
      "remove_mcp_server",
      payload,
      this.sessionId,
      options.idempotencyKey,
    );
  }

  async getHostedMcpJob(jobId: string): Promise<GetHostedMcpJobResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: GetHostedMcpJobRequestPayload = {
      job_id: jobId,
    };
    return this.sendRequest<GetHostedMcpJobRequestPayload, GetHostedMcpJobResponsePayload>(
      "get_hosted_mcp_job",
      payload,
      this.sessionId,
    );
  }

  async listHostedMcpJobs(
    filters: {
      server_profile_id?: string;
      status?: ListHostedMcpJobsRequestPayload["status"];
      lifecycle_state?: ListHostedMcpJobsRequestPayload["lifecycle_state"];
    } = {},
  ): Promise<ListHostedMcpJobsResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: ListHostedMcpJobsRequestPayload = {
      ...(filters.server_profile_id ? { server_profile_id: filters.server_profile_id } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.lifecycle_state ? { lifecycle_state: filters.lifecycle_state } : {}),
    };
    return this.sendRequest<ListHostedMcpJobsRequestPayload, ListHostedMcpJobsResponsePayload>(
      "list_hosted_mcp_jobs",
      payload,
      this.sessionId,
    );
  }

  async requeueHostedMcpJob(
    jobId: string,
    payloadOverrides: Omit<RequeueHostedMcpJobRequestPayload, "job_id"> = {},
    options: MutatingRequestOptions = {},
  ): Promise<RequeueHostedMcpJobResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: RequeueHostedMcpJobRequestPayload = {
      job_id: jobId,
      ...payloadOverrides,
    };
    return this.sendRequest<RequeueHostedMcpJobRequestPayload, RequeueHostedMcpJobResponsePayload>(
      "requeue_hosted_mcp_job",
      payload,
      this.sessionId,
      options.idempotencyKey,
    );
  }

  async cancelHostedMcpJob(
    jobId: string,
    payloadOverrides: Omit<CancelHostedMcpJobRequestPayload, "job_id"> = {},
    options: MutatingRequestOptions = {},
  ): Promise<CancelHostedMcpJobResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: CancelHostedMcpJobRequestPayload = {
      job_id: jobId,
      ...payloadOverrides,
    };
    return this.sendRequest<CancelHostedMcpJobRequestPayload, CancelHostedMcpJobResponsePayload>(
      "cancel_hosted_mcp_job",
      payload,
      this.sessionId,
      options.idempotencyKey,
    );
  }

  async diagnostics(sections?: DiagnosticsRequestPayload["sections"]): Promise<DiagnosticsResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: DiagnosticsRequestPayload = sections ? { sections } : {};
    return this.sendRequest<DiagnosticsRequestPayload, DiagnosticsResponsePayload>(
      "diagnostics",
      payload,
      this.sessionId,
    );
  }

  async runMaintenance(
    jobTypes: RunMaintenanceRequestPayload["job_types"],
    options: Omit<RunMaintenanceRequestPayload, "job_types"> = {},
    requestOptions: MutatingRequestOptions = {},
  ): Promise<RunMaintenanceResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: RunMaintenanceRequestPayload = {
      job_types: jobTypes,
      ...options,
    };
    return this.sendRequest<RunMaintenanceRequestPayload, RunMaintenanceResponsePayload>(
      "run_maintenance",
      payload,
      this.sessionId,
      requestOptions.idempotencyKey,
    );
  }

  async submitActionAttempt(
    attempt: RawActionAttempt,
    options: MutatingRequestOptions = {},
  ): Promise<SubmitActionAttemptResponsePayload> {
    if (!this.sessionId) {
      await this.hello(attempt.environment_context.workspace_roots);
    }

    const payload: SubmitActionAttemptRequestPayload = {
      attempt,
    };

    return this.sendRequest<SubmitActionAttemptRequestPayload, SubmitActionAttemptResponsePayload>(
      "submit_action_attempt",
      payload,
      this.sessionId,
      options.idempotencyKey,
    );
  }

  async listApprovals(
    filters: {
      run_id?: string;
      status?: ApprovalRequest["status"];
    } = {},
  ): Promise<ListApprovalsResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: ListApprovalsRequestPayload = filters;
    return this.sendRequest<ListApprovalsRequestPayload, ListApprovalsResponsePayload>(
      "list_approvals",
      payload,
      this.sessionId,
    );
  }

  async queryApprovalInbox(
    filters: {
      run_id?: string;
      status?: ApprovalRequest["status"];
    } = {},
  ): Promise<QueryApprovalInboxResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: QueryApprovalInboxRequestPayload = filters;
    return this.sendRequest<QueryApprovalInboxRequestPayload, QueryApprovalInboxResponsePayload>(
      "query_approval_inbox",
      payload,
      this.sessionId,
    );
  }

  async resolveApproval(
    approvalId: string,
    resolution: ResolveApprovalRequestPayload["resolution"],
    note?: string,
    options: MutatingRequestOptions = {},
  ): Promise<ResolveApprovalResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: ResolveApprovalRequestPayload = {
      approval_id: approvalId,
      resolution,
      ...(note ? { note } : {}),
    };

    return this.sendRequest<ResolveApprovalRequestPayload, ResolveApprovalResponsePayload>(
      "resolve_approval",
      payload,
      this.sessionId,
      options.idempotencyKey,
    );
  }

  async queryTimeline(
    runId: string,
    visibilityScope?: QueryTimelineRequestPayload["visibility_scope"],
  ): Promise<QueryTimelineResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: QueryTimelineRequestPayload = {
      run_id: runId,
      ...(visibilityScope ? { visibility_scope: visibilityScope } : {}),
    };

    return this.sendRequest<QueryTimelineRequestPayload, QueryTimelineResponsePayload>(
      "query_timeline",
      payload,
      this.sessionId,
    );
  }

  async queryHelper(
    runId: string,
    questionType: QueryHelperRequestPayload["question_type"],
    focusStepId?: string,
    compareStepId?: string,
    visibilityScope?: QueryHelperRequestPayload["visibility_scope"],
  ): Promise<QueryHelperResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: QueryHelperRequestPayload = {
      run_id: runId,
      question_type: questionType,
      ...(focusStepId ? { focus_step_id: focusStepId } : {}),
      ...(compareStepId ? { compare_step_id: compareStepId } : {}),
      ...(visibilityScope ? { visibility_scope: visibilityScope } : {}),
    };

    return this.sendRequest<QueryHelperRequestPayload, QueryHelperResponsePayload>(
      "query_helper",
      payload,
      this.sessionId,
    );
  }

  async queryArtifact(
    artifactId: string,
    visibilityScope?: QueryArtifactRequestPayload["visibility_scope"],
    options: {
      fullContent?: boolean;
    } = {},
  ): Promise<QueryArtifactResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const payload: QueryArtifactRequestPayload = {
      artifact_id: artifactId,
      ...(visibilityScope ? { visibility_scope: visibilityScope } : {}),
      ...(options.fullContent ? { full_content: true } : {}),
    };

    return this.sendRequest<QueryArtifactRequestPayload, QueryArtifactResponsePayload>(
      "query_artifact",
      payload,
      this.sessionId,
    );
  }

  async planRecovery(targetInput: string | RecoveryTarget): Promise<PlanRecoveryResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const target = normalizeRecoveryTarget(targetInput);
    const payload: PlanRecoveryRequestPayload = {
      target,
    };

    return this.sendRequest<PlanRecoveryRequestPayload, PlanRecoveryResponsePayload>(
      "plan_recovery",
      payload,
      this.sessionId,
    );
  }

  async executeRecovery(
    targetInput: string | RecoveryTarget,
    options: MutatingRequestOptions = {},
  ): Promise<ExecuteRecoveryResponsePayload> {
    if (!this.sessionId) {
      await this.hello();
    }

    const target = normalizeRecoveryTarget(targetInput);
    const payload: ExecuteRecoveryRequestPayload = {
      target,
    };

    return this.sendRequest<ExecuteRecoveryRequestPayload, ExecuteRecoveryResponsePayload>(
      "execute_recovery",
      payload,
      this.sessionId,
      options.idempotencyKey,
    );
  }

  private async sendRequest<TPayload, TResult>(
    method: RequestEnvelope<TPayload>["method"],
    payload: TPayload,
    sessionId?: string,
    idempotencyKey?: string,
  ): Promise<TResult> {
    const request: RequestEnvelope<TPayload> = {
      api_version: API_VERSION,
      request_id: `req_${uuidv7().replaceAll("-", "")}`,
      session_id: sessionId,
      method,
      payload,
      idempotency_key: idempotencyKey,
    };

    const rawResponse = await writeAndReadLine(this.socketPath, request, this.transport);

    if (!isResponseEnvelope(rawResponse)) {
      throw new AuthorityClientTransportError(
        "Daemon returned an invalid response envelope.",
        "INVALID_RESPONSE",
        false,
      );
    }

    const response = rawResponse as ResponseEnvelope<TResult>;

    if (!response.ok || !response.result) {
      throw new AuthorityDaemonResponseError(
        response.error?.message ?? "Unknown daemon error.",
        response.error?.code ?? "UNKNOWN",
        response.error?.error_class ?? "UnknownError",
        response.error?.retryable ?? false,
        response.error?.details,
      );
    }

    return response.result;
  }
}

function normalizeRecoveryTarget(target: string | RecoveryTarget): RecoveryTarget {
  if (typeof target !== "string") {
    return target;
  }

  if (target.startsWith("act_")) {
    return {
      type: "action_boundary",
      action_id: target,
    };
  }

  return {
    type: "snapshot_id",
    snapshot_id: target,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableConnectError(error: unknown): boolean {
  return (
    error instanceof AuthorityClientTransportError &&
    (error.code === "SOCKET_CONNECT_FAILED" || error.code === "SOCKET_CONNECT_TIMEOUT") &&
    error.retryable
  );
}

async function writeAndReadLine(socketPath: string, payload: unknown, transport: TransportOptions): Promise<unknown> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= transport.maxConnectRetries; attempt += 1) {
    try {
      return await writeAndReadLineOnce(socketPath, payload, transport);
    } catch (error) {
      lastError = error;

      const canRetry = attempt < transport.maxConnectRetries && isRetryableConnectError(error);
      if (!canRetry) {
        throw error;
      }

      await sleep(transport.connectRetryDelayMs);
    }
  }

  throw lastError;
}

async function writeAndReadLineOnce(
  socketPath: string,
  payload: unknown,
  transport: TransportOptions,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;
    let connected = false;
    let responseTimer: NodeJS.Timeout | undefined;
    const requestBody = `${JSON.stringify(payload)}\n`;

    const connectTimer = setTimeout(() => {
      if (settled || connected) {
        return;
      }

      settled = true;
      socket.destroy();
      reject(
        new AuthorityClientTransportError(
          "Timed out while connecting to the authority daemon.",
          "SOCKET_CONNECT_TIMEOUT",
          true,
          {
            socket_path: socketPath,
            timeout_ms: transport.connectTimeoutMs,
          },
        ),
      );
    }, transport.connectTimeoutMs);

    const cleanup = () => {
      clearTimeout(connectTimer);
      if (responseTimer) {
        clearTimeout(responseTimer);
      }
    };

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      callback();
    };

    socket.setEncoding("utf8");

    socket.once("connect", () => {
      connected = true;
      clearTimeout(connectTimer);
      responseTimer = setTimeout(() => {
        settle(() => {
          socket.destroy();
          reject(
            new AuthorityClientTransportError(
              "Timed out while waiting for the authority daemon response.",
              "SOCKET_RESPONSE_TIMEOUT",
              false,
              {
                socket_path: socketPath,
                timeout_ms: transport.responseTimeoutMs,
              },
            ),
          );
        });
      }, transport.responseTimeoutMs);

      socket.write(requestBody);
    });

    socket.on("data", (chunk) => {
      if (settled) {
        return;
      }

      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");

      if (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        settle(() => {
          socket.end();

          try {
            resolve(JSON.parse(line));
          } catch (error) {
            reject(
              new AuthorityClientTransportError("Daemon returned malformed JSON.", "INVALID_RESPONSE", false, {
                cause: error instanceof Error ? error.message : String(error),
              }),
            );
          }
        });
      }
    });

    socket.once("error", (error) => {
      settle(() => {
        reject(
          new AuthorityClientTransportError(
            "Failed to communicate with the authority daemon.",
            "SOCKET_CONNECT_FAILED",
            !connected,
            {
              socket_path: socketPath,
              cause: error.message,
              errno: "code" in error ? error.code : undefined,
            },
          ),
        );
      });
    });

    socket.once("close", () => {
      if (settled) {
        return;
      }

      settle(() => {
        reject(
          new AuthorityClientTransportError(
            connected
              ? "Authority daemon closed the socket before sending a response."
              : "Authority daemon connection closed before it was established.",
            connected ? "SOCKET_CLOSED" : "SOCKET_CONNECT_FAILED",
            !connected,
            {
              socket_path: socketPath,
            },
          ),
        );
      });
    });
  });
}
