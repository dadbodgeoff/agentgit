import { z, type ZodType } from "zod";

export const API_VERSION = "authority.v1" as const;
export const SCHEMA_PACK_VERSION = "v1" as const;

export const ApiVersionSchema = z.literal(API_VERSION);
export const SchemaPackVersionSchema = z.literal(SCHEMA_PACK_VERSION);
export const TimestampStringSchema = z.string().min(1);

export type ApiVersion = z.infer<typeof ApiVersionSchema>;
export type SchemaPackVersion = z.infer<typeof SchemaPackVersionSchema>;

export const ClientTypeSchema = z.enum(["sdk_ts", "sdk_py", "cli", "ui"]);
export type ClientType = z.infer<typeof ClientTypeSchema>;

export const DaemonMethodSchema = z.enum([
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
]);
export type DaemonMethod = z.infer<typeof DaemonMethodSchema>;

export const TraceContextSchema = z
  .object({
    trace_id: z.string().min(1).optional(),
    span_id: z.string().min(1).optional(),
  })
  .strict();
export type TraceContext = z.infer<typeof TraceContextSchema>;

export const ErrorCodeSchema = z.enum([
  "BAD_REQUEST",
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "CONFLICT",
  "TIMEOUT",
  "PRECONDITION_FAILED",
  "POLICY_BLOCKED",
  "UPSTREAM_FAILURE",
  "CAPABILITY_UNAVAILABLE",
  "STORAGE_UNAVAILABLE",
  "BROKER_UNAVAILABLE",
  "INTERNAL_ERROR",
]);

export const ErrorEnvelopeSchema = z
  .object({
    code: ErrorCodeSchema,
    error_class: z.string().min(1),
    message: z.string().min(1),
    details: z.record(z.string(), z.unknown()).optional(),
    retryable: z.boolean(),
  })
  .strict();
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

const RequestEnvelopeBaseSchema = z
  .object({
    api_version: ApiVersionSchema,
    request_id: z.string().min(1),
    session_id: z.string().min(1).optional(),
    method: DaemonMethodSchema,
    idempotency_key: z.string().min(1).optional(),
    trace: TraceContextSchema.optional(),
    payload: z.unknown(),
  })
  .strict();
export const RequestEnvelopeSchema = RequestEnvelopeBaseSchema;
type RequestEnvelopeBase = z.infer<typeof RequestEnvelopeBaseSchema>;
export type RequestEnvelope<TPayload = unknown> = Omit<RequestEnvelopeBase, "payload"> & { payload: TPayload };

const ResponseEnvelopeBaseSchema = z
  .object({
    api_version: ApiVersionSchema,
    request_id: z.string().min(1),
    session_id: z.string().min(1).optional(),
    ok: z.boolean(),
    result: z.unknown().nullable(),
    error: ErrorEnvelopeSchema.nullable(),
  })
  .strict();
type ResponseEnvelopeBase = z.infer<typeof ResponseEnvelopeBaseSchema>;
export type ResponseEnvelope<TResult> = Omit<ResponseEnvelopeBase, "result"> & { result: TResult | null };

export const ServerCapabilitiesSchema = z
  .object({
    local_only: z.boolean(),
    methods: z.array(DaemonMethodSchema),
  })
  .strict();
export type ServerCapabilities = z.infer<typeof ServerCapabilitiesSchema>;

export const HelloRequestPayloadSchema = z
  .object({
    client_type: ClientTypeSchema,
    client_version: z.string().min(1),
    requested_api_version: ApiVersionSchema,
    workspace_roots: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type HelloRequestPayload = z.infer<typeof HelloRequestPayloadSchema>;

export const HelloResponsePayloadSchema = z
  .object({
    session_id: z.string().min(1),
    accepted_api_version: ApiVersionSchema,
    runtime_version: z.string().min(1),
    schema_pack_version: SchemaPackVersionSchema,
    capabilities: ServerCapabilitiesSchema,
  })
  .strict();
export type HelloResponsePayload = z.infer<typeof HelloResponsePayloadSchema>;

export const RegisterRunRequestPayloadSchema = z
  .object({
    workflow_name: z.string().min(1),
    agent_framework: z.string().min(1),
    agent_name: z.string().min(1),
    workspace_roots: z.array(z.string().min(1)).min(1),
    client_metadata: z.record(z.string(), z.unknown()).optional(),
    budget_config: z
      .object({
        max_mutating_actions: z.number().int().nonnegative().nullable().optional(),
        max_destructive_actions: z.number().int().nonnegative().nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type RegisterRunRequestPayload = z.infer<typeof RegisterRunRequestPayloadSchema>;

export const RunHandleSchema = z
  .object({
    run_id: z.string().min(1),
    session_id: z.string().min(1),
    workflow_name: z.string().min(1),
  })
  .strict();
export type RunHandle = z.infer<typeof RunHandleSchema>;

export const RegisterRunResponsePayloadSchema = z
  .object({
    run_id: z.string().min(1),
    run_handle: RunHandleSchema,
    effective_policy_profile: z.string().min(1),
  })
  .strict();
export type RegisterRunResponsePayload = z.infer<typeof RegisterRunResponsePayloadSchema>;

export const GetRunSummaryRequestPayloadSchema = z
  .object({
    run_id: z.string().min(1),
  })
  .strict();
export type GetRunSummaryRequestPayload = z.infer<typeof GetRunSummaryRequestPayloadSchema>;

export const RunEventSummarySchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    event_type: z.string().min(1),
    occurred_at: TimestampStringSchema,
    recorded_at: TimestampStringSchema,
  })
  .strict();
export type RunEventSummary = z.infer<typeof RunEventSummarySchema>;

export const RunMaintenanceStatusSchema = z
  .object({
    projection_status: z.literal("fresh"),
    projection_lag_events: z.literal(0),
    degraded_artifact_capture_actions: z.number().int().nonnegative(),
    low_disk_pressure_signals: z.number().int().nonnegative(),
    artifact_health: z
      .object({
        total: z.number().int().nonnegative(),
        available: z.number().int().nonnegative(),
        missing: z.number().int().nonnegative(),
        expired: z.number().int().nonnegative(),
        corrupted: z.number().int().nonnegative(),
        tampered: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type RunMaintenanceStatus = z.infer<typeof RunMaintenanceStatusSchema>;

export const RunSummarySchema = z
  .object({
    run_id: z.string().min(1),
    session_id: z.string().min(1),
    workflow_name: z.string().min(1),
    agent_framework: z.string().min(1),
    agent_name: z.string().min(1),
    workspace_roots: z.array(z.string().min(1)),
    event_count: z.number().int().nonnegative(),
    latest_event: RunEventSummarySchema.nullable(),
    budget_config: z
      .object({
        max_mutating_actions: z.number().int().nonnegative().nullable(),
        max_destructive_actions: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    budget_usage: z
      .object({
        mutating_actions: z.number().int().nonnegative(),
        destructive_actions: z.number().int().nonnegative(),
      })
      .strict(),
    maintenance_status: RunMaintenanceStatusSchema,
    created_at: TimestampStringSchema,
    started_at: TimestampStringSchema,
  })
  .strict();
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const GetRunSummaryResponsePayloadSchema = z
  .object({
    run: RunSummarySchema,
  })
  .strict();
export type GetRunSummaryResponsePayload = z.infer<typeof GetRunSummaryResponsePayloadSchema>;

export const CapabilityRecordSchema = z
  .object({
    capability_name: z.string().min(1),
    status: z.enum(["available", "degraded", "unavailable"]),
    scope: z.enum(["host", "workspace", "adapter"]),
    detected_at: TimestampStringSchema,
    source: z.string().min(1),
    details: z.record(z.string(), z.unknown()),
  })
  .strict();
export type CapabilityRecord = z.infer<typeof CapabilityRecordSchema>;

export const ReasonDetailSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();
export type ReasonDetail = z.infer<typeof ReasonDetailSchema>;

export const GetCapabilitiesRequestPayloadSchema = z
  .object({
    workspace_root: z.string().min(1).optional(),
  })
  .strict();
export type GetCapabilitiesRequestPayload = z.infer<typeof GetCapabilitiesRequestPayloadSchema>;

export const GetCapabilitiesResponsePayloadSchema = z
  .object({
    capabilities: z.array(CapabilityRecordSchema),
    detection_timestamps: z
      .object({
        started_at: TimestampStringSchema,
        completed_at: TimestampStringSchema,
      })
      .strict(),
    degraded_mode_warnings: z.array(z.string().min(1)),
  })
  .strict();
export type GetCapabilitiesResponsePayload = z.infer<typeof GetCapabilitiesResponsePayloadSchema>;

export const McpRegistrySourceSchema = z.enum(["operator_api", "bootstrap_env"]);
export type McpRegistrySource = z.infer<typeof McpRegistrySourceSchema>;

export const DiagnosticsSectionSchema = z.enum([
  "daemon_health",
  "journal_health",
  "maintenance_backlog",
  "projection_lag",
  "storage_summary",
  "capability_summary",
]);
export type DiagnosticsSection = z.infer<typeof DiagnosticsSectionSchema>;

export const DiagnosticsRequestPayloadSchema = z
  .object({
    sections: z.array(DiagnosticsSectionSchema).min(1).optional(),
  })
  .strict();
export type DiagnosticsRequestPayload = z.infer<typeof DiagnosticsRequestPayloadSchema>;

export const DaemonHealthSchema = z
  .object({
    status: z.enum(["healthy", "degraded"]),
    active_sessions: z.number().int().nonnegative(),
    active_runs: z.number().int().nonnegative(),
    warnings: z.array(z.string().min(1)),
    primary_reason: ReasonDetailSchema.nullable().optional(),
  })
  .strict();
export type DaemonHealth = z.infer<typeof DaemonHealthSchema>;

export const JournalHealthSchema = z
  .object({
    status: z.enum(["healthy", "degraded"]),
    total_runs: z.number().int().nonnegative(),
    total_events: z.number().int().nonnegative(),
    pending_approvals: z.number().int().nonnegative(),
    warnings: z.array(z.string().min(1)),
    primary_reason: ReasonDetailSchema.nullable().optional(),
  })
  .strict();
export type JournalHealth = z.infer<typeof JournalHealthSchema>;

export const MaintenanceBacklogSchema = z
  .object({
    pending_critical_jobs: z.number().int().nonnegative(),
    pending_maintenance_jobs: z.number().int().nonnegative(),
    oldest_pending_critical_job: z.string().min(1).nullable(),
    current_heavy_job: z.string().min(1).nullable(),
    snapshot_compaction_debt: z.number().int().nonnegative().nullable(),
    warnings: z.array(z.string().min(1)),
    primary_reason: ReasonDetailSchema.nullable().optional(),
  })
  .strict();
export type MaintenanceBacklog = z.infer<typeof MaintenanceBacklogSchema>;

export const ProjectionLagSchema = z
  .object({
    projection_status: z.literal("fresh"),
    lag_events: z.literal(0),
  })
  .strict();
export type ProjectionLag = z.infer<typeof ProjectionLagSchema>;

export const StorageSummarySchema = z
  .object({
    artifact_health: RunMaintenanceStatusSchema.shape.artifact_health,
    degraded_artifact_capture_actions: z.number().int().nonnegative(),
    low_disk_pressure_signals: z.number().int().nonnegative(),
    warnings: z.array(z.string().min(1)),
    primary_reason: ReasonDetailSchema.nullable().optional(),
  })
  .strict();
export type StorageSummary = z.infer<typeof StorageSummarySchema>;

export const CapabilitySummarySchema = z
  .object({
    cached: z.boolean(),
    refreshed_at: TimestampStringSchema.nullable(),
    workspace_root: z.string().min(1).nullable(),
    capability_count: z.number().int().nonnegative(),
    degraded_capabilities: z.number().int().nonnegative(),
    unavailable_capabilities: z.number().int().nonnegative(),
    stale_after_ms: z.number().int().nonnegative(),
    is_stale: z.boolean(),
    warnings: z.array(z.string().min(1)),
    primary_reason: ReasonDetailSchema.nullable().optional(),
  })
  .strict();
export type CapabilitySummary = z.infer<typeof CapabilitySummarySchema>;

export const DiagnosticsResponsePayloadSchema = z
  .object({
    daemon_health: DaemonHealthSchema.nullable(),
    journal_health: JournalHealthSchema.nullable(),
    maintenance_backlog: MaintenanceBacklogSchema.nullable(),
    projection_lag: ProjectionLagSchema.nullable(),
    storage_summary: StorageSummarySchema.nullable(),
    capability_summary: CapabilitySummarySchema.nullable(),
  })
  .strict();
export type DiagnosticsResponsePayload = z.infer<typeof DiagnosticsResponsePayloadSchema>;

export const MaintenanceJobTypeSchema = z.enum([
  "startup_reconcile_runs",
  "startup_reconcile_recoveries",
  "sqlite_wal_checkpoint",
  "projection_refresh",
  "projection_rebuild",
  "snapshot_gc",
  "snapshot_compaction",
  "snapshot_rebase_anchor",
  "artifact_expiry",
  "artifact_orphan_cleanup",
  "capability_refresh",
  "helper_fact_warm",
]);
export type MaintenanceJobType = z.infer<typeof MaintenanceJobTypeSchema>;

export const MaintenancePrioritySchema = z.enum(["critical", "interactive_support", "maintenance", "administrative"]);
export type MaintenancePriority = z.infer<typeof MaintenancePrioritySchema>;

export const RunMaintenanceRequestPayloadSchema = z
  .object({
    job_types: z.array(MaintenanceJobTypeSchema).min(1),
    priority_override: MaintenancePrioritySchema.optional(),
    scope: z
      .object({
        workspace_root: z.string().min(1).optional(),
        run_id: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type RunMaintenanceRequestPayload = z.infer<typeof RunMaintenanceRequestPayloadSchema>;

export const RunMaintenanceJobResultSchema = z
  .object({
    job_type: MaintenanceJobTypeSchema,
    status: z.enum(["completed", "not_supported", "failed"]),
    performed_inline: z.boolean(),
    summary: z.string().min(1),
    stats: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type RunMaintenanceJobResult = z.infer<typeof RunMaintenanceJobResultSchema>;

export const RunMaintenanceResponsePayloadSchema = z
  .object({
    accepted_priority: MaintenancePrioritySchema,
    scope: RunMaintenanceRequestPayloadSchema.shape.scope.unwrap().nullable(),
    jobs: z.array(RunMaintenanceJobResultSchema),
    stream_id: z.string().min(1).nullable(),
  })
  .strict();
export type RunMaintenanceResponsePayload = z.infer<typeof RunMaintenanceResponsePayloadSchema>;

export const ToolRegistrationSchema = z
  .object({
    tool_name: z.string().min(1),
    tool_kind: z.enum(["filesystem", "shell", "browser", "mcp", "function"]),
  })
  .strict();
export type ToolRegistration = z.infer<typeof ToolRegistrationSchema>;

export const CredentialModeSchema = z.enum(["brokered", "delegated", "direct", "none", "unknown"]);
export const VisibilityScopeSchema = z.enum(["user", "model", "internal", "sensitive_internal"]);
export type VisibilityScope = z.infer<typeof VisibilityScopeSchema>;

export const EnvironmentContextSchema = z
  .object({
    workspace_roots: z.array(z.string().min(1)).min(1),
    cwd: z.string().min(1).optional(),
    credential_mode: CredentialModeSchema.optional(),
  })
  .strict();
export type EnvironmentContext = z.infer<typeof EnvironmentContextSchema>;

export const FrameworkContextSchema = z
  .object({
    agent_name: z.string().min(1).optional(),
    agent_framework: z.string().min(1).optional(),
  })
  .strict();
export type FrameworkContext = z.infer<typeof FrameworkContextSchema>;

export const RawActionAttemptSchema = z
  .object({
    run_id: z.string().min(1),
    tool_registration: ToolRegistrationSchema,
    raw_call: z.record(z.string(), z.unknown()),
    environment_context: EnvironmentContextSchema,
    framework_context: FrameworkContextSchema.optional(),
    trace: TraceContextSchema.optional(),
    received_at: TimestampStringSchema,
  })
  .strict();
export type RawActionAttempt = z.infer<typeof RawActionAttemptSchema>;

export const ProvenanceModeSchema = z.enum(["governed", "observed", "imported", "unknown"]);
export const ActorTypeSchema = z.enum(["agent", "user", "system", "observer"]);
export const SideEffectLevelSchema = z.enum(["read_only", "mutating", "destructive", "unknown"]);
export const ExternalEffectSchema = z.enum(["none", "network", "communication", "financial", "unknown"]);
export const ReversibilityHintSchema = z.enum([
  "reversible",
  "potentially_reversible",
  "compensatable",
  "irreversible",
  "unknown",
]);
export const SensitivityHintSchema = z.enum(["low", "moderate", "high", "unknown"]);
export const ScopeBreadthSchema = z.enum(["single", "set", "workspace", "repository", "origin", "external", "unknown"]);

export const McpServerTransportSchema = z.enum(["stdio", "streamable_http"]);
export type McpServerTransport = z.infer<typeof McpServerTransportSchema>;
export const McpNetworkScopeSchema = z.enum(["loopback", "private", "public_https"]);
export type McpNetworkScope = z.infer<typeof McpNetworkScopeSchema>;

export const McpToolPolicySchema = z
  .object({
    tool_name: z.string().min(1),
    side_effect_level: SideEffectLevelSchema,
    approval_mode: z.enum(["allow", "ask"]).optional(),
  })
  .strict();
export type McpToolPolicy = z.infer<typeof McpToolPolicySchema>;

export const McpStreamableHttpAuthSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("none"),
    })
    .strict(),
  z
    .object({
      type: z.literal("bearer_env"),
      bearer_env_var: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("bearer_secret_ref"),
      secret_id: z.string().min(1),
    })
    .strict(),
]);
export type McpStreamableHttpAuth = z.infer<typeof McpStreamableHttpAuthSchema>;

export const McpServerDefinitionSchema = z
  .discriminatedUnion("transport", [
    z
      .object({
        server_id: z.string().min(1),
        display_name: z.string().min(1).optional(),
        transport: z.literal("stdio"),
        command: z.string().min(1),
        args: z.array(z.string().min(1)).optional(),
        cwd: z.string().min(1).optional(),
        env: z.record(z.string(), z.string()).optional(),
        timeout_ms: z.number().int().positive().optional(),
        tools: z.array(McpToolPolicySchema).min(1),
      })
      .strict(),
    z
      .object({
        server_id: z.string().min(1),
        display_name: z.string().min(1).optional(),
        transport: z.literal("streamable_http"),
        url: z.string().url(),
        headers: z.record(z.string(), z.string()).optional(),
        network_scope: McpNetworkScopeSchema.optional(),
        max_concurrent_calls: z.number().int().positive().optional(),
        auth: McpStreamableHttpAuthSchema.optional(),
        timeout_ms: z.number().int().positive().optional(),
        tools: z.array(McpToolPolicySchema).min(1),
      })
      .strict(),
  ]);
export type McpServerDefinition = z.infer<typeof McpServerDefinitionSchema>;

export const McpServerRegistrationRecordSchema = z
  .object({
    server: McpServerDefinitionSchema,
    source: McpRegistrySourceSchema,
    created_at: TimestampStringSchema,
    updated_at: TimestampStringSchema,
  })
  .strict();
export type McpServerRegistrationRecord = z.infer<typeof McpServerRegistrationRecordSchema>;

export const ListMcpServersRequestPayloadSchema = z.object({}).strict();
export type ListMcpServersRequestPayload = z.infer<typeof ListMcpServersRequestPayloadSchema>;

export const ListMcpServersResponsePayloadSchema = z
  .object({
    servers: z.array(McpServerRegistrationRecordSchema),
  })
  .strict();
export type ListMcpServersResponsePayload = z.infer<typeof ListMcpServersResponsePayloadSchema>;

export const UpsertMcpServerRequestPayloadSchema = z
  .object({
    server: McpServerDefinitionSchema,
  })
  .strict();
export type UpsertMcpServerRequestPayload = z.infer<typeof UpsertMcpServerRequestPayloadSchema>;

export const UpsertMcpServerResponsePayloadSchema = z
  .object({
    server: McpServerRegistrationRecordSchema,
    created: z.boolean(),
  })
  .strict();
export type UpsertMcpServerResponsePayload = z.infer<typeof UpsertMcpServerResponsePayloadSchema>;

export const RemoveMcpServerRequestPayloadSchema = z
  .object({
    server_id: z.string().min(1),
  })
  .strict();
export type RemoveMcpServerRequestPayload = z.infer<typeof RemoveMcpServerRequestPayloadSchema>;

export const RemoveMcpServerResponsePayloadSchema = z
  .object({
    removed: z.boolean(),
    removed_server: McpServerRegistrationRecordSchema.nullable(),
  })
  .strict();
export type RemoveMcpServerResponsePayload = z.infer<typeof RemoveMcpServerResponsePayloadSchema>;

export const McpSecretInputSchema = z
  .object({
    secret_id: z.string().min(1),
    display_name: z.string().min(1).optional(),
    bearer_token: z.string().min(1),
  })
  .strict();
export type McpSecretInput = z.infer<typeof McpSecretInputSchema>;

export const McpSecretMetadataSchema = z
  .object({
    secret_id: z.string().min(1),
    display_name: z.string().min(1).nullable(),
    auth_type: z.literal("bearer"),
    status: z.literal("active"),
    version: z.number().int().positive(),
    created_at: TimestampStringSchema,
    updated_at: TimestampStringSchema,
    rotated_at: TimestampStringSchema.nullable(),
    last_used_at: TimestampStringSchema.nullable(),
    source: z.literal("operator_api"),
  })
  .strict();
export type McpSecretMetadata = z.infer<typeof McpSecretMetadataSchema>;

export const ListMcpSecretsRequestPayloadSchema = z.object({}).strict();
export type ListMcpSecretsRequestPayload = z.infer<typeof ListMcpSecretsRequestPayloadSchema>;

export const ListMcpSecretsResponsePayloadSchema = z
  .object({
    secrets: z.array(McpSecretMetadataSchema),
  })
  .strict();
export type ListMcpSecretsResponsePayload = z.infer<typeof ListMcpSecretsResponsePayloadSchema>;

export const UpsertMcpSecretRequestPayloadSchema = z
  .object({
    secret: McpSecretInputSchema,
  })
  .strict();
export type UpsertMcpSecretRequestPayload = z.infer<typeof UpsertMcpSecretRequestPayloadSchema>;

export const UpsertMcpSecretResponsePayloadSchema = z
  .object({
    secret: McpSecretMetadataSchema,
    created: z.boolean(),
    rotated: z.boolean(),
  })
  .strict();
export type UpsertMcpSecretResponsePayload = z.infer<typeof UpsertMcpSecretResponsePayloadSchema>;

export const RemoveMcpSecretRequestPayloadSchema = z
  .object({
    secret_id: z.string().min(1),
  })
  .strict();
export type RemoveMcpSecretRequestPayload = z.infer<typeof RemoveMcpSecretRequestPayloadSchema>;

export const RemoveMcpSecretResponsePayloadSchema = z
  .object({
    removed: z.boolean(),
    removed_secret: McpSecretMetadataSchema.nullable(),
  })
  .strict();
export type RemoveMcpSecretResponsePayload = z.infer<typeof RemoveMcpSecretResponsePayloadSchema>;

export const McpPublicHostPolicySchema = z
  .object({
    host: z.string().min(1),
    display_name: z.string().min(1).optional(),
    allow_subdomains: z.boolean().optional(),
    allowed_ports: z.array(z.number().int().positive().max(65_535)).min(1).optional(),
  })
  .strict();
export type McpPublicHostPolicy = z.infer<typeof McpPublicHostPolicySchema>;

export const McpPublicHostPolicyRecordSchema = z
  .object({
    policy: McpPublicHostPolicySchema,
    source: z.literal("operator_api"),
    created_at: TimestampStringSchema,
    updated_at: TimestampStringSchema,
  })
  .strict();
export type McpPublicHostPolicyRecord = z.infer<typeof McpPublicHostPolicyRecordSchema>;

export const ListMcpHostPoliciesRequestPayloadSchema = z.object({}).strict();
export type ListMcpHostPoliciesRequestPayload = z.infer<typeof ListMcpHostPoliciesRequestPayloadSchema>;

export const ListMcpHostPoliciesResponsePayloadSchema = z
  .object({
    policies: z.array(McpPublicHostPolicyRecordSchema),
  })
  .strict();
export type ListMcpHostPoliciesResponsePayload = z.infer<typeof ListMcpHostPoliciesResponsePayloadSchema>;

export const UpsertMcpHostPolicyRequestPayloadSchema = z
  .object({
    policy: McpPublicHostPolicySchema,
  })
  .strict();
export type UpsertMcpHostPolicyRequestPayload = z.infer<typeof UpsertMcpHostPolicyRequestPayloadSchema>;

export const UpsertMcpHostPolicyResponsePayloadSchema = z
  .object({
    policy: McpPublicHostPolicyRecordSchema,
    created: z.boolean(),
  })
  .strict();
export type UpsertMcpHostPolicyResponsePayload = z.infer<typeof UpsertMcpHostPolicyResponsePayloadSchema>;

export const RemoveMcpHostPolicyRequestPayloadSchema = z
  .object({
    host: z.string().min(1),
  })
  .strict();
export type RemoveMcpHostPolicyRequestPayload = z.infer<typeof RemoveMcpHostPolicyRequestPayloadSchema>;

export const RemoveMcpHostPolicyResponsePayloadSchema = z
  .object({
    removed: z.boolean(),
    removed_policy: McpPublicHostPolicyRecordSchema.nullable(),
  })
  .strict();
export type RemoveMcpHostPolicyResponsePayload = z.infer<typeof RemoveMcpHostPolicyResponsePayloadSchema>;

export const ActionRecordSchema = z
  .object({
    schema_version: z.literal("action.v1"),
    action_id: z.string().min(1),
    run_id: z.string().min(1),
    session_id: z.string().min(1),
    status: z.literal("normalized"),
    timestamps: z
      .object({
        requested_at: TimestampStringSchema,
        normalized_at: TimestampStringSchema,
      })
      .strict(),
    provenance: z
      .object({
        mode: ProvenanceModeSchema,
        source: z.string().min(1),
        confidence: z.number().min(0).max(1),
      })
      .strict(),
    actor: z
      .object({
        type: ActorTypeSchema,
        agent_name: z.string().min(1).optional(),
        agent_framework: z.string().min(1).optional(),
        tool_name: z.string().min(1),
        tool_kind: z.string().min(1),
      })
      .strict(),
    operation: z
      .object({
        domain: z.string().min(1),
        kind: z.string().min(1),
        name: z.string().min(1),
        display_name: z.string().min(1).optional(),
      })
      .strict(),
    execution_path: z
      .object({
        surface: z.enum([
          "sdk_function",
          "governed_shell",
          "governed_fs",
          "mcp_proxy",
          "provider_hosted",
          "observer",
        ]),
        mode: z.enum(["pre_execution", "post_hoc", "imported"]),
        credential_mode: CredentialModeSchema,
      })
      .strict(),
    target: z
      .object({
        primary: z
          .object({
            type: z.string().min(1),
            locator: z.string().min(1),
            label: z.string().min(1).optional(),
          })
          .strict(),
        scope: z
          .object({
            breadth: ScopeBreadthSchema,
            estimated_count: z.number().int().nonnegative().optional(),
            unknowns: z.array(z.string().min(1)),
          })
          .strict(),
      })
      .strict(),
    input: z
      .object({
        raw: z.record(z.string(), z.unknown()),
        redacted: z.record(z.string(), z.unknown()),
        schema_ref: z.string().min(1).nullable(),
        contains_sensitive_data: z.boolean(),
      })
      .strict(),
    risk_hints: z
      .object({
        side_effect_level: SideEffectLevelSchema,
        external_effects: ExternalEffectSchema,
        reversibility_hint: ReversibilityHintSchema,
        sensitivity_hint: SensitivityHintSchema,
        batch: z.boolean(),
      })
      .strict(),
    facets: z.record(z.string(), z.unknown()),
    normalization: z
      .object({
        mapper: z.string().min(1),
        inferred_fields: z.array(z.string().min(1)),
        warnings: z.array(z.string().min(1)),
        normalization_confidence: z.number().min(0).max(1),
      })
      .strict(),
  })
  .strict();
export type ActionRecord = z.infer<typeof ActionRecordSchema>;

export const PolicyDecisionSchema = z.enum(["allow", "deny", "ask", "simulate", "allow_with_snapshot"]);
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export const PolicyReasonSchema = z
  .object({
    code: z.string().min(1),
    severity: z.enum(["low", "moderate", "high", "critical"]),
    message: z.string().min(1),
  })
  .strict();
export type PolicyReason = z.infer<typeof PolicyReasonSchema>;

export const PolicyOutcomeRecordSchema = z
  .object({
    schema_version: z.literal("policy-outcome.v1"),
    policy_outcome_id: z.string().min(1),
    action_id: z.string().min(1),
    decision: PolicyDecisionSchema,
    reasons: z.array(PolicyReasonSchema),
    trust_requirements: z
      .object({
        wrapped_path_required: z.boolean(),
        brokered_credentials_required: z.boolean(),
        direct_credentials_forbidden: z.boolean(),
      })
      .strict(),
    preconditions: z
      .object({
        snapshot_required: z.boolean(),
        approval_required: z.boolean(),
        simulation_supported: z.boolean(),
      })
      .strict(),
    approval: z.null(),
    budget_effects: z
      .object({
        budget_check: z.enum(["passed", "soft_limit", "hard_limit", "unknown"]),
        estimated_cost: z.number().nonnegative().nullable(),
        remaining_mutating_actions: z.number().int().nonnegative().nullable().optional(),
        remaining_destructive_actions: z.number().int().nonnegative().nullable().optional(),
      })
      .strict(),
    policy_context: z
      .object({
        matched_rules: z.array(z.string().min(1)),
        sticky_decision_applied: z.boolean(),
      })
      .strict(),
    evaluated_at: TimestampStringSchema,
  })
  .strict();
export type PolicyOutcomeRecord = z.infer<typeof PolicyOutcomeRecordSchema>;

export const ExecutionArtifactSchema = z
  .object({
    artifact_id: z.string().min(1),
    type: z.enum(["diff", "stdout", "stderr", "screenshot", "request_response", "file_content"]),
    content_ref: z.string().min(1),
    byte_size: z.number().int().nonnegative(),
    visibility: VisibilityScopeSchema,
  })
  .strict();
export type ExecutionArtifact = z.infer<typeof ExecutionArtifactSchema>;

export const StoredArtifactRecordSchema = ExecutionArtifactSchema.extend({
  run_id: z.string().min(1),
  action_id: z.string().min(1),
  execution_id: z.string().min(1),
  integrity: z
    .object({
      schema_version: z.literal("artifact-integrity.v1"),
      digest_algorithm: z.literal("sha256"),
      digest: z.string().min(1).nullable(),
    })
    .strict(),
  created_at: TimestampStringSchema,
  expires_at: TimestampStringSchema.nullable(),
  expired_at: TimestampStringSchema.nullable(),
})
  .strict();
export type StoredArtifactRecord = z.infer<typeof StoredArtifactRecordSchema>;

export const ArtifactAvailabilitySchema = z.enum(["available", "missing", "expired", "corrupted", "tampered"]);
export type ArtifactAvailability = z.infer<typeof ArtifactAvailabilitySchema>;

export const ExecutionResultSchema = z
  .object({
    execution_id: z.string().min(1),
    action_id: z.string().min(1),
    mode: z.enum(["executed", "simulated"]),
    success: z.boolean(),
    output: z.record(z.string(), z.unknown()),
    artifacts: z.array(ExecutionArtifactSchema),
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
        partial_effects: z.boolean(),
      })
      .strict()
      .optional(),
    artifact_capture: z
      .object({
        requested_count: z.number().int().nonnegative(),
        stored_count: z.number().int().nonnegative(),
        degraded: z.boolean(),
        failures: z.array(
          z
            .object({
              artifact_id: z.string().min(1),
              type: z.string().min(1),
              code: ErrorCodeSchema,
              retryable: z.boolean(),
              low_disk_pressure: z.boolean(),
            })
            .strict(),
        ),
      })
      .strict()
      .optional(),
    started_at: TimestampStringSchema,
    completed_at: TimestampStringSchema,
  })
  .strict();
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

export const QueryArtifactRequestPayloadSchema = z
  .object({
    artifact_id: z.string().min(1),
    visibility_scope: VisibilityScopeSchema.optional(),
    full_content: z.boolean().optional(),
  })
  .strict();
export type QueryArtifactRequestPayload = z.infer<typeof QueryArtifactRequestPayloadSchema>;

export const QueryArtifactResponsePayloadSchema = z
  .object({
    artifact: StoredArtifactRecordSchema,
    artifact_status: ArtifactAvailabilitySchema,
    visibility_scope: VisibilityScopeSchema,
    content_available: z.boolean(),
    content: z.string(),
    content_truncated: z.boolean(),
    returned_chars: z.number().int().nonnegative(),
    max_inline_chars: z.number().int().positive(),
  })
  .strict();
export type QueryArtifactResponsePayload = z.infer<typeof QueryArtifactResponsePayloadSchema>;

export const SnapshotClassSchema = z.enum([
  "metadata_only",
  "journal_only",
  "journal_plus_anchor",
  "exact_anchor",
]);
export type SnapshotClass = z.infer<typeof SnapshotClassSchema>;

export const SnapshotFidelitySchema = z.enum(["full", "partial", "metadata_only", "none"]);
export type SnapshotFidelity = z.infer<typeof SnapshotFidelitySchema>;

export const SnapshotRecordSchema = z
  .object({
    snapshot_id: z.string().min(1),
    action_id: z.string().min(1),
    snapshot_class: SnapshotClassSchema,
    fidelity: SnapshotFidelitySchema,
    scope_paths: z.array(z.string().min(1)),
    storage_bytes: z.number().int().nonnegative(),
    created_at: TimestampStringSchema,
  })
  .strict();
export type SnapshotRecord = z.infer<typeof SnapshotRecordSchema>;

export const SubmitActionAttemptRequestPayloadSchema = z
  .object({
    attempt: RawActionAttemptSchema,
  })
  .strict();
export type SubmitActionAttemptRequestPayload = z.infer<typeof SubmitActionAttemptRequestPayloadSchema>;

export const SubmitActionAttemptResponsePayloadSchema = z
  .object({
    action: ActionRecordSchema,
    policy_outcome: PolicyOutcomeRecordSchema,
    execution_result: ExecutionResultSchema.nullable().optional(),
    snapshot_record: SnapshotRecordSchema.nullable().optional(),
    approval_request: z.lazy(() => ApprovalRequestSchema).nullable().optional(),
  })
  .strict();
export type SubmitActionAttemptResponsePayload = z.infer<typeof SubmitActionAttemptResponsePayloadSchema>;

export const ApprovalRequestSchema = z
  .object({
    approval_id: z.string().min(1),
    run_id: z.string().min(1),
    action_id: z.string().min(1),
    status: z.enum(["pending", "approved", "denied"]),
    requested_at: TimestampStringSchema,
    resolved_at: TimestampStringSchema.nullable(),
    resolution_note: z.string().min(1).nullable(),
    decision_requested: z.literal("approve_or_deny"),
    action_summary: z.string().min(1),
    primary_reason: ReasonDetailSchema.nullable().optional(),
  })
  .strict();
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ListApprovalsRequestPayloadSchema = z
  .object({
    run_id: z.string().min(1).optional(),
    status: z.enum(["pending", "approved", "denied"]).optional(),
  })
  .strict();
export type ListApprovalsRequestPayload = z.infer<typeof ListApprovalsRequestPayloadSchema>;

export const ListApprovalsResponsePayloadSchema = z
  .object({
    approvals: z.array(ApprovalRequestSchema),
  })
  .strict();
export type ListApprovalsResponsePayload = z.infer<typeof ListApprovalsResponsePayloadSchema>;

export const ApprovalInboxItemSchema = z
  .object({
    approval_id: z.string().min(1),
    run_id: z.string().min(1),
    workflow_name: z.string().min(1),
    action_id: z.string().min(1),
    action_summary: z.string().min(1),
    action_domain: z.string().min(1),
    side_effect_level: SideEffectLevelSchema,
    status: z.enum(["pending", "approved", "denied"]),
    requested_at: TimestampStringSchema,
    resolved_at: TimestampStringSchema.nullable(),
    resolution_note: z.string().min(1).nullable(),
    decision_requested: z.literal("approve_or_deny"),
    snapshot_required: z.boolean(),
    reason_summary: z.string().min(1).nullable(),
    primary_reason: ReasonDetailSchema.nullable().optional(),
    target_locator: z.string().min(1),
    target_label: z.string().min(1).nullable(),
  })
  .strict();
export type ApprovalInboxItem = z.infer<typeof ApprovalInboxItemSchema>;

export const QueryApprovalInboxRequestPayloadSchema = z
  .object({
    run_id: z.string().min(1).optional(),
    status: z.enum(["pending", "approved", "denied"]).optional(),
  })
  .strict();
export type QueryApprovalInboxRequestPayload = z.infer<typeof QueryApprovalInboxRequestPayloadSchema>;

export const QueryApprovalInboxResponsePayloadSchema = z
  .object({
    items: z.array(ApprovalInboxItemSchema),
    counts: z
      .object({
        pending: z.number().int().nonnegative(),
        approved: z.number().int().nonnegative(),
        denied: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type QueryApprovalInboxResponsePayload = z.infer<typeof QueryApprovalInboxResponsePayloadSchema>;

export const ResolveApprovalRequestPayloadSchema = z
  .object({
    approval_id: z.string().min(1),
    resolution: z.enum(["approved", "denied"]),
    note: z.string().min(1).optional(),
  })
  .strict();
export type ResolveApprovalRequestPayload = z.infer<typeof ResolveApprovalRequestPayloadSchema>;

export const ResolveApprovalResponsePayloadSchema = z
  .object({
    approval_request: ApprovalRequestSchema,
    execution_result: ExecutionResultSchema.nullable().optional(),
    snapshot_record: SnapshotRecordSchema.nullable().optional(),
  })
  .strict();
export type ResolveApprovalResponsePayload = z.infer<typeof ResolveApprovalResponsePayloadSchema>;

export const RecoveryTargetSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("snapshot_id"),
      snapshot_id: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("action_boundary"),
      action_id: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("external_object"),
      external_object_id: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("run_checkpoint"),
      run_checkpoint: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("branch_point"),
      run_id: z.string().min(1),
      sequence: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      type: z.literal("path_subset"),
      snapshot_id: z.string().min(1),
      paths: z.array(z.string().min(1)).min(1),
    })
    .strict(),
]);
export type RecoveryTarget = z.infer<typeof RecoveryTargetSchema>;

export const RecoveryClassSchema = z.enum([
  "reversible",
  "compensatable",
  "review_only",
  "irreversible",
]);
export type RecoveryClass = z.infer<typeof RecoveryClassSchema>;

export const RecoveryPlanStepSchema = z
  .object({
    step_id: z.string().min(1),
    type: z.string().min(1),
    idempotent: z.boolean(),
    depends_on: z.array(z.string().min(1)),
  })
  .strict();
export type RecoveryPlanStep = z.infer<typeof RecoveryPlanStepSchema>;

export const RecoveryReviewGuidanceSchema = z
  .object({
    systems_touched: z.array(z.string().min(1)),
    objects_touched: z.array(z.string().min(1)),
    manual_steps: z.array(z.string().min(1)),
    uncertainty: z.array(z.string().min(1)),
  })
  .strict();
export type RecoveryReviewGuidance = z.infer<typeof RecoveryReviewGuidanceSchema>;

export const RecoveryDowngradeReasonSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();
export type RecoveryDowngradeReason = z.infer<typeof RecoveryDowngradeReasonSchema>;

export const RecoveryPlanSchema = z
  .object({
    schema_version: z.literal("recovery-plan.v1"),
    recovery_plan_id: z.string().min(1),
    target: RecoveryTargetSchema,
    recovery_class: RecoveryClassSchema,
    strategy: z.string().min(1),
    confidence: z.number().min(0).max(1),
    steps: z.array(RecoveryPlanStepSchema),
    impact_preview: z
      .object({
        paths_to_change: z.number().int().nonnegative().optional(),
        later_actions_affected: z.number().int().nonnegative(),
        overlapping_paths: z.array(z.string().min(1)),
        external_effects: z.array(z.string().min(1)),
        data_loss_risk: z.enum(["low", "moderate", "high", "unknown"]),
      })
      .strict(),
    warnings: z.array(
      z
        .object({
          code: z.string().min(1),
          message: z.string().min(1),
        })
        .strict(),
    ),
    downgrade_reason: RecoveryDowngradeReasonSchema.optional(),
    review_guidance: RecoveryReviewGuidanceSchema.optional(),
    created_at: TimestampStringSchema,
  })
  .strict();
export type RecoveryPlan = z.infer<typeof RecoveryPlanSchema>;

export const PlanRecoveryRequestPayloadSchema = z
  .object({
    snapshot_id: z.string().min(1).optional(),
    target: RecoveryTargetSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.target && !value.snapshot_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Either target or snapshot_id is required.",
        path: ["target"],
      });
    }

    if (value.target && value.snapshot_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide either target or snapshot_id, not both.",
        path: ["target"],
      });
    }
  })
  .strict();
export type PlanRecoveryRequestPayload = z.infer<typeof PlanRecoveryRequestPayloadSchema>;

export const PlanRecoveryResponsePayloadSchema = z
  .object({
    recovery_plan: RecoveryPlanSchema,
  })
  .strict();
export type PlanRecoveryResponsePayload = z.infer<typeof PlanRecoveryResponsePayloadSchema>;

export const ExecuteRecoveryRequestPayloadSchema = z
  .object({
    snapshot_id: z.string().min(1).optional(),
    target: RecoveryTargetSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.target && !value.snapshot_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Either target or snapshot_id is required.",
        path: ["target"],
      });
    }

    if (value.target && value.snapshot_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide either target or snapshot_id, not both.",
        path: ["target"],
      });
    }
  })
  .strict();
export type ExecuteRecoveryRequestPayload = z.infer<typeof ExecuteRecoveryRequestPayloadSchema>;

export const ExecuteRecoveryResponsePayloadSchema = z
  .object({
    recovery_plan: RecoveryPlanSchema,
    restored: z.boolean(),
    outcome: z.enum(["restored", "compensated"]),
    executed_at: TimestampStringSchema,
  })
  .strict();
export type ExecuteRecoveryResponsePayload = z.infer<typeof ExecuteRecoveryResponsePayloadSchema>;

export const TimelineStepSchema = z
  .object({
    schema_version: z.literal("timeline-step.v1"),
    step_id: z.string().min(1),
    run_id: z.string().min(1),
    sequence: z.number().int().positive(),
    step_type: z.enum([
      "action_step",
      "approval_step",
      "recovery_step",
      "analysis_step",
      "system_step",
    ]),
    title: z.string().min(1),
    status: z.enum([
      "completed",
      "failed",
      "partial",
      "blocked",
      "awaiting_approval",
      "cancelled",
    ]),
    provenance: z.enum(["governed", "observed", "imported", "unknown"]),
    action_id: z.string().min(1).nullable(),
    decision: PolicyDecisionSchema.nullable(),
    primary_reason: ReasonDetailSchema.nullable().optional(),
    reversibility_class: RecoveryClassSchema.nullable(),
    confidence: z.number().min(0).max(1),
    summary: z.string().min(1),
    warnings: z.array(z.string().min(1)).optional(),
    primary_artifacts: z.array(
      z
        .object({
          artifact_id: z.string().min(1).optional(),
          artifact_status: ArtifactAvailabilitySchema.optional(),
          integrity: z
            .object({
              schema_version: z.literal("artifact-integrity.v1"),
              digest_algorithm: z.literal("sha256"),
              digest: z.string().min(1).nullable(),
            })
            .strict()
            .optional(),
          type: z.string().min(1),
          count: z.number().int().nonnegative().optional(),
          label: z.string().min(1).optional(),
        })
        .strict(),
    ),
    artifact_previews: z.array(
      z
        .object({
          type: z.string().min(1),
          label: z.string().min(1).optional(),
          preview: z.string().min(1),
        })
        .strict(),
    ),
    external_effects: z.array(ExternalEffectSchema),
    related: z
      .object({
        snapshot_id: z.string().min(1).nullable().optional(),
        execution_id: z.string().min(1).nullable().optional(),
        recovery_plan_ids: z.array(z.string().min(1)).optional(),
        target_locator: z.string().min(1).nullable().optional(),
        recovery_target_type: z
          .enum([
            "snapshot_id",
            "action_boundary",
            "external_object",
            "run_checkpoint",
            "branch_point",
            "path_subset",
          ])
          .nullable()
          .optional(),
        recovery_target_label: z.string().min(1).nullable().optional(),
        recovery_scope_paths: z.array(z.string().min(1)).optional(),
        recovery_strategy: z.string().min(1).nullable().optional(),
        recovery_downgrade_reason: RecoveryDowngradeReasonSchema.nullable().optional(),
        later_actions_affected: z.number().int().nonnegative().nullable().optional(),
        overlapping_paths: z.array(z.string().min(1)).optional(),
        data_loss_risk: z.enum(["low", "moderate", "high", "unknown"]).nullable().optional(),
      })
      .strict(),
    occurred_at: TimestampStringSchema,
  })
  .strict();
export type TimelineStep = z.infer<typeof TimelineStepSchema>;

export const PreviewBudgetSummarySchema = z
  .object({
    max_inline_preview_chars: z.number().int().positive(),
    max_total_inline_preview_chars: z.number().int().positive(),
    preview_chars_used: z.number().int().nonnegative(),
    truncated_previews: z.number().int().nonnegative(),
    omitted_previews: z.number().int().nonnegative(),
  })
  .strict();
export type PreviewBudgetSummary = z.infer<typeof PreviewBudgetSummarySchema>;

export const QueryTimelineRequestPayloadSchema = z
  .object({
    run_id: z.string().min(1),
    visibility_scope: VisibilityScopeSchema.optional(),
  })
  .strict();
export type QueryTimelineRequestPayload = z.infer<typeof QueryTimelineRequestPayloadSchema>;

export const QueryTimelineResponsePayloadSchema = z
  .object({
    run_summary: RunSummarySchema,
    steps: z.array(TimelineStepSchema),
    projection_status: z.enum(["fresh", "rebuilt"]),
    visibility_scope: VisibilityScopeSchema,
    redactions_applied: z.number().int().nonnegative(),
    preview_budget: PreviewBudgetSummarySchema,
  })
  .strict();
export type QueryTimelineResponsePayload = z.infer<typeof QueryTimelineResponsePayloadSchema>;

export const HelperQuestionTypeSchema = z.enum([
  "run_summary",
  "what_happened",
  "summarize_after_boundary",
  "step_details",
  "explain_policy_decision",
  "reversible_steps",
  "why_blocked",
  "likely_cause",
  "suggest_likely_cause",
  "what_changed_after_step",
  "revert_impact",
  "preview_revert_loss",
  "what_would_i_lose_if_i_revert_here",
  "external_side_effects",
  "identify_external_effects",
  "list_actions_touching_scope",
  "compare_steps",
]);
export type HelperQuestionType = z.infer<typeof HelperQuestionTypeSchema>;

export const QueryHelperRequestPayloadSchema = z
  .object({
    run_id: z.string().min(1),
    question_type: HelperQuestionTypeSchema,
    focus_step_id: z.string().min(1).optional(),
    compare_step_id: z.string().min(1).optional(),
    visibility_scope: VisibilityScopeSchema.optional(),
  })
  .strict();
export type QueryHelperRequestPayload = z.infer<typeof QueryHelperRequestPayloadSchema>;

export const QueryHelperResponsePayloadSchema = z
  .object({
    answer: z.string().min(1),
    confidence: z.number().min(0).max(1),
    primary_reason: ReasonDetailSchema.nullable().optional(),
    visibility_scope: VisibilityScopeSchema,
    redactions_applied: z.number().int().nonnegative(),
    preview_budget: PreviewBudgetSummarySchema,
    evidence: z.array(
      z
        .object({
          step_id: z.string().min(1),
          sequence: z.number().int().positive(),
          title: z.string().min(1),
        })
        .strict(),
    ),
    uncertainty: z.array(z.string().min(1)),
  })
  .strict();
export type QueryHelperResponsePayload = z.infer<typeof QueryHelperResponsePayloadSchema>;

export class AgentGitError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorEnvelope["code"],
    public readonly details?: Record<string, unknown>,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "AgentGitError";
  }

  toErrorEnvelope(): ErrorEnvelope {
    return {
      code: this.code,
      error_class: this.name,
      message: this.message,
      details: this.details,
      retryable: this.retryable,
    };
  }
}

export class ValidationError extends AgentGitError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "VALIDATION_FAILED", details, false);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends AgentGitError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "NOT_FOUND", details, false);
    this.name = "NotFoundError";
  }
}

export class PreconditionError extends AgentGitError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "PRECONDITION_FAILED", details, false);
    this.name = "PreconditionError";
  }
}

export class InternalError extends AgentGitError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "INTERNAL_ERROR", details, false);
    this.name = "InternalError";
  }
}

export function formatZodIssues(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

export function validate<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ValidationError("Request payload validation failed.", {
      issues: formatZodIssues(result.error),
    });
  }
  return result.data;
}

export function isResponseEnvelope(value: unknown): value is ResponseEnvelope<unknown> {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    candidate.api_version === API_VERSION &&
    typeof candidate.request_id === "string" &&
    typeof candidate.ok === "boolean" &&
    "result" in candidate &&
    "error" in candidate
  );
}
