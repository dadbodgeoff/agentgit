import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { vi } from "vitest";

vi.mock("server-only", () => ({}));

import { saveWorkspaceConnectionState, getWorkspaceConnectionState } from "@/lib/backend/workspace/cloud-state";
import { resolveWorkspaceSettings, saveWorkspaceSettings } from "@/lib/backend/workspace/workspace-settings";
import type { WorkspaceSession } from "@/schemas/cloud";

function buildWorkspaceSession(): WorkspaceSession {
  return {
    user: {
      id: "user_01",
      name: "Jordan Smith",
      email: "jordan@acme.dev",
    },
    activeWorkspace: {
      id: "ws_acme_01",
      name: "Acme platform",
      slug: "acme-platform",
      role: "admin",
    },
  };
}

describe("workspace settings backend", () => {
  const originalAgentGitRoot = process.env.AGENTGIT_ROOT;
  const tempDirs: string[] = [];

  afterEach(() => {
    if (originalAgentGitRoot === undefined) {
      delete process.env.AGENTGIT_ROOT;
    } else {
      process.env.AGENTGIT_ROOT = originalAgentGitRoot;
    }

    for (const tempDir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("derives initial settings from the persisted onboarding workspace state", () => {
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-state-"));
    tempDirs.push(process.env.AGENTGIT_ROOT);

    saveWorkspaceConnectionState({
      workspaceId: "ws_acme_01",
      workspaceName: "Launch workspace",
      workspaceSlug: "launch-workspace",
      repositoryIds: ["repo_platform"],
      members: [{ name: "Jordan Smith", email: "jordan@acme.dev", role: "admin" }],
      invites: [],
      defaultNotificationChannel: "email",
      policyPack: "guarded",
      launchedAt: "2026-04-07T15:04:00Z",
    });

    const settings = resolveWorkspaceSettings(buildWorkspaceSession());

    expect(settings).toMatchObject({
      workspaceName: "Launch workspace",
      workspaceSlug: "launch-workspace",
      defaultNotificationChannel: "email",
      approvalTtlMinutes: 30,
      requireRejectComment: true,
    });
  });

  it("persists settings and syncs overlapping workspace identity fields", () => {
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-state-"));
    tempDirs.push(process.env.AGENTGIT_ROOT);

    saveWorkspaceConnectionState({
      workspaceId: "ws_acme_01",
      workspaceName: "Acme platform",
      workspaceSlug: "acme-platform",
      repositoryIds: ["repo_platform"],
      members: [{ name: "Jordan Smith", email: "jordan@acme.dev", role: "admin" }],
      invites: [],
      defaultNotificationChannel: "slack",
      policyPack: "guarded",
      launchedAt: "2026-04-07T15:04:00Z",
    });

    const response = saveWorkspaceSettings(buildWorkspaceSession(), {
      workspaceName: "Platform control",
      workspaceSlug: "platform-control",
      defaultNotificationChannel: "in_app",
      approvalTtlMinutes: 45,
      requireRejectComment: false,
      freezeDeploysOutsideBusinessHours: true,
    });

    const updatedWorkspace = getWorkspaceConnectionState("ws_acme_01");
    const resolvedSettings = resolveWorkspaceSettings(buildWorkspaceSession());

    expect(response.settings.workspaceName).toBe("Platform control");
    expect(updatedWorkspace).toMatchObject({
      workspaceName: "Platform control",
      workspaceSlug: "platform-control",
      defaultNotificationChannel: "in_app",
    });
    expect(resolvedSettings).toMatchObject({
      workspaceName: "Platform control",
      workspaceSlug: "platform-control",
      approvalTtlMinutes: 45,
      freezeDeploysOutsideBusinessHours: true,
    });
  });
});
