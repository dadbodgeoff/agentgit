#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AuthorityClient } from "@agentgit/authority-sdk";

import { CLI_EXIT_CODES, formatCliJsonError, toCliError, usageError } from "./cli-contract.js";
import { parseGlobalFlags, resolveCliConfig } from "./cli-config.js";
import { printResult } from "./cli-output.js";
import { formatArtifact } from "./formatters/audit.js";
import {
  formatMcpHostPolicies,
  formatMcpSecrets,
  formatMcpServerCandidates,
  formatMcpServerCredentialBindings,
  formatMcpServerProfiles,
  formatMcpServers,
  formatMcpServerTrustDecisions,
} from "./formatters/mcp.js";
import {
  formatCapabilities,
  formatDiagnostics,
  formatHelper,
  formatMaintenance,
  formatRecoveryPlan,
  formatRunSummary,
  formatTimeline,
} from "./formatters/runtime.js";
import {
  buildDoctorResult,
  buildTrustReport,
  formatDaemonStart,
  formatDoctor,
  formatInitResult,
  formatSetupResult,
  formatTrustReport,
  parseInitCommandOptions,
  parseSetupCommandOptions,
  parseTrustReportOptions,
  runDaemonStartCommand,
  runInitProductionCommand,
  runSetupCommand,
} from "./lifecycle.js";
import {
  isConnectedGeneralCommand,
  runConnectedGeneralCommand,
  tryRunStandaloneGeneralCommand,
} from "./commands/general.js";
import { isMcpCommand, runMcpCommand } from "./commands/mcp.js";
import { runPolicyCommand, tryRunStandalonePolicyCommand } from "./commands/policy.js";
import { runProfileCommand } from "./commands/profile.js";
import { isRuntimeCommand, runRuntimeCommand } from "./commands/runtime.js";

export {
  formatArtifact,
  formatCapabilities,
  formatDiagnostics,
  formatHelper,
  formatMaintenance,
  formatMcpHostPolicies,
  formatMcpSecrets,
  formatMcpServerCandidates,
  formatMcpServerCredentialBindings,
  formatMcpServerProfiles,
  formatMcpServerTrustDecisions,
  formatMcpServers,
  formatRecoveryPlan,
  formatRunSummary,
  formatTimeline,
};

const USAGE = [
  "Usage: agentgit-authority [global-flags] <command> [args]",
  "",
  "Global flags:",
  "  --json",
  "  --profile <name>",
  "  --config-root <path>",
  "  --workspace-root <path>",
  "  --socket-path <path>",
  "  --connect-timeout-ms <ms>",
  "  --response-timeout-ms <ms>",
  "  --max-connect-retries <count>",
  "  --connect-retry-delay-ms <ms>",
  "",
  "Commands:",
  "  version",
  "  ping",
  "  doctor",
  "  setup [--profile-name <name>] [--force]",
  "  daemon start",
  "  init --production [--profile-name <name>] [--force]",
  "  trust-report [--run-id <run-id>] [--visibility <user|model|internal|sensitive_internal>]",
  "  onboard-mcp <plan-json-or-path>",
  "  trust-review-mcp <plan-json-or-path>",
  "  release-verify-artifacts [artifacts-dir] [--signature-mode <required|allow-unsigned>] [--public-key-path <path>]",
  "  cloud-roadmap",
  "  config show",
  "  config validate",
  "  profile list",
  "  profile show [name]",
  "  profile use <name>",
  "  profile upsert <name> [--socket-path <path>] [--workspace-root <path>] [--connect-timeout-ms <ms>] [--response-timeout-ms <ms>] [--max-connect-retries <count>] [--connect-retry-delay-ms <ms>]",
  "  profile remove <name>",
  "  policy show",
  "  policy validate <path>",
  "  policy diff <path>",
  "  policy explain <attempt-json-or-path>",
  "  policy calibration-report [--run-id <run-id>] [--include-samples] [--sample-limit <n>]",
  "  policy recommend-thresholds [--run-id <run-id>] [--min-samples <n>]",
  "  policy replay-thresholds [--run-id <run-id>] [--candidate-policy <path>] [--min-samples <n>] [--direction <tighten|relax|all>] [--include-changed-samples] [--sample-limit <n>]",
  "  policy render-threshold-patch [--run-id <run-id>] [--min-samples <n>] [--direction <tighten|relax|all>]",
  "  register-run [workflow-name] [max-mutating] [max-destructive]",
  "  run-summary <run-id>",
  "  capabilities [workspace-root]",
  "  list-mcp-servers",
  "  list-mcp-server-candidates",
  "  submit-mcp-server-candidate <definition-json-or-path>",
  "  list-mcp-server-profiles",
  "  show-mcp-server-review <candidate-id|server-profile-id>",
  "  resolve-mcp-server-candidate <definition-json-or-path>",
  "  list-mcp-server-trust-decisions [server-profile-id]",
  "  approve-mcp-server-profile <definition-json-or-path>",
  "  list-mcp-server-credential-bindings [server-profile-id]",
  "  bind-mcp-server-credentials <definition-json-or-path>",
  "  revoke-mcp-server-credentials <credential-binding-id>",
  "  activate-mcp-server-profile <server-profile-id>",
  "  quarantine-mcp-server-profile <definition-json-or-path>",
  "  revoke-mcp-server-profile <definition-json-or-path>",
  "  list-mcp-secrets",
  "  list-mcp-host-policies",
  "  upsert-mcp-secret <definition-json-or-path>",
  "    or --secret-id <secret-id> [--display-name <name>] [--expires-at <timestamp>] (--bearer-token-file <path> | --bearer-token-stdin | --prompt-bearer-token)",
  "  remove-mcp-secret <secret-id>",
  "  upsert-mcp-host-policy <definition-json-or-path>",
  "  remove-mcp-host-policy <host>",
  "  show-hosted-mcp-job <job-id>",
  "  list-hosted-mcp-jobs [server-profile-id] [queued|running|cancel_requested|succeeded|failed|canceled|dead_letter_retryable|dead_letter_non_retryable]",
  "  requeue-hosted-mcp-job <job-id> [--reset-attempts] [--max-attempts <n>] [--reason <text>]",
  "  cancel-hosted-mcp-job <job-id> [--reason <text>]",
  "  upsert-mcp-server <definition-json-or-path>",
  "  remove-mcp-server <server-id>",
  "  diagnostics [daemon_health|journal_health|maintenance_backlog|projection_lag|storage_summary|capability_summary|policy_summary|security_posture|hosted_worker|hosted_queue...]",
  "  maintenance <job-type...>",
  "  timeline <run-id> [user|model|internal|sensitive_internal]",
  "  artifact <artifact-id> [user|model|internal|sensitive_internal]",
  "  artifact-export <artifact-id> <destination-path> [user|model|internal|sensitive_internal]",
  "  run-audit-export <run-id> <output-dir> [user|model|internal|sensitive_internal]",
  "  run-audit-verify <bundle-dir>",
  "  run-audit-report <bundle-dir>",
  "  run-audit-compare <left-bundle-dir> <right-bundle-dir>",
  "  run-audit-share <bundle-dir> <output-dir> [omit-artifact-content|include-artifact-content]",
  "  list-approvals [run-id] [pending|approved|denied]",
  "  approval-inbox [run-id] [pending|approved|denied]",
  "  approve <approval-id> [note]",
  "  deny <approval-id> [note]",
  "  helper <run-id> <run_summary|what_happened|summarize_after_boundary|step_details|explain_policy_decision|reversible_steps|why_blocked|likely_cause|suggest_likely_cause|what_changed_after_step|revert_impact|preview_revert_loss|what_would_i_lose_if_i_revert_here|external_side_effects|identify_external_effects|list_actions_touching_scope|compare_steps> [focus-step-id] [compare-step-id] [user|model|internal|sensitive_internal]",
  "  submit-filesystem-write <run-id> <path> <content>",
  "  submit-filesystem-delete <run-id> <path>",
  "  submit-shell <run-id> <command...>",
  "  submit-mcp-tool <run-id> <server-id> <tool-name> [arguments-json-or-path]",
  "  submit-mcp-profile-tool <run-id> <server-profile-id> <tool-name> [arguments-json-or-path]",
  "  submit-draft-create <run-id> <subject> <body>",
  "  submit-draft-archive <run-id> <draft-id>",
  "  submit-draft-delete <run-id> <draft-id>",
  "  submit-draft-unarchive <run-id> <draft-id>",
  "  submit-draft-update <run-id> <draft-id> <subject> <body>",
  "  submit-draft-add-label <run-id> <draft-id> <label>",
  "  submit-draft-remove-label <run-id> <draft-id> <label>",
  "  submit-draft-restore <run-id> <draft-id> <state-json>",
  "  submit-note-create <run-id> <title> <body>",
  "  submit-note-archive <run-id> <note-id>",
  "  submit-note-unarchive <run-id> <note-id>",
  "  submit-note-delete <run-id> <note-id>",
  "  submit-note-update <run-id> <note-id> <title> <body>",
  "  submit-note-restore <run-id> <note-id> <state-json>",
  "  submit-ticket-create <run-id> <title> <body>",
  "  submit-ticket-update <run-id> <ticket-id> <title> <body>",
  "  submit-ticket-delete <run-id> <ticket-id>",
  "  submit-ticket-restore <run-id> <ticket-id> <state-json>",
  "  submit-ticket-close <run-id> <ticket-id>",
  "  submit-ticket-reopen <run-id> <ticket-id>",
  "  submit-ticket-add-label <run-id> <ticket-id> <label>",
  "  submit-ticket-remove-label <run-id> <ticket-id> <label>",
  "  submit-ticket-assign-user <run-id> <ticket-id> <user-id>",
  "  submit-ticket-unassign-user <run-id> <ticket-id> <user-id>",
  "  plan-recovery <snapshot-id|action-id>",
  "  execute-recovery <snapshot-id|action-id>",
].join("\n");

function wantsJsonOutput(argv: string[]): boolean {
  return argv.includes("--json");
}

function readCliPackageVersion(): string {
  const packageJsonUrl = new URL("../package.json", import.meta.url);
  const parsed = JSON.parse(fs.readFileSync(packageJsonUrl, "utf8")) as {
    version?: unknown;
  };
  return typeof parsed.version === "string" ? parsed.version : "0.1.0";
}

const CLI_VERSION = readCliPackageVersion();

export async function runCli(argv: string[] = process.argv.slice(2), providedClient?: AuthorityClient): Promise<void> {
  const flags = parseGlobalFlags(argv);
  const { jsonOutput, command, rest } = flags;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  if (
    tryRunStandaloneGeneralCommand({
      command,
      rest,
      flags,
      jsonOutput,
      cliVersion: CLI_VERSION,
    })
  ) {
    return;
  }

  if (command === "policy" && tryRunStandalonePolicyCommand(rest, jsonOutput)) {
    return;
  }

  const resolvedConfig = resolveCliConfig(process.cwd(), flags);
  const workspaceRoot = resolvedConfig.workspace_root.value;

  switch (command) {
    case "setup": {
      const result = runSetupCommand(resolvedConfig, parseSetupCommandOptions(rest));
      printResult(result, jsonOutput, formatSetupResult);
      return;
    }
    case "daemon": {
      const subcommand = rest[0];
      if (subcommand !== "start" || rest.length !== 1) {
        throw usageError("Usage: agentgit-authority [global-flags] daemon start");
      }
      const result = await runDaemonStartCommand(resolvedConfig);
      printResult(result, jsonOutput, formatDaemonStart);
      return;
    }
    default:
      break;
  }

  const client =
    providedClient ??
    new AuthorityClient({
      clientType: "cli",
      clientVersion: CLI_VERSION,
      socketPath: resolvedConfig.socket_path.value,
      defaultWorkspaceRoots: [workspaceRoot],
      connectTimeoutMs: resolvedConfig.connect_timeout_ms.value,
      responseTimeoutMs: resolvedConfig.response_timeout_ms.value,
      maxConnectRetries: resolvedConfig.max_connect_retries.value,
      connectRetryDelayMs: resolvedConfig.connect_retry_delay_ms.value,
    });

  if (isConnectedGeneralCommand(command)) {
    await runConnectedGeneralCommand({
      command,
      client,
      resolvedConfig,
      workspaceRoot,
      rest,
      jsonOutput,
    });
    return;
  }

  if (command === "profile") {
    await runProfileCommand(resolvedConfig, rest, jsonOutput);
    return;
  }

  if (command === "policy") {
    await runPolicyCommand(client, rest, jsonOutput);
    return;
  }

  if (isMcpCommand(command)) {
    await runMcpCommand({
      command,
      client,
      workspaceRoot,
      rest,
      jsonOutput,
    });
    return;
  }

  if (isRuntimeCommand(command)) {
    await runRuntimeCommand({
      command,
      client,
      workspaceRoot,
      rest,
      jsonOutput,
    });
    return;
  }

  switch (command) {
    case "doctor": {
      const result = await buildDoctorResult(client, resolvedConfig, CLI_VERSION);
      printResult(result, jsonOutput, formatDoctor);
      if (result.checks.some((check) => check.status === "fail")) {
        process.exitCode = CLI_EXIT_CODES.UNAVAILABLE;
      }
      return;
    }
    case "init": {
      const options = parseInitCommandOptions(rest);
      const result = await runInitProductionCommand(client, resolvedConfig, options, CLI_VERSION);
      printResult(result, jsonOutput, formatInitResult);
      if (!result.readiness_passed) {
        process.exitCode = CLI_EXIT_CODES.UNAVAILABLE;
      }
      return;
    }
    case "trust-report": {
      const options = parseTrustReportOptions(rest);
      const result = await buildTrustReport(client, resolvedConfig, options, CLI_VERSION);
      printResult(result, jsonOutput, formatTrustReport);
      return;
    }
    default: {
      throw usageError(USAGE);
    }
  }
}

async function main(): Promise<void> {
  await runCli();
}

const invokedPath = process.argv[1];
const modulePath = fileURLToPath(import.meta.url);
const normalizeExecutablePath = (value: string): string => {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
};
const isDirectExecution =
  typeof invokedPath === "string" && normalizeExecutablePath(invokedPath) === normalizeExecutablePath(modulePath);

if (isDirectExecution) {
  main().catch((error: unknown) => {
    const jsonOutput = wantsJsonOutput(process.argv.slice(2));
    const cliError = toCliError(error);

    if (jsonOutput) {
      console.error(JSON.stringify(formatCliJsonError(cliError), null, 2));
    } else {
      console.error(`Error [${cliError.code}]: ${cliError.message}`);
    }

    process.exit(cliError.exitCode);
  });
}
