import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiRole = vi.fn();
const retryConnectorCommand = vi.fn();

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
  retryConnectorCommand,
}));

describe("sync command retry route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries a connector command for the active workspace", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", slug: "acme", role: "admin" },
      },
    });
    retryConnectorCommand.mockReturnValue({
      commandId: "cmd_01",
      connectorId: "conn_01",
      status: "pending",
      queuedAt: "2026-04-07T19:00:00Z",
      message: "Command returned to pending.",
    });

    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/v1/sync/commands/cmd_01/retry", { method: "POST" }), {
      params: Promise.resolve({ commandId: "cmd_01" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(retryConnectorCommand).toHaveBeenCalledWith("ws_acme_01", "cmd_01", expect.any(String));
    expect(body.status).toBe("pending");
  });
});
