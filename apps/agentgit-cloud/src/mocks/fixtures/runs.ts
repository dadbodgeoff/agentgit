import { RunDetailSchema, type PreviewState, type RunDetail } from "@/schemas/cloud";

const runReadyFixture = RunDetailSchema.parse({
  id: "run_7f3a2b",
  workflowName: "repo-fix-auth-refactor",
  agentName: "Codex",
  agentFramework: "cloud",
  workspaceRoots: ["/Users/geoffreyfernald/Documents/agentgit"],
  projectionStatus: "fresh",
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
  steps: [
    {
      id: "step_1",
      sequence: 1,
      title: "Open repository context",
      stepType: "analysis_step",
      status: "completed",
      decision: null,
      summary: "Loaded repository files and current runtime configuration.",
      occurredAt: "2026-04-06T14:30:04Z",
    },
    {
      id: "step_2",
      sequence: 2,
      title: "Request shell approval",
      stepType: "approval_step",
      status: "completed",
      decision: null,
      summary: "Asked for review before clearing build output and rebuilding artifacts.",
      occurredAt: "2026-04-06T14:31:12Z",
      snapshotId: "snap_102",
    },
    {
      id: "step_3",
      sequence: 3,
      title: "Apply auth refactor",
      stepType: "action_step",
      status: "completed",
      decision: "allow",
      summary: "Updated the auth session invalidation path and rebuilt generated assets.",
      occurredAt: "2026-04-06T14:32:34Z",
      snapshotId: "snap_103",
    },
  ],
});

export function getRunFixture(_runId: string, _previewState: PreviewState): RunDetail {
  return runReadyFixture;
}
