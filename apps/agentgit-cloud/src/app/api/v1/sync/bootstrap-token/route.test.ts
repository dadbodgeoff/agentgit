import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiRole = vi.fn();
const issueConnectorBootstrapToken = vi.fn();
const enforceConnectorBootstrapTokenRateLimits = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiRole,
}));

vi.mock("@/lib/backend/control-plane/connectors", () => ({
  CONNECTOR_BOOTSTRAP_TOKEN_HEADER: "x-agentgit-connector-bootstrap-token",
  issueConnectorBootstrapToken,
}));

vi.mock("@/lib/security/rate-limit", () => ({
  enforceConnectorBootstrapTokenRateLimits,
}));

describe("sync bootstrap-token route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enforceConnectorBootstrapTokenRateLimits.mockResolvedValue(null);
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
    expect(body.bootstrapToken).toBeUndefined();
    expect(response.headers.get("x-agentgit-connector-bootstrap-token")).toBe("agcbt_test");
  });

  it("returns the rate-limit response before issuing a token", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        activeWorkspace: {
          id: "ws_acme_01",
          slug: "acme",
          role: "admin",
        },
      },
    });
    enforceConnectorBootstrapTokenRateLimits.mockResolvedValue(
      new Response(JSON.stringify({ message: "Too many bootstrap token requests. Retry in a minute." }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    );

    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/v1/sync/bootstrap-token", { method: "POST" }));
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(issueConnectorBootstrapToken).not.toHaveBeenCalled();
    expect(body.message).toContain("Too many bootstrap token requests");
  });
});
