import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { withWorkspaceAuthorityClient } = vi.hoisted(() => ({
  withWorkspaceAuthorityClient: vi.fn(),
}));

vi.mock("@/lib/backend/authority/client", () => ({
  withWorkspaceAuthorityClient,
}));

import { RunJournal } from "@agentgit/run-journal";

import { saveWorkspaceConnectionState } from "@/lib/backend/workspace/cloud-state";
import { listDiscoveredRepositoryInventory } from "@/lib/backend/workspace/repository-inventory";
import { getRunReplayPreview } from "@/lib/backend/workspace/run-replay";

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createRepo(remoteUrl: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-replay-"));

  runGit(["init", "-b", "main"], repoRoot);
  runGit(["config", "user.name", "AgentGit Test"], repoRoot);
  runGit(["config", "user.email", "tests@agentgit.dev"], repoRoot);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "# Replay test repo\n", "utf8");
  runGit(["add", "README.md"], repoRoot);
  runGit(["commit", "-m", "Initial commit"], repoRoot);
  runGit(["remote", "add", "origin", remoteUrl], repoRoot);

  return repoRoot;
}

describe("run replay preview", () => {
  const originalWorkspaceRoots = process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS;
  const originalAgentGitRoot = process.env.AGENTGIT_ROOT;
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.clearAllMocks();

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

  it("builds a replay preview from journaled governed actions", async () => {
    const repoRoot = createRepo("git@github.com:acme/platform-ui.git");
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

    const journalPath = path.join(repoRoot, ".agentgit", "state", "authority.db");
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    const journal = new RunJournal({ dbPath: journalPath });
    journal.registerRunLifecycle({
      run_id: "run_replay_01",
      session_id: "sess_replay_01",
      workflow_name: "release",
      agent_framework: "codex",
      agent_name: "Codex",
      workspace_roots: [repoRoot],
      client_metadata: {},
      budget_config: {
        max_mutating_actions: null,
        max_destructive_actions: null,
      },
      created_at: "2026-04-08T12:00:00Z",
    });
    journal.appendRunEvent("run_replay_01", {
      event_type: "action.normalized",
      occurred_at: "2026-04-08T12:00:01Z",
      recorded_at: "2026-04-08T12:00:01Z",
      payload: {
        action: {
          schema_version: "action.v1",
          action_id: "act_replay_01",
          run_id: "run_replay_01",
          session_id: "sess_replay_01",
          status: "normalized",
          timestamps: {
            requested_at: "2026-04-08T12:00:01Z",
            normalized_at: "2026-04-08T12:00:01Z",
          },
          provenance: {
            mode: "governed",
            source: "agent",
            confidence: 0.98,
          },
          actor: {
            type: "agent",
            agent_name: "Codex",
            agent_framework: "codex",
            tool_name: "write_file",
            tool_kind: "filesystem",
          },
          operation: {
            domain: "filesystem",
            kind: "write",
            name: "write_file",
            display_name: "Write README",
          },
          execution_path: {
            surface: "governed_fs",
            mode: "pre_execution",
            credential_mode: "none",
          },
          target: {
            primary: {
              type: "path",
              locator: path.join(repoRoot, "README.md"),
              label: "README.md",
            },
            scope: {
              breadth: "single",
              unknowns: [],
            },
          },
          input: {
            raw: {
              path: path.join(repoRoot, "README.md"),
              content: "# Replay test repo\n\nUpdated.\n",
            },
            redacted: {
              path: path.join(repoRoot, "README.md"),
            },
            schema_ref: null,
            contains_sensitive_data: false,
          },
          risk_hints: {
            side_effect_level: "mutating",
            external_effects: "none",
            reversibility_hint: "reversible",
            sensitivity_hint: "low",
            batch: false,
          },
          facets: {},
          normalization: {
            mapper: "test",
            inferred_fields: [],
            warnings: [],
            normalization_confidence: 0.99,
          },
          confidence_assessment: {
            engine_version: "test",
            score: 0.96,
            band: "high",
            requires_human_review: false,
            factors: [],
          },
        },
      },
    });
    journal.appendRunEvent("run_replay_01", {
      event_type: "policy.evaluated",
      occurred_at: "2026-04-08T12:00:01Z",
      recorded_at: "2026-04-08T12:00:01Z",
      payload: {
        action_id: "act_replay_01",
        decision: "allow",
      },
    });
    journal.close();

    withWorkspaceAuthorityClient.mockImplementation(async (_workspaceId, callback) =>
      callback({
        queryHelper: vi.fn().mockResolvedValue({
          answer: "The run completed cleanly.",
        }),
      }),
    );

    const preview = await getRunReplayPreview("acme", "platform-ui", "ws_acme_01", "run_replay_01");

    expect(preview).not.toBeNull();
    expect(preview?.replayMode).toBe("exact");
    expect(preview?.replayableActionCount).toBe(1);
    expect(preview?.actions[0]?.sourceActionId).toBe("act_replay_01");
    expect(preview?.helperSummary).toBe("The run completed cleanly.");
  });
});
