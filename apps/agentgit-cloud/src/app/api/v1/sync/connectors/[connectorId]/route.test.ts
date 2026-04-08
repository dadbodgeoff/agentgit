import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiRole = vi.fn();
const revokeWorkspaceConnector = vi.fn();

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
  revokeWorkspaceConnector,
}));

describe("sync connector revoke route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("revokes a connector for the active workspace", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", slug: "acme", role: "admin" },
      },
    });
    revokeWorkspaceConnector.mockReturnValue({
      connectorId: "conn_01",
      revokedAt: "2026-04-07T19:00:00Z",
      message: "Connector access revoked.",
    });

    const { DELETE } = await import("./route");
    const response = await DELETE(
      new Request("http://localhost/api/v1/sync/connectors/conn_01", { method: "DELETE" }),
      {
        params: Promise.resolve({ connectorId: "conn_01" }),
      },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(revokeWorkspaceConnector).toHaveBeenCalledWith("ws_acme_01", "conn_01", expect.any(String));
    expect(body.connectorId).toBe("conn_01");
  });
});
