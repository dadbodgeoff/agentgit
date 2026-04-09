import { beforeEach, describe, expect, it, vi } from "vitest";

const requireConnectorSession = vi.fn();
const ingestConnectorEvents = vi.fn();

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
  ingestConnectorEvents,
}));

describe("sync events route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ingests a connector event batch", async () => {
    requireConnectorSession.mockReturnValue({
      denied: null,
      access: {
        connector: {
          id: "conn_01",
        },
      },
    });
    ingestConnectorEvents.mockReturnValue({
      schemaVersion: "cloud-sync.v1",
      connectorId: "conn_01",
      acceptedAt: "2026-04-07T18:06:00Z",
      acceptedCount: 1,
      highestAcceptedSequence: 1,
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/v1/sync/events", {
        method: "POST",
        headers: {
          authorization: "Bearer agcs_test",
        },
        body: JSON.stringify({
          schemaVersion: "cloud-sync.v1",
          requestId: "req_events_01",
          connectorId: "conn_01",
          sentAt: "2026-04-07T18:06:00Z",
          events: [
            {
              schemaVersion: "cloud-sync.v1",
              eventId: "evt_01",
              connectorId: "conn_01",
              workspaceId: "ws_acme_01",
              repository: {
                owner: "acme",
                name: "platform-ui",
              },
              sequence: 1,
              occurredAt: "2026-04-07T18:05:30Z",
              type: "repo_state.snapshot",
              payload: {
                headSha: "abcdef1234567",
              },
            },
          ],
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.acceptedCount).toBe(1);
  });

  it("rejects an event batch with a mismatched schema version", async () => {
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
      new Request("http://localhost/api/v1/sync/events", {
        method: "POST",
        headers: {
          authorization: "Bearer agcs_test",
        },
        body: JSON.stringify({
          schemaVersion: "cloud-sync.v0",
          requestId: "req_events_01",
          connectorId: "conn_01",
          sentAt: "2026-04-07T18:06:00Z",
          events: [
            {
              schemaVersion: "cloud-sync.v1",
              eventId: "evt_01",
              connectorId: "conn_01",
              workspaceId: "ws_acme_01",
              repository: {
                owner: "acme",
                name: "platform-ui",
              },
              sequence: 1,
              occurredAt: "2026-04-07T18:05:30Z",
              type: "repo_state.snapshot",
              payload: {
                headSha: "abcdef1234567",
              },
            },
          ],
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.message).toContain("schemaVersion");
    expect(ingestConnectorEvents).not.toHaveBeenCalled();
  });
});
