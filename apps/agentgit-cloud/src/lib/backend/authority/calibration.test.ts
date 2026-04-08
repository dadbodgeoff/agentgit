import fs from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunJournal } from "@agentgit/run-journal";

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
    const result = await getRepositoryCalibrationReport("repo_01", "ws_acme_01");

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

  it("falls back to local journal calibration data when the authority daemon call fails", async () => {
    findRepositoryRuntimeRecordById.mockReturnValue({
      metadata: { root: "/tmp/repo" },
      inventory: { id: "repo_01" },
    });
    withScopedAuthorityClient.mockRejectedValue(new Error("daemon unavailable"));

    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const journalClose = vi.fn();
    vi.spyOn(RunJournal.prototype, "getPolicyCalibrationReport").mockReturnValue({
      report: {
        filters: {
          run_id: null,
        },
        totals: {
          sample_count: 7,
          calibration: {
            brier_score: 0.18,
            expected_calibration_error: 0.09,
            bins: [
              {
                confidence_floor: 0,
                sample_count: 2,
                resolved_sample_count: 2,
                approved_count: 0,
              },
              {
                confidence_floor: 0.8,
                sample_count: 5,
                resolved_sample_count: 5,
                approved_count: 4,
              },
            ],
          },
        },
      },
    } as never);
    vi.spyOn(RunJournal.prototype, "close").mockImplementation(journalClose);

    const { getRepositoryCalibrationReport } = await import("./calibration");
    const result = await getRepositoryCalibrationReport("repo_01", "ws_acme_01");

    expect(result).toMatchObject({
      repoId: "repo_01",
      totalActions: 7,
      brierScore: 0.18,
      ece: 0.09,
      recommendations: [],
    });
    expect(journalClose).toHaveBeenCalled();
  });

  it("maps calibration threshold replay preview into the cloud contract", async () => {
    findRepositoryRuntimeRecordById.mockReturnValue({
      metadata: { root: "/tmp/repo" },
      inventory: { id: "repo_01" },
    });
    withScopedAuthorityClient.mockResolvedValue({
      generated_at: "2026-04-08T12:00:00Z",
      effective_policy_profile: "guarded",
      candidate_thresholds: [{ action_family: "shell/exec", ask_below: 0.42 }],
      filters: {
        run_id: null,
        include_changed_samples: false,
        sample_limit: null,
      },
      summary: {
        replayable_samples: 14,
        skipped_samples: 2,
        changed_decisions: 3,
        unchanged_decisions: 11,
        current_approvals_requested: 6,
        candidate_approvals_requested: 4,
        approvals_reduced: 2,
        approvals_increased: 0,
        historically_denied_auto_allowed: 0,
        historically_approved_auto_allowed: 0,
        historically_allowed_newly_gated: 1,
        current_matches_recorded: 14,
        current_diverges_from_recorded: 0,
      },
      action_families: [
        {
          action_family: "shell/exec",
          current_ask_below: 0.3,
          candidate_ask_below: 0.42,
          replayable_samples: 14,
          skipped_samples: 2,
          changed_decisions: 3,
          unchanged_decisions: 11,
          current_approvals_requested: 6,
          candidate_approvals_requested: 4,
          approvals_reduced: 2,
          approvals_increased: 0,
          historically_denied_auto_allowed: 0,
          historically_approved_auto_allowed: 0,
          historically_allowed_newly_gated: 1,
          current_matches_recorded: 14,
          current_diverges_from_recorded: 0,
        },
      ],
      samples_truncated: false,
    });

    const { replayRepositoryCalibrationThresholds } = await import("./calibration");
    const result = await replayRepositoryCalibrationThresholds("repo_01", "ws_acme_01", [
      {
        actionFamily: "shell/exec",
        askBelow: 0.42,
      },
    ]);

    expect(result).toMatchObject({
      repoId: "repo_01",
      effectivePolicyProfile: "guarded",
      candidateThresholds: [{ actionFamily: "shell/exec", askBelow: 0.42 }],
      summary: {
        changedDecisions: 3,
        approvalsReduced: 2,
      },
      actionFamilies: [
        {
          domain: "shell/exec",
          candidateAskThreshold: 0.42,
        },
      ],
    });
  });
});
