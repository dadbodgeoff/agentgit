import "server-only";

import fs from "node:fs";
import path from "node:path";

import { RunJournal } from "@agentgit/run-journal";
import type { GetPolicyCalibrationReportResponsePayload, PolicyThresholdRecommendation } from "@agentgit/schemas";

import { withScopedAuthorityClient } from "@/lib/backend/authority/client";
import { findRepositoryRuntimeRecordById } from "@/lib/backend/workspace/repository-inventory";
import { CalibrationReportSchema, type CalibrationBand, type CalibrationRecommendation } from "@/schemas/cloud";

function clampMetric(value: number | null | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}

function buildBand(
  bins: GetPolicyCalibrationReportResponsePayload["report"]["totals"]["calibration"]["bins"],
  predicate: (confidenceFloor: number) => boolean,
  minimum: number,
): CalibrationBand {
  const matched = bins.filter((bin) => predicate(bin.confidence_floor));
  const count = matched.reduce((sum, bin) => sum + bin.sample_count, 0);
  const resolved = matched.reduce((sum, bin) => sum + bin.resolved_sample_count, 0);
  const approved = matched.reduce((sum, bin) => sum + bin.approved_count, 0);

  return {
    min: minimum,
    count,
    accuracy: resolved > 0 ? clampMetric(approved / resolved) : 0,
  };
}

function mapRecommendation(recommendation: PolicyThresholdRecommendation): CalibrationRecommendation | null {
  if (recommendation.recommended_ask_below === null) {
    return null;
  }

  return {
    domain: recommendation.action_family,
    currentAskThreshold: clampMetric(recommendation.current_ask_below ?? 0),
    recommended: clampMetric(recommendation.recommended_ask_below),
    impact: recommendation.rationale,
  };
}

function getJournalPath(repoRoot: string): string {
  return path.join(repoRoot, ".agentgit", "state", "authority.db");
}

function mapCalibrationReport(params: {
  calibrationReport: GetPolicyCalibrationReportResponsePayload["report"];
  recommendations: PolicyThresholdRecommendation[];
  repoId: string;
}) {
  const totals = params.calibrationReport.totals;
  const quality = totals.calibration;

  return CalibrationReportSchema.parse({
    repoId: params.repoId,
    period: params.calibrationReport.filters.run_id
      ? `Run ${params.calibrationReport.filters.run_id}`
      : "workspace history",
    totalActions: totals.sample_count,
    brierScore: clampMetric(quality.brier_score),
    ece: clampMetric(quality.expected_calibration_error),
    bands: {
      high: buildBand(quality.bins, (floor) => floor >= 0.85, 0.85),
      guarded: buildBand(quality.bins, (floor) => floor >= 0.65 && floor < 0.85, 0.65),
      low: buildBand(quality.bins, (floor) => floor < 0.65, 0),
    },
    recommendations: params.recommendations
      .map(mapRecommendation)
      .filter((recommendation): recommendation is CalibrationRecommendation => recommendation !== null),
  });
}

function buildLocalFallbackCalibrationReport(repoId: string, repoRoot: string) {
  const journalPath = getJournalPath(repoRoot);
  if (!fs.existsSync(journalPath)) {
    return CalibrationReportSchema.parse({
      repoId,
      period: "workspace history",
      totalActions: 0,
      brierScore: 0,
      ece: 0,
      bands: {
        high: { min: 0.85, count: 0, accuracy: 0 },
        guarded: { min: 0.65, count: 0, accuracy: 0 },
        low: { min: 0, count: 0, accuracy: 0 },
      },
      recommendations: [],
    });
  }

  const journal = new RunJournal({ dbPath: journalPath });
  try {
    const report = journal.getPolicyCalibrationReport({
      include_samples: false,
      sample_limit: null,
    });

    return mapCalibrationReport({
      calibrationReport: report.report,
      recommendations: [],
      repoId,
    });
  } catch {
    return CalibrationReportSchema.parse({
      repoId,
      period: "workspace history",
      totalActions: 0,
      brierScore: 0,
      ece: 0,
      bands: {
        high: { min: 0.85, count: 0, accuracy: 0 },
        guarded: { min: 0.65, count: 0, accuracy: 0 },
        low: { min: 0, count: 0, accuracy: 0 },
      },
      recommendations: [],
    });
  } finally {
    journal.close();
  }
}

export async function getRepositoryCalibrationReport(repoId: string, workspaceId: string) {
  const repository = await findRepositoryRuntimeRecordById(repoId, workspaceId);
  if (!repository) {
    return null;
  }

  try {
    const [calibrationReport, thresholdRecommendations] = await Promise.all([
      withScopedAuthorityClient([repository.metadata.root], (client) =>
        client.getPolicyCalibrationReport({
          include_samples: false,
        }),
      ),
      withScopedAuthorityClient([repository.metadata.root], (client) =>
        client.getPolicyThresholdRecommendations({
          min_samples: 5,
        }),
      ),
    ]);

    return mapCalibrationReport({
      calibrationReport: calibrationReport.report,
      recommendations: thresholdRecommendations.recommendations,
      repoId: repository.inventory.id,
    });
  } catch {
    return buildLocalFallbackCalibrationReport(repository.inventory.id, repository.metadata.root);
  }
}
