import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ActionRecord } from "@agentgit/schemas";
import { LocalSnapshotEngine } from "@agentgit/snapshot-engine";

import {
  type CachedCapabilityState,
  createActionBoundaryReviewPlan,
  executePathSubsetRecovery,
  StaticCompensationRegistry,
  executeSnapshotRecovery,
  planPathSubsetRecovery,
  planSnapshotRecovery,
} from "./index.js";

let tempDir: string | null = null;

function makeCapabilityState(
  workspaceRoot: string,
  overrides: Partial<CachedCapabilityState> = {},
): CachedCapabilityState {
  return {
    capabilities: [
      {
        capability_name: "host.runtime_storage",
        status: "available",
        scope: "host",
        detected_at: "2026-03-29T12:00:00.000Z",
        source: "authority_daemon",
        details: {
          writable: true,
        },
      },
      {
        capability_name: "workspace.root_access",
        status: "available",
        scope: "workspace",
        detected_at: "2026-03-29T12:00:00.000Z",
        source: "filesystem_probe",
        details: {
          workspace_root: workspaceRoot,
          exists: true,
          is_directory: true,
          readable: true,
          writable: true,
        },
      },
    ],
    degraded_mode_warnings: [],
    refreshed_at: "2026-03-29T12:00:00.000Z",
    stale_after_ms: 300_000,
    is_stale: false,
    ...overrides,
  };
}

function makeAction(targetPath: string): ActionRecord {
  return {
    schema_version: "action.v1",
    action_id: "act_test",
    run_id: "run_test",
    session_id: "sess_test",
    status: "normalized",
    timestamps: {
      requested_at: "2026-03-29T12:00:00.000Z",
      normalized_at: "2026-03-29T12:00:01.000Z",
    },
    provenance: {
      mode: "governed",
      source: "test",
      confidence: 0.99,
    },
    actor: {
      type: "agent",
      tool_name: "delete_file",
      tool_kind: "filesystem",
    },
    operation: {
      domain: "filesystem",
      kind: "delete",
      name: "filesystem.delete",
      display_name: "Delete file",
    },
    execution_path: {
      surface: "governed_fs",
      mode: "pre_execution",
      credential_mode: "none",
    },
    target: {
      primary: {
        type: "path",
        locator: targetPath,
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
      side_effect_level: "destructive",
      external_effects: "none",
      reversibility_hint: "potentially_reversible",
      sensitivity_hint: "low",
      batch: false,
    },
    facets: {
      filesystem: {
        operation: "delete",
      },
    },
    normalization: {
      mapper: "test",
      inferred_fields: [],
      warnings: [],
      normalization_confidence: 0.99,
    },
  };
}

function makeShellAction(workspaceRoot: string): ActionRecord {
  return {
    schema_version: "action.v1",
    action_id: "act_shell",
    run_id: "run_shell",
    session_id: "sess_shell",
    status: "normalized",
    timestamps: {
      requested_at: "2026-03-29T12:00:00.000Z",
      normalized_at: "2026-03-29T12:00:01.000Z",
    },
    provenance: {
      mode: "governed",
      source: "test",
      confidence: 0.92,
    },
    actor: {
      type: "agent",
      tool_name: "exec_command",
      tool_kind: "shell",
    },
    operation: {
      domain: "shell",
      kind: "exec",
      name: "shell.exec",
      display_name: "Run shell command",
    },
    execution_path: {
      surface: "governed_shell",
      mode: "pre_execution",
      credential_mode: "none",
    },
    target: {
      primary: {
        type: "workspace",
        locator: workspaceRoot,
      },
      scope: {
        breadth: "workspace",
        estimated_count: 1,
        unknowns: [],
      },
    },
    input: {
      raw: {
        argv: [process.execPath, "-e", "console.log('hello')"],
      },
      redacted: {
        argv: [process.execPath, "-e", "console.log('hello')"],
      },
      schema_ref: null,
      contains_sensitive_data: false,
    },
    risk_hints: {
      side_effect_level: "mutating",
      external_effects: "network",
      reversibility_hint: "compensatable",
      sensitivity_hint: "moderate",
      batch: false,
    },
    facets: {
      shell: {
        argv: [process.execPath, "-e", "console.log('hello')"],
        cwd: workspaceRoot,
      },
    },
    normalization: {
      mapper: "test",
      inferred_fields: [],
      warnings: [],
      normalization_confidence: 0.92,
    },
  };
}

afterEach(() => {
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("recovery-engine", () => {
  it("plans a reversible snapshot restore", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-recovery-"));
    const targetPath = path.join(tempDir, "restore-me.txt");
    fs.writeFileSync(targetPath, "before", "utf8");

    const snapshotEngine = new LocalSnapshotEngine({
      rootDir: path.join(tempDir, "snapshots"),
    });
    const snapshot = await snapshotEngine.createSnapshot({
      action: makeAction(targetPath),
      requested_class: "journal_plus_anchor",
      workspace_root: tempDir,
    });

    fs.writeFileSync(targetPath, "after", "utf8");
    await snapshotEngine.createSnapshot({
      action: {
        ...makeAction(targetPath),
        action_id: "act_later",
      },
      requested_class: "journal_plus_anchor",
      workspace_root: tempDir,
    });

    const plan = await planSnapshotRecovery(snapshotEngine, snapshot.snapshot_id);

    expect(plan.recovery_class).toBe("reversible");
    expect(plan.target).toEqual({
      type: "snapshot_id",
      snapshot_id: snapshot.snapshot_id,
    });
    expect(plan.impact_preview.paths_to_change).toBeGreaterThan(0);
    expect(plan.impact_preview.later_actions_affected).toBe(1);
    expect(plan.impact_preview.overlapping_paths).toContain("restore-me.txt");
    expect(plan.warnings[0]?.code).toBe("LATER_ACTIONS_OVERLAP_BOUNDARY");
  });

  it("executes a snapshot restore", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-recovery-"));
    const targetPath = path.join(tempDir, "restore-me.txt");
    fs.writeFileSync(targetPath, "before", "utf8");

    const snapshotEngine = new LocalSnapshotEngine({
      rootDir: path.join(tempDir, "snapshots"),
    });
    const snapshot = await snapshotEngine.createSnapshot({
      action: makeAction(targetPath),
      requested_class: "journal_plus_anchor",
      workspace_root: tempDir,
    });

    fs.unlinkSync(targetPath);
    const result = await executeSnapshotRecovery(snapshotEngine, snapshot.snapshot_id);

    expect(result.restored).toBe(true);
    expect(result.outcome).toBe("restored");
    expect(fs.readFileSync(targetPath, "utf8")).toBe("before");
  });

  it("degrades snapshot restore planning to manual review when cached capability state is stale", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-recovery-"));
    const targetPath = path.join(tempDir, "restore-me.txt");
    fs.writeFileSync(targetPath, "before", "utf8");

    const snapshotEngine = new LocalSnapshotEngine({
      rootDir: path.join(tempDir, "snapshots"),
    });
    const snapshot = await snapshotEngine.createSnapshot({
      action: makeAction(targetPath),
      requested_class: "journal_plus_anchor",
      workspace_root: tempDir,
    });

    const plan = await planSnapshotRecovery(snapshotEngine, snapshot.snapshot_id, {
      cached_capability_state: makeCapabilityState(tempDir, {
        is_stale: true,
      }),
    });

    expect(plan.recovery_class).toBe("review_only");
    expect(plan.strategy).toBe("manual_review_only");
    expect(plan.downgrade_reason).toEqual(
      expect.objectContaining({
        code: "CAPABILITY_STATE_STALE",
      }),
    );
    expect(plan.warnings.map((warning) => warning.code)).toContain("CAPABILITY_STATE_STALE");

    await expect(
      executeSnapshotRecovery(snapshotEngine, snapshot.snapshot_id, {
        cached_capability_state: makeCapabilityState(tempDir, {
          is_stale: true,
        }),
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it("degrades snapshot restore planning to manual review when cached runtime storage is degraded", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-recovery-"));
    const targetPath = path.join(tempDir, "restore-me.txt");
    fs.writeFileSync(targetPath, "before", "utf8");

    const snapshotEngine = new LocalSnapshotEngine({
      rootDir: path.join(tempDir, "snapshots"),
    });
    const snapshot = await snapshotEngine.createSnapshot({
      action: makeAction(targetPath),
      requested_class: "journal_plus_anchor",
      workspace_root: tempDir,
    });

    const plan = await planSnapshotRecovery(snapshotEngine, snapshot.snapshot_id, {
      cached_capability_state: makeCapabilityState(tempDir, {
        capabilities: [
          {
            capability_name: "host.runtime_storage",
            status: "degraded",
            scope: "host",
            detected_at: "2026-03-29T12:00:00.000Z",
            source: "authority_daemon",
            details: {
              writable: false,
            },
          },
          {
            capability_name: "workspace.root_access",
            status: "available",
            scope: "workspace",
            detected_at: "2026-03-29T12:00:00.000Z",
            source: "filesystem_probe",
            details: {
              workspace_root: tempDir,
              exists: true,
              is_directory: true,
              readable: true,
              writable: true,
            },
          },
        ],
      }),
    });

    expect(plan.recovery_class).toBe("review_only");
    expect(plan.strategy).toBe("manual_review_only");
    expect(plan.downgrade_reason).toEqual(
      expect.objectContaining({
        code: "RUNTIME_STORAGE_CAPABILITY_DEGRADED",
      }),
    );
    expect(plan.warnings.map((warning) => warning.code)).toContain("RUNTIME_STORAGE_CAPABILITY_DEGRADED");
  });

  it("plans metadata-only boundaries as manual review when no compensator exists", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-recovery-"));
    const snapshotEngine = new LocalSnapshotEngine({
      rootDir: path.join(tempDir, "snapshots"),
    });
    const snapshot = await snapshotEngine.createSnapshot({
      action: makeShellAction(tempDir),
      requested_class: "metadata_only",
      workspace_root: tempDir,
    });

    const plan = await planSnapshotRecovery(snapshotEngine, snapshot.snapshot_id);

    expect(plan.recovery_class).toBe("review_only");
    expect(plan.strategy).toBe("manual_review_only");
    expect(plan.impact_preview.external_effects).toEqual(["network"]);
    expect(plan.review_guidance?.systems_touched).toContain("shell");
    expect(plan.review_guidance?.manual_steps[0]).toContain("Inspect workspace changes");
    expect(plan.warnings.map((warning) => warning.code)).toContain("NO_TRUSTED_COMPENSATOR");
    await expect(executeSnapshotRecovery(snapshotEngine, snapshot.snapshot_id)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it("keeps shell mutation boundaries manual-review only even with a richer snapshot", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-recovery-"));
    const snapshotEngine = new LocalSnapshotEngine({
      rootDir: path.join(tempDir, "snapshots"),
    });
    const sourcePath = path.join(tempDir, "source.txt");
    const destinationPath = path.join(tempDir, "destination.txt");

    fs.writeFileSync(sourcePath, "move me", "utf8");
    const snapshot = await snapshotEngine.createSnapshot({
      action: makeShellAction(tempDir),
      requested_class: "journal_plus_anchor",
      workspace_root: tempDir,
    });

    fs.renameSync(sourcePath, destinationPath);

    const plan = await planSnapshotRecovery(snapshotEngine, snapshot.snapshot_id);

    expect(plan.recovery_class).toBe("review_only");
    expect(plan.strategy).toBe("manual_review_only");
    expect(plan.downgrade_reason).toEqual(
      expect.objectContaining({
        code: "OPAQUE_SHELL_BOUNDARY",
      }),
    );
    expect(plan.review_guidance?.uncertainty).toContain(
      "The original shell command may have produced broad or partially opaque side effects, so automated restore is not trusted.",
    );

    await expect(executeSnapshotRecovery(snapshotEngine, snapshot.snapshot_id)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it("uses a trusted compensation registry when one is registered", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-recovery-"));
    const snapshotEngine = new LocalSnapshotEngine({
      rootDir: path.join(tempDir, "snapshots"),
    });
    const snapshot = await snapshotEngine.createSnapshot({
      action: makeShellAction(tempDir),
      requested_class: "metadata_only",
      workspace_root: tempDir,
    });
    const registry = new StaticCompensationRegistry([
      {
        canCompensate(manifest) {
          return manifest.operation_domain === "shell";
        },
        buildCandidate() {
          return {
            strategy: "issue_compensating_shell_command",
            confidence: 0.66,
            steps: [
              {
                step_id: "step_comp_1",
                type: "issue_compensating_shell_command",
                idempotent: false,
                depends_on: [],
              },
            ],
            impact_preview: {
              external_effects: ["network_compensation"],
              data_loss_risk: "moderate",
            },
            warnings: [],
          };
        },
        async execute() {
          return true;
        },
      },
    ]);

    const plan = await planSnapshotRecovery(snapshotEngine, snapshot.snapshot_id, {
      compensation_registry: registry,
    });

    expect(plan.recovery_class).toBe("compensatable");
    expect(plan.strategy).toBe("issue_compensating_shell_command");
    expect(plan.steps).toHaveLength(1);
    expect(plan.impact_preview.external_effects).toEqual(["network_compensation"]);

    const result = await executeSnapshotRecovery(snapshotEngine, snapshot.snapshot_id, {
      compensation_registry: registry,
    });
    expect(result.restored).toBe(false);
    expect(result.outcome).toBe("compensated");
  });

  it("returns not found when planning or executing an unknown snapshot", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-recovery-"));
    const snapshotEngine = new LocalSnapshotEngine({
      rootDir: path.join(tempDir, "snapshots"),
    });

    await expect(planSnapshotRecovery(snapshotEngine, "snap_missing")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(executeSnapshotRecovery(snapshotEngine, "snap_missing")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("plans and executes a reversible path-subset restore for filesystem snapshots", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-recovery-"));
    const snapshotEngine = new LocalSnapshotEngine({
      rootDir: path.join(tempDir, "snapshots"),
    });
    const configPath = path.join(tempDir, "config.json");
    const notesPath = path.join(tempDir, "notes.txt");

    fs.writeFileSync(configPath, '{"version":1}');
    fs.writeFileSync(notesPath, "v1");
    const snapshot = await snapshotEngine.createSnapshot({
      action: makeAction(configPath),
      requested_class: "journal_plus_anchor",
      workspace_root: tempDir,
    });

    fs.writeFileSync(configPath, '{"version":2}');
    fs.writeFileSync(notesPath, "v2");
    const target = {
      type: "path_subset" as const,
      snapshot_id: snapshot.snapshot_id,
      paths: [configPath],
    };

    const plan = await planPathSubsetRecovery(snapshotEngine, target);
    expect(plan.recovery_class).toBe("reversible");
    expect(plan.strategy).toBe("restore_path_subset");
    expect(plan.impact_preview.paths_to_change).toBe(1);

    const result = await executePathSubsetRecovery(snapshotEngine, target);
    expect(result.restored).toBe(true);
    expect(result.outcome).toBe("restored");
    expect(fs.readFileSync(configPath, "utf8")).toBe('{"version":1}');
    expect(fs.readFileSync(notesPath, "utf8")).toBe("v2");
  });

  it("degrades path-subset restore planning to manual review when cached workspace access is unavailable", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-recovery-"));
    const snapshotEngine = new LocalSnapshotEngine({
      rootDir: path.join(tempDir, "snapshots"),
    });
    const configPath = path.join(tempDir, "config.json");

    fs.writeFileSync(configPath, '{"version":1}');
    const snapshot = await snapshotEngine.createSnapshot({
      action: makeAction(configPath),
      requested_class: "journal_plus_anchor",
      workspace_root: tempDir,
    });

    const target = {
      type: "path_subset" as const,
      snapshot_id: snapshot.snapshot_id,
      paths: [configPath],
    };

    const plan = await planPathSubsetRecovery(snapshotEngine, target, {
      cached_capability_state: makeCapabilityState(tempDir, {
        capabilities: [
          {
            capability_name: "host.runtime_storage",
            status: "available",
            scope: "host",
            detected_at: "2026-03-29T12:00:00.000Z",
            source: "authority_daemon",
            details: {
              writable: true,
            },
          },
          {
            capability_name: "workspace.root_access",
            status: "unavailable",
            scope: "workspace",
            detected_at: "2026-03-29T12:00:00.000Z",
            source: "filesystem_probe",
            details: {
              workspace_root: tempDir,
              exists: false,
              is_directory: false,
              readable: false,
              writable: false,
            },
          },
        ],
      }),
    });
    expect(plan.recovery_class).toBe("review_only");
    expect(plan.strategy).toBe("manual_review_only");
    expect(plan.downgrade_reason).toEqual(
      expect.objectContaining({
        code: "WORKSPACE_CAPABILITY_UNAVAILABLE",
      }),
    );
    expect(plan.warnings.map((warning) => warning.code)).toContain("WORKSPACE_CAPABILITY_UNAVAILABLE");

    await expect(
      executePathSubsetRecovery(snapshotEngine, target, {
        cached_capability_state: makeCapabilityState(tempDir, {
          capabilities: [
            {
              capability_name: "host.runtime_storage",
              status: "available",
              scope: "host",
              detected_at: "2026-03-29T12:00:00.000Z",
              source: "authority_daemon",
              details: {
                writable: true,
              },
            },
            {
              capability_name: "workspace.root_access",
              status: "unavailable",
              scope: "workspace",
              detected_at: "2026-03-29T12:00:00.000Z",
              source: "filesystem_probe",
              details: {
                workspace_root: tempDir,
                exists: false,
                is_directory: false,
                readable: false,
                writable: false,
              },
            },
          ],
        }),
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it("plans metadata-only path-subset targets as manual review", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-recovery-"));
    const snapshotEngine = new LocalSnapshotEngine({
      rootDir: path.join(tempDir, "snapshots"),
    });
    const snapshot = await snapshotEngine.createSnapshot({
      action: makeShellAction(tempDir),
      requested_class: "metadata_only",
      workspace_root: tempDir,
    });
    const target = {
      type: "path_subset" as const,
      snapshot_id: snapshot.snapshot_id,
      paths: [path.join(tempDir, "src/app.ts")],
    };

    const plan = await planPathSubsetRecovery(snapshotEngine, target);
    expect(plan.recovery_class).toBe("review_only");
    expect(plan.strategy).toBe("manual_review_only");
    expect(plan.warnings.map((warning) => warning.code)).toContain("PATH_SUBSET_UNSUPPORTED_FOR_BOUNDARY");

    await expect(executePathSubsetRecovery(snapshotEngine, target)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it("surfaces a failing compensator as an internal error", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-recovery-"));
    const snapshotEngine = new LocalSnapshotEngine({
      rootDir: path.join(tempDir, "snapshots"),
    });
    const snapshot = await snapshotEngine.createSnapshot({
      action: makeShellAction(tempDir),
      requested_class: "metadata_only",
      workspace_root: tempDir,
    });
    const registry = new StaticCompensationRegistry([
      {
        canCompensate() {
          return true;
        },
        buildCandidate() {
          return {
            strategy: "failing_compensator",
            confidence: 0.5,
            steps: [
              {
                step_id: "step_fail_1",
                type: "failing_compensator",
                idempotent: true,
                depends_on: [],
              },
            ],
            impact_preview: {
              external_effects: ["draft_archive"],
              data_loss_risk: "low",
            },
          };
        },
        async execute() {
          return false;
        },
      },
    ]);

    await expect(
      executeSnapshotRecovery(snapshotEngine, snapshot.snapshot_id, {
        compensation_registry: registry,
      }),
    ).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
  });

  it("creates review-only action-boundary plans without snapshots", () => {
    const plan = createActionBoundaryReviewPlan({
      action_id: "act_boundary",
      target_locator: "/workspace/README.md",
      operation_domain: "filesystem",
      display_name: "Write file",
      side_effect_level: "mutating",
      external_effects: "none",
      reversibility_hint: "potentially_reversible",
      later_actions_affected: 1,
      overlapping_paths: ["/workspace/README.md"],
    });

    expect(plan.target).toEqual({
      type: "action_boundary",
      action_id: "act_boundary",
    });
    expect(plan.recovery_class).toBe("review_only");
    expect(plan.warnings.map((warning) => warning.code)).toContain("NO_BOUNDARY_SNAPSHOT");
    expect(plan.review_guidance?.objects_touched).toEqual(["/workspace/README.md"]);
  });
});
