import "server-only";

import { DashboardSummarySchema, type ActivityEvent, type DashboardSummary, type RecentRun } from "@/schemas/cloud";
import {
  collectWorkspaceRepositoryRuntimeRecords,
  type WorkspaceRepositoryRuntimeRecord,
} from "@/lib/backend/workspace/repository-inventory";

function formatDuration(startedAt: string, endedAt: string): string {
  const deltaMs = Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime());
  const totalSeconds = Math.round(deltaMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function describeEvent(eventType: string, repoLabel: string): { message: string; tone: ActivityEvent["tone"] } {
  switch (eventType) {
    case "approval.requested":
      return {
        message: `Approval requested for a governed action in ${repoLabel}.`,
        tone: "accent",
      };
    case "execution.failed":
      return {
        message: `A run failed in ${repoLabel}. Review the latest execution output.`,
        tone: "error",
      };
    case "execution.completed":
      return {
        message: `A governed run completed in ${repoLabel}.`,
        tone: "neutral",
      };
    case "recovery.executed":
      return {
        message: `Recovery executed for ${repoLabel}.`,
        tone: "warning",
      };
    default:
      return {
        message: `Recent governed activity was recorded for ${repoLabel}.`,
        tone: "neutral",
      };
  }
}

function mapRecentRuns(records: WorkspaceRepositoryRuntimeRecord[]): RecentRun[] {
  return records
    .filter((record) => record.latestRun !== null)
    .map((record) => {
      const latestRun = record.latestRun!;
      const latestTimestamp = latestRun.latest_event?.occurred_at ?? latestRun.started_at;
      const status = record.inventory.lastRunStatus;

      return {
        id: latestRun.run_id,
        repo: `${record.metadata.owner}/${record.metadata.name}`,
        branch: record.metadata.defaultBranch,
        status,
        duration: formatDuration(latestRun.started_at, latestTimestamp),
        timestamp: latestTimestamp,
      };
    })
    .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())
    .slice(0, 8);
}

function mapRecentActivity(records: WorkspaceRepositoryRuntimeRecord[]): ActivityEvent[] {
  return records
    .filter((record) => record.latestRun?.latest_event)
    .map((record) => {
      const latestEvent = record.latestRun!.latest_event!;
      const repoLabel = `${record.metadata.owner}/${record.metadata.name}`;
      const description = describeEvent(latestEvent.event_type, repoLabel);

      return {
        id: `${record.latestRun!.run_id}:${latestEvent.sequence}`,
        message: description.message,
        repo: repoLabel,
        createdAt: latestEvent.occurred_at,
        tone: description.tone,
      };
    })
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .slice(0, 8);
}

function countFailedRuns24h(recentRuns: RecentRun[]): number {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return recentRuns.filter((run) => run.status === "failed" && new Date(run.timestamp).getTime() >= cutoff).length;
}

function countPendingApprovals(records: WorkspaceRepositoryRuntimeRecord[]): number {
  return records.reduce((total, record) => total + record.pendingApprovalCount, 0);
}

export async function getDashboardSummaryFromWorkspace(workspaceId: string): Promise<DashboardSummary> {
  const repositories = await collectWorkspaceRepositoryRuntimeRecords(workspaceId);
  const recentRuns = mapRecentRuns(repositories);
  const recentActivity = mapRecentActivity(repositories);
  const pendingApprovals = countPendingApprovals(repositories);
  const failedRuns24h = countFailedRuns24h(recentRuns);
  const lastUpdatedAt =
    recentRuns[0]?.timestamp ?? recentActivity[0]?.createdAt ?? repositories[0]?.inventory.lastUpdatedAt ?? undefined;

  return DashboardSummarySchema.parse({
    metrics: [
      {
        id: "connected_repos",
        label: "Connected repositories",
        value: String(repositories.length),
        trend: `${repositories.filter((record) => record.inventory.agentStatus === "healthy").length} healthy`,
      },
      {
        id: "pending_approvals",
        label: "Pending approvals",
        value: String(pendingApprovals),
        trend: pendingApprovals > 0 ? "human review required" : "queue clear",
      },
      {
        id: "failed_runs",
        label: "Failed runs (24h)",
        value: String(failedRuns24h),
        trend: `${recentRuns.filter((run) => run.status === "completed").length} recent completions`,
      },
    ],
    recentRuns,
    recentActivity,
    lastUpdatedAt,
  });
}
