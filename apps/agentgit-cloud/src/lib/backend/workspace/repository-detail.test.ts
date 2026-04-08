import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { vi } from "vitest";
import { RunJournal } from "@agentgit/run-journal";

vi.mock("server-only", () => ({}));

import { saveWorkspaceConnectionState } from "@/lib/backend/workspace/cloud-state";
import { getRepositoryDetail, listRepositoryRuns } from "@/lib/backend/workspace/repository-detail";
import { listDiscoveredRepositoryInventory } from "@/lib/backend/workspace/repository-inventory";

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createRepo(remoteUrl: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-repo-detail-"));

  runGit(["init", "-b", "main"], repoRoot);
  runGit(["config", "user.name", "AgentGit Test"], repoRoot);
  runGit(["config", "user.email", "tests@agentgit.dev"], repoRoot);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "# Repository detail\n", "utf8");
  runGit(["add", "README.md"], repoRoot);
  runGit(["commit", "-m", "Initial commit"], repoRoot);
  runGit(["remote", "add", "origin", remoteUrl], repoRoot);

  return repoRoot;
}

function createRun(repoRoot: string, workflowName: string, latestEventType: string, occurredAt: string): void {
  const journalPath = path.join(repoRoot, ".agentgit", "state", "authority.db");
  const journal = new RunJournal({ dbPath: journalPath });

  try {
    const runId = `run_${Math.random().toString(16).slice(2, 10)}`;
    journal.registerRunLifecycle({
      run_id: runId,
      session_id: "sess_repo_detail",
      workflow_name: workflowName,
      agent_framework: "cloud",
      agent_name: "Codex",
      workspace_roots: [repoRoot],
      client_metadata: {},
      budget_config: {
        max_mutating_actions: null,
        max_destructive_actions: null,
      },
      created_at: occurredAt,
    });

    journal.appendRunEvent(runId, {
      event_type: latestEventType,
      occurred_at: occurredAt,
      recorded_at: occurredAt,
      payload: {},
    });
  } finally {
    journal.close();
  }
}

describe("repository detail backend adapter", () => {
  const originalWorkspaceRoots = process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS;
  const originalAgentGitRoot = process.env.AGENTGIT_ROOT;
  const tempDirs: string[] = [];

  afterEach(() => {
    if (originalWorkspaceRoots === undefined) {
      delete process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS;
    } else {
      process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS = originalWorkspaceRoots;
    }

    if (originalAgentGitRoot === undefined) {
      delete process.env.AGENTGIT_ROOT;
    } else {
      process.env.AGENTGIT_ROOT = originalAgentGitRoot;
    }

    for (const tempDir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("builds repository detail and run history from the governed journal", async () => {
    const repoRoot = createRepo("git@github.com:acme/platform-ui.git");
    tempDirs.push(repoRoot);
    process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS = repoRoot;
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-state-"));
    tempDirs.push(process.env.AGENTGIT_ROOT);

    createRun(repoRoot, "sync-policies", "execution.completed", "2026-04-06T14:32:34Z");
    createRun(repoRoot, "deploy-preview", "execution.failed", "2026-04-06T15:10:00Z");

    const inventory = await listDiscoveredRepositoryInventory();
    await saveWorkspaceConnectionState({
      workspaceId: "ws_acme_01",
      workspaceName: "Acme platform",
      workspaceSlug: "acme-platform",
      repositoryIds: inventory.items.map((item) => item.id),
      members: [{ name: "Jordan Smith", email: "jordan@acme.dev", role: "owner" }],
      invites: [],
      defaultNotificationChannel: "slack",
      policyPack: "guarded",
      launchedAt: "2026-04-07T15:04:00Z",
    });

    const detail = await getRepositoryDetail("acme", "platform-ui", "ws_acme_01");
    const runs = await listRepositoryRuns("acme", "platform-ui", "ws_acme_01");

    expect(detail).toMatchObject({
      owner: "acme",
      name: "platform-ui",
      totalRuns: 2,
      lastRunStatus: "failed",
    });
    expect(detail?.recentActivity[0]?.tone).toBe("error");
    expect(runs?.items).toHaveLength(2);
    expect(runs?.items[0]).toMatchObject({
      workflowName: "deploy-preview",
      status: "failed",
    });
  });
});
