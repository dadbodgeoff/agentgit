import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiSession = vi.fn();
const getActionDetail = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiSession,
}));

vi.mock("@/lib/backend/workspace/action-detail", () => ({
  getActionDetail,
}));

describe("run action detail route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the active workspace and repo identity when loading action detail", async () => {
    requireApiSession.mockResolvedValue({
      unauthorized: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", slug: "acme", role: "member" },
      },
    });
    getActionDetail.mockResolvedValue({
      id: "run_01:act_01",
      runId: "run_01",
      actionId: "act_01",
      repo: "acme/platform-ui",
      workflowName: "policy-check",
      occurredAt: "2026-04-07T19:00:00Z",
      runContext: {
        sessionId: "sess_01",
        workflowName: "policy-check",
        agentName: "Codex",
        agentFramework: "cloud",
        status: "completed",
        startedAt: "2026-04-07T18:59:00Z",
        latestEventAt: "2026-04-07T19:00:00Z",
        eventCount: 4,
      },
      approvalContext: {
        approvalId: "apr_01",
        status: "pending",
        decisionRequested: "approve_or_deny",
        requestedAt: "2026-04-07T19:00:00Z",
        resolvedAt: null,
        resolutionNote: null,
        actionSummary: "Write file",
        primaryReason: {
          code: "SAFE_TO_RUN",
          message: "Safe to run.",
        },
      },
      normalizedAction: {
        domain: "filesystem",
        kind: "write",
        name: "filesystem/write",
        displayName: "Write file",
        targetLocator: "README.md",
        targetLabel: null,
        executionSurface: "governed_fs",
        executionMode: "pre_execution",
        confidenceScore: 0.95,
        confidenceBand: "high",
        sideEffectLevel: "mutating",
        reversibilityHint: "reversible",
        externalEffects: [],
        warnings: [],
        rawInput: {},
        redactedInput: {},
      },
      policyOutcome: {
        decision: "allow_with_snapshot",
        reasons: [],
        snapshotRequired: true,
        approvalRequired: false,
        budgetCheck: "passed",
        matchedRules: [],
      },
      execution: {
        stepId: "step_01",
        status: "completed",
        stepType: "action_step",
        summary: "Write completed.",
        snapshotId: "snap_01",
        artifactLabels: [],
        helperSummary: null,
        policyExplanation: null,
        laterActionsAffected: 0,
        overlappingPaths: [],
      },
    });

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/v1/runs/run_01/actions/act_01?owner=acme&name=platform-ui"),
      {
        params: Promise.resolve({ runId: "run_01", actionId: "act_01" }),
      },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(getActionDetail).toHaveBeenCalledWith("acme", "platform-ui", "run_01", "act_01", "ws_acme_01");
    expect(body.actionId).toBe("act_01");
  });

  it("rejects malformed repository coordinates before loading action detail", async () => {
    requireApiSession.mockResolvedValue({
      unauthorized: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", slug: "acme", role: "member" },
      },
    });

    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://localhost/api/v1/runs/run_01/actions/act_01?owner=acme&name=platform/ui"),
      {
        params: Promise.resolve({ runId: "run_01", actionId: "act_01" }),
      },
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(getActionDetail).not.toHaveBeenCalled();
    expect(body.message).toBe("Repository owner or name is invalid.");
  });
});
