import { CalibrationReportSchema, type CalibrationReport, type PreviewState } from "@/schemas/cloud";

const calibrationReadyFixture = CalibrationReportSchema.parse({
  repoId: "repo_abc123",
  period: "30d",
  totalActions: 847,
  brierScore: 0.12,
  ece: 0.08,
  bands: {
    high: { min: 0.85, count: 612, accuracy: 0.97 },
    guarded: { min: 0.65, count: 178, accuracy: 0.81 },
    low: { min: 0.0, count: 57, accuracy: 0.42 },
  },
  recommendations: [
    {
      domain: "shell",
      currentAskThreshold: 0.3,
      recommended: 0.35,
      impact: "+12 more auto-allowed actions per week",
    },
    {
      domain: "filesystem",
      currentAskThreshold: 0.25,
      recommended: 0.3,
      impact: "-3 low-confidence writes would be escalated per week",
    },
  ],
});

const calibrationEmptyFixture = CalibrationReportSchema.parse({
  repoId: "repo_abc123",
  period: "30d",
  totalActions: 12,
  brierScore: 0.42,
  ece: 0.25,
  bands: {
    high: { min: 0.85, count: 4, accuracy: 0.75 },
    guarded: { min: 0.65, count: 5, accuracy: 0.6 },
    low: { min: 0.0, count: 3, accuracy: 0.33 },
  },
  recommendations: [],
});

export function getCalibrationFixture(previewState: PreviewState): CalibrationReport {
  return previewState === "empty" ? calibrationEmptyFixture : calibrationReadyFixture;
}
