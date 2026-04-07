import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiRole = vi.fn();
const sendWorkspaceIntegrationTest = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiRole,
}));

vi.mock("@/lib/backend/workspace/workspace-integrations", () => ({
  sendWorkspaceIntegrationTest,
}));

describe("integration test-notification route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns delivery details for a valid enabled channel", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "admin" },
      },
    });
    sendWorkspaceIntegrationTest.mockReturnValue({
      channel: "email",
      deliveredAt: "2026-04-07T12:00:00Z",
      message: "Email notification queued.",
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/v1/settings/integrations/test-notification", {
        method: "POST",
        body: JSON.stringify({ channel: "email" }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.channel).toBe("email");
  });

  it("returns a conflict when the saved integration state blocks delivery", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "admin" },
      },
    });
    sendWorkspaceIntegrationTest.mockImplementation(() => {
      throw new Error("Slack delivery is not configured for this workspace.");
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/v1/settings/integrations/test-notification", {
        method: "POST",
        body: JSON.stringify({ channel: "slack" }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.message).toContain("not configured");
  });
});
