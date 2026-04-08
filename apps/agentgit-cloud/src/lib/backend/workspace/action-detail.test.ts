import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionRecordSchema, PolicyOutcomeRecordSchema } from "@agentgit/schemas";
import { RunJournal } from "@agentgit/run-journal";

const { withWorkspaceAuthorityClient } = vi.hoisted(() => ({
  withWorkspaceAuthorityClient: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/backend/authority/client", () => ({
  withWorkspaceAuthorityClient,
}));

import { getActionDetail } from "@/lib/backend/workspace/action-detail";
import { saveWorkspaceConnectionState } from "@/lib/backend/workspace/cloud-state";
import { listDiscoveredRepositoryInventory } from "@/lib/backend/workspace/repository-inventory";

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createRepo(remoteUrl: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-action-detail-"));

  runGit(["init", "-b", "main"], repoRoot);
  runGit(["config", "user.name", "AgentGit Test"], repoRoot);
  runGit(["config", "user.email", "tests@agentgit.dev"], repoRoot);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "# Action detail test repo\n", "utf8");
  runGit(["add", "README.md"], repoRoot);
  runGit(["commit", "-m", "Initial commit"], repoRoot);
  runGit(["remote", "add", "origin", remoteUrl], repoRoot);

  return repoRoot;
}

describe("action detail backend adapter", () => {
  const originalWorkspaceRoots = process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS;
  const originalAgentGitRoot = process.env.AGENTGIT_ROOT;
  const tempDirs: string[] = [];

  afterEach(() => {
    if (originalWorkspaceRoots === undefined) {
      delete process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS;
    } else {
      process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS = originalWorkspaceRoots;
    }

    if (originalAgentGitRoot === undefined) {
      delete process.env.AGENTGIT_ROOT;
    } else {
      process.env.AGENTGIT_ROOT = originalAgentGitRoot;
    }

    for (const tempDir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("surfaces run, approval, policy, and recovery context for an action", async () => {
    const repoRoot = createRepo("git@github.com:acme/platform-ui.git");
    tempDirs.push(repoRoot);
    process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS = repoRoot;
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-state-"));
    tempDirs.push(process.env.AGENTGIT_ROOT);
    const inventory = await listDiscoveredRepositoryInventory();
    await saveWorkspaceConnectionState({
      workspaceId: "ws_acme_01",
      workspaceName: "Acme platform",
      workspaceSlug: "acme-platform",
      repositoryIds: [inventory.items[0]!.id],
      members: [{ name: "Jordan Smith", email: "jordan@acme.dev", role: "owner" }],
      invites: [],
      defaultNotificationChannel: "slack",
      policyPack: "guarded",
      launchedAt: "2026-04-07T15:04:00Z",
    });

    const runId = "run_action_detail";
    const actionId = "act_action_detail";
    const snapshotId = "snap_action_detail";
    const targetPath = path.join(repoRoot, "README.md");
    const repositoryId = inventory.items[0]?.id;
    expect(repositoryId).toBeDefined();

    await saveWorkspaceConnectionState({
      workspaceId: "ws_acme_01",
      workspaceName: "Acme platform",
      workspaceSlug: "acme-platform",
      repositoryIds: [repositoryId!],
      members: [{ name: "Jordan Smith", email: "jordan@acme.dev", role: "owner" }],
      invites: [],
      defaultNotificationChannel: "slack",
      policyPack: "guarded",
      launchedAt: "2026-04-07T18:59:00Z",
    });

    const action = ActionRecordSchema.parse({
      schema_version: "action.v1",
      action_id: actionId,
      run_id: runId,
      session_id: "sess_action_detail",
      status: "normalized",
      timestamps: {
        requested_at: "2026-04-07T19:00:00Z",
        normalized_at: "2026-04-07T19:00:01Z",
      },
      provenance: {
        mode: "governed",
        source: "cloud",
        confidence: 0.93,
      },
      actor: {
        type: "agent",
        agent_name: "AgentGit",
        agent_framework: "authority",
        tool_name: "agentgit",
        tool_kind: "governed_runtime",
      },
      operation: {
        domain: "filesystem",
        kind: "write",
        name: "filesystem/write",
        display_name: "Write README.md",
      },
      execution_path: {
        surface: "governed_fs",
        mode: "pre_execution",
        credential_mode: "brokered",
      },
      target: {
        primary: {
          type: "path",
          locator: targetPath,
          label: "README.md",
        },
        scope: {
          breadth: "single",
          unknowns: [],
        },
      },
      input: {
        raw: { path: targetPath },
        redacted: { path: targetPath },
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
      facets: {},
      normalization: {
        mapper: "test",
        inferred_fields: [],
        warnings: [],
        normalization_confidence: 0.93,
      },
      confidence_assessment: {
        engine_version: "test",
        score: 0.93,
        band: "high",
        requires_human_review: false,
        factors: [],
      },
    });

    const policyOutcome = PolicyOutcomeRecordSchema.parse({
      schema_version: "policy-outcome.v1",
      policy_outcome_id: "pol_action_detail",
      action_id: actionId,
      decision: "allow_with_snapshot",
      reasons: [
        {
          code: "SAFE_TO_RUN",
          severity: "low",
          message: "Safe to run with a snapshot.",
        },
      ],
      trust_requirements: {
        wrapped_path_required: true,
        brokered_credentials_required: false,
        direct_credentials_forbidden: false,
      },
      preconditions: {
        snapshot_required: true,
        approval_required: false,
        simulation_supported: false,
      },
      approval: null,
      budget_effects: {
        budget_check: "passed",
        estimated_cost: 0,
      },
      policy_context: {
        matched_rules: ["repo.default"],
        sticky_decision_applied: false,
      },
      evaluated_at: "2026-04-07T19:00:02Z",
    });

    const journal = new RunJournal({
      dbPath: path.join(repoRoot, ".agentgit", "state", "authority.db"),
    });

    try {
      journal.registerRunLifecycle({
        run_id: runId,
        session_id: "sess_action_detail",
        workflow_name: "operator-action-detail",
        agent_framework: "cloud",
        agent_name: "Codex",
        workspace_roots: [repoRoot],
        client_metadata: {},
        budget_config: {
          max_mutating_actions: null,
          max_destructive_actions: null,
        },
        created_at: "2026-04-07T19:00:00Z",
      });

      journal.appendRunEvent(runId, {
        event_type: "action.normalized",
        occurred_at: action.timestamps.normalized_at,
        recorded_at: action.timestamps.normalized_at,
        payload: {
          action_id: actionId,
          action,
        },
      });

      journal.appendRunEvent(runId, {
        event_type: "policy.evaluated",
        occurred_at: policyOutcome.evaluated_at,
        recorded_at: policyOutcome.evaluated_at,
        payload: {
          action_id: actionId,
          decision: policyOutcome.decision,
          reasons: [
            {
              code: "SAFE_TO_RUN",
              severity: "low",
              message: "Safe to run with a snapshot.",
            },
          ],
          snapshot_required: true,
          approval_required: false,
          matched_rules: policyOutcome.policy_context.matched_rules,
          budget_check: "passed",
        },
      });

      journal.appendRunEvent(runId, {
        event_type: "snapshot.created",
        occurred_at: "2026-04-07T19:00:03Z",
        recorded_at: "2026-04-07T19:00:03Z",
        payload: {
          action_id: actionId,
          snapshot_id: snapshotId,
          snapshot_class: "metadata_only",
          fidelity: "metadata_only",
        },
      });

      journal.appendRunEvent(runId, {
        event_type: "recovery.executed",
        occurred_at: "2026-04-07T19:00:04Z",
        recorded_at: "2026-04-07T19:00:04Z",
        payload: {
          action_id: actionId,
          snapshot_id: snapshotId,
          outcome: "restored",
          recovery_class: "reversible",
          strategy: "restore_snapshot",
        },
      });

      const approval = journal.createApprovalRequest({
        run_id: runId,
        action,
        policy_outcome: policyOutcome,
      });

      const timelineResponse = {
        run_summary: {
          run_id: runId,
          session_id: "sess_action_detail",
          workflow_name: "operator-action-detail",
          agent_framework: "cloud",
          agent_name: "Codex",
          workspace_roots: [repoRoot],
          event_count: 6,
          latest_event: {
            sequence: 6,
            event_type: "approval.requested",
            occurred_at: "2026-04-07T19:00:04Z",
            recorded_at: "2026-04-07T19:00:04Z",
          },
          budget_config: {
            max_mutating_actions: null,
            max_destructive_actions: null,
          },
          budget_usage: {
            mutating_actions: 1,
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
          created_at: "2026-04-07T19:00:00Z",
          started_at: "2026-04-07T19:00:00Z",
        },
        steps: [
          {
            schema_version: "timeline-step.v1",
            step_id: "step_action_detail",
            run_id: runId,
            sequence: 1,
            step_type: "action_step",
            title: "Write README.md",
            status: "completed",
            provenance: "governed",
            action_id: actionId,
            decision: "allow_with_snapshot",
            primary_reason: {
              code: "SAFE_TO_RUN",
              message: "Safe to run with a snapshot.",
            },
            reversibility_class: "reversible",
            confidence: 0.93,
            summary: "Write README.md completed with snapshot coverage.",
            primary_artifacts: [
              {
                artifact_id: "artifact_action_detail",
                artifact_status: "available",
                type: "snapshot",
                label: "Snapshot manifest",
              },
            ],
            artifact_previews: [],
            external_effects: [],
            related: {
              snapshot_id: snapshotId,
              execution_id: "exec_action_detail",
              later_actions_affected: 2,
              overlapping_paths: [targetPath],
              recovery_target_type: "path_subset",
              recovery_target_label: "README.md",
              recovery_scope_paths: [targetPath],
              recovery_strategy: "restore_snapshot",
            },
            occurred_at: "2026-04-07T19:00:01Z",
          },
        ],
        projection_status: "fresh",
        visibility_scope: "internal",
        redactions_applied: 0,
        preview_budget: {
          max_inline_preview_chars: 4_096,
          max_total_inline_preview_chars: 16_384,
          preview_chars_used: 128,
          truncated_previews: 0,
          omitted_previews: 0,
        },
      };

      const helperResponse = {
        answer: "Write README.md details are available.",
        confidence: 0.91,
        primary_reason: {
          code: "STEP_DETAILS",
          message: "The step details explain the action body.",
        },
        visibility_scope: "internal",
        redactions_applied: 0,
        preview_budget: {
          max_inline_preview_chars: 4_096,
          max_total_inline_preview_chars: 16_384,
          preview_chars_used: 24,
          truncated_previews: 0,
          omitted_previews: 0,
        },
        evidence: [
          {
            step_id: "step_action_detail",
            sequence: 1,
            title: "Write README.md",
          },
        ],
        uncertainty: [],
      };

      const policyResponse = {
        ...helperResponse,
        answer: "Policy allowed the write because the action was recoverable and snapshot protected.",
        confidence: 0.95,
        primary_reason: {
          code: "SAFE_TO_RUN",
          message: "The action was allowed with snapshot protection.",
        },
      };

      const authorityClient = {
        queryTimeline: vi.fn().mockResolvedValue(timelineResponse),
        queryHelper: vi
          .fn()
          .mockImplementation(async (_runId: string, questionType: string) =>
            questionType === "step_details" ? helperResponse : policyResponse,
          ),
      };

      withWorkspaceAuthorityClient.mockImplementation(async (_workspaceId, run) => run(authorityClient as never));

      const detail = await getActionDetail("acme", "platform-ui", runId, actionId, "ws_acme_01");

      expect(detail).not.toBeNull();
      expect(detail).toMatchObject({
        id: `${runId}:${actionId}`,
        runId,
        actionId,
        repo: "acme/platform-ui",
        workflowName: "operator-action-detail",
        runContext: {
          sessionId: "sess_action_detail",
          workflowName: "operator-action-detail",
          agentName: "Codex",
          agentFramework: "cloud",
          status: "completed",
          eventCount: 6,
        },
        approvalContext: {
          approvalId: approval.approval_id,
          status: "pending",
          decisionRequested: "approve_or_deny",
          resolutionNote: null,
          actionSummary: "Write README.md",
          primaryReason: {
            code: "SAFE_TO_RUN",
            message: "Safe to run with a snapshot.",
          },
        },
        execution: {
          stepId: "step_action_detail",
          status: "completed",
          stepType: "action_step",
          snapshotId: snapshotId,
          artifactLabels: ["Snapshot manifest"],
          helperSummary: "Write README.md details are available.",
          policyExplanation: "Policy allowed the write because the action was recoverable and snapshot protected.",
          laterActionsAffected: 2,
          overlappingPaths: [targetPath],
        },
      });
      expect(detail?.policyOutcome.reasons[0]).toEqual({
        code: "SAFE_TO_RUN",
        severity: "low",
        message: "Safe to run with a snapshot.",
      });
    } finally {
      journal.close();
    }
  });

  it("falls back to journal-only action detail for minimal normalized events", async () => {
    const repoRoot = createRepo("git@github.com:acme/platform-ui.git");
    tempDirs.push(repoRoot);
    process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS = repoRoot;
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-state-"));
    tempDirs.push(process.env.AGENTGIT_ROOT);

    const repositoryId = (await listDiscoveredRepositoryInventory()).items[0]?.id;
    expect(repositoryId).toBeDefined();

    await saveWorkspaceConnectionState({
      workspaceId: "ws_acme_01",
      workspaceName: "Acme platform",
      workspaceSlug: "acme-platform",
      repositoryIds: [repositoryId!],
      members: [{ name: "Jordan Smith", email: "jordan@acme.dev", role: "owner" }],
      invites: [],
      defaultNotificationChannel: "slack",
      policyPack: "guarded",
      launchedAt: "2026-04-07T18:59:00Z",
    });

    const runId = "run_action_detail_fallback";
    const actionId = "act_action_detail_fallback";
    const targetPath = path.join(repoRoot, "README.md");
    const journal = new RunJournal({ dbPath: path.join(repoRoot, ".agentgit", "state", "authority.db") });

    try {
      journal.registerRunLifecycle({
        run_id: runId,
        session_id: "sess_action_detail_fallback",
        workflow_name: "playwright-snapshot-smoke",
        agent_framework: "cloud",
        agent_name: "Codex",
        workspace_roots: [repoRoot],
        client_metadata: {},
        budget_config: {
          max_mutating_actions: null,
          max_destructive_actions: null,
        },
        created_at: "2026-04-07T15:00:00Z",
      });

      journal.appendRunEvent(runId, {
        event_type: "policy.evaluated",
        occurred_at: "2026-04-07T15:00:01Z",
        recorded_at: "2026-04-07T15:00:01Z",
        payload: {
          action_id: actionId,
          decision: "allow",
          reasons: ["Smoke policy seed"],
          snapshot_required: true,
          approval_required: false,
          matched_rules: ["repo.default"],
        },
      });

      journal.appendRunEvent(runId, {
        event_type: "action.normalized",
        occurred_at: "2026-04-07T15:00:02Z",
        recorded_at: "2026-04-07T15:00:02Z",
        payload: {
          action_id: actionId,
          target_locator: targetPath,
          action: {
            operation: {
              domain: "filesystem",
              kind: "update_file",
              display_name: "Update README.md",
            },
            target: {
              primary: {
                locator: targetPath,
              },
            },
          },
        },
      });

      journal.appendRunEvent(runId, {
        event_type: "execution.completed",
        occurred_at: "2026-04-07T15:00:03Z",
        recorded_at: "2026-04-07T15:00:03Z",
        payload: {
          action_id: actionId,
        },
      });

      const detail = await getActionDetail("acme", "platform-ui", runId, actionId, "ws_acme_01");

      expect(detail).not.toBeNull();
      expect(detail).toMatchObject({
        runId,
        actionId,
        workflowName: "playwright-snapshot-smoke",
        normalizedAction: {
          displayName: "unknown",
          targetLocator: targetPath,
          executionMode: "pre_execution",
        },
        policyOutcome: {
          decision: "allow",
          snapshotRequired: true,
          approvalRequired: false,
        },
        execution: {
          status: "completed",
        },
      });
      expect(detail?.runContext.eventCount).toBe(5);
    } finally {
      journal.close();
    }
  });
});
