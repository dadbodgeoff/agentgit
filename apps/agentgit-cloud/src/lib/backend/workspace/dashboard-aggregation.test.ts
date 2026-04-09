import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { vi } from "vitest";
import { RunJournal } from "@agentgit/run-journal";

vi.mock("server-only", () => ({}));

import { saveWorkspaceConnectionState } from "@/lib/backend/workspace/cloud-state";
import { withControlPlaneState } from "@/lib/backend/control-plane/state";
import { getDashboardSummaryFromWorkspace } from "@/lib/backend/workspace/dashboard-aggregation";
import { listDiscoveredRepositoryInventory } from "@/lib/backend/workspace/repository-inventory";

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createRepo(remoteUrl: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-dashboard-"));

  runGit(["init", "-b", "main"], repoRoot);
  runGit(["config", "user.name", "AgentGit Test"], repoRoot);
  runGit(["config", "user.email", "tests@agentgit.dev"], repoRoot);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "# Dashboard repo\n", "utf8");
  runGit(["add", "README.md"], repoRoot);
  runGit(["commit", "-m", "Initial commit"], repoRoot);
  runGit(["remote", "add", "origin", remoteUrl], repoRoot);

  return repoRoot;
}

function createRun(repoRoot: string, latestEventType: string, occurredAt: string): void {
  const journalPath = path.join(repoRoot, ".agentgit", "state", "authority.db");
  const journal = new RunJournal({ dbPath: journalPath });

  try {
    const runId = `run_${Math.random().toString(16).slice(2, 10)}`;
    journal.registerRunLifecycle({
      run_id: runId,
      session_id: "sess_dashboard",
      workflow_name: "dashboard-smoke",
      agent_framework: "cloud",
      agent_name: "Codex",
      workspace_roots: [repoRoot],
      client_metadata: {},
      budget_config: {
        max_mutating_actions: null,
        max_destructive_actions: null,
      },
      created_at: "2026-04-06T14:30:00Z",
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

describe("dashboard workspace aggregation", () => {
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

  it("builds dashboard metrics and recent activity from workspace repositories", async () => {
    const completedRepo = createRepo("git@github.com:acme/platform-ui.git");
    const failedRepo = createRepo("git@github.com:acme/api-gateway.git");
    tempDirs.push(completedRepo, failedRepo);

    createRun(completedRepo, "execution.completed", "2026-04-06T14:32:34Z");
    createRun(failedRepo, "execution.failed", "2026-04-06T14:40:10Z");
    process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS = [completedRepo, failedRepo].join(",");
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-state-"));
    tempDirs.push(process.env.AGENTGIT_ROOT);

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

    const dashboard = await getDashboardSummaryFromWorkspace("ws_acme_01");

    expect(dashboard.metrics.map((metric) => metric.id)).toEqual([
      "connected_repos",
      "pending_approvals",
      "failed_runs",
    ]);
    expect(dashboard.recentRuns).toHaveLength(2);
    expect(dashboard.recentRuns[0]).toMatchObject({
      repo: "acme/api-gateway",
      status: "failed",
    });
    expect(dashboard.recentActivity[0]).toMatchObject({
      repo: "acme/api-gateway",
      tone: "error",
    });
  });

  it("respects the persisted workspace repository scope", async () => {
    const firstRepo = createRepo("git@github.com:acme/platform-ui.git");
    const secondRepo = createRepo("git@github.com:acme/api-gateway.git");
    tempDirs.push(firstRepo, secondRepo);
    createRun(firstRepo, "execution.completed", "2026-04-06T14:32:34Z");
    createRun(secondRepo, "execution.failed", "2026-04-06T14:40:10Z");
    process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS = [firstRepo, secondRepo].join(",");
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-state-"));
    tempDirs.push(process.env.AGENTGIT_ROOT);

    const inventory = await listDiscoveredRepositoryInventory();
    await saveWorkspaceConnectionState({
      workspaceId: "ws_acme_01",
      workspaceName: "Acme platform",
      workspaceSlug: "acme-platform",
      repositoryIds: [inventory.items.find((item) => item.name === "platform-ui")!.id],
      members: [{ name: "Jordan Smith", email: "jordan@acme.dev", role: "owner" }],
      invites: [],
      defaultNotificationChannel: "slack",
      policyPack: "guarded",
      launchedAt: "2026-04-07T15:04:00Z",
    });

    const dashboard = await getDashboardSummaryFromWorkspace("ws_acme_01");

    expect(dashboard.metrics.find((metric) => metric.id === "connected_repos")?.value).toBe("1");
    expect(dashboard.recentRuns).toHaveLength(1);
    expect(dashboard.recentRuns[0]!.repo).toBe("acme/platform-ui");
  });

  it("fails closed for workspaces without a persisted repository scope", async () => {
    const repoRoot = createRepo("git@github.com:acme/platform-ui.git");
    tempDirs.push(repoRoot);
    createRun(repoRoot, "execution.completed", "2026-04-06T14:32:34Z");
    process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS = repoRoot;
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-state-"));
    tempDirs.push(process.env.AGENTGIT_ROOT);

    const dashboard = await getDashboardSummaryFromWorkspace("ws_unknown");

    expect(dashboard.metrics.find((metric) => metric.id === "connected_repos")?.value).toBe("0");
    expect(dashboard.recentRuns).toHaveLength(0);
    expect(dashboard.recentActivity).toHaveLength(0);
  });

  it("projects connector-synced repositories and activity without shared journal access", async () => {
    process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS = "";
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-state-"));
    tempDirs.push(process.env.AGENTGIT_ROOT);

    await saveWorkspaceConnectionState({
      workspaceId: "ws_acme_01",
      workspaceName: "Acme platform",
      workspaceSlug: "acme-platform",
      repositoryIds: [],
      members: [{ name: "Jordan Smith", email: "jordan@acme.dev", role: "owner" }],
      invites: [],
      defaultNotificationChannel: "slack",
      policyPack: "guarded",
      launchedAt: "2026-04-07T15:04:00Z",
    });

    withControlPlaneState((store) => {
      store.putConnector({
        id: "conn_01",
        workspaceId: "ws_acme_01",
        workspaceSlug: "acme-platform",
        connectorName: "primary",
        machineName: "geoffrey-mbp",
        connectorVersion: "0.1.0",
        platform: {
          os: "darwin",
          arch: "arm64",
          hostname: "geoffrey-mbp",
        },
        capabilities: ["repo_state_sync", "run_event_sync"],
        repository: {
          provider: "github",
          repo: {
            owner: "acme",
            name: "platform-ui",
          },
          remoteUrl: "git@github.com:acme/platform-ui.git",
          defaultBranch: "main",
          currentBranch: "main",
          headSha: "abcdef1234567",
          isDirty: false,
          aheadBy: 0,
          behindBy: 0,
          workspaceRoot: "/Users/test/platform-ui",
          lastFetchedAt: null,
        },
        status: "active",
        registeredAt: "2026-04-07T18:00:00Z",
        lastSeenAt: "2026-04-07T18:05:00Z",
      });
      store.appendEvent({
        event: {
          schemaVersion: "cloud-sync.v1",
          eventId: "evt_run_failed_01",
          connectorId: "conn_01",
          workspaceId: "ws_acme_01",
          repository: {
            owner: "acme",
            name: "platform-ui",
          },
          sequence: 1,
          occurredAt: "2026-04-07T18:06:00Z",
          type: "run.event",
          payload: {
            runId: "run_01",
            event: {
              event_type: "execution.failed",
              occurred_at: "2026-04-07T18:06:00Z",
              payload: {
                action_id: "act_01",
              },
            },
          },
        },
        ingestedAt: "2026-04-07T18:06:05Z",
      });
    });

    const dashboard = await getDashboardSummaryFromWorkspace("ws_acme_01");

    expect(dashboard.metrics.find((metric) => metric.id === "connected_repos")?.value).toBe("1");
    expect(dashboard.recentRuns).toHaveLength(0);
    expect(dashboard.recentActivity[0]).toMatchObject({
      repo: "acme/platform-ui",
      kind: "run_failed",
      tone: "error",
    });
  });
});
