import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiSession = vi.fn();
const listRepositorySnapshots = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiSession,
}));

vi.mock("@/lib/backend/workspace/repository-snapshots", () => ({
  listRepositorySnapshots,
}));

describe("repository snapshots route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a repository snapshot inventory for an authenticated member", async () => {
    requireApiSession.mockResolvedValue({
      unauthorized: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "member" },
      },
    });
    listRepositorySnapshots.mockResolvedValue({
      items: [
        {
          snapshotId: "snap_01",
          runId: "run_01",
          actionId: "act_01",
          workflowName: "snapshot-smoke",
          actionSummary: "Delete restore-me.txt",
          targetLocator: "/tmp/repo/restore-me.txt",
          snapshotClass: "metadata_only",
          fidelity: "metadata_only",
          scopePaths: ["restore-me.txt"],
          integrityStatus: "verified",
          storageBytes: null,
          createdAt: "2026-04-07T15:00:02Z",
        },
      ],
      total: 1,
      page: 1,
      per_page: 1,
      has_more: false,
      authorityReachable: false,
      restorableCount: 1,
      restoredCount: 0,
    });

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/v1/repositories/acme/platform-ui/snapshots"), {
      params: Promise.resolve({ owner: "acme", name: "platform-ui" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.items[0].snapshotId).toBe("snap_01");
    expect(response.headers.get("x-agentgit-request-id")).toBeTruthy();
  });
});
