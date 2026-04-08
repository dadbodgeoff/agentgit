import {
  PolicyConfigSchema,
  PolicyDecisionSchema,
  PolicyLoadedSourceSchema,
  PolicySummarySchema,
  PolicyThresholdRecommendationSchema,
  RecoveryPlanSchema,
  SideEffectLevelSchema,
  TimestampStringSchema,
} from "@agentgit/schemas";
import {
  ConnectorCapabilitySchema,
  ConnectorCommandExecutionResultSchema,
  ConnectorCommandStatusSchema,
  ConnectorCommandTypeSchema,
  ConnectorStatusSchema,
  CloudProviderSchema,
  ProviderIdentityStatusSchema,
  ProviderRepositoryIdentitySchema,
  ProviderVisibilitySchema,
} from "@agentgit/cloud-sync-protocol";
import { z } from "zod";

export const WorkspaceRoleSchema = z.enum(["member", "admin", "owner"]);
export type WorkspaceRole = z.infer<typeof WorkspaceRoleSchema>;

export const ApprovalStatusSchema = z.enum(["pending", "approved", "rejected", "expired"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalResolvedStatusSchema = z.enum(["approved", "rejected", "expired"]);
export type ApprovalResolvedStatus = z.infer<typeof ApprovalResolvedStatusSchema>;

export const ApprovalDomainSchema = z.enum(["shell", "git", "filesystem", "network", "deploy", "policy"]);
export type ApprovalDomain = z.infer<typeof ApprovalDomainSchema>;

export const RunStatusSchema = z.enum(["queued", "running", "completed", "failed", "canceled"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const PageStateSchema = z.enum(["loading", "empty", "error", "stale", "ready"]);
export type PageState = z.infer<typeof PageStateSchema>;

export const DashboardMetricSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    value: z.string().min(1),
    trend: z.string().optional(),
  })
  .strict();
export type DashboardMetric = z.infer<typeof DashboardMetricSchema>;

export const ApprovalListItemSchema = z
  .object({
    id: z.string().min(1),
    runId: z.string().min(1),
    actionId: z.string().min(1),
    repositoryOwner: z.string().min(1).optional(),
    repositoryName: z.string().min(1).optional(),
    workflowName: z.string().min(1),
    domain: ApprovalDomainSchema,
    sideEffectLevel: SideEffectLevelSchema,
    status: ApprovalStatusSchema,
    requestedAt: TimestampStringSchema,
    resolvedAt: TimestampStringSchema.optional(),
    resolutionNote: z.string().min(1).optional(),
    actionSummary: z.string().min(1),
    reasonSummary: z.string().min(1).nullable(),
    targetLocator: z.string().min(1),
    targetLabel: z.string().min(1).optional(),
    snapshotRequired: z.boolean(),
  })
  .strict();
export type ApprovalListItem = z.infer<typeof ApprovalListItemSchema>;

export const PaginatedEnvelopeSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z
    .object({
      items: z.array(itemSchema),
      total: z.number().int().nonnegative(),
      page: z.number().int().positive(),
      per_page: z.number().int().positive(),
      has_more: z.boolean(),
    })
    .strict();

export type PaginatedEnvelope<T> = {
  items: T[];
  total: number;
  page: number;
  per_page: number;
  has_more: boolean;
};

export const PreviewStateSchema = z.enum(["ready", "loading", "empty", "error"]);
export type PreviewState = z.infer<typeof PreviewStateSchema>;

export const SessionUserSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    email: z.string().email(),
  })
  .strict();
export type SessionUser = z.infer<typeof SessionUserSchema>;

export const ActiveWorkspaceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    slug: z.string().min(1),
    role: WorkspaceRoleSchema,
  })
  .strict();
export type ActiveWorkspace = z.infer<typeof ActiveWorkspaceSchema>;

export const NotificationChannelSchema = z.enum(["in_app", "email", "slack"]);
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;

export const PolicyPackSchema = z.enum(["balanced", "guarded", "strict"]);
export type PolicyPack = z.infer<typeof PolicyPackSchema>;

export const WorkspaceSessionSchema = z
  .object({
    user: SessionUserSchema,
    activeWorkspace: ActiveWorkspaceSchema,
  })
  .strict();
export type WorkspaceSession = z.infer<typeof WorkspaceSessionSchema>;

export const WorkspaceSettingsSchema = z
  .object({
    workspaceName: z.string().trim().min(3).max(48),
    workspaceSlug: z
      .string()
      .trim()
      .min(3)
      .max(48)
      .regex(/^[a-z0-9-]+$/),
    defaultNotificationChannel: NotificationChannelSchema,
    approvalTtlMinutes: z.number().int().min(15).max(120),
    requireRejectComment: z.boolean(),
    freezeDeploysOutsideBusinessHours: z.boolean(),
  })
  .strict();
export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>;

export const WorkspaceSettingsSaveResponseSchema = z
  .object({
    settings: WorkspaceSettingsSchema,
    savedAt: TimestampStringSchema,
    message: z.string().min(1),
  })
  .strict();
export type WorkspaceSettingsSaveResponse = z.infer<typeof WorkspaceSettingsSaveResponseSchema>;

export const BillingPlanTierSchema = z.enum(["starter", "team", "enterprise"]);
export type BillingPlanTier = z.infer<typeof BillingPlanTierSchema>;

export const BillingCycleSchema = z.enum(["monthly", "yearly"]);
export type BillingCycle = z.infer<typeof BillingCycleSchema>;

export const BillingInvoiceStatusSchema = z.enum(["paid", "open", "void"]);
export type BillingInvoiceStatus = z.infer<typeof BillingInvoiceStatusSchema>;

export const BillingPaymentMethodStatusSchema = z.enum(["active", "expiring", "update_required"]);
export type BillingPaymentMethodStatus = z.infer<typeof BillingPaymentMethodStatusSchema>;

export const BillingInvoiceSchema = z
  .object({
    id: z.string().min(1),
    periodLabel: z.string().min(1),
    amountUsd: z.number().nonnegative(),
    status: BillingInvoiceStatusSchema,
    issuedAt: TimestampStringSchema,
    dueAt: TimestampStringSchema.optional(),
  })
  .strict();
export type BillingInvoice = z.infer<typeof BillingInvoiceSchema>;

export const WorkspaceBillingSchema = z
  .object({
    workspaceId: z.string().min(1),
    workspaceName: z.string().min(1),
    planTier: BillingPlanTierSchema,
    billingCycle: BillingCycleSchema,
    billingEmail: z.string().email(),
    invoiceEmail: z.string().email(),
    taxId: z.string().trim().max(32).optional(),
    seatsIncluded: z.number().int().positive(),
    seatsUsed: z.number().int().nonnegative(),
    repositoriesIncluded: z.number().int().positive(),
    repositoriesConnected: z.number().int().nonnegative(),
    approvalsIncluded: z.number().int().positive(),
    approvalsUsed: z.number().int().nonnegative(),
    monthlyEstimateUsd: z.number().nonnegative(),
    nextInvoiceDate: TimestampStringSchema,
    paymentMethodLabel: z.string().min(1),
    paymentMethodStatus: BillingPaymentMethodStatusSchema,
    invoices: z.array(BillingInvoiceSchema),
  })
  .strict();
export type WorkspaceBilling = z.infer<typeof WorkspaceBillingSchema>;

export const BillingUpdateSchema = z
  .object({
    planTier: BillingPlanTierSchema,
    billingCycle: BillingCycleSchema,
    billingEmail: z.string().email("Enter a valid billing email."),
    invoiceEmail: z.string().email("Enter a valid invoice email."),
    taxId: z.string().trim().max(32).optional().or(z.literal("")),
  })
  .strict();
export type BillingUpdate = z.infer<typeof BillingUpdateSchema>;

export const BillingSaveResponseSchema = z
  .object({
    billing: WorkspaceBillingSchema,
    savedAt: TimestampStringSchema,
    message: z.string().min(1),
  })
  .strict();
export type BillingSaveResponse = z.infer<typeof BillingSaveResponseSchema>;

export const IntegrationHealthStatusSchema = z.enum(["healthy", "warning", "degraded"]);
export type IntegrationHealthStatus = z.infer<typeof IntegrationHealthStatusSchema>;

export const SlackDeliveryModeSchema = z.enum(["all", "approvals_only", "disabled"]);
export type SlackDeliveryMode = z.infer<typeof SlackDeliveryModeSchema>;

export const NotificationEventSchema = z.enum(["approval_requested", "run_failed", "policy_changed", "snapshot_restored"]);
export type NotificationEvent = z.infer<typeof NotificationEventSchema>;

export const WorkspaceIntegrationSnapshotSchema = z
  .object({
    githubAppInstalled: z.boolean(),
    githubAppStatus: IntegrationHealthStatusSchema,
    githubOrgName: z.string().min(1),
    webhookStatus: IntegrationHealthStatusSchema,
    webhookLastDeliveryAt: TimestampStringSchema,
    webhookFailureCount24h: z.number().int().nonnegative(),
    slackConnected: z.boolean(),
    slackWorkspaceName: z.string().min(1).optional(),
    slackChannelName: z.string().min(1).optional(),
    slackDeliveryMode: SlackDeliveryModeSchema,
    emailNotificationsEnabled: z.boolean(),
    digestCadence: z.enum(["realtime", "daily", "weekly"]),
    notificationEvents: z.array(NotificationEventSchema),
  })
  .strict();
export type WorkspaceIntegrationSnapshot = z.infer<typeof WorkspaceIntegrationSnapshotSchema>;

export const WorkspaceIntegrationUpdateSchema = z
  .object({
    slackConnected: z.boolean(),
    slackWorkspaceName: z.string().trim().max(48).optional().or(z.literal("")),
    slackChannelName: z.string().trim().max(48).optional().or(z.literal("")),
    slackDeliveryMode: SlackDeliveryModeSchema,
    emailNotificationsEnabled: z.boolean(),
    digestCadence: z.enum(["realtime", "daily", "weekly"]),
    notificationEvents: z.array(NotificationEventSchema).min(1, "Select at least one notification event."),
  })
  .strict()
  .superRefine((values, context) => {
    if (values.slackConnected && !values.slackChannelName) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Enter a Slack channel when Slack delivery is enabled.",
        path: ["slackChannelName"],
      });
    }
  });
export type WorkspaceIntegrationUpdate = z.infer<typeof WorkspaceIntegrationUpdateSchema>;

export const WorkspaceIntegrationSaveResponseSchema = z
  .object({
    integrations: WorkspaceIntegrationSnapshotSchema,
    savedAt: TimestampStringSchema,
    message: z.string().min(1),
  })
  .strict();
export type WorkspaceIntegrationSaveResponse = z.infer<typeof WorkspaceIntegrationSaveResponseSchema>;

export const IntegrationTestChannelSchema = z.enum(["slack", "email", "in_app"]);
export type IntegrationTestChannel = z.infer<typeof IntegrationTestChannelSchema>;

export const IntegrationTestRequestSchema = z
  .object({
    channel: IntegrationTestChannelSchema,
  })
  .strict();
export type IntegrationTestRequest = z.infer<typeof IntegrationTestRequestSchema>;

export const IntegrationTestResponseSchema = z
  .object({
    channel: IntegrationTestChannelSchema,
    deliveredAt: TimestampStringSchema,
    message: z.string().min(1),
  })
  .strict();
export type IntegrationTestResponse = z.infer<typeof IntegrationTestResponseSchema>;

export const OnboardingRepositoryOptionSchema = z
  .object({
    id: z.string().min(1),
    owner: z.string().min(1),
    name: z.string().min(1),
    defaultBranch: z.string().min(1),
    description: z.string().min(1),
    requiresOrgApproval: z.boolean().default(false),
  })
  .strict();
export type OnboardingRepositoryOption = z.infer<typeof OnboardingRepositoryOptionSchema>;

export const OnboardingTeamInviteSchema = z
  .object({
    name: z.string().trim().min(1, "Invite name is required."),
    email: z.string().email("Enter a valid email address."),
    role: WorkspaceRoleSchema,
  })
  .strict();
export type OnboardingTeamInvite = z.infer<typeof OnboardingTeamInviteSchema>;

export const WorkspaceMembershipSchema = z
  .object({
    name: z.string().trim().min(1),
    email: z.string().email(),
    role: WorkspaceRoleSchema,
  })
  .strict();
export type WorkspaceMembership = z.infer<typeof WorkspaceMembershipSchema>;

export const OnboardingBootstrapSchema = z
  .object({
    suggestedWorkspaceName: z.string().min(1),
    suggestedWorkspaceSlug: z.string().min(1),
    availableRepositories: z.array(OnboardingRepositoryOptionSchema),
    connectedRepositoryIds: z.array(z.string().min(1)),
    invites: z.array(OnboardingTeamInviteSchema),
    defaultNotificationChannel: NotificationChannelSchema,
    recommendedPolicyPack: PolicyPackSchema,
    launchedAt: TimestampStringSchema.optional(),
  })
  .strict();
export type OnboardingBootstrap = z.infer<typeof OnboardingBootstrapSchema>;

export const OnboardingFormValuesSchema = z
  .object({
    workspaceName: z.string().trim().min(3, "Workspace name must be at least 3 characters.").max(48),
    workspaceSlug: z
      .string()
      .trim()
      .min(3, "Workspace slug must be at least 3 characters.")
      .max(48)
      .regex(/^[a-z0-9-]+$/, "Use lowercase letters, numbers, and hyphens only."),
    repositoryIds: z.array(z.string().min(1)).min(1, "Select at least one repository."),
    invites: z.array(OnboardingTeamInviteSchema).max(5, "Limit invites to 5 during onboarding."),
    defaultNotificationChannel: NotificationChannelSchema,
    policyPack: PolicyPackSchema,
    confirmLaunch: z.boolean().refine((value) => value, {
      message: "Confirm the launch checklist before continuing.",
    }),
  })
  .strict();
export type OnboardingFormValues = z.infer<typeof OnboardingFormValuesSchema>;

export const OnboardingLaunchResponseSchema = z
  .object({
    workspaceId: z.string().min(1),
    launchedAt: TimestampStringSchema,
    connectedRepositoryCount: z.number().int().nonnegative(),
    invitedTeamCount: z.number().int().nonnegative(),
    message: z.string().min(1),
  })
  .strict();
export type OnboardingLaunchResponse = z.infer<typeof OnboardingLaunchResponseSchema>;

export const WorkspaceConnectionStateSchema = z
  .object({
    workspaceId: z.string().min(1),
    workspaceName: z.string().min(1),
    workspaceSlug: z.string().min(1),
    repositoryIds: z.array(z.string().min(1)),
    members: z.array(WorkspaceMembershipSchema).default([]),
    invites: z.array(OnboardingTeamInviteSchema),
    defaultNotificationChannel: NotificationChannelSchema,
    policyPack: PolicyPackSchema,
    launchedAt: TimestampStringSchema,
  })
  .strict();
export type WorkspaceConnectionState = z.infer<typeof WorkspaceConnectionStateSchema>;

export const WorkspaceTeamMemberStatusSchema = z.enum(["active", "invited"]);
export type WorkspaceTeamMemberStatus = z.infer<typeof WorkspaceTeamMemberStatusSchema>;

export const WorkspaceTeamMemberSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    email: z.string().email(),
    role: WorkspaceRoleSchema,
    status: WorkspaceTeamMemberStatusSchema,
  })
  .strict();
export type WorkspaceTeamMember = z.infer<typeof WorkspaceTeamMemberSchema>;

export const WorkspaceTeamSnapshotSchema = z
  .object({
    workspaceId: z.string().min(1),
    workspaceName: z.string().min(1),
    workspaceSlug: z.string().min(1),
    members: z.array(WorkspaceTeamMemberSchema),
    inviteLimit: z.number().int().positive(),
  })
  .strict();
export type WorkspaceTeamSnapshot = z.infer<typeof WorkspaceTeamSnapshotSchema>;

export const WorkspaceTeamUpdateSchema = z
  .object({
    invites: z.array(OnboardingTeamInviteSchema).max(20, "Limit invites to 20 workspace invites."),
  })
  .strict();
export type WorkspaceTeamUpdate = z.infer<typeof WorkspaceTeamUpdateSchema>;

export const WorkspaceTeamSaveResponseSchema = z
  .object({
    team: WorkspaceTeamSnapshotSchema,
    savedAt: TimestampStringSchema,
    message: z.string().min(1),
  })
  .strict();
export type WorkspaceTeamSaveResponse = z.infer<typeof WorkspaceTeamSaveResponseSchema>;

export const RepositoryStatusSchema = z.enum(["active", "archived"]);
export type RepositoryStatus = z.infer<typeof RepositoryStatusSchema>;

export const AgentStatusSchema = z.enum(["healthy", "escalated", "idle"]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const RepositoryListItemSchema = z
  .object({
    id: z.string().min(1),
    owner: z.string().min(1),
    name: z.string().min(1),
    provider: CloudProviderSchema,
    providerIdentityStatus: ProviderIdentityStatusSchema,
    providerRepositoryUrl: z.string().url().nullable(),
    providerVisibility: ProviderVisibilitySchema,
    providerVerifiedAt: TimestampStringSchema.nullable(),
    providerStatusReason: z.string().min(1).nullable(),
    defaultBranch: z.string().min(1),
    repositoryStatus: RepositoryStatusSchema,
    lastRunStatus: RunStatusSchema,
    lastUpdatedAt: TimestampStringSchema,
    agentStatus: AgentStatusSchema,
  })
  .strict();
export type RepositoryListItem = z.infer<typeof RepositoryListItemSchema>;

export const RepositoryListResponseSchema = PaginatedEnvelopeSchema(RepositoryListItemSchema);
export type RepositoryListResponse = z.infer<typeof RepositoryListResponseSchema>;

export const RepositoryConnectionBootstrapSchema = z
  .object({
    availableRepositories: z.array(OnboardingRepositoryOptionSchema),
    connectedRepositoryIds: z.array(z.string().min(1)),
    activeConnectorCount: z.number().int().nonnegative(),
    totalConnectorCount: z.number().int().nonnegative(),
    staleConnectorCount: z.number().int().nonnegative(),
    revokedConnectorCount: z.number().int().nonnegative(),
    activeConnectorRepositoryIds: z.array(z.string().min(1)),
    launchedAt: TimestampStringSchema.nullable(),
  })
  .strict();
export type RepositoryConnectionBootstrap = z.infer<typeof RepositoryConnectionBootstrapSchema>;

export const RepositoryConnectionUpdateSchema = z
  .object({
    repositoryIds: z.array(z.string().min(1)),
  })
  .strict();
export type RepositoryConnectionUpdate = z.infer<typeof RepositoryConnectionUpdateSchema>;

export const RepositoryConnectionSaveResponseSchema = z
  .object({
    connectedRepositoryIds: z.array(z.string().min(1)),
    connectedRepositoryCount: z.number().int().nonnegative(),
    newlyConnectedRepositoryIds: z.array(z.string().min(1)),
    connectorBootstrapSuggested: z.boolean(),
    savedAt: TimestampStringSchema,
    message: z.string().min(1),
  })
  .strict();
export type RepositoryConnectionSaveResponse = z.infer<typeof RepositoryConnectionSaveResponseSchema>;

export const RepositoryRunListItemSchema = z
  .object({
    id: z.string().min(1),
    workflowName: z.string().min(1),
    agentName: z.string().min(1),
    status: RunStatusSchema,
    startedAt: TimestampStringSchema,
    updatedAt: TimestampStringSchema,
    eventCount: z.number().int().nonnegative(),
    summary: z.string().min(1),
  })
  .strict();
export type RepositoryRunListItem = z.infer<typeof RepositoryRunListItemSchema>;

export const RepositoryRunsResponseSchema = PaginatedEnvelopeSchema(RepositoryRunListItemSchema);
export type RepositoryRunsResponse = z.infer<typeof RepositoryRunsResponseSchema>;

export const RepositoryDetailSchema = z
  .object({
    id: z.string().min(1),
    owner: z.string().min(1),
    name: z.string().min(1),
    providerIdentity: ProviderRepositoryIdentitySchema,
    defaultBranch: z.string().min(1),
    rootPath: z.string().min(1),
    repositoryStatus: RepositoryStatusSchema,
    lastRunStatus: RunStatusSchema,
    lastUpdatedAt: TimestampStringSchema,
    agentStatus: AgentStatusSchema,
    latestRunId: z.string().min(1).optional(),
    latestWorkflowName: z.string().min(1).optional(),
    pendingApprovalCount: z.number().int().nonnegative(),
    totalRuns: z.number().int().nonnegative(),
    failedRuns24h: z.number().int().nonnegative(),
    recentActivity: z.array(z.lazy(() => ActivityEventSchema)),
  })
  .strict();
export type RepositoryDetail = z.infer<typeof RepositoryDetailSchema>;

export const SnapshotIntegrityStatusSchema = z.enum(["verified", "missing"]);
export type SnapshotIntegrityStatus = z.infer<typeof SnapshotIntegrityStatusSchema>;

export const SnapshotRestoreOutcomeSchema = z.enum(["restored", "compensated"]);
export type SnapshotRestoreOutcome = z.infer<typeof SnapshotRestoreOutcomeSchema>;

export const RepositorySnapshotRecoverySchema = z
  .object({
    executedAt: TimestampStringSchema,
    outcome: SnapshotRestoreOutcomeSchema,
    recoveryClass: z.string().min(1),
    strategy: z.string().min(1),
  })
  .strict();
export type RepositorySnapshotRecovery = z.infer<typeof RepositorySnapshotRecoverySchema>;

export const RepositorySnapshotListItemSchema = z
  .object({
    snapshotId: z.string().min(1),
    runId: z.string().min(1),
    actionId: z.string().min(1),
    workflowName: z.string().min(1),
    actionSummary: z.string().min(1),
    targetLocator: z.string().min(1),
    snapshotClass: z.string().min(1),
    fidelity: z.string().min(1),
    scopePaths: z.array(z.string().min(1)),
    integrityStatus: SnapshotIntegrityStatusSchema,
    storageBytes: z.number().int().nonnegative().nullable(),
    createdAt: TimestampStringSchema,
    latestRecovery: RepositorySnapshotRecoverySchema.optional(),
    latestRestoreCommandId: z.string().min(1).nullable().optional(),
    latestRestoreCommandStatus: ConnectorCommandStatusSchema.nullable().optional(),
    latestRestoreCommandUpdatedAt: TimestampStringSchema.nullable().optional(),
    latestRestoreCommandMessage: z.string().min(1).nullable().optional(),
    latestRestoreRunId: z.string().min(1).nullable().optional(),
    latestRestoreActionId: z.string().min(1).nullable().optional(),
  })
  .strict();
export type RepositorySnapshotListItem = z.infer<typeof RepositorySnapshotListItemSchema>;

export const RepositorySnapshotsResponseSchema = z
  .object({
    items: z.array(RepositorySnapshotListItemSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    per_page: z.number().int().positive(),
    has_more: z.boolean(),
    authorityReachable: z.boolean(),
    restorableCount: z.number().int().nonnegative(),
    restoredCount: z.number().int().nonnegative(),
  })
  .strict();
export type RepositorySnapshotsResponse = z.infer<typeof RepositorySnapshotsResponseSchema>;

export const RecentRunSchema = z
  .object({
    id: z.string().min(1),
    repo: z.string().min(1),
    branch: z.string().min(1),
    status: RunStatusSchema,
    duration: z.string().min(1),
    timestamp: TimestampStringSchema,
  })
  .strict();
export type RecentRun = z.infer<typeof RecentRunSchema>;

export const ActivityEventSchema = z
  .object({
    id: z.string().min(1),
    kind: z
      .enum([
        "approval_requested",
        "approval_resolved",
        "run_started",
        "run_completed",
        "run_failed",
        "snapshot_restored",
        "connector_command",
        "connector_event",
        "policy_changed",
      ])
      .optional(),
    title: z.string().min(1).optional(),
    message: z.string().min(1),
    repo: z.string().min(1),
    actorLabel: z.string().min(1).optional(),
    runId: z.string().min(1).optional(),
    actionId: z.string().min(1).optional(),
    detailPath: z.string().min(1).optional(),
    externalUrl: z.string().url().optional(),
    createdAt: TimestampStringSchema,
    tone: z.enum(["neutral", "warning", "error", "accent"]).default("neutral"),
  })
  .strict();
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

export const ActivityFeedResponseSchema = z
  .object({
    items: z.array(ActivityEventSchema),
    total: z.number().int().nonnegative(),
    generatedAt: TimestampStringSchema,
  })
  .strict();
export type ActivityFeedResponse = z.infer<typeof ActivityFeedResponseSchema>;

export const AuditActorTypeSchema = z.enum(["human", "agent", "system"]);
export type AuditActorType = z.infer<typeof AuditActorTypeSchema>;

export const AuditOutcomeSchema = z.enum(["success", "warning", "failure", "info"]);
export type AuditOutcome = z.infer<typeof AuditOutcomeSchema>;

export const AuditCategorySchema = z.enum(["approval", "connector", "run", "recovery", "policy", "fleet"]);
export type AuditCategory = z.infer<typeof AuditCategorySchema>;

export const AuditEntrySchema = z
  .object({
    id: z.string().min(1),
    occurredAt: TimestampStringSchema,
    actorLabel: z.string().min(1),
    actorType: AuditActorTypeSchema,
    category: AuditCategorySchema,
    action: z.string().min(1),
    target: z.string().min(1),
    outcome: AuditOutcomeSchema,
    repo: z.string().min(1).nullable(),
    runId: z.string().min(1).nullable(),
    actionId: z.string().min(1).nullable(),
    detailPath: z.string().min(1).nullable().optional(),
    externalUrl: z.string().url().nullable().optional(),
    details: z.string().min(1),
  })
  .strict();
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export const AuditLogResponseSchema = z
  .object({
    items: z.array(AuditEntrySchema),
    total: z.number().int().nonnegative(),
    generatedAt: TimestampStringSchema,
  })
  .strict();
export type AuditLogResponse = z.infer<typeof AuditLogResponseSchema>;

export const DashboardSummarySchema = z
  .object({
    metrics: z.array(DashboardMetricSchema),
    recentRuns: z.array(RecentRunSchema),
    recentActivity: z.array(ActivityEventSchema),
    lastUpdatedAt: TimestampStringSchema.optional(),
  })
  .strict();
export type DashboardSummary = z.infer<typeof DashboardSummarySchema>;

export const ApprovalListResponseSchema = PaginatedEnvelopeSchema(ApprovalListItemSchema);
export type ApprovalListResponse = z.infer<typeof ApprovalListResponseSchema>;

export const ApprovalDecisionRequestSchema = z
  .object({
    comment: z.string().trim().max(280).optional(),
  })
  .strict();
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequestSchema>;

export const ApprovalDecisionResponseSchema = z
  .object({
    id: z.string().min(1),
    status: ApprovalResolvedStatusSchema,
    resolvedByName: z.string().min(1),
    resolvedAt: TimestampStringSchema,
    message: z.string().min(1),
    comment: z.string().trim().max(280).optional(),
  })
  .strict();
export type ApprovalDecisionResponse = z.infer<typeof ApprovalDecisionResponseSchema>;

export const RunStepTypeSchema = z.enum(["action_step", "approval_step", "recovery_step", "analysis_step", "system_step"]);
export type RunStepType = z.infer<typeof RunStepTypeSchema>;

export const RunStepStatusSchema = z.enum(["completed", "failed", "partial", "blocked", "awaiting_approval", "cancelled"]);
export type RunStepStatus = z.infer<typeof RunStepStatusSchema>;

export const RunStepSchema = z
  .object({
    id: z.string().min(1),
    sequence: z.number().int().positive(),
    title: z.string().min(1),
    stepType: RunStepTypeSchema,
    status: RunStepStatusSchema,
    actionId: z.string().min(1).optional(),
    decision: PolicyDecisionSchema.nullable(),
    summary: z.string().min(1),
    occurredAt: TimestampStringSchema,
    snapshotId: z.string().min(1).optional(),
  })
  .strict();
export type RunStep = z.infer<typeof RunStepSchema>;

export const RunDetailSchema = z
  .object({
    id: z.string().min(1),
    workflowName: z.string().min(1),
    agentName: z.string().min(1),
    agentFramework: z.string().min(1),
    workspaceRoots: z.array(z.string().min(1)),
    projectionStatus: z.enum(["fresh", "rebuilt"]),
    runtime: z.string().min(1),
    status: RunStatusSchema,
    startedAt: TimestampStringSchema,
    endedAt: TimestampStringSchema,
    actionCount: z.number().int().nonnegative(),
    actionsAllowed: z.number().int().nonnegative(),
    actionsDenied: z.number().int().nonnegative(),
    actionsAsked: z.number().int().nonnegative(),
    snapshotsTaken: z.number().int().nonnegative(),
    summary: z.string().min(1),
    steps: z.array(RunStepSchema),
  })
  .strict();
export type RunDetail = z.infer<typeof RunDetailSchema>;

export const ActionDetailSchema = z
  .object({
    id: z.string().min(1),
    runId: z.string().min(1),
    actionId: z.string().min(1),
    repo: z.string().min(1),
    workflowName: z.string().min(1),
    occurredAt: TimestampStringSchema,
    normalizedAction: z
      .object({
        domain: z.string().min(1),
        kind: z.string().min(1),
        name: z.string().min(1),
        displayName: z.string().min(1),
        targetLocator: z.string().min(1),
        targetLabel: z.string().min(1).nullable(),
        executionSurface: z.string().min(1),
        executionMode: z.string().min(1),
        confidenceScore: z.number().min(0).max(1),
        confidenceBand: z.enum(["high", "guarded", "low"]),
        sideEffectLevel: SideEffectLevelSchema,
        reversibilityHint: z.string().min(1),
        externalEffects: z.array(z.string().min(1)),
        warnings: z.array(z.string().min(1)),
        rawInput: z.record(z.string(), z.unknown()),
        redactedInput: z.record(z.string(), z.unknown()),
      })
      .strict(),
    policyOutcome: z
      .object({
        decision: PolicyDecisionSchema.nullable(),
        reasons: z.array(
          z
            .object({
              code: z.string().min(1),
              severity: z.string().min(1),
              message: z.string().min(1),
            })
            .strict(),
        ),
        snapshotRequired: z.boolean(),
        approvalRequired: z.boolean(),
        budgetCheck: z.string().min(1),
        matchedRules: z.array(z.string().min(1)),
      })
      .strict(),
    runContext: z
      .object({
        sessionId: z.string().min(1),
        workflowName: z.string().min(1),
        agentName: z.string().min(1),
        agentFramework: z.string().min(1),
        status: RunStatusSchema,
        startedAt: TimestampStringSchema,
        latestEventAt: TimestampStringSchema,
        eventCount: z.number().int().nonnegative(),
      })
      .strict(),
    approvalContext: z
      .object({
        approvalId: z.string().min(1),
        status: ApprovalStatusSchema,
        decisionRequested: z.enum(["approve_or_deny"]),
        requestedAt: TimestampStringSchema,
        resolvedAt: TimestampStringSchema.nullable(),
        resolutionNote: z.string().min(1).nullable(),
        actionSummary: z.string().min(1),
        primaryReason: z
          .object({
            code: z.string().min(1),
            message: z.string().min(1),
          })
          .strict()
          .nullable(),
      })
      .nullable(),
    execution: z
      .object({
        stepId: z.string().min(1).nullable(),
        status: RunStepStatusSchema,
        stepType: RunStepTypeSchema,
        summary: z.string().min(1),
        snapshotId: z.string().min(1).nullable(),
        artifactLabels: z.array(z.string().min(1)),
        helperSummary: z.string().min(1).nullable(),
        policyExplanation: z.string().min(1).nullable(),
        laterActionsAffected: z.number().int().nonnegative(),
        overlappingPaths: z.array(z.string().min(1)),
      })
      .strict(),
  })
  .strict();
export type ActionDetail = z.infer<typeof ActionDetailSchema>;

export const CalibrationBandSchema = z
  .object({
    min: z.number().min(0).max(1),
    count: z.number().int().nonnegative(),
    accuracy: z.number().min(0).max(1),
  })
  .strict();
export type CalibrationBand = z.infer<typeof CalibrationBandSchema>;

export const CalibrationRecommendationSchema = z
  .object({
    domain: z.string().min(1),
    currentAskThreshold: z.number().min(0).max(1),
    recommended: z.number().min(0).max(1),
    impact: z.string().min(1),
  })
  .strict();
export type CalibrationRecommendation = z.infer<typeof CalibrationRecommendationSchema>;

export const CalibrationReportSchema = z
  .object({
    repoId: z.string().min(1),
    period: z.string().min(1),
    totalActions: z.number().int().nonnegative(),
    brierScore: z.number().min(0).max(1),
    ece: z.number().min(0).max(1),
    bands: z
      .object({
        high: CalibrationBandSchema,
        guarded: CalibrationBandSchema,
        low: CalibrationBandSchema,
      })
      .strict(),
    recommendations: z.array(CalibrationRecommendationSchema),
  })
  .strict();
export type CalibrationReport = z.infer<typeof CalibrationReportSchema>;

export const RepositoryPolicyValidationSchema = z
  .object({
    valid: z.boolean(),
    issues: z.array(z.string().min(1)),
    compiledProfileName: z.string().min(1).nullable(),
    compiledRuleCount: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type RepositoryPolicyValidation = z.infer<typeof RepositoryPolicyValidationSchema>;

export const RepositoryPolicySnapshotSchema = z
  .object({
    repoId: z.string().min(1),
    owner: z.string().min(1),
    name: z.string().min(1),
    policyPath: z.string().min(1),
    authorityReachable: z.boolean(),
    hasWorkspaceOverride: z.boolean(),
    effectivePolicy: z
      .object({
        policy: PolicyConfigSchema,
        summary: PolicySummarySchema,
      })
      .strict(),
    workspaceConfig: PolicyConfigSchema,
    validation: RepositoryPolicyValidationSchema,
    recommendations: z.array(PolicyThresholdRecommendationSchema),
    loadedSources: z.array(PolicyLoadedSourceSchema),
  })
  .strict();
export type RepositoryPolicySnapshot = z.infer<typeof RepositoryPolicySnapshotSchema>;

export const RepositoryPolicySaveResponseSchema = z
  .object({
    policy: RepositoryPolicySnapshotSchema,
    savedAt: TimestampStringSchema,
    message: z.string().min(1),
  })
  .strict();
export type RepositoryPolicySaveResponse = z.infer<typeof RepositoryPolicySaveResponseSchema>;

export const RepositoryPolicyDocumentInputSchema = z
  .object({
    document: z.string().trim().min(1, "Policy document is required."),
  })
  .strict();
export type RepositoryPolicyDocumentInput = z.infer<typeof RepositoryPolicyDocumentInputSchema>;

export const SnapshotRestoreIntentSchema = z.enum(["plan", "execute"]);
export type SnapshotRestoreIntent = z.infer<typeof SnapshotRestoreIntentSchema>;

export const SnapshotRestoreRequestSchema = z
  .object({
    intent: SnapshotRestoreIntentSchema,
  })
  .strict();
export type SnapshotRestoreRequest = z.infer<typeof SnapshotRestoreRequestSchema>;

export const SnapshotRestorePreviewSchema = z
  .object({
    snapshotId: z.string().min(1),
    plan: RecoveryPlanSchema,
  })
  .strict();
export type SnapshotRestorePreview = z.infer<typeof SnapshotRestorePreviewSchema>;

export const SnapshotRestoreExecuteResponseSchema = z
  .object({
    snapshotId: z.string().min(1),
    plan: RecoveryPlanSchema,
    restored: z.boolean(),
    outcome: SnapshotRestoreOutcomeSchema,
    executedAt: TimestampStringSchema,
    message: z.string().min(1),
  })
  .strict();
export type SnapshotRestoreExecuteResponse = z.infer<typeof SnapshotRestoreExecuteResponseSchema>;

export const SnapshotRestoreQueuedResponseSchema = z
  .object({
    snapshotId: z.string().min(1),
    commandId: z.string().min(1),
    connectorId: z.string().min(1),
    queuedAt: TimestampStringSchema,
    message: z.string().min(1),
  })
  .strict();
export type SnapshotRestoreQueuedResponse = z.infer<typeof SnapshotRestoreQueuedResponseSchema>;

export const SnapshotRestoreExecutionResultSchema = z.union([
  SnapshotRestoreExecuteResponseSchema,
  SnapshotRestoreQueuedResponseSchema,
]);
export type SnapshotRestoreExecutionResult = z.infer<typeof SnapshotRestoreExecutionResultSchema>;

export const WorkspaceConnectorCommandSummarySchema = z
  .object({
    commandId: z.string().min(1),
    type: ConnectorCommandTypeSchema,
    status: ConnectorCommandStatusSchema,
    issuedAt: TimestampStringSchema,
    updatedAt: TimestampStringSchema,
    acknowledgedAt: TimestampStringSchema.nullable(),
    leaseExpiresAt: TimestampStringSchema.nullable(),
    attemptCount: z.number().int().nonnegative(),
    nextAttemptAt: TimestampStringSchema.nullable(),
    message: z.string().min(1).nullable(),
    result: ConnectorCommandExecutionResultSchema.nullable(),
    detailPath: z.string().min(1).nullable().optional(),
    externalUrl: z.string().url().nullable().optional(),
    replayable: z.boolean().optional(),
    replayStatus: z.enum(["available", "scheduled", "queued", "leased", "settled"]).optional(),
    replayReason: z.string().min(1).nullable().optional(),
  })
  .strict();
export type WorkspaceConnectorCommandSummary = z.infer<typeof WorkspaceConnectorCommandSummarySchema>;

export const WorkspaceConnectorEventSummarySchema = z
  .object({
    eventId: z.string().min(1),
    type: z.string().min(1),
    occurredAt: TimestampStringSchema,
  })
  .strict();
export type WorkspaceConnectorEventSummary = z.infer<typeof WorkspaceConnectorEventSummarySchema>;

export const WorkspaceConnectorSummarySchema = z
  .object({
    id: z.string().min(1),
    connectorName: z.string().min(1),
    machineName: z.string().min(1),
    status: ConnectorStatusSchema,
    connectorVersion: z.string().min(1),
    registeredAt: TimestampStringSchema,
    lastSeenAt: TimestampStringSchema,
    workspaceSlug: z.string().min(1),
    capabilities: z.array(ConnectorCapabilitySchema),
    providerIdentity: ProviderRepositoryIdentitySchema,
    repositoryOwner: z.string().min(1),
    repositoryName: z.string().min(1),
    currentBranch: z.string().min(1),
    headSha: z.string().min(7),
    isDirty: z.boolean(),
    aheadBy: z.number().int().nonnegative(),
    behindBy: z.number().int().nonnegative(),
    workspaceRoot: z.string().min(1),
    daemonReachable: z.boolean(),
    pendingCommandCount: z.number().int().nonnegative(),
    leasedCommandCount: z.number().int().nonnegative(),
    retryableCommandCount: z.number().int().nonnegative(),
    automaticRetryCount: z.number().int().nonnegative(),
    eventCount: z.number().int().nonnegative(),
    lastEvent: WorkspaceConnectorEventSummarySchema.nullable(),
    statusReason: z.string().min(1).nullable(),
    revokedAt: TimestampStringSchema.nullable(),
    lastCommand: WorkspaceConnectorCommandSummarySchema.nullable(),
    recentCommands: z.array(WorkspaceConnectorCommandSummarySchema),
    recentEvents: z.array(WorkspaceConnectorEventSummarySchema),
  })
  .strict();
export type WorkspaceConnectorSummary = z.infer<typeof WorkspaceConnectorSummarySchema>;

export const WorkspaceConnectorInventorySchema = z
  .object({
    items: z.array(WorkspaceConnectorSummarySchema),
    total: z.number().int().nonnegative(),
    generatedAt: TimestampStringSchema,
  })
  .strict();
export type WorkspaceConnectorInventory = z.infer<typeof WorkspaceConnectorInventorySchema>;

export const ConnectorBootstrapResponseSchema = z
  .object({
    bootstrapToken: z.string().min(1),
    workspaceId: z.string().min(1),
    workspaceSlug: z.string().min(1),
    expiresAt: TimestampStringSchema,
    commandHint: z.string().min(1),
  })
  .strict();
export type ConnectorBootstrapResponse = z.infer<typeof ConnectorBootstrapResponseSchema>;

export const ConnectorCommandDispatchRequestSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("refresh_repo_state"),
      forceFullSync: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("sync_run_history"),
      includeSnapshots: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("create_commit"),
      message: z.string().trim().min(1).max(200),
      stageAll: z.boolean(),
      paths: z.array(z.string().min(1)).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("push_branch"),
      branch: z.string().trim().min(1).optional(),
      setUpstream: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("execute_restore"),
      snapshotId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("open_pull_request"),
      title: z.string().trim().min(1).max(200),
      body: z.string().max(20_000).optional(),
      baseBranch: z.string().trim().min(1).optional(),
      headBranch: z.string().trim().min(1).optional(),
      draft: z.boolean().optional(),
    })
    .strict(),
]);
export type ConnectorCommandDispatchRequest = z.infer<typeof ConnectorCommandDispatchRequestSchema>;

export const ConnectorCommandDispatchResponseSchema = z
  .object({
    commandId: z.string().min(1),
    connectorId: z.string().min(1),
    status: ConnectorCommandStatusSchema,
    queuedAt: TimestampStringSchema,
    message: z.string().min(1),
  })
  .strict();
export type ConnectorCommandDispatchResponse = z.infer<typeof ConnectorCommandDispatchResponseSchema>;

export const ConnectorCommandRetryResponseSchema = z
  .object({
    commandId: z.string().min(1),
    connectorId: z.string().min(1),
    status: ConnectorCommandStatusSchema,
    queuedAt: TimestampStringSchema,
    message: z.string().min(1),
  })
  .strict();
export type ConnectorCommandRetryResponse = z.infer<typeof ConnectorCommandRetryResponseSchema>;

export const ConnectorRevokeResponseSchema = z
  .object({
    connectorId: z.string().min(1),
    revokedAt: TimestampStringSchema,
    message: z.string().min(1),
  })
  .strict();
export type ConnectorRevokeResponse = z.infer<typeof ConnectorRevokeResponseSchema>;
