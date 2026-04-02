import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { ActionRecord, PolicyCalibrationReport, PolicyConfig } from "@agentgit/schemas";

import {
  compilePolicyPack,
  DEFAULT_POLICY_PACK,
  evaluatePolicy,
  replayPolicyThresholds,
  recommendPolicyThresholds,
  type PolicyEvaluationContext,
} from "./index.js";

const deterministicFixturePath = new URL("./test-fixtures/deterministic-policy-golden.json", import.meta.url);

interface DeterministicPolicyFixtureCase {
  case_id: string;
  expected: {
    decision: string;
    reason_codes: string[];
  };
}

interface DeterministicPolicyFixture {
  fixture_version: string;
  cases: DeterministicPolicyFixtureCase[];
}

const deterministicFixture: DeterministicPolicyFixture = JSON.parse(
  fs.readFileSync(path.resolve(fileURLToPath(deterministicFixturePath)), "utf8"),
) as DeterministicPolicyFixture;

function makeConfidenceAssessment(score: number): ActionRecord["confidence_assessment"] {
  return {
    engine_version: "test-confidence/v1",
    score,
    band: score >= 0.85 ? "high" : score >= 0.65 ? "guarded" : "low",
    requires_human_review: score < 0.65,
    factors: [
      {
        factor_id: "test_baseline",
        label: "Test baseline",
        kind: "baseline",
        delta: score,
        rationale: "Test confidence baseline.",
      },
    ],
  };
}

function makeAction(overrides: Partial<ActionRecord> = {}): ActionRecord {
  const confidenceScore =
    overrides.confidence_assessment?.score ?? overrides.normalization?.normalization_confidence ?? 0.99;
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
    confidence_assessment: makeConfidenceAssessment(confidenceScore),
    ...overrides,
  };
}

function normalizeOutcome(outcome: ReturnType<typeof evaluatePolicy>) {
  return {
    decision: outcome.decision,
    reason_codes: outcome.reasons.map((reason) => reason.code),
    matched_rules: outcome.policy_context.matched_rules,
    trust_requirements: outcome.trust_requirements,
    preconditions: outcome.preconditions,
  };
}

function findDeterministicCase(caseId: string): DeterministicPolicyFixtureCase {
  const fixtureCase = deterministicFixture.cases.find((entry) => entry.case_id === caseId);
  if (!fixtureCase) {
    throw new Error(
      `Missing deterministic policy fixture case '${caseId}'. Available cases: ${deterministicFixture.cases
        .map((entry) => entry.case_id)
        .join(", ")}`,
    );
  }
  return fixtureCase;
}

function makeBudgetContext(
  overrides: Partial<NonNullable<PolicyEvaluationContext["run_summary"]>> = {},
): PolicyEvaluationContext {
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

function makeShellReadOnlyAction(confidence = 0.42): ActionRecord {
  return makeAction({
    actor: {
      type: "agent",
      agent_name: "test-agent",
      agent_framework: "test-framework",
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
        type: "path",
        locator: "/workspace/project",
        label: "project",
      },
      scope: {
        breadth: "single",
        estimated_count: 1,
        unknowns: [],
      },
    },
    risk_hints: {
      side_effect_level: "read_only",
      external_effects: "none",
      reversibility_hint: "reversible",
      sensitivity_hint: "low",
      batch: false,
    },
    facets: {
      shell: {
        command_family: "readonly_known_safe",
      },
    },
    normalization: {
      mapper: "test",
      inferred_fields: [],
      warnings: [],
      normalization_confidence: confidence,
    },
  });
}

function makeOwnedNoteAction(confidence = 0.45): ActionRecord {
  return makeAction({
    actor: {
      type: "agent",
      agent_name: "test-agent",
      agent_framework: "test-framework",
      tool_name: "notes_update",
      tool_kind: "function",
    },
    operation: {
      domain: "function",
      kind: "invoke",
      name: "function.invoke",
      display_name: "Update note",
    },
    execution_path: {
      surface: "owned_integration",
      mode: "pre_execution",
      credential_mode: "none",
    },
    target: {
      primary: {
        type: "resource",
        locator: "note:123",
        label: "note",
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
      reversibility_hint: "reversible",
      sensitivity_hint: "low",
      batch: false,
    },
    facets: {
      function: {
        integration: "notes",
        operation: "update_note",
        trusted_compensator: "restore_note",
      },
    },
    normalization: {
      mapper: "test",
      inferred_fields: [],
      warnings: [],
      normalization_confidence: confidence,
    },
  });
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

describe("policy determinism fixtures", () => {
  it("produces stable deny outcomes for protected secret reads", () => {
    const fixtureCase = findDeterministicCase("deny_protected_secret_path");
    const action = makeAction({
      operation: {
        domain: "filesystem",
        kind: "read",
        name: "filesystem.read",
        display_name: "Read file",
      },
      actor: {
        type: "agent",
        agent_name: "test-agent",
        agent_framework: "test-framework",
        tool_name: "read_file",
        tool_kind: "filesystem",
      },
      execution_path: {
        surface: "governed_fs",
        mode: "pre_execution",
        credential_mode: "none",
      },
      target: {
        primary: {
          type: "path",
          locator: "/workspace/project/.env",
          label: ".env",
        },
        scope: {
          breadth: "single",
          estimated_count: 1,
          unknowns: [],
        },
      },
      risk_hints: {
        side_effect_level: "read_only",
        external_effects: "none",
        reversibility_hint: "reversible",
        sensitivity_hint: "high",
        batch: false,
      },
      facets: {
        filesystem: {
          operation: "read",
          byte_length: 0,
        },
      },
    });

    const firstOutcome = normalizeOutcome(evaluatePolicy(action));
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(normalizeOutcome(evaluatePolicy(action))).toEqual(firstOutcome);
    }

    expect(firstOutcome.decision).toBe(fixtureCase.expected.decision);
    expect(firstOutcome.reason_codes).toEqual(fixtureCase.expected.reason_codes);
  });

  it("produces stable ask outcomes when capability state is stale", () => {
    const fixtureCase = findDeterministicCase("ask_capability_state_stale");
    const action = makeAction();
    const context = makeCapabilityContext({
      is_stale: true,
    });

    const firstOutcome = normalizeOutcome(evaluatePolicy(action, context));
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(normalizeOutcome(evaluatePolicy(action, context))).toEqual(firstOutcome);
    }

    expect(firstOutcome.decision).toBe(fixtureCase.expected.decision);
    expect(firstOutcome.reason_codes).toEqual(fixtureCase.expected.reason_codes);
  });

  it("produces stable deny outcomes for direct credentials on brokered ticket actions", () => {
    const fixtureCase = findDeterministicCase("deny_direct_credentials_ticket_broker");
    const action = makeAction({
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
    });

    const firstOutcome = normalizeOutcome(evaluatePolicy(action));
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(normalizeOutcome(evaluatePolicy(action))).toEqual(firstOutcome);
    }

    expect(firstOutcome.decision).toBe(fixtureCase.expected.decision);
    expect(firstOutcome.reason_codes).toEqual(fixtureCase.expected.reason_codes);
  });
});

describe("evaluatePolicy", () => {
  it("should deny filesystem access to protected secret paths from the default policy pack", () => {
    const outcome = evaluatePolicy(
      makeAction({
        operation: {
          domain: "filesystem",
          kind: "read",
          name: "filesystem.read",
          display_name: "Read file",
        },
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "read_file",
          tool_kind: "filesystem",
        },
        execution_path: {
          surface: "governed_fs",
          mode: "pre_execution",
          credential_mode: "none",
        },
        target: {
          primary: {
            type: "path",
            locator: "/workspace/project/.env",
            label: ".env",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "read_only",
          external_effects: "none",
          reversibility_hint: "reversible",
          sensitivity_hint: "high",
          batch: false,
        },
        facets: {
          filesystem: {
            operation: "read",
            byte_length: 0,
          },
        },
      }),
    );

    expect(outcome.decision).toBe("deny");
    expect(outcome.reasons[0]?.code).toBe("PROTECTED_SECRET_PATH_DENIED");
  });

  it("should deny mutation of protected agent configuration surfaces from the default policy pack", () => {
    const outcome = evaluatePolicy(
      makeAction({
        target: {
          primary: {
            type: "path",
            locator: "/workspace/project/.claude/settings.json",
            label: "settings.json",
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
          reversibility_hint: "reversible",
          sensitivity_hint: "high",
          batch: false,
        },
      }),
    );

    expect(outcome.decision).toBe("deny");
    expect(outcome.reasons[0]?.code).toBe("AGENT_CONFIG_MUTATION_DENIED");
  });

  it("should allow small governed writes under 256KB", () => {
    const outcome = evaluatePolicy(makeAction());

    expect(outcome.decision).toBe("allow");
  });

  it("should allow the built-in default policy pack to be compiled explicitly", () => {
    const compiled = compilePolicyPack([DEFAULT_POLICY_PACK]);

    expect(compiled.profile_name).toBe("coding-agent-v1");
    expect(compiled.rules.length).toBeGreaterThan(0);
    expect(compiled.thresholds.low_confidence["filesystem/*"]).toBe(0.3);
    expect(compiled.thresholds.low_confidence["function/*"]).toBe(0.5);
  });

  it("should let require_approval rules strengthen an otherwise allowed action", () => {
    const customPolicy: PolicyConfig = {
      profile_name: "custom-test",
      policy_version: "1",
      rules: [
        {
          rule_id: "runtime.package-json.ask",
          description: "Require approval for package.json writes.",
          rationale: "Dependency manifest edits are operator-reviewed in this test.",
          binding_scope: "runtime_override",
          decision: "allow",
          enforcement_mode: "require_approval",
          priority: 50,
          match: {
            type: "all",
            conditions: [
              {
                type: "field",
                field: "operation.domain",
                operator: "eq",
                value: "filesystem",
              },
              {
                type: "field",
                field: "target.primary.locator",
                operator: "matches",
                value: "/package\\.json$",
              },
            ],
          },
          reason: {
            code: "PACKAGE_MANIFEST_REQUIRES_APPROVAL",
            severity: "high",
            message: "Package manifest writes require approval.",
          },
        },
      ],
    };

    const outcome = evaluatePolicy(
      makeAction({
        target: {
          primary: {
            type: "path",
            locator: "/workspace/project/package.json",
            label: "package.json",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
      }),
      {
        compiled_policy: compilePolicyPack([DEFAULT_POLICY_PACK, customPolicy]),
      },
    );

    expect(outcome.decision).toBe("ask");
    expect(outcome.reasons[0]?.code).toBe("PACKAGE_MANIFEST_REQUIRES_APPROVAL");
  });

  it("should preserve snapshot preconditions when require_approval overlays a snapshot-backed action", () => {
    const customPolicy: PolicyConfig = {
      profile_name: "custom-test",
      policy_version: "1",
      rules: [
        {
          rule_id: "runtime.delete.ask",
          description: "Require approval for deletes.",
          rationale: "Delete operations must be approved by an operator.",
          binding_scope: "runtime_override",
          decision: "allow_with_snapshot",
          enforcement_mode: "require_approval",
          priority: 50,
          match: {
            type: "all",
            conditions: [
              {
                type: "field",
                field: "operation.domain",
                operator: "eq",
                value: "filesystem",
              },
              {
                type: "field",
                field: "operation.kind",
                operator: "eq",
                value: "delete",
              },
            ],
          },
          reason: {
            code: "DELETE_REQUIRES_APPROVAL",
            severity: "high",
            message: "Delete operations require approval.",
          },
        },
      ],
    };

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
      {
        compiled_policy: compilePolicyPack([DEFAULT_POLICY_PACK, customPolicy]),
      },
    );

    expect(outcome.decision).toBe("ask");
    expect(outcome.preconditions.approval_required).toBe(true);
    expect(outcome.preconditions.snapshot_required).toBe(true);
    expect(outcome.reasons[0]?.code).toBe("DELETE_REQUIRES_APPROVAL");
  });

  it("should preserve deny precedence when a lower-priority policy tries to allow the same action", () => {
    const allowPolicy: PolicyConfig = {
      profile_name: "allow-test",
      policy_version: "1",
      rules: [
        {
          rule_id: "workspace.allow-dotenv",
          description: "Attempt to allow dotenv access.",
          rationale: "Test-only conflicting allow.",
          binding_scope: "workspace",
          decision: "allow",
          enforcement_mode: "enforce",
          priority: 5,
          match: {
            type: "field",
            field: "target.primary.locator",
            operator: "matches",
            value: "/\\.env$",
          },
          reason: {
            code: "TEST_ALLOW",
            severity: "low",
            message: "Test allow rule.",
          },
        },
      ],
    };

    const outcome = evaluatePolicy(
      makeAction({
        operation: {
          domain: "filesystem",
          kind: "read",
          name: "filesystem.read",
          display_name: "Read file",
        },
        actor: {
          type: "agent",
          agent_name: "test-agent",
          agent_framework: "test-framework",
          tool_name: "read_file",
          tool_kind: "filesystem",
        },
        target: {
          primary: {
            type: "path",
            locator: "/workspace/project/.env",
            label: ".env",
          },
          scope: {
            breadth: "single",
            estimated_count: 1,
            unknowns: [],
          },
        },
        risk_hints: {
          side_effect_level: "read_only",
          external_effects: "none",
          reversibility_hint: "reversible",
          sensitivity_hint: "high",
          batch: false,
        },
        facets: {
          filesystem: {
            operation: "read",
            byte_length: 0,
          },
        },
      }),
      {
        compiled_policy: compilePolicyPack([DEFAULT_POLICY_PACK, allowPolicy]),
      },
    );

    expect(outcome.decision).toBe("deny");
    expect(outcome.reasons[0]?.code).toBe("PROTECTED_SECRET_PATH_DENIED");
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
    expect(outcome.preconditions.snapshot_required).toBe(true);
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
    expect(outcome.preconditions.snapshot_required).toBe(true);
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

  it("should let explicit low-confidence thresholds strengthen read-only shell actions", () => {
    const customPolicy: PolicyConfig = {
      profile_name: "custom-thresholds",
      policy_version: "1",
      thresholds: {
        low_confidence: [
          {
            action_family: "shell/*",
            ask_below: 0.45,
          },
        ],
      },
      rules: [],
    };

    const outcome = evaluatePolicy(makeShellReadOnlyAction(0.42), {
      compiled_policy: compilePolicyPack([customPolicy, DEFAULT_POLICY_PACK]),
    });

    expect(outcome.decision).toBe("ask");
    expect(outcome.preconditions.approval_required).toBe(true);
  });

  it("should prefer exact action-family thresholds over wildcard thresholds", () => {
    const customPolicy: PolicyConfig = {
      profile_name: "custom-thresholds",
      policy_version: "1",
      thresholds: {
        low_confidence: [
          {
            action_family: "shell/*",
            ask_below: 0.2,
          },
          {
            action_family: "shell/exec",
            ask_below: 0.45,
          },
        ],
      },
      rules: [],
    };

    const outcome = evaluatePolicy(makeShellReadOnlyAction(0.42), {
      compiled_policy: compilePolicyPack([customPolicy, DEFAULT_POLICY_PACK]),
    });

    expect(outcome.decision).toBe("ask");
    expect(outcome.preconditions.approval_required).toBe(true);
  });

  it("should only relax low-confidence gating when explicit policy config lowers the threshold", () => {
    const defaultOutcome = evaluatePolicy(makeOwnedNoteAction(0.45));
    expect(defaultOutcome.decision).toBe("ask");

    const customPolicy: PolicyConfig = {
      profile_name: "custom-thresholds",
      policy_version: "1",
      thresholds: {
        low_confidence: [
          {
            action_family: "function/*",
            ask_below: 0.4,
          },
        ],
      },
      rules: [],
    };

    const relaxedOutcome = evaluatePolicy(makeOwnedNoteAction(0.45), {
      compiled_policy: compilePolicyPack([customPolicy, DEFAULT_POLICY_PACK]),
    });

    expect(relaxedOutcome.decision).toBe("allow_with_snapshot");
    expect(relaxedOutcome.preconditions.snapshot_required).toBe(true);
  });

  it("should recommend tightening thresholds when denied approvals appear above the current threshold", () => {
    const report: PolicyCalibrationReport = {
      generated_at: "2026-04-01T12:00:00.000Z",
      filters: {
        run_id: "run_policy",
        include_samples: true,
        sample_limit: null,
      },
      totals: {
        sample_count: 2,
        unique_action_families: 1,
        confidence: {
          average: 0.38,
          min: 0.34,
          max: 0.42,
        },
        decisions: {
          allow: 0,
          allow_with_snapshot: 0,
          ask: 2,
          deny: 0,
        },
        approvals: {
          requested: 2,
          pending: 0,
          approved: 1,
          denied: 1,
        },
        recovery_attempted_count: 0,
      },
      action_families: [
        {
          action_family: "shell/exec",
          sample_count: 2,
          confidence: {
            average: 0.38,
            min: 0.34,
            max: 0.42,
          },
          decisions: {
            allow: 0,
            allow_with_snapshot: 0,
            ask: 2,
            deny: 0,
          },
          approvals: {
            requested: 2,
            pending: 0,
            approved: 1,
            denied: 1,
          },
          snapshot_classes: [],
          top_matched_rules: [],
          top_reason_codes: [],
          recovery_attempted_count: 0,
          approval_rate: 1,
          denial_rate: 0.5,
        },
      ],
      samples: [
        {
          sample_id: "a",
          run_id: "run_policy",
          action_id: "act_1",
          evaluated_at: "2026-04-01T12:00:00.000Z",
          action_family: "shell/exec",
          decision: "ask",
          normalization_confidence: 0.42,
          confidence_score: 0.42,
          matched_rules: [],
          reason_codes: [],
          snapshot_class: null,
          approval_requested: true,
          approval_id: "apr_1",
          approval_status: "denied",
          resolved_at: "2026-04-01T12:01:00.000Z",
          recovery_attempted: false,
          recovery_result: null,
          recovery_class: null,
          recovery_strategy: null,
        },
        {
          sample_id: "b",
          run_id: "run_policy",
          action_id: "act_2",
          evaluated_at: "2026-04-01T12:00:00.000Z",
          action_family: "shell/exec",
          decision: "ask",
          normalization_confidence: 0.34,
          confidence_score: 0.34,
          matched_rules: [],
          reason_codes: [],
          snapshot_class: null,
          approval_requested: true,
          approval_id: "apr_2",
          approval_status: "approved",
          resolved_at: "2026-04-01T12:01:00.000Z",
          recovery_attempted: false,
          recovery_result: null,
          recovery_class: null,
          recovery_strategy: null,
        },
      ],
      samples_truncated: false,
    };

    const recommendations = recommendPolicyThresholds(report, compilePolicyPack([DEFAULT_POLICY_PACK]), {
      min_samples: 2,
    });

    expect(recommendations[0]).toEqual(
      expect.objectContaining({
        action_family: "shell/exec",
        direction: "tighten",
        current_ask_below: 0.3,
        recommended_ask_below: 0.43,
        automatic_live_application_allowed: false,
      }),
    );
  });

  it("should recommend relaxation only as a report when all approvals were granted", () => {
    const report: PolicyCalibrationReport = {
      generated_at: "2026-04-01T12:00:00.000Z",
      filters: {
        run_id: "run_policy",
        include_samples: true,
        sample_limit: null,
      },
      totals: {
        sample_count: 2,
        unique_action_families: 1,
        confidence: {
          average: 0.455,
          min: 0.45,
          max: 0.46,
        },
        decisions: {
          allow: 0,
          allow_with_snapshot: 0,
          ask: 2,
          deny: 0,
        },
        approvals: {
          requested: 2,
          pending: 0,
          approved: 2,
          denied: 0,
        },
        recovery_attempted_count: 0,
      },
      action_families: [
        {
          action_family: "function/invoke",
          sample_count: 2,
          confidence: {
            average: 0.455,
            min: 0.45,
            max: 0.46,
          },
          decisions: {
            allow: 0,
            allow_with_snapshot: 0,
            ask: 2,
            deny: 0,
          },
          approvals: {
            requested: 2,
            pending: 0,
            approved: 2,
            denied: 0,
          },
          snapshot_classes: [],
          top_matched_rules: [],
          top_reason_codes: [],
          recovery_attempted_count: 0,
          approval_rate: 1,
          denial_rate: 0,
        },
      ],
      samples: [
        {
          sample_id: "a",
          run_id: "run_policy",
          action_id: "act_1",
          evaluated_at: "2026-04-01T12:00:00.000Z",
          action_family: "function/invoke",
          decision: "ask",
          normalization_confidence: 0.45,
          confidence_score: 0.45,
          matched_rules: [],
          reason_codes: [],
          snapshot_class: null,
          approval_requested: true,
          approval_id: "apr_1",
          approval_status: "approved",
          resolved_at: "2026-04-01T12:01:00.000Z",
          recovery_attempted: false,
          recovery_result: null,
          recovery_class: null,
          recovery_strategy: null,
        },
        {
          sample_id: "b",
          run_id: "run_policy",
          action_id: "act_2",
          evaluated_at: "2026-04-01T12:00:00.000Z",
          action_family: "function/invoke",
          decision: "ask",
          normalization_confidence: 0.46,
          confidence_score: 0.46,
          matched_rules: [],
          reason_codes: [],
          snapshot_class: null,
          approval_requested: true,
          approval_id: "apr_2",
          approval_status: "approved",
          resolved_at: "2026-04-01T12:01:00.000Z",
          recovery_attempted: false,
          recovery_result: null,
          recovery_class: null,
          recovery_strategy: null,
        },
      ],
      samples_truncated: false,
    };

    const recommendations = recommendPolicyThresholds(report, compilePolicyPack([DEFAULT_POLICY_PACK]), {
      min_samples: 2,
    });

    expect(recommendations[0]).toEqual(
      expect.objectContaining({
        action_family: "function/invoke",
        direction: "relax",
        current_ask_below: 0.5,
        recommended_ask_below: 0.44,
        requires_policy_update: true,
        automatic_live_application_allowed: false,
      }),
    );
  });

  it("replays candidate thresholds against recorded actions", () => {
    const action = makeAction({
      action_id: "act_replay",
      normalization: {
        mapper: "test",
        inferred_fields: [],
        warnings: [],
        normalization_confidence: 0.35,
      },
      confidence_assessment: makeConfidenceAssessment(0.35),
      facets: {
        filesystem: {
          operation: "write",
          byte_length: 64,
        },
      },
    });

    const replay = replayPolicyThresholds(
      [
        {
          run_id: "run_policy",
          action_id: "act_replay",
          evaluated_at: "2026-04-01T12:00:00.000Z",
          action_family: "filesystem/write",
          recorded_decision: "allow",
          approval_status: null,
          confidence_score: 0.35,
          low_confidence_threshold: 0.3,
          confidence_triggered: false,
          action,
        },
      ],
      compilePolicyPack([DEFAULT_POLICY_PACK]),
      [
        {
          action_family: "filesystem/write",
          ask_below: 0.4,
        },
      ],
      {
        include_changed_samples: true,
      },
    );

    expect(replay.summary.changed_decisions).toBe(1);
    expect(replay.summary.approvals_increased).toBe(1);
    expect(replay.summary.historically_allowed_newly_gated).toBe(1);
    expect(replay.changed_samples).toEqual([
      expect.objectContaining({
        action_id: "act_replay",
        current_decision: "allow",
        candidate_decision: "ask",
        change_kind: "historical_allow_now_gated",
        candidate_confidence_triggered: true,
      }),
    ]);
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

  it("denies execution for quarantined MCP profiles", () => {
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
          name: "mcp.mcpprof_123.echo_note",
          display_name: "Call MCP tool mcpprof_123/echo_note",
        },
        execution_path: {
          surface: "mcp_proxy",
          mode: "pre_execution",
          credential_mode: "brokered",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "mcp://server/mcpprof_123/tools/echo_note",
            label: "mcpprof_123/echo_note",
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
            server_id: "mcpprof_123",
            server_profile_id: "mcpprof_123",
            tool_name: "echo_note",
            profile_status: "quarantined",
            drift_state_at_submit: "drifted",
            allowed_execution_modes: ["local_proxy"],
          },
        },
      }),
      {
        mcp_server_registry: {
          servers: [
            {
              server_id: "mcpprof_123",
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
    expect(outcome.reasons[0]?.code).toBe("MCP_PROFILE_QUARANTINED");
  });

  it("denies hosted delegated execution for degraded session token bindings", () => {
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
          name: "mcp.mcpprof_123.echo_note",
          display_name: "Call MCP tool mcpprof_123/echo_note",
        },
        execution_path: {
          surface: "provider_hosted",
          mode: "pre_execution",
          credential_mode: "delegated",
        },
        target: {
          primary: {
            type: "external_object",
            locator: "mcp://server/mcpprof_123/tools/echo_note",
            label: "mcpprof_123/echo_note",
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
            server_id: "mcpprof_123",
            server_profile_id: "mcpprof_123",
            tool_name: "echo_note",
            execution_mode_requested: "hosted_delegated",
            credential_binding_mode: "session_token",
            profile_status: "active",
            drift_state_at_submit: "clean",
            allowed_execution_modes: ["hosted_delegated"],
          },
        },
      }),
      {
        mcp_server_registry: {
          servers: [
            {
              server_id: "mcpprof_123",
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
    expect(outcome.reasons[0]?.code).toBe("MCP_AUTH_BINDING_MISSING");
  });
});
