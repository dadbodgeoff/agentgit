import { describe, expect, it } from "vitest";

import type { ActionRecord } from "@agentgit/schemas";

import { evaluatePolicy, type PolicyEvaluationContext } from "./index.js";

function makeAction(overrides: Partial<ActionRecord> = {}): ActionRecord {
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
      agent_name: "test-agent",
      agent_framework: "test-framework",
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
        locator: "/workspace/project/src/index.ts",
        label: "index.ts",
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
        byte_length: 128,
      },
    },
    normalization: {
      mapper: "test",
      inferred_fields: [],
      warnings: [],
      normalization_confidence: 0.99,
    },
    ...overrides,
  };
}

function makeBudgetContext(overrides: Partial<NonNullable<PolicyEvaluationContext["run_summary"]>> = {}): PolicyEvaluationContext {
  return {
    run_summary: {
      budget_config: {
        max_mutating_actions: null,
        max_destructive_actions: null,
      },
      budget_usage: {
        mutating_actions: 0,
        destructive_actions: 0,
      },
      ...overrides,
    },
  };
}

function makeCapabilityContext(
  overrides: Partial<NonNullable<PolicyEvaluationContext["cached_capability_state"]>> = {},
): PolicyEvaluationContext {
  return {
    cached_capability_state: {
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
          capability_name: "adapter.tickets_brokered_credentials",
          status: "available",
          scope: "adapter",
          detected_at: "2026-03-29T12:00:00.000Z",
          source: "session_env",
          details: {
            integration: "tickets",
            brokered_profile_configured: true,
          },
        },
        {
          capability_name: "workspace.root_access",
          status: "available",
          scope: "workspace",
          detected_at: "2026-03-29T12:00:00.000Z",
          source: "filesystem_probe",
          details: {
            workspace_root: "/workspace/project",
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
    },
  };
}

describe("evaluatePolicy", () => {
  it("should allow small governed writes under 256KB", () => {
    const outcome = evaluatePolicy(makeAction());

    expect(outcome.decision).toBe("allow");
  });

  it("should require approval for brokered ticket mutations when cached capability state is stale", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "tickets_create",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "create_ticket",
          name: "tickets.create_ticket",
          display_name: "Create external ticket",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "brokered",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "tickets://issue/ticket_existing",
            label: "Ticket ticket_existing",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "tickets",
            operation: "create_ticket",
            trusted_compensator: "tickets.delete_ticket",
          },
        },
      }),
      makeCapabilityContext({
        is_stale: true,
      }),
    );

    expect(outcome.decision).toBe("ask");
    expect(outcome.reasons[0]?.code).toBe("CAPABILITY_STATE_STALE");
    expect(outcome.trust_requirements.brokered_credentials_required).toBe(true);
    expect(outcome.preconditions.approval_required).toBe(true);
  });

  it("should require approval for brokered ticket mutations when cached broker capability is unavailable", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "tickets_create",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "create_ticket",
          name: "tickets.create_ticket",
          display_name: "Create external ticket",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "brokered",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "tickets://issue/ticket_existing",
            label: "Ticket ticket_existing",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "tickets",
            operation: "create_ticket",
            trusted_compensator: "tickets.delete_ticket",
          },
        },
      }),
      makeCapabilityContext({
        capabilities: [
          {
            capability_name: "adapter.tickets_brokered_credentials",
            status: "unavailable",
            scope: "adapter",
            detected_at: "2026-03-29T12:00:00.000Z",
            source: "session_env",
            details: {
              integration: "tickets",
              brokered_profile_configured: false,
            },
          },
        ],
      }),
    );

    expect(outcome.decision).toBe("ask");
    expect(outcome.reasons[0]?.code).toBe("BROKERED_CAPABILITY_UNAVAILABLE");
    expect(outcome.trust_requirements.brokered_credentials_required).toBe(true);
    expect(outcome.preconditions.approval_required).toBe(true);
  });

  it("should require approval for governed filesystem writes when cached workspace capability state is stale", () => {
    const outcome = evaluatePolicy(
      makeAction(),
      makeCapabilityContext({
        is_stale: true,
      }),
    );

    expect(outcome.decision).toBe("ask");
    expect(outcome.reasons[0]?.code).toBe("CAPABILITY_STATE_STALE");
    expect(outcome.preconditions.approval_required).toBe(true);
  });

  it("should require approval when cached workspace access is unavailable for the target path", () => {
    const outcome = evaluatePolicy(
      makeAction(),
      makeCapabilityContext({
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
              workspace_root: "/workspace/project",
              exists: false,
              is_directory: false,
              readable: false,
              writable: false,
            },
          },
        ],
      }),
    );

    expect(outcome.decision).toBe("ask");
    expect(outcome.reasons[0]?.code).toBe("WORKSPACE_CAPABILITY_UNAVAILABLE");
    expect(outcome.preconditions.approval_required).toBe(true);
  });

  it("should require approval for snapshot-backed filesystem mutations when runtime storage is degraded", () => {
    const outcome = evaluatePolicy(
      makeAction({
        operation: {
          domain: "filesystem",
          kind: "delete",
          name: "filesystem.delete",
          display_name: "Delete file",
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
            byte_length: 0,
          },
        },
      }),
      makeCapabilityContext({
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
              workspace_root: "/workspace/project",
              exists: true,
              is_directory: true,
              readable: true,
              writable: true,
            },
          },
        ],
      }),
    );

    expect(outcome.decision).toBe("ask");
    expect(outcome.reasons[0]?.code).toBe("RUNTIME_STORAGE_CAPABILITY_DEGRADED");
    expect(outcome.preconditions.approval_required).toBe(true);
  });

  it("should require approval for snapshot-backed shell mutations when cached capability state is stale", () => {
    const outcome = evaluatePolicy(
      makeAction({
        operation: {
          domain: "shell",
          kind: "exec",
          name: "shell.exec",
          display_name: "Execute shell command",
        },
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "exec_command",
          tool_kind: "shell",
        },
        execution_path: {
          surface: "governed_shell",
          mode: "pre_execution",
          credential_mode: "none",
        },
        target: {
          primary: {
            type: "path",
            locator: "/workspace/project",
            label: "workspace",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "none",
          reversibility_hint: "potentially_reversible",
          sensitivity_hint: "low",
          batch: false,
        },
        facets: {
          shell: {
            command_family: "filesystem_primitive",
          },
        },
      }),
      makeCapabilityContext({
        is_stale: true,
      }),
    );

    expect(outcome.decision).toBe("ask");
    expect(outcome.reasons[0]?.code).toBe("CAPABILITY_STATE_STALE");
    expect(outcome.preconditions.approval_required).toBe(true);
  });

  it("should require snapshot for large governed writes over 256KB", () => {
    const outcome = evaluatePolicy(
      makeAction({
        facets: {
          filesystem: {
            operation: "write",
            byte_length: 300_000,
          },
        },
      }),
    );

    expect(outcome.decision).toBe("allow_with_snapshot");
    expect(outcome.preconditions.snapshot_required).toBe(true);
  });

  it("should require snapshot for delete operations", () => {
    const outcome = evaluatePolicy(
      makeAction({
        operation: {
          domain: "filesystem",
          kind: "delete",
          name: "filesystem.delete",
          display_name: "Delete file",
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
            byte_length: 0,
          },
        },
      }),
    );

    expect(outcome.decision).toBe("allow_with_snapshot");
  });

  it("should deny paths outside workspace when scope is unknown", () => {
    const outcome = evaluatePolicy(
      makeAction({
        target: {
          primary: {
            type: "path",
            locator: "/tmp/outside.ts",
            label: "outside.ts",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: ["scope"],
          },
        },
      }),
    );

    expect(outcome.decision).toBe("deny");
  });

  it("should ask when normalization confidence is below 0.3", () => {
    const outcome = evaluatePolicy(
      makeAction({
        normalization: {
          mapper: "test",
          inferred_fields: [],
          warnings: ["opaque_execution"],
          normalization_confidence: 0.2,
        },
      }),
    );

    expect(outcome.decision).toBe("ask");
    expect(outcome.preconditions.approval_required).toBe(true);
  });

  it("should set snapshot_required true when decision is allow_with_snapshot", () => {
    const outcome = evaluatePolicy(
      makeAction({
        facets: {
          filesystem: {
            operation: "write",
            byte_length: 300_000,
          },
        },
      }),
    );

    expect(outcome.preconditions.snapshot_required).toBe(true);
  });

  it("should set approval_required true when decision is ask", () => {
    const outcome = evaluatePolicy(
      makeAction({
        normalization: {
          mapper: "test",
          inferred_fields: [],
          warnings: ["opaque_execution"],
          normalization_confidence: 0.2,
        },
      }),
    );

    expect(outcome.preconditions.approval_required).toBe(true);
  });

  it("should mark a soft limit when a mutating action consumes the final budget slot", () => {
    const outcome = evaluatePolicy(
      makeAction(),
      makeBudgetContext({
        budget_config: {
          max_mutating_actions: 1,
          max_destructive_actions: null,
        },
      }),
    );

    expect(outcome.decision).toBe("allow");
    expect(outcome.budget_effects.budget_check).toBe("soft_limit");
    expect(outcome.budget_effects.remaining_mutating_actions).toBe(0);
  });

  it("should deny when a destructive action exceeds the destructive budget", () => {
    const outcome = evaluatePolicy(
      makeAction({
        operation: {
          domain: "filesystem",
          kind: "delete",
          name: "filesystem.delete",
          display_name: "Delete file",
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
            byte_length: 0,
          },
        },
      }),
      makeBudgetContext({
        budget_config: {
          max_mutating_actions: null,
          max_destructive_actions: 0,
        },
      }),
    );

    expect(outcome.decision).toBe("deny");
    expect(outcome.budget_effects.budget_check).toBe("hard_limit");
  });

  it("should ask with a package manager specific reason", () => {
    const outcome = evaluatePolicy(
      makeAction({
        operation: {
          domain: "shell",
          kind: "exec",
          name: "shell.exec",
          display_name: "Run shell command",
        },
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "exec_command",
          tool_kind: "shell",
        },
        execution_path: {
          surface: "governed_shell",
          mode: "pre_execution",
          credential_mode: "none",
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: true,
        },
        facets: {
          shell: {
            argv: ["npm", "install"],
            command_family: "package_manager",
          },
        },
        normalization: {
          mapper: "test",
          inferred_fields: [],
          warnings: ["workspace_wide_effects"],
          normalization_confidence: 0.72,
        },
      }),
    );

    expect(outcome.decision).toBe("ask");
    expect(outcome.reasons[0]?.code).toBe("PACKAGE_MANAGER_REQUIRES_APPROVAL");
  });

  it("should allow trusted compensatable draft functions with snapshot protection", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "drafts_create",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "create_draft",
          name: "drafts.create_draft",
          display_name: "Create draft message",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "none",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "drafts://message_draft/draft_act_test",
            label: "Launch plan",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "drafts",
            operation: "create_draft",
            trusted_compensator: "drafts.archive_draft",
          },
        },
      }),
    );

    expect(outcome.decision).toBe("allow_with_snapshot");
    expect(outcome.preconditions.snapshot_required).toBe(true);
    expect(outcome.reasons[0]?.code).toBe("OWNED_FUNCTION_COMPENSATABLE");
  });

  it("should allow trusted compensatable draft archive with snapshot protection", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "drafts_archive",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "archive_draft",
          name: "drafts.archive_draft",
          display_name: "Archive draft message",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "none",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "drafts://message_draft/draft_act_test",
            label: "Draft draft_act_test",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "drafts",
            operation: "archive_draft",
            trusted_compensator: "drafts.unarchive_draft",
          },
        },
      }),
    );

    expect(outcome.decision).toBe("allow_with_snapshot");
    expect(outcome.preconditions.snapshot_required).toBe(true);
    expect(outcome.reasons[0]?.code).toBe("OWNED_FUNCTION_COMPENSATABLE");
  });

  it("should allow trusted compensatable draft delete with snapshot protection", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "drafts_delete",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "delete_draft",
          name: "drafts.delete_draft",
          display_name: "Delete draft message",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "none",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "drafts://message_draft/draft_act_test",
            label: "Draft draft_act_test",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "destructive",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "drafts",
            operation: "delete_draft",
            trusted_compensator: "drafts.restore_draft",
          },
        },
      }),
    );

    expect(outcome.decision).toBe("allow_with_snapshot");
    expect(outcome.preconditions.snapshot_required).toBe(true);
    expect(outcome.reasons[0]?.code).toBe("OWNED_FUNCTION_COMPENSATABLE");
  });

  it("should allow trusted compensatable draft unarchive with snapshot protection", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "drafts_unarchive",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "unarchive_draft",
          name: "drafts.unarchive_draft",
          display_name: "Unarchive draft message",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "none",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "drafts://message_draft/draft_act_test",
            label: "Draft draft_act_test",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "drafts",
            operation: "unarchive_draft",
            trusted_compensator: "drafts.archive_draft",
          },
        },
      }),
    );

    expect(outcome.decision).toBe("allow_with_snapshot");
    expect(outcome.preconditions.snapshot_required).toBe(true);
    expect(outcome.reasons[0]?.code).toBe("OWNED_FUNCTION_COMPENSATABLE");
  });

  it("should allow trusted compensatable draft update with snapshot protection", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "drafts_update",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "update_draft",
          name: "drafts.update_draft",
          display_name: "Update draft message",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "none",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "drafts://message_draft/draft_act_test",
            label: "Draft draft_act_test",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "drafts",
            operation: "update_draft",
            trusted_compensator: "drafts.restore_draft",
          },
        },
      }),
    );

    expect(outcome.decision).toBe("allow_with_snapshot");
    expect(outcome.preconditions.snapshot_required).toBe(true);
    expect(outcome.reasons[0]?.code).toBe("OWNED_FUNCTION_COMPENSATABLE");
  });

  it("should allow trusted compensatable draft restore with snapshot protection", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "drafts_restore",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "restore_draft",
          name: "drafts.restore_draft",
          display_name: "Restore draft message",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "none",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "drafts://message_draft/draft_act_test",
            label: "Draft draft_act_test",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "drafts",
            operation: "restore_draft",
            trusted_compensator: "drafts.restore_draft",
          },
        },
      }),
    );

    expect(outcome.decision).toBe("allow_with_snapshot");
    expect(outcome.preconditions.snapshot_required).toBe(true);
    expect(outcome.reasons[0]?.code).toBe("OWNED_FUNCTION_COMPENSATABLE");
  });

  it("should allow trusted compensatable draft labeling with snapshot protection", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "drafts_add_label",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "add_label",
          name: "drafts.add_label",
          display_name: "Add draft label",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "none",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "drafts://message_draft/draft_act_test/labels/priority%2Fhigh",
            label: "Draft draft_act_test label priority/high",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "drafts",
            operation: "add_label",
            trusted_compensator: "drafts.remove_label",
          },
        },
      }),
    );

    expect(outcome.decision).toBe("allow_with_snapshot");
    expect(outcome.preconditions.snapshot_required).toBe(true);
    expect(outcome.reasons[0]?.code).toBe("OWNED_FUNCTION_COMPENSATABLE");
  });

  it("should allow trusted compensatable draft label removal with snapshot protection", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "drafts_remove_label",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "remove_label",
          name: "drafts.remove_label",
          display_name: "Remove draft label",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "none",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "drafts://message_draft/draft_act_test/labels/priority%2Fhigh",
            label: "Draft draft_act_test label priority/high",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "drafts",
            operation: "remove_label",
            trusted_compensator: "drafts.add_label",
          },
        },
      }),
    );

    expect(outcome.decision).toBe("allow_with_snapshot");
    expect(outcome.preconditions.snapshot_required).toBe(true);
    expect(outcome.reasons[0]?.code).toBe("OWNED_FUNCTION_COMPENSATABLE");
  });

  it("should allow brokered ticket updates with snapshot protection", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "tickets_update",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "update_ticket",
          name: "tickets.update_ticket",
          display_name: "Update external ticket",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "brokered",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "tickets://issue/ticket_existing",
            label: "Ticket ticket_existing",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "tickets",
            operation: "update_ticket",
            trusted_compensator: "tickets.restore_ticket",
          },
        },
      }),
    );

    expect(outcome.decision).toBe("allow_with_snapshot");
    expect(outcome.preconditions.snapshot_required).toBe(true);
    expect(outcome.reasons[0]?.code).toBe("OWNED_FUNCTION_COMPENSATABLE");
    expect(outcome.trust_requirements.brokered_credentials_required).toBe(true);
  });

  it("should deny ticket updates with direct credentials", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "tickets_update",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "update_ticket",
          name: "tickets.update_ticket",
          display_name: "Update external ticket",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "direct",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "tickets://issue/ticket_existing",
            label: "Ticket ticket_existing",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "tickets",
            operation: "update_ticket",
            trusted_compensator: "tickets.restore_ticket",
          },
        },
      }),
    );

    expect(outcome.decision).toBe("deny");
    expect(outcome.reasons[0]?.code).toBe("DIRECT_CREDENTIALS_FORBIDDEN");
    expect(outcome.trust_requirements.direct_credentials_forbidden).toBe(true);
  });

  it("should allow brokered ticket delete with snapshot protection", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "tickets_delete",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "delete_ticket",
          name: "tickets.delete_ticket",
          display_name: "Delete external ticket",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "brokered",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "tickets://issue/ticket_existing",
            label: "Ticket ticket_existing",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "destructive",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "tickets",
            operation: "delete_ticket",
            trusted_compensator: "tickets.restore_ticket",
          },
        },
      }),
    );

    expect(outcome.decision).toBe("allow_with_snapshot");
    expect(outcome.preconditions.snapshot_required).toBe(true);
    expect(outcome.trust_requirements.brokered_credentials_required).toBe(true);
  });

  it("should allow brokered ticket restore with snapshot protection", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "tickets_restore",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "restore_ticket",
          name: "tickets.restore_ticket",
          display_name: "Restore external ticket",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "brokered",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "tickets://issue/ticket_existing",
            label: "Ticket ticket_existing",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "tickets",
            operation: "restore_ticket",
            trusted_compensator: "tickets.restore_ticket",
          },
        },
      }),
    );

    expect(outcome.decision).toBe("allow_with_snapshot");
    expect(outcome.preconditions.snapshot_required).toBe(true);
    expect(outcome.trust_requirements.brokered_credentials_required).toBe(true);
  });

  it("should allow brokered ticket close with snapshot protection", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "tickets_close",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "close_ticket",
          name: "tickets.close_ticket",
          display_name: "Close external ticket",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "brokered",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "tickets://issue/ticket_existing",
            label: "Ticket ticket_existing",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "tickets",
            operation: "close_ticket",
            trusted_compensator: "tickets.reopen_ticket",
          },
        },
      }),
    );

    expect(outcome.decision).toBe("allow_with_snapshot");
    expect(outcome.preconditions.snapshot_required).toBe(true);
    expect(outcome.reasons[0]?.code).toBe("OWNED_FUNCTION_COMPENSATABLE");
    expect(outcome.trust_requirements.brokered_credentials_required).toBe(true);
  });

  it("should deny ticket close with direct credentials", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "tickets_close",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "close_ticket",
          name: "tickets.close_ticket",
          display_name: "Close external ticket",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "direct",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "tickets://issue/ticket_existing",
            label: "Ticket ticket_existing",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "tickets",
            operation: "close_ticket",
            trusted_compensator: "tickets.reopen_ticket",
          },
        },
      }),
    );

    expect(outcome.decision).toBe("deny");
    expect(outcome.reasons[0]?.code).toBe("DIRECT_CREDENTIALS_FORBIDDEN");
    expect(outcome.trust_requirements.direct_credentials_forbidden).toBe(true);
  });

  it("should allow brokered ticket reopen with snapshot protection", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "tickets_reopen",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "reopen_ticket",
          name: "tickets.reopen_ticket",
          display_name: "Reopen external ticket",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "brokered",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "tickets://issue/ticket_existing",
            label: "Ticket ticket_existing",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "tickets",
            operation: "reopen_ticket",
            trusted_compensator: "tickets.close_ticket",
          },
        },
      }),
    );

    expect(outcome.decision).toBe("allow_with_snapshot");
    expect(outcome.preconditions.snapshot_required).toBe(true);
    expect(outcome.reasons[0]?.code).toBe("OWNED_FUNCTION_COMPENSATABLE");
    expect(outcome.trust_requirements.brokered_credentials_required).toBe(true);
  });

  it("should deny ticket reopen with direct credentials", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "tickets_reopen",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "reopen_ticket",
          name: "tickets.reopen_ticket",
          display_name: "Reopen external ticket",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "direct",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "tickets://issue/ticket_existing",
            label: "Ticket ticket_existing",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "tickets",
            operation: "reopen_ticket",
            trusted_compensator: "tickets.close_ticket",
          },
        },
      }),
    );

    expect(outcome.decision).toBe("deny");
    expect(outcome.reasons[0]?.code).toBe("DIRECT_CREDENTIALS_FORBIDDEN");
    expect(outcome.trust_requirements.direct_credentials_forbidden).toBe(true);
  });

  it("should allow brokered ticket labeling with snapshot protection", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "tickets_add_label",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "add_label",
          name: "tickets.add_label",
          display_name: "Add external ticket label",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "brokered",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "tickets://issue/ticket_existing/labels/priority%2Fhigh",
            label: "Ticket ticket_existing label priority/high",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "tickets",
            operation: "add_label",
            trusted_compensator: "tickets.remove_label",
          },
        },
      }),
    );

    expect(outcome.decision).toBe("allow_with_snapshot");
    expect(outcome.preconditions.snapshot_required).toBe(true);
    expect(outcome.reasons[0]?.code).toBe("OWNED_FUNCTION_COMPENSATABLE");
  });

  it("should deny ticket labeling with direct credentials", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "tickets_add_label",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "add_label",
          name: "tickets.add_label",
          display_name: "Add external ticket label",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "direct",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "tickets://issue/ticket_existing/labels/priority%2Fhigh",
            label: "Ticket ticket_existing label priority/high",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "tickets",
            operation: "add_label",
            trusted_compensator: "tickets.remove_label",
          },
        },
      }),
    );

    expect(outcome.decision).toBe("deny");
    expect(outcome.reasons[0]?.code).toBe("DIRECT_CREDENTIALS_FORBIDDEN");
  });

  it("should allow brokered ticket label removal with snapshot protection", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "tickets_remove_label",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "remove_label",
          name: "tickets.remove_label",
          display_name: "Remove external ticket label",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "brokered",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "tickets://issue/ticket_existing/labels/priority%2Fhigh",
            label: "Ticket ticket_existing label priority/high",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "tickets",
            operation: "remove_label",
            trusted_compensator: "tickets.add_label",
          },
        },
      }),
    );

    expect(outcome.decision).toBe("allow_with_snapshot");
    expect(outcome.preconditions.snapshot_required).toBe(true);
    expect(outcome.reasons[0]?.code).toBe("OWNED_FUNCTION_COMPENSATABLE");
    expect(outcome.trust_requirements.brokered_credentials_required).toBe(true);
  });

  it("should deny ticket label removal with direct credentials", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "tickets_remove_label",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "remove_label",
          name: "tickets.remove_label",
          display_name: "Remove external ticket label",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "direct",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "tickets://issue/ticket_existing/labels/priority%2Fhigh",
            label: "Ticket ticket_existing label priority/high",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "tickets",
            operation: "remove_label",
            trusted_compensator: "tickets.add_label",
          },
        },
      }),
    );

    expect(outcome.decision).toBe("deny");
    expect(outcome.reasons[0]?.code).toBe("DIRECT_CREDENTIALS_FORBIDDEN");
  });

  it("should allow brokered ticket assignment with snapshot protection", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "tickets_assign_user",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "assign_user",
          name: "tickets.assign_user",
          display_name: "Assign external ticket user",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "brokered",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "tickets://issue/ticket_existing/assignees/user_123",
            label: "Ticket ticket_existing assignee user_123",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "tickets",
            operation: "assign_user",
            trusted_compensator: "tickets.unassign_user",
          },
        },
      }),
    );

    expect(outcome.decision).toBe("allow_with_snapshot");
    expect(outcome.preconditions.snapshot_required).toBe(true);
    expect(outcome.reasons[0]?.code).toBe("OWNED_FUNCTION_COMPENSATABLE");
    expect(outcome.trust_requirements.brokered_credentials_required).toBe(true);
  });

  it("should deny ticket assignment with direct credentials", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "tickets_assign_user",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "assign_user",
          name: "tickets.assign_user",
          display_name: "Assign external ticket user",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "direct",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "tickets://issue/ticket_existing/assignees/user_123",
            label: "Ticket ticket_existing assignee user_123",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "tickets",
            operation: "assign_user",
            trusted_compensator: "tickets.unassign_user",
          },
        },
      }),
    );

    expect(outcome.decision).toBe("deny");
    expect(outcome.reasons[0]?.code).toBe("DIRECT_CREDENTIALS_FORBIDDEN");
  });

  it("should allow brokered ticket unassignment with snapshot protection", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "tickets_unassign_user",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "unassign_user",
          name: "tickets.unassign_user",
          display_name: "Unassign external ticket user",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "brokered",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "tickets://issue/ticket_existing/assignees/user_123",
            label: "Ticket ticket_existing assignee user_123",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "tickets",
            operation: "unassign_user",
            trusted_compensator: "tickets.assign_user",
          },
        },
      }),
    );

    expect(outcome.decision).toBe("allow_with_snapshot");
    expect(outcome.preconditions.snapshot_required).toBe(true);
    expect(outcome.reasons[0]?.code).toBe("OWNED_FUNCTION_COMPENSATABLE");
    expect(outcome.trust_requirements.brokered_credentials_required).toBe(true);
  });

  it("should deny ticket unassignment with direct credentials", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "tickets_unassign_user",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "unassign_user",
          name: "tickets.unassign_user",
          display_name: "Unassign external ticket user",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "direct",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "tickets://issue/ticket_existing/assignees/user_123",
            label: "Ticket ticket_existing assignee user_123",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "tickets",
            operation: "unassign_user",
            trusted_compensator: "tickets.assign_user",
          },
        },
      }),
    );

    expect(outcome.decision).toBe("deny");
    expect(outcome.reasons[0]?.code).toBe("DIRECT_CREDENTIALS_FORBIDDEN");
  });

  it("should allow trusted compensatable note creation with snapshot protection", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "notes_create",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "create_note",
          name: "notes.create_note",
          display_name: "Create workspace note",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "none",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "notes://workspace_note/note_act_test",
            label: "Launch notes",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "notes",
            operation: "create_note",
            trusted_compensator: "notes.archive_note",
          },
        },
      }),
    );

    expect(outcome.decision).toBe("allow_with_snapshot");
    expect(outcome.preconditions.snapshot_required).toBe(true);
    expect(outcome.reasons[0]?.code).toBe("OWNED_FUNCTION_COMPENSATABLE");
  });

  it("should allow trusted compensatable note archive with snapshot protection", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "notes_archive",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "archive_note",
          name: "notes.archive_note",
          display_name: "Archive workspace note",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "none",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "notes://workspace_note/note_act_test",
            label: "Note note_act_test",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "notes",
            operation: "archive_note",
            trusted_compensator: "notes.unarchive_note",
          },
        },
      }),
    );

    expect(outcome.decision).toBe("allow_with_snapshot");
    expect(outcome.preconditions.snapshot_required).toBe(true);
    expect(outcome.reasons[0]?.code).toBe("OWNED_FUNCTION_COMPENSATABLE");
  });

  it("should allow trusted compensatable note unarchive with snapshot protection", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "notes_unarchive",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "unarchive_note",
          name: "notes.unarchive_note",
          display_name: "Unarchive workspace note",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "none",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "notes://workspace_note/note_act_test",
            label: "Note note_act_test",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "notes",
            operation: "unarchive_note",
            trusted_compensator: "notes.archive_note",
          },
        },
      }),
    );

    expect(outcome.decision).toBe("allow_with_snapshot");
    expect(outcome.preconditions.snapshot_required).toBe(true);
    expect(outcome.reasons[0]?.code).toBe("OWNED_FUNCTION_COMPENSATABLE");
  });

  it("should allow trusted compensatable note update with snapshot protection", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "notes_update",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "update_note",
          name: "notes.update_note",
          display_name: "Update workspace note",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "none",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "notes://workspace_note/note_act_test",
            label: "Note note_act_test",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "notes",
            operation: "update_note",
            trusted_compensator: "notes.restore_note",
          },
        },
      }),
    );

    expect(outcome.decision).toBe("allow_with_snapshot");
    expect(outcome.preconditions.snapshot_required).toBe(true);
    expect(outcome.reasons[0]?.code).toBe("OWNED_FUNCTION_COMPENSATABLE");
  });

  it("should allow trusted compensatable note restore with snapshot protection", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "notes_restore",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "restore_note",
          name: "notes.restore_note",
          display_name: "Restore workspace note",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "none",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "notes://workspace_note/note_act_test",
            label: "Note note_act_test",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "notes",
            operation: "restore_note",
            trusted_compensator: "notes.restore_note",
          },
        },
      }),
    );

    expect(outcome.decision).toBe("allow_with_snapshot");
    expect(outcome.preconditions.snapshot_required).toBe(true);
    expect(outcome.reasons[0]?.code).toBe("OWNED_FUNCTION_COMPENSATABLE");
  });

  it("should allow trusted compensatable note delete with snapshot protection", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "notes_delete",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "delete_note",
          name: "notes.delete_note",
          display_name: "Delete workspace note",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "none",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "notes://workspace_note/note_act_test",
            label: "Note note_act_test",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "destructive",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "notes",
            operation: "delete_note",
            trusted_compensator: "notes.restore_note",
          },
        },
      }),
    );

    expect(outcome.decision).toBe("allow_with_snapshot");
    expect(outcome.preconditions.snapshot_required).toBe(true);
    expect(outcome.reasons[0]?.code).toBe("OWNED_FUNCTION_COMPENSATABLE");
  });

  it("should allow brokered ticket creation with snapshot protection", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "tickets_create",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "create_ticket",
          name: "tickets.create_ticket",
          display_name: "Create external ticket",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "brokered",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "tickets://issue/ticket_act_test",
            label: "Launch blocker",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "tickets",
            operation: "create_ticket",
            trusted_compensator: "tickets.delete_ticket",
          },
        },
      }),
    );

    expect(outcome.decision).toBe("allow_with_snapshot");
    expect(outcome.preconditions.snapshot_required).toBe(true);
    expect(outcome.trust_requirements.brokered_credentials_required).toBe(true);
    expect(outcome.trust_requirements.direct_credentials_forbidden).toBe(true);
  });

  it("should deny direct credentials for owned ticket creation", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "tickets_create",
          tool_kind: "function",
        },
        operation: {
          domain: "function",
          kind: "create_ticket",
          name: "tickets.create_ticket",
          display_name: "Create external ticket",
        },
        execution_path: {
          surface: "sdk_function",
          mode: "pre_execution",
          credential_mode: "direct",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "tickets://issue/ticket_act_test",
            label: "Launch blocker",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "mutating",
          external_effects: "network",
          reversibility_hint: "compensatable",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          function: {
            integration: "tickets",
            operation: "create_ticket",
            trusted_compensator: "tickets.delete_ticket",
          },
        },
      }),
    );

    expect(outcome.decision).toBe("deny");
    expect(outcome.reasons[0]?.code).toBe("DIRECT_CREDENTIALS_FORBIDDEN");
    expect(outcome.trust_requirements.brokered_credentials_required).toBe(true);
    expect(outcome.trust_requirements.direct_credentials_forbidden).toBe(true);
  });

  it("allows an explicitly registered read-only MCP tool", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "mcp_call_tool",
          tool_kind: "mcp",
        },
        operation: {
          domain: "mcp",
          kind: "call_tool",
          name: "mcp.notes_server.echo_note",
          display_name: "Call MCP tool notes_server/echo_note",
        },
        execution_path: {
          surface: "mcp_proxy",
          mode: "pre_execution",
          credential_mode: "none",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "mcp://server/notes_server/tools/echo_note",
            label: "notes_server/echo_note",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "unknown",
          external_effects: "network",
          reversibility_hint: "unknown",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          mcp: {
            server_id: "notes_server",
            tool_name: "echo_note",
          },
        },
      }),
      {
        mcp_server_registry: {
          servers: [
            {
              server_id: "notes_server",
              transport: "stdio",
              command: "node",
              tools: [
                {
                  tool_name: "echo_note",
                  side_effect_level: "read_only",
                  approval_mode: "allow",
                },
              ],
            },
          ],
        },
      },
    );

    expect(outcome.decision).toBe("allow");
    expect(outcome.reasons[0]?.code).toBe("MCP_TOOL_TRUSTED_READ_ONLY");
  });

  it("requires approval for a registered mutating MCP tool", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "mcp_call_tool",
          tool_kind: "mcp",
        },
        operation: {
          domain: "mcp",
          kind: "call_tool",
          name: "mcp.notes_server.delete_remote",
          display_name: "Call MCP tool notes_server/delete_remote",
        },
        execution_path: {
          surface: "mcp_proxy",
          mode: "pre_execution",
          credential_mode: "none",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "mcp://server/notes_server/tools/delete_remote",
            label: "notes_server/delete_remote",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "unknown",
          external_effects: "network",
          reversibility_hint: "unknown",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          mcp: {
            server_id: "notes_server",
            tool_name: "delete_remote",
          },
        },
      }),
      {
        mcp_server_registry: {
          servers: [
            {
              server_id: "notes_server",
              transport: "stdio",
              command: "node",
              tools: [
                {
                  tool_name: "delete_remote",
                  side_effect_level: "destructive",
                },
              ],
            },
          ],
        },
      },
    );

    expect(outcome.decision).toBe("ask");
    expect(outcome.reasons[0]?.code).toBe("MCP_TOOL_APPROVAL_REQUIRED");
    expect(outcome.preconditions.approval_required).toBe(true);
  });

  it("denies direct credentials for governed MCP execution", () => {
    const outcome = evaluatePolicy(
      makeAction({
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "mcp_call_tool",
          tool_kind: "mcp",
        },
        operation: {
          domain: "mcp",
          kind: "call_tool",
          name: "mcp.notes_server.echo_note",
          display_name: "Call MCP tool notes_server/echo_note",
        },
        execution_path: {
          surface: "mcp_proxy",
          mode: "pre_execution",
          credential_mode: "direct",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "mcp://server/notes_server/tools/echo_note",
            label: "notes_server/echo_note",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "unknown",
          external_effects: "network",
          reversibility_hint: "unknown",
          sensitivity_hint: "moderate",
          batch: false,
        },
        facets: {
          mcp: {
            server_id: "notes_server",
            tool_name: "echo_note",
          },
        },
      }),
      {
        mcp_server_registry: {
          servers: [
            {
              server_id: "notes_server",
              transport: "stdio",
              command: "node",
              tools: [
                {
                  tool_name: "echo_note",
                  side_effect_level: "read_only",
                  approval_mode: "allow",
                },
              ],
            },
          ],
        },
      },
    );

    expect(outcome.decision).toBe("deny");
    expect(outcome.reasons[0]?.code).toBe("DIRECT_CREDENTIALS_FORBIDDEN");
  });

});
