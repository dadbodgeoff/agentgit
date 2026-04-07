import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiRole = vi.fn();
const resolveWorkspaceTeam = vi.fn();
const saveWorkspaceTeam = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiRole,
}));

vi.mock("@/lib/backend/workspace/workspace-team", () => ({
  resolveWorkspaceTeam,
  saveWorkspaceTeam,
}));

describe("team settings route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the persisted team snapshot for an authorized admin", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "admin" },
      },
    });
    resolveWorkspaceTeam.mockReturnValue({
      workspaceId: "ws_acme_01",
      workspaceName: "Acme platform",
      workspaceSlug: "acme-platform",
      inviteLimit: 20,
      members: [],
    });

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/v1/settings/team"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.workspaceSlug).toBe("acme-platform");
    expect(response.headers.get("x-agentgit-request-id")).toBeTruthy();
  });

  it("returns a validation error for invalid payloads", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "admin" },
      },
    });

    const { PUT } = await import("./route");
    const response = await PUT(
      new Request("http://localhost/api/v1/settings/team", {
        method: "PUT",
        body: JSON.stringify({ invites: [{}] }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.message).toContain("invalid");
  });

  it("passes validated team updates into the backend save flow", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "admin" },
      },
    });
    saveWorkspaceTeam.mockReturnValue({
      team: {
        workspaceId: "ws_acme_01",
        workspaceName: "Acme platform",
        workspaceSlug: "acme-platform",
        inviteLimit: 20,
        members: [
          {
            id: "member_01",
            name: "Jordan Smith",
            email: "jordan@acme.dev",
            role: "admin",
            status: "active",
          },
        ],
      },
      savedAt: "2026-04-07T12:00:00Z",
      message: "Team roster saved.",
    });

    const { PUT } = await import("./route");
    const response = await PUT(
      new Request("http://localhost/api/v1/settings/team", {
        method: "PUT",
        body: JSON.stringify({
          invites: [{ name: "Riley", email: "riley@acme.dev", role: "member" }],
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(saveWorkspaceTeam).toHaveBeenCalled();
    expect(body.team.workspaceSlug).toBe("acme-platform");
  });
});
