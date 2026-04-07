import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiRole = vi.fn();
const queueConnectorCommand = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiRole,
}));

vi.mock("@/lib/backend/control-plane/connectors", () => ({
  ConnectorAccessError: class ConnectorAccessError extends Error {
    constructor(
      message: string,
      public readonly statusCode: number,
    ) {
      super(message);
    }
  },
  queueConnectorCommand,
}));

describe("sync connector command route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queues a connector command for the active workspace", async () => {
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
    queueConnectorCommand.mockReturnValue({
      commandId: "cmd_01",
      connectorId: "conn_01",
      status: "pending",
      queuedAt: "2026-04-07T19:00:00Z",
      message: "create_commit queued for geoffrey-mbp.",
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/v1/sync/connectors/conn_01/commands", {
        method: "POST",
        body: JSON.stringify({
          type: "create_commit",
          message: "chore: test connector commit",
          stageAll: true,
        }),
      }),
      {
        params: Promise.resolve({ connectorId: "conn_01" }),
      },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(queueConnectorCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        activeWorkspace: expect.objectContaining({ id: "ws_acme_01" }),
      }),
      "conn_01",
      expect.objectContaining({
        type: "create_commit",
        message: "chore: test connector commit",
      }),
      expect.any(String),
    );
    expect(body.commandId).toBe("cmd_01");
  });
});
