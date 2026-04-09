import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiSession = vi.fn();
const hasRepositoryRouteAccess = vi.fn();
const getRepositoryDetail = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiSession,
}));

vi.mock("@/lib/backend/workspace/repository-route-access", () => ({
  hasRepositoryRouteAccess,
}));

vi.mock("@/lib/backend/workspace/repository-detail", () => ({
  getRepositoryDetail,
}));

describe("repository detail route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasRepositoryRouteAccess.mockResolvedValue(true);
  });

  it("returns repository detail for an authenticated workspace member", async () => {
    requireApiSession.mockResolvedValue({
      unauthorized: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "member" },
      },
    });
    getRepositoryDetail.mockResolvedValue({
      repoId: "repo_01",
      owner: "acme",
      name: "platform-ui",
    });

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/v1/repositories/acme/platform-ui"), {
      params: Promise.resolve({ owner: "acme", name: "platform-ui" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(hasRepositoryRouteAccess).toHaveBeenCalledWith({
      owner: "acme",
      name: "platform-ui",
      workspaceId: "ws_acme_01",
    });
    expect(body.repoId).toBe("repo_01");
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
    const response = await GET(new Request("http://localhost/api/v1/repositories/acme/platform-ui"), {
      params: Promise.resolve({ owner: "acme", name: "platform-ui" }),
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.message).toContain("active workspace");
    expect(getRepositoryDetail).not.toHaveBeenCalled();
  });
});
