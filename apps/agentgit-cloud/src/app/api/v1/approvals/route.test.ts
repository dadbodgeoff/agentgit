import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiSession = vi.fn();
const listWorkspaceApprovalQueue = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiSession,
}));

vi.mock("@/lib/backend/workspace/workspace-approvals", () => ({
  listWorkspaceApprovalQueue,
}));

describe("approvals route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scopes approval queue reads to the active workspace control plane projection", async () => {
    requireApiSession.mockResolvedValue({
      unauthorized: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "admin" },
      },
    });
    listWorkspaceApprovalQueue.mockReturnValue({
      items: [],
      total: 0,
      page: 1,
      per_page: 25,
      has_more: false,
    });

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/v1/approvals"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(listWorkspaceApprovalQueue).toHaveBeenCalledWith("ws_acme_01");
    expect(body.items).toEqual([]);
  });
});
