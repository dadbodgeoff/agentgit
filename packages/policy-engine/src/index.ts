import path from "node:path";

import {
  type ActionRecord,
  type CapabilityRecord,
  InternalError,
  type McpServerDefinition,
  type PolicyOutcomeRecord,
  type PolicyReason,
  type RunSummary,
} from "@agentgit/schemas";
import { v7 as uuidv7 } from "uuid";

const SAFE_FS_WRITE_BYTES = 256 * 1024;

export interface PolicyEvaluationContext {
  run_summary?: Pick<RunSummary, "budget_config" | "budget_usage">;
  mcp_server_registry?: {
    servers: McpServerDefinition[];
  } | null;
  cached_capability_state?: {
    capabilities: CapabilityRecord[];
    degraded_mode_warnings: string[];
    refreshed_at: string;
    stale_after_ms: number;
    is_stale: boolean;
  } | null;
}

function createPolicyOutcomeId(): string {
  return `pol_${uuidv7().replaceAll("-", "")}`;
}

function makeOutcome(
  action: ActionRecord,
  decision: PolicyOutcomeRecord["decision"],
  reasons: PolicyReason[],
  matchedRules: string[],
  trustRequirements?: Partial<PolicyOutcomeRecord["trust_requirements"]>,
): PolicyOutcomeRecord {
  return {
    schema_version: "policy-outcome.v1",
    policy_outcome_id: createPolicyOutcomeId(),
    action_id: action.action_id,
    decision,
    reasons,
    trust_requirements: {
      wrapped_path_required: true,
      brokered_credentials_required: trustRequirements?.brokered_credentials_required ?? false,
      direct_credentials_forbidden: trustRequirements?.direct_credentials_forbidden ?? false,
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
    evaluated_at: new Date().toISOString(),
  };
}

function makeCapabilityApprovalOutcome(
  action: ActionRecord,
  reason: PolicyReason,
  matchedRule: string,
  trustRequirements?: Partial<PolicyOutcomeRecord["trust_requirements"]>,
): PolicyOutcomeRecord {
  return makeOutcome(
    action,
    "ask",
    [reason],
    [matchedRule],
    trustRequirements,
  );
}

function makeDirectCredentialDenyOutcome(
  action: ActionRecord,
  message: string,
  matchedRule: string,
): PolicyOutcomeRecord {
  return makeOutcome(
    action,
    "deny",
    [
      {
        code: "DIRECT_CREDENTIALS_FORBIDDEN",
        severity: "high",
        message,
      },
    ],
    [matchedRule],
    {
      direct_credentials_forbidden: true,
    },
  );
}

function actionTargetPath(action: ActionRecord): string | null {
  const locator = action.target.primary.locator;
  if (action.target.primary.type !== "path" || !locator) {
    return null;
  }

  return path.resolve(locator);
}

function capabilityWorkspaceRoot(capability: CapabilityRecord): string | null {
  const workspaceRoot = capability.details.workspace_root;
  return typeof workspaceRoot === "string" && workspaceRoot.length > 0 ? path.resolve(workspaceRoot) : null;
}

function isPathWithinWorkspaceRoot(targetPath: string, workspaceRoot: string): boolean {
  return targetPath === workspaceRoot || targetPath.startsWith(`${workspaceRoot}${path.sep}`);
}

function findCapability(capabilities: CapabilityRecord[], capabilityName: string): CapabilityRecord | null {
  return capabilities.find((capability) => capability.capability_name === capabilityName) ?? null;
}

function findWorkspaceCapabilityForAction(action: ActionRecord, capabilities: CapabilityRecord[]): CapabilityRecord | null {
  const targetPath = actionTargetPath(action);
  if (!targetPath) {
    return null;
  }

  return (
    capabilities.find((capability) => {
      if (capability.capability_name !== "workspace.root_access") {
        return false;
      }

      const workspaceRoot = capabilityWorkspaceRoot(capability);
      return workspaceRoot !== null && isPathWithinWorkspaceRoot(targetPath, workspaceRoot);
    }) ?? null
  );
}

function evaluateFilesystemCapabilityState(
  action: ActionRecord,
  context: PolicyEvaluationContext,
  snapshotRequired: boolean,
): PolicyOutcomeRecord | null {
  const capabilityState = context.cached_capability_state;
  if (!capabilityState) {
    return null;
  }

  if (capabilityState.is_stale) {
    return makeCapabilityApprovalOutcome(
      action,
      {
        code: "CAPABILITY_STATE_STALE",
        severity: "high",
        message:
          "Cached workspace capability state is stale; rerun capability_refresh or approve explicitly before automatic execution.",
      },
      "capability.workspace.stale.ask",
    );
  }

  const workspaceCapability = findWorkspaceCapabilityForAction(action, capabilityState.capabilities);
  if (!workspaceCapability) {
    return makeCapabilityApprovalOutcome(
      action,
      {
        code: "CAPABILITY_STATE_INCOMPLETE",
        severity: "high",
        message:
          "Cached capability state did not include governed workspace access for this path; rerun capability_refresh or approve explicitly before automatic execution.",
      },
      "capability.workspace.missing.ask",
    );
  }

  if (workspaceCapability.status !== "available") {
    return makeCapabilityApprovalOutcome(
      action,
      {
        code: "WORKSPACE_CAPABILITY_UNAVAILABLE",
        severity: "high",
        message: `Cached workspace access capability is ${workspaceCapability.status}; rerun capability_refresh or approve explicitly before automatic execution.`,
      },
      "capability.workspace.unavailable.ask",
    );
  }

  if (!snapshotRequired) {
    return null;
  }

  const runtimeStorageCapability = findCapability(capabilityState.capabilities, "host.runtime_storage");
  if (!runtimeStorageCapability) {
    return makeCapabilityApprovalOutcome(
      action,
      {
        code: "CAPABILITY_STATE_INCOMPLETE",
        severity: "high",
        message:
          "Cached capability state did not include runtime snapshot storage readiness; rerun capability_refresh or approve explicitly before automatic execution.",
      },
      "capability.runtime_storage.missing.ask",
    );
  }

  if (runtimeStorageCapability.status !== "available") {
    return makeCapabilityApprovalOutcome(
      action,
      {
        code: "RUNTIME_STORAGE_CAPABILITY_DEGRADED",
        severity: "high",
        message:
          `Cached runtime storage capability is ${runtimeStorageCapability.status}; rerun capability_refresh or approve explicitly before automatic execution that requires snapshot protection.`,
      },
      "capability.runtime_storage.degraded.ask",
    );
  }

  return null;
}

function evaluateShellCapabilityState(action: ActionRecord, context: PolicyEvaluationContext): PolicyOutcomeRecord | null {
  const capabilityState = context.cached_capability_state;
  if (!capabilityState) {
    return null;
  }

  if (capabilityState.is_stale) {
    return makeCapabilityApprovalOutcome(
      action,
      {
        code: "CAPABILITY_STATE_STALE",
        severity: "high",
        message:
          "Cached capability state for snapshot-backed shell execution is stale; rerun capability_refresh or approve explicitly before automatic execution.",
      },
      "capability.shell.stale.ask",
    );
  }

  const runtimeStorageCapability = findCapability(capabilityState.capabilities, "host.runtime_storage");
  if (!runtimeStorageCapability) {
    return makeCapabilityApprovalOutcome(
      action,
      {
        code: "CAPABILITY_STATE_INCOMPLETE",
        severity: "high",
        message:
          "Cached capability state did not include runtime snapshot storage readiness; rerun capability_refresh or approve explicitly before automatic shell execution.",
      },
      "capability.shell.runtime_storage.missing.ask",
    );
  }

  if (runtimeStorageCapability.status !== "available") {
    return makeCapabilityApprovalOutcome(
      action,
      {
        code: "RUNTIME_STORAGE_CAPABILITY_DEGRADED",
        severity: "high",
        message:
          `Cached runtime storage capability is ${runtimeStorageCapability.status}; rerun capability_refresh or approve explicitly before automatic shell execution that requires snapshot protection.`,
      },
      "capability.shell.runtime_storage.degraded.ask",
    );
  }

  return null;
}

function evaluateFilesystem(action: ActionRecord, context: PolicyEvaluationContext): PolicyOutcomeRecord {
  const locator = action.target.primary.locator;
  const normalizationConfidence = action.normalization.normalization_confidence;
  const fsFacet = action.facets.filesystem as { operation?: string; byte_length?: number } | undefined;
  const operation = fsFacet?.operation ?? action.operation.kind;
  const byteLength = fsFacet?.byte_length ?? 0;

  if (normalizationConfidence < 0.3) {
    return makeOutcome(
      action,
      "ask",
      [
        {
          code: "LOW_NORMALIZATION_CONFIDENCE",
          severity: "high",
          message: "Filesystem action could not be normalized confidently.",
        },
      ],
      ["normalization.low_confidence.ask"],
    );
  }

  if (!locator || action.target.scope.unknowns.includes("scope")) {
    return makeOutcome(
      action,
      "deny",
      [
        {
          code: "PATH_NOT_GOVERNED",
          severity: "critical",
          message: "Filesystem path is outside the governed workspace roots.",
        },
      ],
      ["filesystem.outside_workspace.deny"],
    );
  }

  if (operation === "delete") {
    return (
      evaluateFilesystemCapabilityState(action, context, true) ??
      makeOutcome(
        action,
        "allow_with_snapshot",
        [
          {
            code: "FS_DESTRUCTIVE_WORKSPACE_MUTATION",
            severity: "moderate",
            message: "Destructive filesystem mutations require a recovery boundary.",
          },
        ],
        ["filesystem.delete.requires_snapshot"],
      )
    );
  }

  if (byteLength <= SAFE_FS_WRITE_BYTES) {
    return (
      evaluateFilesystemCapabilityState(action, context, false) ??
      makeOutcome(
        action,
        "allow",
        [
          {
            code: "TRUSTED_GOVERNED_FS_WRITE",
            severity: "low",
            message: "Small governed filesystem writes are allowed in safe mode.",
          },
        ],
        ["filesystem.safe.small_write"],
      )
    );
  }

  return (
    evaluateFilesystemCapabilityState(action, context, true) ??
    makeOutcome(
      action,
      "allow_with_snapshot",
      [
        {
          code: "FS_MUTATION_REQUIRES_SNAPSHOT",
          severity: "moderate",
          message: "Large governed filesystem writes require snapshot protection.",
        },
      ],
      ["filesystem.large_write.requires_snapshot"],
    )
  );
}

function evaluateShell(action: ActionRecord, context: PolicyEvaluationContext): PolicyOutcomeRecord {
  const shellFacet = action.facets.shell as { command_family?: string } | undefined;
  const commandFamily = shellFacet?.command_family ?? "unclassified";

  if (action.normalization.normalization_confidence < 0.3) {
    return makeOutcome(
      action,
      "ask",
      [
        {
          code: "UNKNOWN_SCOPE_REQUIRES_APPROVAL",
          severity: "high",
          message: "Shell command scope is opaque and requires approval.",
        },
      ],
      ["shell.unknown_scope.ask"],
    );
  }

  if (action.risk_hints.side_effect_level === "read_only") {
    return makeOutcome(
      action,
      "allow",
      [
        {
          code: "TRUSTED_READONLY_ALLOWED",
          severity: "low",
          message: "Known read-only shell commands are allowed in safe mode.",
        },
      ],
      ["shell.safe.read_only"],
    );
  }

  if (
    action.risk_hints.side_effect_level === "destructive" ||
    (action.risk_hints.side_effect_level === "mutating" &&
      (commandFamily === "filesystem_primitive" || commandFamily === "version_control_mutating"))
  ) {
    return (
      evaluateShellCapabilityState(action, context) ??
      makeOutcome(
        action,
        "allow_with_snapshot",
        [
          {
            code: "FS_DESTRUCTIVE_WORKSPACE_MUTATION",
            severity: "high",
            message: "Mutating shell commands require snapshot protection before proceeding.",
          },
        ],
        ["shell.mutating.requires_snapshot"],
      )
    );
  }

  if (commandFamily === "package_manager") {
    return makeOutcome(
      action,
      "ask",
      [
        {
          code: "PACKAGE_MANAGER_REQUIRES_APPROVAL",
          severity: "high",
          message: "Package manager commands may change dependencies or fetch remote artifacts and require approval.",
        },
      ],
      ["shell.package_manager.ask"],
    );
  }

  if (commandFamily === "build_tool") {
    return makeOutcome(
      action,
      "ask",
      [
        {
          code: "BUILD_TOOL_REQUIRES_APPROVAL",
          severity: "moderate",
          message: "Build tool commands may mutate workspace outputs and require approval.",
        },
      ],
      ["shell.build_tool.ask"],
    );
  }

  if (commandFamily === "interpreter") {
    return makeOutcome(
      action,
      "ask",
      [
        {
          code: "INTERPRETER_EXECUTION_REQUIRES_APPROVAL",
          severity: "high",
          message: "Interpreter-launched scripts remain opaque and require approval.",
        },
      ],
      ["shell.interpreter.ask"],
    );
  }

  return makeOutcome(
    action,
    "ask",
    [
      {
        code: "UNKNOWN_SCOPE_REQUIRES_APPROVAL",
        severity: "high",
        message: "Unclassified shell command requires approval.",
      },
    ],
    ["shell.unclassified.ask"],
  );
}

function evaluateFunction(action: ActionRecord, context: PolicyEvaluationContext): PolicyOutcomeRecord {
  const functionFacet = action.facets.function as
    | {
        integration?: string;
        operation?: string;
        trusted_compensator?: string;
      }
    | undefined;
  const integration = functionFacet?.integration ?? "unknown";
  const operation = functionFacet?.operation ?? action.operation.kind;

  if (action.normalization.normalization_confidence < 0.5) {
    return makeOutcome(
      action,
      "ask",
      [
        {
          code: "FUNCTION_LOW_CONFIDENCE_REQUIRES_APPROVAL",
          severity: "high",
          message: "Function action could not be normalized confidently enough for automatic execution.",
        },
      ],
      ["function.low_confidence.ask"],
    );
  }

  if (
    integration === "drafts" &&
    (operation === "create_draft" ||
      operation === "archive_draft" ||
      operation === "delete_draft" ||
      operation === "unarchive_draft" ||
      operation === "update_draft" ||
      operation === "restore_draft" ||
      operation === "add_label" ||
      operation === "remove_label") &&
    functionFacet?.trusted_compensator
  ) {
    return makeOutcome(
      action,
      "allow_with_snapshot",
      [
        {
          code: "OWNED_FUNCTION_COMPENSATABLE",
          severity: "moderate",
          message: "Owned draft mutation is allowed with a recovery boundary because a trusted compensator exists.",
        },
      ],
      ["function.drafts.compensatable.requires_snapshot"],
    );
  }

  if (
    integration === "notes" &&
    (operation === "create_note" ||
      operation === "archive_note" ||
      operation === "unarchive_note" ||
      operation === "update_note" ||
      operation === "restore_note" ||
      operation === "delete_note") &&
    functionFacet?.trusted_compensator
  ) {
    return makeOutcome(
      action,
      "allow_with_snapshot",
      [
        {
          code: "OWNED_FUNCTION_COMPENSATABLE",
          severity: "moderate",
          message: "Owned note mutation is allowed with a recovery boundary because a trusted compensator exists.",
        },
      ],
      ["function.notes.compensatable.requires_snapshot"],
    );
  }

  if (
    integration === "tickets" &&
    (operation === "create_ticket" ||
      operation === "update_ticket" ||
      operation === "delete_ticket" ||
      operation === "restore_ticket" ||
      operation === "close_ticket" ||
      operation === "reopen_ticket" ||
      operation === "add_label" ||
      operation === "remove_label" ||
      operation === "assign_user" ||
      operation === "unassign_user") &&
    functionFacet?.trusted_compensator
  ) {
    if (action.execution_path.credential_mode !== "brokered") {
      return makeOutcome(
        action,
        "deny",
        [
          {
            code:
              action.execution_path.credential_mode === "direct"
                ? "DIRECT_CREDENTIALS_FORBIDDEN"
                : "BROKERED_CREDENTIALS_REQUIRED",
            severity: "critical",
            message:
              action.execution_path.credential_mode === "direct"
                ? "Owned ticket integrations may not execute with direct credentials."
                : "Owned ticket integrations require brokered credentials.",
          },
        ],
        [
          action.execution_path.credential_mode === "direct"
            ? "credentials.direct.forbidden"
            : "credentials.brokered.required",
        ],
        {
          brokered_credentials_required: true,
          direct_credentials_forbidden: true,
        },
      );
    }

    const capabilityState = context.cached_capability_state;
    if (capabilityState) {
      if (capabilityState.is_stale) {
        return makeCapabilityApprovalOutcome(
          action,
          {
            code: "CAPABILITY_STATE_STALE",
            severity: "high",
            message:
              "Cached ticket capability state is stale; rerun capability_refresh or approve explicitly before automatic execution.",
          },
          "capability.tickets.stale.ask",
          {
            brokered_credentials_required: true,
            direct_credentials_forbidden: true,
          },
        );
      }

      const ticketCapability = capabilityState.capabilities.find(
        (capability) => capability.capability_name === "adapter.tickets_brokered_credentials",
      );
      if (!ticketCapability) {
        return makeCapabilityApprovalOutcome(
          action,
          {
            code: "CAPABILITY_STATE_INCOMPLETE",
            severity: "high",
            message:
              "Cached capability state did not include ticket broker readiness; rerun capability_refresh or approve explicitly before automatic execution.",
          },
          "capability.tickets.missing.ask",
          {
            brokered_credentials_required: true,
            direct_credentials_forbidden: true,
          },
        );
      }

      if (ticketCapability.status !== "available") {
        return makeCapabilityApprovalOutcome(
          action,
          {
            code: "BROKERED_CAPABILITY_UNAVAILABLE",
            severity: "high",
            message: `Cached ticket broker capability is ${ticketCapability.status}; rerun capability_refresh or approve explicitly before automatic execution.`,
          },
          "capability.tickets.unavailable.ask",
          {
            brokered_credentials_required: true,
            direct_credentials_forbidden: true,
          },
        );
      }
    }

    return makeOutcome(
      action,
      "allow_with_snapshot",
      [
        {
          code: "OWNED_FUNCTION_COMPENSATABLE",
          severity: "moderate",
          message: "Owned ticket mutation is allowed with a recovery boundary because a trusted compensator and brokered credentials exist.",
        },
      ],
      ["function.tickets.compensatable.requires_snapshot"],
      {
        brokered_credentials_required: true,
        direct_credentials_forbidden: true,
      },
    );
  }

  return makeOutcome(
    action,
    "ask",
    [
      {
        code: "FUNCTION_REQUIRES_APPROVAL",
        severity: "high",
        message: "This function integration is not yet trusted for automatic execution.",
      },
    ],
    ["function.untrusted.ask"],
  );
}

function evaluateMcp(action: ActionRecord, context: PolicyEvaluationContext): PolicyOutcomeRecord {
  const mcpFacet = action.facets.mcp as
    | {
        server_id?: string;
        tool_name?: string;
      }
    | undefined;
  const serverId = typeof mcpFacet?.server_id === "string" ? mcpFacet.server_id : "";
  const toolName = typeof mcpFacet?.tool_name === "string" ? mcpFacet.tool_name : "";

  if (action.execution_path.credential_mode === "direct") {
    return makeDirectCredentialDenyOutcome(
      action,
      "Governed MCP proxy execution does not accept direct client-provided credentials.",
      "mcp.direct_credentials.deny",
    );
  }

  if (!context.mcp_server_registry || context.mcp_server_registry.servers.length === 0) {
    return makeOutcome(
      action,
      "deny",
      [
        {
          code: "CAPABILITY_UNAVAILABLE",
          severity: "high",
          message: "No trusted MCP server registry is configured for governed MCP execution.",
        },
      ],
      ["mcp.registry.missing.deny"],
    );
  }

  const server = context.mcp_server_registry.servers.find((candidate) => candidate.server_id === serverId);
  if (!server) {
    return makeOutcome(
      action,
      "deny",
      [
        {
          code: "CAPABILITY_UNAVAILABLE",
          severity: "high",
          message: `MCP server "${serverId}" is not registered for governed execution.`,
        },
      ],
      ["mcp.server.unregistered.deny"],
    );
  }

  const toolPolicy = server.tools.find((candidate) => candidate.tool_name === toolName);
  if (!toolPolicy) {
    return makeOutcome(
      action,
      "deny",
      [
        {
          code: "CAPABILITY_UNAVAILABLE",
          severity: "high",
          message: `MCP tool "${toolName}" is not registered for governed execution on server "${serverId}".`,
        },
      ],
      ["mcp.tool.unregistered.deny"],
    );
  }

  if (toolPolicy.side_effect_level === "read_only" && toolPolicy.approval_mode !== "ask") {
    return makeOutcome(
      action,
      "allow",
      [
        {
          code: "MCP_TOOL_TRUSTED_READ_ONLY",
          severity: "low",
          message: "This MCP tool is explicitly registered as read-only and trusted for automatic execution.",
        },
      ],
      ["mcp.tool.read_only.allow"],
    );
  }

  return makeOutcome(
    action,
    "ask",
    [
      {
        code: "MCP_TOOL_APPROVAL_REQUIRED",
        severity: "moderate",
        message:
          toolPolicy.side_effect_level === "read_only"
            ? "This MCP tool is registered as read-only, but operator policy requires explicit approval."
            : "Mutating MCP tools require explicit approval in the governed runtime.",
      },
    ],
    [
      toolPolicy.side_effect_level === "read_only"
        ? "mcp.tool.read_only.ask"
        : "mcp.tool.mutating.ask",
    ],
  );
}

function withBudgetEffects(
  action: ActionRecord,
  outcome: PolicyOutcomeRecord,
  context: PolicyEvaluationContext,
): PolicyOutcomeRecord {
  const runSummary = context.run_summary;
  if (!runSummary) {
    return outcome;
  }

  const updatedOutcome: PolicyOutcomeRecord = {
    ...outcome,
    reasons: [...outcome.reasons],
    budget_effects: {
      ...outcome.budget_effects,
    },
    policy_context: {
      ...outcome.policy_context,
      matched_rules: [...outcome.policy_context.matched_rules],
    },
  };

  const mutatingRelevant =
    action.risk_hints.side_effect_level === "mutating" || action.risk_hints.side_effect_level === "destructive";
  const destructiveRelevant = action.risk_hints.side_effect_level === "destructive";

  if (mutatingRelevant && runSummary.budget_config.max_mutating_actions !== null) {
    const remaining = runSummary.budget_config.max_mutating_actions - runSummary.budget_usage.mutating_actions - 1;
    updatedOutcome.budget_effects.remaining_mutating_actions = Math.max(remaining, 0);

    if (remaining < 0) {
      updatedOutcome.decision = "deny";
      updatedOutcome.preconditions.snapshot_required = false;
      updatedOutcome.preconditions.approval_required = false;
      updatedOutcome.budget_effects.budget_check = "hard_limit";
      updatedOutcome.reasons.push({
        code: "MUTATING_ACTION_BUDGET_EXCEEDED",
        severity: "critical",
        message: "Run mutating action budget is exhausted.",
      });
      updatedOutcome.policy_context.matched_rules.push("budget.mutating.hard_limit");
      return updatedOutcome;
    }

    if (remaining === 0) {
      updatedOutcome.budget_effects.budget_check = "soft_limit";
      updatedOutcome.reasons.push({
        code: "MUTATING_ACTION_BUDGET_AT_LIMIT",
        severity: "moderate",
        message: "This action would consume the final mutating action slot for the run.",
      });
      updatedOutcome.policy_context.matched_rules.push("budget.mutating.soft_limit");
    }
  }

  if (destructiveRelevant && runSummary.budget_config.max_destructive_actions !== null) {
    const remaining = runSummary.budget_config.max_destructive_actions - runSummary.budget_usage.destructive_actions - 1;
    updatedOutcome.budget_effects.remaining_destructive_actions = Math.max(remaining, 0);

    if (remaining < 0) {
      updatedOutcome.decision = "deny";
      updatedOutcome.preconditions.snapshot_required = false;
      updatedOutcome.preconditions.approval_required = false;
      updatedOutcome.budget_effects.budget_check = "hard_limit";
      updatedOutcome.reasons.push({
        code: "DESTRUCTIVE_ACTION_BUDGET_EXCEEDED",
        severity: "critical",
        message: "Run destructive action budget is exhausted.",
      });
      updatedOutcome.policy_context.matched_rules.push("budget.destructive.hard_limit");
      return updatedOutcome;
    }

    if (remaining === 0) {
      updatedOutcome.budget_effects.budget_check = "soft_limit";
      updatedOutcome.reasons.push({
        code: "DESTRUCTIVE_ACTION_BUDGET_AT_LIMIT",
        severity: "high",
        message: "This action would consume the final destructive action slot for the run.",
      });
      updatedOutcome.policy_context.matched_rules.push("budget.destructive.soft_limit");
    }
  }

  updatedOutcome.preconditions.snapshot_required = updatedOutcome.decision === "allow_with_snapshot";
  updatedOutcome.preconditions.approval_required = updatedOutcome.decision === "ask";
  return updatedOutcome;
}

export function evaluatePolicy(action: ActionRecord, context: PolicyEvaluationContext = {}): PolicyOutcomeRecord {
  try {
    const baseOutcome =
      action.operation.domain === "filesystem"
        ? evaluateFilesystem(action, context)
        : action.operation.domain === "shell"
          ? evaluateShell(action, context)
          : action.operation.domain === "mcp"
            ? evaluateMcp(action, context)
          : action.operation.domain === "function"
            ? evaluateFunction(action, context)
          : makeOutcome(
              action,
              "ask",
              [
                {
                  code: "CAPABILITY_UNAVAILABLE",
                  severity: "high",
                  message: "No policy evaluator exists for this action domain yet.",
                },
              ],
              ["policy.domain.unsupported"],
            );

    return withBudgetEffects(action, baseOutcome, context);
  } catch (error) {
    const wrapped =
      error instanceof InternalError
        ? error
        : new InternalError("Policy evaluation failed.", {
            cause: error instanceof Error ? error.message : String(error),
          });

    return makeOutcome(
      action,
      "deny",
      [
        {
          code: "POLICY_EVALUATION_ERROR",
          severity: "critical",
          message: wrapped.message,
        },
      ],
      ["policy.evaluation.error"],
    );
  }
}
