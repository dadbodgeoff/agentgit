import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiSession = vi.fn();
const listWorkspaceAuditLog = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiSession,
}));

vi.mock("@/lib/backend/workspace/audit-log", () => ({
  listWorkspaceAuditLog,
}));

describe("audit route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns workspace audit entries for the active session", async () => {
    requireApiSession.mockResolvedValue({
      unauthorized: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", slug: "acme", role: "member" },
      },
    });
    listWorkspaceAuditLog.mockReturnValue({
      items: [],
      total: 0,
      generatedAt: "2026-04-07T19:00:00Z",
    });

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/v1/audit"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(listWorkspaceAuditLog).toHaveBeenCalledWith("ws_acme_01");
    expect(body.total).toBe(0);
  });
});
