import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiSession = vi.fn();
const hasRepositoryRouteAccess = vi.fn();
const listRepositoryRuns = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiSession,
}));

vi.mock("@/lib/backend/workspace/repository-route-access", () => ({
  hasRepositoryRouteAccess,
}));

vi.mock("@/lib/backend/workspace/repository-detail", () => ({
  listRepositoryRuns,
}));

describe("repository runs route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasRepositoryRouteAccess.mockResolvedValue(true);
  });

  it("returns runs for a workspace-scoped repository", async () => {
    requireApiSession.mockResolvedValue({
      unauthorized: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "member" },
      },
    });
    listRepositoryRuns.mockResolvedValue({
      items: [{ runId: "run_01" }],
      total: 1,
      page_size: 25,
      next_cursor: null,
      has_more: false,
    });

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/v1/repositories/acme/platform-ui/runs"), {
      params: Promise.resolve({ owner: "acme", name: "platform-ui" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(hasRepositoryRouteAccess).toHaveBeenCalledWith({
      owner: "acme",
      name: "platform-ui",
      workspaceId: "ws_acme_01",
    });
    expect(body.total).toBe(1);
  });

  it("fails closed when the repository is outside the active workspace", async () => {
    requireApiSession.mockResolvedValue({
      unauthorized: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "member" },
      },
    });
    hasRepositoryRouteAccess.mockResolvedValue(false);

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/v1/repositories/acme/platform-ui/runs"), {
      params: Promise.resolve({ owner: "acme", name: "platform-ui" }),
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.message).toContain("active workspace");
    expect(listRepositoryRuns).not.toHaveBeenCalled();
  });
});
