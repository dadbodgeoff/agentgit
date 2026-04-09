import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiRole = vi.fn();
const getWorkspaceConnectionState = vi.fn();
const saveWorkspaceConnectionState = vi.fn();
const listWorkspaceRepositoryOptions = vi.fn();
const isWorkspaceSlugOwnedByAnotherWorkspace = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiRole,
}));

vi.mock("@/lib/backend/workspace/cloud-state", () => ({
  getWorkspaceConnectionState,
  saveWorkspaceConnectionState,
}));

vi.mock("@/lib/backend/workspace/repository-inventory", () => ({
  listWorkspaceRepositoryOptions,
}));

vi.mock("@/lib/backend/workspace/workspace-scope", () => ({
  isWorkspaceSlugOwnedByAnotherWorkspace,
}));

describe("onboarding route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getWorkspaceConnectionState.mockResolvedValue(null);
    listWorkspaceRepositoryOptions.mockResolvedValue([
      {
        id: "repo_01",
        owner: "acme",
        name: "platform-ui",
        defaultBranch: "main",
        description: "Platform repo",
        requiresOrgApproval: false,
      },
    ]);
    isWorkspaceSlugOwnedByAnotherWorkspace.mockResolvedValue(false);
  });

  it("persists onboarding with an explicit owner membership", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        user: { id: "usr_01", name: "Jordan Smith", email: "jordan@acme.dev" },
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "owner" },
      },
    });
    saveWorkspaceConnectionState.mockResolvedValue({
      workspaceId: "ws_acme_01",
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/v1/onboarding", {
        method: "POST",
        body: JSON.stringify({
          workspaceName: "Acme Platform",
          workspaceSlug: "acme-platform",
          repositoryIds: ["repo_01"],
          invites: [
            {
              name: "Taylor",
              email: "taylor@acme.dev",
              role: "admin",
            },
          ],
          defaultNotificationChannel: "slack",
          policyPack: "guarded",
          confirmLaunch: true,
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(saveWorkspaceConnectionState).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_acme_01",
        members: [
          expect.objectContaining({
            email: "jordan@acme.dev",
            role: "owner",
          }),
        ],
      }),
    );
    expect(body.workspaceId).toBe("ws_acme_01");
  });

  it("rejects onboarding when the slug is already owned by another workspace", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        user: { id: "usr_01", name: "Jordan Smith", email: "jordan@acme.dev" },
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "owner" },
      },
    });
    isWorkspaceSlugOwnedByAnotherWorkspace.mockResolvedValue(true);

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/v1/onboarding", {
        method: "POST",
        body: JSON.stringify({
          workspaceName: "Acme Platform",
          workspaceSlug: "acme-platform",
          repositoryIds: ["repo_01"],
          invites: [],
          defaultNotificationChannel: "slack",
          policyPack: "guarded",
          confirmLaunch: true,
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.message).toContain("already in use");
    expect(saveWorkspaceConnectionState).not.toHaveBeenCalled();
  });

  it("rejects onboarding invites that re-add the current workspace owner", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        user: { id: "usr_01", name: "Jordan Smith", email: "jordan@acme.dev" },
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "owner" },
      },
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/v1/onboarding", {
        method: "POST",
        body: JSON.stringify({
          workspaceName: "Acme Platform",
          workspaceSlug: "acme-platform",
          repositoryIds: ["repo_01"],
          invites: [
            {
              name: "Jordan Smith",
              email: "jordan@acme.dev",
              role: "member",
            },
          ],
          defaultNotificationChannel: "slack",
          policyPack: "guarded",
          confirmLaunch: true,
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.message).toContain("owner");
    expect(saveWorkspaceConnectionState).not.toHaveBeenCalled();
  });
});
