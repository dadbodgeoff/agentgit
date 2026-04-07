import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiSession = vi.fn();
const withWorkspaceAuthorityClient = vi.fn();
const mapTimelineToRunDetail = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiSession,
}));

vi.mock("@/lib/backend/authority/client", () => ({
  withWorkspaceAuthorityClient,
}));

vi.mock("@/lib/backend/authority/contracts", () => ({
  mapTimelineToRunDetail,
}));

describe("run detail route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the active workspace when querying run detail", async () => {
    requireApiSession.mockResolvedValue({
      unauthorized: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "member" },
      },
    });
    withWorkspaceAuthorityClient.mockImplementation(async (_workspaceId, run) =>
      run({
        queryTimeline: vi.fn().mockResolvedValue({ run_summary: { run_id: "run_01" }, steps: [] }),
      }),
    );
    mapTimelineToRunDetail.mockReturnValue({ id: "run_01", steps: [] });

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/v1/runs/run_01"), {
      params: Promise.resolve({ runId: "run_01" }),
    });

    expect(response.status).toBe(200);
    expect(withWorkspaceAuthorityClient).toHaveBeenCalledWith("ws_acme_01", expect.any(Function));
  });
});
