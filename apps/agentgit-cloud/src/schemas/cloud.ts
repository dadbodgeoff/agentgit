import { TimestampStringSchema } from "@agentgit/schemas";
import { z } from "zod";

export const WorkspaceRoleSchema = z.enum(["member", "admin", "owner"]);
export type WorkspaceRole = z.infer<typeof WorkspaceRoleSchema>;

export const ApprovalStatusSchema = z.enum(["pending", "approved", "rejected", "expired"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

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
    repo: z.string().min(1),
    branch: z.string().min(1),
    status: ApprovalStatusSchema,
    requestedAt: TimestampStringSchema,
    confidence: z.number().min(0).max(1),
    actionSummary: z.string().min(1),
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

export const WorkspaceSessionSchema = z
  .object({
    user: SessionUserSchema,
    activeWorkspace: ActiveWorkspaceSchema,
  })
  .strict();
export type WorkspaceSession = z.infer<typeof WorkspaceSessionSchema>;

export const RepositoryStatusSchema = z.enum(["active", "archived"]);
export type RepositoryStatus = z.infer<typeof RepositoryStatusSchema>;

export const AgentStatusSchema = z.enum(["healthy", "escalated", "idle"]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const RepositoryListItemSchema = z
  .object({
    id: z.string().min(1),
    owner: z.string().min(1),
    name: z.string().min(1),
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
    message: z.string().min(1),
    repo: z.string().min(1),
    createdAt: TimestampStringSchema,
    tone: z.enum(["neutral", "warning", "error", "accent"]).default("neutral"),
  })
  .strict();
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

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

export const RunDetailSchema = z
  .object({
    id: z.string().min(1),
    repoId: z.string().min(1),
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
  })
  .strict();
export type RunDetail = z.infer<typeof RunDetailSchema>;

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
