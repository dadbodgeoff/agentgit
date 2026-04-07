import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const findRepositoryRuntimeRecordById = vi.fn();
const withScopedAuthorityClient = vi.fn();

vi.mock("@/lib/backend/workspace/repository-inventory", () => ({
  findRepositoryRuntimeRecordById,
}));

vi.mock("@/lib/backend/authority/client", () => ({
  withScopedAuthorityClient,
}));

describe("authority calibration adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps calibration report and threshold recommendations into the cloud contract", async () => {
    findRepositoryRuntimeRecordById.mockReturnValue({
      metadata: { root: "/tmp/repo" },
      inventory: { id: "repo_01" },
    });
    withScopedAuthorityClient
      .mockResolvedValueOnce({
        report: {
          filters: {
            run_id: null,
          },
          totals: {
            sample_count: 12,
            calibration: {
              brier_score: 0.22,
              expected_calibration_error: 0.11,
              bins: [
                {
                  confidence_floor: 0,
                  sample_count: 4,
                  resolved_sample_count: 4,
                  approved_count: 1,
                },
                {
                  confidence_floor: 0.7,
                  sample_count: 3,
                  resolved_sample_count: 3,
                  approved_count: 2,
                },
                {
                  confidence_floor: 0.9,
                  sample_count: 5,
                  resolved_sample_count: 5,
                  approved_count: 5,
                },
              ],
            },
          },
        },
      })
      .mockResolvedValueOnce({
        recommendations: [
          {
            action_family: "shell/exec",
            current_ask_below: 0.3,
            recommended_ask_below: 0.42,
            rationale: "More denials appear below 0.42 confidence.",
          },
        ],
      });

    const { getRepositoryCalibrationReport } = await import("./calibration");
    const result = await getRepositoryCalibrationReport("repo_01");

    expect(result).toMatchObject({
      repoId: "repo_01",
      totalActions: 12,
      brierScore: 0.22,
      ece: 0.11,
    });
    expect(result?.bands.high.count).toBe(5);
    expect(result?.recommendations[0]).toMatchObject({
      domain: "shell/exec",
      currentAskThreshold: 0.3,
      recommended: 0.42,
    });
  });
});
