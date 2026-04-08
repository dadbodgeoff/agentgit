import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { vi } from "vitest";
import { RunJournal } from "@agentgit/run-journal";

vi.mock("server-only", () => ({}));

import { saveWorkspaceConnectionState } from "@/lib/backend/workspace/cloud-state";
import {
  listDiscoveredRepositoryInventory,
  listRepositoryInventory,
  listWorkspaceRepositoryOptions,
} from "@/lib/backend/workspace/repository-inventory";

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createRepo(remoteUrl: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-repo-"));

  runGit(["init", "-b", "main"], repoRoot);
  runGit(["config", "user.name", "AgentGit Test"], repoRoot);
  runGit(["config", "user.email", "tests@agentgit.dev"], repoRoot);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "# Test repo\n", "utf8");
  runGit(["add", "README.md"], repoRoot);
  runGit(["commit", "-m", "Initial commit"], repoRoot);
  runGit(["remote", "add", "origin", remoteUrl], repoRoot);

  return repoRoot;
}

function createRun(repoRoot: string, latestEventType: string): void {
  const journalPath = path.join(repoRoot, ".agentgit", "state", "authority.db");
  const journal = new RunJournal({ dbPath: journalPath });

  try {
    journal.registerRunLifecycle({
      run_id: `run_${Math.random().toString(16).slice(2, 10)}`,
      session_id: "sess_test",
      workflow_name: "repo-inventory-smoke",
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

    journal.appendRunEvent(journal.listAllRuns()[0]!.run_id, {
      event_type: latestEventType,
      occurred_at: "2026-04-06T14:32:34Z",
      recorded_at: "2026-04-06T14:32:34Z",
      payload: {},
    });
  } finally {
    journal.close();
  }
}

describe("repository inventory backend adapter", () => {
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

  it("builds repository inventory from git metadata and a completed run", async () => {
    const repoRoot = createRepo("git@github.com:acme/platform-ui.git");
    tempDirs.push(repoRoot);
    createRun(repoRoot, "execution.completed");
    process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS = repoRoot;
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-state-"));
    tempDirs.push(process.env.AGENTGIT_ROOT);

    const discoveredInventory = await listDiscoveredRepositoryInventory();
    await saveWorkspaceConnectionState({
      workspaceId: "ws_acme_01",
      workspaceName: "Acme platform",
      workspaceSlug: "acme-platform",
      repositoryIds: discoveredInventory.items.map((item) => item.id),
      members: [{ name: "Jordan Smith", email: "jordan@acme.dev", role: "owner" }],
      invites: [],
      defaultNotificationChannel: "slack",
      policyPack: "guarded",
      launchedAt: "2026-04-07T15:04:00Z",
    });

    const inventory = await listRepositoryInventory("ws_acme_01");

    expect(inventory.items).toHaveLength(1);
    expect(inventory.items[0]).toMatchObject({
      owner: "acme",
      name: "platform-ui",
      defaultBranch: "main",
      lastRunStatus: "completed",
      agentStatus: "healthy",
      repositoryStatus: "active",
    });
  });

  it("marks a repository escalated when the latest run failed", async () => {
    const repoRoot = createRepo("git@github.com:acme/api-gateway.git");
    tempDirs.push(repoRoot);
    createRun(repoRoot, "execution.failed");
    process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS = repoRoot;
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-state-"));
    tempDirs.push(process.env.AGENTGIT_ROOT);

    const discoveredInventory = await listDiscoveredRepositoryInventory();
    await saveWorkspaceConnectionState({
      workspaceId: "ws_acme_01",
      workspaceName: "Acme platform",
      workspaceSlug: "acme-platform",
      repositoryIds: discoveredInventory.items.map((item) => item.id),
      members: [{ name: "Jordan Smith", email: "jordan@acme.dev", role: "owner" }],
      invites: [],
      defaultNotificationChannel: "slack",
      policyPack: "guarded",
      launchedAt: "2026-04-07T15:04:00Z",
    });

    const inventory = await listRepositoryInventory("ws_acme_01");

    expect(inventory.items[0]).toMatchObject({
      owner: "acme",
      name: "api-gateway",
      lastRunStatus: "failed",
      agentStatus: "escalated",
    });
  });

  it("filters inventory down to repositories connected to the active workspace", async () => {
    const firstRepo = createRepo("git@github.com:acme/platform-ui.git");
    const secondRepo = createRepo("git@github.com:acme/api-gateway.git");
    tempDirs.push(firstRepo, secondRepo);
    createRun(firstRepo, "execution.completed");
    createRun(secondRepo, "execution.completed");
    process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS = [firstRepo, secondRepo].join(",");
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-state-"));
    tempDirs.push(process.env.AGENTGIT_ROOT);

    const fullInventory = await listDiscoveredRepositoryInventory();
    await saveWorkspaceConnectionState({
      workspaceId: "ws_acme_01",
      workspaceName: "Acme platform",
      workspaceSlug: "acme-platform",
      repositoryIds: [fullInventory.items[0]!.id],
      members: [{ name: "Jordan Smith", email: "jordan@acme.dev", role: "owner" }],
      invites: [],
      defaultNotificationChannel: "slack",
      policyPack: "guarded",
      launchedAt: "2026-04-07T15:04:00Z",
    });

    const filteredInventory = await listRepositoryInventory("ws_acme_01");

    expect(filteredInventory.items).toHaveLength(1);
    expect(filteredInventory.items[0]!.id).toBe(fullInventory.items[0]!.id);
  });

  it("returns no repositories when the workspace has no persisted repository scope", async () => {
    const repoRoot = createRepo("git@github.com:acme/platform-ui.git");
    tempDirs.push(repoRoot);
    createRun(repoRoot, "execution.completed");
    process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS = repoRoot;
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-state-"));
    tempDirs.push(process.env.AGENTGIT_ROOT);

    const inventory = await listRepositoryInventory("ws_unknown");

    expect(inventory.items).toHaveLength(0);
    expect(inventory.total).toBe(0);
  });

  it("only offers repository options that are unclaimed or already connected to the active workspace", async () => {
    const firstRepo = createRepo("git@github.com:acme/platform-ui.git");
    const secondRepo = createRepo("git@github.com:acme/api-gateway.git");
    tempDirs.push(firstRepo, secondRepo);
    createRun(firstRepo, "execution.completed");
    createRun(secondRepo, "execution.completed");
    process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS = [firstRepo, secondRepo].join(",");
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-state-"));
    tempDirs.push(process.env.AGENTGIT_ROOT);

    const discoveredInventory = await listDiscoveredRepositoryInventory();
    const platformUiId = discoveredInventory.items.find((item) => item.name === "platform-ui")?.id;
    const apiGatewayId = discoveredInventory.items.find((item) => item.name === "api-gateway")?.id;
    expect(platformUiId).toBeDefined();
    expect(apiGatewayId).toBeDefined();

    await saveWorkspaceConnectionState({
      workspaceId: "ws_current",
      workspaceName: "Current workspace",
      workspaceSlug: "current-workspace",
      repositoryIds: [platformUiId!],
      members: [{ name: "Jordan Smith", email: "jordan@acme.dev", role: "owner" }],
      invites: [],
      defaultNotificationChannel: "slack",
      policyPack: "guarded",
      launchedAt: "2026-04-07T15:04:00Z",
    });
    await saveWorkspaceConnectionState({
      workspaceId: "ws_other",
      workspaceName: "Other workspace",
      workspaceSlug: "other-workspace",
      repositoryIds: [apiGatewayId!],
      members: [{ name: "Taylor Jones", email: "taylor@acme.dev", role: "owner" }],
      invites: [],
      defaultNotificationChannel: "slack",
      policyPack: "guarded",
      launchedAt: "2026-04-07T15:04:00Z",
    });

    const repositoryOptions = await listWorkspaceRepositoryOptions("ws_current");

    expect(repositoryOptions.map((item) => item.name)).toEqual(["platform-ui"]);
  });
});
