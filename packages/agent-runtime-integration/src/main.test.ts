import { describe, expect, it } from "vitest";

import { formatInspectResult, formatRestoreResult, formatRunResult, formatSetupResult } from "./main.js";

describe("product CLI formatting", () => {
  it("formats setup output with honest attached assurance language", () => {
    const output = formatSetupResult({
      action: "setup",
      runtime: "Custom agent command",
      workspace_root: "/tmp/workspace",
      assurance_level: "attached",
      assurance_ceiling: "attached",
      governance_mode: "attached_live",
      guarantees: ["known_shell_entrypoints_governed"],
      default_checkpoint_policy: "never",
      checkpoint_intent: null,
      checkpoint_reason_template: null,
      governed_surfaces: ["governed shell launch boundary"],
      degraded_reasons: [],
      changed: true,
      next_command: "agentgit run",
      health_checks: [
        {
          label: "governed launch assets",
          ok: true,
          detail: "AgentGit saved the command and generated governed shell shims for agentgit run.",
        },
      ],
      preserved_user_changes: [],
    });

    expect(output).toContain("Assurance level: attached");
    expect(output).toContain("Assurance: AgentGit is governing supported launch surfaces.");
    expect(output).toContain("Governance mode: attached live launch");
    expect(output).toContain("Guarantees: supported shell entrypoints governed");
  });

  it("formats inspect output with an exact restore command", () => {
    const output = formatInspectResult({
      workspace_root: "/tmp/workspace",
      governed_workspace_root: "/tmp/workspace",
      run_id: "run_123",
      found: true,
      assurance_level: "attached",
      governance_mode: "attached_live",
      guarantees: ["known_shell_entrypoints_governed"],
      default_checkpoint_policy: "never",
      checkpoint_intent: null,
      checkpoint_reason_template: null,
      latest_explicit_checkpoint: null,
      latest_automatic_checkpoint: null,
      restore_vs_checkpoint: null,
      summary: "AgentGit observed a dangerous delete.",
      action_title: "Delete file",
      action_status: "completed",
      changed_paths: ["/tmp/workspace/important-plan.md"],
      restore_available: true,
      restore_command: 'agentgit restore --path "/tmp/workspace/important-plan.md"',
      restore_boundary: "targeted path restore",
      restore_guidance: "AgentGit can safely target the recorded changed path without widening the restore scope.",
      degraded_reasons: [],
    });

    expect(output).toContain("Latest notable governed run");
    expect(output).toContain("Assurance level: attached");
    expect(output).toContain("Governance mode: attached live launch");
    expect(output).toContain("Restore boundary: targeted path restore");
    expect(output).toContain(
      "Restore guidance: AgentGit can safely target the recorded changed path without widening the restore scope.",
    );
    expect(output).toContain('Next restore command: agentgit restore --path "/tmp/workspace/important-plan.md"');
  });

  it("formats contained setup output with explicit network and credential truth", () => {
    const output = formatSetupResult({
      action: "setup",
      runtime: "Custom agent command",
      workspace_root: "/tmp/workspace",
      assurance_level: "contained",
      assurance_ceiling: "contained",
      governance_mode: "contained_projection",
      guarantees: ["real_workspace_protected", "publish_path_governed"],
      default_checkpoint_policy: "risky_runs",
      checkpoint_intent: "broad_risk_default",
      checkpoint_reason_template: "Checkpoint before risky contained runs.",
      governed_surfaces: ["contained runtime boundary", "governed publication boundary"],
      degraded_reasons: ["Container network egress is not restricted."],
      changed: true,
      next_command: "agentgit run",
      health_checks: [],
      preserved_user_changes: [],
      contained_details: {
        backend: "docker",
        network_policy: "inherit",
        egress_mode: "inherit",
        egress_assurance: "degraded",
        credential_mode: "direct_env",
        credential_env_keys: ["OPENAI_API_KEY"],
        credential_file_paths: [],
        egress_allowlist_hosts: [],
        capability_snapshot: {
          backend_kind: "docker",
          capability_version: 1,
          docker_available: true,
          docker_desktop_vm: true,
          rootless_docker: false,
          projection_enforced: true,
          read_only_rootfs_enabled: true,
          network_restricted: false,
          credential_brokering_enabled: false,
          egress_mode: "inherit",
          egress_assurance: "degraded",
          backend_enforced_allowlist_supported: false,
          raw_socket_egress_blocked: false,
          server_platform: "Docker Desktop 4.63.0 (177762)",
          server_os: "linux",
          server_arch: "aarch64",
        },
      },
    });

    expect(output).toContain("Assurance level: contained");
    expect(output).toContain("Checkpoint default: risky-runs");
    expect(output).toContain("Contained backend: docker");
    expect(output).toContain("Contained network policy: inherit");
    expect(output).toContain("Contained egress mode: inherit");
    expect(output).toContain("Contained egress assurance: degraded");
    expect(output).toContain("Contained credentials: direct host env allowlist (OPENAI_API_KEY)");
    expect(output).toContain("Governance mode: contained projection");
    expect(output).toContain("Guarantees: real workspace protected, publish-back path governed");
    expect(output).toContain(
      "Contained capabilities: projected workspace enforced, read-only rootfs, network inherited, egress mode inherit, egress assurance degraded, credential brokering not enabled, no proxy allowlist, backend-enforced allowlists unsupported, raw socket egress not blocked, Docker Desktop VM [Docker Desktop 4.63.0 (177762) / linux / aarch64]",
    );
  });

  it("formats contained inspect output with brokered runtime bindings", () => {
    const output = formatInspectResult({
      workspace_root: "/tmp/workspace",
      governed_workspace_root: "/tmp/workspace",
      run_id: "run_123",
      found: true,
      assurance_level: "contained",
      governance_mode: "contained_projection",
      guarantees: [
        "real_workspace_protected",
        "publish_path_governed",
        "brokered_credentials_only",
        "egress_policy_applied",
      ],
      default_checkpoint_policy: "always_before_run",
      checkpoint_intent: "operator_requested",
      checkpoint_reason_template: "Checkpoint before every contained run.",
      latest_explicit_checkpoint: null,
      latest_automatic_checkpoint: {
        checkpoint_id: "cp_123",
        workspace_root: "/tmp/workspace",
        governed_workspace_root: "/tmp/workspace",
        run_id: "run_123",
        run_checkpoint: "run_123#3",
        snapshot_id: "snap_123",
        sequence: 3,
        checkpoint_kind: "branch_point",
        trigger: "default_policy",
        checkpoint_policy: "always_before_run",
        checkpoint_intent: "operator_requested",
        reason: "Checkpoint before every contained run.",
        schema_version: 11,
        created_at: "2026-04-03T00:00:00.000Z",
        updated_at: "2026-04-03T00:00:00.000Z",
      },
      restore_vs_checkpoint: "Recommended restore target is narrower than the latest checkpoint boundary.",
      summary: "AgentGit published a contained workspace change.",
      action_title: "Delete file",
      action_status: "completed",
      changed_paths: ["/tmp/workspace/important-plan.md"],
      restore_available: true,
      restore_command: "agentgit restore --contained-run-id crun_123",
      restore_boundary: "contained projection discard",
      restore_guidance:
        "AgentGit can discard unpublished projected changes directly because they have not been applied to the real workspace.",
      degraded_reasons: [],
      contained_details: {
        backend: "docker",
        network_policy: "none",
        egress_mode: "none",
        egress_assurance: "boundary_enforced",
        credential_mode: "brokered_bindings",
        credential_env_keys: ["OPENAI_API_KEY"],
        credential_file_paths: ["/run/agentgit-secrets/openai.key"],
        egress_allowlist_hosts: [],
        capability_snapshot: {
          backend_kind: "docker",
          capability_version: 1,
          docker_available: true,
          docker_desktop_vm: false,
          rootless_docker: true,
          projection_enforced: true,
          read_only_rootfs_enabled: true,
          network_restricted: true,
          credential_brokering_enabled: true,
          egress_mode: "none",
          egress_assurance: "boundary_enforced",
          backend_enforced_allowlist_supported: false,
          raw_socket_egress_blocked: true,
          server_platform: "Docker Engine - Community",
          server_os: "linux",
          server_arch: "x86_64",
        },
      },
    });

    expect(output).toContain("Assurance level: contained");
    expect(output).toContain("Contained backend: docker");
    expect(output).toContain(
      "Contained credentials: brokered runtime bindings (env OPENAI_API_KEY; files /run/agentgit-secrets/openai.key)",
    );
    expect(output).toContain(
      "Latest automatic checkpoint: run_123#3 (automatic, branch_point, Checkpoint before every contained run.)",
    );
    expect(output).toContain(
      "Restore vs checkpoint: Recommended restore target is narrower than the latest checkpoint boundary.",
    );
    expect(output).toContain("Governance mode: contained projection");
    expect(output).toContain(
      "Guarantees: real workspace protected, publish-back path governed, no direct host credential passthrough, contained egress policy applied",
    );
    expect(output).toContain(
      "Contained capabilities: projected workspace enforced, read-only rootfs, network restricted, egress mode none, egress assurance boundary-enforced, credential brokering enabled, no proxy allowlist, backend-enforced allowlists unsupported, raw socket egress blocked, rootless Docker [Docker Engine - Community / linux / x86_64]",
    );
  });

  it("formats restore previews with source-of-truth detail and advanced guidance", () => {
    const output = formatRestoreResult({
      workspace_root: "/tmp/workspace",
      governed_workspace_root: "/tmp/workspace",
      preview_only: true,
      restored: false,
      conflict_detected: true,
      recovery_class: "review_only",
      target: {
        type: "path_subset",
        snapshot_id: "snap_123",
        paths: ["/tmp/workspace/important-plan.md"],
      },
      target_summary: "/tmp/workspace/important-plan.md",
      restore_source: "path_subset via snapshot_restore",
      restore_boundary: "targeted path restore",
      restore_guidance: "AgentGit can safely target the recorded changed path without widening the restore scope.",
      exactness: "review_only",
      preview_reason:
        "AgentGit is previewing only because this recovery boundary is not trusted for exact automatic restore.",
      deletes_files: null,
      changed_path_count: 1,
      overlapping_paths: ["/tmp/workspace/important-plan.md"],
      restore_command: 'agentgit restore --path "/tmp/workspace/important-plan.md" --force',
      advanced_command: "agentgit-authority plan-recovery <target>",
    });

    expect(output).toContain("Restore preview");
    expect(output).toContain("Source of truth: path_subset via snapshot_restore");
    expect(output).toContain("Restore boundary: targeted path restore");
    expect(output).toContain(
      "Boundary guidance: AgentGit can safely target the recorded changed path without widening the restore scope.",
    );
    expect(output).toContain("Restore mode: review_only");
    expect(output).toContain(
      "Why preview only: AgentGit is previewing only because this recovery boundary is not trusted for exact automatic restore.",
    );
    expect(output).toContain("Advanced command: agentgit-authority plan-recovery <target>");
  });

  it("formats run output with explicit checkpoint details", () => {
    const output = formatRunResult({
      workspace_root: "/tmp/workspace",
      runtime: "Custom agent command",
      run_id: "run_123",
      exit_code: 0,
      daemon_started: true,
      run_checkpoint: "run_123#7",
      checkpoint_kind: "hard_checkpoint",
      checkpoint_trigger: "explicit_run_flag",
      checkpoint_reason: "Before a large refactor.",
      checkpoint_restore_command: "agentgit restore --checkpoint run_123#7",
    });

    expect(output).toContain("Checkpoint: run_123#7");
    expect(output).toContain("Checkpoint kind: hard_checkpoint");
    expect(output).toContain("Checkpoint trigger: explicit_run_flag");
    expect(output).toContain("Checkpoint reason: Before a large refactor.");
    expect(output).toContain("Checkpoint restore command: agentgit restore --checkpoint run_123#7");
  });
});
