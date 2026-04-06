import path from "node:path";

import { AuthorityClient } from "@agentgit/authority-sdk";

import {
  compareRunAuditBundles,
  createRunAuditReport,
  createRunAuditSharePackage,
  exportArtifactContent,
  exportRunAuditBundle,
  verifyRunAuditBundle,
} from "../audit/bundles.js";
import { CLI_EXIT_CODES, inputError, usageError } from "../cli-contract.js";
import { printResult } from "../cli-output.js";
import {
  formatArtifact,
  formatArtifactExport,
  formatRunAuditCompare,
  formatRunAuditExport,
  formatRunAuditReport,
  formatRunAuditShare,
  formatRunAuditVerify,
} from "../formatters/audit.js";
import {
  formatApprovalInbox,
  formatApprovalList,
  formatCapabilities,
  formatDiagnostics,
  formatExecuteRecovery,
  formatHelper,
  formatMaintenance,
  formatPlanRecovery,
  formatResolveApproval,
  formatRunSummary,
  formatSubmitAction,
  formatTimeline,
} from "../formatters/runtime.js";
import { parseJsonArgOrFile, parseVisibilityScopeArg } from "../parsers/common.js";

type DiagnosticsSection = NonNullable<Parameters<AuthorityClient["diagnostics"]>[0]>[number];
type MaintenanceJobType = Parameters<AuthorityClient["runMaintenance"]>[0][number];
type HelperQuestionType = Parameters<AuthorityClient["queryHelper"]>[1];

const RUNTIME_COMMANDS = new Set([
  "run-summary",
  "capabilities",
  "diagnostics",
  "maintenance",
  "timeline",
  "artifact",
  "artifact-export",
  "run-audit-export",
  "run-audit-verify",
  "run-audit-report",
  "run-audit-compare",
  "run-audit-share",
  "list-approvals",
  "approval-inbox",
  "approve",
  "deny",
  "helper",
  "submit-filesystem-write",
  "submit-filesystem-delete",
  "submit-shell",
  "submit-mcp-tool",
  "submit-mcp-profile-tool",
  "submit-draft-create",
  "submit-draft-archive",
  "submit-draft-delete",
  "submit-draft-unarchive",
  "submit-draft-update",
  "submit-draft-add-label",
  "submit-draft-remove-label",
  "submit-draft-restore",
  "submit-note-create",
  "submit-note-archive",
  "submit-note-unarchive",
  "submit-note-delete",
  "submit-note-update",
  "submit-note-restore",
  "submit-ticket-create",
  "submit-ticket-update",
  "submit-ticket-delete",
  "submit-ticket-restore",
  "submit-ticket-close",
  "submit-ticket-reopen",
  "submit-ticket-add-label",
  "submit-ticket-remove-label",
  "submit-ticket-assign-user",
  "submit-ticket-unassign-user",
  "plan-recovery",
  "execute-recovery",
]);

const DIAGNOSTICS_SECTIONS = new Set<DiagnosticsSection>([
  "daemon_health",
  "journal_health",
  "maintenance_backlog",
  "projection_lag",
  "storage_summary",
  "capability_summary",
  "policy_summary",
  "security_posture",
  "hosted_worker",
  "hosted_queue",
]);

const MAINTENANCE_JOB_TYPES = new Set<MaintenanceJobType>([
  "startup_reconcile_runs",
  "startup_reconcile_recoveries",
  "sqlite_wal_checkpoint",
  "projection_refresh",
  "projection_rebuild",
  "snapshot_gc",
  "snapshot_compaction",
  "snapshot_rebase_anchor",
  "artifact_expiry",
  "artifact_orphan_cleanup",
  "capability_refresh",
  "helper_fact_warm",
]);

function parseDiagnosticsSections(args: string[]): DiagnosticsSection[] {
  return args.filter((value): value is DiagnosticsSection => DIAGNOSTICS_SECTIONS.has(value as DiagnosticsSection));
}

function parseMaintenanceJobTypes(args: string[]): MaintenanceJobType[] {
  return args.filter((value): value is MaintenanceJobType => MAINTENANCE_JOB_TYPES.has(value as MaintenanceJobType));
}

function parseObjectJsonArgument(
  value: string,
  errorMessage: string,
  parser: (input: string) => unknown = parseJsonArgOrFile,
): Record<string, unknown> {
  try {
    const parsed = parser(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("arguments must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw inputError(`${errorMessage}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function submitAction(
  client: AuthorityClient,
  workspaceRoot: string,
  input: {
    run_id: string;
    tool_registration: {
      tool_name: string;
      tool_kind: "filesystem" | "shell" | "mcp" | "function";
    };
    raw_call: Record<string, unknown>;
    credential_mode: "none" | "brokered";
  },
) {
  return client.submitActionAttempt({
    run_id: input.run_id,
    tool_registration: input.tool_registration,
    raw_call: input.raw_call,
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: input.credential_mode,
    },
    framework_context: {
      agent_name: "agentgit-cli",
      agent_framework: "cli",
    },
    received_at: new Date().toISOString(),
  });
}

export function isRuntimeCommand(command: string): boolean {
  return RUNTIME_COMMANDS.has(command);
}

export async function runRuntimeCommand(options: {
  command: string;
  client: AuthorityClient;
  workspaceRoot: string;
  rest: string[];
  jsonOutput: boolean;
}): Promise<void> {
  const { command, client, workspaceRoot, rest, jsonOutput } = options;

  switch (command) {
    case "run-summary": {
      const runId = rest[0];

      if (!runId) {
        throw usageError("Usage: agentgit-authority [global-flags] run-summary <run-id>");
      }

      const result = await client.getRunSummary(runId);
      printResult(result, jsonOutput, formatRunSummary);
      return;
    }
    case "capabilities": {
      const result = await client.getCapabilities(rest[0]);
      printResult(result, jsonOutput, formatCapabilities);
      return;
    }
    case "diagnostics": {
      const sections = rest.length > 0 ? parseDiagnosticsSections(rest) : undefined;
      const result = await client.diagnostics(sections && sections.length > 0 ? sections : undefined);
      printResult(result, jsonOutput, formatDiagnostics);
      return;
    }
    case "maintenance": {
      if (rest.length < 1) {
        throw usageError("Usage: agentgit-authority [global-flags] maintenance <job-type...>");
      }

      const jobTypes = parseMaintenanceJobTypes(rest);
      if (jobTypes.length === 0) {
        throw inputError("No valid maintenance job types were provided.");
      }

      const result = await client.runMaintenance(jobTypes);
      printResult(result, jsonOutput, formatMaintenance);
      return;
    }
    case "timeline": {
      const runId = rest[0];
      const visibilityScope = parseVisibilityScopeArg(rest[1]);

      if (!runId) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] timeline <run-id> [user|model|internal|sensitive_internal]",
        );
      }

      const result = await client.queryTimeline(runId, visibilityScope);
      printResult(result, jsonOutput, formatTimeline);
      return;
    }
    case "list-approvals": {
      const [runId, status] = rest;
      const result = await client.listApprovals({
        ...(runId ? { run_id: runId } : {}),
        ...(status ? { status: status as "pending" | "approved" | "denied" } : {}),
      });
      printResult(result, jsonOutput, formatApprovalList);
      return;
    }
    case "approval-inbox": {
      const [runId, status] = rest;
      const result = await client.queryApprovalInbox({
        ...(runId ? { run_id: runId } : {}),
        ...(status ? { status: status as "pending" | "approved" | "denied" } : {}),
      });
      printResult(result, jsonOutput, formatApprovalInbox);
      return;
    }
    case "approve": {
      const approvalId = rest[0];

      if (!approvalId) {
        throw usageError("Usage: agentgit-authority [global-flags] approve <approval-id> [note]");
      }

      const note = rest.slice(1).join(" ") || undefined;
      const result = await client.resolveApproval(approvalId, "approved", note);
      printResult(result, jsonOutput, (value) => formatResolveApproval(value, "approved"));
      return;
    }
    case "deny": {
      const approvalId = rest[0];

      if (!approvalId) {
        throw usageError("Usage: agentgit-authority [global-flags] deny <approval-id> [note]");
      }

      const note = rest.slice(1).join(" ") || undefined;
      const result = await client.resolveApproval(approvalId, "denied", note);
      printResult(result, jsonOutput, (value) => formatResolveApproval(value, "denied"));
      return;
    }
    case "artifact": {
      if (rest.length < 1) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] artifact <artifact-id> [user|model|internal|sensitive_internal]",
        );
      }
      const artifactId = rest[0]!;
      const visibilityScope = parseVisibilityScopeArg(rest[1]);
      const result = await client.queryArtifact(artifactId, visibilityScope);
      printResult(result, jsonOutput, formatArtifact);
      return;
    }
    case "artifact-export": {
      const artifactId = rest[0];
      const destinationPath = rest[1];
      const visibilityScope = parseVisibilityScopeArg(rest[2]);

      if (!artifactId || !destinationPath) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] artifact-export <artifact-id> <destination-path> [user|model|internal|sensitive_internal]",
        );
      }

      const resolvedDestinationPath = path.isAbsolute(destinationPath)
        ? destinationPath
        : path.resolve(workspaceRoot, destinationPath);
      const exported = await exportArtifactContent(client, artifactId, resolvedDestinationPath, visibilityScope);
      printResult(exported, jsonOutput, formatArtifactExport);
      return;
    }
    case "run-audit-export": {
      const runId = rest[0];
      const rawOutputDir = rest[1];
      const visibilityScope = parseVisibilityScopeArg(rest[2]) ?? "user";

      if (!runId || !rawOutputDir) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] run-audit-export <run-id> <output-dir> [user|model|internal|sensitive_internal]",
        );
      }

      const resolvedOutputDir = path.isAbsolute(rawOutputDir)
        ? rawOutputDir
        : path.resolve(workspaceRoot, rawOutputDir);
      const result = await exportRunAuditBundle(client, runId, resolvedOutputDir, visibilityScope, {
        formatApprovalInbox,
        formatApprovalList,
        formatDiagnostics,
        formatRunSummary,
        formatTimeline,
      });
      printResult(result, jsonOutput, formatRunAuditExport);
      return;
    }
    case "run-audit-verify": {
      const rawOutputDir = rest[0];

      if (!rawOutputDir) {
        throw usageError("Usage: agentgit-authority [global-flags] run-audit-verify <bundle-dir>");
      }

      const resolvedOutputDir = path.isAbsolute(rawOutputDir)
        ? rawOutputDir
        : path.resolve(workspaceRoot, rawOutputDir);
      const result = verifyRunAuditBundle(resolvedOutputDir);
      printResult(result, jsonOutput, formatRunAuditVerify);
      if (!result.verified) {
        process.exitCode = CLI_EXIT_CODES.INPUT_INVALID;
      }
      return;
    }
    case "run-audit-report": {
      const rawOutputDir = rest[0];

      if (!rawOutputDir) {
        throw usageError("Usage: agentgit-authority [global-flags] run-audit-report <bundle-dir>");
      }

      const resolvedOutputDir = path.isAbsolute(rawOutputDir)
        ? rawOutputDir
        : path.resolve(workspaceRoot, rawOutputDir);
      const result = createRunAuditReport(resolvedOutputDir);
      printResult(result, jsonOutput, formatRunAuditReport);
      if (!result.verified) {
        process.exitCode = CLI_EXIT_CODES.INPUT_INVALID;
      }
      return;
    }
    case "run-audit-compare": {
      const leftRawOutputDir = rest[0];
      const rightRawOutputDir = rest[1];

      if (!leftRawOutputDir || !rightRawOutputDir) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] run-audit-compare <left-bundle-dir> <right-bundle-dir>",
        );
      }

      const leftResolvedOutputDir = path.isAbsolute(leftRawOutputDir)
        ? leftRawOutputDir
        : path.resolve(workspaceRoot, leftRawOutputDir);
      const rightResolvedOutputDir = path.isAbsolute(rightRawOutputDir)
        ? rightRawOutputDir
        : path.resolve(workspaceRoot, rightRawOutputDir);
      const result = compareRunAuditBundles(leftResolvedOutputDir, rightResolvedOutputDir);
      printResult(result, jsonOutput, formatRunAuditCompare);
      if (result.differences.length > 0 || !result.left_verified || !result.right_verified) {
        process.exitCode = CLI_EXIT_CODES.INPUT_INVALID;
      }
      return;
    }
    case "run-audit-share": {
      const rawOutputDir = rest[0];
      const rawShareOutputDir = rest[1];
      const shareMode = rest[2] ?? "omit-artifact-content";

      if (!rawOutputDir || !rawShareOutputDir) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] run-audit-share <bundle-dir> <output-dir> [omit-artifact-content|include-artifact-content]",
        );
      }
      if (shareMode !== "omit-artifact-content" && shareMode !== "include-artifact-content") {
        throw usageError("run-audit-share mode must be either omit-artifact-content or include-artifact-content.");
      }

      const resolvedOutputDir = path.isAbsolute(rawOutputDir)
        ? rawOutputDir
        : path.resolve(workspaceRoot, rawOutputDir);
      const resolvedShareOutputDir = path.isAbsolute(rawShareOutputDir)
        ? rawShareOutputDir
        : path.resolve(workspaceRoot, rawShareOutputDir);
      const result = createRunAuditSharePackage(
        resolvedOutputDir,
        resolvedShareOutputDir,
        shareMode === "include-artifact-content",
      );
      printResult(result, jsonOutput, formatRunAuditShare);
      return;
    }
    case "helper": {
      const [runId, questionType, rawFocusStepId, rawCompareStepId, rawVisibilityScope] = rest;
      const visibilityScope =
        parseVisibilityScopeArg(rawVisibilityScope) ??
        parseVisibilityScopeArg(rawCompareStepId) ??
        parseVisibilityScopeArg(rawFocusStepId);
      const focusStepId = parseVisibilityScopeArg(rawFocusStepId) ? undefined : rawFocusStepId;
      const compareStepId = parseVisibilityScopeArg(rawCompareStepId) ? undefined : rawCompareStepId;

      if (!runId || !questionType) {
        throw usageError(
          "Usage: agentgit-authority [--json] helper <run-id> <run_summary|what_happened|summarize_after_boundary|step_details|explain_policy_decision|reversible_steps|why_blocked|likely_cause|suggest_likely_cause|what_changed_after_step|revert_impact|preview_revert_loss|what_would_i_lose_if_i_revert_here|external_side_effects|identify_external_effects|list_actions_touching_scope|compare_steps> [focus-step-id] [compare-step-id] [user|model|internal|sensitive_internal]",
        );
      }

      const result = await client.queryHelper(
        runId,
        questionType as HelperQuestionType,
        focusStepId,
        compareStepId,
        visibilityScope,
      );
      printResult(result, jsonOutput, (value) => formatHelper(value, questionType as HelperQuestionType));
      return;
    }
    case "submit-filesystem-write": {
      const [runId, targetPath, ...contentParts] = rest;

      if (!runId || !targetPath) {
        throw usageError("Usage: agentgit-authority [global-flags] submit-filesystem-write <run-id> <path> <content>");
      }

      const content = contentParts.join(" ");
      const result = await submitAction(client, workspaceRoot, {
        run_id: runId,
        tool_registration: {
          tool_name: "write_file",
          tool_kind: "filesystem",
        },
        raw_call: {
          operation: "write",
          path: targetPath,
          content,
        },
        credential_mode: "none",
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-filesystem-delete": {
      const [runId, targetPath] = rest;

      if (!runId || !targetPath) {
        throw usageError("Usage: agentgit-authority [global-flags] submit-filesystem-delete <run-id> <path>");
      }

      const result = await submitAction(client, workspaceRoot, {
        run_id: runId,
        tool_registration: {
          tool_name: "delete_file",
          tool_kind: "filesystem",
        },
        raw_call: {
          operation: "delete",
          path: targetPath,
        },
        credential_mode: "none",
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-shell": {
      const [runId, ...commandParts] = rest;

      if (!runId || commandParts.length === 0) {
        throw usageError("Usage: agentgit-authority [global-flags] submit-shell <run-id> <command...>");
      }

      const result = await submitAction(client, workspaceRoot, {
        run_id: runId,
        tool_registration: {
          tool_name: "exec_command",
          tool_kind: "shell",
        },
        raw_call: {
          command: commandParts.join(" "),
          argv: commandParts,
        },
        credential_mode: "none",
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-mcp-tool": {
      const [runId, serverId, toolName, ...argumentParts] = rest;

      if (!runId || !serverId || !toolName) {
        throw usageError(
          "Usage: agentgit-authority [--json] submit-mcp-tool <run-id> <server-id> <tool-name> [arguments-json-or-path]",
        );
      }

      const toolArguments =
        argumentParts.length > 0
          ? parseObjectJsonArgument(
              argumentParts.join(" "),
              'submit-mcp-tool expects JSON like {"note":"launch blocker"} for tool arguments',
            )
          : {};

      const result = await submitAction(client, workspaceRoot, {
        run_id: runId,
        tool_registration: {
          tool_name: "mcp_call_tool",
          tool_kind: "mcp",
        },
        raw_call: {
          server_id: serverId,
          tool_name: toolName,
          arguments: toolArguments,
        },
        credential_mode: "none",
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-mcp-profile-tool": {
      const [runId, serverProfileId, toolName, ...argumentParts] = rest;

      if (!runId || !serverProfileId || !toolName) {
        throw usageError(
          "Usage: agentgit-authority [--json] submit-mcp-profile-tool <run-id> <server-profile-id> <tool-name> [arguments-json-or-path]",
        );
      }

      const toolArguments =
        argumentParts.length > 0
          ? parseObjectJsonArgument(
              argumentParts.join(" "),
              'submit-mcp-profile-tool expects JSON like {"note":"launch blocker"} for tool arguments',
            )
          : {};

      const result = await submitAction(client, workspaceRoot, {
        run_id: runId,
        tool_registration: {
          tool_name: "mcp_call_tool",
          tool_kind: "mcp",
        },
        raw_call: {
          server_id: serverProfileId,
          server_profile_id: serverProfileId,
          tool_name: toolName,
          arguments: toolArguments,
        },
        credential_mode: "none",
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-draft-create": {
      const [runId, subject, ...bodyParts] = rest;

      if (!runId || !subject) {
        throw usageError("Usage: agentgit-authority [global-flags] submit-draft-create <run-id> <subject> <body>");
      }

      const result = await submitAction(client, workspaceRoot, {
        run_id: runId,
        tool_registration: {
          tool_name: "drafts_create",
          tool_kind: "function",
        },
        raw_call: {
          integration: "drafts",
          operation: "create_draft",
          subject,
          body: bodyParts.join(" "),
        },
        credential_mode: "none",
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-draft-archive": {
      const [runId, draftId] = rest;

      if (!runId || !draftId) {
        throw usageError("Usage: agentgit-authority [global-flags] submit-draft-archive <run-id> <draft-id>");
      }

      const result = await submitAction(client, workspaceRoot, {
        run_id: runId,
        tool_registration: {
          tool_name: "drafts_archive",
          tool_kind: "function",
        },
        raw_call: {
          integration: "drafts",
          operation: "archive_draft",
          draft_id: draftId,
        },
        credential_mode: "none",
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-draft-delete": {
      const [runId, draftId] = rest;

      if (!runId || !draftId) {
        throw usageError("Usage: agentgit-authority [global-flags] submit-draft-delete <run-id> <draft-id>");
      }

      const result = await submitAction(client, workspaceRoot, {
        run_id: runId,
        tool_registration: {
          tool_name: "drafts_delete",
          tool_kind: "function",
        },
        raw_call: {
          integration: "drafts",
          operation: "delete_draft",
          draft_id: draftId,
        },
        credential_mode: "none",
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-draft-unarchive": {
      const [runId, draftId] = rest;

      if (!runId || !draftId) {
        throw usageError("Usage: agentgit-authority [global-flags] submit-draft-unarchive <run-id> <draft-id>");
      }

      const result = await submitAction(client, workspaceRoot, {
        run_id: runId,
        tool_registration: {
          tool_name: "drafts_unarchive",
          tool_kind: "function",
        },
        raw_call: {
          integration: "drafts",
          operation: "unarchive_draft",
          draft_id: draftId,
        },
        credential_mode: "none",
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-draft-update": {
      const [runId, draftId, subject, ...bodyParts] = rest;

      if (!runId || !draftId || !subject) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] submit-draft-update <run-id> <draft-id> <subject> <body>",
        );
      }

      const result = await submitAction(client, workspaceRoot, {
        run_id: runId,
        tool_registration: {
          tool_name: "drafts_update",
          tool_kind: "function",
        },
        raw_call: {
          integration: "drafts",
          operation: "update_draft",
          draft_id: draftId,
          subject,
          body: bodyParts.join(" "),
        },
        credential_mode: "none",
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-draft-add-label": {
      const [runId, draftId, label] = rest;

      if (!runId || !draftId || !label) {
        throw usageError("Usage: agentgit-authority [global-flags] submit-draft-add-label <run-id> <draft-id> <label>");
      }

      const result = await submitAction(client, workspaceRoot, {
        run_id: runId,
        tool_registration: {
          tool_name: "drafts_add_label",
          tool_kind: "function",
        },
        raw_call: {
          integration: "drafts",
          operation: "add_label",
          draft_id: draftId,
          label,
        },
        credential_mode: "none",
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-draft-remove-label": {
      const [runId, draftId, label] = rest;

      if (!runId || !draftId || !label) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] submit-draft-remove-label <run-id> <draft-id> <label>",
        );
      }

      const result = await submitAction(client, workspaceRoot, {
        run_id: runId,
        tool_registration: {
          tool_name: "drafts_remove_label",
          tool_kind: "function",
        },
        raw_call: {
          integration: "drafts",
          operation: "remove_label",
          draft_id: draftId,
          label,
        },
        credential_mode: "none",
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-draft-restore": {
      const [runId, draftId, ...stateParts] = rest;

      if (!runId || !draftId || stateParts.length === 0) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] submit-draft-restore <run-id> <draft-id> <state-json>",
        );
      }

      const state = parseObjectJsonArgument(
        stateParts.join(" "),
        'submit-draft-restore expects JSON like {"subject":"...","body":"...","status":"active|archived|deleted","labels":[]}',
        (value) => JSON.parse(value),
      );

      const result = await submitAction(client, workspaceRoot, {
        run_id: runId,
        tool_registration: {
          tool_name: "drafts_restore",
          tool_kind: "function",
        },
        raw_call: {
          integration: "drafts",
          operation: "restore_draft",
          draft_id: draftId,
          ...state,
        },
        credential_mode: "none",
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-note-create": {
      const [runId, title, ...bodyParts] = rest;

      if (!runId || !title) {
        throw usageError("Usage: agentgit-authority [global-flags] submit-note-create <run-id> <title> <body>");
      }

      const result = await submitAction(client, workspaceRoot, {
        run_id: runId,
        tool_registration: {
          tool_name: "notes_create",
          tool_kind: "function",
        },
        raw_call: {
          integration: "notes",
          operation: "create_note",
          title,
          body: bodyParts.join(" "),
        },
        credential_mode: "none",
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-note-archive": {
      const [runId, noteId] = rest;

      if (!runId || !noteId) {
        throw usageError("Usage: agentgit-authority [global-flags] submit-note-archive <run-id> <note-id>");
      }

      const result = await submitAction(client, workspaceRoot, {
        run_id: runId,
        tool_registration: {
          tool_name: "notes_archive",
          tool_kind: "function",
        },
        raw_call: {
          integration: "notes",
          operation: "archive_note",
          note_id: noteId,
        },
        credential_mode: "none",
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-note-unarchive": {
      const [runId, noteId] = rest;

      if (!runId || !noteId) {
        throw usageError("Usage: agentgit-authority [global-flags] submit-note-unarchive <run-id> <note-id>");
      }

      const result = await submitAction(client, workspaceRoot, {
        run_id: runId,
        tool_registration: {
          tool_name: "notes_unarchive",
          tool_kind: "function",
        },
        raw_call: {
          integration: "notes",
          operation: "unarchive_note",
          note_id: noteId,
        },
        credential_mode: "none",
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-note-delete": {
      const [runId, noteId] = rest;

      if (!runId || !noteId) {
        throw usageError("Usage: agentgit-authority [global-flags] submit-note-delete <run-id> <note-id>");
      }

      const result = await submitAction(client, workspaceRoot, {
        run_id: runId,
        tool_registration: {
          tool_name: "notes_delete",
          tool_kind: "function",
        },
        raw_call: {
          integration: "notes",
          operation: "delete_note",
          note_id: noteId,
        },
        credential_mode: "none",
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-note-update": {
      const [runId, noteId, title, ...bodyParts] = rest;

      if (!runId || !noteId || !title) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] submit-note-update <run-id> <note-id> <title> <body>",
        );
      }

      const body = bodyParts.join(" ");
      const result = await submitAction(client, workspaceRoot, {
        run_id: runId,
        tool_registration: {
          tool_name: "notes_update",
          tool_kind: "function",
        },
        raw_call: {
          integration: "notes",
          operation: "update_note",
          note_id: noteId,
          title,
          ...(body.length > 0 ? { body } : {}),
        },
        credential_mode: "none",
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-note-restore": {
      const [runId, noteId, ...stateParts] = rest;

      if (!runId || !noteId || stateParts.length === 0) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] submit-note-restore <run-id> <note-id> <state-json>",
        );
      }

      const state = parseObjectJsonArgument(
        stateParts.join(" "),
        'submit-note-restore expects JSON like {"title":"...","body":"...","status":"active|archived|deleted"}',
        (value) => JSON.parse(value),
      );

      const result = await submitAction(client, workspaceRoot, {
        run_id: runId,
        tool_registration: {
          tool_name: "notes_restore",
          tool_kind: "function",
        },
        raw_call: {
          integration: "notes",
          operation: "restore_note",
          note_id: noteId,
          ...state,
        },
        credential_mode: "none",
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-ticket-create": {
      const [runId, title, ...bodyParts] = rest;

      if (!runId || !title) {
        throw usageError("Usage: agentgit-authority [global-flags] submit-ticket-create <run-id> <title> <body>");
      }

      const result = await submitAction(client, workspaceRoot, {
        run_id: runId,
        tool_registration: {
          tool_name: "tickets_create",
          tool_kind: "function",
        },
        raw_call: {
          integration: "tickets",
          operation: "create_ticket",
          title,
          body: bodyParts.join(" "),
        },
        credential_mode: "brokered",
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-ticket-update": {
      const [runId, ticketId, title, ...bodyParts] = rest;

      if (!runId || !ticketId || !title) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] submit-ticket-update <run-id> <ticket-id> <title> <body>",
        );
      }

      const result = await submitAction(client, workspaceRoot, {
        run_id: runId,
        tool_registration: {
          tool_name: "tickets_update",
          tool_kind: "function",
        },
        raw_call: {
          integration: "tickets",
          operation: "update_ticket",
          ticket_id: ticketId,
          title,
          body: bodyParts.join(" "),
        },
        credential_mode: "brokered",
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-ticket-delete": {
      const [runId, ticketId] = rest;

      if (!runId || !ticketId) {
        throw usageError("Usage: agentgit-authority [global-flags] submit-ticket-delete <run-id> <ticket-id>");
      }

      const result = await submitAction(client, workspaceRoot, {
        run_id: runId,
        tool_registration: {
          tool_name: "tickets_delete",
          tool_kind: "function",
        },
        raw_call: {
          integration: "tickets",
          operation: "delete_ticket",
          ticket_id: ticketId,
        },
        credential_mode: "brokered",
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-ticket-restore": {
      const [runId, ticketId, ...stateParts] = rest;

      if (!runId || !ticketId || stateParts.length === 0) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] submit-ticket-restore <run-id> <ticket-id> <state-json>",
        );
      }

      const state = parseObjectJsonArgument(
        stateParts.join(" "),
        'submit-ticket-restore expects JSON like {"title":"...","body":"...","status":"active","labels":[],"assigned_users":[]}',
        (value) => JSON.parse(value),
      );

      const result = await submitAction(client, workspaceRoot, {
        run_id: runId,
        tool_registration: {
          tool_name: "tickets_restore",
          tool_kind: "function",
        },
        raw_call: {
          integration: "tickets",
          operation: "restore_ticket",
          ticket_id: ticketId,
          ...state,
        },
        credential_mode: "brokered",
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-ticket-close": {
      const [runId, ticketId] = rest;

      if (!runId || !ticketId) {
        throw usageError("Usage: agentgit-authority [global-flags] submit-ticket-close <run-id> <ticket-id>");
      }

      const result = await submitAction(client, workspaceRoot, {
        run_id: runId,
        tool_registration: {
          tool_name: "tickets_close",
          tool_kind: "function",
        },
        raw_call: {
          integration: "tickets",
          operation: "close_ticket",
          ticket_id: ticketId,
        },
        credential_mode: "brokered",
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-ticket-reopen": {
      const [runId, ticketId] = rest;

      if (!runId || !ticketId) {
        throw usageError("Usage: agentgit-authority [global-flags] submit-ticket-reopen <run-id> <ticket-id>");
      }

      const result = await submitAction(client, workspaceRoot, {
        run_id: runId,
        tool_registration: {
          tool_name: "tickets_reopen",
          tool_kind: "function",
        },
        raw_call: {
          integration: "tickets",
          operation: "reopen_ticket",
          ticket_id: ticketId,
        },
        credential_mode: "brokered",
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-ticket-add-label": {
      const [runId, ticketId, label] = rest;

      if (!runId || !ticketId || !label) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] submit-ticket-add-label <run-id> <ticket-id> <label>",
        );
      }

      const result = await submitAction(client, workspaceRoot, {
        run_id: runId,
        tool_registration: {
          tool_name: "tickets_add_label",
          tool_kind: "function",
        },
        raw_call: {
          integration: "tickets",
          operation: "add_label",
          ticket_id: ticketId,
          label,
        },
        credential_mode: "brokered",
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-ticket-remove-label": {
      const [runId, ticketId, label] = rest;

      if (!runId || !ticketId || !label) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] submit-ticket-remove-label <run-id> <ticket-id> <label>",
        );
      }

      const result = await submitAction(client, workspaceRoot, {
        run_id: runId,
        tool_registration: {
          tool_name: "tickets_remove_label",
          tool_kind: "function",
        },
        raw_call: {
          integration: "tickets",
          operation: "remove_label",
          ticket_id: ticketId,
          label,
        },
        credential_mode: "brokered",
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-ticket-assign-user": {
      const [runId, ticketId, userId] = rest;

      if (!runId || !ticketId || !userId) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] submit-ticket-assign-user <run-id> <ticket-id> <user-id>",
        );
      }

      const result = await submitAction(client, workspaceRoot, {
        run_id: runId,
        tool_registration: {
          tool_name: "tickets_assign_user",
          tool_kind: "function",
        },
        raw_call: {
          integration: "tickets",
          operation: "assign_user",
          ticket_id: ticketId,
          user_id: userId,
        },
        credential_mode: "brokered",
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-ticket-unassign-user": {
      const [runId, ticketId, userId] = rest;

      if (!runId || !ticketId || !userId) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] submit-ticket-unassign-user <run-id> <ticket-id> <user-id>",
        );
      }

      const result = await submitAction(client, workspaceRoot, {
        run_id: runId,
        tool_registration: {
          tool_name: "tickets_unassign_user",
          tool_kind: "function",
        },
        raw_call: {
          integration: "tickets",
          operation: "unassign_user",
          ticket_id: ticketId,
          user_id: userId,
        },
        credential_mode: "brokered",
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "plan-recovery": {
      const boundaryId = rest[0];

      if (!boundaryId) {
        throw usageError("Usage: agentgit-authority [global-flags] plan-recovery <snapshot-id|action-id>");
      }

      const result = await client.planRecovery(boundaryId);
      printResult(result, jsonOutput, formatPlanRecovery);
      return;
    }
    case "execute-recovery": {
      const boundaryId = rest[0];

      if (!boundaryId) {
        throw usageError("Usage: agentgit-authority [global-flags] execute-recovery <snapshot-id|action-id>");
      }

      const result = await client.executeRecovery(boundaryId);
      printResult(result, jsonOutput, formatExecuteRecovery);
      return;
    }
    default:
      throw usageError(`Unsupported runtime command: ${command}`);
  }
}
