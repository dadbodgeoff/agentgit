import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiRole = vi.fn();
const listWorkspaceAuditLog = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiRole,
}));

vi.mock("@/lib/backend/workspace/audit-log", () => ({
  listWorkspaceAuditLog,
}));

describe("audit route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns workspace audit entries for the active session", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", slug: "acme", role: "admin" },
      },
    });
    listWorkspaceAuditLog.mockReturnValue({
      items: [],
      total: 0,
      page_size: 25,
      next_cursor: null,
      has_more: false,
      generatedAt: "2026-04-07T19:00:00Z",
    });

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/v1/audit"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(listWorkspaceAuditLog).toHaveBeenCalledWith("ws_acme_01", {
      cursor: undefined,
      limit: 25,
    });
    expect(body.total).toBe(0);
  });
});
