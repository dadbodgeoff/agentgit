import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiSession = vi.fn();
const withWorkspaceAuthorityClient = vi.fn();
const mapApprovalInboxToCloud = vi.fn();
const listWorkspaceRunContexts = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiSession,
}));

vi.mock("@/lib/backend/authority/client", () => ({
  withWorkspaceAuthorityClient,
}));

vi.mock("@/lib/backend/authority/contracts", () => ({
  mapApprovalInboxToCloud,
}));

vi.mock("@/lib/backend/workspace/workspace-runtime", () => ({
  listWorkspaceRunContexts,
}));

describe("approvals route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scopes approval inbox queries to the active workspace", async () => {
    requireApiSession.mockResolvedValue({
      unauthorized: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "admin" },
      },
    });
    withWorkspaceAuthorityClient.mockImplementation(async (_workspaceId, run) =>
      run({
        queryApprovalInbox: vi.fn().mockResolvedValue({ items: [], counts: { pending: 0, approved: 0, denied: 0 } }),
      }),
    );
    mapApprovalInboxToCloud.mockReturnValue({
      items: [],
      total: 0,
      page: 1,
      per_page: 25,
      has_more: false,
    });
    listWorkspaceRunContexts.mockReturnValue([
      {
        run: { run_id: "run_1" },
        repository: { inventory: { owner: "acme", name: "api-gateway" } },
      },
    ]);

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/v1/approvals"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(withWorkspaceAuthorityClient).toHaveBeenCalledWith("ws_acme_01", expect.any(Function));
    expect(mapApprovalInboxToCloud).toHaveBeenCalledWith(expect.anything(), expect.any(Map));
    expect(body.items).toEqual([]);
  });
});
