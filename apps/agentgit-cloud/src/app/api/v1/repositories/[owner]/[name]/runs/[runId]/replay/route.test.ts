import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiRole = vi.fn();
const getRunReplayPreview = vi.fn();
const queueRunReplay = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiRole,
}));

vi.mock("@/lib/backend/workspace/run-replay", () => ({
  RunReplayAccessError: class RunReplayAccessError extends Error {
    constructor(
      message: string,
      public readonly statusCode: number,
    ) {
      super(message);
    }
  },
  getRunReplayPreview,
  queueRunReplay,
}));

describe("repository run replay route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a replay preview for an authorized admin", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        user: { id: "usr_01", name: "Jordan Smith", email: "jordan@acme.dev" },
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "admin" },
      },
    });
    getRunReplayPreview.mockResolvedValue({
      sourceRunId: "run_01",
      workflowName: "release",
      connectorStatus: "active",
      connectorStatusReason: null,
      connectorId: "conn_01",
      connectorMachineName: "mbp",
      replayMode: "exact",
      sourceActionCount: 2,
      replayableActionCount: 2,
      skippedActionCount: 0,
      pendingApprovalCount: 0,
      summary:
        "release recorded 2 normalized actions; 2 can be replayed, 0 will be skipped, and 0 source approval steps were observed.",
      helperSummary: "The run completed cleanly.",
      replayReason: null,
      actions: [],
    });

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/v1/repositories/acme/platform-ui/runs/run_01/replay"),
      {
        params: Promise.resolve({ owner: "acme", name: "platform-ui", runId: "run_01" }),
      },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.sourceRunId).toBe("run_01");
  });

  it("queues a replay command for an authorized admin", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        user: { id: "usr_01", name: "Jordan Smith", email: "jordan@acme.dev" },
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "admin" },
      },
    });
    queueRunReplay.mockResolvedValue({
      sourceRunId: "run_01",
      connectorId: "conn_01",
      commandId: "cmd_01",
      queuedAt: "2026-04-08T12:00:00Z",
      message: "replay_run queued for mbp.",
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/v1/repositories/acme/platform-ui/runs/run_01/replay", { method: "POST" }),
      {
        params: Promise.resolve({ owner: "acme", name: "platform-ui", runId: "run_01" }),
      },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(queueRunReplay).toHaveBeenCalled();
    expect(body.commandId).toBe("cmd_01");
  });
});
