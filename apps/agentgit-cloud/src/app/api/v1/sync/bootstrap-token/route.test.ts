import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiRole = vi.fn();
const issueConnectorBootstrapToken = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiRole,
}));

vi.mock("@/lib/backend/control-plane/connectors", () => ({
  issueConnectorBootstrapToken,
}));

describe("sync bootstrap-token route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("issues a workspace-scoped bootstrap token for admins", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        user: { id: "user_01" },
        activeWorkspace: {
          id: "ws_acme_01",
          slug: "acme",
          role: "admin",
        },
      },
    });
    issueConnectorBootstrapToken.mockReturnValue({
      bootstrapToken: "agcbt_test",
      workspaceId: "ws_acme_01",
      workspaceSlug: "acme",
      expiresAt: "2026-04-07T20:00:00Z",
      commandHint: "agentgit-cloud-connector bootstrap ...",
    });

    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/v1/sync/bootstrap-token", { method: "POST" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(issueConnectorBootstrapToken).toHaveBeenCalledWith(
      expect.objectContaining({
        activeWorkspace: expect.objectContaining({ id: "ws_acme_01" }),
      }),
      "http://localhost",
      expect.any(String),
    );
    expect(body.bootstrapToken).toBe("agcbt_test");
  });
});
