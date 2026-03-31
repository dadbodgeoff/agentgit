import { describe, expect, it } from "vitest";

import {
  formatArtifact,
  formatCapabilities,
  formatDiagnostics,
  formatHelper,
  formatMaintenance,
  formatRecoveryPlan,
  formatRunSummary,
  formatTimeline,
} from "./main.js";

type TimelineResult = Parameters<typeof formatTimeline>[0];
type TimelineStep = TimelineResult["steps"][number];
type HelperResult = Parameters<typeof formatHelper>[0];
type HelperQuestionType = Parameters<typeof formatHelper>[1];

function makeStep(overrides: Partial<TimelineStep>): TimelineStep {
  return {
    schema_version: "timeline-step.v1",
    step_id: "step_default",
    run_id: "run_cli",
    sequence: 1,
    step_type: "action_step",
    title: "Governed action",
    status: "completed",
    provenance: "governed",
    action_id: "act_default",
    decision: null,
    reversibility_class: null,
    confidence: 0.97,
    summary: "Governed action completed.",
    warnings: [],
    primary_artifacts: [],
    artifact_previews: [],
    external_effects: [],
    related: {
      snapshot_id: null,
      execution_id: null,
      recovery_plan_ids: [],
      target_locator: null,
      recovery_strategy: null,
      recovery_downgrade_reason: null,
      later_actions_affected: null,
      overlapping_paths: [],
      data_loss_risk: null,
    },
    occurred_at: "2026-03-31T12:00:00.000Z",
    ...overrides,
  };
}

function makeTimelineResult(steps: TimelineStep[]): TimelineResult {
  return {
    run_summary: {
      run_id: "run_cli",
      session_id: "sess_cli",
      workflow_name: "trust-review",
      agent_framework: "cli",
      agent_name: "agentgit-cli",
      workspace_roots: ["/tmp/workspace"],
      event_count: steps.length,
      latest_event: null,
      budget_config: {
        max_mutating_actions: null,
        max_destructive_actions: null,
      },
      budget_usage: {
        mutating_actions: 0,
        destructive_actions: 0,
      },
      maintenance_status: {
        projection_status: "fresh",
        projection_lag_events: 0,
        degraded_artifact_capture_actions: 0,
        low_disk_pressure_signals: 0,
        artifact_health: {
          total: 0,
          available: 0,
          missing: 0,
          expired: 0,
          corrupted: 0,
          tampered: 0,
        },
      },
      created_at: "2026-03-31T12:00:00.000Z",
      started_at: "2026-03-31T12:00:00.000Z",
    },
    steps,
    projection_status: "fresh",
    visibility_scope: "user",
    redactions_applied: 0,
    preview_budget: {
      max_inline_preview_chars: 160,
      max_total_inline_preview_chars: 1200,
      preview_chars_used: 0,
      truncated_previews: 0,
      omitted_previews: 0,
    },
  };
}

function makeHelperResult(overrides: Partial<HelperResult>, questionType: HelperQuestionType): string {
  return formatHelper(
    {
      answer: "Base answer.",
      confidence: 0.68,
      primary_reason: null,
      visibility_scope: "user",
      redactions_applied: 0,
      preview_budget: {
        max_inline_preview_chars: 160,
        max_total_inline_preview_chars: 1200,
        preview_chars_used: 0,
        truncated_previews: 0,
        omitted_previews: 0,
      },
      evidence: [],
      uncertainty: [],
      ...overrides,
    },
    questionType,
  );
}

describe("authority cli formatting", () => {
  it("surfaces non-governed trust summaries and advisories in timeline output", () => {
    const timeline = makeTimelineResult([
      makeStep({
        step_id: "step_imported",
        step_type: "analysis_step",
        title: "Imported provider-side action",
        provenance: "imported",
        confidence: 0.61,
        summary: "Imported provider-side action was imported from external history and was not governed pre-execution.",
        action_id: "act_imported",
      }),
      makeStep({
        step_id: "step_observed",
        sequence: 2,
        step_type: "analysis_step",
        title: "Observed shell write",
        provenance: "observed",
        confidence: 0.58,
        summary: "Observed shell write was observed after execution and was not controlled pre-execution.",
        action_id: "act_observed",
      }),
      makeStep({
        step_id: "step_unknown",
        sequence: 3,
        step_type: "analysis_step",
        title: "Unknown provenance step",
        provenance: "unknown",
        confidence: 0.52,
        summary: "Unknown provenance step has insufficient trustworthy provenance to claim pre-execution control.",
        action_id: "act_unknown",
      }),
    ]);

    const output = formatTimeline(timeline);

    expect(output).toContain("Visibility: user");
    expect(output).toContain("Redactions applied: 0");
    expect(output).toContain("Preview budget: 0/1200 chars used, 0 truncated, 0 omitted");
    expect(output).toContain("Trust summary: 3 non-governed step(s) detected (1 imported, 1 observed, 1 unknown).");
    expect(output).toContain("Trust advisory: imported action from external history; it was not governed pre-execution.");
    expect(output).toContain("Trust advisory: observed-only action; evidence was captured after execution rather than controlled before it.");
    expect(output).toContain("Trust advisory: insufficient trustworthy provenance to claim governed pre-execution control.");
  });

  it("formats helper primary reasons when present", () => {
    const output = makeHelperResult(
      {
        primary_reason: {
          code: "UNKNOWN_SCOPE_REQUIRES_APPROVAL",
          message: "Unknown scope requires approval before execution.",
        },
      },
      "why_blocked",
    );

    expect(output).toContain("Primary reason: UNKNOWN_SCOPE_REQUIRES_APPROVAL");
    expect(output).toContain("Unknown scope requires approval before execution.");
  });

  it("formats structured recovery downgrade reasons in timeline and recovery plan output", () => {
    const timeline = makeTimelineResult([
      makeStep({
        step_id: "step_recovery",
        step_type: "recovery_step",
        title: "Manual review planned",
        reversibility_class: "review_only",
        action_id: "act_recovery",
        summary: "Planned manual review for snapshot snap_cap.",
        related: {
          snapshot_id: "snap_cap",
          execution_id: null,
          recovery_plan_ids: ["rec_cap"],
          target_locator: "/tmp/capability.txt",
          recovery_target_type: "snapshot_id",
          recovery_target_label: "snapshot snap_cap",
          recovery_scope_paths: [],
          recovery_strategy: "manual_review_only",
          recovery_downgrade_reason: {
            code: "CAPABILITY_STATE_STALE",
            message:
              "Cached workspace/runtime capability state is stale; rerun capability_refresh before trusting automatic restore.",
          },
          later_actions_affected: 0,
          overlapping_paths: [],
          data_loss_risk: "unknown",
        },
      }),
    ]);

    const timelineOutput = formatTimeline(timeline);
    expect(timelineOutput).toContain("Recovery downgrade: CAPABILITY_STATE_STALE");

    const recoveryPlanOutput = formatRecoveryPlan({
      schema_version: "recovery-plan.v1",
      recovery_plan_id: "rec_cap",
      target: {
        type: "snapshot_id",
        snapshot_id: "snap_cap",
      },
      recovery_class: "review_only",
      strategy: "manual_review_only",
      confidence: 0.34,
      steps: [],
      impact_preview: {
        paths_to_change: 1,
        later_actions_affected: 0,
        overlapping_paths: [],
        external_effects: [],
        data_loss_risk: "unknown",
      },
      warnings: [
        {
          code: "CAPABILITY_STATE_STALE",
          message:
            "Cached workspace/runtime capability state is stale; rerun capability_refresh before trusting automatic restore.",
        },
      ],
      downgrade_reason: {
        code: "CAPABILITY_STATE_STALE",
        message:
          "Cached workspace/runtime capability state is stale; rerun capability_refresh before trusting automatic restore.",
      },
      review_guidance: {
        systems_touched: ["filesystem"],
        objects_touched: ["/tmp/capability.txt"],
        manual_steps: ["Rerun capability_refresh before retrying restore."],
        uncertainty: ["Automatic restore is not currently trustworthy."],
      },
      created_at: "2026-03-31T12:00:00.000Z",
    });

    expect(recoveryPlanOutput).toContain("Downgrade reason: CAPABILITY_STATE_STALE");
  });

  it("formats maintenance status in run summaries", () => {
    const output = formatRunSummary({
      run: {
        ...makeTimelineResult([]).run_summary,
        maintenance_status: {
          projection_status: "fresh",
          projection_lag_events: 0,
          degraded_artifact_capture_actions: 2,
          low_disk_pressure_signals: 3,
          artifact_health: {
            total: 5,
            available: 2,
            missing: 1,
            expired: 1,
            corrupted: 1,
            tampered: 0,
          },
        },
      },
    });

    expect(output).toContain("Projection: fresh (0 lag events)");
    expect(output).toContain("Artifact health: 2/5 available, 1 missing, 1 expired, 1 corrupted, 0 tampered");
    expect(output).toContain("Degraded artifact captures: 2");
    expect(output).toContain("Low-disk pressure signals: 3");
  });

  it("formats degraded diagnostics without hiding missing maintenance detail", () => {
    const output = formatDiagnostics({
      daemon_health: {
        status: "degraded",
        active_sessions: 2,
        active_runs: 1,
        primary_reason: {
          code: "DEGRADED_ARTIFACT_CAPTURE",
          message: "2 action(s) completed with degraded durable evidence capture.",
        },
        warnings: ["Runtime is healthy enough to serve requests, but durable evidence health is degraded."],
      },
      journal_health: {
        status: "degraded",
        total_runs: 4,
        total_events: 17,
        pending_approvals: 1,
        primary_reason: {
          code: "PENDING_APPROVALS",
          message: "1 approval request(s) remain unresolved.",
        },
        warnings: ["Journal metadata is intact, but some durable execution evidence is unavailable or degraded."],
      },
      maintenance_backlog: {
        pending_critical_jobs: 0,
        pending_maintenance_jobs: 0,
        oldest_pending_critical_job: null,
        current_heavy_job: null,
        snapshot_compaction_debt: null,
        primary_reason: {
          code: "LOW_DISK_PRESSURE_OBSERVED",
          message: "3 low-disk pressure signal(s) were recorded while storing evidence.",
        },
        warnings: ["Storage pressure has been observed, but no queued maintenance worker is tracking disk recovery at launch."],
      },
      projection_lag: {
        projection_status: "fresh",
        lag_events: 0,
      },
      storage_summary: {
        artifact_health: {
          total: 5,
          available: 2,
          missing: 1,
          expired: 1,
          corrupted: 0,
          tampered: 1,
        },
        degraded_artifact_capture_actions: 2,
        low_disk_pressure_signals: 3,
        primary_reason: {
          code: "DEGRADED_ARTIFACT_CAPTURE",
          message: "2 action(s) completed with degraded durable evidence capture.",
        },
        warnings: [
          "2 action(s) completed with degraded durable evidence capture.",
          "3 low-disk pressure signal(s) were recorded while storing evidence.",
        ],
      },
      capability_summary: {
        cached: true,
        refreshed_at: "2026-03-31T12:05:00.000Z",
        workspace_root: "/tmp/workspace",
        capability_count: 4,
        degraded_capabilities: 1,
        unavailable_capabilities: 1,
        stale_after_ms: 300000,
        is_stale: false,
        primary_reason: {
          code: "BROKERED_CAPABILITY_UNAVAILABLE",
          message: "Cached ticket broker capability is unavailable; trusted brokered ticket execution is not currently available.",
        },
        warnings: [
          "Credential brokering is launch-scoped to session environment profiles rather than secure OS-backed storage.",
        ],
      },
    });

    expect(output).toContain("Daemon health: degraded");
    expect(output).toContain("Journal totals: 4 runs, 17 events, 1 pending approvals");
    expect(output).toContain("Maintenance backlog: 0 critical, 0 maintenance");
    expect(output).toContain("Projection lag: fresh (0 lag events)");
    expect(output).toContain("Storage evidence: 2/5 available, 1 missing, 1 expired, 0 corrupted, 1 tampered");
    expect(output).toContain("Low-disk pressure signals: 3");
    expect(output).toContain("Daemon primary reason: DEGRADED_ARTIFACT_CAPTURE");
    expect(output).toContain("Journal primary reason: PENDING_APPROVALS");
    expect(output).toContain("Maintenance primary reason: LOW_DISK_PRESSURE_OBSERVED");
    expect(output).toContain("Storage primary reason: DEGRADED_ARTIFACT_CAPTURE");
    expect(output).toContain("Capability summary: cached");
    expect(output).toContain("Capability primary reason: BROKERED_CAPABILITY_UNAVAILABLE");
    expect(output).toContain("Capability counts: 4 total, 1 degraded, 1 unavailable");
    expect(output).toContain("Capability stale after: 300000ms");
  });

  it("formats detected capability records and degraded warnings honestly", () => {
    const output = formatCapabilities({
      capabilities: [
        {
          capability_name: "host.runtime_storage",
          status: "available",
          scope: "host",
          detected_at: "2026-03-31T12:00:00.000Z",
          source: "authority_daemon",
          details: {
            writable: true,
          },
        },
        {
          capability_name: "host.credential_broker_mode",
          status: "degraded",
          scope: "host",
          detected_at: "2026-03-31T12:00:00.000Z",
          source: "authority_daemon",
          details: {
            mode: "session_env_only",
            secure_store: false,
          },
        },
      ],
      detection_timestamps: {
        started_at: "2026-03-31T12:00:00.000Z",
        completed_at: "2026-03-31T12:00:01.000Z",
      },
      degraded_mode_warnings: [
        "Credential brokering is launch-scoped to session environment profiles rather than secure OS-backed storage.",
      ],
    });

    expect(output).toContain("Capabilities");
    expect(output).toContain("Detection started: 2026-03-31T12:00:00.000Z");
    expect(output).toContain("Detection completed: 2026-03-31T12:00:01.000Z");
    expect(output).toContain("host.runtime_storage [available]");
    expect(output).toContain("host.credential_broker_mode [degraded]");
    expect(output).toContain('Details: {"mode":"session_env_only","secure_store":false}');
    expect(output).toContain("Credential brokering is launch-scoped to session environment profiles");
  });

  it("formats inline maintenance results honestly", () => {
    const output = formatMaintenance({
      accepted_priority: "administrative",
      scope: null,
      stream_id: null,
      jobs: [
        {
          job_type: "artifact_expiry",
          status: "completed",
          performed_inline: true,
          summary: "Expired 2 durable artifact blob(s) by retention policy.",
          stats: {
            expired_artifacts: 2,
          },
        },
        {
          job_type: "startup_reconcile_runs",
          status: "completed",
          performed_inline: true,
          summary: "Reconciled 2 persisted run(s); rehydrated 0 run record(s) and 0 session record(s).",
          stats: {
            runs_considered: 2,
            sessions_rehydrated: 0,
            runs_rehydrated: 0,
            total_sessions: 1,
            total_runs: 2,
          },
        },
      ],
    });

    expect(output).toContain("Maintenance accepted at priority administrative");
    expect(output).toContain("artifact_expiry: completed (inline)");
    expect(output).toContain("Expired 2 durable artifact blob(s) by retention policy.");
    expect(output).toContain("startup_reconcile_runs: completed (inline)");
  });

  it("formats helper uncertainty blocks for weak-trust answers without dropping evidence", () => {
    const output = makeHelperResult(
      {
        answer: "The likeliest cause is Imported provider-side action at step 3 because it is imported rather than governed.",
        confidence: 0.68,
        evidence: [
          {
            step_id: "step_imported",
            sequence: 3,
            title: "Imported provider-side action",
          },
        ],
        uncertainty: ["This is inferred from weak trust provenance rather than a recorded failure or block."],
      },
      "suggest_likely_cause",
    );

    expect(output).toContain("Helper answer for suggest_likely_cause");
    expect(output).toContain("Visibility: user");
    expect(output).toContain("Redactions applied: 0");
    expect(output).toContain("Preview budget: 0/1200 chars used, 0 truncated, 0 omitted");
    expect(output).toContain("#3 Imported provider-side action (step_imported)");
    expect(output).toContain("weak trust provenance rather than a recorded failure or block");
  });

  it("formats retrievable artifact ids and artifact query output", () => {
    const timeline = makeTimelineResult([
      makeStep({
        primary_artifacts: [
          {
            type: "stdout",
            label: "stdout",
            artifact_id: "artifact_stdout_1",
            artifact_status: "missing",
          },
        ],
      }),
    ]);

    const timelineOutput = formatTimeline(timeline);
    expect(timelineOutput).toContain("stdout (stdout, artifact_stdout_1, missing)");

    const artifactOutput = formatArtifact({
      artifact: {
        artifact_id: "artifact_stdout_1",
        run_id: "run_cli",
        action_id: "act_default",
        execution_id: "exec_1",
        type: "stdout",
        content_ref: "inline://exec_1/stdout",
        byte_size: 12,
        integrity: {
          schema_version: "artifact-integrity.v1",
          digest_algorithm: "sha256",
          digest: "deadbeef",
        },
        visibility: "internal",
        expires_at: "2026-03-31T13:00:01.000Z",
        expired_at: "2026-03-31T13:00:01.000Z",
        created_at: "2026-03-31T12:00:01.000Z",
      },
      artifact_status: "missing",
      visibility_scope: "internal",
      content_available: false,
      content: "",
      content_truncated: false,
      returned_chars: 0,
      max_inline_chars: 8192,
    });

    expect(artifactOutput).toContain("Artifact artifact_stdout_1");
    expect(artifactOutput).toContain("Status: missing");
    expect(artifactOutput).toContain("Stored visibility: internal");
    expect(artifactOutput).toContain("Integrity: artifact-integrity.v1 sha256");
    expect(artifactOutput).toContain("Integrity digest: deadbeef");
    expect(artifactOutput).toContain("Expires: 2026-03-31T13:00:01.000Z");
    expect(artifactOutput).toContain("Expired: 2026-03-31T13:00:01.000Z");
    expect(artifactOutput).toContain("Content available: no");
    expect(artifactOutput).toContain("Returned chars: 0/8192");
  });

  it("formats structured branch-point recovery targets distinctly from opaque checkpoints", () => {
    const output = formatRecoveryPlan({
      schema_version: "recovery-plan.v1",
      recovery_plan_id: "rec_branch_1",
      target: {
        type: "branch_point",
        run_id: "run_cli",
        sequence: 7,
      },
      recovery_class: "reversible",
      strategy: "restore_snapshot",
      confidence: 0.84,
      steps: [],
      impact_preview: {
        later_actions_affected: 0,
        overlapping_paths: [],
        external_effects: [],
        data_loss_risk: "low",
      },
      warnings: [],
      created_at: "2026-03-31T12:00:00.000Z",
    });

    expect(output).toContain("Target branch point: run_cli#7");
  });

  it("surfaces structured recovery target metadata in timeline output", () => {
    const timeline = makeTimelineResult([
      makeStep({
        step_id: "step_recovery_branch",
        step_type: "recovery_step",
        title: "Recovery executed",
        summary: "Executed recovery for branch point run_cli#7.",
        reversibility_class: "reversible",
        related: {
          snapshot_id: "snap_branch",
          execution_id: null,
          recovery_plan_ids: ["rec_branch_1"],
          target_locator: "src/config.json",
          recovery_target_type: "branch_point",
          recovery_target_label: "branch point run_cli#7",
          recovery_scope_paths: ["src/config.json", "README.md"],
          recovery_strategy: "restore_snapshot",
          later_actions_affected: 0,
          overlapping_paths: [],
          data_loss_risk: "low",
        },
      }),
    ]);

    const output = formatTimeline(timeline);
    expect(output).toContain("Recovery target: branch_point (branch point run_cli#7)");
    expect(output).toContain("Recovery scope: src/config.json, README.md");
  });
});
