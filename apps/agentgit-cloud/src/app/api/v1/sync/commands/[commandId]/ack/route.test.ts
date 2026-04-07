import { beforeEach, describe, expect, it, vi } from "vitest";

const requireConnectorSession = vi.fn();
const acknowledgeConnectorCommand = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/connector-session", () => ({
  requireConnectorSession,
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
  acknowledgeConnectorCommand,
}));

describe("sync connector command ack route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("acknowledges a connector command", async () => {
    requireConnectorSession.mockReturnValue({
      denied: null,
      access: {
        connector: {
          id: "conn_01",
        },
      },
    });
    acknowledgeConnectorCommand.mockReturnValue({
      schemaVersion: "cloud-sync.v1",
      connectorId: "conn_01",
      commandId: "cmd_01",
      acceptedAt: "2026-04-07T19:00:00Z",
      status: "completed",
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/v1/sync/commands/cmd_01/ack", {
        method: "POST",
        body: JSON.stringify({
          connectorId: "conn_01",
          commandId: "cmd_01",
          acknowledgedAt: "2026-04-07T19:00:00Z",
          status: "completed",
          message: "Created commit abc1234.",
        }),
      }),
      {
        params: Promise.resolve({ commandId: "cmd_01" }),
      },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(acknowledgeConnectorCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        connector: expect.objectContaining({ id: "conn_01" }),
      }),
      expect.objectContaining({
        connectorId: "conn_01",
        commandId: "cmd_01",
        status: "completed",
      }),
      expect.any(String),
    );
    expect(body.status).toBe("completed");
  });
});
