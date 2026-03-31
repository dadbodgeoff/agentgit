import { describe, expect, it } from "vitest";

import type { TimelineStep } from "@agentgit/schemas";

import { answerHelperQuery, projectTimelineSteps, projectTimelineView, type JournalEventRecord } from "./index.js";

const events: JournalEventRecord[] = [
  {
    sequence: 1,
    event_type: "run.created",
    occurred_at: "2026-03-29T12:00:00.000Z",
    recorded_at: "2026-03-29T12:00:00.000Z",
    payload: {
      workflow_name: "demo",
    },
  },
  {
    sequence: 2,
    event_type: "action.normalized",
    occurred_at: "2026-03-29T12:00:01.000Z",
    recorded_at: "2026-03-29T12:00:01.000Z",
    payload: {
      action_id: "act_1",
      operation: {
        display_name: "Delete file",
      },
    },
  },
  {
    sequence: 3,
    event_type: "policy.evaluated",
    occurred_at: "2026-03-29T12:00:01.100Z",
    recorded_at: "2026-03-29T12:00:01.100Z",
    payload: {
      action_id: "act_1",
      decision: "allow_with_snapshot",
    },
  },
  {
    sequence: 4,
    event_type: "snapshot.created",
    occurred_at: "2026-03-29T12:00:01.200Z",
    recorded_at: "2026-03-29T12:00:01.200Z",
    payload: {
      snapshot_id: "snap_1",
      action_id: "act_1",
    },
  },
  {
    sequence: 5,
    event_type: "execution.completed",
    occurred_at: "2026-03-29T12:00:01.300Z",
    recorded_at: "2026-03-29T12:00:01.300Z",
      payload: {
        action_id: "act_1",
        execution_id: "exec_1",
        mode: "executed",
      },
  },
  {
    sequence: 6,
    event_type: "recovery.planned",
    occurred_at: "2026-03-29T12:00:02.000Z",
    recorded_at: "2026-03-29T12:00:02.000Z",
    payload: {
      snapshot_id: "snap_1",
      recovery_plan_id: "rec_1",
      recovery_class: "reversible",
      strategy: "restore_snapshot",
    },
  },
  {
    sequence: 7,
    event_type: "recovery.executed",
    occurred_at: "2026-03-29T12:00:02.000Z",
    recorded_at: "2026-03-29T12:00:02.000Z",
    payload: {
      snapshot_id: "snap_1",
      recovery_plan_id: "rec_1",
      recovery_class: "reversible",
    },
  },
];

describe("timeline-helper", () => {
  it("projects grouped journal events into ordered timeline steps", () => {
    const steps = projectTimelineSteps("run_1", events);

    expect(steps).toHaveLength(3);
    expect(steps[1]?.schema_version).toBe("timeline-step.v1");
    expect(steps[1]?.title).toBe("Delete file");
    expect(steps[1]?.summary).toContain("after creating snapshot");
    expect(steps[1]?.reversibility_class).toBe("reversible");
    expect(steps[2]?.step_type).toBe("recovery_step");
  });

  it("projects review-only recovery plans honestly", () => {
    const reviewOnlyEvents: JournalEventRecord[] = [
      {
        sequence: 1,
        event_type: "recovery.planned",
        occurred_at: "2026-03-29T12:00:02.000Z",
        recorded_at: "2026-03-29T12:00:02.000Z",
        payload: {
          action_id: "act_review",
          recovery_plan_id: "rec_review",
          recovery_class: "review_only",
          strategy: "manual_review_only",
          downgrade_reason_code: "CAPABILITY_STATE_STALE",
          downgrade_reason_message:
            "Cached workspace/runtime capability state is stale; rerun capability_refresh before trusting automatic restore.",
        },
      },
    ];

    const steps = projectTimelineSteps("run_review", reviewOnlyEvents);

    expect(steps[0]?.step_type).toBe("recovery_step");
    expect(steps[0]?.action_id).toBe("act_review");
    expect(steps[0]?.reversibility_class).toBe("review_only");
    expect(steps[0]?.related.recovery_downgrade_reason).toEqual({
      code: "CAPABILITY_STATE_STALE",
      message:
        "Cached workspace/runtime capability state is stale; rerun capability_refresh before trusting automatic restore.",
    });
    expect(steps[0]?.primary_artifacts[0]?.type).toBe("recovery_boundary");
    expect(steps[0]?.summary).toContain("manual review");
  });

  it("answers grounded helper questions from steps", () => {
    const steps = projectTimelineSteps("run_1", events);
    const answer = answerHelperQuery("reversible_steps", steps);

    expect(answer.answer).toContain("reversible");
    expect(answer.evidence).toHaveLength(2);
  });

  it("explains one timeline step in grounded detail", () => {
    const steps = projectTimelineSteps("run_1", events);
    const answer = answerHelperQuery("step_details", steps, steps[1]?.step_id);

    expect(answer.answer).toContain("Delete file");
    expect(answer.answer).toContain("status completed");
    expect(answer.answer).toContain("Policy decision: allow_with_snapshot");
    expect(answer.answer).toContain("Reversibility: reversible");
    expect(answer.answer).toContain("Snapshot: snap_1");
    expect(answer.evidence).toHaveLength(1);
  });

  it("preserves structured recovery overlap evidence on recovery steps", () => {
    const recoveryEvents: JournalEventRecord[] = [
      {
        sequence: 1,
        event_type: "recovery.planned",
        occurred_at: "2026-03-29T12:00:02.000Z",
        recorded_at: "2026-03-29T12:00:02.000Z",
        payload: {
          action_id: "act_overlap",
          recovery_plan_id: "rec_overlap",
          recovery_class: "review_only",
          strategy: "manual_review_only",
          target_locator: "/tmp/restore-me.txt",
          later_actions_affected: 2,
          overlapping_paths: ["/tmp/restore-me.txt", "/tmp/other.txt"],
          data_loss_risk: "moderate",
          warnings: [
            "Recovery would overwrite 2 later action(s) touching /tmp/restore-me.txt.",
            "This boundary captured metadata only, so exact automated restore is unavailable.",
          ],
          external_effects: ["network"],
        },
      },
    ];

    const steps = projectTimelineSteps("run_overlap", recoveryEvents);

    expect(steps[0]?.related.target_locator).toBe("/tmp/restore-me.txt");
    expect(steps[0]?.related.later_actions_affected).toBe(2);
    expect(steps[0]?.related.overlapping_paths).toContain("/tmp/restore-me.txt");
    expect(steps[0]?.related.data_loss_risk).toBe("moderate");
    expect(steps[0]?.warnings?.[0]).toContain("overwrite 2 later action");
    expect(steps[0]?.external_effects).toEqual(["network"]);
  });

  it("includes first-class recovery downgrade reasons in step details and revert-loss answers", () => {
    const recoveryEvents: JournalEventRecord[] = [
      {
        sequence: 1,
        event_type: "recovery.planned",
        occurred_at: "2026-03-29T12:00:02.000Z",
        recorded_at: "2026-03-29T12:00:02.000Z",
        payload: {
          snapshot_id: "snap_capability",
          recovery_plan_id: "rec_capability",
          recovery_class: "review_only",
          strategy: "manual_review_only",
          target_locator: "/tmp/capability.txt",
          downgrade_reason_code: "WORKSPACE_CAPABILITY_UNAVAILABLE",
          downgrade_reason_message:
            "Cached workspace access capability is unavailable for this boundary; automatic restore is not trusted.",
          later_actions_affected: 1,
          overlapping_paths: ["/tmp/capability.txt"],
          data_loss_risk: "moderate",
          warnings: [
            "Cached workspace access capability is unavailable for this boundary; automatic restore is not trusted.",
          ],
        },
      },
    ];

    const steps = projectTimelineSteps("run_capability_reason", recoveryEvents);
    const detailAnswer = answerHelperQuery("step_details", steps, steps[0]?.step_id);
    const lossAnswer = answerHelperQuery("preview_revert_loss", steps, steps[0]?.step_id);

    expect(detailAnswer.answer).toContain("Recovery downgrade reason: WORKSPACE_CAPABILITY_UNAVAILABLE");
    expect(lossAnswer.answer).toContain("Primary downgrade reason: WORKSPACE_CAPABILITY_UNAVAILABLE");
  });

  it("includes artifact previews in step details when recorded", () => {
    const failedEvents: JournalEventRecord[] = [
      {
        sequence: 1,
        event_type: "action.normalized",
        occurred_at: "2026-03-29T12:00:00.000Z",
        recorded_at: "2026-03-29T12:00:00.000Z",
        payload: {
          action_id: "act_preview_1",
          operation: {
            display_name: "Run shell command",
          },
        },
      },
      {
        sequence: 2,
        event_type: "policy.evaluated",
        occurred_at: "2026-03-29T12:00:00.100Z",
        recorded_at: "2026-03-29T12:00:00.100Z",
        payload: {
          action_id: "act_preview_1",
          decision: "allow",
        },
      },
      {
        sequence: 3,
        event_type: "execution.failed",
        occurred_at: "2026-03-29T12:00:00.200Z",
        recorded_at: "2026-03-29T12:00:00.200Z",
        payload: {
          action_id: "act_preview_1",
          error: "Shell command exited with a non-zero status.",
          exit_code: 2,
          stdout_excerpt: "partial output",
          stderr_excerpt: "permission denied",
        },
      },
    ];

    const steps = projectTimelineSteps("run_preview", failedEvents);
    const answer = answerHelperQuery("step_details", steps, steps[0]?.step_id);

    expect(steps[0]?.artifact_previews).toHaveLength(2);
    expect(answer.answer).toContain("Artifact previews:");
    expect(answer.answer).toContain("stdout: partial output");
    expect(answer.answer).toContain("stderr: permission denied");
  });

  it("surfaces degraded artifact capture honestly on executed action steps", () => {
    const degradedEvents: JournalEventRecord[] = [
      {
        sequence: 1,
        event_type: "action.normalized",
        occurred_at: "2026-03-29T12:00:00.000Z",
        recorded_at: "2026-03-29T12:00:00.000Z",
        payload: {
          action_id: "act_degraded_artifacts",
          operation: {
            display_name: "Write file",
          },
        },
      },
      {
        sequence: 2,
        event_type: "policy.evaluated",
        occurred_at: "2026-03-29T12:00:00.050Z",
        recorded_at: "2026-03-29T12:00:00.050Z",
        payload: {
          action_id: "act_degraded_artifacts",
          decision: "allow",
        },
      },
      {
        sequence: 3,
        event_type: "execution.completed",
        occurred_at: "2026-03-29T12:00:00.100Z",
        recorded_at: "2026-03-29T12:00:00.100Z",
        payload: {
          action_id: "act_degraded_artifacts",
          execution_id: "exec_degraded_artifacts",
          mode: "executed",
          artifact_types: ["stdout", "file_content"],
          artifact_count: 2,
          stored_artifact_count: 1,
          artifact_capture_failed_count: 1,
          warnings: ["Supporting evidence capture degraded: 1 artifact(s) could not be stored because local storage was unavailable."],
        },
      },
    ];

    const steps = projectTimelineSteps("run_degraded_artifacts", degradedEvents);
    const answer = answerHelperQuery("step_details", steps, steps[0]?.step_id);

    expect(steps[0]?.summary).toContain("Supporting evidence capture was degraded");
    expect(steps[0]?.warnings).toContain(
      "Supporting evidence capture degraded: 1 artifact(s) could not be stored because local storage was unavailable.",
    );
    expect(answer.answer).toContain("Warnings:");
    expect(answer.answer).toContain("Supporting evidence capture degraded");
  });

  it("includes filesystem content previews in step details for governed writes", () => {
    const fileEvents: JournalEventRecord[] = [
      {
        sequence: 1,
        event_type: "action.normalized",
        occurred_at: "2026-03-29T12:00:00.000Z",
        recorded_at: "2026-03-29T12:00:00.000Z",
        payload: {
          action_id: "act_file_1",
          operation: {
            display_name: "Write file",
          },
          target_locator: "/tmp/example.txt",
          filesystem_operation: "write",
          input_preview: "hello from agentgit",
        },
      },
      {
        sequence: 2,
        event_type: "policy.evaluated",
        occurred_at: "2026-03-29T12:00:00.050Z",
        recorded_at: "2026-03-29T12:00:00.050Z",
        payload: {
          action_id: "act_file_1",
          decision: "allow",
        },
      },
      {
        sequence: 3,
        event_type: "execution.completed",
        occurred_at: "2026-03-29T12:00:00.100Z",
        recorded_at: "2026-03-29T12:00:00.100Z",
        payload: {
          action_id: "act_file_1",
          execution_id: "exec_file_1",
          mode: "executed",
          artifact_types: ["file_content", "diff"],
          artifact_count: 2,
          target_path: "/tmp/example.txt",
          operation: "write",
          bytes_written: 19,
          before_preview: "old content",
          after_preview: "hello from agentgit",
          diff_preview: "- old content\n+ hello from agentgit",
        },
      },
    ];

    const steps = projectTimelineSteps("run_file", fileEvents);
    const answer = answerHelperQuery("step_details", steps, steps[0]?.step_id);

    expect(steps[0]?.artifact_previews).toHaveLength(2);
    expect(answer.answer).toContain("Artifact previews:");
    expect(answer.answer).toContain("hello from agentgit");
    expect(answer.answer).toContain("/tmp/example.txt");
    expect(answer.answer).toContain("- old content");
  });

  it("includes recovery restore previews in step details", () => {
    const recoveryEvents: JournalEventRecord[] = [
      {
        sequence: 1,
        event_type: "recovery.executed",
        occurred_at: "2026-03-29T12:00:02.000Z",
        recorded_at: "2026-03-29T12:00:02.000Z",
        payload: {
          snapshot_id: "snap_restore_1",
          recovery_plan_id: "rec_restore_1",
          restored: true,
          target_path: "/tmp/restore-me.txt",
          existed_before: true,
          entry_kind: "file",
        },
      },
    ];

    const steps = projectTimelineSteps("run_restore", recoveryEvents);
    const answer = answerHelperQuery("step_details", steps, steps[0]?.step_id);

    expect(steps[0]?.artifact_previews).toHaveLength(1);
    expect(answer.answer).toContain("Artifact previews:");
    expect(answer.answer).toContain("Restored /tmp/restore-me.txt");
  });

  it("preserves structured branch-point recovery target metadata on recovery steps", () => {
    const recoveryEvents: JournalEventRecord[] = [
      {
        sequence: 1,
        event_type: "recovery.executed",
        occurred_at: "2026-03-29T12:00:02.000Z",
        recorded_at: "2026-03-29T12:00:02.000Z",
        payload: {
          snapshot_id: "snap_branch_1",
          recovery_plan_id: "rec_branch_1",
          recovery_class: "reversible",
          strategy: "restore_snapshot",
          target_type: "branch_point",
          branch_point_run_id: "run_branch",
          branch_point_sequence: 7,
          restored: true,
        },
      },
    ];

    const steps = projectTimelineSteps("run_branch", recoveryEvents);

    expect(steps[0]?.summary).toContain("branch point run_branch#7");
    expect(steps[0]?.related.recovery_target_type).toBe("branch_point");
    expect(steps[0]?.related.recovery_target_label).toBe("branch point run_branch#7");
    expect(steps[0]?.primary_artifacts[0]?.label).toBe("branch point run_branch#7");
  });

  it("includes path-subset recovery scope in helper step details", () => {
    const recoveryEvents: JournalEventRecord[] = [
      {
        sequence: 1,
        event_type: "recovery.executed",
        occurred_at: "2026-03-29T12:00:02.000Z",
        recorded_at: "2026-03-29T12:00:02.000Z",
        payload: {
          snapshot_id: "snap_subset_1",
          recovery_plan_id: "rec_subset_1",
          recovery_class: "reversible",
          strategy: "restore_path_subset",
          target_type: "path_subset",
          target_paths: ["src/config.json", "README.md"],
          target_locator: "src/config.json",
          restored: true,
        },
      },
    ];

    const steps = projectTimelineSteps("run_subset", recoveryEvents);
    const answer = answerHelperQuery("step_details", steps, steps[0]?.step_id);

    expect(steps[0]?.summary).toContain("path subset snap_subset_1 @ src/config.json, README.md");
    expect(steps[0]?.related.recovery_scope_paths).toEqual(["src/config.json", "README.md"]);
    expect(answer.answer).toContain("Recovery target: path_subset (path subset snap_subset_1 @ src/config.json, README.md).");
    expect(answer.answer).toContain("Recovery scope: src/config.json, README.md.");
  });

  it("includes action-boundary context in recovery step details", () => {
    const reviewOnlyEvents: JournalEventRecord[] = [
      {
        sequence: 1,
        event_type: "recovery.planned",
        occurred_at: "2026-03-29T12:00:02.000Z",
        recorded_at: "2026-03-29T12:00:02.000Z",
        payload: {
          action_id: "act_review_detail",
          recovery_plan_id: "rec_review_detail",
          recovery_class: "review_only",
          strategy: "manual_review_only",
        },
      },
    ];

    const steps = projectTimelineSteps("run_review_detail", reviewOnlyEvents);
    const answer = answerHelperQuery("step_details", steps, steps[0]?.step_id);

    expect(answer.answer).toContain("Recovery boundary action: act_review_detail");
    expect(answer.answer).toContain("Reversibility: review_only");
  });

  it("projects approval events into an approval step", () => {
    const approvalEvents: JournalEventRecord[] = [
      {
        sequence: 1,
        event_type: "approval.requested",
        occurred_at: "2026-03-29T12:00:00.000Z",
        recorded_at: "2026-03-29T12:00:00.000Z",
        payload: {
          approval_id: "apr_1",
          action_id: "act_2",
          action_summary: "Install packages",
        },
      },
      {
        sequence: 2,
        event_type: "approval.resolved",
        occurred_at: "2026-03-29T12:00:02.000Z",
        recorded_at: "2026-03-29T12:00:02.000Z",
        payload: {
          approval_id: "apr_1",
          action_id: "act_2",
          resolution: "approved",
          action_summary: "Install packages",
          resolution_note: "looks safe",
        },
      },
    ];

    const steps = projectTimelineSteps("run_2", approvalEvents);

    expect(steps).toHaveLength(1);
    expect(steps[0]?.step_type).toBe("approval_step");
    expect(steps[0]?.status).toBe("completed");
    expect(steps[0]?.summary).toContain("Install packages");
    expect(steps[0]?.summary).toContain("looks safe");
  });

  it("marks an approved-and-executed ask action as completed", () => {
    const askThenExecuteEvents: JournalEventRecord[] = [
      {
        sequence: 1,
        event_type: "action.normalized",
        occurred_at: "2026-03-29T12:00:00.000Z",
        recorded_at: "2026-03-29T12:00:00.000Z",
        payload: {
          action_id: "act_3",
          operation: {
            display_name: "Run shell command",
          },
        },
      },
      {
        sequence: 2,
        event_type: "policy.evaluated",
        occurred_at: "2026-03-29T12:00:00.100Z",
        recorded_at: "2026-03-29T12:00:00.100Z",
        payload: {
          action_id: "act_3",
          decision: "ask",
        },
      },
      {
        sequence: 3,
        event_type: "execution.completed",
        occurred_at: "2026-03-29T12:00:02.000Z",
        recorded_at: "2026-03-29T12:00:02.000Z",
        payload: {
          action_id: "act_3",
          execution_id: "exec_3",
          mode: "executed",
        },
      },
    ];

    const steps = projectTimelineSteps("run_3", askThenExecuteEvents);

    expect(steps[0]?.status).toBe("completed");
    expect(steps[0]?.summary).toContain("after approval");
  });

  it("uses policy reasons in blocked action summaries and helper answers", () => {
    const blockedEvents: JournalEventRecord[] = [
      {
        sequence: 1,
        event_type: "action.normalized",
        occurred_at: "2026-03-29T12:00:00.000Z",
        recorded_at: "2026-03-29T12:00:00.000Z",
        payload: {
          action_id: "act_4",
          operation: {
            display_name: "Install packages",
          },
        },
      },
      {
        sequence: 2,
        event_type: "policy.evaluated",
        occurred_at: "2026-03-29T12:00:00.100Z",
        recorded_at: "2026-03-29T12:00:00.100Z",
        payload: {
          action_id: "act_4",
          decision: "deny",
          reasons: [
            {
              code: "MUTATING_BUDGET_EXHAUSTED",
              message: "Run mutating action budget is exhausted.",
            },
          ],
        },
      },
    ];

    const steps = projectTimelineSteps("run_4", blockedEvents);
    const answer = answerHelperQuery("why_blocked", steps);

    expect(steps[0]?.summary).toContain("Run mutating action budget is exhausted.");
    expect(steps[0]?.primary_reason?.code).toBe("MUTATING_BUDGET_EXHAUSTED");
    expect(answer.answer).toContain("blocked");
    expect(answer.primary_reason?.code).toBe("MUTATING_BUDGET_EXHAUSTED");
    expect(answer.evidence).toHaveLength(1);
  });

  it("explains policy decisions from recorded reasons and scope", () => {
    const blockedEvents: JournalEventRecord[] = [
      {
        sequence: 1,
        event_type: "action.normalized",
        occurred_at: "2026-03-29T12:00:00.000Z",
        recorded_at: "2026-03-29T12:00:00.000Z",
        payload: {
          action_id: "act_policy_1",
          operation: {
            display_name: "Delete file",
          },
          target_locator: "/tmp/policy-target.txt",
        },
      },
      {
        sequence: 2,
        event_type: "policy.evaluated",
        occurred_at: "2026-03-29T12:00:00.100Z",
        recorded_at: "2026-03-29T12:00:00.100Z",
        payload: {
          action_id: "act_policy_1",
          decision: "deny",
          reasons: [
            {
              code: "PROTECTED_FILE_DELETE_DENIED",
              message: "Deleting protected files is not allowed.",
            },
          ],
        },
      },
    ];

    const steps = projectTimelineSteps("run_policy", blockedEvents);
    const answer = answerHelperQuery("explain_policy_decision", steps, steps[0]?.step_id);

    expect(answer.answer).toContain("evaluated as deny");
    expect(answer.answer).toContain("/tmp/policy-target.txt");
    expect(answer.answer).toContain("Deleting protected files is not allowed.");
    expect(answer.answer).toContain("Primary reason code: PROTECTED_FILE_DELETE_DENIED.");
    expect(steps[0]?.primary_reason?.code).toBe("PROTECTED_FILE_DELETE_DENIED");
    expect(answer.primary_reason?.code).toBe("PROTECTED_FILE_DELETE_DENIED");
    expect(answer.uncertainty).toHaveLength(0);
  });

  it("preserves approval primary reasons on approval steps", () => {
    const approvalEvents: JournalEventRecord[] = [
      {
        sequence: 1,
        event_type: "approval.requested",
        occurred_at: "2026-03-29T12:00:00.000Z",
        recorded_at: "2026-03-29T12:00:00.000Z",
        payload: {
          approval_id: "apr_1",
          action_id: "act_approval_1",
          action_summary: "Delete file",
          status: "pending",
          primary_reason: {
            code: "UNKNOWN_SCOPE_REQUIRES_APPROVAL",
            message: "Unknown scope requires approval before execution.",
          },
        },
      },
    ];

    const steps = projectTimelineSteps("run_approval", approvalEvents);

    expect(steps[0]?.step_type).toBe("approval_step");
    expect(steps[0]?.primary_reason).toEqual({
      code: "UNKNOWN_SCOPE_REQUIRES_APPROVAL",
      message: "Unknown scope requires approval before execution.",
    });
  });

  it("identifies the latest failed step as the likely cause", () => {
    const failedEvents: JournalEventRecord[] = [
      {
        sequence: 1,
        event_type: "action.normalized",
        occurred_at: "2026-03-29T12:00:00.000Z",
        recorded_at: "2026-03-29T12:00:00.000Z",
        payload: {
          action_id: "act_likely_1",
          operation: {
            display_name: "Run shell command",
          },
        },
      },
      {
        sequence: 2,
        event_type: "policy.evaluated",
        occurred_at: "2026-03-29T12:00:00.100Z",
        recorded_at: "2026-03-29T12:00:00.100Z",
        payload: {
          action_id: "act_likely_1",
          decision: "ask",
        },
      },
      {
        sequence: 3,
        event_type: "execution.failed",
        occurred_at: "2026-03-29T12:00:00.200Z",
        recorded_at: "2026-03-29T12:00:00.200Z",
        payload: {
          action_id: "act_likely_1",
          error: "Shell command exited with a non-zero status.",
          exit_code: 3,
          stderr_excerpt: "boom",
        },
      },
    ];

    const steps = projectTimelineSteps("run_likely", failedEvents);
    const answer = answerHelperQuery("likely_cause", steps);

    expect(answer.answer).toContain("Run shell command");
    expect(answer.answer).toContain("exited with code 3");
    expect(answer.evidence.length).toBeGreaterThan(0);
  });

  it("describes the steps recorded after a focus step", () => {
    const steps = projectTimelineSteps("run_1", events);
    const answer = answerHelperQuery("what_changed_after_step", steps, steps[0]?.step_id);

    expect(answer.answer).toContain("After Run created");
    expect(answer.answer).toContain("2 later step(s)");
    expect(answer.evidence).toHaveLength(2);
  });

  it("estimates revert impact from a focus step", () => {
    const steps = projectTimelineSteps("run_1", events);
    const answer = answerHelperQuery("revert_impact", steps, steps[0]?.step_id);

    expect(answer.answer).toContain("would discard 2 later step(s)");
    expect(answer.answer).toContain("Delete file");
    expect(answer.evidence).toHaveLength(2);
  });

  it("explains what would be lost by reverting at a given step", () => {
    const steps = projectTimelineSteps("run_1", events);
    const answer = answerHelperQuery("what_would_i_lose_if_i_revert_here", steps, steps[0]?.step_id);

    expect(answer.answer).toContain("would remove 2 later recorded step(s)");
    expect(answer.answer).toContain("Delete file");
    expect(answer.answer).toContain("Recovery executed");
    expect(answer.evidence).toHaveLength(2);
  });

  it("grounds preview_revert_loss in structured overlap warnings for review-only boundaries", () => {
    const recoveryEvents: JournalEventRecord[] = [
      {
        sequence: 1,
        event_type: "recovery.planned",
        occurred_at: "2026-03-29T12:00:02.000Z",
        recorded_at: "2026-03-29T12:00:02.000Z",
        payload: {
          action_id: "act_preview_loss",
          recovery_plan_id: "rec_preview_loss",
          recovery_class: "review_only",
          strategy: "manual_review_only",
          target_locator: "/tmp/preview-loss.txt",
          later_actions_affected: 3,
          overlapping_paths: ["/tmp/preview-loss.txt"],
          data_loss_risk: "moderate",
          warnings: ["Recovery would overwrite 3 later action(s) touching /tmp/preview-loss.txt."],
        },
      },
    ];

    const steps = projectTimelineSteps("run_preview_loss", recoveryEvents);
    const answer = answerHelperQuery("preview_revert_loss", steps, steps[0]?.step_id);

    expect(answer.answer).toContain("affect 3 later action(s)");
    expect(answer.answer).toContain("/tmp/preview-loss.txt");
    expect(answer.answer).toContain("review-only");
    expect(answer.uncertainty[0]).toContain("manual review or compensation");
  });

  it("reports steps with external side effects from recorded hints", () => {
    const networkEvents: JournalEventRecord[] = [
      {
        sequence: 1,
        event_type: "action.normalized",
        occurred_at: "2026-03-29T12:00:00.000Z",
        recorded_at: "2026-03-29T12:00:00.000Z",
        payload: {
          action_id: "act_net_1",
          operation: {
            display_name: "Install packages",
          },
          risk_hints: {
            external_effects: "network",
          },
        },
      },
      {
        sequence: 2,
        event_type: "policy.evaluated",
        occurred_at: "2026-03-29T12:00:00.100Z",
        recorded_at: "2026-03-29T12:00:00.100Z",
        payload: {
          action_id: "act_net_1",
          decision: "ask",
        },
      },
    ];

    const steps = projectTimelineSteps("run_net", networkEvents);
    const answer = answerHelperQuery("external_side_effects", steps);

    expect(steps[0]?.external_effects).toEqual(["network"]);
    expect(answer.answer).toContain("external side effects");
    expect(answer.answer).toContain("Install packages");
    expect(answer.evidence).toHaveLength(1);
  });

  it("lists other actions touching the same recorded scope and degrades when scope is missing", () => {
    const scopeEvents: JournalEventRecord[] = [
      {
        sequence: 1,
        event_type: "action.normalized",
        occurred_at: "2026-03-29T12:00:00.000Z",
        recorded_at: "2026-03-29T12:00:00.000Z",
        payload: {
          action_id: "act_scope_1",
          operation: {
            display_name: "Write file",
          },
          target_locator: "/tmp/shared.txt",
        },
      },
      {
        sequence: 2,
        event_type: "policy.evaluated",
        occurred_at: "2026-03-29T12:00:00.050Z",
        recorded_at: "2026-03-29T12:00:00.050Z",
        payload: {
          action_id: "act_scope_1",
          decision: "allow",
        },
      },
      {
        sequence: 3,
        event_type: "action.normalized",
        occurred_at: "2026-03-29T12:00:01.000Z",
        recorded_at: "2026-03-29T12:00:01.000Z",
        payload: {
          action_id: "act_scope_2",
          operation: {
            display_name: "Delete file",
          },
          target_locator: "/tmp/shared.txt",
        },
      },
      {
        sequence: 4,
        event_type: "policy.evaluated",
        occurred_at: "2026-03-29T12:00:01.050Z",
        recorded_at: "2026-03-29T12:00:01.050Z",
        payload: {
          action_id: "act_scope_2",
          decision: "allow_with_snapshot",
        },
      },
      {
        sequence: 5,
        event_type: "run.started",
        occurred_at: "2026-03-29T12:00:02.000Z",
        recorded_at: "2026-03-29T12:00:02.000Z",
      },
    ];

    const steps = projectTimelineSteps("run_scope", scopeEvents);
    const scopedAnswer = answerHelperQuery("list_actions_touching_scope", steps, steps[0]?.step_id);
    const missingScopeAnswer = answerHelperQuery("list_actions_touching_scope", steps, steps[2]?.step_id);

    expect(scopedAnswer.answer).toContain("touching /tmp/shared.txt");
    expect(scopedAnswer.evidence).toHaveLength(1);
    expect(missingScopeAnswer.answer).toContain("does not carry a recorded target scope");
    expect(missingScopeAnswer.uncertainty[0]).toContain("target locators");
  });

  it("compares two timeline steps and summarizes what happened between them", () => {
    const steps = projectTimelineSteps("run_1", events);
    const answer = answerHelperQuery("compare_steps", steps, steps[0]?.step_id, steps[2]?.step_id);

    expect(answer.answer).toContain("Between Run created");
    expect(answer.answer).toContain("2 step(s) were recorded");
    expect(answer.answer).toContain("Recovery executed");
    expect(answer.evidence.length).toBeGreaterThanOrEqual(3);
  });

  it("surfaces shell failure details and stderr artifacts in the timeline", () => {
    const failedEvents: JournalEventRecord[] = [
      {
        sequence: 1,
        event_type: "action.normalized",
        occurred_at: "2026-03-29T12:00:00.000Z",
        recorded_at: "2026-03-29T12:00:00.000Z",
        payload: {
          action_id: "act_6",
          operation: {
            display_name: "Run shell command",
          },
        },
      },
      {
        sequence: 2,
        event_type: "policy.evaluated",
        occurred_at: "2026-03-29T12:00:00.100Z",
        recorded_at: "2026-03-29T12:00:00.100Z",
        payload: {
          action_id: "act_6",
          decision: "allow",
        },
      },
      {
        sequence: 3,
        event_type: "execution.failed",
        occurred_at: "2026-03-29T12:00:00.200Z",
        recorded_at: "2026-03-29T12:00:00.200Z",
        payload: {
          action_id: "act_6",
          error: "Shell command exited with a non-zero status.",
          exit_code: 3,
          stderr_excerpt: "boom",
        },
      },
    ];

    const steps = projectTimelineSteps("run_6", failedEvents);

    expect(steps[0]?.status).toBe("failed");
    expect(steps[0]?.summary).toContain("exited with code 3");
    expect(steps[0]?.summary).toContain("stderr: boom");
    expect(
      steps[0]?.primary_artifacts.some((artifact: { type: string }) => artifact.type === "stderr"),
    ).toBe(true);
  });

  it("surfaces unknown execution outcomes as partial action steps", () => {
    const unknownOutcomeEvents: JournalEventRecord[] = [
      {
        sequence: 1,
        event_type: "action.normalized",
        occurred_at: "2026-03-29T12:00:00.000Z",
        recorded_at: "2026-03-29T12:00:00.000Z",
        payload: {
          action_id: "act_unknown_1",
          operation: {
            display_name: "Delete file",
          },
        },
      },
      {
        sequence: 2,
        event_type: "policy.evaluated",
        occurred_at: "2026-03-29T12:00:00.050Z",
        recorded_at: "2026-03-29T12:00:00.050Z",
        payload: {
          action_id: "act_unknown_1",
          decision: "allow_with_snapshot",
        },
      },
      {
        sequence: 3,
        event_type: "snapshot.created",
        occurred_at: "2026-03-29T12:00:00.100Z",
        recorded_at: "2026-03-29T12:00:00.100Z",
        payload: {
          action_id: "act_unknown_1",
          snapshot_id: "snap_unknown_1",
        },
      },
      {
        sequence: 4,
        event_type: "execution.outcome_unknown",
        occurred_at: "2026-03-29T12:00:00.200Z",
        recorded_at: "2026-03-29T12:00:00.200Z",
        payload: {
          action_id: "act_unknown_1",
          message: "Daemon restarted before a terminal execution event was recorded.",
        },
      },
    ];

    const steps = projectTimelineSteps("run_unknown", unknownOutcomeEvents);
    const answer = answerHelperQuery("likely_cause", steps);

    expect(steps[0]?.status).toBe("partial");
    expect(steps[0]?.summary).toContain("final outcome is unknown");
    expect(answer.answer).toContain("unknown execution outcome");
    expect(answer.uncertainty[0]).toContain("unknown execution outcome");
  });

  it("projects imported actions as non-governed analysis steps", () => {
    const importedEvents: JournalEventRecord[] = [
      {
        sequence: 1,
        event_type: "action.imported",
        occurred_at: "2026-03-29T15:29:20.000Z",
        recorded_at: "2026-03-29T15:30:01.000Z",
        payload: {
          action_id: "act_imported_1",
          operation: {
            display_name: "Imported provider-side action",
          },
          provenance_mode: "imported",
          provenance_confidence: 0.61,
          risk_hints: {
            external_effects: "network",
          },
          governed: false,
        },
      },
    ];

    const steps = projectTimelineSteps("run_imported", importedEvents);

    expect(steps[0]?.step_type).toBe("analysis_step");
    expect(steps[0]?.provenance).toBe("imported");
    expect(steps[0]?.reversibility_class).toBe("review_only");
    expect(steps[0]?.summary).toContain("imported from external history");
    expect(steps[0]?.external_effects).toEqual(["network"]);
  });

  it("treats observed-only actions as a weak likely-cause signal when no explicit failure exists", () => {
    const observedEvents: JournalEventRecord[] = [
      {
        sequence: 1,
        event_type: "action.normalized",
        occurred_at: "2026-03-29T12:00:00.000Z",
        recorded_at: "2026-03-29T12:00:00.000Z",
        payload: {
          action_id: "act_observed_1",
          operation: {
            display_name: "Observed remote mutation",
          },
          provenance_mode: "observed",
          provenance_confidence: 0.58,
          target_locator: "tickets://issue/123",
        },
      },
    ];

    const steps = projectTimelineSteps("run_observed", observedEvents);
    const answer = answerHelperQuery("suggest_likely_cause", steps);
    const details = answerHelperQuery("step_details", steps, steps[0]?.step_id);

    expect(steps[0]?.provenance).toBe("observed");
    expect(answer.answer).toContain("observed rather than governed");
    expect(answer.uncertainty[0]).toContain("weak trust provenance");
    expect(details.answer).toContain("Trust level: observed");
  });

  it("includes partial status counts in run summaries", () => {
    const unknownOutcomeEvents: JournalEventRecord[] = [
      {
        sequence: 1,
        event_type: "run.created",
        occurred_at: "2026-03-29T12:00:00.000Z",
        recorded_at: "2026-03-29T12:00:00.000Z",
        payload: {
          workflow_name: "demo",
        },
      },
      {
        sequence: 2,
        event_type: "action.normalized",
        occurred_at: "2026-03-29T12:00:00.050Z",
        recorded_at: "2026-03-29T12:00:00.050Z",
        payload: {
          action_id: "act_unknown_2",
          operation: {
            display_name: "Delete file",
          },
        },
      },
      {
        sequence: 3,
        event_type: "policy.evaluated",
        occurred_at: "2026-03-29T12:00:00.100Z",
        recorded_at: "2026-03-29T12:00:00.100Z",
        payload: {
          action_id: "act_unknown_2",
          decision: "allow_with_snapshot",
        },
      },
      {
        sequence: 4,
        event_type: "snapshot.created",
        occurred_at: "2026-03-29T12:00:00.150Z",
        recorded_at: "2026-03-29T12:00:00.150Z",
        payload: {
          action_id: "act_unknown_2",
          snapshot_id: "snap_unknown_2",
        },
      },
      {
        sequence: 5,
        event_type: "execution.outcome_unknown",
        occurred_at: "2026-03-29T12:00:00.200Z",
        recorded_at: "2026-03-29T12:00:00.200Z",
        payload: {
          action_id: "act_unknown_2",
          message: "Daemon restarted before a terminal execution event was recorded.",
        },
      },
    ];

    const steps = projectTimelineSteps("run_unknown_2", unknownOutcomeEvents);
    const answer = answerHelperQuery("run_summary", steps);

    expect(answer.answer).toContain("Status summary:");
    expect(answer.answer).toContain("1 partial");
    expect(answer.answer).toContain("1 completed");
  });

  it("adds trust summaries to run and post-boundary helper answers when non-governed steps are present", () => {
    const steps = projectTimelineSteps("run_trust_summary", [
      {
        sequence: 1,
        event_type: "action.normalized",
        occurred_at: "2026-03-29T16:00:00.000Z",
        recorded_at: "2026-03-29T16:00:00.000Z",
        payload: {
          action_id: "act_governed",
          operation: {
            display_name: "Governed file write",
          },
          target_locator: "file:///workspace/a.txt",
        },
      },
      {
        sequence: 2,
        event_type: "execution.completed",
        occurred_at: "2026-03-29T16:00:00.100Z",
        recorded_at: "2026-03-29T16:00:00.100Z",
        payload: {
          action_id: "act_governed",
          execution_id: "exec_governed",
        },
      },
      {
        sequence: 3,
        event_type: "action.imported",
        occurred_at: "2026-03-29T16:00:01.000Z",
        recorded_at: "2026-03-29T16:00:01.000Z",
        payload: {
          action_id: "act_imported",
          operation: {
            display_name: "Imported provider-side action",
          },
          provenance_mode: "imported",
          provenance_confidence: 0.61,
          governed: false,
          target_locator: "file:///workspace/a.txt",
        },
      },
      {
        sequence: 4,
        event_type: "action.observed",
        occurred_at: "2026-03-29T16:00:02.000Z",
        recorded_at: "2026-03-29T16:00:02.000Z",
        payload: {
          action_id: "act_observed",
          operation: {
            display_name: "Observed shell write",
          },
          provenance_mode: "observed",
          provenance_confidence: 0.58,
          governed: false,
          target_locator: "file:///workspace/a.txt",
        },
      },
    ]);

    const runSummary = answerHelperQuery("run_summary", steps);
    const summarizeAfter = answerHelperQuery(
      "summarize_after_boundary",
      steps,
      "step_run_trust_summary_action_act_governed",
    );

    expect(runSummary.answer).toContain("analysis step(s)");
    expect(runSummary.answer).toContain("Trust summary: 2 non-governed step(s) were recorded (1 imported, 1 observed).");
    expect(runSummary.uncertainty[0]).toContain("not governed pre-execution");
    expect(summarizeAfter.answer).toContain("Trust summary: 2 non-governed step(s) were recorded (1 imported, 1 observed).");
    expect(summarizeAfter.uncertainty[0]).toContain("later steps were not governed pre-execution");
  });

  it("calls out weak-trust evidence in revert, external-effect, and scope-match answers", () => {
    const steps: TimelineStep[] = [
      {
        schema_version: "timeline-step.v1" as const,
        step_id: "step_focus",
        run_id: "run_scope",
        sequence: 1,
        step_type: "action_step" as const,
        title: "Governed delete",
        status: "completed" as const,
        provenance: "governed" as const,
        action_id: "act_focus",
        decision: null,
        reversibility_class: "reversible" as const,
        confidence: 0.97,
        summary: "Governed delete completed.",
        warnings: [],
        primary_artifacts: [],
        artifact_previews: [],
        external_effects: [],
        related: {
          snapshot_id: "snap_focus",
          execution_id: null,
          recovery_plan_ids: [],
          target_locator: "file:///workspace/a.txt",
          recovery_strategy: null,
          later_actions_affected: null,
          overlapping_paths: [],
          data_loss_risk: null,
        },
        occurred_at: "2026-03-29T17:00:00.000Z",
      },
      {
        schema_version: "timeline-step.v1" as const,
        step_id: "step_imported",
        run_id: "run_scope",
        sequence: 2,
        step_type: "analysis_step" as const,
        title: "Imported provider-side action",
        status: "completed" as const,
        provenance: "imported" as const,
        action_id: "act_imported",
        decision: null,
        reversibility_class: "review_only" as const,
        confidence: 0.61,
        summary: "Imported provider-side action was imported from external history and was not governed pre-execution.",
        warnings: [],
        primary_artifacts: [],
        artifact_previews: [],
        external_effects: ["network"],
        related: {
          snapshot_id: null,
          execution_id: null,
          recovery_plan_ids: [],
          target_locator: "file:///workspace/a.txt",
          recovery_strategy: null,
          later_actions_affected: null,
          overlapping_paths: [],
          data_loss_risk: null,
        },
        occurred_at: "2026-03-29T17:00:01.000Z",
      },
    ];

    const revertLoss = answerHelperQuery("preview_revert_loss", steps, "step_focus");
    const external = answerHelperQuery("identify_external_effects", steps);
    const touchingScope = answerHelperQuery("list_actions_touching_scope", steps, "step_focus");

    expect(revertLoss.answer).toContain("weaker trust provenance");
    expect(revertLoss.uncertainty[0]).toContain("non-governed");
    expect(external.answer).toContain("non-governed");
    expect(external.uncertainty[0]).toContain("non-governed");
    expect(touchingScope.answer).toContain("matching step(s) are non-governed");
    expect(touchingScope.uncertainty[0]).toContain("non-governed");
  });

  it("redacts visibility-tagged previews at user scope and exposes them at sensitive_internal scope", () => {
    const events: JournalEventRecord[] = [
      {
        sequence: 1,
        event_type: "action.normalized",
        occurred_at: "2026-03-29T18:00:00.000Z",
        recorded_at: "2026-03-29T18:00:00.000Z",
        payload: {
          action_id: "act_sensitive",
          operation: {
            display_name: "Write secret file",
          },
          target_locator: "file:///workspace/secret.txt",
          input_preview: "token=super-secret",
          input_preview_visibility: "sensitive_internal",
        },
      },
      {
        sequence: 2,
        event_type: "execution.completed",
        occurred_at: "2026-03-29T18:00:00.100Z",
        recorded_at: "2026-03-29T18:00:00.100Z",
        payload: {
          action_id: "act_sensitive",
          execution_id: "exec_sensitive",
          artifact_types: ["file_content", "stdout"],
          stdout_excerpt: "Bearer secret-token",
          stdout_excerpt_visibility: "internal",
        },
      },
    ];

    const userView = projectTimelineView("run_sensitive", events, "user");
    const internalView = projectTimelineView("run_sensitive", events, "internal");
    const sensitiveView = projectTimelineView("run_sensitive", events, "sensitive_internal");

    expect(userView.redactions_applied).toBe(2);
    expect(userView.steps[0]?.artifact_previews).toHaveLength(0);
    expect(internalView.redactions_applied).toBe(1);
    expect(
      internalView.steps[0]?.artifact_previews.some((preview: { preview: string }) => preview.preview.includes("Bearer secret-token")),
    ).toBe(true);
    expect(sensitiveView.redactions_applied).toBe(0);
    expect(
      sensitiveView.steps[0]?.artifact_previews.some((preview: { preview: string }) => preview.preview.includes("token=super-secret")),
    ).toBe(true);
  });

  it("tracks truncated and omitted previews when inline artifact budget is exhausted", () => {
    const oversized = "x".repeat(320);
    const budgetEvents: JournalEventRecord[] = [];

    for (let index = 0; index < 4; index += 1) {
      const actionId = `act_budget_${index}`;
      const sequenceBase = index * 3;
      budgetEvents.push(
        {
          sequence: sequenceBase + 1,
          event_type: "action.normalized",
          occurred_at: `2026-03-29T18:00:0${index}.000Z`,
          recorded_at: `2026-03-29T18:00:0${index}.000Z`,
          payload: {
            action_id: actionId,
            operation: {
              display_name: `Budget action ${index}`,
            },
            target_locator: `/tmp/budget-${index}.txt`,
            filesystem_operation: "write",
            input_preview: oversized,
          },
        },
        {
          sequence: sequenceBase + 2,
          event_type: "policy.evaluated",
          occurred_at: `2026-03-29T18:00:0${index}.100Z`,
          recorded_at: `2026-03-29T18:00:0${index}.100Z`,
          payload: {
            action_id: actionId,
            decision: "allow",
          },
        },
        {
          sequence: sequenceBase + 3,
          event_type: "execution.completed",
          occurred_at: `2026-03-29T18:00:0${index}.200Z`,
          recorded_at: `2026-03-29T18:00:0${index}.200Z`,
          payload: {
            action_id: actionId,
            execution_id: `exec_budget_${index}`,
            mode: "executed",
            artifact_types: ["file_content", "diff"],
            diff_preview: oversized,
            stdout_excerpt: oversized,
            stderr_excerpt: oversized,
          },
        },
      );
    }

    const view = projectTimelineView("run_budget", budgetEvents, "user");

    expect(view.preview_budget.max_inline_preview_chars).toBe(160);
    expect(view.preview_budget.max_total_inline_preview_chars).toBe(1200);
    expect(view.preview_budget.preview_chars_used).toBe(1200);
    expect(view.preview_budget.truncated_previews).toBeGreaterThan(0);
    expect(view.preview_budget.omitted_previews).toBeGreaterThan(0);
    expect(view.steps[3]?.artifact_previews).toHaveLength(0);
  });
});
