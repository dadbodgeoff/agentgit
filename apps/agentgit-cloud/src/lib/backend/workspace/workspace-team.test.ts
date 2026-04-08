import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getWorkspaceConnectionState, saveWorkspaceConnectionState } from "@/lib/backend/workspace/cloud-state";
import { resolveWorkspaceTeam, saveWorkspaceTeam } from "@/lib/backend/workspace/workspace-team";
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

describe("workspace team backend", () => {
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

  it("resolves the active member and pending invites from workspace state", async () => {
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-team-"));
    tempDirs.push(process.env.AGENTGIT_ROOT);

    await saveWorkspaceConnectionState({
      workspaceId: "ws_acme_01",
      workspaceName: "Acme platform",
      workspaceSlug: "acme-platform",
      repositoryIds: [],
      members: [{ name: "Jordan Smith", email: "jordan@acme.dev", role: "admin" }],
      invites: [{ name: "Riley", email: "riley@acme.dev", role: "member" }],
      defaultNotificationChannel: "slack",
      policyPack: "guarded",
      launchedAt: "2026-04-07T15:04:00Z",
    });

    const snapshot = await resolveWorkspaceTeam(buildWorkspaceSession());

    expect(snapshot.workspaceSlug).toBe("acme-platform");
    expect(snapshot.members).toHaveLength(2);
    expect(snapshot.members.find((member) => member.status === "active")?.email).toBe("jordan@acme.dev");
    expect(snapshot.members.find((member) => member.status === "invited")?.email).toBe("riley@acme.dev");
  });

  it("persists invite updates back into workspace state", async () => {
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-team-"));
    tempDirs.push(process.env.AGENTGIT_ROOT);

    const response = await saveWorkspaceTeam(buildWorkspaceSession(), {
      invites: [
        { name: "Riley", email: "riley@acme.dev", role: "member" },
        { name: "Ari", email: "ari@acme.dev", role: "admin" },
      ],
    });

    expect(response.team.members.filter((member) => member.status === "invited")).toHaveLength(2);
    expect(response.message).toContain("workspace state");
    expect((await getWorkspaceConnectionState("ws_acme_01"))?.repositoryIds).toEqual([]);
  });

  it("fails closed on repository visibility before onboarding state exists", async () => {
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-team-"));
    tempDirs.push(process.env.AGENTGIT_ROOT);

    const response = await saveWorkspaceTeam(buildWorkspaceSession(), {
      invites: [{ name: "Riley", email: "riley@acme.dev", role: "member" }],
    });

    expect(response.team.members.filter((member) => member.status === "invited")).toHaveLength(1);
    expect((await getWorkspaceConnectionState("ws_acme_01"))?.repositoryIds).toEqual([]);
  });
});
