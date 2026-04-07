import {
  QueryApprovalInboxResponsePayloadSchema,
  QueryTimelineResponsePayloadSchema,
} from "@agentgit/schemas";

import { mapApprovalInboxToCloud, mapTimelineToRunDetail } from "@/lib/backend/authority/contracts";

describe("authority contract adapters", () => {
  it("maps approval inbox payloads into cloud approval cards", () => {
    const payload = QueryApprovalInboxResponsePayloadSchema.parse({
      items: [
        {
          approval_id: "apr_123",
          run_id: "run_123",
          workflow_name: "fix-auth",
          action_id: "act_123",
          action_summary: "Delete and rebuild generated assets.",
          action_domain: "shell",
          side_effect_level: "mutating",
          status: "denied",
          requested_at: "2026-04-06T14:31:45Z",
          resolved_at: "2026-04-06T14:35:12Z",
          resolution_note: "Need a narrower cleanup step.",
          decision_requested: "approve_or_deny",
          snapshot_required: true,
          reason_summary: "The shell command can mutate the workspace root.",
          primary_reason: {
            code: "policy.shell.threshold",
            message: "Threshold exceeded.",
          },
          target_locator: "workspace://repo",
          target_label: "repo root",
        },
      ],
      counts: {
        pending: 0,
        approved: 0,
        denied: 1,
      },
    });

    const mapped = mapApprovalInboxToCloud(payload);

    expect(mapped.items[0]).toMatchObject({
      id: "apr_123",
      workflowName: "fix-auth",
      status: "rejected",
      snapshotRequired: true,
      targetLabel: "repo root",
    });
  });

  it("maps authority timeline payloads into cloud run detail", () => {
    const payload = QueryTimelineResponsePayloadSchema.parse({
      run_summary: {
        run_id: "run_7f3a2b",
        session_id: "sess_1",
        workflow_name: "fix-auth",
        agent_framework: "cloud",
        agent_name: "Codex",
        workspace_roots: ["/workspace/repo"],
        event_count: 3,
        latest_event: {
          sequence: 3,
          event_type: "run.completed",
          occurred_at: "2026-04-06T14:32:34Z",
          recorded_at: "2026-04-06T14:32:34Z",
        },
        budget_config: {
          max_mutating_actions: 10,
          max_destructive_actions: 2,
        },
        budget_usage: {
          mutating_actions: 3,
          destructive_actions: 0,
        },
        maintenance_status: {
          projection_status: "fresh",
          projection_lag_events: 0,
          degraded_artifact_capture_actions: 0,
          low_disk_pressure_signals: 0,
          artifact_health: {
            total: 1,
            available: 1,
            missing: 0,
            expired: 0,
            corrupted: 0,
            tampered: 0,
          },
        },
        created_at: "2026-04-06T14:30:00Z",
        started_at: "2026-04-06T14:30:00Z",
      },
      steps: [
        {
          schema_version: "timeline-step.v1",
          step_id: "step_1",
          run_id: "run_7f3a2b",
          sequence: 1,
          step_type: "approval_step",
          title: "Review shell cleanup",
          status: "completed",
          provenance: "governed",
          action_id: "act_1",
          decision: null,
          primary_reason: null,
          reversibility_class: null,
          confidence: 0.42,
          summary: "Requested approval for the cleanup step.",
          primary_artifacts: [],
          artifact_previews: [],
          external_effects: [],
          related: {
            snapshot_id: "snap_1",
            execution_id: null,
            target_locator: "workspace://repo",
            recovery_target_type: null,
            recovery_target_label: null,
            recovery_strategy: null,
            recovery_downgrade_reason: null,
            later_actions_affected: null,
            data_loss_risk: null,
          },
          occurred_at: "2026-04-06T14:31:12Z",
        },
        {
          schema_version: "timeline-step.v1",
          step_id: "step_2",
          run_id: "run_7f3a2b",
          sequence: 2,
          step_type: "action_step",
          title: "Rebuild generated assets",
          status: "completed",
          provenance: "governed",
          action_id: "act_2",
          decision: "allow_with_snapshot",
          primary_reason: null,
          reversibility_class: "reversible",
          confidence: 0.89,
          summary: "Rebuilt assets after approval.",
          primary_artifacts: [],
          artifact_previews: [],
          external_effects: [],
          related: {
            snapshot_id: "snap_1",
            execution_id: null,
            target_locator: "workspace://repo",
            recovery_target_type: null,
            recovery_target_label: null,
            recovery_strategy: null,
            recovery_downgrade_reason: null,
            later_actions_affected: null,
            data_loss_risk: null,
          },
          occurred_at: "2026-04-06T14:32:34Z",
        },
      ],
      projection_status: "fresh",
      visibility_scope: "user",
      redactions_applied: 0,
      preview_budget: {
        max_inline_preview_chars: 2000,
        max_total_inline_preview_chars: 4000,
        preview_chars_used: 0,
        truncated_previews: 0,
        omitted_previews: 0,
      },
    });

    const mapped = mapTimelineToRunDetail(payload);

    expect(mapped).toMatchObject({
      id: "run_7f3a2b",
      workflowName: "fix-auth",
      status: "completed",
      actionCount: 1,
      actionsAsked: 1,
      snapshotsTaken: 1,
    });
    expect(mapped.steps).toHaveLength(2);
  });
});
