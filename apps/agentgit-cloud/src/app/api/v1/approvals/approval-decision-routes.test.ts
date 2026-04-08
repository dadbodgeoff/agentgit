import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiSession = vi.fn();
const findConnectorForRepository = vi.fn();
const getWorkspaceApprovalProjection = vi.fn();
const queueConnectorCommand = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiSession,
}));

vi.mock("@/lib/backend/control-plane/connectors", async () => {
  const actual = await vi.importActual<typeof import("@/lib/backend/control-plane/connectors")>(
    "@/lib/backend/control-plane/connectors",
  );

  return {
    ...actual,
    findConnectorForRepository,
    queueConnectorCommand,
  };
});

vi.mock("@/lib/backend/workspace/workspace-approvals", () => ({
  getWorkspaceApprovalProjection,
}));

describe("approval decision routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireApiSession.mockResolvedValue({
      session: {
        user: { email: "jordan@acme.dev", name: "Jordan Smith" },
      },
      unauthorized: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "admin" },
      },
    });
    getWorkspaceApprovalProjection.mockReturnValue({
      id: "appr_01",
      runId: "run_01",
      actionId: "act_01",
      repositoryOwner: "acme",
      repositoryName: "platform-ui",
      workflowName: "Ship fix",
      domain: "deploy",
      sideEffectLevel: "mutating",
      status: "pending",
      requestedAt: "2026-04-07T19:00:00Z",
      actionSummary: "Deploy preview",
      reasonSummary: "Needs review",
      targetLocator: "deploy://preview",
      snapshotRequired: false,
      commandId: null,
      commandStatus: null,
    });
    findConnectorForRepository.mockReturnValue({
      id: "conn_01",
      machineName: "geoffrey-mbp",
    });
    queueConnectorCommand.mockReturnValue({
      commandId: "cmd_01",
      connectorId: "conn_01",
      status: "pending",
      queuedAt: "2026-04-07T19:01:00Z",
      message: "resolve_approval queued for geoffrey-mbp.",
    });
  });

  it("returns 400 for malformed approval payloads instead of queuing a connector command", async () => {
    const { POST } = await import("./[id]/approve/route");
    const response = await POST(
      new Request("http://localhost/api/v1/approvals/appr_01/approve", {
        body: JSON.stringify({ comment: 42 }),
        method: "POST",
      }),
      { params: Promise.resolve({ id: "appr_01" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.message).toContain("invalid");
    expect(queueConnectorCommand).not.toHaveBeenCalled();
  });

  it("scopes rejection decisions to the active workspace and queues a connector command", async () => {
    const { POST } = await import("./[id]/reject/route");
    const response = await POST(
      new Request("http://localhost/api/v1/approvals/appr_01/reject", {
        body: JSON.stringify({ comment: "Too risky" }),
        method: "POST",
      }),
      { params: Promise.resolve({ id: "appr_01" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(getWorkspaceApprovalProjection).toHaveBeenCalledWith("ws_acme_01", "appr_01");
    expect(findConnectorForRepository).toHaveBeenCalledWith("ws_acme_01", "acme", "platform-ui");
    expect(queueConnectorCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        activeWorkspace: expect.objectContaining({ id: "ws_acme_01" }),
      }),
      "conn_01",
      {
        type: "resolve_approval",
        approvalId: "appr_01",
        resolution: "denied",
        note: "Too risky",
      },
      expect.any(String),
    );
    expect(body.status).toBe("rejected");
  });

  it("returns an expired conflict when the approval TTL has already elapsed", async () => {
    getWorkspaceApprovalProjection.mockReturnValue({
      id: "appr_01",
      runId: "run_01",
      actionId: "act_01",
      repositoryOwner: "acme",
      repositoryName: "platform-ui",
      workflowName: "Ship fix",
      domain: "deploy",
      sideEffectLevel: "mutating",
      status: "expired",
      requestedAt: "2026-04-07T19:00:00Z",
      resolvedAt: "2026-04-07T19:30:00Z",
      resolutionNote: "Approval timed out before the connector could deliver a reviewer decision.",
      actionSummary: "Deploy preview",
      reasonSummary: "Needs review",
      targetLocator: "deploy://preview",
      snapshotRequired: false,
      decisionCommandStatus: "failed",
    });

    const { POST } = await import("./[id]/approve/route");
    const response = await POST(
      new Request("http://localhost/api/v1/approvals/appr_01/approve", {
        body: JSON.stringify({ comment: "Too late" }),
        method: "POST",
      }),
      { params: Promise.resolve({ id: "appr_01" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.status).toBe("expired");
    expect(body.message).toContain("timed out");
    expect(queueConnectorCommand).not.toHaveBeenCalled();
  });
});
