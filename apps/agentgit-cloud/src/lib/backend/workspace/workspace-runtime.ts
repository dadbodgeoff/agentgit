import "server-only";

import fs from "node:fs";
import path from "node:path";

import { RunJournal, type RunJournalEventRecord } from "@agentgit/run-journal";
import type { ApprovalRequest, RunSummary } from "@agentgit/schemas";

import {
  collectWorkspaceRepositoryRuntimeRecords,
  type WorkspaceRepositoryRuntimeRecord,
} from "@/lib/backend/workspace/repository-inventory";

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

export function getRepositoryJournalPath(repoRoot: string): string {
  return path.join(repoRoot, ".agentgit", "state", "authority.db");
}

export type WorkspaceRunContext = {
  repository: WorkspaceRepositoryRuntimeRecord;
  run: RunSummary;
  events: RunJournalEventRecord[];
};

export async function listWorkspaceRunContexts(workspaceId: string): Promise<WorkspaceRunContext[]> {
  const contexts: WorkspaceRunContext[] = [];

  for (const repository of await collectWorkspaceRepositoryRuntimeRecords(workspaceId)) {
    const journalPath = getRepositoryJournalPath(repository.metadata.root);
    if (!fs.existsSync(journalPath)) {
      continue;
    }

    const journal = new RunJournal({ dbPath: journalPath });
    try {
      const runs = journal
        .listAllRuns()
        .filter((run) => run.workspace_roots.some((workspaceRoot) => isSameOrNestedPath(workspaceRoot, repository.metadata.root)))
        .sort((left, right) => {
          const leftTimestamp = left.latest_event?.occurred_at ?? left.started_at;
          const rightTimestamp = right.latest_event?.occurred_at ?? right.started_at;
          return new Date(rightTimestamp).getTime() - new Date(leftTimestamp).getTime();
        });

      for (const run of runs) {
        contexts.push({
          repository,
          run,
          events: journal.listRunEvents(run.run_id),
        });
      }
    } finally {
      journal.close();
    }
  }

  return contexts.sort((left, right) => {
    const leftTimestamp = left.run.latest_event?.occurred_at ?? left.run.started_at;
    const rightTimestamp = right.run.latest_event?.occurred_at ?? right.run.started_at;
    return new Date(rightTimestamp).getTime() - new Date(leftTimestamp).getTime();
  });
}

export async function listWorkspaceApprovals(workspaceId: string): Promise<Array<{
  repository: WorkspaceRepositoryRuntimeRecord;
  approval: ApprovalRequest;
}>> {
  const approvals: Array<{
    repository: WorkspaceRepositoryRuntimeRecord;
    approval: ApprovalRequest;
  }> = [];

  for (const repository of await collectWorkspaceRepositoryRuntimeRecords(workspaceId)) {
    const journalPath = getRepositoryJournalPath(repository.metadata.root);
    if (!fs.existsSync(journalPath)) {
      continue;
    }

    const journal = new RunJournal({ dbPath: journalPath });
    try {
      for (const approval of journal.listApprovals()) {
        approvals.push({
          repository,
          approval,
        });
      }
    } finally {
      journal.close();
    }
  }

  return approvals.sort(
    (left, right) => new Date(right.approval.requested_at).getTime() - new Date(left.approval.requested_at).getTime(),
  );
}

export async function findWorkspaceRunContext(runId: string, workspaceId: string): Promise<WorkspaceRunContext | null> {
  return (await listWorkspaceRunContexts(workspaceId)).find((context) => context.run.run_id === runId) ?? null;
}
