import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatArtifact,
  formatCapabilities,
  formatDiagnostics,
  formatHelper,
  formatMaintenance,
  formatMcpServerCandidates,
  formatMcpServerCredentialBindings,
  formatMcpServerProfiles,
  formatMcpServerTrustDecisions,
  formatMcpHostPolicies,
  formatMcpSecrets,
  formatMcpServers,
  formatRecoveryPlan,
  formatRunSummary,
  formatTimeline,
  runCli,
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
    expect(output).toContain(
      "Trust advisory: imported action from external history; it was not governed pre-execution.",
    );
    expect(output).toContain(
      "Trust advisory: observed-only action; evidence was captured after execution rather than controlled before it.",
    );
    expect(output).toContain(
      "Trust advisory: insufficient trustworthy provenance to claim governed pre-execution control.",
    );
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

  it("formats governed MCP registry listings with transport and source details", () => {
    const output = formatMcpServers({
      servers: [
        {
          source: "operator_api",
          created_at: "2026-03-31T12:00:00.000Z",
          updated_at: "2026-03-31T12:05:00.000Z",
          server: {
            server_id: "notes_http",
            display_name: "Notes HTTP server",
            transport: "streamable_http",
            url: "http://127.0.0.1:3010/mcp",
            network_scope: "private",
            max_concurrent_calls: 2,
            auth: {
              type: "bearer_env",
              bearer_env_var: "AGENTGIT_TEST_MCP_HTTP_TOKEN",
            },
            tools: [
              {
                tool_name: "echo_note",
                side_effect_level: "read_only",
                approval_mode: "allow",
              },
            ],
          },
        },
      ],
    });

    expect(output).toContain("Local governed MCP servers");
    expect(output).toContain("notes_http [streamable_http]");
    expect(output).toContain("Source: operator_api");
    expect(output).toContain("Transport target: http://127.0.0.1:3010/mcp");
    expect(output).toContain("Network scope: private");
    expect(output).toContain("Max concurrent calls: 2");
  });

  it("formats MCP server candidates", () => {
    const output = formatMcpServerCandidates({
      candidates: [
        {
          candidate_id: "mcpcand_123",
          source_kind: "user_input",
          raw_endpoint: "https://api.example.com/mcp",
          transport_hint: "streamable_http",
          workspace_id: null,
          submitted_by_session_id: "sess_cli",
          submitted_by_run_id: null,
          notes: "Submitted from CLI",
          resolution_state: "pending",
          resolution_error: null,
          submitted_at: "2026-04-01T12:00:00.000Z",
          updated_at: "2026-04-01T12:00:00.000Z",
        },
      ],
    });

    expect(output).toContain("MCP server candidates");
    expect(output).toContain("mcpcand_123 [user_input]");
    expect(output).toContain("Raw endpoint: https://api.example.com/mcp");
    expect(output).toContain("Resolution state: pending");
  });

  it("formats MCP server profiles", () => {
    const output = formatMcpServerProfiles({
      profiles: [
        {
          server_profile_id: "mcpprof_123",
          candidate_id: "mcpcand_123",
          display_name: "Example MCP",
          transport: "streamable_http",
          canonical_endpoint: "https://api.example.com/mcp",
          network_scope: "public_https",
          trust_tier: "operator_approved_public",
          status: "draft",
          drift_state: "clean",
          quarantine_reason_codes: [],
          allowed_execution_modes: ["local_proxy"],
          active_trust_decision_id: null,
          auth_descriptor: {
            mode: "none",
            audience: null,
            scope_labels: [],
          },
          identity_baseline: {
            canonical_host: "api.example.com",
            canonical_port: 443,
            tls_identity_summary: null,
            auth_issuer: null,
            publisher_identity: null,
            tool_inventory_hash: null,
            fetched_at: "2026-04-01T12:00:00.000Z",
          },
          tool_inventory_version: null,
          last_resolved_at: "2026-04-01T12:00:00.000Z",
          created_at: "2026-04-01T12:00:00.000Z",
          updated_at: "2026-04-01T12:00:00.000Z",
        },
      ],
    });

    expect(output).toContain("MCP server profiles");
    expect(output).toContain("mcpprof_123 [draft]");
    expect(output).toContain("Canonical endpoint: https://api.example.com/mcp");
    expect(output).toContain("Trust tier: operator_approved_public");
    expect(output).toContain("Drift state: clean");
  });

  it("formats MCP server trust decisions", () => {
    const output = formatMcpServerTrustDecisions({
      trust_decisions: [
        {
          trust_decision_id: "mcptrust_123",
          server_profile_id: "mcpprof_123",
          decision: "allow_policy_managed",
          trust_tier: "operator_approved_public",
          allowed_execution_modes: ["local_proxy"],
          max_side_effect_level_without_approval: "read_only",
          reason_codes: ["INITIAL_REVIEW_COMPLETE"],
          approved_by_session_id: "sess_cli",
          approved_at: "2026-04-01T12:05:00.000Z",
          valid_until: null,
          reapproval_triggers: ["tool_inventory_hash_changed"],
        },
      ],
    });

    expect(output).toContain("MCP server trust decisions");
    expect(output).toContain("mcptrust_123 [allow_policy_managed]");
    expect(output).toContain("Profile: mcpprof_123");
    expect(output).toContain("Reason codes: INITIAL_REVIEW_COMPLETE");
  });

  it("formats MCP server credential bindings", () => {
    const output = formatMcpServerCredentialBindings({
      credential_bindings: [
        {
          credential_binding_id: "mcpbind_123",
          server_profile_id: "mcpprof_123",
          binding_mode: "bearer_secret_ref",
          broker_profile_id: "mcp_secret_123",
          scope_labels: ["remote:mcp"],
          audience: null,
          status: "active",
          created_at: "2026-04-01T12:05:00.000Z",
          updated_at: "2026-04-01T12:05:00.000Z",
          revoked_at: null,
        },
      ],
    });

    expect(output).toContain("MCP server credential bindings");
    expect(output).toContain("mcpbind_123 [bearer_secret_ref]");
    expect(output).toContain("Broker profile: mcp_secret_123");
    expect(output).toContain("Status: active");
  });

  it("formats governed MCP secret listings without exposing secret values", () => {
    const output = formatMcpSecrets({
      secrets: [
        {
          secret_id: "mcp_secret_notion",
          display_name: "Notion MCP",
          auth_type: "bearer",
          status: "active",
          version: 3,
          created_at: "2026-03-31T12:00:00.000Z",
          updated_at: "2026-03-31T12:05:00.000Z",
          rotated_at: "2026-03-31T12:05:00.000Z",
          last_used_at: "2026-03-31T12:06:00.000Z",
          source: "operator_api",
        },
      ],
    });

    expect(output).toContain("Governed MCP secrets");
    expect(output).toContain("mcp_secret_notion [bearer]");
    expect(output).toContain("Version: 3");
    expect(output).toContain("Last used: 2026-03-31T12:06:00.000Z");
    expect(output).not.toContain("bearer_token");
  });

  it("formats governed MCP public host policy listings", () => {
    const output = formatMcpHostPolicies({
      policies: [
        {
          policy: {
            host: "api.notion.com",
            display_name: "Notion API",
            allow_subdomains: false,
            allowed_ports: [443],
          },
          source: "operator_api",
          created_at: "2026-03-31T12:00:00.000Z",
          updated_at: "2026-03-31T12:05:00.000Z",
        },
      ],
    });

    expect(output).toContain("Governed MCP public host policies");
    expect(output).toContain("api.notion.com");
    expect(output).toContain("Allow subdomains: no");
    expect(output).toContain("Allowed ports: 443");
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
        warnings: [
          "Storage pressure has been observed, but no queued maintenance worker is tracking disk recovery at launch.",
        ],
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
          message:
            "Cached ticket broker capability is unavailable; trusted brokered ticket execution is not currently available.",
        },
        warnings: [
          "Credential brokering is launch-scoped to session environment profiles rather than secure OS-backed storage.",
        ],
      },
      policy_summary: null,
      security_posture: {
        status: "degraded",
        secret_storage: {
          mode: "local_encrypted_store",
          provider: "macos_keychain",
          durable: true,
          encrypted_at_rest: true,
          secret_expiry_enforced: true,
          rotation_metadata_tracked: true,
          legacy_key_path: null,
        },
        stdio_sandbox: {
          registered_server_count: 2,
          protected_server_count: 0,
          production_ready_server_count: 0,
          digest_pinned_server_count: 0,
          mutable_tag_server_count: 0,
          local_build_server_count: 0,
          registry_policy_server_count: 0,
          signature_verification_server_count: 0,
          provenance_attestation_server_count: 0,
          fallback_server_count: 0,
          unconfigured_server_count: 1,
          preferred_production_mode: "oci_container",
          local_dev_fallback_mode: null,
          current_host_mode: "oci_runtime_required",
          current_host_mode_reason:
            "No usable OCI runtime is available on this host. Governed stdio MCP execution requires OCI sandboxing.",
          macos_seatbelt_available: false,
          docker_runtime_usable: false,
          podman_runtime_usable: false,
          windows_plan: {
            supported_via_oci: true,
            recommended_runtime: "docker_desktop_wsl2_or_podman_machine",
            native_fallback_available: false,
            summary:
              "On Windows, use Docker Desktop with WSL2 or Podman machine for OCI sandboxing. No native host-process fallback is supported.",
          },
          degraded_servers: ["notes_stdio_docker"],
        },
        streamable_http: {
          registered_server_count: 3,
          connect_time_dns_scope_validation: true,
          redirect_chain_revalidation: true,
          concurrency_limits_enforced: true,
          shared_sqlite_leases: true,
          lease_heartbeat_renewal: true,
          legacy_bearer_env_servers: ["notes_http_legacy"],
          missing_secret_ref_servers: [],
          missing_public_host_policy_servers: ["notes_http_public"],
        },
        primary_reason: {
          code: "STDIO_SANDBOX_DEGRADED",
          message: "1 governed stdio MCP server does not have a usable sandbox on this host.",
        },
        warnings: [
          "notes_stdio_docker requires docker OCI sandboxing, but the runtime is not usable: daemon unavailable.",
          "Legacy bearer_env auth is still configured for 1 streamable_http MCP server(s).",
        ],
      },
      hosted_worker: {
        status: "degraded",
        reachable: false,
        managed_by_daemon: false,
        endpoint_kind: "unix",
        endpoint: "unix:/tmp/hosted-worker.sock",
        runtime_id: null,
        image_digest: null,
        control_plane_auth_required: true,
        last_error: "connect ENOENT /tmp/hosted-worker.sock",
        primary_reason: {
          code: "HOSTED_WORKER_UNREACHABLE",
          message: "connect ENOENT /tmp/hosted-worker.sock",
        },
        warnings: ["Hosted MCP worker is unreachable: connect ENOENT /tmp/hosted-worker.sock"],
      },
      hosted_queue: {
        status: "degraded",
        queued_jobs: 0,
        running_jobs: 0,
        cancel_requested_jobs: 0,
        succeeded_jobs: 3,
        failed_jobs: 1,
        canceled_jobs: 0,
        retryable_failed_jobs: 1,
        dead_letter_retryable_jobs: 1,
        dead_letter_non_retryable_jobs: 0,
        oldest_queued_at: null,
        oldest_failed_at: "2026-03-31T12:10:00.000Z",
        active_server_profiles: [],
        primary_reason: {
          code: "HOSTED_QUEUE_FAILED_JOBS",
          message: "1 hosted MCP execution job(s) are in a failed terminal state.",
        },
        warnings: ["1 hosted MCP execution job(s) are in a failed terminal state and require operator action."],
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
    expect(output).toContain("Security posture: degraded");
    expect(output).toContain("Secret storage: local_encrypted_store (macos_keychain)");
    expect(output).toContain("Stdio sandbox: 0/2 protected");
    expect(output).toContain("Stdio production-ready: 0");
    expect(output).toContain("Stdio digest-pinned: 0");
    expect(output).toContain("Stdio mutable-tag OCI: 0");
    expect(output).toContain("Stdio fallback-only: 0");
    expect(output).toContain("Stdio unconfigured: 1");
    expect(output).toContain("Stdio preferred production mode: oci_container");
    expect(output).toContain("Stdio local dev fallback: none");
    expect(output).toContain("Stdio current host mode: oci_runtime_required");
    expect(output).toContain("Windows plan: On Windows, use Docker Desktop with WSL2 or Podman machine");
    expect(output).toContain("Streamable HTTP hardening: dns=on, redirects=on, sqlite leases=on, heartbeat=on");
    expect(output).toContain("Security primary reason: STDIO_SANDBOX_DEGRADED");
    expect(output).toContain("Hosted worker: degraded");
    expect(output).toContain("Hosted worker endpoint: unix:/tmp/hosted-worker.sock");
    expect(output).toContain("Hosted worker primary reason: HOSTED_WORKER_UNREACHABLE");
    expect(output).toContain("Hosted queue: degraded");
    expect(output).toContain(
      "Hosted queue counts: 0 queued, 0 running, 0 cancel requested, 3 succeeded, 1 failed, 0 canceled",
    );
    expect(output).toContain("Hosted queue dead-letter: 1 retryable, 0 non-retryable");
    expect(output).toContain("Hosted queue primary reason: HOSTED_QUEUE_FAILED_JOBS");
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
        answer:
          "The likeliest cause is Imported provider-side action at step 3 because it is imported rather than governed.",
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

async function captureCliRun(
  argv: string[],
  client: Record<string, unknown>,
): Promise<{ stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
    stdout.push(typeof value === "string" ? value : JSON.stringify(value));
  });
  const stderrSpy = vi.spyOn(console, "error").mockImplementation((value?: unknown) => {
    stderr.push(typeof value === "string" ? value : JSON.stringify(value));
  });

  try {
    await runCli(argv, client as never);
    return {
      stdout: stdout.join("\n"),
      stderr: stderr.join("\n"),
    };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    process.exitCode = 0;
  }
}

afterEach(() => {
  process.exitCode = 0;
});

describe("authority cli commands", () => {
  it("runs the list-mcp-secrets command end to end", async () => {
    const output = await captureCliRun(["list-mcp-secrets"], {
      listMcpSecrets: vi.fn().mockResolvedValue({
        secrets: [
          {
            secret_id: "mcp_secret_notion",
            display_name: "Notion MCP",
            auth_type: "bearer",
            status: "active",
            version: 2,
            created_at: "2026-03-31T12:00:00.000Z",
            updated_at: "2026-03-31T12:05:00.000Z",
            rotated_at: "2026-03-31T12:05:00.000Z",
            last_used_at: null,
            source: "operator_api",
          },
        ],
      }),
    });

    expect(output.stderr).toBe("");
    expect(output.stdout).toContain("Governed MCP secrets");
    expect(output.stdout).toContain("mcp_secret_notion [bearer]");
  });

  it("runs the init --production command end to end and writes an active profile", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cli-init-unit-"));
    const configRoot = path.join(tempRoot, "config");
    const workspaceRoot = path.join(tempRoot, "workspace");
    const socketPath = path.join(tempRoot, "authority.sock");
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const output = await captureCliRun(
      [
        "--config-root",
        configRoot,
        "--workspace-root",
        workspaceRoot,
        "--socket-path",
        socketPath,
        "init",
        "--production",
        "--profile-name",
        "prod",
      ],
      {
        hello: vi.fn().mockResolvedValue({
          schema_version: "authority.hello.v1",
          session_id: "sess_init",
          accepted_api_version: "authority.v1",
          runtime_version: "1.0.0-test",
          schema_pack_version: "1.0.0-test",
        }),
        getCapabilities: vi.fn().mockResolvedValue({
          capabilities: [
            {
              capability_name: "host.credential_broker_mode",
              status: "available",
              scope: "host",
              detected_at: "2026-04-01T12:00:00.000Z",
              source: "authority_daemon",
              details: {
                mode: "local_encrypted_store",
                key_provider: "macos_keychain",
              },
            },
          ],
          detection_timestamps: {
            started_at: "2026-04-01T12:00:00.000Z",
            completed_at: "2026-04-01T12:00:00.000Z",
          },
          degraded_mode_warnings: [],
        }),
        listMcpServers: vi.fn().mockResolvedValue({
          servers: [],
        }),
        listMcpSecrets: vi.fn().mockResolvedValue({
          secrets: [],
        }),
        listMcpHostPolicies: vi.fn().mockResolvedValue({
          policies: [],
        }),
        diagnostics: vi.fn().mockResolvedValue({
          policy_summary: null,
          security_posture: {
            status: "healthy",
            secret_storage: {
              mode: "local_encrypted_store",
              provider: "macos_keychain",
              durable: true,
              encrypted_at_rest: true,
              secret_expiry_enforced: true,
              rotation_metadata_tracked: true,
              legacy_key_path: null,
            },
            stdio_sandbox: {
              registered_server_count: 0,
              protected_server_count: 0,
              production_ready_server_count: 0,
              digest_pinned_server_count: 0,
              mutable_tag_server_count: 0,
              local_build_server_count: 0,
              registry_policy_server_count: 0,
              signature_verification_server_count: 0,
              provenance_attestation_server_count: 0,
              fallback_server_count: 0,
              unconfigured_server_count: 0,
              preferred_production_mode: "oci_container",
              local_dev_fallback_mode: "oci_container_build",
              current_host_mode: "oci_container_ready",
              current_host_mode_reason: "OCI sandbox runtime is available.",
              macos_seatbelt_available: false,
              docker_runtime_usable: true,
              podman_runtime_usable: false,
              windows_plan: {
                supported_via_oci: true,
                recommended_runtime: "docker_desktop_wsl2_or_podman_machine",
                native_fallback_available: false,
                summary:
                  "On Windows, use Docker Desktop with WSL2 or Podman machine for OCI sandboxing. No native host-process fallback is supported.",
              },
              degraded_servers: [],
            },
            streamable_http: {
              registered_server_count: 0,
              connect_time_dns_scope_validation: true,
              redirect_chain_revalidation: true,
              concurrency_limits_enforced: true,
              shared_sqlite_leases: true,
              lease_heartbeat_renewal: true,
              legacy_bearer_env_servers: [],
              missing_secret_ref_servers: [],
              missing_public_host_policy_servers: [],
            },
            warnings: [],
            primary_reason: null,
          },
          hosted_worker: null,
          hosted_queue: null,
        }),
      },
    );

    expect(output.stderr).toBe("");
    expect(output.stdout).toContain("Initialized production profile prod");
    expect(output.stdout).toContain("Readiness passed: yes");

    const configPath = path.join(configRoot, "authority-cli.toml");
    expect(fs.existsSync(configPath)).toBe(true);
    const configText = fs.readFileSync(configPath, "utf8");
    expect(configText).toContain('active_profile = "prod"');
    expect(configText).toContain("socket_path");
    expect(configText).toContain("workspace_root");
  });

  it("runs the trust-report command end to end", async () => {
    const output = await captureCliRun(["trust-report", "--run-id", "run_trust"], {
      hello: vi.fn().mockResolvedValue({
        schema_version: "authority.hello.v1",
        session_id: "sess_trust",
        accepted_api_version: "authority.v1",
        runtime_version: "1.0.0-test",
        schema_pack_version: "1.0.0-test",
      }),
      getCapabilities: vi.fn().mockResolvedValue({
        capabilities: [
          {
            capability_name: "host.credential_broker_mode",
            status: "available",
            scope: "host",
            detected_at: "2026-04-01T12:00:00.000Z",
            source: "authority_daemon",
            details: {
              mode: "local_encrypted_store",
              key_provider: "macos_keychain",
            },
          },
        ],
        detection_timestamps: {
          started_at: "2026-04-01T12:00:00.000Z",
          completed_at: "2026-04-01T12:00:00.000Z",
        },
        degraded_mode_warnings: [],
      }),
      listMcpServers: vi.fn().mockResolvedValue({
        servers: [],
      }),
      listMcpSecrets: vi.fn().mockResolvedValue({
        secrets: [],
      }),
      listMcpHostPolicies: vi.fn().mockResolvedValue({
        policies: [],
      }),
      diagnostics: vi.fn().mockResolvedValue({
        policy_summary: null,
        security_posture: {
          status: "degraded",
          secret_storage: {
            mode: "local_encrypted_store",
            provider: "macos_keychain",
            durable: true,
            encrypted_at_rest: true,
            secret_expiry_enforced: true,
            rotation_metadata_tracked: true,
            legacy_key_path: null,
          },
          stdio_sandbox: {
            registered_server_count: 1,
            protected_server_count: 1,
            production_ready_server_count: 0,
            digest_pinned_server_count: 0,
            mutable_tag_server_count: 1,
            local_build_server_count: 0,
            registry_policy_server_count: 0,
            signature_verification_server_count: 0,
            provenance_attestation_server_count: 0,
            fallback_server_count: 0,
            unconfigured_server_count: 0,
            preferred_production_mode: "oci_container",
            local_dev_fallback_mode: "oci_container_build",
            current_host_mode: "oci_container_ready",
            current_host_mode_reason: "OCI sandbox runtime is available.",
            macos_seatbelt_available: false,
            docker_runtime_usable: true,
            podman_runtime_usable: false,
            windows_plan: {
              supported_via_oci: true,
              recommended_runtime: "docker_desktop_wsl2_or_podman_machine",
              native_fallback_available: false,
              summary:
                "On Windows, use Docker Desktop with WSL2 or Podman machine for OCI sandboxing. No native host-process fallback is supported.",
            },
            degraded_servers: ["notes_stdio"],
          },
          streamable_http: {
            registered_server_count: 1,
            connect_time_dns_scope_validation: true,
            redirect_chain_revalidation: true,
            concurrency_limits_enforced: true,
            shared_sqlite_leases: true,
            lease_heartbeat_renewal: true,
            legacy_bearer_env_servers: [],
            missing_secret_ref_servers: [],
            missing_public_host_policy_servers: [],
          },
          warnings: ["1 governed stdio MCP server does not have a usable sandbox on this host."],
          primary_reason: {
            code: "STDIO_SANDBOX_DEGRADED",
            message: "1 governed stdio MCP server does not have a usable sandbox on this host.",
          },
        },
        hosted_worker: null,
        hosted_queue: null,
      }),
      listMcpServerProfiles: vi.fn().mockResolvedValue({
        profiles: [
          {
            server_profile_id: "mcpprof_123",
            candidate_id: "mcpcand_123",
            display_name: "Example MCP",
            transport: "streamable_http",
            canonical_endpoint: "https://api.example.com/mcp",
            network_scope: "public_https",
            trust_tier: "operator_approved_public",
            status: "active",
            drift_state: "clean",
            quarantine_reason_codes: [],
            allowed_execution_modes: ["local_proxy"],
            active_trust_decision_id: "mcptrust_123",
            active_credential_binding_id: "mcpbind_123",
            auth_descriptor: {
              mode: "bearer_secret_ref",
              audience: null,
              scope_labels: ["remote:mcp"],
            },
            identity_baseline: {
              canonical_host: "api.example.com",
              canonical_port: 443,
              tls_identity_summary: "platform_tls_validated",
              auth_issuer: null,
              publisher_identity: null,
              tool_inventory_hash: "hash_tools",
              fetched_at: "2026-04-01T12:00:00.000Z",
            },
            imported_tools: [],
            tool_inventory_version: "hash_tools",
            last_resolved_at: "2026-04-01T12:00:00.000Z",
            created_at: "2026-04-01T12:00:00.000Z",
            updated_at: "2026-04-01T12:00:00.000Z",
          },
        ],
      }),
      listMcpServerTrustDecisions: vi.fn().mockResolvedValue({
        trust_decisions: [
          {
            trust_decision_id: "mcptrust_123",
            server_profile_id: "mcpprof_123",
            decision: "allow_policy_managed",
            trust_tier: "operator_approved_public",
            allowed_execution_modes: ["local_proxy"],
            max_side_effect_level_without_approval: "read_only",
            reason_codes: ["INITIAL_REVIEW_COMPLETE"],
            approved_by_session_id: "sess_trust",
            approved_at: "2026-04-01T12:00:00.000Z",
            valid_until: null,
            reapproval_triggers: [],
          },
        ],
      }),
      listMcpServerCredentialBindings: vi.fn().mockResolvedValue({
        credential_bindings: [
          {
            credential_binding_id: "mcpbind_123",
            server_profile_id: "mcpprof_123",
            binding_mode: "bearer_secret_ref",
            broker_profile_id: "mcp_secret_123",
            scope_labels: ["remote:mcp"],
            audience: null,
            status: "active",
            created_at: "2026-04-01T12:00:00.000Z",
            updated_at: "2026-04-01T12:00:00.000Z",
            revoked_at: null,
          },
        ],
      }),
      queryTimeline: vi.fn().mockResolvedValue({
        run_summary: {
          run_id: "run_trust",
          session_id: "sess_trust",
          workflow_name: "trust",
          agent_framework: "cli",
          agent_name: "agentgit-cli",
          workspace_roots: ["/tmp/workspace"],
          event_count: 1,
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
          created_at: "2026-04-01T12:00:00.000Z",
          started_at: "2026-04-01T12:00:00.000Z",
        },
        steps: [],
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
      }),
    });

    expect(output.stderr).toBe("");
    expect(output.stdout).toContain("Trust report");
    expect(output.stdout).toContain("MCP profiles: 1");
    expect(output.stdout).toContain("Active non-deny trust decisions: 1");
    expect(output.stdout).toContain("Timeline trust summary:");
  });

  it("runs the onboard-mcp command end to end", async () => {
    const client = {
      upsertMcpSecret: vi.fn().mockResolvedValue({
        secret: {
          secret_id: "mcp_secret_notion",
          status: "active",
        },
        created: true,
      }),
      upsertMcpHostPolicy: vi.fn().mockResolvedValue({
        policy: {
          policy: {
            host: "api.notion.com",
          },
        },
        created: true,
      }),
      upsertMcpServer: vi.fn().mockResolvedValue({
        server: {
          server: {
            server_id: "notes_public",
            transport: "streamable_http",
          },
          source: "operator_api",
          updated_at: "2026-04-01T12:00:00.000Z",
        },
        created: true,
      }),
      registerRun: vi.fn().mockResolvedValue({
        run_id: "run_onboard",
      }),
      submitActionAttempt: vi.fn().mockResolvedValue({
        execution_result: {
          mode: "executed",
          success: true,
          execution_id: "exec_onboard",
          output: {
            summary: "echo:launch blocker",
          },
        },
      }),
    };

    const output = await captureCliRun(
      [
        "onboard-mcp",
        JSON.stringify({
          secrets: [
            {
              secret_id: "mcp_secret_notion",
              display_name: "Notion bearer",
              bearer_token: "token-value",
            },
          ],
          host_policies: [
            {
              host: "api.notion.com",
              display_name: "Notion API",
              allow_subdomains: false,
              allowed_ports: [443],
            },
          ],
          server: {
            server_id: "notes_public",
            display_name: "Notes public MCP",
            transport: "streamable_http",
            url: "https://api.notion.com/mcp",
            network_scope: "public_https",
            auth: {
              type: "bearer_secret_ref",
              secret_id: "mcp_secret_notion",
            },
            tools: [
              {
                tool_name: "echo_note",
                side_effect_level: "read_only",
                approval_mode: "allow",
              },
            ],
          },
          smoke_test: {
            tool_name: "echo_note",
            arguments: {
              note: "launch blocker",
            },
          },
        }),
      ],
      client,
    );

    expect(client.upsertMcpSecret).toHaveBeenCalledTimes(1);
    expect(client.upsertMcpHostPolicy).toHaveBeenCalledTimes(1);
    expect(client.upsertMcpServer).toHaveBeenCalledTimes(1);
    expect(client.registerRun).toHaveBeenCalledTimes(1);
    expect(client.submitActionAttempt).toHaveBeenCalledTimes(1);
    expect(output.stdout).toContain("MCP onboarding completed for notes_public");
    expect(output.stdout).toContain("Smoke test:");
  });

  it("runs the trust-review-mcp command end to end", async () => {
    const client = {
      upsertMcpSecret: vi.fn().mockResolvedValue({
        secret: {
          secret_id: "mcp_secret_remote",
          status: "active",
        },
        created: true,
      }),
      submitMcpServerCandidate: vi.fn().mockResolvedValue({
        candidate: {
          candidate_id: "mcpcand_123",
          source_kind: "user_input",
          raw_endpoint: "http://127.0.0.1:4319/mcp",
          transport_hint: "streamable_http",
          workspace_id: null,
          submitted_by_session_id: "sess_cli",
          submitted_by_run_id: null,
          notes: null,
          resolution_state: "submitted",
          resolution_error: null,
          submitted_at: "2026-04-01T12:00:00.000Z",
          updated_at: "2026-04-01T12:00:00.000Z",
        },
      }),
      resolveMcpServerCandidate: vi.fn().mockResolvedValue({
        candidate: {
          candidate_id: "mcpcand_123",
          source_kind: "user_input",
          raw_endpoint: "http://127.0.0.1:4319/mcp",
          transport_hint: "streamable_http",
          workspace_id: null,
          submitted_by_session_id: "sess_cli",
          submitted_by_run_id: null,
          notes: null,
          resolution_state: "resolved",
          resolution_error: null,
          submitted_at: "2026-04-01T12:00:00.000Z",
          updated_at: "2026-04-01T12:05:00.000Z",
        },
        profile: {
          server_profile_id: "mcpprof_123",
          candidate_id: "mcpcand_123",
          display_name: "Remote Example MCP",
          transport: "streamable_http",
          canonical_endpoint: "http://127.0.0.1:4319/mcp",
          network_scope: "loopback",
          trust_tier: "operator_approved_public",
          status: "draft",
          drift_state: "clean",
          quarantine_reason_codes: [],
          allowed_execution_modes: ["local_proxy"],
          active_trust_decision_id: null,
          active_credential_binding_id: null,
          auth_descriptor: {
            mode: "none",
            audience: null,
            scope_labels: [],
          },
          identity_baseline: {
            canonical_host: "127.0.0.1",
            canonical_port: 4319,
            tls_identity_summary: null,
            auth_issuer: null,
            publisher_identity: null,
            tool_inventory_hash: "hash_tools",
            fetched_at: "2026-04-01T12:05:00.000Z",
          },
          imported_tools: [],
          tool_inventory_version: "hash_tools",
          last_resolved_at: "2026-04-01T12:05:00.000Z",
          created_at: "2026-04-01T12:05:00.000Z",
          updated_at: "2026-04-01T12:05:00.000Z",
        },
        created_profile: true,
        drift_detected: false,
      }),
      approveMcpServerProfile: vi.fn().mockResolvedValue({
        profile: {
          server_profile_id: "mcpprof_123",
          status: "pending_approval",
        },
        trust_decision: {
          trust_decision_id: "mcptrust_123",
          decision: "allow_policy_managed",
        },
        created: true,
      }),
      bindMcpServerCredentials: vi.fn().mockResolvedValue({
        profile: {
          server_profile_id: "mcpprof_123",
        },
        credential_binding: {
          credential_binding_id: "mcpbind_123",
          binding_mode: "bearer_secret_ref",
          status: "active",
        },
      }),
      activateMcpServerProfile: vi.fn().mockResolvedValue({
        profile: {
          server_profile_id: "mcpprof_123",
          status: "active",
        },
      }),
      registerRun: vi.fn().mockResolvedValue({
        run_id: "run_trust_review",
      }),
      submitActionAttempt: vi.fn().mockResolvedValue({
        execution_result: {
          mode: "executed",
          success: true,
          execution_id: "exec_trust_review",
          output: {
            summary: "echo:launch blocker",
          },
        },
      }),
      getMcpServerReview: vi.fn().mockResolvedValue({
        candidate: {
          candidate_id: "mcpcand_123",
          source_kind: "user_input",
          raw_endpoint: "http://127.0.0.1:4319/mcp",
          transport_hint: "streamable_http",
          workspace_id: null,
          submitted_by_session_id: "sess_cli",
          submitted_by_run_id: null,
          notes: null,
          resolution_state: "resolved",
          resolution_error: null,
          submitted_at: "2026-04-01T12:00:00.000Z",
          updated_at: "2026-04-01T12:05:00.000Z",
        },
        profile: {
          server_profile_id: "mcpprof_123",
          candidate_id: "mcpcand_123",
          display_name: "Remote Example MCP",
          transport: "streamable_http",
          canonical_endpoint: "http://127.0.0.1:4319/mcp",
          network_scope: "loopback",
          trust_tier: "operator_approved_public",
          status: "active",
          drift_state: "clean",
          quarantine_reason_codes: [],
          allowed_execution_modes: ["local_proxy"],
          active_trust_decision_id: "mcptrust_123",
          active_credential_binding_id: "mcpbind_123",
          auth_descriptor: {
            mode: "bearer_secret_ref",
            audience: null,
            scope_labels: ["remote:mcp"],
          },
          identity_baseline: {
            canonical_host: "127.0.0.1",
            canonical_port: 4319,
            tls_identity_summary: null,
            auth_issuer: null,
            publisher_identity: null,
            tool_inventory_hash: "hash_tools",
            fetched_at: "2026-04-01T12:05:00.000Z",
          },
          imported_tools: [],
          tool_inventory_version: "hash_tools",
          last_resolved_at: "2026-04-01T12:05:00.000Z",
          created_at: "2026-04-01T12:05:00.000Z",
          updated_at: "2026-04-01T12:05:00.000Z",
        },
        active_trust_decision: {
          trust_decision_id: "mcptrust_123",
          server_profile_id: "mcpprof_123",
          decision: "allow_policy_managed",
          trust_tier: "operator_approved_public",
          allowed_execution_modes: ["local_proxy"],
          max_side_effect_level_without_approval: "read_only",
          reason_codes: ["INITIAL_REVIEW_COMPLETE"],
          approved_by_session_id: "sess_cli",
          approved_at: "2026-04-01T12:05:00.000Z",
          valid_until: null,
          reapproval_triggers: [],
        },
        active_credential_binding: {
          credential_binding_id: "mcpbind_123",
          server_profile_id: "mcpprof_123",
          binding_mode: "bearer_secret_ref",
          broker_profile_id: "mcp_secret_remote",
          scope_labels: ["remote:mcp"],
          audience: null,
          status: "active",
          created_at: "2026-04-01T12:06:00.000Z",
          updated_at: "2026-04-01T12:06:00.000Z",
          revoked_at: null,
        },
        review: {
          review_target: "candidate_profile",
          executable: true,
          activation_ready: true,
          requires_approval: false,
          requires_resolution: false,
          requires_credentials: false,
          requires_reapproval: false,
          hosted_execution_supported: false,
          local_proxy_supported: true,
          drift_detected: false,
          quarantined: false,
          revoked: false,
          warnings: [],
          recommended_actions: [],
        },
      }),
    };

    const output = await captureCliRun(
      [
        "trust-review-mcp",
        JSON.stringify({
          secrets: [
            {
              secret_id: "mcp_secret_remote",
              display_name: "Remote bearer",
              bearer_token: "token-value",
            },
          ],
          candidate: {
            source_kind: "user_input",
            raw_endpoint: "http://127.0.0.1:4319/mcp",
            transport_hint: "streamable_http",
          },
          resolve: {
            display_name: "Remote Example MCP",
          },
          approval: {
            decision: "allow_policy_managed",
            trust_tier: "operator_approved_public",
            allowed_execution_modes: ["local_proxy"],
            reason_codes: ["INITIAL_REVIEW_COMPLETE"],
          },
          credential_binding: {
            binding_mode: "bearer_secret_ref",
            broker_profile_id: "mcp_secret_remote",
            scope_labels: ["remote:mcp"],
          },
          smoke_test: {
            tool_name: "echo_note",
            arguments: {
              note: "launch blocker",
            },
          },
        }),
      ],
      client,
    );

    expect(client.submitMcpServerCandidate).toHaveBeenCalledTimes(1);
    expect(client.resolveMcpServerCandidate).toHaveBeenCalledWith({
      candidate_id: "mcpcand_123",
      display_name: "Remote Example MCP",
    });
    expect(client.approveMcpServerProfile).toHaveBeenCalledWith({
      server_profile_id: "mcpprof_123",
      decision: "allow_policy_managed",
      trust_tier: "operator_approved_public",
      allowed_execution_modes: ["local_proxy"],
      reason_codes: ["INITIAL_REVIEW_COMPLETE"],
    });
    expect(client.bindMcpServerCredentials).toHaveBeenCalledWith({
      server_profile_id: "mcpprof_123",
      binding_mode: "bearer_secret_ref",
      broker_profile_id: "mcp_secret_remote",
      scope_labels: ["remote:mcp"],
    });
    expect(client.activateMcpServerProfile).toHaveBeenCalledWith("mcpprof_123");
    expect(client.getMcpServerReview).toHaveBeenCalledWith({
      server_profile_id: "mcpprof_123",
    });
    expect(output.stdout).toContain("MCP trust review completed for mcpprof_123");
    expect(output.stdout).toContain("Credential binding:");
    expect(output.stdout).toContain("Final review:");
  });

  it("runs the release-verify-artifacts command end to end", async () => {
    const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cli-release-verify-unit-"));
    const tarballPath = path.join(artifactsDir, "pkg.tgz");
    fs.writeFileSync(tarballPath, "package-content", "utf8");
    const tarballSha = createHash("sha256").update(fs.readFileSync(tarballPath)).digest("hex");

    const manifestPath = path.join(artifactsDir, "manifest.json");
    const manifest = {
      packages: [
        {
          name: "@agentgit/example",
          tarball_path: tarballPath,
          sha256: tarballSha,
        },
      ],
    };
    const manifestJson = JSON.stringify(manifest, null, 2);
    fs.writeFileSync(manifestPath, manifestJson, "utf8");
    const manifestSha = createHash("sha256").update(manifestJson, "utf8").digest("hex");
    fs.writeFileSync(path.join(artifactsDir, "manifest.sha256"), `${manifestSha}  manifest.json\n`, "utf8");

    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const signature = createSign("sha256").update(manifestJson).end().sign(privateKey).toString("base64");
    fs.writeFileSync(path.join(artifactsDir, "manifest.sig"), `${signature}\n`, "utf8");
    const publicKeyPath = path.join(artifactsDir, "release-public.pem");
    fs.writeFileSync(publicKeyPath, publicKey.export({ format: "pem", type: "spki" }), "utf8");

    const output = await captureCliRun(
      [
        "--json",
        "release-verify-artifacts",
        artifactsDir,
        "--signature-mode",
        "required",
        "--public-key-path",
        publicKeyPath,
      ],
      {},
    );

    expect(output.stderr).toBe("");
    const parsed = JSON.parse(output.stdout) as {
      ok: boolean;
      signature_verified: boolean;
      packages: Array<{ name: string }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.signature_verified).toBe(true);
    expect(parsed.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "@agentgit/example",
        }),
      ]),
    );
  });

  it("runs the cloud-roadmap command end to end", async () => {
    const output = await captureCliRun(["cloud-roadmap"], {});
    expect(output.stderr).toBe("");
    expect(output.stdout).toContain("Cloud roadmap");
    expect(output.stdout).toContain("Launch contract: local-first-mvp");
    expect(output.stdout).toContain("cloud-1");
  });

  it("runs the policy show command end to end", async () => {
    const output = await captureCliRun(["policy", "show"], {
      getEffectivePolicy: vi.fn().mockResolvedValue({
        policy: {
          profile_name: "workspace-hardening",
          policy_version: "2026.04.01",
          thresholds: {
            low_confidence: [
              {
                action_family: "shell/*",
                ask_below: 0.45,
              },
            ],
          },
          rules: [
            {
              rule_id: "workspace.readme-write-review",
              description: "Require approval before README mutations.",
              rationale: "README is user-facing and should stay review-gated.",
              binding_scope: "workspace",
              decision: "allow",
              enforcement_mode: "require_approval",
              priority: 900,
              match: {
                type: "field",
                field: "actor.tool_name",
                operator: "eq",
                value: "write_file",
              },
              reason: {
                code: "README_REQUIRES_APPROVAL",
                severity: "moderate",
                message: "README writes require approval.",
              },
            },
          ],
        },
        summary: {
          profile_name: "workspace-hardening",
          policy_versions: ["2026.04.01", "builtin.2026-04-01"],
          compiled_rule_count: 3,
          loaded_sources: [
            {
              scope: "workspace",
              path: "/tmp/workspace/.agentgit/policy.toml",
              profile_name: "workspace-hardening",
              policy_version: "2026.04.01",
              rule_count: 1,
            },
            {
              scope: "builtin_default",
              path: null,
              profile_name: "local-default",
              policy_version: "builtin.2026-04-01",
              rule_count: 2,
            },
          ],
          warnings: [],
        },
      }),
    });

    expect(output.stderr).toBe("");
    expect(output.stdout).toContain("Effective policy");
    expect(output.stdout).toContain("Profile: workspace-hardening");
    expect(output.stdout).toContain("shell/*: ask_below=0.450");
    expect(output.stdout).toContain("workspace.readme-write-review [require_approval/allow]");
  });

  it("runs the policy diff command against a TOML file", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cli-policy-diff-"));
    const policyPath = path.join(tempRoot, "policy.toml");
    fs.writeFileSync(
      policyPath,
      [
        'profile_name = "workspace-hardening"',
        'policy_version = "2026.04.02"',
        "",
        "[thresholds]",
        'low_confidence = [{ action_family = "shell/*", ask_below = 0.40 }]',
        "",
        "[[rules]]",
        'rule_id = "workspace.readme-write-review"',
        'description = "Require approval before README mutations."',
        'rationale = "README is user-facing and should stay review-gated."',
        'binding_scope = "workspace"',
        'decision = "allow"',
        'enforcement_mode = "require_approval"',
        "priority = 900",
        'reason = { code = "README_REQUIRES_APPROVAL", severity = "moderate", message = "README writes require approval." }',
        'match = { type = "field", field = "actor.tool_name", operator = "eq", value = "write_file" }',
      ].join("\n"),
      "utf8",
    );

    const output = await captureCliRun(["policy", "diff", policyPath], {
      getEffectivePolicy: vi.fn().mockResolvedValue({
        policy: {
          profile_name: "workspace-hardening",
          policy_version: "2026.04.01",
          thresholds: {
            low_confidence: [
              {
                action_family: "shell/*",
                ask_below: 0.45,
              },
            ],
          },
          rules: [],
        },
        summary: {
          profile_name: "workspace-hardening",
          policy_versions: ["2026.04.01", "builtin.2026-04-01"],
          compiled_rule_count: 3,
          loaded_sources: [],
          warnings: [],
        },
      }),
    });

    expect(output.stderr).toBe("");
    expect(output.stdout).toContain("Policy diff");
    expect(output.stdout).toContain("Threshold changes:");
    expect(output.stdout).toContain("shell/*: 0.450 -> 0.400");
    expect(output.stdout).toContain("Rule additions: workspace.readme-write-review");
  });

  it("runs the policy calibration-report command end to end", async () => {
    const output = await captureCliRun(
      ["policy", "calibration-report", "--run-id", "run_policy", "--include-samples", "--sample-limit", "5"],
      {
        getPolicyCalibrationReport: vi.fn().mockResolvedValue({
          report: {
            generated_at: "2026-04-01T12:00:00.000Z",
            filters: {
              run_id: "run_policy",
              include_samples: true,
              sample_limit: 5,
            },
            totals: {
              sample_count: 2,
              unique_action_families: 2,
              confidence: {
                average: 0.69,
                min: 0.42,
                max: 0.96,
              },
              decisions: {
                allow: 0,
                allow_with_snapshot: 1,
                ask: 1,
                deny: 0,
              },
              approvals: {
                requested: 1,
                pending: 0,
                approved: 1,
                denied: 0,
              },
              recovery_attempted_count: 1,
            },
            action_families: [
              {
                action_family: "filesystem/write",
                sample_count: 1,
                confidence: {
                  average: 0.96,
                  min: 0.96,
                  max: 0.96,
                },
                decisions: {
                  allow: 0,
                  allow_with_snapshot: 1,
                  ask: 0,
                  deny: 0,
                },
                approvals: {
                  requested: 0,
                  pending: 0,
                  approved: 0,
                  denied: 0,
                },
                snapshot_classes: [{ key: "journal_plus_anchor", count: 1 }],
                top_matched_rules: [{ key: "builtin.fs.snapshot", count: 1 }],
                top_reason_codes: [{ key: "SAFE_TO_RUN", count: 1 }],
                recovery_attempted_count: 1,
                approval_rate: 0,
                denial_rate: null,
              },
              {
                action_family: "shell/exec",
                sample_count: 1,
                confidence: {
                  average: 0.42,
                  min: 0.42,
                  max: 0.42,
                },
                decisions: {
                  allow: 0,
                  allow_with_snapshot: 0,
                  ask: 1,
                  deny: 0,
                },
                approvals: {
                  requested: 1,
                  pending: 0,
                  approved: 1,
                  denied: 0,
                },
                snapshot_classes: [],
                top_matched_rules: [{ key: "builtin.shell.ask", count: 1 }],
                top_reason_codes: [{ key: "APPROVAL_REQUIRED", count: 1 }],
                recovery_attempted_count: 0,
                approval_rate: 1,
                denial_rate: 0,
              },
            ],
            samples: [
              {
                sample_id: "run_policy:act_shell",
                run_id: "run_policy",
                action_id: "act_shell",
                evaluated_at: "2026-04-01T12:01:00.000Z",
                action_family: "shell/exec",
                decision: "ask",
                normalization_confidence: 0.42,
                matched_rules: ["builtin.shell.ask"],
                reason_codes: ["APPROVAL_REQUIRED"],
                snapshot_class: null,
                approval_requested: true,
                approval_id: "apr_123",
                approval_status: "approved",
                resolved_at: "2026-04-01T12:02:00.000Z",
                recovery_attempted: false,
                recovery_result: null,
                recovery_class: null,
                recovery_strategy: null,
              },
            ],
            samples_truncated: false,
          },
        }),
      },
    );

    expect(output.stderr).toBe("");
    expect(output.stdout).toContain("Policy calibration report");
    expect(output.stdout).toContain("Run filter: run_policy");
    expect(output.stdout).toContain("Samples: 2");
    expect(output.stdout).toContain("shell/exec: 1 sample");
    expect(output.stdout).toContain("act_shell [shell/exec] decision=ask");
  });

  it("runs the policy explain command end to end", async () => {
    const attemptPath = path.join(os.tmpdir(), `agentgit-policy-explain-${Date.now()}.json`);
    fs.writeFileSync(
      attemptPath,
      JSON.stringify({
        run_id: "run_policy",
        tool_registration: {
          tool_name: "write_file",
          tool_kind: "filesystem",
        },
        raw_call: {
          path: "/workspace/README.md",
          content: "hello",
        },
        environment_context: {
          workspace_roots: ["/workspace"],
        },
        received_at: "2026-04-01T12:00:00.000Z",
      }),
      "utf8",
    );

    const output = await captureCliRun(["policy", "explain", attemptPath], {
      explainPolicyAction: vi.fn().mockResolvedValue({
        action: {
          schema_version: "action.v1",
          action_id: "act_explain",
          run_id: "run_policy",
          session_id: "sess_test",
          status: "normalized",
          timestamps: {
            requested_at: "2026-04-01T12:00:00.000Z",
            normalized_at: "2026-04-01T12:00:01.000Z",
          },
          provenance: {
            mode: "governed",
            source: "test",
            confidence: 0.99,
          },
          actor: {
            type: "agent",
            tool_name: "write_file",
            tool_kind: "filesystem",
          },
          operation: {
            domain: "filesystem",
            kind: "write",
            name: "filesystem.write",
            display_name: "Write file",
          },
          execution_path: {
            surface: "governed_fs",
            mode: "pre_execution",
            credential_mode: "none",
          },
          target: {
            primary: {
              type: "path",
              locator: "/workspace/README.md",
            },
            scope: {
              breadth: "single",
              estimated_count: 1,
              unknowns: [],
            },
          },
          input: {
            raw: {},
            redacted: {},
            schema_ref: null,
            contains_sensitive_data: false,
          },
          risk_hints: {
            side_effect_level: "mutating",
            external_effects: "none",
            reversibility_hint: "reversible",
            sensitivity_hint: "low",
            batch: false,
          },
          facets: {
            filesystem: {
              operation: "write",
              byte_length: 5,
            },
          },
          normalization: {
            mapper: "test",
            inferred_fields: [],
            warnings: [],
            normalization_confidence: 0.96,
          },
          confidence_assessment: {
            engine_version: "test-confidence/v1",
            score: 0.96,
            band: "high",
            requires_human_review: false,
            factors: [
              {
                factor_id: "test_baseline",
                label: "Test baseline",
                kind: "baseline",
                delta: 0.96,
                rationale: "Test confidence baseline.",
              },
            ],
          },
        },
        policy_outcome: {
          schema_version: "policy-outcome.v1",
          policy_outcome_id: "pol_explain",
          action_id: "act_explain",
          decision: "allow",
          reasons: [
            {
              code: "FS_SMALL_WORKSPACE_WRITE",
              severity: "low",
              message: "Small workspace writes are allowed.",
            },
          ],
          trust_requirements: {
            wrapped_path_required: true,
            brokered_credentials_required: false,
            direct_credentials_forbidden: false,
          },
          preconditions: {
            snapshot_required: false,
            approval_required: false,
            simulation_supported: false,
          },
          approval: null,
          budget_effects: {
            budget_check: "passed",
            estimated_cost: 0,
            remaining_mutating_actions: null,
            remaining_destructive_actions: null,
          },
          policy_context: {
            matched_rules: ["filesystem.write.small.allow"],
            sticky_decision_applied: false,
          },
          evaluated_at: "2026-04-01T12:00:02.000Z",
        },
        action_family: "filesystem/write",
        effective_policy_profile: "workspace-hardening",
        low_confidence_threshold: 0.3,
        confidence_score: 0.96,
        confidence_triggered: false,
        snapshot_selection: null,
      }),
    });

    expect(output.stderr).toBe("");
    expect(output.stdout).toContain("Policy explanation");
    expect(output.stdout).toContain("Action family: filesystem/write");
    expect(output.stdout).toContain("Decision: allow");
    expect(output.stdout).toContain("Low-confidence threshold: 0.300");
  });

  it("runs the policy recommend-thresholds command end to end", async () => {
    const output = await captureCliRun(
      ["policy", "recommend-thresholds", "--run-id", "run_policy", "--min-samples", "2"],
      {
        getPolicyThresholdRecommendations: vi.fn().mockResolvedValue({
          generated_at: "2026-04-01T12:00:00.000Z",
          filters: {
            run_id: "run_policy",
            min_samples: 2,
          },
          effective_policy_profile: "workspace-hardening",
          recommendations: [
            {
              action_family: "shell/exec",
              current_ask_below: 0.3,
              recommended_ask_below: 0.41,
              direction: "relax",
              sample_count: 4,
              approvals_requested: 4,
              approvals_approved: 4,
              approvals_denied: 0,
              observed_confidence_min: 0.32,
              observed_confidence_max: 0.61,
              denied_confidence_max: null,
              approved_confidence_min: 0.42,
              rationale: "Relax with human review.",
              requires_policy_update: true,
              automatic_live_application_allowed: false,
            },
          ],
        }),
      },
    );

    expect(output.stderr).toBe("");
    expect(output.stdout).toContain("Policy threshold recommendations");
    expect(output.stdout).toContain("Profile: workspace-hardening");
    expect(output.stdout).toContain("shell/exec: relax");
    expect(output.stdout).toContain("threshold: 0.300 -> 0.410");
    expect(output.stdout).toContain("Report only: yes");
  });

  it("runs the policy replay-thresholds command end to end", async () => {
    const output = await captureCliRun(
      ["policy", "replay-thresholds", "--run-id", "run_policy", "--min-samples", "2", "--direction", "relax"],
      {
        getPolicyThresholdRecommendations: vi.fn().mockResolvedValue({
          generated_at: "2026-04-01T12:00:00.000Z",
          filters: {
            run_id: "run_policy",
            min_samples: 2,
          },
          effective_policy_profile: "workspace-hardening",
          recommendations: [
            {
              action_family: "filesystem/write",
              current_ask_below: 0.3,
              recommended_ask_below: 0.4,
              direction: "tighten",
              sample_count: 1,
              approvals_requested: 0,
              approvals_approved: 0,
              approvals_denied: 0,
              observed_confidence_min: 0.35,
              observed_confidence_max: 0.35,
              denied_confidence_max: null,
              approved_confidence_min: null,
              rationale: "Tighten for replay coverage.",
              requires_policy_update: true,
              automatic_live_application_allowed: false,
            },
          ],
        }),
        replayPolicyThresholds: vi.fn().mockResolvedValue({
          generated_at: "2026-04-01T12:00:01.000Z",
          filters: {
            run_id: "run_policy",
            include_changed_samples: false,
            sample_limit: null,
          },
          effective_policy_profile: "workspace-hardening",
          candidate_thresholds: [
            {
              action_family: "filesystem/write",
              ask_below: 0.4,
            },
          ],
          summary: {
            replayable_samples: 1,
            skipped_samples: 0,
            changed_decisions: 1,
            unchanged_decisions: 0,
            current_approvals_requested: 0,
            candidate_approvals_requested: 1,
            approvals_reduced: 0,
            approvals_increased: 1,
            historically_denied_auto_allowed: 0,
            historically_approved_auto_allowed: 0,
            historically_allowed_newly_gated: 1,
            current_matches_recorded: 1,
            current_diverges_from_recorded: 0,
          },
          action_families: [
            {
              action_family: "filesystem/write",
              replayable_samples: 1,
              skipped_samples: 0,
              changed_decisions: 1,
              unchanged_decisions: 0,
              current_approvals_requested: 0,
              candidate_approvals_requested: 1,
              approvals_reduced: 0,
              approvals_increased: 1,
              historically_denied_auto_allowed: 0,
              historically_approved_auto_allowed: 0,
              historically_allowed_newly_gated: 1,
              current_matches_recorded: 1,
              current_diverges_from_recorded: 0,
            },
          ],
          samples_truncated: false,
        }),
      },
    );

    expect(output.stderr).toBe("");
    expect(output.stdout).toContain("Policy threshold replay");
    expect(output.stdout).toContain("Candidate thresholds: filesystem/write=0.400");
    expect(output.stdout).toContain("Approvals increased: 1");
    expect(output.stdout).toContain("allowed_newly_gated=1");
  });

  it("runs the policy render-threshold-patch command end to end", async () => {
    const output = await captureCliRun(
      ["policy", "render-threshold-patch", "--run-id", "run_policy", "--min-samples", "2", "--direction", "relax"],
      {
        getPolicyThresholdRecommendations: vi.fn().mockResolvedValue({
          generated_at: "2026-04-01T12:00:00.000Z",
          filters: {
            run_id: "run_policy",
            min_samples: 2,
          },
          effective_policy_profile: "workspace-hardening",
          recommendations: [
            {
              action_family: "shell/exec",
              current_ask_below: 0.3,
              recommended_ask_below: 0.28,
              direction: "relax",
              sample_count: 4,
              approvals_requested: 4,
              approvals_approved: 4,
              approvals_denied: 0,
              observed_confidence_min: 0.29,
              observed_confidence_max: 0.61,
              denied_confidence_max: null,
              approved_confidence_min: 0.29,
              rationale: "Relax with human review.",
              requires_policy_update: true,
              automatic_live_application_allowed: false,
            },
          ],
        }),
        replayPolicyThresholds: vi.fn().mockResolvedValue({
          generated_at: "2026-04-01T12:00:01.000Z",
          filters: {
            run_id: "run_policy",
            include_changed_samples: false,
            sample_limit: null,
          },
          effective_policy_profile: "workspace-hardening",
          candidate_thresholds: [
            {
              action_family: "shell/exec",
              ask_below: 0.28,
            },
          ],
          summary: {
            replayable_samples: 4,
            skipped_samples: 0,
            changed_decisions: 1,
            unchanged_decisions: 3,
            current_approvals_requested: 4,
            candidate_approvals_requested: 3,
            approvals_reduced: 1,
            approvals_increased: 0,
            historically_denied_auto_allowed: 0,
            historically_approved_auto_allowed: 0,
            historically_allowed_newly_gated: 0,
            current_matches_recorded: 4,
            current_diverges_from_recorded: 0,
          },
          action_families: [
            {
              action_family: "shell/exec",
              current_ask_below: 0.3,
              candidate_ask_below: 0.28,
              replayable_samples: 4,
              skipped_samples: 0,
              changed_decisions: 1,
              unchanged_decisions: 3,
              current_approvals_requested: 4,
              candidate_approvals_requested: 3,
              approvals_reduced: 1,
              approvals_increased: 0,
              historically_denied_auto_allowed: 0,
              historically_approved_auto_allowed: 0,
              historically_allowed_newly_gated: 0,
              current_matches_recorded: 4,
              current_diverges_from_recorded: 0,
            },
          ],
          samples_truncated: false,
        }),
      },
    );

    expect(output.stderr).toBe("");
    expect(output.stdout).toContain("Policy threshold patch");
    expect(output.stdout).toContain("Direction filter: relax");
    expect(output.stdout).toContain('action_family = "shell/exec"');
    expect(output.stdout).toContain("ask_below = 0.280");
    expect(output.stdout).toContain("Apply step: review this patch");
  });

  it("runs the policy validate command locally against a TOML file", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cli-policy-"));
    const policyPath = path.join(tempRoot, "policy.toml");
    fs.writeFileSync(
      policyPath,
      [
        'profile_name = "workspace-hardening"',
        'policy_version = "2026.04.01"',
        "",
        "[[rules]]",
        'rule_id = "workspace.readme-write-review"',
        'description = "Require approval before README mutations."',
        'rationale = "README is user-facing and should stay review-gated."',
        'binding_scope = "workspace"',
        'decision = "allow"',
        'enforcement_mode = "require_approval"',
        "priority = 900",
        'reason = { code = "README_REQUIRES_APPROVAL", severity = "moderate", message = "README writes require approval." }',
        'match = { type = "field", field = "actor.tool_name", operator = "eq", value = "write_file" }',
      ].join("\n"),
      "utf8",
    );

    const output = await captureCliRun(["policy", "validate", policyPath], {});

    expect(output.stderr).toBe("");
    expect(output.stdout).toContain("Policy validation");
    expect(output.stdout).toContain("Valid: yes");
    expect(output.stdout).toContain("Compiled rules: 1");
  });

  it("runs the upsert-mcp-host-policy command end to end", async () => {
    const client = {
      upsertMcpHostPolicy: vi.fn().mockResolvedValue({
        created: true,
        policy: {
          policy: {
            host: "api.notion.com",
            display_name: "Notion API",
            allow_subdomains: false,
            allowed_ports: [443],
          },
          source: "operator_api",
          created_at: "2026-03-31T12:00:00.000Z",
          updated_at: "2026-03-31T12:00:00.000Z",
        },
      }),
    };

    const output = await captureCliRun(
      [
        "upsert-mcp-host-policy",
        JSON.stringify({
          host: "api.notion.com",
          display_name: "Notion API",
          allow_subdomains: false,
          allowed_ports: [443],
        }),
      ],
      client,
    );

    expect(client.upsertMcpHostPolicy).toHaveBeenCalledWith({
      host: "api.notion.com",
      display_name: "Notion API",
      allow_subdomains: false,
      allowed_ports: [443],
    });
    expect(output.stdout).toContain("Registered MCP host policy api.notion.com");
  });

  it("runs the doctor command end to end and recommends OCI sandboxing when stdio protection is degraded", async () => {
    const output = await captureCliRun(["doctor"], {
      hello: vi.fn().mockResolvedValue({
        schema_version: "authority.hello.v1",
        session_id: "sess_cli",
        accepted_api_version: "authority.v1",
        runtime_version: "1.0.0-test",
        schema_pack_version: "1.0.0-test",
      }),
      getCapabilities: vi.fn().mockResolvedValue({
        capabilities: [
          {
            capability_name: "host.credential_broker_mode",
            status: "available",
            scope: "host",
            detected_at: "2026-04-01T12:00:00.000Z",
            source: "authority_daemon",
            details: {
              mode: "local_encrypted_store",
              key_provider: "macos_keychain",
            },
          },
        ],
        detection_timestamps: {
          started_at: "2026-04-01T12:00:00.000Z",
          completed_at: "2026-04-01T12:00:00.000Z",
        },
        degraded_mode_warnings: [],
      }),
      listMcpServers: vi.fn().mockResolvedValue({
        servers: [],
      }),
      listMcpSecrets: vi.fn().mockResolvedValue({
        secrets: [],
      }),
      listMcpHostPolicies: vi.fn().mockResolvedValue({
        policies: [],
      }),
      diagnostics: vi.fn().mockResolvedValue({
        policy_summary: null,
        security_posture: {
          status: "degraded",
          secret_storage: {
            mode: "local_encrypted_store",
            provider: "macos_keychain",
            durable: true,
            encrypted_at_rest: true,
            secret_expiry_enforced: true,
            rotation_metadata_tracked: true,
            legacy_key_path: null,
          },
          stdio_sandbox: {
            registered_server_count: 2,
            protected_server_count: 1,
            production_ready_server_count: 1,
            digest_pinned_server_count: 0,
            mutable_tag_server_count: 1,
            local_build_server_count: 0,
            registry_policy_server_count: 0,
            signature_verification_server_count: 0,
            provenance_attestation_server_count: 0,
            fallback_server_count: 0,
            unconfigured_server_count: 1,
            preferred_production_mode: "oci_container",
            local_dev_fallback_mode: null,
            current_host_mode: "oci_container_ready",
            current_host_mode_reason: "Docker is usable on this host for OCI sandboxing.",
            macos_seatbelt_available: false,
            docker_runtime_usable: true,
            podman_runtime_usable: false,
            windows_plan: {
              supported_via_oci: true,
              recommended_runtime: "docker_desktop_wsl2_or_podman_machine",
              native_fallback_available: false,
              summary:
                "On Windows, use Docker Desktop with WSL2 or Podman machine for OCI sandboxing. No native host-process fallback is supported.",
            },
            degraded_servers: ["notes_stdio"],
          },
          streamable_http: {
            registered_server_count: 1,
            connect_time_dns_scope_validation: true,
            redirect_chain_revalidation: true,
            concurrency_limits_enforced: true,
            shared_sqlite_leases: true,
            lease_heartbeat_renewal: true,
            legacy_bearer_env_servers: [],
            missing_secret_ref_servers: [],
            missing_public_host_policy_servers: [],
          },
          warnings: ["1 governed stdio MCP server does not have a usable sandbox on this host."],
          primary_reason: {
            code: "STDIO_SANDBOX_DEGRADED",
            message: "1 governed stdio MCP server does not have a usable sandbox on this host.",
          },
        },
        hosted_worker: {
          status: "degraded",
          reachable: false,
          managed_by_daemon: false,
          endpoint_kind: "unix",
          endpoint: "unix:/tmp/hosted-worker.sock",
          runtime_id: null,
          image_digest: null,
          control_plane_auth_required: true,
          last_error: "connect ENOENT /tmp/hosted-worker.sock",
          primary_reason: {
            code: "HOSTED_WORKER_UNREACHABLE",
            message: "connect ENOENT /tmp/hosted-worker.sock",
          },
          warnings: ["Hosted MCP worker is unreachable: connect ENOENT /tmp/hosted-worker.sock"],
        },
        hosted_queue: {
          status: "degraded",
          queued_jobs: 0,
          running_jobs: 0,
          cancel_requested_jobs: 0,
          succeeded_jobs: 0,
          failed_jobs: 1,
          canceled_jobs: 0,
          retryable_failed_jobs: 1,
          dead_letter_retryable_jobs: 1,
          dead_letter_non_retryable_jobs: 0,
          oldest_queued_at: null,
          oldest_failed_at: "2026-04-01T12:05:00.000Z",
          active_server_profiles: ["mcpprof_hosted"],
          primary_reason: {
            code: "HOSTED_QUEUE_FAILED_JOBS",
            message: "1 hosted MCP execution job(s) are in a failed terminal state.",
          },
          warnings: ["1 hosted MCP execution job(s) are in a failed terminal state and require operator action."],
        },
      }),
    });

    expect(output.stderr).toBe("");
    expect(output.stdout).toContain("Security posture: degraded");
    expect(output.stdout).toContain("[warn] SECURITY_POSTURE");
    expect(output.stdout).toContain("[warn] HOSTED_WORKER");
    expect(output.stdout).toContain("[warn] HOSTED_QUEUE");
    expect(output.stdout).toContain("Set all stdio MCP servers to the `oci_container` sandbox.");
    expect(output.stdout).toContain("Replace mutable-tag OCI images for 1 stdio MCP server(s) with sha256-pinned refs");
    expect(output.stdout).toContain(
      "Inspect failed hosted MCP jobs with `list-hosted-mcp-jobs` or `show-hosted-mcp-job`, then recover them with `requeue-hosted-mcp-job`",
    );
  });

  it("runs the hosted MCP operator commands end to end", async () => {
    const client = {
      getHostedMcpJob: vi.fn().mockResolvedValue({
        job: {
          job_id: "mcpjob_123",
          run_id: "run_cli",
          action_id: "act_cli",
          server_profile_id: "mcpprof_123",
          tool_name: "echo_note",
          server_display_name: "Hosted Notes",
          canonical_endpoint: "https://api.example.com/mcp",
          network_scope: "public_https",
          allowed_hosts: ["api.example.com"],
          auth_context_ref: "none",
          arguments: {
            note: "hello",
          },
          status: "failed",
          attempt_count: 4,
          max_attempts: 4,
          current_lease_id: "mcplease_123",
          claimed_by: null,
          claimed_at: null,
          last_heartbeat_at: null,
          cancel_requested_at: null,
          cancel_requested_by_session_id: null,
          cancel_reason: null,
          canceled_at: null,
          next_attempt_at: "2026-04-01T12:05:00.000Z",
          created_at: "2026-04-01T12:00:00.000Z",
          updated_at: "2026-04-01T12:05:00.000Z",
          completed_at: "2026-04-01T12:05:00.000Z",
          last_error: {
            code: "CAPABILITY_UNAVAILABLE",
            message: "Hosted worker unavailable",
            retryable: true,
          },
          execution_result: null,
        },
        lifecycle: {
          state: "dead_letter_retryable",
          dead_lettered: true,
          eligible_for_requeue: true,
          retry_budget_remaining: 0,
        },
        leases: [
          {
            lease_id: "mcplease_123",
            run_id: "run_cli",
            action_id: "act_cli",
            server_profile_id: "mcpprof_123",
            tool_name: "echo_note",
            auth_context_ref: "none",
            allowed_hosts: ["api.example.com"],
            issued_at: "2026-04-01T12:00:01.000Z",
            expires_at: "2026-04-01T12:01:01.000Z",
            artifact_budget: {
              max_artifacts: 8,
              max_total_bytes: 262144,
            },
            single_use: true,
            status: "consumed",
            consumed_at: "2026-04-01T12:00:02.000Z",
            revoked_at: null,
          },
        ],
        attestations: [],
        recent_events: [
          {
            sequence: 11,
            event_type: "mcp_hosted_job_dead_lettered",
            occurred_at: "2026-04-01T12:05:00.000Z",
            recorded_at: "2026-04-01T12:05:00.000Z",
            payload: {
              job_id: "mcpjob_123",
              error_code: "CAPABILITY_UNAVAILABLE",
            },
          },
        ],
      }),
      listHostedMcpJobs: vi.fn().mockResolvedValue({
        jobs: [
          {
            job_id: "mcpjob_123",
            run_id: "run_cli",
            action_id: "act_cli",
            server_profile_id: "mcpprof_123",
            tool_name: "echo_note",
            server_display_name: "Hosted Notes",
            canonical_endpoint: "https://api.example.com/mcp",
            network_scope: "public_https",
            allowed_hosts: ["api.example.com"],
            auth_context_ref: "none",
            arguments: {
              note: "hello",
            },
            status: "failed",
            attempt_count: 4,
            max_attempts: 4,
            current_lease_id: null,
            claimed_by: null,
            claimed_at: null,
            last_heartbeat_at: null,
            cancel_requested_at: null,
            cancel_requested_by_session_id: null,
            cancel_reason: null,
            canceled_at: null,
            next_attempt_at: "2026-04-01T12:05:00.000Z",
            created_at: "2026-04-01T12:00:00.000Z",
            updated_at: "2026-04-01T12:05:00.000Z",
            completed_at: "2026-04-01T12:05:00.000Z",
            last_error: {
              code: "CAPABILITY_UNAVAILABLE",
              message: "Hosted worker unavailable",
              retryable: true,
            },
            execution_result: null,
          },
        ],
        summary: {
          queued: 0,
          running: 0,
          cancel_requested: 0,
          succeeded: 0,
          failed: 1,
          canceled: 0,
          dead_letter_retryable: 1,
          dead_letter_non_retryable: 0,
        },
      }),
      requeueHostedMcpJob: vi.fn().mockResolvedValue({
        job: {
          job_id: "mcpjob_123",
          run_id: "run_cli",
          action_id: "act_cli",
          server_profile_id: "mcpprof_123",
          tool_name: "echo_note",
          server_display_name: "Hosted Notes",
          canonical_endpoint: "https://api.example.com/mcp",
          network_scope: "public_https",
          allowed_hosts: ["api.example.com"],
          auth_context_ref: "none",
          arguments: {
            note: "hello",
          },
          status: "queued",
          attempt_count: 4,
          max_attempts: 4,
          current_lease_id: null,
          claimed_by: null,
          claimed_at: null,
          last_heartbeat_at: null,
          cancel_requested_at: null,
          cancel_requested_by_session_id: null,
          cancel_reason: null,
          canceled_at: null,
          next_attempt_at: "2026-04-01T12:06:00.000Z",
          created_at: "2026-04-01T12:00:00.000Z",
          updated_at: "2026-04-01T12:06:00.000Z",
          completed_at: null,
          last_error: null,
          execution_result: null,
        },
        requeued: true,
        previous_status: "failed",
        attempt_count_reset: true,
        max_attempts_updated: true,
      }),
      cancelHostedMcpJob: vi.fn().mockResolvedValue({
        job: {
          job_id: "mcpjob_123",
          run_id: "run_cli",
          action_id: "act_cli",
          server_profile_id: "mcpprof_123",
          tool_name: "echo_note",
          server_display_name: "Hosted Notes",
          canonical_endpoint: "https://api.example.com/mcp",
          network_scope: "public_https",
          allowed_hosts: ["api.example.com"],
          auth_context_ref: "none",
          arguments: {
            note: "hello",
          },
          status: "canceled",
          attempt_count: 4,
          max_attempts: 4,
          current_lease_id: null,
          claimed_by: null,
          claimed_at: null,
          last_heartbeat_at: "2026-04-01T12:05:30.000Z",
          cancel_requested_at: "2026-04-01T12:05:30.000Z",
          cancel_requested_by_session_id: "sess_cli",
          cancel_reason: "operator stop",
          canceled_at: "2026-04-01T12:05:31.000Z",
          next_attempt_at: "2026-04-01T12:05:00.000Z",
          created_at: "2026-04-01T12:00:00.000Z",
          updated_at: "2026-04-01T12:05:31.000Z",
          completed_at: "2026-04-01T12:05:31.000Z",
          last_error: {
            code: "CONFLICT",
            message: "Hosted MCP execution job was canceled during execution.",
            retryable: false,
          },
          execution_result: null,
        },
        cancellation_requested: true,
        previous_status: "running",
        terminal: true,
      }),
    };

    const showOutput = await captureCliRun(["show-hosted-mcp-job", "mcpjob_123"], client);
    expect(client.getHostedMcpJob).toHaveBeenCalledWith("mcpjob_123");
    expect(showOutput.stdout).toContain("Hosted MCP job mcpjob_123");
    expect(showOutput.stdout).toContain("Lifecycle: dead_letter_retryable");

    const listOutput = await captureCliRun(["list-hosted-mcp-jobs", "mcpprof_123", "failed"], client);
    expect(client.listHostedMcpJobs).toHaveBeenCalledWith({
      server_profile_id: "mcpprof_123",
      status: "failed",
    });
    expect(listOutput.stdout).toContain("Hosted MCP execution jobs");
    expect(listOutput.stdout).toContain("Dead-letter summary: 1 retryable, 0 non-retryable");
    expect(listOutput.stdout).toContain("mcpjob_123 [failed]");

    const requeueOutput = await captureCliRun(
      ["requeue-hosted-mcp-job", "mcpjob_123", "--reset-attempts", "--max-attempts", "6", "--reason", "worker fixed"],
      client,
    );
    expect(client.requeueHostedMcpJob).toHaveBeenCalledWith("mcpjob_123", {
      reset_attempt_count: true,
      max_attempts: 6,
      reason: "worker fixed",
    });
    expect(requeueOutput.stdout).toContain("Requeued hosted MCP job mcpjob_123");
    expect(requeueOutput.stdout).toContain("Current status: queued");
    expect(requeueOutput.stdout).toContain("Attempt count reset: yes");
    expect(requeueOutput.stdout).toContain("Max attempts updated: yes");

    const cancelOutput = await captureCliRun(
      ["cancel-hosted-mcp-job", "mcpjob_123", "--reason", "operator stop"],
      client,
    );
    expect(client.cancelHostedMcpJob).toHaveBeenCalledWith("mcpjob_123", {
      reason: "operator stop",
    });
    expect(cancelOutput.stdout).toContain("Canceled hosted MCP job mcpjob_123");
    expect(cancelOutput.stdout).toContain("Current status: canceled");
  });

  it("runs the MCP server review command end to end", async () => {
    const client = {
      getMcpServerReview: vi.fn().mockResolvedValue({
        candidate: {
          candidate_id: "mcpcand_123",
          source_kind: "agent_discovered",
          raw_endpoint: "https://api.example.com/mcp",
          transport_hint: "streamable_http",
          workspace_id: null,
          submitted_by_session_id: "sess_cli",
          submitted_by_run_id: null,
          notes: null,
          resolution_state: "resolved",
          resolution_error: null,
          submitted_at: "2026-04-01T12:00:00.000Z",
          updated_at: "2026-04-01T12:05:00.000Z",
        },
        profile: {
          server_profile_id: "mcpprof_123",
          candidate_id: "mcpcand_123",
          display_name: "Example MCP",
          transport: "streamable_http",
          canonical_endpoint: "https://api.example.com/mcp",
          network_scope: "public_https",
          trust_tier: "operator_approved_public",
          status: "pending_approval",
          drift_state: "clean",
          quarantine_reason_codes: [],
          allowed_execution_modes: ["hosted_delegated"],
          active_trust_decision_id: null,
          active_credential_binding_id: null,
          auth_descriptor: {
            mode: "hosted_token_exchange",
            audience: null,
            scope_labels: ["remote:mcp"],
          },
          identity_baseline: {
            canonical_host: "api.example.com",
            canonical_port: 443,
            tls_identity_summary: "platform_tls_validated",
            auth_issuer: null,
            publisher_identity: null,
            tool_inventory_hash: "hash_tools",
            fetched_at: "2026-04-01T12:05:00.000Z",
          },
          imported_tools: [],
          tool_inventory_version: "hash_tools",
          last_resolved_at: "2026-04-01T12:05:00.000Z",
          created_at: "2026-04-01T12:05:00.000Z",
          updated_at: "2026-04-01T12:05:00.000Z",
        },
        active_trust_decision: null,
        active_credential_binding: null,
        review: {
          review_target: "candidate_profile",
          executable: false,
          activation_ready: false,
          requires_approval: true,
          requires_resolution: false,
          requires_credentials: true,
          requires_reapproval: false,
          hosted_execution_supported: true,
          local_proxy_supported: false,
          drift_detected: false,
          quarantined: false,
          revoked: false,
          warnings: [
            "Profile does not have an active non-deny trust decision.",
            "Profile requires brokered credentials before activation.",
          ],
          recommended_actions: [
            "Approve the profile with explicit trust tier and execution mode limits.",
            "Bind brokered credentials that match the profile auth descriptor.",
          ],
        },
      }),
    };

    const output = await captureCliRun(["show-mcp-server-review", "mcpprof_123"], client);
    expect(client.getMcpServerReview).toHaveBeenCalledWith({
      server_profile_id: "mcpprof_123",
    });
    expect(output.stdout).toContain("MCP server review");
    expect(output.stdout).toContain("Profile: mcpprof_123 [pending_approval]");
    expect(output.stdout).toContain("Requires approval: yes");
    expect(output.stdout).toContain("Recommended actions:");
  });

  it("runs the remove-mcp-secret command end to end", async () => {
    const client = {
      removeMcpSecret: vi.fn().mockResolvedValue({
        removed: true,
        removed_secret: {
          secret_id: "mcp_secret_notion",
        },
      }),
    };

    const output = await captureCliRun(["remove-mcp-secret", "mcp_secret_notion"], client);

    expect(client.removeMcpSecret).toHaveBeenCalledWith("mcp_secret_notion");
    expect(output.stdout).toContain("Removed MCP secret mcp_secret_notion");
  });

  it("runs the candidate resolution and trust-decision commands end to end", async () => {
    const client = {
      resolveMcpServerCandidate: vi.fn().mockResolvedValue({
        candidate: {
          candidate_id: "mcpcand_123",
          source_kind: "user_input",
          raw_endpoint: "https://api.example.com/mcp",
          transport_hint: "streamable_http",
          workspace_id: null,
          submitted_by_session_id: "sess_cli",
          submitted_by_run_id: null,
          notes: null,
          resolution_state: "resolved",
          resolution_error: null,
          submitted_at: "2026-04-01T12:00:00.000Z",
          updated_at: "2026-04-01T12:05:00.000Z",
        },
        profile: {
          server_profile_id: "mcpprof_123",
          candidate_id: "mcpcand_123",
          display_name: "Example MCP",
          transport: "streamable_http",
          canonical_endpoint: "https://api.example.com/mcp",
          network_scope: "public_https",
          trust_tier: "operator_approved_public",
          status: "draft",
          drift_state: "clean",
          quarantine_reason_codes: [],
          allowed_execution_modes: ["local_proxy"],
          active_trust_decision_id: null,
          auth_descriptor: {
            mode: "none",
            audience: null,
            scope_labels: [],
          },
          identity_baseline: {
            canonical_host: "api.example.com",
            canonical_port: 443,
            tls_identity_summary: null,
            auth_issuer: null,
            publisher_identity: null,
            tool_inventory_hash: "hash_tools",
            fetched_at: "2026-04-01T12:05:00.000Z",
          },
          tool_inventory_version: "hash_tools",
          last_resolved_at: "2026-04-01T12:05:00.000Z",
          created_at: "2026-04-01T12:05:00.000Z",
          updated_at: "2026-04-01T12:05:00.000Z",
        },
        created_profile: true,
        drift_detected: false,
      }),
      approveMcpServerProfile: vi.fn().mockResolvedValue({
        profile: {
          server_profile_id: "mcpprof_123",
          status: "pending_approval",
        },
        trust_decision: {
          trust_decision_id: "mcptrust_123",
          decision: "allow_policy_managed",
        },
      }),
      listMcpServerTrustDecisions: vi.fn().mockResolvedValue({
        trust_decisions: [
          {
            trust_decision_id: "mcptrust_123",
            server_profile_id: "mcpprof_123",
            decision: "allow_policy_managed",
            trust_tier: "operator_approved_public",
            allowed_execution_modes: ["local_proxy"],
            max_side_effect_level_without_approval: "read_only",
            reason_codes: ["INITIAL_REVIEW_COMPLETE"],
            approved_by_session_id: "sess_cli",
            approved_at: "2026-04-01T12:05:00.000Z",
            valid_until: null,
            reapproval_triggers: [],
          },
        ],
      }),
    };

    const resolveOutput = await captureCliRun(
      [
        "resolve-mcp-server-candidate",
        JSON.stringify({
          candidate_id: "mcpcand_123",
          display_name: "Example MCP",
        }),
      ],
      client,
    );
    expect(client.resolveMcpServerCandidate).toHaveBeenCalledWith({
      candidate_id: "mcpcand_123",
      display_name: "Example MCP",
    });
    expect(resolveOutput.stdout).toContain("Resolved MCP server candidate mcpcand_123");
    expect(resolveOutput.stdout).toContain("Profile: mcpprof_123");

    const approveOutput = await captureCliRun(
      [
        "approve-mcp-server-profile",
        JSON.stringify({
          server_profile_id: "mcpprof_123",
          decision: "allow_policy_managed",
          trust_tier: "operator_approved_public",
          allowed_execution_modes: ["local_proxy"],
          reason_codes: ["INITIAL_REVIEW_COMPLETE"],
        }),
      ],
      client,
    );
    expect(client.approveMcpServerProfile).toHaveBeenCalledWith({
      server_profile_id: "mcpprof_123",
      decision: "allow_policy_managed",
      trust_tier: "operator_approved_public",
      allowed_execution_modes: ["local_proxy"],
      reason_codes: ["INITIAL_REVIEW_COMPLETE"],
    });
    expect(approveOutput.stdout).toContain("Recorded MCP profile trust decision mcptrust_123");

    const decisionsOutput = await captureCliRun(["list-mcp-server-trust-decisions", "mcpprof_123"], client);
    expect(client.listMcpServerTrustDecisions).toHaveBeenCalledWith("mcpprof_123");
    expect(decisionsOutput.stdout).toContain("MCP server trust decisions");
    expect(decisionsOutput.stdout).toContain("mcptrust_123 [allow_policy_managed]");
  });

  it("runs the credential binding commands end to end", async () => {
    const client = {
      listMcpServerCredentialBindings: vi.fn().mockResolvedValue({
        credential_bindings: [
          {
            credential_binding_id: "mcpbind_123",
            server_profile_id: "mcpprof_123",
            binding_mode: "bearer_secret_ref",
            broker_profile_id: "mcp_secret_123",
            scope_labels: ["remote:mcp"],
            audience: null,
            status: "active",
            created_at: "2026-04-01T12:05:00.000Z",
            updated_at: "2026-04-01T12:05:00.000Z",
            revoked_at: null,
          },
        ],
      }),
      bindMcpServerCredentials: vi.fn().mockResolvedValue({
        profile: {
          server_profile_id: "mcpprof_123",
        },
        credential_binding: {
          credential_binding_id: "mcpbind_123",
          binding_mode: "bearer_secret_ref",
          status: "active",
        },
      }),
      revokeMcpServerCredentials: vi.fn().mockResolvedValue({
        profile: {
          server_profile_id: "mcpprof_123",
        },
        credential_binding: {
          credential_binding_id: "mcpbind_123",
          server_profile_id: "mcpprof_123",
          status: "revoked",
        },
      }),
    };

    const listOutput = await captureCliRun(["list-mcp-server-credential-bindings", "mcpprof_123"], client);
    expect(client.listMcpServerCredentialBindings).toHaveBeenCalledWith("mcpprof_123");
    expect(listOutput.stdout).toContain("MCP server credential bindings");

    const bindOutput = await captureCliRun(
      [
        "bind-mcp-server-credentials",
        JSON.stringify({
          server_profile_id: "mcpprof_123",
          binding_mode: "bearer_secret_ref",
          broker_profile_id: "mcp_secret_123",
          scope_labels: ["remote:mcp"],
        }),
      ],
      client,
    );
    expect(client.bindMcpServerCredentials).toHaveBeenCalledWith({
      server_profile_id: "mcpprof_123",
      binding_mode: "bearer_secret_ref",
      broker_profile_id: "mcp_secret_123",
      scope_labels: ["remote:mcp"],
    });
    expect(bindOutput.stdout).toContain("Bound MCP server credentials mcpbind_123");

    const revokeOutput = await captureCliRun(["revoke-mcp-server-credentials", "mcpbind_123"], client);
    expect(client.revokeMcpServerCredentials).toHaveBeenCalledWith("mcpbind_123");
    expect(revokeOutput.stdout).toContain("Revoked MCP server credentials mcpbind_123");
  });

  it("runs the activate, quarantine, and revoke profile commands end to end", async () => {
    const client = {
      activateMcpServerProfile: vi.fn().mockResolvedValue({
        profile: {
          server_profile_id: "mcpprof_123",
          status: "active",
        },
      }),
      quarantineMcpServerProfile: vi.fn().mockResolvedValue({
        profile: {
          server_profile_id: "mcpprof_123",
          status: "quarantined",
          quarantine_reason_codes: ["MANUAL_REVIEW_HOLD"],
        },
      }),
      revokeMcpServerProfile: vi.fn().mockResolvedValue({
        profile: {
          server_profile_id: "mcpprof_123",
          status: "revoked",
          quarantine_reason_codes: ["MANUAL_REVOKE"],
        },
      }),
    };

    const activateOutput = await captureCliRun(["activate-mcp-server-profile", "mcpprof_123"], client);
    expect(client.activateMcpServerProfile).toHaveBeenCalledWith("mcpprof_123");
    expect(activateOutput.stdout).toContain("Activated MCP server profile mcpprof_123");

    const quarantineOutput = await captureCliRun(
      [
        "quarantine-mcp-server-profile",
        JSON.stringify({
          server_profile_id: "mcpprof_123",
          reason_codes: ["MANUAL_REVIEW_HOLD"],
        }),
      ],
      client,
    );
    expect(client.quarantineMcpServerProfile).toHaveBeenCalledWith({
      server_profile_id: "mcpprof_123",
      reason_codes: ["MANUAL_REVIEW_HOLD"],
    });
    expect(quarantineOutput.stdout).toContain("Quarantined MCP server profile mcpprof_123");

    const revokeOutput = await captureCliRun(
      [
        "revoke-mcp-server-profile",
        JSON.stringify({
          server_profile_id: "mcpprof_123",
          reason_codes: ["MANUAL_REVOKE"],
        }),
      ],
      client,
    );
    expect(client.revokeMcpServerProfile).toHaveBeenCalledWith({
      server_profile_id: "mcpprof_123",
      reason_codes: ["MANUAL_REVOKE"],
    });
    expect(revokeOutput.stdout).toContain("Revoked MCP server profile mcpprof_123");
  });

  it("runs the submit-mcp-tool command end to end", async () => {
    const client = {
      submitActionAttempt: vi.fn().mockResolvedValue({
        action: {
          action_id: "act_mcp_cli",
          operation: {
            display_name: "Call MCP tool notes_stdio/echo_note",
            name: "mcp.notes_stdio.echo_note",
            domain: "mcp",
          },
          target: {
            primary: {
              locator: "mcp://server/notes_stdio/tools/echo_note",
            },
          },
          actor: {
            tool_name: "mcp_call_tool",
            tool_kind: "mcp",
          },
          risk_hints: {
            side_effect_level: "read_only",
          },
        },
        policy_outcome: {
          decision: "allow",
          reasons: [],
        },
        approval_request: null,
        snapshot_record: null,
        execution_result: {
          mode: "executed",
          success: true,
          execution_id: "exec_mcp_cli",
          output: {
            server_id: "notes_stdio",
            tool_name: "echo_note",
            summary: "echo:launch blocker",
          },
        },
      }),
    };

    const output = await captureCliRun(
      ["submit-mcp-tool", "run_cli", "notes_stdio", "echo_note", '{"note":"launch blocker"}'],
      client,
    );

    expect(client.submitActionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        run_id: "run_cli",
        tool_registration: {
          tool_name: "mcp_call_tool",
          tool_kind: "mcp",
        },
        raw_call: {
          server_id: "notes_stdio",
          tool_name: "echo_note",
          arguments: {
            note: "launch blocker",
          },
        },
      }),
    );
    expect(output.stdout).toContain("Operation: Call MCP tool notes_stdio/echo_note");
    expect(output.stdout).toContain("Execution: executed successfully (exec_mcp_cli)");
  });

  it("runs the submit-mcp-profile-tool command end to end", async () => {
    const client = {
      submitActionAttempt: vi.fn().mockResolvedValue({
        action: {
          action_id: "act_mcp_profile_cli",
          operation: {
            display_name: "Call MCP tool mcpprof_123/echo_note",
            name: "mcp.mcpprof_123.echo_note",
            domain: "mcp",
          },
          target: {
            primary: {
              locator: "mcp://server/mcpprof_123/tools/echo_note",
            },
          },
          actor: {
            tool_name: "mcp_call_tool",
            tool_kind: "mcp",
          },
          risk_hints: {
            side_effect_level: "read_only",
          },
        },
        policy_outcome: {
          decision: "allow",
          reasons: [],
        },
        approval_request: null,
        snapshot_record: null,
        execution_result: {
          mode: "executed",
          success: true,
          execution_id: "exec_mcp_profile_cli",
          output: {
            server_id: "mcpprof_123",
            tool_name: "echo_note",
            summary: "http-echo:phase2",
          },
        },
      }),
    };

    const output = await captureCliRun(
      ["submit-mcp-profile-tool", "run_cli", "mcpprof_123", "echo_note", '{"note":"phase2"}'],
      client,
    );

    expect(client.submitActionAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        run_id: "run_cli",
        raw_call: {
          server_id: "mcpprof_123",
          server_profile_id: "mcpprof_123",
          tool_name: "echo_note",
          arguments: {
            note: "phase2",
          },
        },
      }),
    );
    expect(output.stdout).toContain("Operation: Call MCP tool mcpprof_123/echo_note");
  });

  it("runs the artifact-export command end to end without requesting truncated content", async () => {
    const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cli-export-unit-"));
    const destinationPath = path.join(exportRoot, "artifact.txt");
    const client = {
      queryArtifact: vi.fn().mockResolvedValue({
        artifact: {
          artifact_id: "artifact_stdout_1",
          run_id: "run_cli",
          action_id: "act_cli",
          execution_id: "exec_cli",
          type: "stdout",
          content_ref: "artifact://stdout/1",
          byte_size: 18,
          integrity: {
            schema_version: "artifact-integrity.v1",
            digest_algorithm: "sha256",
            digest: "deadbeef",
          },
          visibility: "internal",
          expires_at: null,
          expired_at: null,
          created_at: "2026-03-31T13:00:00.000Z",
        },
        artifact_status: "available",
        visibility_scope: "internal",
        content_available: true,
        content: "full artifact body",
        content_truncated: false,
        returned_chars: 18,
        max_inline_chars: 8192,
      }),
    };

    try {
      const output = await captureCliRun(["artifact-export", "artifact_stdout_1", destinationPath, "internal"], client);

      expect(client.queryArtifact).toHaveBeenCalledWith("artifact_stdout_1", "internal", {
        fullContent: true,
      });
      expect(fs.readFileSync(destinationPath, "utf8")).toBe("full artifact body");
      expect(output.stdout).toContain("Exported artifact artifact_stdout_1");
      expect(output.stdout).toContain(`Output path: ${destinationPath}`);
    } finally {
      fs.rmSync(exportRoot, { recursive: true, force: true });
    }
  });

  it("runs the run-audit-export command end to end and writes a complete audit bundle", async () => {
    const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cli-audit-unit-"));
    const outputDir = path.join(exportRoot, "bundle");
    const client = {
      getRunSummary: vi.fn().mockResolvedValue({
        run: {
          ...makeTimelineResult([]).run_summary,
          run_id: "run_cli",
        },
      }),
      queryTimeline: vi.fn().mockResolvedValue({
        ...makeTimelineResult([
          makeStep({
            primary_artifacts: [
              {
                type: "stdout",
                artifact_id: "artifact_stdout_1",
                artifact_status: "available",
              },
            ],
          }),
        ]),
        visibility_scope: "internal",
      }),
      listApprovals: vi.fn().mockResolvedValue({
        approvals: [],
      }),
      queryApprovalInbox: vi.fn().mockResolvedValue({
        counts: {
          pending: 0,
          approved: 0,
          denied: 0,
        },
        items: [],
      }),
      diagnostics: vi.fn().mockResolvedValue({
        daemon_health: {
          status: "healthy",
          active_sessions: 1,
          active_runs: 1,
          primary_reason: null,
          warnings: [],
        },
        policy_summary: null,
      }),
      queryArtifact: vi.fn().mockResolvedValue({
        artifact: {
          artifact_id: "artifact_stdout_1",
          run_id: "run_cli",
          action_id: "act_cli",
          execution_id: "exec_cli",
          type: "stdout",
          content_ref: "artifact://stdout/1",
          byte_size: 18,
          integrity: {
            schema_version: "artifact-integrity.v1",
            digest_algorithm: "sha256",
            digest: "deadbeef",
          },
          visibility: "internal",
          expires_at: null,
          expired_at: null,
          created_at: "2026-03-31T13:00:00.000Z",
        },
        artifact_status: "available",
        visibility_scope: "internal",
        content_available: true,
        content: "audit artifact body",
        content_truncated: false,
        returned_chars: 19,
        max_inline_chars: 8192,
      }),
    };

    try {
      const output = await captureCliRun(["run-audit-export", "run_cli", outputDir, "internal"], client);

      expect(client.getRunSummary).toHaveBeenCalledWith("run_cli");
      expect(client.queryTimeline).toHaveBeenCalledWith("run_cli", "internal");
      expect(client.listApprovals).toHaveBeenCalledWith({ run_id: "run_cli" });
      expect(client.queryApprovalInbox).toHaveBeenCalledWith({ run_id: "run_cli" });
      expect(client.queryArtifact).toHaveBeenCalledWith("artifact_stdout_1", "internal", {
        fullContent: true,
      });
      expect(fs.existsSync(path.join(outputDir, "manifest.json"))).toBe(true);
      expect(fs.existsSync(path.join(outputDir, "timeline.txt"))).toBe(true);
      expect(fs.readFileSync(path.join(outputDir, "artifacts", "artifact_stdout_1.stdout.txt"), "utf8")).toBe(
        "audit artifact body",
      );
      expect(output.stdout).toContain("Exported run audit bundle for run_cli");
      expect(output.stdout).toContain("Artifacts exported: 1");
    } finally {
      fs.rmSync(exportRoot, { recursive: true, force: true });
    }
  });

  it("runs the run-audit-verify command end to end and detects tampering", async () => {
    const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cli-audit-verify-unit-"));
    const outputDir = path.join(exportRoot, "bundle");
    const artifactDir = path.join(outputDir, "artifacts");
    const artifactPath = path.join(artifactDir, "artifact_stdout_1.stdout.txt");
    const artifactContent = "audit artifact body";
    const artifactSha256 = createHash("sha256").update(artifactContent).digest("hex");

    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, "run-summary.json"), "{}", "utf8");
    fs.writeFileSync(path.join(outputDir, "run-summary.txt"), "summary", "utf8");
    fs.writeFileSync(path.join(outputDir, "timeline.json"), "{}", "utf8");
    fs.writeFileSync(path.join(outputDir, "timeline.txt"), "timeline", "utf8");
    fs.writeFileSync(path.join(outputDir, "approvals.json"), "{}", "utf8");
    fs.writeFileSync(path.join(outputDir, "approvals.txt"), "approvals", "utf8");
    fs.writeFileSync(path.join(outputDir, "approval-inbox.json"), "{}", "utf8");
    fs.writeFileSync(path.join(outputDir, "approval-inbox.txt"), "inbox", "utf8");
    fs.writeFileSync(path.join(outputDir, "diagnostics.json"), "{}", "utf8");
    fs.writeFileSync(path.join(outputDir, "diagnostics.txt"), "diagnostics", "utf8");
    fs.writeFileSync(artifactPath, artifactContent, "utf8");
    fs.writeFileSync(
      path.join(outputDir, "manifest.json"),
      JSON.stringify(
        {
          run_id: "run_cli",
          output_dir: outputDir,
          visibility_scope: "internal",
          exported_at: "2026-04-01T00:00:00.000Z",
          files_written: [],
          exported_artifacts: [
            {
              artifact_id: "artifact_stdout_1",
              type: "stdout",
              output_path: artifactPath,
              relative_path: path.join("artifacts", "artifact_stdout_1.stdout.txt"),
              bytes_written: Buffer.byteLength(artifactContent, "utf8"),
              visibility_scope: "internal",
              sha256: artifactSha256,
              integrity_digest: artifactSha256,
            },
          ],
          skipped_artifacts: [],
          counts: {
            timeline_steps: 1,
            approvals: 0,
            approval_inbox_items: 0,
            exported_artifacts: 1,
            skipped_artifacts: 0,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    try {
      const verifiedOutput = await captureCliRun(["run-audit-verify", outputDir], {});
      expect(verifiedOutput.stderr).toBe("");
      expect(verifiedOutput.stdout).toContain("Verified run audit bundle for run_cli");
      expect(verifiedOutput.stdout).toContain("Audit bundle verified: yes");

      fs.writeFileSync(artifactPath, "tampered", "utf8");

      const tamperedOutput = await captureCliRun(["run-audit-verify", outputDir], {});
      expect(tamperedOutput.stderr).toBe("");
      expect(tamperedOutput.stdout).toContain("Audit bundle verified: no");
      expect(tamperedOutput.stdout).toContain("ARTIFACT_SHA256_MISMATCH");
      expect(tamperedOutput.stdout).toContain("ARTIFACT_INTEGRITY_MISMATCH");
    } finally {
      fs.rmSync(exportRoot, { recursive: true, force: true });
    }
  });

  it("runs the run-audit-report command and summarizes a verified bundle", async () => {
    const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cli-audit-report-unit-"));
    const outputDir = path.join(exportRoot, "bundle");
    const artifactDir = path.join(outputDir, "artifacts");
    const artifactPath = path.join(artifactDir, "artifact_stdout_1.stdout.txt");
    const artifactContent = "audit artifact body";
    const artifactSha256 = createHash("sha256").update(artifactContent).digest("hex");

    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, "run-summary.json"),
      JSON.stringify(
        {
          run: {
            ...makeTimelineResult([]).run_summary,
            run_id: "run_cli",
            action_count: 1,
            approval_count: 0,
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    fs.writeFileSync(path.join(outputDir, "run-summary.txt"), "summary", "utf8");
    fs.writeFileSync(
      path.join(outputDir, "timeline.json"),
      JSON.stringify(
        {
          ...makeTimelineResult([
            makeStep({
              primary_artifacts: [
                {
                  type: "stdout",
                  artifact_id: "artifact_stdout_1",
                  artifact_status: "available",
                },
              ],
              reversibility_class: "reversible",
              external_effects: ["network"],
            }),
          ]),
          visibility_scope: "internal",
        },
        null,
        2,
      ),
      "utf8",
    );
    fs.writeFileSync(path.join(outputDir, "timeline.txt"), "timeline", "utf8");
    fs.writeFileSync(path.join(outputDir, "approvals.json"), JSON.stringify({ approvals: [] }, null, 2), "utf8");
    fs.writeFileSync(path.join(outputDir, "approvals.txt"), "approvals", "utf8");
    fs.writeFileSync(
      path.join(outputDir, "approval-inbox.json"),
      JSON.stringify({ counts: { pending: 0, approved: 0, denied: 0 }, items: [] }, null, 2),
      "utf8",
    );
    fs.writeFileSync(path.join(outputDir, "approval-inbox.txt"), "inbox", "utf8");
    fs.writeFileSync(
      path.join(outputDir, "diagnostics.json"),
      JSON.stringify({ daemon_health: { status: "healthy" } }, null, 2),
      "utf8",
    );
    fs.writeFileSync(path.join(outputDir, "diagnostics.txt"), "diagnostics", "utf8");
    fs.writeFileSync(artifactPath, artifactContent, "utf8");
    fs.writeFileSync(
      path.join(outputDir, "manifest.json"),
      JSON.stringify(
        {
          manifest_version: "agentgit.run-audit-bundle.v2",
          run_id: "run_cli",
          output_dir: outputDir,
          visibility_scope: "internal",
          exported_at: "2026-04-01T00:00:00.000Z",
          files_written: [],
          exported_artifacts: [
            {
              artifact_id: "artifact_stdout_1",
              type: "stdout",
              output_path: artifactPath,
              relative_path: path.join("artifacts", "artifact_stdout_1.stdout.txt"),
              bytes_written: Buffer.byteLength(artifactContent, "utf8"),
              visibility_scope: "internal",
              sha256: artifactSha256,
              integrity_digest: artifactSha256,
            },
          ],
          skipped_artifacts: [],
        },
        null,
        2,
      ),
      "utf8",
    );

    try {
      const output = await captureCliRun(["run-audit-report", outputDir], {});
      expect(output.stderr).toBe("");
      expect(output.stdout).toContain("Audit report for run_cli");
      expect(output.stdout).toContain("Verified: yes");
      expect(output.stdout).toContain("Artifacts exported: 1");
      expect(output.stdout).toContain("External-effect steps: 1");
    } finally {
      fs.rmSync(exportRoot, { recursive: true, force: true });
    }
  });

  it("runs the run-audit-compare command and reports bundle differences", async () => {
    const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cli-audit-compare-unit-"));
    const leftDir = path.join(exportRoot, "left");
    const rightDir = path.join(exportRoot, "right");
    const makeBundle = (dir: string, runId: string, artifactContent: string, actionCount: number) => {
      const artifactDir = path.join(dir, "artifacts");
      const artifactPath = path.join(artifactDir, "artifact_stdout_1.stdout.txt");
      const artifactSha256 = createHash("sha256").update(artifactContent).digest("hex");
      fs.mkdirSync(artifactDir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "run-summary.json"),
        JSON.stringify(
          {
            run: {
              ...makeTimelineResult([]).run_summary,
              run_id: runId,
              action_count: actionCount,
              approval_count: 0,
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      fs.writeFileSync(path.join(dir, "run-summary.txt"), "summary", "utf8");
      fs.writeFileSync(
        path.join(dir, "timeline.json"),
        JSON.stringify(
          {
            ...makeTimelineResult(
              Array.from({ length: actionCount }, (_, index) => makeStep({ step_id: `step_${index + 1}` })),
            ),
            visibility_scope: "internal",
          },
          null,
          2,
        ),
        "utf8",
      );
      fs.writeFileSync(path.join(dir, "timeline.txt"), "timeline", "utf8");
      fs.writeFileSync(path.join(dir, "approvals.json"), JSON.stringify({ approvals: [] }, null, 2), "utf8");
      fs.writeFileSync(path.join(dir, "approvals.txt"), "approvals", "utf8");
      fs.writeFileSync(
        path.join(dir, "approval-inbox.json"),
        JSON.stringify({ counts: { pending: 0, approved: 0, denied: 0 }, items: [] }, null, 2),
        "utf8",
      );
      fs.writeFileSync(path.join(dir, "approval-inbox.txt"), "inbox", "utf8");
      fs.writeFileSync(
        path.join(dir, "diagnostics.json"),
        JSON.stringify({ daemon_health: { status: "healthy", marker: artifactContent } }, null, 2),
        "utf8",
      );
      fs.writeFileSync(path.join(dir, "diagnostics.txt"), "diagnostics", "utf8");
      fs.writeFileSync(artifactPath, artifactContent, "utf8");
      fs.writeFileSync(
        path.join(dir, "manifest.json"),
        JSON.stringify(
          {
            manifest_version: "agentgit.run-audit-bundle.v2",
            run_id: runId,
            output_dir: dir,
            visibility_scope: "internal",
            exported_at: "2026-04-01T00:00:00.000Z",
            files_written: [],
            exported_artifacts: [
              {
                artifact_id: "artifact_stdout_1",
                type: "stdout",
                output_path: artifactPath,
                relative_path: path.join("artifacts", "artifact_stdout_1.stdout.txt"),
                bytes_written: Buffer.byteLength(artifactContent, "utf8"),
                visibility_scope: "internal",
                sha256: artifactSha256,
                integrity_digest: artifactSha256,
              },
            ],
            skipped_artifacts: [],
          },
          null,
          2,
        ),
        "utf8",
      );
    };

    makeBundle(leftDir, "run_left", "left artifact", 1);
    makeBundle(rightDir, "run_right", "right artifact", 2);

    try {
      const output = await captureCliRun(["run-audit-compare", leftDir, rightDir], {});
      expect(output.stderr).toBe("");
      expect(output.stdout).toContain("Compared audit bundles run_left -> run_right");
      expect(output.stdout).toContain("RUN_ID_CHANGED");
      expect(output.stdout).toContain("ACTION_COUNT_CHANGED");
      expect(output.stdout).toContain("EXPORTED_ARTIFACT_DIGEST_CHANGED");
      expect(output.stdout).toContain("DIAGNOSTICS_CHANGED");
    } finally {
      fs.rmSync(exportRoot, { recursive: true, force: true });
    }
  });

  it("runs the run-audit-share command and withholds artifact content by default", async () => {
    const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cli-audit-share-unit-"));
    const bundleDir = path.join(exportRoot, "bundle");
    const shareDir = path.join(exportRoot, "share");
    const artifactDir = path.join(bundleDir, "artifacts");
    const artifactPath = path.join(artifactDir, "artifact_stdout_1.stdout.txt");
    const artifactContent = "audit artifact body";
    const artifactSha256 = createHash("sha256").update(artifactContent).digest("hex");

    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(
      path.join(bundleDir, "run-summary.json"),
      JSON.stringify(
        {
          run: {
            ...makeTimelineResult([]).run_summary,
            run_id: "run_cli",
            action_count: 1,
            approval_count: 0,
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    fs.writeFileSync(path.join(bundleDir, "run-summary.txt"), "summary", "utf8");
    fs.writeFileSync(
      path.join(bundleDir, "timeline.json"),
      JSON.stringify({ ...makeTimelineResult([]), visibility_scope: "internal" }, null, 2),
      "utf8",
    );
    fs.writeFileSync(path.join(bundleDir, "timeline.txt"), "timeline", "utf8");
    fs.writeFileSync(path.join(bundleDir, "approvals.json"), JSON.stringify({ approvals: [] }, null, 2), "utf8");
    fs.writeFileSync(path.join(bundleDir, "approvals.txt"), "approvals", "utf8");
    fs.writeFileSync(
      path.join(bundleDir, "approval-inbox.json"),
      JSON.stringify({ counts: { pending: 0, approved: 0, denied: 0 }, items: [] }, null, 2),
      "utf8",
    );
    fs.writeFileSync(path.join(bundleDir, "approval-inbox.txt"), "inbox", "utf8");
    fs.writeFileSync(
      path.join(bundleDir, "diagnostics.json"),
      JSON.stringify({ daemon_health: { status: "healthy" } }, null, 2),
      "utf8",
    );
    fs.writeFileSync(path.join(bundleDir, "diagnostics.txt"), "diagnostics", "utf8");
    fs.writeFileSync(artifactPath, artifactContent, "utf8");
    fs.writeFileSync(
      path.join(bundleDir, "manifest.json"),
      JSON.stringify(
        {
          manifest_version: "agentgit.run-audit-bundle.v2",
          run_id: "run_cli",
          output_dir: bundleDir,
          visibility_scope: "internal",
          exported_at: "2026-04-01T00:00:00.000Z",
          files_written: [],
          exported_artifacts: [
            {
              artifact_id: "artifact_stdout_1",
              type: "stdout",
              output_path: artifactPath,
              relative_path: path.join("artifacts", "artifact_stdout_1.stdout.txt"),
              bytes_written: Buffer.byteLength(artifactContent, "utf8"),
              visibility_scope: "internal",
              sha256: artifactSha256,
              integrity_digest: artifactSha256,
            },
          ],
          skipped_artifacts: [],
        },
        null,
        2,
      ),
      "utf8",
    );

    try {
      const output = await captureCliRun(["run-audit-share", bundleDir, shareDir], {});
      expect(output.stderr).toBe("");
      expect(output.stdout).toContain("Created audit share package for run_cli");
      expect(output.stdout).toContain("Artifacts copied: 0");
      expect(output.stdout).toContain("Artifacts withheld: 1");
      expect(fs.existsSync(path.join(shareDir, "share-manifest.json"))).toBe(true);
      expect(fs.existsSync(path.join(shareDir, "run-summary.json"))).toBe(true);
      expect(fs.existsSync(path.join(shareDir, "artifacts", "artifact_stdout_1.stdout.txt"))).toBe(false);
      const shareManifest = JSON.parse(fs.readFileSync(path.join(shareDir, "share-manifest.json"), "utf8")) as {
        include_artifact_content: boolean;
        withheld_artifacts: Array<{ artifact_id: string; reason: string }>;
      };
      expect(shareManifest.include_artifact_content).toBe(false);
      expect(shareManifest.withheld_artifacts).toContainEqual(
        expect.objectContaining({
          artifact_id: "artifact_stdout_1",
          reason: "artifact content omitted from share package",
        }),
      );
    } finally {
      fs.rmSync(exportRoot, { recursive: true, force: true });
    }
  });
});
