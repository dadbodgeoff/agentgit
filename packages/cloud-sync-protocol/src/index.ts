import { ApprovalInboxItemSchema, TimestampStringSchema } from "@agentgit/schemas";
import { z } from "zod";

export const SyncSchemaVersionSchema = z.literal("cloud-sync.v1");
export type SyncSchemaVersion = z.infer<typeof SyncSchemaVersionSchema>;

export const ConnectorStatusSchema = z.enum(["active", "stale", "revoked"]);
export type ConnectorStatus = z.infer<typeof ConnectorStatusSchema>;

export const CloudProviderSchema = z.enum(["github", "gitlab", "bitbucket", "local"]);
export type CloudProvider = z.infer<typeof CloudProviderSchema>;

export const ConnectorCapabilitySchema = z.enum([
  "repo_state_sync",
  "run_event_sync",
  "snapshot_manifest_sync",
  "approval_resolution",
  "restore_execution",
  "git_commit",
  "git_push",
  "pull_request_open",
]);
export type ConnectorCapability = z.infer<typeof ConnectorCapabilitySchema>;

export const ConnectorPlatformSchema = z
  .object({
    os: z.string().min(1),
    arch: z.string().min(1),
    hostname: z.string().min(1),
  })
  .strict();
export type ConnectorPlatform = z.infer<typeof ConnectorPlatformSchema>;

export const RepositoryRefSchema = z
  .object({
    owner: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();
export type RepositoryRef = z.infer<typeof RepositoryRefSchema>;

export const RepositoryStateSnapshotSchema = z
  .object({
    provider: CloudProviderSchema,
    repo: RepositoryRefSchema,
    remoteUrl: z.string().min(1).nullable(),
    defaultBranch: z.string().min(1),
    currentBranch: z.string().min(1),
    headSha: z.string().min(7),
    isDirty: z.boolean(),
    aheadBy: z.number().int().nonnegative(),
    behindBy: z.number().int().nonnegative(),
    workspaceRoot: z.string().min(1),
    lastFetchedAt: TimestampStringSchema.nullable().optional(),
  })
  .strict();
export type RepositoryStateSnapshot = z.infer<typeof RepositoryStateSnapshotSchema>;

export const ProviderVisibilitySchema = z.enum(["public", "private", "internal", "unknown"]);
export type ProviderVisibility = z.infer<typeof ProviderVisibilitySchema>;

export const ProviderIdentityStatusSchema = z.enum(["verified", "local_only", "drifted", "unreachable"]);
export type ProviderIdentityStatus = z.infer<typeof ProviderIdentityStatusSchema>;

export const ProviderRepositoryIdentitySchema = z
  .object({
    provider: CloudProviderSchema,
    status: ProviderIdentityStatusSchema,
    owner: z.string().min(1),
    name: z.string().min(1),
    defaultBranch: z.string().min(1),
    repositoryUrl: z.string().url().nullable(),
    visibility: ProviderVisibilitySchema,
    externalId: z.string().min(1).nullable(),
    verifiedAt: TimestampStringSchema.nullable(),
    statusReason: z.string().min(1).nullable(),
  })
  .strict();
export type ProviderRepositoryIdentity = z.infer<typeof ProviderRepositoryIdentitySchema>;

export const ConnectorRecordSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    workspaceSlug: z.string().min(1),
    connectorName: z.string().min(1),
    machineName: z.string().min(1),
    connectorVersion: z.string().min(1),
    platform: ConnectorPlatformSchema,
    capabilities: z.array(ConnectorCapabilitySchema).min(1),
    repository: RepositoryStateSnapshotSchema,
    status: ConnectorStatusSchema,
    registeredAt: TimestampStringSchema,
    lastSeenAt: TimestampStringSchema,
  })
  .strict();
export type ConnectorRecord = z.infer<typeof ConnectorRecordSchema>;

export const ConnectorRegistrationRequestSchema = z
  .object({
    workspaceId: z.string().min(1),
    connectorName: z.string().trim().min(1).max(64),
    machineName: z.string().trim().min(1).max(128),
    connectorVersion: z.string().trim().min(1).max(32),
    platform: ConnectorPlatformSchema,
    capabilities: z.array(ConnectorCapabilitySchema).min(1),
    repository: RepositoryStateSnapshotSchema,
  })
  .strict();
export type ConnectorRegistrationRequest = z.infer<typeof ConnectorRegistrationRequestSchema>;

export const ConnectorRegistrationResponseSchema = z
  .object({
    schemaVersion: SyncSchemaVersionSchema,
    connector: ConnectorRecordSchema,
    accessToken: z.string().min(1),
    issuedAt: TimestampStringSchema,
    expiresAt: TimestampStringSchema,
  })
  .strict();
export type ConnectorRegistrationResponse = z.infer<typeof ConnectorRegistrationResponseSchema>;

export const ConnectorHeartbeatRequestSchema = z
  .object({
    requestId: z.string().trim().min(1).max(128),
    connectorId: z.string().min(1),
    sentAt: TimestampStringSchema,
    repository: RepositoryStateSnapshotSchema,
    localDaemon: z
      .object({
        reachable: z.boolean(),
        socketPath: z.string().min(1).nullable().optional(),
        journalPath: z.string().min(1).nullable().optional(),
        snapshotRootPath: z.string().min(1).nullable().optional(),
      })
      .strict(),
  })
  .strict();
export type ConnectorHeartbeatRequest = z.infer<typeof ConnectorHeartbeatRequestSchema>;
export const ConnectorLocalDaemonStatusSchema = ConnectorHeartbeatRequestSchema.shape.localDaemon;
export type ConnectorLocalDaemonStatus = z.infer<typeof ConnectorLocalDaemonStatusSchema>;

export const ConnectorHeartbeatResponseSchema = z
  .object({
    schemaVersion: SyncSchemaVersionSchema,
    connectorId: z.string().min(1),
    acceptedAt: TimestampStringSchema,
    status: ConnectorStatusSchema,
    pendingCommandCount: z.number().int().nonnegative(),
  })
  .strict();
export type ConnectorHeartbeatResponse = z.infer<typeof ConnectorHeartbeatResponseSchema>;

export const ConnectorEventTypeSchema = z.enum([
  "repo_state.snapshot",
  "run.lifecycle",
  "run.event",
  "snapshot.manifest",
  "approval.requested",
  "approval.resolution",
  "policy.state",
]);
export type ConnectorEventType = z.infer<typeof ConnectorEventTypeSchema>;

export const ApprovalRequestedEventPayloadSchema = ApprovalInboxItemSchema;
export type ApprovalRequestedEventPayload = z.infer<typeof ApprovalRequestedEventPayloadSchema>;

export const ApprovalResolutionEventPayloadSchema = ApprovalInboxItemSchema;
export type ApprovalResolutionEventPayload = z.infer<typeof ApprovalResolutionEventPayloadSchema>;

export const ConnectorEventEnvelopeSchema = z
  .object({
    schemaVersion: SyncSchemaVersionSchema,
    eventId: z.string().min(1),
    connectorId: z.string().min(1),
    workspaceId: z.string().min(1),
    repository: RepositoryRefSchema,
    sequence: z.number().int().positive(),
    occurredAt: TimestampStringSchema,
    type: ConnectorEventTypeSchema,
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ConnectorEventEnvelope = z.infer<typeof ConnectorEventEnvelopeSchema>;

export const ConnectorEventBatchRequestSchema = z
  .object({
    requestId: z.string().trim().min(1).max(128),
    connectorId: z.string().min(1),
    sentAt: TimestampStringSchema,
    events: z.array(ConnectorEventEnvelopeSchema).min(1).max(1000),
  })
  .strict();
export type ConnectorEventBatchRequest = z.infer<typeof ConnectorEventBatchRequestSchema>;

export const ConnectorEventBatchResponseSchema = z
  .object({
    schemaVersion: SyncSchemaVersionSchema,
    connectorId: z.string().min(1),
    acceptedAt: TimestampStringSchema,
    acceptedCount: z.number().int().nonnegative(),
    highestAcceptedSequence: z.number().int().positive(),
  })
  .strict();
export type ConnectorEventBatchResponse = z.infer<typeof ConnectorEventBatchResponseSchema>;

export const ConnectorCommandTypeSchema = z.enum([
  "refresh_repo_state",
  "sync_run_history",
  "replay_run",
  "resolve_approval",
  "execute_restore",
  "create_commit",
  "push_branch",
  "open_pull_request",
]);
export type ConnectorCommandType = z.infer<typeof ConnectorCommandTypeSchema>;

export const ConnectorCommandStatusSchema = z.enum(["pending", "acked", "completed", "failed", "expired"]);
export type ConnectorCommandStatus = z.infer<typeof ConnectorCommandStatusSchema>;

export const RefreshRepoStateCommandPayloadSchema = z
  .object({
    forceFullSync: z.boolean().optional(),
  })
  .strict();
export type RefreshRepoStateCommandPayload = z.infer<typeof RefreshRepoStateCommandPayloadSchema>;

export const SyncRunHistoryCommandPayloadSchema = z
  .object({
    includeSnapshots: z.boolean().optional(),
  })
  .strict();
export type SyncRunHistoryCommandPayload = z.infer<typeof SyncRunHistoryCommandPayloadSchema>;

export const ReplayRunCommandPayloadSchema = z
  .object({
    sourceRunId: z.string().min(1),
    replayWorkflowName: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type ReplayRunCommandPayload = z.infer<typeof ReplayRunCommandPayloadSchema>;

export const ResolveApprovalCommandPayloadSchema = z
  .object({
    approvalId: z.string().min(1),
    resolution: z.enum(["approved", "denied"]),
    note: z.string().trim().max(280).optional(),
  })
  .strict();
export type ResolveApprovalCommandPayload = z.infer<typeof ResolveApprovalCommandPayloadSchema>;

export const CreateCommitCommandPayloadSchema = z
  .object({
    message: z.string().trim().min(1).max(200),
    stageAll: z.boolean(),
    paths: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type CreateCommitCommandPayload = z.infer<typeof CreateCommitCommandPayloadSchema>;

export const PushBranchCommandPayloadSchema = z
  .object({
    branch: z.string().trim().min(1).optional(),
    setUpstream: z.boolean().optional(),
  })
  .strict();
export type PushBranchCommandPayload = z.infer<typeof PushBranchCommandPayloadSchema>;

export const RestoreCommandPayloadSchema = z
  .object({
    snapshotId: z.string().min(1),
  })
  .strict();
export type RestoreCommandPayload = z.infer<typeof RestoreCommandPayloadSchema>;

export const OpenPullRequestCommandPayloadSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().max(20_000).optional(),
    baseBranch: z.string().trim().min(1).optional(),
    headBranch: z.string().trim().min(1).optional(),
    draft: z.boolean().optional(),
  })
  .strict();
export type OpenPullRequestCommandPayload = z.infer<typeof OpenPullRequestCommandPayloadSchema>;

export const ConnectorCommandExecutionResultSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("refresh_repo_state"),
      publishedEventCount: z.number().int().nonnegative().optional(),
      includesSnapshots: z.boolean().optional(),
      syncedAt: TimestampStringSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("sync_run_history"),
      publishedEventCount: z.number().int().nonnegative().optional(),
      includesSnapshots: z.boolean().optional(),
      syncedAt: TimestampStringSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("replay_run"),
      sourceRunId: z.string().min(1),
      replayRunId: z.string().min(1).optional(),
      submittedActionCount: z.number().int().nonnegative(),
      skippedActionCount: z.number().int().nonnegative(),
      pendingApprovalCount: z.number().int().nonnegative(),
      replayedAt: TimestampStringSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("resolve_approval"),
      approvalId: z.string().min(1),
      runId: z.string().min(1).optional(),
      actionId: z.string().min(1).optional(),
      resolution: z.enum(["approved", "denied"]),
      resolvedAt: TimestampStringSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("create_commit"),
      commitSha: z.string().min(7).optional(),
      branch: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("push_branch"),
      branch: z.string().min(1).optional(),
      remoteName: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("execute_restore"),
      snapshotId: z.string().min(1),
      restored: z.boolean().optional(),
      outcome: z.enum(["restored", "compensated"]).optional(),
      runId: z.string().min(1).nullable().optional(),
      actionId: z.string().min(1).nullable().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("open_pull_request"),
      provider: CloudProviderSchema.optional(),
      pullRequestUrl: z.string().url().optional(),
      pullRequestNumber: z.number().int().positive().optional(),
      baseBranch: z.string().min(1),
      headBranch: z.string().min(1),
      draft: z.boolean(),
    })
    .strict(),
]);
export type ConnectorCommandExecutionResult = z.infer<typeof ConnectorCommandExecutionResultSchema>;

export const ConnectorCommandEnvelopeSchema = z
  .object({
    schemaVersion: SyncSchemaVersionSchema,
    commandId: z.string().min(1),
    connectorId: z.string().min(1),
    workspaceId: z.string().min(1),
    repository: RepositoryRefSchema,
    issuedAt: TimestampStringSchema,
    expiresAt: TimestampStringSchema,
    type: ConnectorCommandTypeSchema,
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ConnectorCommandEnvelope = z.infer<typeof ConnectorCommandEnvelopeSchema>;

export const ConnectorCommandPullRequestSchema = z
  .object({
    requestId: z.string().trim().min(1).max(128),
    connectorId: z.string().min(1),
    sentAt: TimestampStringSchema,
  })
  .strict();
export type ConnectorCommandPullRequest = z.infer<typeof ConnectorCommandPullRequestSchema>;

export const ConnectorCommandPullResponseSchema = z
  .object({
    schemaVersion: SyncSchemaVersionSchema,
    connectorId: z.string().min(1),
    commands: z.array(ConnectorCommandEnvelopeSchema),
    acceptedAt: TimestampStringSchema,
  })
  .strict();
export type ConnectorCommandPullResponse = z.infer<typeof ConnectorCommandPullResponseSchema>;

export const ConnectorCommandAckRequestSchema = z
  .object({
    requestId: z.string().trim().min(1).max(128),
    idempotencyKey: z.string().trim().min(1).max(128).optional(),
    connectorId: z.string().min(1),
    commandId: z.string().min(1),
    acknowledgedAt: TimestampStringSchema,
    status: z.enum(["acked", "completed", "failed"]),
    message: z.string().min(1).optional(),
    result: ConnectorCommandExecutionResultSchema.optional(),
  })
  .strict();
export type ConnectorCommandAckRequest = z.infer<typeof ConnectorCommandAckRequestSchema>;

export const ConnectorCommandAckResponseSchema = z
  .object({
    schemaVersion: SyncSchemaVersionSchema,
    connectorId: z.string().min(1),
    commandId: z.string().min(1),
    acceptedAt: TimestampStringSchema,
    status: ConnectorCommandStatusSchema,
  })
  .strict();
export type ConnectorCommandAckResponse = z.infer<typeof ConnectorCommandAckResponseSchema>;
