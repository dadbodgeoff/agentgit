import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiRole = vi.fn();
const listWorkspaceConnectors = vi.fn();
const getWorkspaceConnectionState = vi.fn();
const saveWorkspaceConnectionState = vi.fn();
const listAllRepositoryOptions = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiRole,
}));

vi.mock("@/lib/backend/control-plane/connectors", () => ({
  listWorkspaceConnectors,
  issueConnectorBootstrapToken: vi.fn(),
}));

vi.mock("@/lib/backend/workspace/cloud-state", () => ({
  getWorkspaceConnectionState,
  saveWorkspaceConnectionState,
}));

vi.mock("@/lib/backend/workspace/repository-inventory", () => ({
  listAllRepositoryOptions,
}));

describe("repository connect route", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        user: {
          id: "user_01",
          name: "Admin",
          email: "admin@agentgit.dev",
        },
        activeWorkspace: {
          id: "ws_01",
          name: "Acme",
          slug: "acme",
          role: "admin",
        },
      },
    });
    listAllRepositoryOptions.mockReturnValue([
      {
        id: "repo_01",
        owner: "acme",
        name: "platform-ui",
        defaultBranch: "main",
        description: "Governed repository rooted at /workspace/platform-ui.",
        requiresOrgApproval: false,
      },
      {
        id: "repo_02",
        owner: "acme",
        name: "platform-api",
        defaultBranch: "main",
        description: "Governed repository rooted at /workspace/platform-api.",
        requiresOrgApproval: false,
      },
    ]);
    listWorkspaceConnectors.mockReturnValue({
      items: [
        {
          id: "conn_01",
          status: "active",
          repositoryOwner: "acme",
          repositoryName: "platform-ui",
        },
      ],
      total: 1,
      generatedAt: "2026-04-08T00:00:00Z",
    });
  });

  it("returns repository connection bootstrap details for admins", async () => {
    getWorkspaceConnectionState.mockReturnValue({
      workspaceId: "ws_01",
      workspaceName: "Acme",
      workspaceSlug: "acme",
      repositoryIds: ["repo_01"],
      members: [],
      invites: [],
      defaultNotificationChannel: "slack",
      policyPack: "guarded",
      launchedAt: "2026-04-08T00:00:00Z",
    });

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/v1/repos/connect"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.connectedRepositoryIds).toEqual(["repo_01"]);
    expect(body.activeConnectorRepositoryIds).toEqual(["repo_01"]);
    expect(body.totalConnectorCount).toBe(1);
  });

  it("persists repository selections and suggests bootstrap when no active connector covers them", async () => {
    getWorkspaceConnectionState.mockReturnValue({
      workspaceId: "ws_01",
      workspaceName: "Acme",
      workspaceSlug: "acme",
      repositoryIds: ["repo_01"],
      members: [],
      invites: [],
      defaultNotificationChannel: "slack",
      policyPack: "guarded",
      launchedAt: "2026-04-08T00:00:00Z",
    });
    listWorkspaceConnectors.mockReturnValue({
      items: [],
      total: 0,
      generatedAt: "2026-04-08T00:00:00Z",
    });
    saveWorkspaceConnectionState.mockImplementation((value: unknown) => value);

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/v1/repos/connect", {
        method: "POST",
        body: JSON.stringify({
          repositoryIds: ["repo_01", "repo_02"],
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.connectedRepositoryCount).toBe(2);
    expect(body.newlyConnectedRepositoryIds).toEqual(["repo_02"]);
    expect(body.connectorBootstrapSuggested).toBe(true);
    expect(saveWorkspaceConnectionState).toHaveBeenCalled();
  });
});
