import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiRole = vi.fn();
const hasRepositoryRouteAccess = vi.fn();
const restoreRepositorySnapshot = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiRole,
}));

vi.mock("@/lib/backend/workspace/repository-route-access", () => ({
  hasRepositoryRouteAccess,
}));

vi.mock("@/lib/backend/workspace/repository-snapshots", () => ({
  RepositorySnapshotRestoreError: class RepositorySnapshotRestoreError extends Error {
    constructor(
      message: string,
      public readonly statusCode: number,
    ) {
      super(message);
    }
  },
  restoreRepositorySnapshot,
}));

describe("repository snapshot restore route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasRepositoryRouteAccess.mockResolvedValue(true);
  });

  it("plans a snapshot restore for an authorized admin", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "admin" },
      },
    });
    restoreRepositorySnapshot.mockResolvedValue({
      snapshotId: "snap_01",
      plan: {
        schema_version: "recovery-plan.v1",
        recovery_plan_id: "plan_01",
        target: {
          type: "snapshot_id",
          snapshot_id: "snap_01",
        },
        recovery_class: "reversible",
        strategy: "restore_snapshot",
        confidence: 0.98,
        steps: [],
        impact_preview: {
          paths_to_change: 1,
          later_actions_affected: 0,
          overlapping_paths: [],
          external_effects: [],
          data_loss_risk: "low",
        },
        warnings: [],
        created_at: "2026-04-07T15:10:00Z",
      },
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/v1/repositories/acme/platform-ui/snapshots/snap_01/restore", {
        method: "POST",
        body: JSON.stringify({ intent: "plan" }),
      }),
      {
        params: Promise.resolve({ owner: "acme", name: "platform-ui", snapshotId: "snap_01" }),
      },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(restoreRepositorySnapshot).toHaveBeenCalledWith(
      "acme",
      "platform-ui",
      "snap_01",
      "plan",
      expect.any(String),
      "ws_acme_01",
    );
    expect(body.snapshotId).toBe("snap_01");
    expect(body.plan.strategy).toBe("restore_snapshot");
  });

  it("queues a connector-backed restore execution for an authorized admin", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "admin" },
      },
    });
    restoreRepositorySnapshot.mockResolvedValue({
      snapshotId: "snap_01",
      commandId: "cmd_restore_01",
      connectorId: "conn_01",
      queuedAt: "2026-04-07T15:11:00Z",
      message: "Restore queued for geoffrey-mbp.",
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/v1/repositories/acme/platform-ui/snapshots/snap_01/restore", {
        method: "POST",
        body: JSON.stringify({ intent: "execute" }),
      }),
      {
        params: Promise.resolve({ owner: "acme", name: "platform-ui", snapshotId: "snap_01" }),
      },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(restoreRepositorySnapshot).toHaveBeenCalledWith(
      "acme",
      "platform-ui",
      "snap_01",
      "execute",
      expect.any(String),
      "ws_acme_01",
    );
    expect(body.commandId).toBe("cmd_restore_01");
  });

  it("fails closed when the repository is outside the active workspace", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "admin" },
      },
    });
    hasRepositoryRouteAccess.mockResolvedValue(false);

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/v1/repositories/acme/platform-ui/snapshots/snap_01/restore", {
        method: "POST",
        body: JSON.stringify({ intent: "plan" }),
      }),
      {
        params: Promise.resolve({ owner: "acme", name: "platform-ui", snapshotId: "snap_01" }),
      },
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.message).toContain("not found");
    expect(restoreRepositorySnapshot).not.toHaveBeenCalled();
  });
});
