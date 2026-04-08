import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { RunJournal } from "@agentgit/run-journal";

vi.mock("server-only", () => ({}));

import { saveWorkspaceConnectionState } from "@/lib/backend/workspace/cloud-state";
import { listDiscoveredRepositoryInventory } from "@/lib/backend/workspace/repository-inventory";
import { listRepositorySnapshots } from "@/lib/backend/workspace/repository-snapshots";

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createRepo(remoteUrl: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-snapshots-"));

  runGit(["init", "-b", "main"], repoRoot);
  runGit(["config", "user.name", "AgentGit Test"], repoRoot);
  runGit(["config", "user.email", "tests@agentgit.dev"], repoRoot);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "# Snapshot test repo\n", "utf8");
  fs.writeFileSync(path.join(repoRoot, "restore-me.txt"), "restore me\n", "utf8");
  runGit(["add", "README.md", "restore-me.txt"], repoRoot);
  runGit(["commit", "-m", "Initial commit"], repoRoot);
  runGit(["remote", "add", "origin", remoteUrl], repoRoot);

  return repoRoot;
}

function seedSnapshotRecord(params: {
  repoRoot: string;
  runId: string;
  workflowName: string;
  actionId: string;
  snapshotId: string;
  includeRecovery?: boolean;
}): void {
  const journalPath = path.join(params.repoRoot, ".agentgit", "state", "authority.db");
  const journal = new RunJournal({ dbPath: journalPath });
  const targetPath = path.join(params.repoRoot, "restore-me.txt");

  try {
    journal.registerRunLifecycle({
      run_id: params.runId,
      session_id: "sess_snapshot_tests",
      workflow_name: params.workflowName,
      agent_framework: "cloud",
      agent_name: "Codex",
      workspace_roots: [params.repoRoot],
      client_metadata: {},
      budget_config: {
        max_mutating_actions: null,
        max_destructive_actions: null,
      },
      created_at: "2026-04-07T15:00:00Z",
    });

    journal.appendRunEvent(params.runId, {
      event_type: "action.normalized",
      occurred_at: "2026-04-07T15:00:01Z",
      recorded_at: "2026-04-07T15:00:01Z",
      payload: {
        action_id: params.actionId,
        target_locator: targetPath,
        action: {
          operation: {
            domain: "filesystem",
            kind: "delete_file",
            display_name: "Delete restore-me.txt",
          },
          target: {
            primary: {
              locator: targetPath,
            },
          },
        },
      },
    });

    journal.appendRunEvent(params.runId, {
      event_type: "snapshot.created",
      occurred_at: "2026-04-07T15:00:02Z",
      recorded_at: "2026-04-07T15:00:02Z",
      payload: {
        action_id: params.actionId,
        snapshot_id: params.snapshotId,
        snapshot_class: "metadata_only",
        fidelity: "metadata_only",
      },
    });

    if (params.includeRecovery) {
      journal.appendRunEvent(params.runId, {
        event_type: "recovery.executed",
        occurred_at: "2026-04-07T15:04:00Z",
        recorded_at: "2026-04-07T15:04:00Z",
        payload: {
          snapshot_id: params.snapshotId,
          outcome: "restored",
          recovery_class: "reversible",
          strategy: "restore_snapshot",
        },
      });
    }
  } finally {
    journal.close();
  }

  const manifestPath = path.join(
    params.repoRoot,
    ".agentgit",
    "state",
    "snapshots",
    "metadata",
    `${params.snapshotId}.json`,
  );
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        snapshot_id: params.snapshotId,
        action_id: params.actionId,
        run_id: params.runId,
        target_path: targetPath,
        workspace_root: params.repoRoot,
        existed_before: true,
        entry_kind: "file",
        snapshot_class: "metadata_only",
        fidelity: "metadata_only",
        created_at: "2026-04-07T15:00:02Z",
        action_display_name: "Delete restore-me.txt",
        operation_domain: "filesystem",
        operation_kind: "delete_file",
      },
      null,
      2,
    ),
    "utf8",
  );
}

describe("repository snapshots backend adapter", () => {
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

  it("derives repository snapshots from the journal and snapshot manifests", async () => {
    const repoRoot = createRepo("git@github.com:acme/platform-ui.git");
    tempDirs.push(repoRoot);
    process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS = repoRoot;
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-state-"));
    tempDirs.push(process.env.AGENTGIT_ROOT);

    seedSnapshotRecord({
      repoRoot,
      runId: "run_snapshot_01",
      workflowName: "snapshot-smoke",
      actionId: "act_snapshot_01",
      snapshotId: "snap_snapshot_01",
      includeRecovery: true,
    });

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

    const snapshots = await listRepositorySnapshots("acme", "platform-ui", "ws_acme_01");
    expect(snapshots).not.toBeNull();
    expect(snapshots?.items).toHaveLength(1);
    expect(snapshots?.items[0]).toMatchObject({
      snapshotId: "snap_snapshot_01",
      actionSummary: "Delete restore-me.txt",
      targetLocator: path.join(repoRoot, "restore-me.txt"),
      integrityStatus: "verified",
    });
    expect(snapshots?.items[0]?.latestRecovery?.strategy).toBe("restore_snapshot");
    expect(snapshots?.restorableCount).toBe(1);
    expect(snapshots?.restoredCount).toBe(1);
  });

  it("returns an empty inventory when a repository has no recorded snapshots", async () => {
    const repoRoot = createRepo("git@github.com:acme/api-gateway.git");
    tempDirs.push(repoRoot);
    process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS = repoRoot;
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

    const snapshots = await listRepositorySnapshots("acme", "api-gateway", "ws_acme_01");

    expect(snapshots).not.toBeNull();
    expect(snapshots?.items).toHaveLength(0);
    expect(snapshots?.total).toBe(0);
  });
});
