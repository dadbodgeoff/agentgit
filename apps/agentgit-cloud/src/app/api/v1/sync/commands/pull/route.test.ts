import { beforeEach, describe, expect, it, vi } from "vitest";

const requireConnectorSession = vi.fn();
const pullPendingConnectorCommands = vi.fn();

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
  pullPendingConnectorCommands,
}));

describe("sync connector command pull route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pulls pending connector commands", async () => {
    requireConnectorSession.mockReturnValue({
      denied: null,
      access: {
        connector: {
          id: "conn_01",
        },
      },
    });
    pullPendingConnectorCommands.mockReturnValue({
      schemaVersion: "cloud-sync.v1",
      connectorId: "conn_01",
      acceptedAt: "2026-04-07T19:00:12Z",
      commands: [],
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/v1/sync/commands/pull", {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: "cloud-sync.v1",
          requestId: "req_pull_01",
          connectorId: "conn_01",
          sentAt: "2026-04-07T19:00:12Z",
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(pullPendingConnectorCommands).toHaveBeenCalled();
    expect(body.connectorId).toBe("conn_01");
  });

  it("rejects a command pull payload with a mismatched schema version", async () => {
    requireConnectorSession.mockReturnValue({
      denied: null,
      access: {
        connector: {
          id: "conn_01",
        },
      },
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/v1/sync/commands/pull", {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: "cloud-sync.v0",
          requestId: "req_pull_01",
          connectorId: "conn_01",
          sentAt: "2026-04-07T19:00:12Z",
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.message).toContain("schemaVersion");
    expect(pullPendingConnectorCommands).not.toHaveBeenCalled();
  });
});
