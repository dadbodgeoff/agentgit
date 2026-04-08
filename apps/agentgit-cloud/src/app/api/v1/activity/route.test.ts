import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiSession = vi.fn();
const listWorkspaceActivity = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiSession,
}));

vi.mock("@/lib/backend/workspace/activity-feed", () => ({
  listWorkspaceActivity,
}));

describe("activity route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns workspace activity for the active session", async () => {
    requireApiSession.mockResolvedValue({
      unauthorized: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", slug: "acme", role: "member" },
      },
    });
    listWorkspaceActivity.mockReturnValue({
      items: [],
      total: 0,
      page_size: 25,
      next_cursor: null,
      has_more: false,
      generatedAt: "2026-04-07T19:00:00Z",
    });

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/v1/activity"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(listWorkspaceActivity).toHaveBeenCalledWith("ws_acme_01", {
      cursor: undefined,
      limit: 25,
    });
    expect(body.total).toBe(0);
  });
});
