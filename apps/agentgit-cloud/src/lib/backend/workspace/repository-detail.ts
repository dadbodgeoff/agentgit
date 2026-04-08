import "server-only";

import fs from "node:fs";
import path from "node:path";

import { RunJournal } from "@agentgit/run-journal";
import type { RunSummary } from "@agentgit/schemas";

import {
  RepositoryDetailSchema,
  RepositoryRunsResponseSchema,
  type ActivityEvent,
  type RepositoryDetail,
  type RepositoryRunListItem,
  type RunStatus,
} from "@/schemas/cloud";
import { buildLocalProviderRepositoryIdentity } from "@/lib/backend/providers/repository-identity";
import { findRepositoryRuntimeRecord } from "@/lib/backend/workspace/repository-inventory";

function normalizePathForComparison(input: string): string {
  const resolved = path.resolve(input);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function isSameOrNestedPath(candidate: string, base: string): boolean {
  const normalizedCandidate = normalizePathForComparison(candidate);
  const normalizedBase = normalizePathForComparison(base);
  return normalizedCandidate === normalizedBase || normalizedCandidate.startsWith(`${normalizedBase}${path.sep}`);
}

function getJournalPath(repoRoot: string): string {
  return path.join(repoRoot, ".agentgit", "state", "authority.db");
}

function listRunsForRepository(repoRoot: string): RunSummary[] {
  const journalPath = getJournalPath(repoRoot);
  if (!fs.existsSync(journalPath)) {
    return [];
  }

  const journal = new RunJournal({ dbPath: journalPath });
  try {
    return journal
      .listAllRuns()
      .filter((run) => run.workspace_roots.some((workspaceRoot) => isSameOrNestedPath(workspaceRoot, repoRoot)))
      .sort((left, right) => {
        const leftTimestamp = left.latest_event?.occurred_at ?? left.started_at;
        const rightTimestamp = right.latest_event?.occurred_at ?? right.started_at;
        return new Date(rightTimestamp).getTime() - new Date(leftTimestamp).getTime();
      });
  } finally {
    journal.close();
  }
}

function mapRunStatus(run: RunSummary): RunStatus {
  const eventType = run.latest_event?.event_type;
  switch (eventType) {
    case undefined:
    case null:
      return "queued";
    case "execution.failed":
    case "execution.outcome_unknown":
      return "failed";
    case "approval.requested":
    case "approval.resolved":
    case "action.normalized":
    case "policy.evaluated":
    case "execution.started":
    case "run.created":
    case "run.started":
    case "snapshot.created":
    case "checkpoint.created":
    case "recovery.planned":
      return "running";
    case "execution.completed":
    case "recovery.executed":
      return "completed";
    default:
      return "completed";
  }
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
        message: `A governed run failed in ${repoLabel}.`,
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

function mapRunSummary(run: RunSummary): RepositoryRunListItem {
  const updatedAt = run.latest_event?.occurred_at ?? run.started_at;
  const status = mapRunStatus(run);

  return {
    id: run.run_id,
    workflowName: run.workflow_name,
    agentName: `${run.agent_framework} / ${run.agent_name}`,
    status,
    startedAt: run.started_at,
    updatedAt,
    eventCount: run.event_count,
    summary: `${run.workflow_name} recorded ${run.event_count} event${run.event_count === 1 ? "" : "s"}.`,
  };
}

export function getRepositoryDetail(
  owner: string,
  name: string,
  workspaceId?: string,
): RepositoryDetail | null {
  const repository = findRepositoryRuntimeRecord(owner, name, workspaceId);
  if (!repository) {
    return null;
  }

  const runs = listRunsForRepository(repository.metadata.root);
  const recentActivity = runs
    .filter((run) => run.latest_event)
    .slice(0, 6)
    .map((run) => {
      const latestEvent = run.latest_event!;
      const repoLabel = `${repository.metadata.owner}/${repository.metadata.name}`;
      const description = describeEvent(latestEvent.event_type, repoLabel);

      return {
        id: `${run.run_id}:${latestEvent.sequence}`,
        message: description.message,
        repo: repoLabel,
        createdAt: latestEvent.occurred_at,
        tone: description.tone,
      };
    });
  const failedRuns24hCutoff = Date.now() - 24 * 60 * 60 * 1000;
  const failedRuns24h = runs.filter((run) => {
    const updatedAt = run.latest_event?.occurred_at ?? run.started_at;
    return mapRunStatus(run) === "failed" && new Date(updatedAt).getTime() >= failedRuns24hCutoff;
  }).length;

  return RepositoryDetailSchema.parse({
    id: repository.inventory.id,
    owner: repository.inventory.owner,
    name: repository.inventory.name,
    providerIdentity: buildLocalProviderRepositoryIdentity({
      provider: repository.metadata.provider,
      owner: repository.inventory.owner,
      name: repository.inventory.name,
      defaultBranch: repository.inventory.defaultBranch,
    }),
    defaultBranch: repository.inventory.defaultBranch,
    rootPath: repository.metadata.root,
    repositoryStatus: repository.inventory.repositoryStatus,
    lastRunStatus: repository.inventory.lastRunStatus,
    lastUpdatedAt: repository.inventory.lastUpdatedAt,
    agentStatus: repository.inventory.agentStatus,
    latestRunId: repository.latestRun?.run_id ?? undefined,
    latestWorkflowName: repository.latestRun?.workflow_name ?? undefined,
    pendingApprovalCount: repository.pendingApprovalCount,
    totalRuns: runs.length,
    failedRuns24h,
    recentActivity,
  });
}

export function listRepositoryRuns(owner: string, name: string, workspaceId?: string) {
  const repository = findRepositoryRuntimeRecord(owner, name, workspaceId);
  if (!repository) {
    return null;
  }

  const items = listRunsForRepository(repository.metadata.root).map(mapRunSummary);

  return RepositoryRunsResponseSchema.parse({
    items,
    total: items.length,
    page: 1,
    per_page: items.length === 0 ? 25 : items.length,
    has_more: false,
  });
}
