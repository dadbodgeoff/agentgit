import { beforeEach, describe, expect, it, vi } from "vitest";

const requireConnectorSession = vi.fn();
const recordConnectorHeartbeat = vi.fn();

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
  recordConnectorHeartbeat,
}));

describe("sync heartbeat route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records a connector heartbeat", async () => {
    requireConnectorSession.mockReturnValue({
      denied: null,
      access: {
        connector: {
          id: "conn_01",
        },
      },
    });
    recordConnectorHeartbeat.mockReturnValue({
      schemaVersion: "cloud-sync.v1",
      connectorId: "conn_01",
      acceptedAt: "2026-04-07T18:05:00Z",
      status: "active",
      pendingCommandCount: 0,
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/v1/sync/heartbeat", {
        method: "POST",
        headers: {
          authorization: "Bearer agcs_test",
        },
        body: JSON.stringify({
          schemaVersion: "cloud-sync.v1",
          requestId: "req_heartbeat_01",
          connectorId: "conn_01",
          sentAt: "2026-04-07T18:05:00Z",
          repository: {
            provider: "github",
            repo: {
              owner: "acme",
              name: "platform-ui",
            },
            remoteUrl: "git@github.com:acme/platform-ui.git",
            defaultBranch: "main",
            currentBranch: "main",
            headSha: "abcdef1234567",
            isDirty: false,
            aheadBy: 0,
            behindBy: 0,
            workspaceRoot: "/Users/me/code/platform-ui",
            lastFetchedAt: null,
          },
          localDaemon: {
            reachable: true,
            socketPath: "/tmp/authority.sock",
            journalPath: "/tmp/authority.db",
            snapshotRootPath: "/tmp/snapshots",
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(recordConnectorHeartbeat).toHaveBeenCalled();
    expect(body.connectorId).toBe("conn_01");
  });

  it("rejects a heartbeat payload with a mismatched schema version", async () => {
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
      new Request("http://localhost/api/v1/sync/heartbeat", {
        method: "POST",
        headers: {
          authorization: "Bearer agcs_test",
        },
        body: JSON.stringify({
          schemaVersion: "cloud-sync.v0",
          requestId: "req_heartbeat_01",
          connectorId: "conn_01",
          sentAt: "2026-04-07T18:05:00Z",
          repository: {
            provider: "github",
            repo: {
              owner: "acme",
              name: "platform-ui",
            },
            remoteUrl: "git@github.com:acme/platform-ui.git",
            defaultBranch: "main",
            currentBranch: "main",
            headSha: "abcdef1234567",
            isDirty: false,
            aheadBy: 0,
            behindBy: 0,
            workspaceRoot: "/Users/me/code/platform-ui",
            lastFetchedAt: null,
          },
          localDaemon: {
            reachable: true,
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.message).toContain("schemaVersion");
    expect(recordConnectorHeartbeat).not.toHaveBeenCalled();
  });
});
