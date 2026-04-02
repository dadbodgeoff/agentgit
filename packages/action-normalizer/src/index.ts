import crypto from "node:crypto";
import path from "node:path";

import {
  InternalError,
  PreconditionError,
  ValidationError,
  type ActionRecord,
  type RawActionAttempt,
} from "@agentgit/schemas";
import { v7 as uuidv7 } from "uuid";

type NormalizedActionRecord = Omit<ActionRecord, "confidence_assessment">;
type ActionConfidenceAssessment = ActionRecord["confidence_assessment"];
type ActionConfidenceFactor = ActionConfidenceAssessment["factors"][number];

const ACTION_CONFIDENCE_ENGINE_VERSION = "action-confidence/v1";

function createActionId(): string {
  return `act_${uuidv7().replaceAll("-", "")}`;
}

function normalizePath(targetPath: string, cwd: string | undefined): string {
  if (path.isAbsolute(targetPath)) {
    return path.normalize(targetPath);
  }

  return path.resolve(cwd ?? process.cwd(), targetPath);
}

function isPathInsideWorkspace(targetPath: string, workspaceRoots: string[]): boolean {
  return workspaceRoots.some((root) => {
    const normalizedRoot = path.resolve(root);
    const normalizedTarget = path.resolve(targetPath);
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
  });
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJsonValue(entry)]),
    );
  }

  return value;
}

function stableJsonHash(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(sortJsonValue(value)))
    .digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function roundConfidence(value: number): number {
  return Number(Math.max(0, Math.min(1, value)).toFixed(3));
}

function pushConfidenceFactor(
  factors: ActionConfidenceFactor[],
  factor: Omit<ActionConfidenceFactor, "delta"> & { delta: number },
): void {
  factors.push({
    ...factor,
    delta: roundConfidence(factor.delta),
  });
}

function assessActionConfidence(action: NormalizedActionRecord): ActionConfidenceAssessment {
  const factors: ActionConfidenceFactor[] = [];
  pushConfidenceFactor(factors, {
    factor_id: "normalization_baseline",
    label: "Normalization baseline",
    kind: "baseline",
    delta: action.normalization.normalization_confidence,
    rationale: `Started from mapper confidence ${action.normalization.normalization_confidence.toFixed(3)}.`,
  });

  if (action.provenance.confidence >= 0.95) {
    pushConfidenceFactor(factors, {
      factor_id: "provenance_governed_high",
      label: "Strong provenance",
      kind: "boost",
      delta: 0.04,
      rationale: "Governed provenance is high-confidence and strengthens trust in the action envelope.",
    });
  } else if (action.provenance.confidence < 0.75) {
    pushConfidenceFactor(factors, {
      factor_id: "provenance_uncertain",
      label: "Weak provenance",
      kind: "penalty",
      delta: -0.08,
      rationale: "Low provenance confidence weakens trust in the normalized action context.",
    });
  }

  if (action.target.scope.unknowns.includes("scope")) {
    pushConfidenceFactor(factors, {
      factor_id: "scope_unknown",
      label: "Opaque scope",
      kind: "penalty",
      delta: -0.22,
      rationale: "Unknown scope makes blast radius estimation unreliable.",
    });
  } else if (action.target.scope.breadth === "single") {
    pushConfidenceFactor(factors, {
      factor_id: "scope_single",
      label: "Single-target scope",
      kind: "boost",
      delta: 0.04,
      rationale: "Single-target actions are easier to reason about and recover from.",
    });
  } else if (action.target.scope.breadth === "workspace" || action.target.scope.breadth === "repository") {
    pushConfidenceFactor(factors, {
      factor_id: "scope_broad_workspace",
      label: "Broad workspace scope",
      kind: "penalty",
      delta: -0.06,
      rationale: "Workspace-wide scope expands ambiguity and recovery cost.",
    });
  } else if (action.target.scope.breadth === "unknown" || action.target.scope.breadth === "external") {
    pushConfidenceFactor(factors, {
      factor_id: "scope_external_or_unknown",
      label: "External or unknown scope",
      kind: "penalty",
      delta: -0.1,
      rationale: "External or unknown scope increases uncertainty about downstream effects.",
    });
  }

  if (action.risk_hints.side_effect_level === "read_only") {
    pushConfidenceFactor(factors, {
      factor_id: "side_effect_read_only",
      label: "Read-only execution",
      kind: "boost",
      delta: 0.05,
      rationale: "Read-only actions are easier to classify and carry lower risk.",
    });
  } else if (action.risk_hints.side_effect_level === "destructive") {
    pushConfidenceFactor(factors, {
      factor_id: "side_effect_destructive",
      label: "Destructive execution",
      kind: "penalty",
      delta: -0.12,
      rationale: "Destructive actions reduce confidence that automated execution should proceed without review.",
    });
  } else if (action.risk_hints.side_effect_level === "unknown") {
    pushConfidenceFactor(factors, {
      factor_id: "side_effect_unknown",
      label: "Unknown side effects",
      kind: "penalty",
      delta: -0.14,
      rationale: "Unknown side effects make it unsafe to trust the classification strongly.",
    });
  }

  if (action.risk_hints.external_effects === "network") {
    pushConfidenceFactor(factors, {
      factor_id: "external_network",
      label: "Network side effects",
      kind: "penalty",
      delta: -0.06,
      rationale: "Remote side effects reduce determinism and complicate recovery.",
    });
  } else if (action.risk_hints.external_effects === "communication") {
    pushConfidenceFactor(factors, {
      factor_id: "external_communication",
      label: "Communication side effects",
      kind: "penalty",
      delta: -0.08,
      rationale: "Communication side effects usually escape local rollback guarantees.",
    });
  } else if (action.risk_hints.external_effects === "financial") {
    pushConfidenceFactor(factors, {
      factor_id: "external_financial",
      label: "Financial side effects",
      kind: "penalty",
      delta: -0.14,
      rationale: "Financial effects are high-stakes and demand conservative confidence.",
    });
  } else if (action.risk_hints.external_effects === "unknown") {
    pushConfidenceFactor(factors, {
      factor_id: "external_unknown",
      label: "Unknown external effects",
      kind: "penalty",
      delta: -0.1,
      rationale: "Uncertain external effects weaken operator trust in autonomous execution.",
    });
  }

  if (action.risk_hints.reversibility_hint === "reversible") {
    pushConfidenceFactor(factors, {
      factor_id: "reversibility_reversible",
      label: "Clearly reversible",
      kind: "boost",
      delta: 0.03,
      rationale: "Clear rollback paths improve confidence in automated handling.",
    });
  } else if (action.risk_hints.reversibility_hint === "compensatable") {
    pushConfidenceFactor(factors, {
      factor_id: "reversibility_compensatable",
      label: "Compensatable",
      kind: "boost",
      delta: 0.015,
      rationale: "Trusted compensators partially reduce operational ambiguity.",
    });
  } else if (action.risk_hints.reversibility_hint === "potentially_reversible") {
    pushConfidenceFactor(factors, {
      factor_id: "reversibility_partial",
      label: "Partially reversible",
      kind: "penalty",
      delta: -0.03,
      rationale: "Partial reversibility still leaves meaningful uncertainty about recovery quality.",
    });
  } else if (action.risk_hints.reversibility_hint === "irreversible") {
    pushConfidenceFactor(factors, {
      factor_id: "reversibility_irreversible",
      label: "Irreversible",
      kind: "penalty",
      delta: -0.12,
      rationale: "Irreversible actions require conservative confidence handling.",
    });
  } else {
    pushConfidenceFactor(factors, {
      factor_id: "reversibility_unknown",
      label: "Unknown reversibility",
      kind: "penalty",
      delta: -0.08,
      rationale: "Unknown rollback characteristics reduce confidence in safe automation.",
    });
  }

  if (action.risk_hints.batch) {
    pushConfidenceFactor(factors, {
      factor_id: "batch_effects",
      label: "Batch effects",
      kind: "penalty",
      delta: -0.06,
      rationale: "Batch execution raises blast radius and makes partial failures harder to reason about.",
    });
  }

  if (action.risk_hints.sensitivity_hint === "moderate") {
    pushConfidenceFactor(factors, {
      factor_id: "sensitivity_moderate",
      label: "Moderate sensitivity",
      kind: "penalty",
      delta: -0.03,
      rationale: "Moderately sensitive targets deserve more conservative confidence.",
    });
  } else if (action.risk_hints.sensitivity_hint === "high") {
    pushConfidenceFactor(factors, {
      factor_id: "sensitivity_high",
      label: "High sensitivity",
      kind: "penalty",
      delta: -0.07,
      rationale: "Highly sensitive targets reduce tolerance for uncertainty.",
    });
  } else if (action.risk_hints.sensitivity_hint === "unknown") {
    pushConfidenceFactor(factors, {
      factor_id: "sensitivity_unknown",
      label: "Unknown sensitivity",
      kind: "penalty",
      delta: -0.04,
      rationale: "Unknown sensitivity introduces avoidable uncertainty into autonomous execution.",
    });
  }

  if (action.execution_path.credential_mode === "direct") {
    pushConfidenceFactor(factors, {
      factor_id: "credentials_direct",
      label: "Direct credentials",
      kind: "penalty",
      delta: -0.12,
      rationale: "Direct credentials bypass brokered controls and reduce operational trust.",
    });
  } else if (action.execution_path.credential_mode === "delegated") {
    pushConfidenceFactor(factors, {
      factor_id: "credentials_delegated",
      label: "Delegated credentials",
      kind: "penalty",
      delta: -0.04,
      rationale: "Delegated credentials are safer than direct credentials but still reduce local certainty.",
    });
  } else if (action.execution_path.credential_mode === "brokered") {
    pushConfidenceFactor(factors, {
      factor_id: "credentials_brokered",
      label: "Brokered credentials",
      kind: "boost",
      delta: 0.01,
      rationale: "Brokered credentials preserve policy control and auditability.",
    });
  }

  if (action.execution_path.surface === "governed_fs") {
    pushConfidenceFactor(factors, {
      factor_id: "surface_governed_fs",
      label: "Governed filesystem surface",
      kind: "boost",
      delta: 0.03,
      rationale: "The governed filesystem surface exposes narrow, inspectable semantics.",
    });
  } else if (action.execution_path.surface === "provider_hosted") {
    pushConfidenceFactor(factors, {
      factor_id: "surface_provider_hosted",
      label: "Provider-hosted surface",
      kind: "penalty",
      delta: -0.08,
      rationale: "Provider-hosted execution reduces local observability and rollback certainty.",
    });
  } else if (action.execution_path.surface === "mcp_proxy") {
    pushConfidenceFactor(factors, {
      factor_id: "surface_mcp_proxy",
      label: "MCP proxy surface",
      kind: "penalty",
      delta: -0.04,
      rationale: "Remote tool mediation adds operational uncertainty compared with local governed execution.",
    });
  }

  if (action.normalization.warnings.includes("opaque_execution")) {
    pushConfidenceFactor(factors, {
      factor_id: "warning_opaque_execution",
      label: "Opaque execution",
      kind: "penalty",
      delta: -0.12,
      rationale: "Opaque execution hides effective scope and weakens confidence in autonomous handling.",
    });
  }
  if (action.normalization.warnings.includes("workspace_wide_effects")) {
    pushConfidenceFactor(factors, {
      factor_id: "warning_workspace_wide",
      label: "Workspace-wide effects",
      kind: "penalty",
      delta: -0.05,
      rationale: "Workspace-wide effects reduce precision in scope and recovery planning.",
    });
  }
  if (action.normalization.warnings.includes("mcp_read_only_hint_untrusted")) {
    pushConfidenceFactor(factors, {
      factor_id: "warning_untrusted_mcp_hint",
      label: "Untrusted MCP hint",
      kind: "penalty",
      delta: -0.03,
      rationale: "An unverified read-only hint should not materially raise trust.",
    });
  }

  const functionFacet =
    action.operation.domain === "function" && isRecord(action.facets.function) ? action.facets.function : null;
  if (
    functionFacet &&
    typeof functionFacet.trusted_compensator === "string" &&
    functionFacet.trusted_compensator.length > 0
  ) {
    pushConfidenceFactor(factors, {
      factor_id: "function_trusted_compensator",
      label: "Trusted compensator",
      kind: "boost",
      delta: 0.03,
      rationale: "Trusted compensators improve recoverability and operator confidence.",
    });
  }

  const mcpFacet = action.operation.domain === "mcp" && isRecord(action.facets.mcp) ? action.facets.mcp : null;
  if (mcpFacet && mcpFacet.trust_tier_at_submit === "operator_owned") {
    pushConfidenceFactor(factors, {
      factor_id: "mcp_operator_owned",
      label: "Operator-owned MCP server",
      kind: "boost",
      delta: 0.02,
      rationale: "Operator-owned MCP registrations are more trustworthy than anonymous remote tools.",
    });
  }
  if (mcpFacet && mcpFacet.drift_state_at_submit === "drifted") {
    pushConfidenceFactor(factors, {
      factor_id: "mcp_drifted",
      label: "Drifted MCP profile",
      kind: "penalty",
      delta: -0.08,
      rationale: "Profile drift at submit time weakens confidence in the tool contract.",
    });
  }
  if (mcpFacet && mcpFacet.profile_status === "pending_approval") {
    pushConfidenceFactor(factors, {
      factor_id: "mcp_pending_profile",
      label: "Pending MCP profile approval",
      kind: "penalty",
      delta: -0.08,
      rationale: "Pending MCP approval indicates that trust establishment is incomplete.",
    });
  }

  const total = roundConfidence(factors.reduce((sum, factor) => sum + factor.delta, 0));
  const band: ActionConfidenceAssessment["band"] = total >= 0.85 ? "high" : total >= 0.65 ? "guarded" : "low";
  const requiresHumanReview =
    total < 0.65 ||
    action.target.scope.unknowns.includes("scope") ||
    action.risk_hints.side_effect_level === "unknown" ||
    action.normalization.warnings.includes("opaque_execution");

  return {
    engine_version: ACTION_CONFIDENCE_ENGINE_VERSION,
    score: total,
    band,
    requires_human_review: requiresHumanReview,
    factors,
  };
}

function withConfidenceAssessment(action: NormalizedActionRecord): ActionRecord {
  return {
    ...action,
    confidence_assessment: assessActionConfidence(action),
  };
}

function normalizeFilesystemAttempt(attempt: RawActionAttempt, sessionId: string): NormalizedActionRecord {
  const rawOperation = String(attempt.raw_call.operation ?? "write");
  const rawPath = String(attempt.raw_call.path ?? "");
  const normalizedPath = normalizePath(rawPath, attempt.environment_context.cwd);
  const content = typeof attempt.raw_call.content === "string" ? attempt.raw_call.content : "";
  const byteLength = Buffer.byteLength(content, "utf8");
  const isWorkspacePath = isPathInsideWorkspace(normalizedPath, attempt.environment_context.workspace_roots);

  const sideEffectLevel =
    rawOperation === "delete"
      ? "destructive"
      : rawOperation === "write" || rawOperation === "overwrite"
        ? "mutating"
        : "unknown";

  return {
    schema_version: "action.v1",
    action_id: createActionId(),
    run_id: attempt.run_id,
    session_id: sessionId,
    status: "normalized",
    timestamps: {
      requested_at: attempt.received_at,
      normalized_at: new Date().toISOString(),
    },
    provenance: {
      mode: "governed",
      source: "authority-sdk-ts",
      confidence: isWorkspacePath ? 0.99 : 0.85,
    },
    actor: {
      type: "agent",
      agent_name: attempt.framework_context?.agent_name,
      agent_framework: attempt.framework_context?.agent_framework,
      tool_name: attempt.tool_registration.tool_name,
      tool_kind: attempt.tool_registration.tool_kind,
    },
    operation: {
      domain: "filesystem",
      kind: rawOperation,
      name: `filesystem.${rawOperation}`,
      display_name: rawOperation === "delete" ? "Delete file" : "Write file",
    },
    execution_path: {
      surface: "governed_fs",
      mode: "pre_execution",
      credential_mode: attempt.environment_context.credential_mode ?? "none",
    },
    target: {
      primary: {
        type: "path",
        locator: normalizedPath,
        label: path.basename(normalizedPath),
      },
      scope: {
        breadth: "single",
        estimated_count: 1,
        unknowns: isWorkspacePath ? [] : ["scope"],
      },
    },
    input: {
      raw: attempt.raw_call,
      redacted: attempt.raw_call,
      schema_ref: null,
      contains_sensitive_data: false,
    },
    risk_hints: {
      side_effect_level: sideEffectLevel,
      external_effects: "none",
      reversibility_hint: rawOperation === "delete" ? "potentially_reversible" : "reversible",
      sensitivity_hint: byteLength > 262144 ? "moderate" : "low",
      batch: false,
    },
    facets: {
      filesystem: {
        operation: rawOperation,
        paths: [normalizedPath],
        path_count: 1,
        recursive: false,
        overwrite: rawOperation !== "delete",
        byte_length: byteLength,
      },
    },
    normalization: {
      mapper: "filesystem/v1",
      inferred_fields: ["target.scope", "risk_hints"],
      warnings: isWorkspacePath ? [] : ["unknown_scope"],
      normalization_confidence: isWorkspacePath ? 0.99 : 0.48,
    },
  };
}

const SAFE_READ_ONLY_COMMANDS = new Set(["ls", "pwd", "cat", "head", "tail", "find", "rg", "wc"]);
const SAFE_READ_ONLY_GIT_SUBCOMMANDS = new Set(["status", "diff", "log", "show", "rev-parse", "blame"]);
const PACKAGE_MANAGER_COMMANDS = new Set(["npm", "pnpm", "yarn", "bun", "uv", "pip", "pip3", "poetry"]);
const BUILD_TOOL_COMMANDS = new Set([
  "make",
  "just",
  "cargo",
  "go",
  "dotnet",
  "gradle",
  "mvn",
  "vite",
  "webpack",
  "tsc",
  "turbo",
]);
const INTERPRETER_COMMANDS = new Set(["python", "python3", "node", "bash", "sh", "zsh", "ruby", "php"]);

interface ShellClassification {
  commandFamily: string;
  sideEffectLevel: ActionRecord["risk_hints"]["side_effect_level"];
  reversibilityHint: ActionRecord["risk_hints"]["reversibility_hint"];
  externalEffects: ActionRecord["risk_hints"]["external_effects"];
  sensitivityHint: ActionRecord["risk_hints"]["sensitivity_hint"];
  batch: boolean;
  warnings: string[];
  confidence: number;
  classifierRule: string;
}

interface FunctionRawCall {
  integration?: unknown;
  operation?: unknown;
  draft_id?: unknown;
  note_id?: unknown;
  ticket_id?: unknown;
  status?: unknown;
  labels?: unknown;
  assigned_users?: unknown;
  user_id?: unknown;
  subject?: unknown;
  title?: unknown;
  body?: unknown;
  label?: unknown;
}

interface McpRawCall {
  server_id?: unknown;
  server_profile_id?: unknown;
  candidate_id?: unknown;
  tool_name?: unknown;
  arguments?: unknown;
  annotations?: unknown;
  input_schema?: unknown;
  execution_mode_requested?: unknown;
  trust_tier_at_submit?: unknown;
  drift_state_at_submit?: unknown;
  credential_binding_mode?: unknown;
  profile_status?: unknown;
  candidate_source_kind?: unknown;
  allowed_execution_modes?: unknown;
}

function normalizeStringArray(value: unknown, fieldName: string): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ValidationError(`Ticket restore ${fieldName} must be an array of non-empty strings.`, {
      field: fieldName,
    });
  }

  const normalized = value.map((entry) => entry.trim());
  if (normalized.some((entry) => entry.length === 0)) {
    throw new ValidationError(`Ticket restore ${fieldName} must be an array of non-empty strings.`, {
      field: fieldName,
    });
  }

  return [...new Set(normalized)];
}

function isDirectRestoreTicketStatus(value: string): value is "active" | "closed" {
  return value === "active" || value === "closed";
}

function normalizeDraftRestoreLabels(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ValidationError("Draft restore labels must be an array of non-empty strings.", {
      field: "labels",
    });
  }

  const normalized = value.map((entry) => entry.trim());
  if (normalized.some((entry) => entry.length === 0)) {
    throw new ValidationError("Draft restore labels must be an array of non-empty strings.", {
      field: "labels",
    });
  }

  return [...new Set(normalized)];
}

function isDirectRestoreDraftStatus(value: string): value is "active" | "archived" | "deleted" {
  return value === "active" || value === "archived" || value === "deleted";
}

function isDirectRestoreNoteStatus(value: string): value is "active" | "archived" | "deleted" {
  return value === "active" || value === "archived" || value === "deleted";
}

function shellDisplayName(argv: string[], classification: ShellClassification): string {
  const command = argv[0] ?? "command";
  const subcommand = argv[1] ?? "";

  switch (classification.commandFamily) {
    case "version_control_read_only":
      if (subcommand === "status") return "Inspect git status";
      if (subcommand === "diff") return "Inspect git diff";
      if (subcommand === "log") return "Inspect git history";
      return "Inspect git state";
    case "version_control_mutating":
      if (subcommand === "reset") return argv.includes("--hard") ? "Hard reset git state" : "Reset git state";
      if (subcommand === "checkout" || subcommand === "switch") return "Switch git branch";
      if (subcommand === "restore") return "Restore git-tracked files";
      if (subcommand === "commit") return "Create git commit";
      return "Modify git state";
    case "filesystem_primitive":
      if (command === "rm") return "Delete files";
      if (command === "mv") return "Move files";
      if (command === "cp") return "Copy files";
      return "Mutate files";
    case "package_manager":
      if (["install", "add", "sync"].includes(subcommand)) return "Install packages";
      if (["remove", "rm", "uninstall"].includes(subcommand)) return "Remove packages";
      if (["update", "upgrade"].includes(subcommand)) return "Update packages";
      if (["run", "exec", "dlx"].includes(subcommand)) return `Run ${command} task`;
      return "Manage packages";
    case "build_tool":
      return "Run build tool";
    case "interpreter":
      return `Run ${command} script`;
    case "read_only_shell":
      return `Inspect workspace with ${command}`;
    default:
      return "Run shell command";
  }
}

function classifyShellCommand(argv: string[]): ShellClassification {
  const command = argv[0] ?? "unknown";
  const subcommand = argv[1] ?? "";

  if (SAFE_READ_ONLY_COMMANDS.has(command)) {
    return {
      commandFamily: "read_only_shell",
      sideEffectLevel: "read_only",
      reversibilityHint: "reversible",
      externalEffects: "none",
      sensitivityHint: "low",
      batch: false,
      warnings: [],
      confidence: 0.96,
      classifierRule: "shell.read_only.core",
    };
  }

  if (command === "git" && SAFE_READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
    return {
      commandFamily: "version_control_read_only",
      sideEffectLevel: "read_only",
      reversibilityHint: "reversible",
      externalEffects: "none",
      sensitivityHint: "low",
      batch: false,
      warnings: [],
      confidence: 0.96,
      classifierRule: "shell.git.read_only",
    };
  }

  if (command === "rm") {
    return {
      commandFamily: "filesystem_primitive",
      sideEffectLevel: "destructive",
      reversibilityHint: "potentially_reversible",
      externalEffects: "none",
      sensitivityHint: "moderate",
      batch: true,
      warnings: [],
      confidence: 0.93,
      classifierRule: "shell.fs.rm",
    };
  }

  if (command === "mv" || command === "cp") {
    return {
      commandFamily: "filesystem_primitive",
      sideEffectLevel: "mutating",
      reversibilityHint: "potentially_reversible",
      externalEffects: "none",
      sensitivityHint: "low",
      batch: false,
      warnings: [],
      confidence: 0.8,
      classifierRule: `shell.fs.${command}`,
    };
  }

  if (command === "git" && (subcommand === "reset" || subcommand === "clean")) {
    const destructive =
      subcommand === "clean" ||
      argv.includes("--hard") ||
      argv.includes("-fd") ||
      argv.includes("-fdx") ||
      argv.includes("-xdf");

    return {
      commandFamily: "version_control_mutating",
      sideEffectLevel: destructive ? "destructive" : "mutating",
      reversibilityHint: destructive ? "potentially_reversible" : "compensatable",
      externalEffects: "none",
      sensitivityHint: destructive ? "high" : "moderate",
      batch: destructive,
      warnings: destructive ? [] : ["workspace_wide_effects"],
      confidence: destructive ? 0.9 : 0.78,
      classifierRule: destructive ? "shell.git.destructive" : "shell.git.mutating",
    };
  }

  if (
    command === "git" &&
    ["checkout", "switch", "restore", "apply", "am", "commit", "merge", "rebase", "cherry-pick", "stash"].includes(
      subcommand,
    )
  ) {
    return {
      commandFamily: "version_control_mutating",
      sideEffectLevel: "mutating",
      reversibilityHint: "compensatable",
      externalEffects: "none",
      sensitivityHint: "moderate",
      batch: false,
      warnings: ["workspace_wide_effects"],
      confidence: 0.76,
      classifierRule: "shell.git.mutating",
    };
  }

  if (PACKAGE_MANAGER_COMMANDS.has(command)) {
    const isInstallLike = ["install", "add", "update", "upgrade", "remove", "rm", "uninstall", "sync"].includes(
      subcommand,
    );
    const isRunLike = ["run", "exec", "dlx"].includes(subcommand);

    return {
      commandFamily: "package_manager",
      sideEffectLevel: "mutating",
      reversibilityHint: isInstallLike ? "compensatable" : "potentially_reversible",
      externalEffects: isInstallLike ? "network" : "none",
      sensitivityHint: isInstallLike ? "moderate" : "low",
      batch: isInstallLike,
      warnings: isRunLike ? ["opaque_execution", "workspace_wide_effects"] : ["workspace_wide_effects"],
      confidence: isInstallLike ? 0.72 : 0.58,
      classifierRule: isInstallLike ? "shell.pkg.install_like" : "shell.pkg.run_like",
    };
  }

  if (BUILD_TOOL_COMMANDS.has(command)) {
    return {
      commandFamily: "build_tool",
      sideEffectLevel: "mutating",
      reversibilityHint: "potentially_reversible",
      externalEffects: "none",
      sensitivityHint: "low",
      batch: true,
      warnings: ["workspace_wide_effects"],
      confidence: 0.62,
      classifierRule: "shell.build_tool",
    };
  }

  if (INTERPRETER_COMMANDS.has(command)) {
    return {
      commandFamily: "interpreter",
      sideEffectLevel: "mutating",
      reversibilityHint: "potentially_reversible",
      externalEffects: "none",
      sensitivityHint: "moderate",
      batch: false,
      warnings: ["unknown_scope", "opaque_execution"],
      confidence: 0.29,
      classifierRule: "shell.interpreter.opaque",
    };
  }

  return {
    commandFamily: "unclassified",
    sideEffectLevel: "mutating",
    reversibilityHint: "potentially_reversible",
    externalEffects: "none",
    sensitivityHint: "moderate",
    batch: false,
    warnings: ["unknown_scope", "opaque_execution"],
    confidence: 0.29,
    classifierRule: "shell.unclassified",
  };
}

function normalizeShellAttempt(attempt: RawActionAttempt, sessionId: string): NormalizedActionRecord {
  const rawArgv = Array.isArray(attempt.raw_call.argv)
    ? attempt.raw_call.argv.map((value: unknown) => String(value))
    : typeof attempt.raw_call.command === "string"
      ? attempt.raw_call.command.trim().split(/\s+/)
      : [];

  const command = rawArgv[0] ?? "unknown";
  const cwd = attempt.environment_context.cwd ?? attempt.environment_context.workspace_roots[0] ?? process.cwd();
  const classification = classifyShellCommand(rawArgv);

  return {
    schema_version: "action.v1",
    action_id: createActionId(),
    run_id: attempt.run_id,
    session_id: sessionId,
    status: "normalized",
    timestamps: {
      requested_at: attempt.received_at,
      normalized_at: new Date().toISOString(),
    },
    provenance: {
      mode: "governed",
      source: "authority-sdk-ts",
      confidence: classification.confidence,
    },
    actor: {
      type: "agent",
      agent_name: attempt.framework_context?.agent_name,
      agent_framework: attempt.framework_context?.agent_framework,
      tool_name: attempt.tool_registration.tool_name,
      tool_kind: attempt.tool_registration.tool_kind,
    },
    operation: {
      domain: "shell",
      kind: "exec",
      name: "shell.exec",
      display_name: shellDisplayName(rawArgv, classification),
    },
    execution_path: {
      surface: "governed_shell",
      mode: "pre_execution",
      credential_mode: attempt.environment_context.credential_mode ?? "none",
    },
    target: {
      primary: {
        type: "workspace",
        locator: cwd,
        label: path.basename(cwd),
      },
      scope: {
        breadth: classification.warnings.includes("unknown_scope") ? "unknown" : "workspace",
        unknowns: classification.warnings.includes("unknown_scope") ? ["scope", "target_count"] : [],
      },
    },
    input: {
      raw: attempt.raw_call,
      redacted: attempt.raw_call,
      schema_ref: null,
      contains_sensitive_data: false,
    },
    risk_hints: {
      side_effect_level: classification.sideEffectLevel,
      external_effects: classification.externalEffects,
      reversibility_hint: classification.reversibilityHint,
      sensitivity_hint: classification.sensitivityHint,
      batch: classification.batch,
    },
    facets: {
      shell: {
        argv: rawArgv,
        cwd,
        interpreter: command,
        command_family: classification.commandFamily,
        classifier_rule: classification.classifierRule,
        declared_env_keys: [],
        stdin_kind: "none",
      },
    },
    normalization: {
      mapper: "shell/v1",
      inferred_fields: ["risk_hints", "target.scope"],
      warnings: classification.warnings,
      normalization_confidence: classification.confidence,
    },
  };
}

function normalizeMcpAttempt(attempt: RawActionAttempt, sessionId: string): NormalizedActionRecord {
  const rawCall = attempt.raw_call as McpRawCall;
  const serverId = typeof rawCall.server_id === "string" ? rawCall.server_id.trim() : "";
  const serverProfileId = typeof rawCall.server_profile_id === "string" ? rawCall.server_profile_id.trim() : "";
  const candidateId = typeof rawCall.candidate_id === "string" ? rawCall.candidate_id.trim() : "";
  const toolName = typeof rawCall.tool_name === "string" ? rawCall.tool_name.trim() : "";
  const toolArguments = rawCall.arguments ?? {};

  if (serverId.length === 0) {
    throw new ValidationError("MCP tool execution requires a non-empty server_id.", {
      tool_kind: attempt.tool_registration.tool_kind,
      tool_name: attempt.tool_registration.tool_name,
    });
  }

  if (toolName.length === 0) {
    throw new ValidationError("MCP tool execution requires a non-empty tool_name.", {
      tool_kind: attempt.tool_registration.tool_kind,
      tool_name: attempt.tool_registration.tool_name,
      server_id: serverId,
    });
  }

  if (!isRecord(toolArguments)) {
    throw new ValidationError("MCP tool execution requires arguments to be a JSON object.", {
      server_id: serverId,
      tool_name: toolName,
    });
  }

  const annotations = isRecord(rawCall.annotations) ? rawCall.annotations : null;
  const inputSchema = isRecord(rawCall.input_schema) ? rawCall.input_schema : null;
  const executionModeRequested =
    rawCall.execution_mode_requested === "local_proxy" || rawCall.execution_mode_requested === "hosted_delegated"
      ? rawCall.execution_mode_requested
      : null;
  const trustTierAtSubmit =
    rawCall.trust_tier_at_submit === "operator_owned" ||
    rawCall.trust_tier_at_submit === "publisher_verified" ||
    rawCall.trust_tier_at_submit === "operator_approved_public"
      ? rawCall.trust_tier_at_submit
      : null;
  const driftStateAtSubmit =
    rawCall.drift_state_at_submit === "clean" ||
    rawCall.drift_state_at_submit === "drifted" ||
    rawCall.drift_state_at_submit === "unknown"
      ? rawCall.drift_state_at_submit
      : null;
  const credentialBindingMode =
    rawCall.credential_binding_mode === "oauth_session" ||
    rawCall.credential_binding_mode === "derived_token" ||
    rawCall.credential_binding_mode === "bearer_secret_ref" ||
    rawCall.credential_binding_mode === "session_token" ||
    rawCall.credential_binding_mode === "hosted_token_exchange"
      ? rawCall.credential_binding_mode
      : null;
  const profileStatus =
    rawCall.profile_status === "draft" ||
    rawCall.profile_status === "pending_approval" ||
    rawCall.profile_status === "active" ||
    rawCall.profile_status === "quarantined" ||
    rawCall.profile_status === "revoked"
      ? rawCall.profile_status
      : null;
  const candidateSourceKind =
    rawCall.candidate_source_kind === "operator_seeded" ||
    rawCall.candidate_source_kind === "user_input" ||
    rawCall.candidate_source_kind === "agent_discovered" ||
    rawCall.candidate_source_kind === "catalog_import"
      ? rawCall.candidate_source_kind
      : null;
  const allowedExecutionModes = Array.isArray(rawCall.allowed_execution_modes)
    ? [
        ...new Set(
          rawCall.allowed_execution_modes.filter(
            (entry): entry is "local_proxy" | "hosted_delegated" =>
              entry === "local_proxy" || entry === "hosted_delegated",
          ),
        ),
      ]
    : [];
  const declaredReadOnlyHint =
    typeof annotations?.readOnlyHint === "boolean"
      ? annotations.readOnlyHint
      : typeof annotations?.read_only_hint === "boolean"
        ? annotations.read_only_hint
        : null;
  const normalizedRawCall: Record<string, unknown> = {
    server_id: serverId,
    ...(serverProfileId.length > 0 ? { server_profile_id: serverProfileId } : {}),
    ...(candidateId.length > 0 ? { candidate_id: candidateId } : {}),
    tool_name: toolName,
    arguments: toolArguments,
    ...(annotations ? { annotations } : {}),
    ...(inputSchema ? { input_schema: inputSchema } : {}),
    ...(executionModeRequested ? { execution_mode_requested: executionModeRequested } : {}),
    ...(trustTierAtSubmit ? { trust_tier_at_submit: trustTierAtSubmit } : {}),
    ...(driftStateAtSubmit ? { drift_state_at_submit: driftStateAtSubmit } : {}),
    ...(credentialBindingMode ? { credential_binding_mode: credentialBindingMode } : {}),
    ...(profileStatus ? { profile_status: profileStatus } : {}),
    ...(candidateSourceKind ? { candidate_source_kind: candidateSourceKind } : {}),
    ...(allowedExecutionModes.length > 0 ? { allowed_execution_modes: allowedExecutionModes } : {}),
  };
  const toolLocator = `mcp://server/${encodeURIComponent(serverId)}/tools/${encodeURIComponent(toolName)}`;
  const executionSurface = executionModeRequested === "hosted_delegated" ? "provider_hosted" : "mcp_proxy";
  const credentialMode =
    executionModeRequested === "hosted_delegated"
      ? "delegated"
      : credentialBindingMode
        ? "brokered"
        : (attempt.environment_context.credential_mode ?? "unknown");

  return {
    schema_version: "action.v1",
    action_id: createActionId(),
    run_id: attempt.run_id,
    session_id: sessionId,
    status: "normalized",
    timestamps: {
      requested_at: attempt.received_at,
      normalized_at: new Date().toISOString(),
    },
    provenance: {
      mode: "governed",
      source: "authority-sdk-ts",
      confidence: 0.9,
    },
    actor: {
      type: "agent",
      agent_name: attempt.framework_context?.agent_name,
      agent_framework: attempt.framework_context?.agent_framework,
      tool_name: attempt.tool_registration.tool_name,
      tool_kind: attempt.tool_registration.tool_kind,
    },
    operation: {
      domain: "mcp",
      kind: "call_tool",
      name: `mcp.${serverId}.${toolName}`,
      display_name: `Call MCP tool ${serverId}/${toolName}`,
    },
    execution_path: {
      surface: executionSurface,
      mode: "pre_execution",
      credential_mode: credentialMode,
    },
    target: {
      primary: {
        type: "external_object",
        locator: toolLocator,
        label: `${serverId}/${toolName}`,
      },
      scope: {
        breadth: "single",
        estimated_count: 1,
        unknowns: [],
      },
    },
    input: {
      raw: normalizedRawCall,
      redacted: normalizedRawCall,
      schema_ref: null,
      contains_sensitive_data: false,
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
        server_id: serverId,
        ...(serverProfileId.length > 0 ? { server_profile_id: serverProfileId } : {}),
        ...(candidateId.length > 0 ? { candidate_id: candidateId } : {}),
        tool_name: toolName,
        tool_locator: toolLocator,
        argument_keys: Object.keys(toolArguments).sort(),
        arguments_sha256: stableJsonHash(toolArguments),
        input_schema_sha256: inputSchema ? stableJsonHash(inputSchema) : null,
        annotations,
        declared_read_only_hint: declaredReadOnlyHint,
        execution_mode_requested: executionModeRequested,
        trust_tier_at_submit: trustTierAtSubmit,
        drift_state_at_submit: driftStateAtSubmit,
        credential_binding_mode: credentialBindingMode,
        profile_status: profileStatus,
        candidate_source_kind: candidateSourceKind,
        allowed_execution_modes: allowedExecutionModes,
      },
    },
    normalization: {
      mapper: "mcp/v1",
      inferred_fields: ["target.primary", "risk_hints", "facets.mcp.arguments_sha256"],
      warnings: declaredReadOnlyHint === null ? [] : ["mcp_read_only_hint_untrusted"],
      normalization_confidence: 0.91,
    },
  };
}

function normalizeFunctionAttempt(attempt: RawActionAttempt, sessionId: string): NormalizedActionRecord {
  const rawCall = attempt.raw_call as FunctionRawCall;
  const integration = typeof rawCall.integration === "string" ? rawCall.integration : "";
  const operation = typeof rawCall.operation === "string" ? rawCall.operation : "";

  if (
    !(
      (integration === "drafts" &&
        (operation === "create_draft" ||
          operation === "archive_draft" ||
          operation === "delete_draft" ||
          operation === "unarchive_draft" ||
          operation === "update_draft" ||
          operation === "restore_draft" ||
          operation === "add_label" ||
          operation === "remove_label")) ||
      (integration === "notes" &&
        (operation === "create_note" ||
          operation === "archive_note" ||
          operation === "unarchive_note" ||
          operation === "update_note" ||
          operation === "restore_note" ||
          operation === "delete_note")) ||
      (integration === "tickets" &&
        (operation === "create_ticket" ||
          operation === "update_ticket" ||
          operation === "delete_ticket" ||
          operation === "restore_ticket" ||
          operation === "close_ticket" ||
          operation === "reopen_ticket" ||
          operation === "add_label" ||
          operation === "remove_label" ||
          operation === "assign_user" ||
          operation === "unassign_user"))
    )
  ) {
    throw new ValidationError("Unsupported function action.", {
      integration,
      operation,
    });
  }

  const actionId = createActionId();
  const hasSubject = typeof rawCall.subject === "string";
  const hasBody = typeof rawCall.body === "string";
  const hasTitle = typeof rawCall.title === "string";
  const hasStatus = typeof rawCall.status === "string";
  const subject = hasSubject ? (rawCall.subject as string) : "";
  const body = hasBody ? (rawCall.body as string) : "";
  const title = hasTitle ? (rawCall.title as string) : "";
  const status = hasStatus ? String(rawCall.status).trim() : "";
  const label = typeof rawCall.label === "string" ? rawCall.label.trim() : "";
  const userId = typeof rawCall.user_id === "string" ? rawCall.user_id.trim() : "";
  const draftRestoreLabels =
    integration === "drafts" && operation === "restore_draft" ? normalizeDraftRestoreLabels(rawCall.labels) : [];
  const restoreLabels =
    integration === "tickets" && operation === "restore_ticket" ? normalizeStringArray(rawCall.labels, "labels") : [];
  const restoreAssignedUsers =
    integration === "tickets" && operation === "restore_ticket"
      ? normalizeStringArray(rawCall.assigned_users, "assigned_users")
      : [];
  const rawDraftId = typeof rawCall.draft_id === "string" ? rawCall.draft_id : "";
  const rawNoteId = typeof rawCall.note_id === "string" ? rawCall.note_id : "";
  const rawTicketId = typeof rawCall.ticket_id === "string" ? rawCall.ticket_id : "";
  const draftId = operation === "create_draft" ? `draft_${actionId}` : rawDraftId.trim();
  const noteId = operation === "create_note" ? `note_${actionId}` : rawNoteId.trim();
  const ticketId =
    operation === "create_ticket"
      ? rawTicketId.trim().length > 0
        ? rawTicketId.trim()
        : `ticket_${actionId}`
      : rawTicketId.trim();

  if ((operation === "create_draft" || operation === "update_draft") && hasSubject && subject.trim().length === 0) {
    throw new ValidationError("Draft subject must be non-empty when provided.", {
      integration,
      operation,
    });
  }

  if (operation === "create_draft" && subject.trim().length === 0) {
    throw new ValidationError("Draft creation requires a non-empty subject.", {
      integration,
      operation,
    });
  }

  if (operation === "create_note" && title.trim().length === 0) {
    throw new ValidationError("Note creation requires a non-empty title.", {
      integration,
      operation,
    });
  }

  if (
    (operation === "archive_note" ||
      operation === "unarchive_note" ||
      operation === "update_note" ||
      operation === "restore_note" ||
      operation === "delete_note") &&
    noteId.length === 0
  ) {
    throw new ValidationError(
      operation === "archive_note"
        ? "Note archive requires a non-empty note_id."
        : operation === "unarchive_note"
          ? "Note unarchive requires a non-empty note_id."
          : operation === "update_note"
            ? "Note update requires a non-empty note_id."
            : operation === "restore_note"
              ? "Note restore requires a non-empty note_id."
              : "Note delete requires a non-empty note_id.",
      {
        integration,
        operation,
      },
    );
  }

  if ((operation === "create_note" || operation === "update_note") && hasTitle && title.trim().length === 0) {
    throw new ValidationError("Note title must be non-empty when provided.", {
      integration,
      operation,
    });
  }

  if (operation === "update_note" && !hasTitle && !hasBody) {
    throw new ValidationError("Note update requires at least one mutable field.", {
      integration,
      operation,
    });
  }

  if (operation === "restore_note" && title.trim().length === 0) {
    throw new ValidationError("Note restore requires a non-empty title.", {
      integration,
      operation,
    });
  }

  if (operation === "restore_note" && !hasBody) {
    throw new ValidationError("Note restore requires a body string.", {
      integration,
      operation,
    });
  }

  if (operation === "restore_note" && !hasStatus) {
    throw new ValidationError("Note restore requires a target status.", {
      integration,
      operation,
    });
  }

  if (operation === "restore_note" && !isDirectRestoreNoteStatus(status)) {
    throw new ValidationError("Note restore status must be either active, archived, or deleted.", {
      integration,
      operation,
      status,
    });
  }

  if (operation === "create_ticket" && title.trim().length === 0) {
    throw new ValidationError("Ticket creation requires a non-empty title.", {
      integration,
      operation,
    });
  }

  if (operation === "update_ticket" && ticketId.length === 0) {
    throw new ValidationError("Ticket update requires a non-empty ticket_id.", {
      integration,
      operation,
    });
  }

  if (
    (operation === "delete_ticket" ||
      operation === "restore_ticket" ||
      operation === "close_ticket" ||
      operation === "reopen_ticket") &&
    ticketId.length === 0
  ) {
    throw new ValidationError(
      operation === "delete_ticket"
        ? "Ticket delete requires a non-empty ticket_id."
        : operation === "restore_ticket"
          ? "Ticket restore requires a non-empty ticket_id."
          : operation === "close_ticket"
            ? "Ticket close requires a non-empty ticket_id."
            : "Ticket reopen requires a non-empty ticket_id.",
      {
        integration,
        operation,
      },
    );
  }

  if (
    integration === "tickets" &&
    (operation === "add_label" || operation === "remove_label") &&
    ticketId.length === 0
  ) {
    throw new ValidationError(
      operation === "add_label"
        ? "Ticket labeling requires a non-empty ticket_id."
        : "Ticket label removal requires a non-empty ticket_id.",
      {
        integration,
        operation,
      },
    );
  }

  if (
    integration === "tickets" &&
    (operation === "assign_user" || operation === "unassign_user") &&
    ticketId.length === 0
  ) {
    throw new ValidationError(
      operation === "assign_user"
        ? "Ticket assignment requires a non-empty ticket_id."
        : "Ticket unassignment requires a non-empty ticket_id.",
      {
        integration,
        operation,
      },
    );
  }

  if (operation === "update_ticket" && !hasTitle && !hasBody) {
    throw new ValidationError("Ticket update requires at least one mutable field.", {
      integration,
      operation,
    });
  }

  if (operation === "update_ticket" && hasTitle && title.trim().length === 0) {
    throw new ValidationError("Ticket title must be non-empty when provided.", {
      integration,
      operation,
    });
  }

  if (operation === "restore_ticket" && title.trim().length === 0) {
    throw new ValidationError("Ticket restore requires a non-empty title.", {
      integration,
      operation,
    });
  }

  if (operation === "restore_ticket" && !hasBody) {
    throw new ValidationError("Ticket restore requires a body string.", {
      integration,
      operation,
    });
  }

  if (operation === "restore_ticket" && !hasStatus) {
    throw new ValidationError("Ticket restore requires a target status.", {
      integration,
      operation,
    });
  }

  if (operation === "restore_ticket" && !isDirectRestoreTicketStatus(status)) {
    throw new ValidationError("Ticket restore status must be either active or closed.", {
      integration,
      operation,
      status,
    });
  }

  if (operation === "archive_draft" && draftId.length === 0) {
    throw new ValidationError("Draft archive requires a non-empty draft_id.", {
      integration,
      operation,
    });
  }

  if (operation === "delete_draft" && draftId.length === 0) {
    throw new ValidationError("Draft delete requires a non-empty draft_id.", {
      integration,
      operation,
    });
  }

  if (operation === "unarchive_draft" && draftId.length === 0) {
    throw new ValidationError("Draft unarchive requires a non-empty draft_id.", {
      integration,
      operation,
    });
  }

  if (operation === "update_draft" && draftId.length === 0) {
    throw new ValidationError("Draft update requires a non-empty draft_id.", {
      integration,
      operation,
    });
  }

  if (operation === "restore_draft" && draftId.length === 0) {
    throw new ValidationError("Draft restore requires a non-empty draft_id.", {
      integration,
      operation,
    });
  }

  if (operation === "update_draft" && !hasSubject && !hasBody) {
    throw new ValidationError("Draft update requires at least one mutable field.", {
      integration,
      operation,
    });
  }

  if (integration === "drafts" && operation === "add_label" && draftId.length === 0) {
    throw new ValidationError("Draft labeling requires a non-empty draft_id.", {
      integration,
      operation,
    });
  }

  if (integration === "drafts" && operation === "remove_label" && draftId.length === 0) {
    throw new ValidationError("Draft label removal requires a non-empty draft_id.", {
      integration,
      operation,
    });
  }

  if ((operation === "add_label" || operation === "remove_label") && label.length === 0) {
    throw new ValidationError(
      integration === "tickets"
        ? operation === "add_label"
          ? "Ticket labeling requires a non-empty label."
          : "Ticket label removal requires a non-empty label."
        : "Draft labeling requires a non-empty label.",
      {
        integration,
        operation,
      },
    );
  }

  if (
    integration === "tickets" &&
    (operation === "assign_user" || operation === "unassign_user") &&
    userId.length === 0
  ) {
    throw new ValidationError(
      operation === "assign_user"
        ? "Ticket assignment requires a non-empty user_id."
        : "Ticket unassignment requires a non-empty user_id.",
      {
        integration,
        operation,
      },
    );
  }

  if (operation === "restore_draft" && subject.trim().length === 0) {
    throw new ValidationError("Draft restore requires a non-empty subject.", {
      integration,
      operation,
    });
  }

  if (operation === "restore_draft" && !hasBody) {
    throw new ValidationError("Draft restore requires a body string.", {
      integration,
      operation,
    });
  }

  if (operation === "restore_draft" && !hasStatus) {
    throw new ValidationError("Draft restore requires a target status.", {
      integration,
      operation,
    });
  }

  if (operation === "restore_draft" && !isDirectRestoreDraftStatus(status)) {
    throw new ValidationError("Draft restore status must be either active, archived, or deleted.", {
      integration,
      operation,
      status,
    });
  }

  const locator =
    (operation === "add_label" || operation === "remove_label") && integration === "drafts"
      ? `drafts://message_draft/${draftId}/labels/${encodeURIComponent(label)}`
      : (operation === "add_label" || operation === "remove_label") && integration === "tickets"
        ? `tickets://issue/${ticketId}/labels/${encodeURIComponent(label)}`
        : (operation === "assign_user" || operation === "unassign_user") && integration === "tickets"
          ? `tickets://issue/${ticketId}/assignees/${encodeURIComponent(userId)}`
          : integration === "drafts"
            ? `drafts://message_draft/${draftId}`
            : integration === "notes"
              ? `notes://workspace_note/${noteId}`
              : `tickets://issue/${ticketId}`;
  const targetLabel =
    operation === "create_draft"
      ? subject
      : operation === "create_note"
        ? title
        : operation === "create_ticket"
          ? title
          : operation === "update_ticket"
            ? `Ticket ${ticketId}`
            : operation === "delete_ticket"
              ? `Ticket ${ticketId}`
              : operation === "restore_ticket"
                ? `Ticket ${ticketId}`
                : (operation === "add_label" || operation === "remove_label") && integration === "tickets"
                  ? `Ticket ${ticketId} label ${label}`
                  : (operation === "assign_user" || operation === "unassign_user") && integration === "tickets"
                    ? `Ticket ${ticketId} assignee ${userId}`
                    : operation === "close_ticket"
                      ? `Ticket ${ticketId}`
                      : operation === "reopen_ticket"
                        ? `Ticket ${ticketId}`
                        : operation === "add_label"
                          ? `Draft ${draftId} label ${label}`
                          : operation === "remove_label" && integration === "drafts"
                            ? `Draft ${draftId} label ${label}`
                            : operation === "delete_draft"
                              ? `Draft ${draftId}`
                              : operation === "unarchive_draft"
                                ? `Draft ${draftId}`
                                : operation === "restore_draft"
                                  ? `Draft ${draftId}`
                                  : operation === "archive_note"
                                    ? `Note ${noteId}`
                                    : operation === "update_note"
                                      ? `Note ${noteId}`
                                      : operation === "restore_note"
                                        ? `Note ${noteId}`
                                        : operation === "delete_note"
                                          ? `Note ${noteId}`
                                          : operation === "unarchive_note"
                                            ? `Note ${noteId}`
                                            : integration === "drafts"
                                              ? `Draft ${draftId}`
                                              : integration === "notes"
                                                ? `Note ${noteId}`
                                                : `Ticket ${ticketId}`;
  const trustedCompensator =
    operation === "create_draft"
      ? "drafts.archive_draft"
      : operation === "create_note"
        ? "notes.archive_note"
        : operation === "create_ticket"
          ? "tickets.delete_ticket"
          : operation === "update_ticket"
            ? "tickets.restore_ticket"
            : operation === "delete_ticket"
              ? "tickets.restore_ticket"
              : operation === "restore_ticket"
                ? "tickets.restore_ticket"
                : operation === "add_label" && integration === "tickets"
                  ? "tickets.remove_label"
                  : operation === "remove_label" && integration === "tickets"
                    ? "tickets.add_label"
                    : operation === "assign_user" && integration === "tickets"
                      ? "tickets.unassign_user"
                      : operation === "unassign_user" && integration === "tickets"
                        ? "tickets.assign_user"
                        : operation === "close_ticket"
                          ? "tickets.reopen_ticket"
                          : operation === "reopen_ticket"
                            ? "tickets.close_ticket"
                            : operation === "archive_draft"
                              ? "drafts.unarchive_draft"
                              : operation === "delete_draft"
                                ? "drafts.restore_draft"
                                : operation === "unarchive_draft"
                                  ? "drafts.archive_draft"
                                  : operation === "update_draft"
                                    ? "drafts.restore_draft"
                                    : operation === "restore_draft"
                                      ? "drafts.restore_draft"
                                      : operation === "remove_label" && integration === "drafts"
                                        ? "drafts.add_label"
                                        : operation === "archive_note"
                                          ? "notes.unarchive_note"
                                          : operation === "update_note"
                                            ? "notes.restore_note"
                                            : operation === "restore_note"
                                              ? "notes.restore_note"
                                              : operation === "delete_note"
                                                ? "notes.restore_note"
                                                : operation === "unarchive_note"
                                                  ? "notes.archive_note"
                                                  : "drafts.remove_label";
  const payloadKeys =
    operation === "create_draft"
      ? body.length > 0
        ? ["subject", "body"]
        : ["subject"]
      : operation === "create_note"
        ? body.length > 0
          ? ["title", "body"]
          : ["title"]
        : operation === "create_ticket"
          ? body.length > 0
            ? ["title", "body", "ticket_id"]
            : ["title", "ticket_id"]
          : operation === "update_ticket"
            ? ["ticket_id", ...(hasTitle ? ["title"] : []), ...(hasBody ? ["body"] : [])]
            : operation === "delete_ticket"
              ? ["ticket_id"]
              : operation === "restore_ticket"
                ? ["ticket_id", "title", "body", "status", "labels", "assigned_users"]
                : operation === "close_ticket"
                  ? ["ticket_id"]
                  : operation === "reopen_ticket"
                    ? ["ticket_id"]
                    : (operation === "add_label" || operation === "remove_label") && integration === "tickets"
                      ? ["ticket_id", "label"]
                      : (operation === "assign_user" || operation === "unassign_user") && integration === "tickets"
                        ? ["ticket_id", "user_id"]
                        : operation === "archive_draft"
                          ? ["draft_id"]
                          : operation === "delete_draft"
                            ? ["draft_id"]
                            : operation === "unarchive_draft"
                              ? ["draft_id"]
                              : operation === "update_draft"
                                ? ["draft_id", ...(hasSubject ? ["subject"] : []), ...(hasBody ? ["body"] : [])]
                                : operation === "restore_draft"
                                  ? ["draft_id", "subject", "body", "status", "labels"]
                                  : operation === "update_note"
                                    ? ["note_id", ...(hasTitle ? ["title"] : []), ...(hasBody ? ["body"] : [])]
                                    : operation === "restore_note"
                                      ? ["note_id", "title", "body", "status"]
                                      : operation === "delete_note"
                                        ? ["note_id"]
                                        : operation === "archive_note" || operation === "unarchive_note"
                                          ? ["note_id"]
                                          : ["draft_id", "label"];
  const displayName =
    operation === "create_draft"
      ? "Create draft message"
      : operation === "create_note"
        ? "Create workspace note"
        : operation === "create_ticket"
          ? "Create external ticket"
          : operation === "update_ticket"
            ? "Update external ticket"
            : operation === "delete_ticket"
              ? "Delete external ticket"
              : operation === "restore_ticket"
                ? "Restore external ticket"
                : operation === "close_ticket"
                  ? "Close external ticket"
                  : operation === "reopen_ticket"
                    ? "Reopen external ticket"
                    : operation === "add_label" && integration === "tickets"
                      ? "Add external ticket label"
                      : operation === "remove_label" && integration === "tickets"
                        ? "Remove external ticket label"
                        : operation === "assign_user" && integration === "tickets"
                          ? "Assign external ticket user"
                          : operation === "unassign_user" && integration === "tickets"
                            ? "Unassign external ticket user"
                            : operation === "archive_draft"
                              ? "Archive draft message"
                              : operation === "delete_draft"
                                ? "Delete draft message"
                                : operation === "unarchive_draft"
                                  ? "Unarchive draft message"
                                  : operation === "update_draft"
                                    ? "Update draft message"
                                    : operation === "restore_draft"
                                      ? "Restore draft message"
                                      : operation === "remove_label" && integration === "drafts"
                                        ? "Remove draft label"
                                        : operation === "archive_note"
                                          ? "Archive workspace note"
                                          : operation === "update_note"
                                            ? "Update workspace note"
                                            : operation === "restore_note"
                                              ? "Restore workspace note"
                                              : operation === "delete_note"
                                                ? "Delete workspace note"
                                                : operation === "unarchive_note"
                                                  ? "Unarchive workspace note"
                                                  : "Add draft label";
  const normalizedRawCall: Record<string, unknown> = {
    integration,
    operation,
    ...(operation === "create_draft" ? { subject: subject.trim(), ...(body.length > 0 ? { body } : {}) } : {}),
    ...(operation === "create_note" ? { title: title.trim(), ...(body.length > 0 ? { body } : {}) } : {}),
    ...(operation === "create_ticket"
      ? { ticket_id: ticketId, title: title.trim(), ...(body.length > 0 ? { body } : {}) }
      : {}),
    ...(operation === "update_ticket"
      ? { ticket_id: ticketId, ...(hasTitle ? { title: title.trim() } : {}), ...(hasBody ? { body } : {}) }
      : {}),
    ...(operation === "delete_ticket" ? { ticket_id: ticketId } : {}),
    ...(operation === "restore_ticket"
      ? {
          ticket_id: ticketId,
          title: title.trim(),
          body,
          status,
          labels: restoreLabels,
          assigned_users: restoreAssignedUsers,
        }
      : {}),
    ...(operation === "close_ticket" ? { ticket_id: ticketId } : {}),
    ...(operation === "reopen_ticket" ? { ticket_id: ticketId } : {}),
    ...((operation === "add_label" || operation === "remove_label") && integration === "tickets"
      ? { ticket_id: ticketId, label }
      : {}),
    ...((operation === "assign_user" || operation === "unassign_user") && integration === "tickets"
      ? { ticket_id: ticketId, user_id: userId }
      : {}),
    ...(operation === "archive_draft" ? { draft_id: draftId } : {}),
    ...(operation === "delete_draft" ? { draft_id: draftId } : {}),
    ...(operation === "unarchive_draft" ? { draft_id: draftId } : {}),
    ...(operation === "update_draft"
      ? { draft_id: draftId, ...(hasSubject ? { subject: subject.trim() } : {}), ...(hasBody ? { body } : {}) }
      : {}),
    ...(operation === "restore_draft"
      ? {
          draft_id: draftId,
          subject: subject.trim(),
          body,
          status,
          labels: draftRestoreLabels,
        }
      : {}),
    ...(operation === "update_note"
      ? { note_id: noteId, ...(hasTitle ? { title: title.trim() } : {}), ...(hasBody ? { body } : {}) }
      : {}),
    ...(operation === "restore_note"
      ? {
          note_id: noteId,
          title: title.trim(),
          body,
          status,
        }
      : {}),
    ...(operation === "archive_note" || operation === "unarchive_note" || operation === "delete_note"
      ? { note_id: noteId }
      : {}),
    ...(operation === "add_label" && integration === "drafts" ? { draft_id: draftId, label } : {}),
    ...(operation === "remove_label" && integration === "drafts" ? { draft_id: draftId, label } : {}),
  };

  return {
    schema_version: "action.v1",
    action_id: actionId,
    run_id: attempt.run_id,
    session_id: sessionId,
    status: "normalized",
    timestamps: {
      requested_at: attempt.received_at,
      normalized_at: new Date().toISOString(),
    },
    provenance: {
      mode: "governed",
      source: "authority-sdk-ts",
      confidence: 0.95,
    },
    actor: {
      type: "agent",
      agent_name: attempt.framework_context?.agent_name,
      agent_framework: attempt.framework_context?.agent_framework,
      tool_name: attempt.tool_registration.tool_name,
      tool_kind: attempt.tool_registration.tool_kind,
    },
    operation: {
      domain: "function",
      kind: operation,
      name: `${integration}.${operation}`,
      display_name: displayName,
    },
    execution_path: {
      surface: "sdk_function",
      mode: "pre_execution",
      credential_mode: attempt.environment_context.credential_mode ?? "none",
    },
    target: {
      primary: {
        type: "external_object",
        locator,
        label: targetLabel,
      },
      scope: {
        breadth: "single",
        estimated_count: 1,
        unknowns: [],
      },
    },
    input: {
      raw: normalizedRawCall,
      redacted: normalizedRawCall,
      schema_ref: null,
      contains_sensitive_data: false,
    },
    risk_hints: {
      side_effect_level:
        operation === "delete_ticket" || operation === "delete_note" || operation === "delete_draft"
          ? "destructive"
          : "mutating",
      external_effects: "network",
      reversibility_hint: "compensatable",
      sensitivity_hint: "moderate",
      batch: false,
    },
    facets: {
      function: {
        integration,
        operation,
        object_type:
          integration === "drafts" ? "message_draft" : integration === "notes" ? "workspace_note" : "issue_ticket",
        object_locator: locator,
        trusted_compensator: trustedCompensator,
        payload_keys: payloadKeys,
      },
    },
    normalization: {
      mapper: "function/drafts.v1",
      inferred_fields: ["target.primary", "risk_hints", "facets.function.object_locator"],
      warnings: [],
      normalization_confidence: 0.95,
    },
  };
}

export function normalizeActionAttempt(attempt: RawActionAttempt, sessionId: string): ActionRecord {
  try {
    if (attempt.tool_registration.tool_kind === "filesystem") {
      return withConfidenceAssessment(normalizeFilesystemAttempt(attempt, sessionId));
    }

    if (attempt.tool_registration.tool_kind === "shell") {
      return withConfidenceAssessment(normalizeShellAttempt(attempt, sessionId));
    }

    if (attempt.tool_registration.tool_kind === "function") {
      return withConfidenceAssessment(normalizeFunctionAttempt(attempt, sessionId));
    }

    if (attempt.tool_registration.tool_kind === "mcp") {
      return withConfidenceAssessment(normalizeMcpAttempt(attempt, sessionId));
    }

    if (attempt.tool_registration.tool_kind === "browser") {
      throw new PreconditionError("Governed browser/computer execution is not part of the supported runtime surface.", {
        requested_tool_kind: attempt.tool_registration.tool_kind,
        requested_tool_name: attempt.tool_registration.tool_name,
        supported_tool_kinds: ["filesystem", "shell", "function", "mcp"],
        unsupported_surface: "browser_computer",
      });
    }

    throw new ValidationError("Unsupported tool kind.", {
      tool_kind: attempt.tool_registration.tool_kind,
    });
  } catch (error) {
    if (error instanceof ValidationError || error instanceof InternalError || error instanceof PreconditionError) {
      throw error;
    }

    throw new InternalError("Action normalization failed.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}
