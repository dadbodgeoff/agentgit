import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiRole = vi.fn();
const getRepositoryCalibrationReport = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiRole,
}));

vi.mock("@/lib/backend/authority/calibration", () => ({
  getRepositoryCalibrationReport,
}));

describe("repository calibration route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a repo calibration payload for an authorized admin", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "admin" },
      },
    });
    getRepositoryCalibrationReport.mockResolvedValue({
      repoId: "repo_01",
      period: "workspace history",
      totalActions: 12,
      brierScore: 0.22,
      ece: 0.11,
      bands: {
        high: { min: 0.85, count: 5, accuracy: 1 },
        guarded: { min: 0.65, count: 3, accuracy: 0.66 },
        low: { min: 0, count: 4, accuracy: 0.25 },
      },
      recommendations: [],
    });

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/v1/repos/repo_01/calibration"), {
      params: Promise.resolve({ repoId: "repo_01" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.repoId).toBe("repo_01");
    expect(response.headers.get("x-agentgit-request-id")).toBeTruthy();
  });

  it("returns a 404 when calibration data cannot be resolved for the repo", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "admin" },
      },
    });
    getRepositoryCalibrationReport.mockResolvedValue(null);

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/v1/repos/repo_missing/calibration"), {
      params: Promise.resolve({ repoId: "repo_missing" }),
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.message).toContain("not found");
  });
});
