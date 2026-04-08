import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiRole = vi.fn();
const listWorkspaceConnectors = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiRole,
}));

vi.mock("@/lib/backend/control-plane/connectors", () => ({
  listWorkspaceConnectors,
}));

describe("sync connectors route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns workspace connector inventory for admins", async () => {
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
    listWorkspaceConnectors.mockReturnValue({
      items: [],
      total: 0,
      page_size: 25,
      next_cursor: null,
      has_more: false,
      generatedAt: "2026-04-07T19:00:00Z",
    });

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/v1/sync/connectors"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(listWorkspaceConnectors).toHaveBeenCalledWith("ws_acme_01", expect.any(String), {
      cursor: undefined,
      limit: 25,
    });
    expect(body.total).toBe(0);
  });
});
