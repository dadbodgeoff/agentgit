import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi, afterEach } from "vitest";
import { RunJournal } from "@agentgit/run-journal";

vi.mock("server-only", () => ({}));

import { saveWorkspaceConnectionState } from "@/lib/backend/workspace/cloud-state";
import { listDiscoveredRepositoryInventory } from "@/lib/backend/workspace/repository-inventory";
import {
  resolveRepositoryPolicy,
  saveRepositoryPolicy,
  validateRepositoryPolicyDocument,
} from "@/lib/backend/workspace/repository-policy";

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createRepo(remoteUrl: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-policy-"));

  runGit(["init", "-b", "main"], repoRoot);
  runGit(["config", "user.name", "AgentGit Test"], repoRoot);
  runGit(["config", "user.email", "tests@agentgit.dev"], repoRoot);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "# Policy test repo\n", "utf8");
  runGit(["add", "README.md"], repoRoot);
  runGit(["commit", "-m", "Initial commit"], repoRoot);
  runGit(["remote", "add", "origin", remoteUrl], repoRoot);

  return repoRoot;
}

describe("repository policy backend adapter", () => {
  const originalWorkspaceRoots = process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS;
  const originalAgentGitRoot = process.env.AGENTGIT_ROOT;
  const originalPolicyConfigPath = process.env.AGENTGIT_POLICY_CONFIG_PATH;
  const originalWorkspacePolicyPath = process.env.AGENTGIT_POLICY_WORKSPACE_CONFIG_PATH;
  const originalGeneratedPolicyPath = process.env.AGENTGIT_POLICY_CALIBRATION_CONFIG_PATH;
  const originalGlobalPolicyPath = process.env.AGENTGIT_POLICY_GLOBAL_CONFIG_PATH;
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

    if (originalPolicyConfigPath === undefined) {
      delete process.env.AGENTGIT_POLICY_CONFIG_PATH;
    } else {
      process.env.AGENTGIT_POLICY_CONFIG_PATH = originalPolicyConfigPath;
    }

    if (originalWorkspacePolicyPath === undefined) {
      delete process.env.AGENTGIT_POLICY_WORKSPACE_CONFIG_PATH;
    } else {
      process.env.AGENTGIT_POLICY_WORKSPACE_CONFIG_PATH = originalWorkspacePolicyPath;
    }

    if (originalGeneratedPolicyPath === undefined) {
      delete process.env.AGENTGIT_POLICY_CALIBRATION_CONFIG_PATH;
    } else {
      process.env.AGENTGIT_POLICY_CALIBRATION_CONFIG_PATH = originalGeneratedPolicyPath;
    }

    if (originalGlobalPolicyPath === undefined) {
      delete process.env.AGENTGIT_POLICY_GLOBAL_CONFIG_PATH;
    } else {
      process.env.AGENTGIT_POLICY_GLOBAL_CONFIG_PATH = originalGlobalPolicyPath;
    }

    for (const tempDir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves the built-in policy when no workspace override exists", async () => {
    const repoRoot = createRepo("git@github.com:acme/platform-ui.git");
    tempDirs.push(repoRoot);
    process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS = repoRoot;
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-state-"));
    tempDirs.push(process.env.AGENTGIT_ROOT);
    process.env.AGENTGIT_POLICY_GLOBAL_CONFIG_PATH = path.join(repoRoot, ".missing-global.toml");

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

    const policy = await resolveRepositoryPolicy("acme", "platform-ui", "ws_acme_01");

    expect(policy).not.toBeNull();
    expect(policy?.hasWorkspaceOverride).toBe(false);
    expect(policy?.workspaceConfig.profile_name).toBe("coding-agent-v1");
    expect(policy?.loadedSources.at(-1)?.scope).toBe("builtin_default");
  });

  it("persists a workspace policy override and returns the updated snapshot", async () => {
    const repoRoot = createRepo("git@github.com:acme/platform-ui.git");
    tempDirs.push(repoRoot);
    process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS = repoRoot;
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-state-"));
    tempDirs.push(process.env.AGENTGIT_ROOT);
    process.env.AGENTGIT_POLICY_GLOBAL_CONFIG_PATH = path.join(repoRoot, ".missing-global.toml");

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

    const result = await saveRepositoryPolicy(
      "acme",
      "platform-ui",
      JSON.stringify(
        {
          profile_name: "workspace-override",
          policy_version: "2026-04-07",
          thresholds: {
            low_confidence: [{ action_family: "shell/*", ask_below: 0.42 }],
          },
          rules: [],
        },
        null,
        2,
      ),
      "ws_acme_01",
    );

    expect(result).not.toBeNull();
    expect(result?.policy.hasWorkspaceOverride).toBe(true);
    expect(result?.policy.workspaceConfig.profile_name).toBe("workspace-override");
    expect(result?.policy.workspaceConfig.thresholds?.low_confidence[0]?.ask_below).toBe(0.42);
    expect(fs.existsSync(path.join(repoRoot, ".agentgit", "policy.toml"))).toBe(true);
  });

  it("returns validation issues for malformed policy documents", () => {
    const result = validateRepositoryPolicyDocument("{not json");

    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("degrades gracefully when calibration recommendations cannot be derived", async () => {
    const repoRoot = createRepo("git@github.com:acme/platform-ui.git");
    tempDirs.push(repoRoot);
    process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS = repoRoot;
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-state-"));
    tempDirs.push(process.env.AGENTGIT_ROOT);
    process.env.AGENTGIT_POLICY_GLOBAL_CONFIG_PATH = path.join(repoRoot, ".missing-global.toml");

    fs.mkdirSync(path.join(repoRoot, ".agentgit", "state"), { recursive: true });
    const journal = new RunJournal({
      dbPath: path.join(repoRoot, ".agentgit", "state", "authority.db"),
    });
    journal.close();

    const calibrationSpy = vi
      .spyOn(RunJournal.prototype, "getPolicyCalibrationReport")
      .mockImplementation(() => {
        throw new Error("calibration unavailable");
      });

    try {
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

      const policy = await resolveRepositoryPolicy("acme", "platform-ui", "ws_acme_01");

      expect(policy).not.toBeNull();
      expect(policy?.recommendations).toEqual([]);
    } finally {
      calibrationSpy.mockRestore();
    }
  });
});
