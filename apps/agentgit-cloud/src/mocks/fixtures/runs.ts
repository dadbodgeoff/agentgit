import { RunDetailSchema, type PreviewState, type RunDetail } from "@/schemas/cloud";

const runReadyFixture = RunDetailSchema.parse({
  id: "run_7f3a2b",
  repoId: "repo_abc123",
  runtime: "claude-code",
  status: "completed",
  startedAt: "2026-04-06T14:30:00Z",
  endedAt: "2026-04-06T14:32:34Z",
  actionCount: 12,
  actionsAllowed: 9,
  actionsDenied: 1,
  actionsAsked: 2,
  snapshotsTaken: 3,
  summary: "Refactored auth module. 12 actions, 2 required approval.",
});

export function getRunFixture(_runId: string, _previewState: PreviewState): RunDetail {
  return runReadyFixture;
}
