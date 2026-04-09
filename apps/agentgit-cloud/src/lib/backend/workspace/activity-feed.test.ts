import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withControlPlaneState } from "@/lib/backend/control-plane/state";
import { saveWorkspaceConnectionState } from "@/lib/backend/workspace/cloud-state";
import { listWorkspaceActivity } from "@/lib/backend/workspace/activity-feed";

describe("workspace activity feed", () => {
  const originalAgentGitRoot = process.env.AGENTGIT_ROOT;
  const originalWorkspaceRoots = process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS;
  const tempDirs: string[] = [];

  afterEach(() => {
    if (originalAgentGitRoot === undefined) {
      delete process.env.AGENTGIT_ROOT;
    } else {
      process.env.AGENTGIT_ROOT = originalAgentGitRoot;
    }

    if (originalWorkspaceRoots === undefined) {
      delete process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS;
    } else {
      process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS = originalWorkspaceRoots;
    }

    for (const tempDir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("projects synced connector run events when no local journal is available", async () => {
    process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS = "";
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-activity-"));
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

    const result = await listWorkspaceActivity("ws_acme_01", { limit: 25 });

    expect(result.items[0]).toMatchObject({
      kind: "run_failed",
      repo: "acme/platform-ui",
      runId: "run_01",
      actionId: "act_01",
      tone: "error",
    });
  });
});
