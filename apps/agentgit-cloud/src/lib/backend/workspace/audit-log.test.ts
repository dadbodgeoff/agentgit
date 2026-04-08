import { beforeEach, describe, expect, it, vi } from "vitest";

const listWorkspaceApprovals = vi.fn();
const listWorkspaceRunContexts = vi.fn();
const withControlPlaneState = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/backend/workspace/workspace-runtime", () => ({
  listWorkspaceApprovals,
  listWorkspaceRunContexts,
}));

vi.mock("@/lib/backend/control-plane/state", () => ({
  withControlPlaneState,
}));

describe("workspace audit log", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listWorkspaceApprovals.mockResolvedValue([
      {
        repository: {
          inventory: {
            owner: "acme",
            name: "platform-ui",
          },
        },
        approval: {
          approval_id: "appr_01",
          requested_at: "2026-04-07T10:00:00Z",
          resolved_at: "2026-04-07T10:05:00Z",
          status: "approved",
          action_summary: "Write README",
          run_id: "run_01",
          action_id: "act_01",
          primary_reason: {
            message: "Mutating filesystem action requires review.",
          },
        },
      },
    ]);
    listWorkspaceRunContexts.mockResolvedValue([
      {
        repository: {
          inventory: {
            owner: "acme",
            name: "platform-ui",
          },
        },
        run: {
          run_id: "run_02",
          workflow_name: "nightly-governed-run",
        },
        events: [
          {
            sequence: 12,
            event_type: "execution.failed",
            occurred_at: "2026-04-08T09:00:00Z",
            payload: {
              action_id: "act_02",
            },
          },
        ],
      },
    ]);
    withControlPlaneState.mockImplementation((callback) =>
      callback({
        listCommands: () => [
          {
            command: {
              commandId: "cmd_01",
              workspaceId: "ws_acme_01",
              type: "open_pull_request",
              repository: {
                owner: "acme",
                name: "platform-ui",
              },
            },
            status: "completed",
            updatedAt: "2026-04-08T11:00:00Z",
            lastMessage: "Opened provider PR.",
            nextAttemptAt: null,
            result: {
              pullRequestUrl: "https://github.com/acme/platform-ui/pull/42",
            },
          },
        ],
        listEvents: () => [
          {
            event: {
              eventId: "evt_policy_01",
              workspaceId: "ws_acme_01",
              type: "policy.state",
              occurredAt: "2026-04-06T09:00:00Z",
              repository: {
                owner: "acme",
                name: "platform-ui",
              },
            },
          },
        ],
      }),
    );
  });

  it("filters workspace audit results by date range without changing total matching order", async () => {
    const { listWorkspaceAuditLog } = await import("./audit-log");
    const result = await listWorkspaceAuditLog("ws_acme_01", {
      from: "2026-04-07T00:00:00Z",
      to: "2026-04-07T23:59:59Z",
      limit: null,
    });

    expect(result.total).toBe(1);
    expect(result.items.map((item) => item.id)).toEqual(["appr_01"]);
  });

  it("exports matching audit entries as csv with stable columns", async () => {
    const { exportWorkspaceAuditLog } = await import("./audit-log");
    const exported = await exportWorkspaceAuditLog("ws_acme_01", "csv", {
      from: "2026-04-07T00:00:00Z",
      to: "2026-04-08T23:59:59Z",
      limit: null,
    });

    expect(exported.contentType).toContain("text/csv");
    expect(exported.fileName).toMatch(/^audit-ws_acme_01-.*\.csv$/);
    expect(exported.body).toContain(
      "id,occurredAt,actorLabel,actorType,category,action,target,outcome,repo,runId,actionId,detailPath,externalUrl,details",
    );
    expect(exported.body).toContain('"appr_01"');
    expect(exported.body).toContain('"command:cmd_01"');
    expect(exported.body).toContain('"run_02:12"');
  });
});
