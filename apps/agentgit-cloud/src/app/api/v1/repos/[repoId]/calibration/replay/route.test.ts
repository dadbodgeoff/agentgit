import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiRole = vi.fn();
const replayRepositoryCalibrationThresholds = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiRole,
}));

vi.mock("@/lib/backend/authority/calibration", () => ({
  replayRepositoryCalibrationThresholds,
}));

describe("repository calibration replay route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a threshold replay preview for an authorized admin", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "admin" },
      },
    });
    replayRepositoryCalibrationThresholds.mockResolvedValue({
      repoId: "repo_01",
      generatedAt: "2026-04-08T12:00:00Z",
      effectivePolicyProfile: "guarded",
      candidateThresholds: [{ actionFamily: "shell/exec", askBelow: 0.42 }],
      summary: {
        replayableSamples: 14,
        skippedSamples: 2,
        changedDecisions: 3,
        currentApprovalsRequested: 6,
        candidateApprovalsRequested: 4,
        approvalsReduced: 2,
        approvalsIncreased: 0,
        historicallyDeniedAutoAllowed: 0,
        historicallyAllowedNewlyGated: 1,
      },
      actionFamilies: [],
      samplesTruncated: false,
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/v1/repos/repo_01/calibration/replay", {
        method: "POST",
        body: JSON.stringify({
          candidateThresholds: [{ actionFamily: "shell/exec", askBelow: 0.42 }],
        }),
      }),
      {
        params: Promise.resolve({ repoId: "repo_01" }),
      },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.repoId).toBe("repo_01");
  });

  it("returns a 400 for invalid replay payloads", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "admin" },
      },
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/v1/repos/repo_01/calibration/replay", {
        method: "POST",
        body: JSON.stringify({ candidateThresholds: [] }),
      }),
      {
        params: Promise.resolve({ repoId: "repo_01" }),
      },
    );

    expect(response.status).toBe(400);
  });
});
