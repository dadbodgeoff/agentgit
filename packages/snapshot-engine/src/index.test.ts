import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentGitError, type ActionRecord } from "@agentgit/schemas";
import { createTempDirTracker } from "@agentgit/test-fixtures";

import { LocalSnapshotEngine, selectSnapshotClass } from "./index.js";

let tempDir: string | null = null;
const tempDirs = createTempDirTracker("agentgit-snapshot-");

function makeConfidenceAssessment(score: number, label = "Test baseline"): ActionRecord["confidence_assessment"] {
  return {
    engine_version: "test-confidence/v1",
    score,
    band: score >= 0.85 ? "high" : score >= 0.65 ? "guarded" : "low",
    requires_human_review: score < 0.65,
    factors: [
      {
        factor_id: "test_baseline",
        label,
        kind: "baseline",
        delta: score,
        rationale: "Test confidence baseline.",
      },
    ],
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
      side_effect_level: "mutating",
      external_effects: "none",
      reversibility_hint: "reversible",
      sensitivity_hint: "low",
      batch: false,
    },
    facets: {
      filesystem: {
        operation: "write",
      },
    },
    normalization: {
      mapper: "test",
      inferred_fields: [],
      warnings: [],
      normalization_confidence: 0.99,
    },
    confidence_assessment: makeConfidenceAssessment(0.99),
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
    confidence_assessment: makeConfidenceAssessment(0.76),
  };
}

function makeFunctionAction(workspaceRoot: string): ActionRecord {
  return {
    schema_version: "action.v1",
    action_id: "act_function",
    run_id: "run_function",
    session_id: "sess_function",
    status: "normalized",
    timestamps: {
      requested_at: "2026-03-29T12:00:00.000Z",
      normalized_at: "2026-03-29T12:00:01.000Z",
    },
    provenance: {
      mode: "governed",
      source: "test",
      confidence: 0.95,
    },
    actor: {
      type: "agent",
      tool_name: "drafts_create",
      tool_kind: "function",
    },
    operation: {
      domain: "function",
      kind: "create",
      name: "function.create",
      display_name: "Create draft",
    },
    execution_path: {
      surface: "governed_function",
      mode: "pre_execution",
      credential_mode: "none",
    },
    target: {
      primary: {
        type: "workspace",
        locator: workspaceRoot,
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
      reversibility_hint: "compensatable",
      sensitivity_hint: "low",
      batch: false,
    },
    facets: {
      function: {
        integration: "drafts",
        operation: "create_draft",
      },
    },
    normalization: {
      mapper: "test",
      inferred_fields: [],
      warnings: [],
      normalization_confidence: 0.95,
    },
    confidence_assessment: makeConfidenceAssessment(0.95),
  };
}

afterEach(() => {
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  tempDirs.cleanup();
});

describe("LocalSnapshotEngine", () => {
  it("selects journal_only for narrow reversible filesystem mutations", () => {
    const selection = selectSnapshotClass({
      action: makeAction("/tmp/workspace/file.txt"),
      policy_decision: "allow_with_snapshot",
      capability_state: "healthy",
      journal_chain_depth: 3,
    });

    expect(selection.snapshot_class).toBe("journal_only");
    expect(selection.reason_codes).toContain("snapshot.narrow_reversible_mutation");
  });

  it("selects exact_anchor for shell workspace mutations with remote side effects", () => {
    const selection = selectSnapshotClass({
      action: makeShellAction("/tmp/workspace"),
      policy_decision: "allow_with_snapshot",
      capability_state: "healthy",
      journal_chain_depth: 6,
    });

    expect(selection.snapshot_class).toBe("exact_anchor");
    expect(selection.reason_codes).toContain("snapshot.remote_side_effect_branch_point");
  });

  it("selects exact_anchor for package-manager style branch points", () => {
    const action = makeShellAction("/tmp/workspace");
    action.facets.shell = {
      ...(action.facets.shell as Record<string, unknown>),
      command_family: "package_manager",
    };

    const selection = selectSnapshotClass({
      action,
      policy_decision: "allow_with_snapshot",
      capability_state: "healthy",
      journal_chain_depth: 12,
    });

    expect(selection.snapshot_class).toBe("exact_anchor");
    expect(selection.reason_codes).toContain("snapshot.opaque_workspace_wide_tooling");
  });

  it("selects metadata_only for compensatable non-filesystem mutations", () => {
    const selection = selectSnapshotClass({
      action: makeFunctionAction("/tmp/workspace"),
      policy_decision: "allow_with_snapshot",
      capability_state: "healthy",
      journal_chain_depth: 2,
    });

    expect(selection.snapshot_class).toBe("metadata_only");
    expect(selection.reason_codes).toContain("snapshot.non_filesystem_metadata_only");
  });

  it("strengthens journal_only to journal_plus_anchor when capability state is stale", () => {
    const selection = selectSnapshotClass({
      action: makeAction("/tmp/workspace/file.txt"),
      policy_decision: "allow_with_snapshot",
      capability_state: "stale",
      journal_chain_depth: 3,
    });

    expect(selection.snapshot_class).toBe("journal_plus_anchor");
    expect(selection.reason_codes).toContain("snapshot.capability_state_strengthened");
  });

  it("strengthens low-confidence mutations to exact_anchor", () => {
    const action = makeAction("/tmp/workspace/file.txt");
    action.confidence_assessment = makeConfidenceAssessment(0.32, "Low confidence");

    const selection = selectSnapshotClass({
      action,
      policy_decision: "allow_with_snapshot",
      capability_state: "healthy",
      journal_chain_depth: 2,
    });

    expect(selection.snapshot_class).toBe("exact_anchor");
    expect(selection.reason_codes).toContain("snapshot.low_confidence_branch_point");
    expect(selection.basis.confidence_score).toBe(0.32);
  });

  it("widens to exact_anchor after repeated ambiguous shell history in the same run", () => {
    const selection = selectSnapshotClass({
      action: makeAction("/tmp/workspace/file.txt"),
      policy_decision: "allow_with_snapshot",
      capability_state: "healthy",
      journal_chain_depth: 6,
      recent_ambiguous_shell_mutations: 2,
    });

    expect(selection.snapshot_class).toBe("exact_anchor");
    expect(selection.reason_codes).toContain("snapshot.repeated_ambiguous_shell_history");
    expect(selection.basis.recent_ambiguous_shell_mutations).toBe(2);
  });

  it("strengthens journal_only to journal_plus_anchor after repeated reviewed mutations", () => {
    const selection = selectSnapshotClass({
      action: makeAction("/tmp/workspace/file.txt"),
      policy_decision: "allow_with_snapshot",
      capability_state: "healthy",
      journal_chain_depth: 4,
      recent_review_or_blocked_mutations: 2,
    });

    expect(selection.snapshot_class).toBe("journal_plus_anchor");
    expect(selection.reason_codes).toContain("snapshot.repeated_reviewed_mutation_history");
    expect(selection.basis.recent_review_or_blocked_mutations).toBe(2);
  });

  it("captures and restores a preexisting file", async () => {
    tempDir = tempDirs.make("agentgit-snapshot-");
    const targetPath = path.join(tempDir, "file.txt");
    fs.writeFileSync(targetPath, "before", "utf8");
    const engine = new LocalSnapshotEngine({
      rootDir: path.join(tempDir, "snapshots"),
    });

    const snapshot = await engine.createSnapshot({
      action: makeAction(targetPath),
      requested_class: "journal_plus_anchor",
      workspace_root: tempDir,
    });

    fs.writeFileSync(targetPath, "after", "utf8");
    const restored = await engine.restore(snapshot.snapshot_id);

    expect(snapshot.storage_bytes).toBeGreaterThan(0);
    expect(restored).toBe(true);
    expect(fs.readFileSync(targetPath, "utf8")).toBe("before");
  });

  it("restores a missing target by removing a newly created file from layered snapshot state", async () => {
    tempDir = tempDirs.make("agentgit-snapshot-");
    const targetPath = path.join(tempDir, "new-file.txt");
    const engine = new LocalSnapshotEngine({
      rootDir: path.join(tempDir, "snapshots"),
    });

    const snapshot = await engine.createSnapshot({
      action: makeAction(targetPath),
      requested_class: "journal_plus_anchor",
      workspace_root: tempDir,
    });

    fs.writeFileSync(targetPath, "created later", "utf8");
    const restored = await engine.restore(snapshot.snapshot_id);

    expect(snapshot.storage_bytes).toBe(0);
    expect(restored).toBe(true);
    expect(fs.existsSync(targetPath)).toBe(false);
  });

  it("detects when the target changed after snapshot capture", async () => {
    tempDir = tempDirs.make("agentgit-snapshot-");
    const targetPath = path.join(tempDir, "file.txt");
    fs.writeFileSync(targetPath, "before", "utf8");

    const engine = new LocalSnapshotEngine({
      rootDir: path.join(tempDir, "snapshots"),
    });

    const snapshot = await engine.createSnapshot({
      action: makeAction(targetPath),
      requested_class: "journal_plus_anchor",
      workspace_root: tempDir,
    });

    fs.writeFileSync(targetPath, "after", "utf8");

    await expect(engine.verifyTargetUnchanged(snapshot.snapshot_id, targetPath)).resolves.toBe(false);
  });

  it("persists metadata-only snapshots for non-filesystem actions", async () => {
    tempDir = tempDirs.make("agentgit-snapshot-");
    const engine = new LocalSnapshotEngine({
      rootDir: path.join(tempDir, "snapshots"),
    });

    const snapshot = await engine.createSnapshot({
      action: makeShellAction(tempDir),
      requested_class: "metadata_only",
      workspace_root: tempDir,
    });

    const manifest = await engine.getSnapshotManifest(snapshot.snapshot_id);
    const preview = await engine.previewRestore(snapshot.snapshot_id);

    expect(snapshot.fidelity).toBe("metadata_only");
    expect(manifest?.snapshot_class).toBe("metadata_only");
    expect(manifest?.operation_domain).toBe("shell");
    expect(manifest?.external_effects).toBe("network");
    expect(preview.paths_to_change).toBe(0);
    expect(preview.data_loss_risk).toBe("unknown");
    await expect(engine.restore(snapshot.snapshot_id)).resolves.toBe(false);
  });

  it("captures layered workspace snapshots for shell mutations when requested", async () => {
    tempDir = tempDirs.make("agentgit-snapshot-");
    const sourcePath = path.join(tempDir, "move-me.txt");
    fs.writeFileSync(sourcePath, "before", "utf8");
    const engine = new LocalSnapshotEngine({
      rootDir: path.join(tempDir, "snapshots"),
    });

    const snapshot = await engine.createSnapshot({
      action: makeShellAction(tempDir),
      requested_class: "journal_plus_anchor",
      workspace_root: tempDir,
    });

    fs.renameSync(sourcePath, path.join(tempDir, "moved.txt"));
    const manifest = await engine.getSnapshotManifest(snapshot.snapshot_id);
    const restored = await engine.restore(snapshot.snapshot_id);

    expect(snapshot.snapshot_class).toBe("journal_plus_anchor");
    expect(snapshot.fidelity).toBe("full");
    expect(manifest).toEqual(
      expect.objectContaining({
        snapshot_class: "journal_plus_anchor",
        operation_domain: "shell",
        operation_kind: "exec",
        execution_surface: "governed_shell",
        tool_kind: "shell",
        tool_name: "exec_command",
      }),
    );
    expect(restored).toBe(true);
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  it("surfaces low-disk metadata snapshot writes as retryable storage failures", async () => {
    tempDir = tempDirs.make("agentgit-snapshot-");
    const engine = new LocalSnapshotEngine({
      rootDir: path.join(tempDir, "snapshots"),
    });
    const writeSpy = vi.spyOn(fsPromises, "writeFile").mockRejectedValueOnce(
      Object.assign(new Error("no space left on device"), {
        code: "ENOSPC",
      }),
    );

    try {
      await engine.createSnapshot({
        action: makeShellAction(tempDir),
        requested_class: "metadata_only",
        workspace_root: tempDir,
      });
      throw new Error("expected low-disk metadata snapshot write to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentGitError);
      expect((error as AgentGitError).code).toBe("STORAGE_UNAVAILABLE");
      expect((error as AgentGitError).retryable).toBe(true);
      expect((error as AgentGitError).details?.low_disk_pressure).toBe(true);
      expect((error as AgentGitError).details?.storage_error_code).toBe("ENOSPC");
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("garbage collects orphaned layered and legacy snapshot storage without removing referenced snapshots", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-snapshot-"));
    const targetPath = path.join(tempDir, "gc-file.txt");
    fs.writeFileSync(targetPath, "before", "utf8");

    const engine = new LocalSnapshotEngine({
      rootDir: path.join(tempDir, "snapshots"),
    });

    const snapshot = await engine.createSnapshot({
      action: makeAction(targetPath),
      requested_class: "journal_plus_anchor",
      workspace_root: tempDir,
    });

    const referencedManifestPath = path.join(tempDir, "snapshots", "snaps", snapshot.snapshot_id, "manifest.json");
    expect(fs.existsSync(referencedManifestPath)).toBe(true);

    const orphanedLayeredDir = path.join(tempDir, "snapshots", "snaps", "snap_orphaned");
    fs.mkdirSync(orphanedLayeredDir, { recursive: true });
    fs.writeFileSync(path.join(orphanedLayeredDir, "manifest.json"), "{}", "utf8");
    fs.writeFileSync(path.join(orphanedLayeredDir, "data.txt"), "orphaned-layer", "utf8");

    const strayEntryPath = path.join(tempDir, "snapshots", "snaps", "orphan.tmp");
    fs.writeFileSync(strayEntryPath, "temp", "utf8");

    const orphanedLegacyDir = path.join(tempDir, "snapshots", "snap_legacy_orphaned");
    fs.mkdirSync(orphanedLegacyDir, { recursive: true });
    fs.writeFileSync(path.join(orphanedLegacyDir, "leftover.txt"), "legacy-leftover", "utf8");

    const preservedLegacyDir = path.join(tempDir, "snapshots", "snap_legacy_preserved");
    fs.mkdirSync(preservedLegacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(preservedLegacyDir, "manifest.json"),
      JSON.stringify({ snapshot_id: "snap_legacy_preserved" }),
      "utf8",
    );

    const summary = await engine.garbageCollectSnapshots();

    expect(summary).toEqual({
      workspaces_considered: 1,
      referenced_layered_snapshots: 1,
      layered_snapshots_removed: 1,
      legacy_snapshots_removed: 1,
      stray_entries_removed: 1,
      bytes_freed:
        Buffer.byteLength("{}", "utf8") +
        Buffer.byteLength("orphaned-layer", "utf8") +
        Buffer.byteLength("temp", "utf8") +
        Buffer.byteLength("legacy-leftover", "utf8"),
      empty_directories_removed: 0,
    });

    expect(fs.existsSync(referencedManifestPath)).toBe(true);
    expect(fs.existsSync(orphanedLayeredDir)).toBe(false);
    expect(fs.existsSync(strayEntryPath)).toBe(false);
    expect(fs.existsSync(orphanedLegacyDir)).toBe(false);
    expect(fs.existsSync(path.join(preservedLegacyDir, "manifest.json"))).toBe(true);
  });

  it("rebases duplicate synthetic anchors without following newer live workspace state", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-snapshot-"));
    const targetPath = path.join(tempDir, "config.json");
    fs.writeFileSync(targetPath, '{"version":1}', "utf8");

    const engine = new LocalSnapshotEngine({
      rootDir: path.join(tempDir, "snapshots"),
    });

    const firstSnapshot = await engine.createSnapshot({
      action: makeAction(targetPath),
      requested_class: "journal_plus_anchor",
      workspace_root: tempDir,
    });
    const secondSnapshot = await engine.createSnapshot({
      action: makeAction(targetPath),
      requested_class: "journal_plus_anchor",
      workspace_root: tempDir,
    });

    fs.writeFileSync(targetPath, '{"version":2}', "utf8");
    await engine.createSnapshot({
      action: makeAction(targetPath),
      requested_class: "journal_plus_anchor",
      workspace_root: tempDir,
    });

    const duplicateAnchorPath = path.join(
      tempDir,
      "snapshots",
      "snaps",
      secondSnapshot.snapshot_id,
      "files",
      "config.json",
    );
    expect(fs.readFileSync(duplicateAnchorPath, "utf8")).toBe('{"version":1}');

    const summary = await engine.rebaseSyntheticAnchors();
    expect(summary).toEqual({
      workspaces_considered: 1,
      snapshots_scanned: 3,
      anchors_rebased: 1,
      bytes_freed: Buffer.byteLength('{"version":1}', "utf8"),
      empty_directories_removed: 1,
    });
    expect(fs.existsSync(duplicateAnchorPath)).toBe(false);

    fs.rmSync(targetPath, { force: true });
    await expect(engine.restore(secondSnapshot.snapshot_id)).resolves.toBe(true);
    expect(fs.readFileSync(targetPath, "utf8")).toBe('{"version":1}');
    await expect(engine.verifyTargetUnchanged(secondSnapshot.snapshot_id, targetPath)).resolves.toBe(true);
    await expect(engine.verifyTargetUnchanged(firstSnapshot.snapshot_id, targetPath)).resolves.toBe(true);
  });

  it("surfaces low-disk layered snapshot commits as retryable storage failures", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-snapshot-"));
    const targetPath = path.join(tempDir, "file.txt");
    fs.writeFileSync(targetPath, "before", "utf8");
    const engine = new LocalSnapshotEngine({
      rootDir: path.join(tempDir, "snapshots"),
    });
    const copySpy = vi.spyOn(fsPromises, "copyFile").mockRejectedValueOnce(
      Object.assign(new Error("no space left on device"), {
        code: "ENOSPC",
      }),
    );

    try {
      await engine.createSnapshot({
        action: makeAction(targetPath),
        requested_class: "journal_plus_anchor",
        workspace_root: tempDir,
      });
      throw new Error("expected low-disk workspace snapshot to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentGitError);
      expect((error as AgentGitError).code).toBe("STORAGE_UNAVAILABLE");
      expect((error as AgentGitError).retryable).toBe(true);
      expect((error as AgentGitError).details?.low_disk_pressure).toBe(true);
      expect((error as AgentGitError).details?.storage_error_code).toBe("ENOSPC");
    } finally {
      copySpy.mockRestore();
    }
  });

  it("returns false when restoring an unknown snapshot", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-snapshot-"));
    const engine = new LocalSnapshotEngine({
      rootDir: path.join(tempDir, "snapshots"),
    });

    await expect(engine.restore("snap_missing")).resolves.toBe(false);
    await expect(engine.verifyIntegrity("snap_missing")).resolves.toBe(false);
  });

  it("surfaces corrupted metadata manifests as internal errors", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-snapshot-"));
    const engine = new LocalSnapshotEngine({
      rootDir: path.join(tempDir, "snapshots"),
    });

    const snapshot = await engine.createSnapshot({
      action: makeShellAction(tempDir),
      requested_class: "metadata_only",
      workspace_root: tempDir,
    });

    fs.writeFileSync(
      path.join(tempDir, "snapshots", "metadata", `${snapshot.snapshot_id}.json`),
      "{broken-json",
      "utf8",
    );

    await expect(engine.getSnapshotManifest(snapshot.snapshot_id)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
  });

  it("surfaces corrupted layered manifests as internal errors", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-snapshot-"));
    const targetPath = path.join(tempDir, "file.txt");
    fs.writeFileSync(targetPath, "before", "utf8");
    const engine = new LocalSnapshotEngine({
      rootDir: path.join(tempDir, "snapshots"),
    });

    const snapshot = await engine.createSnapshot({
      action: makeAction(targetPath),
      requested_class: "journal_plus_anchor",
      workspace_root: tempDir,
    });

    fs.writeFileSync(
      path.join(tempDir, "snapshots", "snaps", snapshot.snapshot_id, "manifest.json"),
      "{broken-json",
      "utf8",
    );

    await expect(engine.getSnapshotManifest(snapshot.snapshot_id)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
  });
});
