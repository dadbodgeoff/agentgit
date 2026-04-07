import { DashboardSummarySchema, type DashboardSummary, type PreviewState } from "@/schemas/cloud";

const dashboardReadyFixture = DashboardSummarySchema.parse({
  metrics: [
    { id: "connected_repos", label: "Connected repositories", value: "18", trend: "+4 this week" },
    { id: "pending_approvals", label: "Pending approvals", value: "3", trend: "1 expiring soon" },
    { id: "failed_runs", label: "Failed runs (24h)", value: "7", trend: "down 18%" },
  ],
  recentRuns: [
    {
      id: "run_7f3a2b",
      repo: "acme/api-gateway",
      branch: "feature/auth-refactor",
      status: "completed",
      duration: "2m 34s",
      timestamp: "2026-04-06T14:32:34Z",
    },
    {
      id: "run_9k8d1f",
      repo: "acme/platform-ui",
      branch: "main",
      status: "failed",
      duration: "6m 02s",
      timestamp: "2026-04-06T14:05:00Z",
    },
  ],
  recentActivity: [
    {
      id: "evt_1",
      message: "Agent requested approval to run a shell build step.",
      repo: "acme/api-gateway",
      createdAt: "2026-04-06T14:31:45Z",
      tone: "accent",
    },
    {
      id: "evt_2",
      message: "Calibration recommendation available for shell thresholds.",
      repo: "acme/platform-ui",
      createdAt: "2026-04-06T13:10:00Z",
      tone: "warning",
    },
  ],
  lastUpdatedAt: "2026-04-06T14:32:34Z",
});

const dashboardEmptyFixture = DashboardSummarySchema.parse({
  metrics: [],
  recentRuns: [],
  recentActivity: [],
  lastUpdatedAt: "2026-04-06T14:32:34Z",
});

export function getDashboardFixture(previewState: PreviewState): DashboardSummary {
  return previewState === "empty" ? dashboardEmptyFixture : dashboardReadyFixture;
}
