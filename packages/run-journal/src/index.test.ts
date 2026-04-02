import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentGitError, NotFoundError, type ActionRecord, type PolicyOutcomeRecord } from "@agentgit/schemas";

import { createRunJournal, type RunJournal, type RunJournalOptions } from "./index.js";

let currentJournal: RunJournal | null = null;
let currentDir: string | null = null;

function makeJournal(options: Partial<RunJournalOptions> = {}): RunJournal {
  currentDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-run-journal-"));
  currentJournal = createRunJournal({
    dbPath: path.join(currentDir, "authority.db"),
    ...options,
  });
  return currentJournal;
}

function makeAction(actionId: string, runId: string, family: "filesystem/write" | "shell/exec"): ActionRecord {
  const isShell = family === "shell/exec";
  return {
    schema_version: "action.v1",
    action_id: actionId,
    run_id: runId,
    session_id: "sess_test",
    status: "normalized",
    timestamps: {
      requested_at: "2026-04-01T12:00:00.000Z",
      normalized_at: "2026-04-01T12:00:01.000Z",
    },
    provenance: {
      mode: "governed",
      source: "test",
      confidence: 0.98,
    },
    actor: {
      type: "agent",
      tool_name: isShell ? "exec_command" : "write_file",
      tool_kind: isShell ? "shell" : "filesystem",
    },
    operation: {
      domain: isShell ? "shell" : "filesystem",
      kind: isShell ? "exec" : "write",
      name: family,
      display_name: isShell ? "Run shell command" : "Write file",
    },
    execution_path: {
      surface: isShell ? "governed_shell" : "governed_fs",
      mode: "pre_execution",
      credential_mode: "none",
    },
    target: {
      primary: {
        type: "path",
        locator: isShell ? "/workspace" : "/workspace/README.md",
      },
      scope: {
        breadth: isShell ? "workspace" : "single",
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
      reversibility_hint: isShell ? "potentially_reversible" : "reversible",
      sensitivity_hint: "low",
      batch: false,
    },
    facets: {},
    normalization: {
      mapper: "test",
      inferred_fields: [],
      warnings: [],
      normalization_confidence: isShell ? 0.42 : 0.96,
    },
  };
}

function makePolicyOutcome(
  actionId: string,
  decision: PolicyOutcomeRecord["decision"],
  matchedRules: string[],
): PolicyOutcomeRecord {
  return {
    schema_version: "policy-outcome.v1",
    policy_outcome_id: `pol_${actionId}`,
    action_id: actionId,
    decision,
    reasons: [
      {
        code: decision === "ask" ? "APPROVAL_REQUIRED" : "SAFE_TO_RUN",
        severity: decision === "ask" ? "moderate" : "low",
        message: decision === "ask" ? "Approval required." : "Safe to run.",
      },
    ],
    trust_requirements: {
      wrapped_path_required: true,
      brokered_credentials_required: false,
      direct_credentials_forbidden: false,
    },
    preconditions: {
      snapshot_required: decision === "allow_with_snapshot",
      approval_required: decision === "ask",
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
      matched_rules: matchedRules,
      sticky_decision_applied: false,
    },
    evaluated_at: "2026-04-01T12:00:02.000Z",
  };
}

afterEach(() => {
  currentJournal?.close();
  currentJournal = null;

  if (currentDir) {
    fs.rmSync(currentDir, { recursive: true, force: true });
    currentDir = null;
  }
});

describe("RunJournal", () => {
  it("registers a run and returns a summary", () => {
    const journal = makeJournal();
    journal.registerRunLifecycle({
      run_id: "run_test",
      session_id: "sess_test",
      workflow_name: "workflow",
      agent_framework: "cli",
      agent_name: "agentgit-cli",
      workspace_roots: ["/workspace/project"],
      client_metadata: {
        source: "test",
      },
      budget_config: {
        max_mutating_actions: 3,
        max_destructive_actions: 1,
      },
      created_at: "2026-03-29T12:00:00.000Z",
    });

    const summary = journal.getRunSummary("run_test");

    expect(summary).not.toBeNull();
    expect(summary?.event_count).toBe(2);
    expect(summary?.latest_event?.event_type).toBe("run.started");
    expect(summary?.budget_config.max_mutating_actions).toBe(3);
    expect(summary?.budget_usage.mutating_actions).toBe(0);
    expect(summary?.maintenance_status.projection_status).toBe("fresh");
    expect(summary?.maintenance_status.artifact_health.total).toBe(0);
  });

  it("appends events and increments event counts", () => {
    const journal = makeJournal();
    journal.registerRunLifecycle({
      run_id: "run_test",
      session_id: "sess_test",
      workflow_name: "workflow",
      agent_framework: "cli",
      agent_name: "agentgit-cli",
      workspace_roots: ["/workspace/project"],
      client_metadata: {},
      budget_config: {
        max_mutating_actions: null,
        max_destructive_actions: null,
      },
      created_at: "2026-03-29T12:00:00.000Z",
    });

    const sequence = journal.appendRunEvent("run_test", {
      event_type: "action.normalized",
      occurred_at: "2026-03-29T12:00:01.000Z",
      recorded_at: "2026-03-29T12:00:01.000Z",
      payload: {
        action_id: "act_test",
      },
    });

    const summary = journal.getRunSummary("run_test");

    expect(sequence).toBe(3);
    expect(summary?.event_count).toBe(3);
    expect(summary?.latest_event?.event_type).toBe("action.normalized");
  });

  it("clears cached helper facts when new run events arrive", () => {
    const journal = makeJournal();
    journal.registerRunLifecycle({
      run_id: "run_helper_cache",
      session_id: "sess_helper_cache",
      workflow_name: "workflow",
      agent_framework: "cli",
      agent_name: "agentgit-cli",
      workspace_roots: ["/workspace/project"],
      client_metadata: {},
      budget_config: {
        max_mutating_actions: null,
        max_destructive_actions: null,
      },
      created_at: "2026-03-29T12:00:00.000Z",
    });

    journal.storeHelperFactCache({
      run_id: "run_helper_cache",
      question_type: "run_summary",
      focus_step_id: null,
      compare_step_id: null,
      visibility_scope: "user",
      event_count: 2,
      latest_sequence: 2,
      artifact_state_digest: crypto.createHash("sha256").update("[]", "utf8").digest("hex"),
      response: {
        answer: "cached",
        confidence: 0.9,
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
      },
      warmed_at: "2026-03-29T12:00:02.000Z",
    });

    expect(
      journal.getHelperFactCache({
        run_id: "run_helper_cache",
        question_type: "run_summary",
        visibility_scope: "user",
      })?.response.answer,
    ).toBe("cached");

    journal.appendRunEvent("run_helper_cache", {
      event_type: "action.normalized",
      occurred_at: "2026-03-29T12:00:01.000Z",
      recorded_at: "2026-03-29T12:00:01.000Z",
      payload: {
        action_id: "act_helper_cache",
      },
    });

    expect(
      journal.getHelperFactCache({
        run_id: "run_helper_cache",
        question_type: "run_summary",
        visibility_scope: "user",
      }),
    ).toBeNull();
  });

  it("lists all runs for rehydration", () => {
    const journal = makeJournal();

    for (const runId of ["run_a", "run_b"]) {
      journal.registerRunLifecycle({
        run_id: runId,
        session_id: `sess_${runId}`,
        workflow_name: "workflow",
        agent_framework: "cli",
        agent_name: "agentgit-cli",
        workspace_roots: ["/workspace/project"],
        client_metadata: {},
        budget_config: {
          max_mutating_actions: null,
          max_destructive_actions: null,
        },
        created_at: "2026-03-29T12:00:00.000Z",
      });
    }

    const runs = journal.listAllRuns();

    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.run_id)).toEqual(["run_a", "run_b"]);
  });

  it("claims, completes, and replays idempotent mutations durably", () => {
    const journal = makeJournal();

    const claimed = journal.claimIdempotentMutation({
      session_id: "sess_idem",
      idempotency_key: "idem_1",
      method: "run_maintenance",
      payload: {
        job_types: ["capability_refresh"],
      },
      stored_at: "2026-03-31T12:00:00.000Z",
    });
    expect(claimed.status).toBe("claimed");

    journal.completeIdempotentMutation({
      session_id: "sess_idem",
      idempotency_key: "idem_1",
      response: {
        api_version: "authority.v1",
        request_id: "req_original",
        session_id: "sess_idem",
        ok: true,
        result: {
          accepted_priority: "administrative",
          scope: null,
          jobs: [],
          stream_id: null,
        },
        error: null,
      },
      completed_at: "2026-03-31T12:00:01.000Z",
    });

    const replay = journal.claimIdempotentMutation({
      session_id: "sess_idem",
      idempotency_key: "idem_1",
      method: "run_maintenance",
      payload: {
        job_types: ["capability_refresh"],
      },
      stored_at: "2026-03-31T12:00:02.000Z",
    });

    expect(replay.status).toBe("replay");
    if (replay.status === "replay") {
      expect(replay.record.response.request_id).toBe("req_original");
      expect(replay.record.response.result).toEqual({
        accepted_priority: "administrative",
        scope: null,
        jobs: [],
        stream_id: null,
      });
    }
  });

  it("fails closed when an idempotency key is reused for a different payload", () => {
    const journal = makeJournal();

    const claimed = journal.claimIdempotentMutation({
      session_id: "sess_idem",
      idempotency_key: "idem_conflict",
      method: "register_run",
      payload: {
        workflow_name: "one",
      },
      stored_at: "2026-03-31T12:00:00.000Z",
    });
    expect(claimed.status).toBe("claimed");

    const conflict = journal.claimIdempotentMutation({
      session_id: "sess_idem",
      idempotency_key: "idem_conflict",
      method: "register_run",
      payload: {
        workflow_name: "two",
      },
      stored_at: "2026-03-31T12:00:01.000Z",
    });

    expect(conflict.status).toBe("conflict");
    if (conflict.status === "conflict") {
      expect(conflict.request_method).toBe("register_run");
      expect(conflict.record).toBeNull();
    }
  });

  it("throws a not found error when appending to a missing run", () => {
    const journal = makeJournal();

    expect(() =>
      journal.appendRunEvent("run_missing", {
        event_type: "action.normalized",
        occurred_at: "2026-03-29T12:00:01.000Z",
        recorded_at: "2026-03-29T12:00:01.000Z",
      }),
    ).toThrow(NotFoundError);
  });

  it("stores artifacts durably and reads them back after reopening the journal", () => {
    const journal = makeJournal();
    journal.registerRunLifecycle({
      run_id: "run_artifact",
      session_id: "sess_artifact",
      workflow_name: "workflow",
      agent_framework: "cli",
      agent_name: "agentgit-cli",
      workspace_roots: ["/workspace/project"],
      client_metadata: {},
      budget_config: {
        max_mutating_actions: null,
        max_destructive_actions: null,
      },
      created_at: "2026-03-29T12:00:00.000Z",
    });

    journal.storeArtifact({
      artifact_id: "artifact_stdout_1",
      run_id: "run_artifact",
      action_id: "act_artifact",
      execution_id: "exec_artifact",
      type: "stdout",
      content_ref: "inline://exec_artifact/stdout",
      byte_size: 12,
      visibility: "internal",
      expires_at: null,
      expired_at: null,
      created_at: "2026-03-29T12:00:01.000Z",
      content: "hello world\n",
    });
    journal.close();

    currentJournal = createRunJournal({
      dbPath: path.join(currentDir!, "authority.db"),
    });

    const artifact = currentJournal.getArtifact("artifact_stdout_1");

    expect(artifact.execution_id).toBe("exec_artifact");
    expect(artifact.visibility).toBe("internal");
    expect(artifact.artifact_status).toBe("available");
    expect(artifact.integrity).toEqual({
      schema_version: "artifact-integrity.v1",
      digest_algorithm: "sha256",
      digest: crypto.createHash("sha256").update("hello world\n", "utf8").digest("hex"),
    });
    expect(artifact.content).toBe("hello world\n");
  });

  it("changes the run artifact state digest when a durable artifact blob disappears without new events", () => {
    const journal = makeJournal();
    journal.registerRunLifecycle({
      run_id: "run_artifact_digest",
      session_id: "sess_artifact_digest",
      workflow_name: "workflow",
      agent_framework: "cli",
      agent_name: "agentgit-cli",
      workspace_roots: ["/workspace/project"],
      client_metadata: {},
      budget_config: {
        max_mutating_actions: null,
        max_destructive_actions: null,
      },
      created_at: "2026-03-29T12:00:00.000Z",
    });

    const artifactId = "artifact_digest_stdout_1";
    journal.storeArtifact({
      artifact_id: artifactId,
      run_id: "run_artifact_digest",
      action_id: "act_artifact_digest",
      execution_id: "exec_artifact_digest",
      type: "stdout",
      content_ref: "inline://exec_artifact_digest/stdout",
      byte_size: 5,
      visibility: "internal",
      expires_at: null,
      expired_at: null,
      created_at: "2026-03-29T12:00:01.000Z",
      content: "hello",
    });

    const availableDigest = journal.getRunArtifactStateDigest("run_artifact_digest");
    const digest = crypto.createHash("sha256").update(artifactId).digest("hex");
    const artifactPath = path.join(
      currentDir!,
      "artifacts",
      digest.slice(0, 2),
      digest.slice(2, 4),
      `${artifactId}.txt`,
    );
    fs.rmSync(artifactPath, { force: true });

    const missingDigest = journal.getRunArtifactStateDigest("run_artifact_digest");

    expect(availableDigest).not.toBe(missingDigest);
    expect(journal.getArtifactStatus(artifactId)).toBe("missing");
  });

  it("surfaces low-disk artifact writes as retryable storage failures", () => {
    const journal = makeJournal();
    journal.registerRunLifecycle({
      run_id: "run_artifact_low_disk",
      session_id: "sess_artifact_low_disk",
      workflow_name: "workflow",
      agent_framework: "cli",
      agent_name: "agentgit-cli",
      workspace_roots: ["/workspace/project"],
      client_metadata: {},
      budget_config: {
        max_mutating_actions: null,
        max_destructive_actions: null,
      },
      created_at: "2026-03-29T12:00:00.000Z",
    });

    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      const error = new Error("no space left on device") as NodeJS.ErrnoException;
      error.code = "ENOSPC";
      throw error;
    });

    try {
      journal.storeArtifact({
        artifact_id: "artifact_low_disk",
        run_id: "run_artifact_low_disk",
        action_id: "act_artifact_low_disk",
        execution_id: "exec_artifact_low_disk",
        type: "stdout",
        content_ref: "inline://exec_artifact_low_disk/stdout",
        byte_size: 5,
        visibility: "internal",
        expires_at: null,
        expired_at: null,
        created_at: "2026-03-29T12:00:01.000Z",
        content: "hello",
      });
      throw new Error("expected low-disk artifact write to throw");
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

  it("retries artifact capture once after purging expired artifacts under low disk pressure", () => {
    const journal = makeJournal();
    journal.registerRunLifecycle({
      run_id: "run_artifact_recover",
      session_id: "sess_artifact_recover",
      workflow_name: "workflow",
      agent_framework: "cli",
      agent_name: "agentgit-cli",
      workspace_roots: ["/workspace/project"],
      client_metadata: {},
      budget_config: {
        max_mutating_actions: null,
        max_destructive_actions: null,
      },
      created_at: "2026-03-29T12:00:00.000Z",
    });

    const retentionSpy = vi
      .spyOn(journal, "enforceArtifactRetention")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1)
      .mockReturnValue(0);
    const writeSpy = vi.spyOn(fs, "writeFileSync");
    writeSpy
      .mockImplementationOnce(() => {
        const error = new Error("no space left on device") as NodeJS.ErrnoException;
        error.code = "ENOSPC";
        throw error;
      })
      .mockImplementationOnce(fs.writeFileSync);

    try {
      const integrity = journal.storeArtifact({
        artifact_id: "artifact_retry_after_purge",
        run_id: "run_artifact_recover",
        action_id: "act_artifact_recover",
        execution_id: "exec_artifact_recover",
        type: "stdout",
        content_ref: "inline://exec_artifact_recover/stdout",
        byte_size: 5,
        visibility: "internal",
        expires_at: null,
        expired_at: null,
        created_at: "2026-03-29T12:00:01.000Z",
        content: "hello",
      });

      expect(integrity.digest_algorithm).toBe("sha256");
      expect(journal.getArtifact("artifact_retry_after_purge").artifact_status).toBe("available");
      expect(retentionSpy).toHaveBeenCalledTimes(3);
    } finally {
      retentionSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });

  it("removes unreferenced artifact blobs without sweeping referenced degraded evidence", () => {
    const journal = makeJournal();
    journal.registerRunLifecycle({
      run_id: "run_artifact_orphans",
      session_id: "sess_artifact_orphans",
      workflow_name: "workflow",
      agent_framework: "cli",
      agent_name: "agentgit-cli",
      workspace_roots: ["/workspace/project"],
      client_metadata: {},
      budget_config: {
        max_mutating_actions: null,
        max_destructive_actions: null,
      },
      created_at: "2026-03-29T12:00:00.000Z",
    });

    journal.storeArtifact({
      artifact_id: "artifact_referenced_tampered",
      run_id: "run_artifact_orphans",
      action_id: "act_artifact_orphans",
      execution_id: "exec_artifact_orphans",
      type: "stdout",
      content_ref: "inline://exec_artifact_orphans/stdout",
      byte_size: 5,
      visibility: "internal",
      expires_at: null,
      expired_at: null,
      created_at: "2026-03-29T12:00:01.000Z",
      content: "hello",
    });

    const referencedDigest = crypto.createHash("sha256").update("artifact_referenced_tampered").digest("hex");
    const referencedPath = path.join(
      currentDir!,
      "artifacts",
      referencedDigest.slice(0, 2),
      referencedDigest.slice(2, 4),
      "artifact_referenced_tampered.txt",
    );
    fs.writeFileSync(referencedPath, "HELLO!", "utf8");

    const orphanPath = path.join(currentDir!, "artifacts", "or", "ph", "artifact_orphaned_blob.txt");
    fs.mkdirSync(path.dirname(orphanPath), { recursive: true });
    fs.writeFileSync(orphanPath, "orphan-data", "utf8");

    const orphanTempPath = path.join(currentDir!, "artifacts", "or", "ph", "artifact_orphaned_blob.txt.tmp");
    fs.writeFileSync(orphanTempPath, "temp", "utf8");

    const summary = journal.cleanupOrphanedArtifacts();

    expect(summary).toEqual({
      files_scanned: 3,
      referenced_files: 1,
      orphaned_files_removed: 2,
      bytes_freed: Buffer.byteLength("orphan-data", "utf8") + Buffer.byteLength("temp", "utf8"),
      empty_directories_removed: 2,
    });
    expect(fs.existsSync(referencedPath)).toBe(true);
    expect(fs.existsSync(orphanPath)).toBe(false);
    expect(fs.existsSync(orphanTempPath)).toBe(false);
    expect(journal.getArtifact("artifact_referenced_tampered").artifact_status).toBe("tampered");
  });

  it("summarizes artifact health and degraded evidence signals in run maintenance status", () => {
    const journal = makeJournal();
    journal.registerRunLifecycle({
      run_id: "run_maintenance",
      session_id: "sess_maintenance",
      workflow_name: "workflow",
      agent_framework: "cli",
      agent_name: "agentgit-cli",
      workspace_roots: ["/workspace/project"],
      client_metadata: {},
      budget_config: {
        max_mutating_actions: null,
        max_destructive_actions: null,
      },
      created_at: "2026-03-29T12:00:00.000Z",
    });

    journal.storeArtifact({
      artifact_id: "artifact_available",
      run_id: "run_maintenance",
      action_id: "act_maintenance",
      execution_id: "exec_maintenance",
      type: "stdout",
      content_ref: "inline://exec_maintenance/stdout",
      byte_size: 3,
      visibility: "internal",
      expires_at: null,
      expired_at: null,
      created_at: "2026-03-29T12:00:01.000Z",
      content: "one",
    });
    journal.storeArtifact({
      artifact_id: "artifact_missing_status",
      run_id: "run_maintenance",
      action_id: "act_maintenance",
      execution_id: "exec_maintenance",
      type: "stdout",
      content_ref: "inline://exec_maintenance/stdout2",
      byte_size: 3,
      visibility: "internal",
      expires_at: null,
      expired_at: null,
      created_at: "2026-03-29T12:00:01.000Z",
      content: "two",
    });
    journal.storeArtifact({
      artifact_id: "artifact_expired_status",
      run_id: "run_maintenance",
      action_id: "act_maintenance",
      execution_id: "exec_maintenance",
      type: "stdout",
      content_ref: "inline://exec_maintenance/stdout3",
      byte_size: 5,
      visibility: "internal",
      expires_at: null,
      expired_at: null,
      created_at: "2026-03-29T12:00:01.000Z",
      content: "three",
    });

    const missingDigest = crypto.createHash("sha256").update("artifact_missing_status").digest("hex");
    fs.rmSync(
      path.join(
        currentDir!,
        "artifacts",
        missingDigest.slice(0, 2),
        missingDigest.slice(2, 4),
        "artifact_missing_status.txt",
      ),
      { force: true },
    );
    const rawDb = new Database(path.join(currentDir!, "authority.db"));
    rawDb
      .prepare("UPDATE artifacts SET expires_at = ?, expired_at = ? WHERE artifact_id = ?")
      .run("2026-03-29T12:00:01.000Z", "2026-03-29T12:00:01.000Z", "artifact_expired_status");
    rawDb.close();

    journal.appendRunEvent("run_maintenance", {
      event_type: "execution.completed",
      occurred_at: "2026-03-29T12:00:02.000Z",
      recorded_at: "2026-03-29T12:00:02.000Z",
      payload: {
        action_id: "act_maintenance",
        execution_id: "exec_maintenance",
        artifact_capture_failed_count: 1,
        artifact_capture_failures: [
          {
            artifact_id: "artifact_lost",
            type: "stdout",
            code: "STORAGE_UNAVAILABLE",
            retryable: true,
            low_disk_pressure: true,
          },
        ],
      },
    });

    const summary = journal.getRunSummary("run_maintenance");
    const diagnostics = journal.getDiagnosticsOverview();

    expect(summary?.maintenance_status.degraded_artifact_capture_actions).toBe(1);
    expect(summary?.maintenance_status.low_disk_pressure_signals).toBe(1);
    expect(summary?.maintenance_status.artifact_health.total).toBe(3);
    expect(summary?.maintenance_status.artifact_health.available).toBe(1);
    expect(summary?.maintenance_status.artifact_health.missing).toBe(1);
    expect(summary?.maintenance_status.artifact_health.expired).toBe(1);
    expect(diagnostics.maintenance_status.degraded_artifact_capture_actions).toBe(1);
    expect(diagnostics.maintenance_status.low_disk_pressure_signals).toBe(1);
    expect(diagnostics.maintenance_status.artifact_health.total).toBe(3);
    expect(diagnostics.total_runs).toBe(1);
    expect(diagnostics.total_events).toBeGreaterThan(0);
  });

  it("stores and reloads the latest capability snapshot durably", () => {
    const journal = makeJournal();

    journal.storeCapabilitySnapshot({
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
          capability_name: "adapter.tickets_brokered_credentials",
          status: "unavailable",
          scope: "adapter",
          detected_at: "2026-03-31T12:00:00.000Z",
          source: "session_env",
          details: {
            integration: "tickets",
          },
        },
      ],
      detection_timestamps: {
        started_at: "2026-03-31T12:00:00.000Z",
        completed_at: "2026-03-31T12:00:01.000Z",
      },
      degraded_mode_warnings: [
        "Owned ticket mutations are unavailable until brokered ticket credentials are configured.",
      ],
      workspace_root: "/tmp/workspace",
      refreshed_at: "2026-03-31T12:00:01.000Z",
    });

    expect(journal.getCapabilitySnapshot()).toEqual({
      capabilities: [
        expect.objectContaining({
          capability_name: "host.runtime_storage",
          status: "available",
        }),
        expect.objectContaining({
          capability_name: "adapter.tickets_brokered_credentials",
          status: "unavailable",
        }),
      ],
      detection_timestamps: {
        started_at: "2026-03-31T12:00:00.000Z",
        completed_at: "2026-03-31T12:00:01.000Z",
      },
      degraded_mode_warnings: [
        "Owned ticket mutations are unavailable until brokered ticket credentials are configured.",
      ],
      workspace_root: "/tmp/workspace",
      refreshed_at: "2026-03-31T12:00:01.000Z",
    });
    journal.close();

    currentJournal = createRunJournal({
      dbPath: path.join(currentDir!, "authority.db"),
    });

    const reloadedSnapshot = currentJournal.getCapabilitySnapshot();
    expect(reloadedSnapshot?.workspace_root).toBe("/tmp/workspace");
    expect(reloadedSnapshot?.capabilities[1]?.capability_name).toBe("adapter.tickets_brokered_credentials");
    expect(currentJournal.getDiagnosticsOverview().capability_snapshot?.degraded_mode_warnings).toEqual([
      "Owned ticket mutations are unavailable until brokered ticket credentials are configured.",
    ]);
  });

  it("throws not found for missing artifact ids", () => {
    const journal = makeJournal();

    expect(() => journal.getArtifact("artifact_missing")).toThrow(NotFoundError);
  });

  it("surfaces missing artifact blobs without deleting their metadata truth", () => {
    const journal = makeJournal();
    journal.registerRunLifecycle({
      run_id: "run_artifact_missing",
      session_id: "sess_artifact_missing",
      workflow_name: "workflow",
      agent_framework: "cli",
      agent_name: "agentgit-cli",
      workspace_roots: ["/workspace/project"],
      client_metadata: {},
      budget_config: {
        max_mutating_actions: null,
        max_destructive_actions: null,
      },
      created_at: "2026-03-29T12:00:00.000Z",
    });

    journal.storeArtifact({
      artifact_id: "artifact_missing_blob",
      run_id: "run_artifact_missing",
      action_id: "act_artifact_missing",
      execution_id: "exec_artifact_missing",
      type: "stdout",
      content_ref: "inline://exec_artifact_missing/stdout",
      byte_size: 4,
      visibility: "internal",
      expires_at: null,
      expired_at: null,
      created_at: "2026-03-29T12:00:01.000Z",
      content: "oops",
    });

    const artifactDir = path.join(currentDir!, "artifacts");
    const digest = crypto.createHash("sha256").update("artifact_missing_blob").digest("hex");
    const artifactPath = path.join(artifactDir, digest.slice(0, 2), digest.slice(2, 4), "artifact_missing_blob.txt");
    fs.rmSync(artifactPath, { force: true });

    expect(journal.getArtifactStatus("artifact_missing_blob")).toBe("missing");
    const artifact = journal.getArtifact("artifact_missing_blob");
    expect(artifact.artifact_status).toBe("missing");
    expect(artifact.content).toBeNull();
  });

  it("expires retained artifacts while preserving metadata truth", () => {
    const journal = makeJournal({ artifactRetentionMs: 0 });
    journal.registerRunLifecycle({
      run_id: "run_artifact_expired",
      session_id: "sess_artifact_expired",
      workflow_name: "workflow",
      agent_framework: "cli",
      agent_name: "agentgit-cli",
      workspace_roots: ["/workspace/project"],
      client_metadata: {},
      budget_config: {
        max_mutating_actions: null,
        max_destructive_actions: null,
      },
      created_at: "2026-03-29T12:00:00.000Z",
    });

    journal.storeArtifact({
      artifact_id: "artifact_expired_blob",
      run_id: "run_artifact_expired",
      action_id: "act_artifact_expired",
      execution_id: "exec_artifact_expired",
      type: "stdout",
      content_ref: "inline://exec_artifact_expired/stdout",
      byte_size: 8,
      visibility: "internal",
      expires_at: null,
      expired_at: null,
      created_at: "2026-03-29T12:00:01.000Z",
      content: "retained",
    });

    const artifactDir = path.join(currentDir!, "artifacts");
    const digest = crypto.createHash("sha256").update("artifact_expired_blob").digest("hex");
    const artifactPath = path.join(artifactDir, digest.slice(0, 2), digest.slice(2, 4), "artifact_expired_blob.txt");

    expect(fs.existsSync(artifactPath)).toBe(false);
    expect(journal.getArtifactStatus("artifact_expired_blob")).toBe("expired");
    const artifact = journal.getArtifact("artifact_expired_blob");
    expect(artifact.artifact_status).toBe("expired");
    expect(artifact.content).toBeNull();
    expect(artifact.expires_at).toBe("2026-03-29T12:00:01.000Z");
    expect(artifact.expired_at).toBe("2026-03-29T12:00:01.000Z");
  });

  it("surfaces corrupted artifact blobs without pretending they are missing", () => {
    const journal = makeJournal();
    journal.registerRunLifecycle({
      run_id: "run_artifact_corrupted",
      session_id: "sess_artifact_corrupted",
      workflow_name: "workflow",
      agent_framework: "cli",
      agent_name: "agentgit-cli",
      workspace_roots: ["/workspace/project"],
      client_metadata: {},
      budget_config: {
        max_mutating_actions: null,
        max_destructive_actions: null,
      },
      created_at: "2026-03-29T12:00:00.000Z",
    });

    journal.storeArtifact({
      artifact_id: "artifact_corrupted_blob",
      run_id: "run_artifact_corrupted",
      action_id: "act_artifact_corrupted",
      execution_id: "exec_artifact_corrupted",
      type: "stdout",
      content_ref: "inline://exec_artifact_corrupted/stdout",
      byte_size: 9,
      visibility: "internal",
      expires_at: null,
      expired_at: null,
      created_at: "2026-03-29T12:00:01.000Z",
      content: "corrupted",
    });

    const artifactDir = path.join(currentDir!, "artifacts");
    const digest = crypto.createHash("sha256").update("artifact_corrupted_blob").digest("hex");
    const artifactPath = path.join(artifactDir, digest.slice(0, 2), digest.slice(2, 4), "artifact_corrupted_blob.txt");
    fs.rmSync(artifactPath, { force: true });
    fs.mkdirSync(artifactPath, { recursive: true });

    expect(journal.getArtifactStatus("artifact_corrupted_blob")).toBe("corrupted");
    const artifact = journal.getArtifact("artifact_corrupted_blob");
    expect(artifact.artifact_status).toBe("corrupted");
    expect(artifact.content).toBeNull();
  });

  it("surfaces readable digest-mismatched artifacts as tampered", () => {
    const journal = makeJournal();
    journal.registerRunLifecycle({
      run_id: "run_artifact_tampered",
      session_id: "sess_artifact_tampered",
      workflow_name: "workflow",
      agent_framework: "cli",
      agent_name: "agentgit-cli",
      workspace_roots: ["/workspace/project"],
      client_metadata: {},
      budget_config: {
        max_mutating_actions: null,
        max_destructive_actions: null,
      },
      created_at: "2026-03-29T12:00:00.000Z",
    });

    journal.storeArtifact({
      artifact_id: "artifact_tampered_blob",
      run_id: "run_artifact_tampered",
      action_id: "act_artifact_tampered",
      execution_id: "exec_artifact_tampered",
      type: "stdout",
      content_ref: "inline://exec_artifact_tampered/stdout",
      byte_size: 9,
      visibility: "internal",
      expires_at: null,
      expired_at: null,
      created_at: "2026-03-29T12:00:01.000Z",
      content: "original!",
    });

    const artifactDir = path.join(currentDir!, "artifacts");
    const digest = crypto.createHash("sha256").update("artifact_tampered_blob").digest("hex");
    const artifactPath = path.join(artifactDir, digest.slice(0, 2), digest.slice(2, 4), "artifact_tampered_blob.txt");
    fs.writeFileSync(artifactPath, "tampered!", "utf8");

    expect(journal.getArtifactStatus("artifact_tampered_blob")).toBe("tampered");
    const artifact = journal.getArtifact("artifact_tampered_blob");
    expect(artifact.artifact_status).toBe("tampered");
    expect(artifact.integrity).toEqual({
      schema_version: "artifact-integrity.v1",
      digest_algorithm: "sha256",
      digest: crypto.createHash("sha256").update("original!", "utf8").digest("hex"),
    });
    expect(artifact.content).toBeNull();
  });

  it("builds a policy calibration report with approvals, recovery, and samples", () => {
    const journal = makeJournal();
    journal.registerRunLifecycle({
      run_id: "run_policy_calibration",
      session_id: "sess_policy_calibration",
      workflow_name: "workflow",
      agent_framework: "cli",
      agent_name: "agentgit-cli",
      workspace_roots: ["/workspace/project"],
      client_metadata: {},
      budget_config: {
        max_mutating_actions: null,
        max_destructive_actions: null,
      },
      created_at: "2026-03-29T12:00:00.000Z",
    });

    const writeAction = makeAction("act_write", "run_policy_calibration", "filesystem/write");
    const writeOutcome = makePolicyOutcome("act_write", "allow_with_snapshot", ["builtin.fs.snapshot"]);
    journal.appendRunEvent("run_policy_calibration", {
      event_type: "policy.evaluated",
      occurred_at: writeOutcome.evaluated_at,
      recorded_at: writeOutcome.evaluated_at,
      payload: {
        action_id: writeAction.action_id,
        policy_outcome_id: writeOutcome.policy_outcome_id,
        evaluated_at: writeOutcome.evaluated_at,
        decision: writeOutcome.decision,
        reasons: writeOutcome.reasons,
        matched_rules: writeOutcome.policy_context.matched_rules,
        normalization_confidence: writeAction.normalization.normalization_confidence,
        action_family: `${writeAction.operation.domain}/${writeAction.operation.kind}`,
        snapshot_required: true,
        snapshot_selection: {
          snapshot_class: "journal_plus_anchor",
        },
      },
    });

    const shellAction = makeAction("act_shell", "run_policy_calibration", "shell/exec");
    const shellOutcome = makePolicyOutcome("act_shell", "ask", ["builtin.shell.ask"]);
    journal.appendRunEvent("run_policy_calibration", {
      event_type: "policy.evaluated",
      occurred_at: shellOutcome.evaluated_at,
      recorded_at: shellOutcome.evaluated_at,
      payload: {
        action_id: shellAction.action_id,
        policy_outcome_id: shellOutcome.policy_outcome_id,
        evaluated_at: shellOutcome.evaluated_at,
        decision: shellOutcome.decision,
        reasons: shellOutcome.reasons,
        matched_rules: shellOutcome.policy_context.matched_rules,
        normalization_confidence: shellAction.normalization.normalization_confidence,
        action_family: `${shellAction.operation.domain}/${shellAction.operation.kind}`,
        snapshot_required: false,
        snapshot_selection: null,
      },
    });

    const approval = journal.createApprovalRequest({
      run_id: "run_policy_calibration",
      action: shellAction,
      policy_outcome: shellOutcome,
    });
    const resolvedApproval = journal.resolveApproval(approval.approval_id, "approved", "looks safe");
    expect(resolvedApproval.status).toBe("approved");

    journal.appendRunEvent("run_policy_calibration", {
      event_type: "recovery.executed",
      occurred_at: "2026-03-29T12:05:00.000Z",
      recorded_at: "2026-03-29T12:05:00.000Z",
      payload: {
        action_id: writeAction.action_id,
        outcome: "restored",
        recovery_class: "reversible",
        strategy: "restore_path",
      },
    });

    const report = journal.getPolicyCalibrationReport({
      run_id: "run_policy_calibration",
      include_samples: true,
      sample_limit: 10,
    });

    expect(report.report.filters.run_id).toBe("run_policy_calibration");
    expect(report.report.totals.sample_count).toBe(2);
    expect(report.report.totals.unique_action_families).toBe(2);
    expect(report.report.totals.decisions.allow_with_snapshot).toBe(1);
    expect(report.report.totals.decisions.ask).toBe(1);
    expect(report.report.totals.approvals.requested).toBe(1);
    expect(report.report.totals.approvals.approved).toBe(1);
    expect(report.report.totals.recovery_attempted_count).toBe(1);
    expect(report.report.samples_truncated).toBe(false);
    expect(report.report.samples).toHaveLength(2);

    const filesystemFamily = report.report.action_families.find(
      (family) => family.action_family === "filesystem/write",
    );
    expect(filesystemFamily).toEqual(
      expect.objectContaining({
        sample_count: 1,
        recovery_attempted_count: 1,
      }),
    );
    expect(filesystemFamily?.snapshot_classes).toEqual([{ key: "journal_plus_anchor", count: 1 }]);
    expect(filesystemFamily?.top_matched_rules).toEqual([{ key: "builtin.fs.snapshot", count: 1 }]);

    const shellSample = report.report.samples?.find((sample) => sample.action_id === "act_shell");
    expect(shellSample).toEqual(
      expect.objectContaining({
        decision: "ask",
        approval_requested: true,
        approval_status: "approved",
        recovery_attempted: false,
      }),
    );

    const writeSample = report.report.samples?.find((sample) => sample.action_id === "act_write");
    expect(writeSample).toEqual(
      expect.objectContaining({
        decision: "allow_with_snapshot",
        snapshot_class: "journal_plus_anchor",
        recovery_attempted: true,
        recovery_result: "restored",
        recovery_class: "reversible",
        recovery_strategy: "restore_path",
      }),
    );
  });
});
