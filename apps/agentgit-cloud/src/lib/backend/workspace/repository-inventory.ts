import "server-only";

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { RunJournal } from "@agentgit/run-journal";
import type { RunSummary } from "@agentgit/schemas";

import { RepositoryListResponseSchema, type AgentStatus, type RepositoryListItem, type RunStatus } from "@/schemas/cloud";
import { buildLocalProviderRepositoryIdentity } from "@/lib/backend/providers/repository-identity";
import { getWorkspaceConnectionState } from "@/lib/backend/workspace/cloud-state";
import { resolveWorkspaceRoots } from "@/lib/backend/workspace/roots";

type GitRepositoryMetadata = {
  root: string;
  provider: "github" | "gitlab" | "bitbucket" | "local";
  owner: string;
  name: string;
  defaultBranch: string;
  lastCommitAt: string;
};

export type WorkspaceRepositoryRuntimeRecord = {
  metadata: GitRepositoryMetadata;
  latestRun: RunSummary | null;
  pendingApprovalCount: number;
  inventory: RepositoryListItem;
};

function filterRecordsForWorkspace(
  records: WorkspaceRepositoryRuntimeRecord[],
  workspaceId?: string,
): WorkspaceRepositoryRuntimeRecord[] {
  if (!workspaceId) {
    return records;
  }

  const workspaceState = getWorkspaceConnectionState(workspaceId);
  if (!workspaceState) {
    return [];
  }

  const allowedRepositoryIds = new Set(workspaceState.repositoryIds);
  return records.filter((record) => allowedRepositoryIds.has(record.inventory.id));
}

function tryExecGit(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

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

function parseGitRemote(remoteUrl: string | null, repoRoot: string): {
  owner: string;
  name: string;
  provider: GitRepositoryMetadata["provider"];
} {
  const fallback = {
    owner: path.basename(path.dirname(repoRoot)) || "local",
    name: path.basename(repoRoot) || "workspace",
    provider: "local" as const,
  };

  if (!remoteUrl) {
    return fallback;
  }

  const trimmed = remoteUrl.trim();
  const provider = trimmed.includes("github.com")
    ? "github"
    : trimmed.includes("gitlab")
      ? "gitlab"
      : trimmed.includes("bitbucket")
        ? "bitbucket"
        : "local";
  const sshMatch = trimmed.match(/^[^@]+@[^:]+:(.+)$/);
  const target = sshMatch ? sshMatch[1] : trimmed;

  try {
    const pathname = target.startsWith("http://") || target.startsWith("https://") ? new URL(target).pathname : target;
    const segments = pathname
      .replace(/^\/+/, "")
      .replace(/\.git$/, "")
      .split("/")
      .filter((segment) => segment.length > 0);

    if (segments.length >= 2) {
      return {
        owner: segments[segments.length - 2],
        name: segments[segments.length - 1],
        provider,
      };
    }
  } catch {
    return fallback;
  }

  return fallback;
}

function resolveDefaultBranch(repoRoot: string): string {
  const remoteHead = tryExecGit(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repoRoot);
  if (remoteHead?.includes("/")) {
    return remoteHead.split("/").pop() ?? "main";
  }

  const currentBranch = tryExecGit(["branch", "--show-current"], repoRoot);
  if (currentBranch) {
    return currentBranch;
  }

  return "main";
}

function getGitMetadata(workspaceRoot: string): GitRepositoryMetadata | null {
  const repoRoot = tryExecGit(["rev-parse", "--show-toplevel"], workspaceRoot);
  if (!repoRoot) {
    return null;
  }

  const remoteUrl = tryExecGit(["config", "--get", "remote.origin.url"], repoRoot);
  const identity = parseGitRemote(remoteUrl, repoRoot);
  const lastCommitAt = tryExecGit(["log", "-1", "--format=%cI"], repoRoot) || new Date().toISOString();

  return {
    root: repoRoot,
    provider: identity.provider,
    owner: identity.owner,
    name: identity.name,
    defaultBranch: resolveDefaultBranch(repoRoot),
    lastCommitAt,
  };
}

function deriveRunStatus(run: RunSummary | null): RunStatus {
  const eventType = run?.latest_event?.event_type;
  switch (eventType) {
    case null:
    case undefined:
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

function deriveAgentStatus(params: {
  latestRun: RunSummary | null;
  lastRunStatus: RunStatus;
  pendingApprovalCount: number;
  lastUpdatedAt: string;
}): AgentStatus {
  if (params.pendingApprovalCount > 0 || params.lastRunStatus === "failed") {
    return "escalated";
  }

  if (!params.latestRun) {
    return "idle";
  }

  const ageMs = Date.now() - new Date(params.lastUpdatedAt).getTime();
  if (ageMs > 7 * 24 * 60 * 60 * 1000) {
    return "idle";
  }

  return "healthy";
}

function buildRepositoryId(input: { owner: string; name: string; root: string }): string {
  const digest = createHash("sha256").update(`${input.owner}/${input.name}:${input.root}`, "utf8").digest("hex");
  return `repo_${digest.slice(0, 12)}`;
}

function getJournalPath(repoRoot: string): string {
  return path.join(repoRoot, ".agentgit", "state", "authority.db");
}

function getRunsForRepository(journal: RunJournal, repoRoot: string): RunSummary[] {
  return journal
    .listAllRuns()
    .filter((run) => run.workspace_roots.some((workspaceRoot) => isSameOrNestedPath(workspaceRoot, repoRoot)));
}

function getLatestRun(runs: RunSummary[]): RunSummary | null {
  if (runs.length === 0) {
    return null;
  }

  return runs.reduce((latest, current) => {
    const latestTimestamp = latest.latest_event?.occurred_at ?? latest.started_at;
    const currentTimestamp = current.latest_event?.occurred_at ?? current.started_at;
    return new Date(currentTimestamp).getTime() > new Date(latestTimestamp).getTime() ? current : latest;
  });
}

function getPendingApprovalCount(journal: RunJournal, runs: RunSummary[]): number {
  if (runs.length === 0) {
    return 0;
  }

  const runIds = new Set(runs.map((run) => run.run_id));
  return journal.listApprovals({ status: "pending" }).filter((approval) => runIds.has(approval.run_id)).length;
}

function buildRepositoryRuntimeRecord(workspaceRoot: string): WorkspaceRepositoryRuntimeRecord | null {
  const metadata = getGitMetadata(workspaceRoot);
  if (!metadata) {
    return null;
  }

  let latestRun: RunSummary | null = null;
  let pendingApprovalCount = 0;

  const journalPath = getJournalPath(metadata.root);
  if (fs.existsSync(journalPath)) {
    const journal = new RunJournal({ dbPath: journalPath });
    try {
      const runs = getRunsForRepository(journal, metadata.root);
      latestRun = getLatestRun(runs);
      pendingApprovalCount = getPendingApprovalCount(journal, runs);
    } finally {
      journal.close();
    }
  }

  const lastRunStatus = deriveRunStatus(latestRun);
  const lastUpdatedAt = latestRun?.latest_event?.occurred_at ?? latestRun?.started_at ?? metadata.lastCommitAt;

  return {
    metadata,
    latestRun,
    pendingApprovalCount,
    inventory: {
      id: buildRepositoryId({
        owner: metadata.owner,
        name: metadata.name,
        root: metadata.root,
      }),
      owner: metadata.owner,
      name: metadata.name,
      provider: metadata.provider,
      providerIdentityStatus: "local_only",
      providerRepositoryUrl: null,
      providerVisibility: "unknown",
      providerVerifiedAt: null,
      providerStatusReason: buildLocalProviderRepositoryIdentity({
        provider: metadata.provider,
        owner: metadata.owner,
        name: metadata.name,
        defaultBranch: metadata.defaultBranch,
      }).statusReason,
      defaultBranch: metadata.defaultBranch,
      repositoryStatus: "active",
      lastRunStatus,
      lastUpdatedAt,
      agentStatus: deriveAgentStatus({
        latestRun,
        lastRunStatus,
        pendingApprovalCount,
        lastUpdatedAt,
      }),
    },
  };
}

export function collectWorkspaceRepositoryRuntimeRecords(workspaceId?: string): WorkspaceRepositoryRuntimeRecord[] {
  const records = resolveWorkspaceRoots()
    .map((workspaceRoot) => buildRepositoryRuntimeRecord(workspaceRoot))
    .filter((repository): repository is WorkspaceRepositoryRuntimeRecord => repository !== null)
    .sort(
      (left, right) =>
        new Date(right.inventory.lastUpdatedAt).getTime() - new Date(left.inventory.lastUpdatedAt).getTime(),
    );

  return filterRecordsForWorkspace(records, workspaceId);
}

export function listRepositoryInventory(workspaceId?: string) {
  const repositories = collectWorkspaceRepositoryRuntimeRecords(workspaceId).map((record) => record.inventory);

  return RepositoryListResponseSchema.parse({
    items: repositories,
    total: repositories.length,
    page: 1,
    per_page: repositories.length === 0 ? 25 : repositories.length,
    has_more: false,
  });
}

export function listAllRepositoryOptions() {
  return collectWorkspaceRepositoryRuntimeRecords().map((record) => ({
    id: record.inventory.id,
    owner: record.inventory.owner,
    name: record.inventory.name,
    defaultBranch: record.inventory.defaultBranch,
    description:
      record.latestRun?.workflow_name
        ? `Latest workflow: ${record.latestRun.workflow_name}.`
        : `Governed repository rooted at ${record.metadata.root}.`,
    requiresOrgApproval: false,
  }));
}

export function findRepositoryRuntimeRecord(
  owner: string,
  name: string,
  workspaceId?: string,
): WorkspaceRepositoryRuntimeRecord | null {
  return (
    collectWorkspaceRepositoryRuntimeRecords(workspaceId).find(
      (record) => record.inventory.owner === owner && record.inventory.name === name,
    ) ?? null
  );
}

export function findRepositoryRuntimeRecordById(
  repoId: string,
  workspaceId?: string,
): WorkspaceRepositoryRuntimeRecord | null {
  return collectWorkspaceRepositoryRuntimeRecords(workspaceId).find((record) => record.inventory.id === repoId) ?? null;
}
