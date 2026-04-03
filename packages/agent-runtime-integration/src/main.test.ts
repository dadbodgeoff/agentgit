import { describe, expect, it } from "vitest";

import { formatInspectResult, formatRestoreResult, formatSetupResult } from "./main.js";

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
      summary: "AgentGit observed a dangerous delete.",
      action_title: "Delete file",
      action_status: "completed",
      changed_paths: ["/tmp/workspace/important-plan.md"],
      restore_available: true,
      restore_command: 'agentgit restore --path "/tmp/workspace/important-plan.md"',
      degraded_reasons: [],
    });

    expect(output).toContain("Latest notable governed run");
    expect(output).toContain("Assurance level: attached");
    expect(output).toContain("Governance mode: attached live launch");
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
      governed_surfaces: ["contained runtime boundary", "governed publication boundary"],
      degraded_reasons: ["Container network egress is not restricted."],
      changed: true,
      next_command: "agentgit run",
      health_checks: [],
      preserved_user_changes: [],
      contained_details: {
        backend: "docker",
        network_policy: "inherit",
        credential_mode: "direct_env",
        credential_env_keys: ["OPENAI_API_KEY"],
        credential_file_paths: [],
        egress_allowlist_hosts: [],
        capability_snapshot: {
          docker_available: true,
          docker_desktop_vm: true,
          rootless_docker: false,
          projection_enforced: true,
          read_only_rootfs_enabled: true,
          network_restricted: false,
          credential_brokering_enabled: false,
          server_platform: "Docker Desktop 4.63.0 (177762)",
          server_os: "linux",
          server_arch: "aarch64",
        },
      },
    });

    expect(output).toContain("Assurance level: contained");
    expect(output).toContain("Contained backend: docker");
    expect(output).toContain("Contained network policy: inherit");
    expect(output).toContain("Contained credentials: direct host env allowlist (OPENAI_API_KEY)");
    expect(output).toContain("Governance mode: contained projection");
    expect(output).toContain("Guarantees: real workspace protected, publish-back path governed");
    expect(output).toContain("Contained capabilities: projected workspace enforced, read-only rootfs, network inherited, credential brokering not enabled, no proxy allowlist, Docker Desktop VM [Docker Desktop 4.63.0 (177762) / linux / aarch64]");
  });

  it("formats contained inspect output with brokered secret refs", () => {
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
      summary: "AgentGit published a contained workspace change.",
      action_title: "Delete file",
      action_status: "completed",
      changed_paths: ["/tmp/workspace/important-plan.md"],
      restore_available: true,
      restore_command: "agentgit restore --contained-run-id crun_123",
      degraded_reasons: [],
      contained_details: {
        backend: "docker",
        network_policy: "none",
        credential_mode: "brokered_secret_refs",
        credential_env_keys: ["OPENAI_API_KEY"],
        credential_file_paths: ["/run/agentgit-secrets/openai.key"],
        egress_allowlist_hosts: [],
        capability_snapshot: {
          docker_available: true,
          docker_desktop_vm: false,
          rootless_docker: true,
          projection_enforced: true,
          read_only_rootfs_enabled: true,
          network_restricted: true,
          credential_brokering_enabled: true,
          server_platform: "Docker Engine - Community",
          server_os: "linux",
          server_arch: "x86_64",
        },
      },
    });

    expect(output).toContain("Assurance level: contained");
    expect(output).toContain("Contained backend: docker");
    expect(output).toContain(
      "Contained credentials: brokered secret refs (env OPENAI_API_KEY; files /run/agentgit-secrets/openai.key)",
    );
    expect(output).toContain("Governance mode: contained projection");
    expect(output).toContain("Guarantees: real workspace protected, publish-back path governed, no direct host credential passthrough, contained egress policy applied");
    expect(output).toContain("Contained capabilities: projected workspace enforced, read-only rootfs, network restricted, credential brokering enabled, no proxy allowlist, rootless Docker [Docker Engine - Community / linux / x86_64]");
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
      exactness: "review_only",
      deletes_files: null,
      changed_path_count: 1,
      overlapping_paths: ["/tmp/workspace/important-plan.md"],
      restore_command: 'agentgit restore --path "/tmp/workspace/important-plan.md" --force',
      advanced_command: "agentgit-authority plan-recovery <target>",
    });

    expect(output).toContain("Restore preview");
    expect(output).toContain("Source of truth: path_subset via snapshot_restore");
    expect(output).toContain("Restore mode: review_only");
    expect(output).toContain("Advanced command: agentgit-authority plan-recovery <target>");
  });
});
