#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AuthorityClient, AuthorityDaemonResponseError } from "@agentgit/authority-sdk";
import { type PolicyConfig, type PolicyRule } from "@agentgit/schemas";

import {
  compareRunAuditBundles,
  createRunAuditReport,
  createRunAuditSharePackage,
  exportArtifactContent,
  exportRunAuditBundle,
  verifyRunAuditBundle,
} from "./audit/bundles.js";
import {
  CLI_EXIT_CODES,
  formatCliJsonError,
  inputError,
  ioError,
  toCliError,
  usageError,
} from "./cli-contract.js";
import {
  type CliProfileRecord,
  type CliResolvedConfig,
  getProfileFromResolvedConfig,
  listProfileNames,
  parseGlobalFlags,
  readUserConfig,
  resolveCliConfig,
  setActiveUserProfile,
  upsertUserProfile,
  validateCliConfig,
  writeUserConfig,
  removeUserProfile,
} from "./cli-config.js";
import { parseSecretCommandOptions, secretUsage } from "./cli-secret-input.js";
import {
  formatArtifact,
  formatArtifactExport,
  formatRunAuditCompare,
  formatRunAuditExport,
  formatRunAuditReport,
  formatRunAuditShare,
  formatRunAuditVerify,
} from "./formatters/audit.js";
import {
  bulletList,
  clipText,
  formatBudget,
  formatConfidence,
  formatTimestamp,
  lines,
} from "./formatters/core.js";
import {
  formatCancelHostedMcpJob,
  formatHostedMcpJob,
  formatHostedMcpJobs,
  formatMcpHostPolicies,
  formatMcpSecrets,
  formatMcpServerCandidates,
  formatMcpServerCredentialBindings,
  formatMcpServerProfiles,
  formatMcpServerReview,
  formatMcpServers,
  formatMcpServerTrustDecisions,
  formatRequeueHostedMcpJob,
} from "./formatters/mcp.js";
import {
  formatApprovalInbox,
  formatApprovalList,
  formatCapabilities,
  formatDiagnostics,
  formatExecuteRecovery,
  formatHelper,
  formatMaintenance,
  formatPlanRecovery,
  formatRecoveryPlan,
  formatResolveApproval,
  formatRunSummary,
  formatSubmitAction,
  formatTimeline,
  formatTimelineStep,
} from "./formatters/runtime.js";
import {
  buildDoctorResult,
  buildTrustReport,
  cloudRoadmapResult,
  formatCloudRoadmapResult,
  formatConfigShow,
  formatConfigValidation,
  formatDaemonStart,
  formatDoctor,
  formatHello,
  formatInitResult,
  formatProfileList,
  formatRegisterRun,
  formatSetupResult,
  formatTrustReport,
  formatVersion,
  parseInitCommandOptions,
  parseSetupCommandOptions,
  parseTrustReportOptions,
  runDaemonStartCommand,
  runInitProductionCommand,
  runSetupCommand,
  versionResult,
} from "./lifecycle.js";
import {
  formatMcpOnboardResult,
  formatMcpTrustReviewResult,
  parseMcpOnboardPlan,
  parseMcpTrustReviewPlan,
  runMcpOnboardPlan,
  runMcpTrustReviewPlan,
} from "./mcp/plans.js";
import { parseIntegerFlag, parseJsonArgOrFile, parseVisibilityScopeArg, shiftCommandValue } from "./parsers/common.js";
import {
  buildPolicyDiffResult,
  formatEffectivePolicy,
  formatPolicyCalibrationReport,
  formatPolicyDiff,
  formatPolicyExplanation,
  formatPolicyThresholdPatch,
  formatPolicyThresholdRecommendations,
  formatPolicyThresholdReplay,
  formatPolicyValidation,
  loadPolicyDocument,
  loadPolicyThresholdCandidates,
  renderThresholdPatch,
  validatePolicyConfigDocument,
} from "./policy.js";
import {
  formatReleaseArtifactVerifyResult,
  parseReleaseVerifyCommandArgs,
  verifyReleaseArtifacts,
} from "./release.js";

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

type HelloResult = Awaited<ReturnType<AuthorityClient["hello"]>>;
type RegisterRunResult = Awaited<ReturnType<AuthorityClient["registerRun"]>>;
type RunSummaryResult = Awaited<ReturnType<AuthorityClient["getRunSummary"]>>;
type CapabilitiesResult = Awaited<ReturnType<AuthorityClient["getCapabilities"]>>;
type EffectivePolicyResult = Awaited<ReturnType<AuthorityClient["getEffectivePolicy"]>>;
type ExplainPolicyActionResult = Awaited<ReturnType<AuthorityClient["explainPolicyAction"]>>;
type PolicyCalibrationReportResult = Awaited<ReturnType<AuthorityClient["getPolicyCalibrationReport"]>>;
type PolicyThresholdRecommendationsResult = Awaited<ReturnType<AuthorityClient["getPolicyThresholdRecommendations"]>>;
type PolicyThresholdReplayResult = Awaited<ReturnType<AuthorityClient["replayPolicyThresholds"]>>;
interface PolicyValidationResult {
  valid: boolean;
  issues: string[];
  normalized_config: PolicyConfig | null;
  compiled_policy: {
    rules: PolicyRule[];
  } | null;
}
type ListMcpServersResult = Awaited<ReturnType<AuthorityClient["listMcpServers"]>>;
type ListMcpServerCandidatesResult = Awaited<ReturnType<AuthorityClient["listMcpServerCandidates"]>>;
type SubmitMcpServerCandidateResult = Awaited<ReturnType<AuthorityClient["submitMcpServerCandidate"]>>;
type ListMcpServerProfilesResult = Awaited<ReturnType<AuthorityClient["listMcpServerProfiles"]>>;
type GetMcpServerReviewResult = Awaited<ReturnType<AuthorityClient["getMcpServerReview"]>>;
type ResolveMcpServerCandidateResult = Awaited<ReturnType<AuthorityClient["resolveMcpServerCandidate"]>>;
type ListMcpServerTrustDecisionsResult = Awaited<ReturnType<AuthorityClient["listMcpServerTrustDecisions"]>>;
type ListMcpServerCredentialBindingsResult = Awaited<ReturnType<AuthorityClient["listMcpServerCredentialBindings"]>>;
type BindMcpServerCredentialsResult = Awaited<ReturnType<AuthorityClient["bindMcpServerCredentials"]>>;
type RevokeMcpServerCredentialsResult = Awaited<ReturnType<AuthorityClient["revokeMcpServerCredentials"]>>;
type ApproveMcpServerProfileResult = Awaited<ReturnType<AuthorityClient["approveMcpServerProfile"]>>;
type ActivateMcpServerProfileResult = Awaited<ReturnType<AuthorityClient["activateMcpServerProfile"]>>;
type QuarantineMcpServerProfileResult = Awaited<ReturnType<AuthorityClient["quarantineMcpServerProfile"]>>;
type RevokeMcpServerProfileResult = Awaited<ReturnType<AuthorityClient["revokeMcpServerProfile"]>>;
type ListMcpSecretsResult = Awaited<ReturnType<AuthorityClient["listMcpSecrets"]>>;
type ListMcpHostPoliciesResult = Awaited<ReturnType<AuthorityClient["listMcpHostPolicies"]>>;
type UpsertMcpSecretResult = Awaited<ReturnType<AuthorityClient["upsertMcpSecret"]>>;
type RemoveMcpSecretResult = Awaited<ReturnType<AuthorityClient["removeMcpSecret"]>>;
type UpsertMcpHostPolicyResult = Awaited<ReturnType<AuthorityClient["upsertMcpHostPolicy"]>>;
type RemoveMcpHostPolicyResult = Awaited<ReturnType<AuthorityClient["removeMcpHostPolicy"]>>;
type ShowHostedMcpJobResult = Awaited<ReturnType<AuthorityClient["getHostedMcpJob"]>>;
type ListHostedMcpJobsResult = Awaited<ReturnType<AuthorityClient["listHostedMcpJobs"]>>;
type RequeueHostedMcpJobResult = Awaited<ReturnType<AuthorityClient["requeueHostedMcpJob"]>>;
type CancelHostedMcpJobResult = Awaited<ReturnType<AuthorityClient["cancelHostedMcpJob"]>>;
type UpsertMcpServerResult = Awaited<ReturnType<AuthorityClient["upsertMcpServer"]>>;
type RemoveMcpServerResult = Awaited<ReturnType<AuthorityClient["removeMcpServer"]>>;
type DiagnosticsResult = Awaited<ReturnType<AuthorityClient["diagnostics"]>>;
type MaintenanceResult = Awaited<ReturnType<AuthorityClient["runMaintenance"]>>;
type SubmitActionResult = Awaited<ReturnType<AuthorityClient["submitActionAttempt"]>>;
type ListApprovalsResult = Awaited<ReturnType<AuthorityClient["listApprovals"]>>;
type ApprovalInboxResult = Awaited<ReturnType<AuthorityClient["queryApprovalInbox"]>>;
type ResolveApprovalResult = Awaited<ReturnType<AuthorityClient["resolveApproval"]>>;
type TimelineResult = Awaited<ReturnType<AuthorityClient["queryTimeline"]>>;
type HelperResult = Awaited<ReturnType<AuthorityClient["queryHelper"]>>;
interface PolicyDiffResult {
  comparison_mode: "candidate_overlay";
  effective_profile_name: string;
  candidate_profile_name: string;
  effective_policy_version: string;
  candidate_policy_version: string;
  threshold_additions: Array<{ action_family: string; ask_below: number }>;
  threshold_changes: Array<{ action_family: string; current_ask_below: number; candidate_ask_below: number }>;
  threshold_unchanged_count: number;
  added_rule_ids: string[];
  changed_rule_ids: string[];
  unchanged_rule_ids: string[];
  omitted_effective_rule_count: number;
}
interface PolicyThresholdPatchResult {
  generated_at: string;
  effective_policy_profile: string;
  run_id: string | null;
  min_samples: number;
  direction_filter: "tighten" | "relax" | "all";
  included_recommendations: Array<{
    action_family: string;
    current_ask_below: number | null;
    recommended_ask_below: number | null;
    direction: "tighten" | "relax" | "hold";
    rationale: string;
  }>;
  patch_toml: string;
  report_only: true;
  replay: {
    replayable_samples: number;
    skipped_samples: number;
    changed_decisions: number;
    approvals_reduced: number;
    approvals_increased: number;
    historically_denied_auto_allowed: number;
    historically_allowed_newly_gated: number;
  } | null;
}
interface ConfigShowResult {
  resolved: CliResolvedConfig;
}
interface ProfileListResult {
  active_profile: string | null;
  profiles: Array<{
    name: string;
    source: "user" | "workspace" | "both";
    active: boolean;
  }>;
}
type ReleaseSignatureMode = "required" | "allow-unsigned";
interface ReleaseArtifactVerifyResult {
  ok: true;
  artifacts_dir: string;
  manifest_path: string;
  manifest_sha256_verified: true;
  signature_mode: ReleaseSignatureMode;
  signature_present: boolean;
  signature_verified: boolean;
  packages: Array<{
    name: string;
    tarball_path: string;
    sha256: string;
    verified: true;
  }>;
}
type PlanRecoveryResult = Awaited<ReturnType<AuthorityClient["planRecovery"]>>;
type ExecuteRecoveryResult = Awaited<ReturnType<AuthorityClient["executeRecovery"]>>;
type HelperQuestionType = Parameters<AuthorityClient["queryHelper"]>[1];
type TimelineStep = TimelineResult["steps"][number];
type RecoveryPlan = PlanRecoveryResult["recovery_plan"];
type TimelineArtifact = TimelineStep["primary_artifacts"][number];
type TimelineArtifactPreview = TimelineStep["artifact_previews"][number];
type PolicyReason = SubmitActionResult["policy_outcome"]["reasons"][number];
type ApprovalRequest = ListApprovalsResult["approvals"][number];
type ApprovalInboxItem = ApprovalInboxResult["items"][number];
type HelperEvidence = HelperResult["evidence"][number];
type RecoveryPlanStep = RecoveryPlan["steps"][number];
type DiagnosticsSection = NonNullable<Parameters<AuthorityClient["diagnostics"]>[0]>[number];
type MaintenanceJobType = Parameters<AuthorityClient["runMaintenance"]>[0][number];
type HostedMcpJobStatus = ListHostedMcpJobsResult["jobs"][number]["status"];
type HostedMcpJobLifecycleState = ShowHostedMcpJobResult["lifecycle"]["state"];
type CapabilityRecord = CapabilitiesResult["capabilities"][number];
type RegisteredMcpServer = ListMcpServersResult["servers"][number];
type RegisteredMcpSecret = ListMcpSecretsResult["secrets"][number];
type RegisteredMcpHostPolicy = ListMcpHostPoliciesResult["policies"][number];
type ReasonDetail = NonNullable<DiagnosticsResult["daemon_health"]>["primary_reason"];

interface TimelineTrustSummary {
  nonGoverned: number;
  imported: number;
  observed: number;
  unknown: number;
}

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
const HOSTED_MCP_JOB_STATUSES = new Set<HostedMcpJobStatus>([
  "queued",
  "running",
  "cancel_requested",
  "succeeded",
  "failed",
  "canceled",
]);
const HOSTED_MCP_JOB_LIFECYCLE_STATES = new Set<HostedMcpJobLifecycleState>([
  "queued",
  "running",
  "cancel_requested",
  "succeeded",
  "dead_letter_retryable",
  "dead_letter_non_retryable",
  "canceled",
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

function parseDiagnosticsSections(args: string[]): DiagnosticsSection[] {
  return args.filter((value): value is DiagnosticsSection => DIAGNOSTICS_SECTIONS.has(value as DiagnosticsSection));
}

function parseMaintenanceJobTypes(args: string[]): MaintenanceJobType[] {
  return args.filter((value): value is MaintenanceJobType => MAINTENANCE_JOB_TYPES.has(value as MaintenanceJobType));
}

function parseHostedMcpJobFilter(value: string | undefined): {
  status?: HostedMcpJobStatus;
  lifecycle_state?: HostedMcpJobLifecycleState;
} {
  if (!value) {
    return {};
  }

  if (HOSTED_MCP_JOB_STATUSES.has(value as HostedMcpJobStatus)) {
    return {
      status: value as HostedMcpJobStatus,
    };
  }

  if (HOSTED_MCP_JOB_LIFECYCLE_STATES.has(value as HostedMcpJobLifecycleState)) {
    return {
      lifecycle_state: value as HostedMcpJobLifecycleState,
    };
  }

  throw inputError(
    "Hosted MCP job filter must be one of queued, running, cancel_requested, succeeded, failed, canceled, dead_letter_retryable, or dead_letter_non_retryable.",
    {
      filter: value,
    },
  );
}

function parseRequeueHostedMcpJobOptions(args: string[]): {
  reset_attempt_count?: boolean;
  max_attempts?: number;
  reason?: string;
} {
  const options: {
    reset_attempt_count?: boolean;
    max_attempts?: number;
    reason?: string;
  } = {};
  const rest = [...args];

  while (rest.length > 0) {
    const current = rest.shift();
    switch (current) {
      case "--reset-attempts":
        options.reset_attempt_count = true;
        break;
      case "--max-attempts":
        options.max_attempts = parseIntegerFlag(shiftCommandValue(rest, "--max-attempts"), "--max-attempts");
        if ((options.max_attempts ?? 0) < 1) {
          throw inputError("--max-attempts expects a positive integer.", {
            flag: "--max-attempts",
            value: options.max_attempts,
          });
        }
        break;
      case "--reason":
        options.reason = shiftCommandValue(rest, "--reason");
        if (options.reason.trim().length === 0) {
          throw inputError("--reason expects a non-empty value.", {
            flag: "--reason",
          });
        }
        break;
      default:
        throw inputError(`Unknown requeue-hosted-mcp-job flag: ${current}`, {
          flag: current,
        });
    }
  }

  return options;
}

function parseCancelHostedMcpJobOptions(args: string[]): {
  reason?: string;
} {
  const options: {
    reason?: string;
  } = {};
  const rest = [...args];

  while (rest.length > 0) {
    const current = rest.shift();
    switch (current) {
      case "--reason":
        options.reason = shiftCommandValue(rest, "--reason");
        if (options.reason.trim().length === 0) {
          throw inputError("--reason expects a non-empty value.", {
            flag: "--reason",
          });
        }
        break;
      default:
        throw inputError(`Unknown cancel-hosted-mcp-job flag: ${current}`, {
          flag: current,
        });
    }
  }

  return options;
}

function printResult<T>(result: T, jsonOutput: boolean, format: (value: T) => string): void {
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(format(result));
}

function formatReasonDetail(reason: ReasonDetail | null | undefined): string | null {
  return reason ? `${reason.code}: ${reason.message}` : null;
}

function summarizeTimelineTrust(steps: TimelineStep[]): TimelineTrustSummary {
  const summary: TimelineTrustSummary = {
    nonGoverned: 0,
    imported: 0,
    observed: 0,
    unknown: 0,
  };

  for (const step of steps) {
    if (step.provenance === "governed") {
      continue;
    }

    summary.nonGoverned += 1;

    if (step.provenance === "imported") {
      summary.imported += 1;
    } else if (step.provenance === "observed") {
      summary.observed += 1;
    } else if (step.provenance === "unknown") {
      summary.unknown += 1;
    }
  }

  return summary;
}

function formatTimelineTrustSummary(steps: TimelineStep[]): string | null {
  const summary = summarizeTimelineTrust(steps);

  if (summary.nonGoverned === 0) {
    return "Trust summary: all projected steps are governed.";
  }

  const parts = [
    summary.imported > 0 ? `${summary.imported} imported` : null,
    summary.observed > 0 ? `${summary.observed} observed` : null,
    summary.unknown > 0 ? `${summary.unknown} unknown` : null,
  ].filter((value): value is string => value !== null);

  return `Trust summary: ${summary.nonGoverned} non-governed step(s) detected${parts.length > 0 ? ` (${parts.join(", ")})` : ""}.`;
}

function formatPreviewBudget(result: {
  preview_budget: {
    preview_chars_used: number;
    max_total_inline_preview_chars: number;
    truncated_previews: number;
    omitted_previews: number;
  };
}): string {
  const budget = result.preview_budget;
  return `Preview budget: ${budget.preview_chars_used}/${budget.max_total_inline_preview_chars} chars used, ${budget.truncated_previews} truncated, ${budget.omitted_previews} omitted`;
}

function parseProfileUpsertArgs(args: string[]): { name: string; values: CliProfileRecord } {
  const [name, ...rest] = args;
  if (!name) {
    throw usageError(
      "Usage: agentgit-authority [global-flags] profile upsert <name> [--socket-path <path>] [--workspace-root <path>] [--connect-timeout-ms <ms>] [--response-timeout-ms <ms>] [--max-connect-retries <count>] [--connect-retry-delay-ms <ms>]",
    );
  }

  const values: CliProfileRecord = {};
  while (rest.length > 0) {
    const current = rest.shift()!;
    switch (current) {
      case "--socket-path":
        values.socket_path = path.resolve(shiftCommandValue(rest, "--socket-path"));
        break;
      case "--workspace-root":
        values.workspace_root = path.resolve(shiftCommandValue(rest, "--workspace-root"));
        break;
      case "--connect-timeout-ms":
        values.connect_timeout_ms = parseIntegerFlag(
          shiftCommandValue(rest, "--connect-timeout-ms"),
          "--connect-timeout-ms",
        );
        break;
      case "--response-timeout-ms":
        values.response_timeout_ms = parseIntegerFlag(
          shiftCommandValue(rest, "--response-timeout-ms"),
          "--response-timeout-ms",
        );
        break;
      case "--max-connect-retries":
        values.max_connect_retries = parseIntegerFlag(
          shiftCommandValue(rest, "--max-connect-retries"),
          "--max-connect-retries",
        );
        break;
      case "--connect-retry-delay-ms":
        values.connect_retry_delay_ms = parseIntegerFlag(
          shiftCommandValue(rest, "--connect-retry-delay-ms"),
          "--connect-retry-delay-ms",
        );
        break;
      default:
        throw inputError(`Unknown profile upsert flag: ${current}`, {
          flag: current,
        });
    }
  }

  return {
    name,
    values,
  };
}

export async function runCli(argv: string[] = process.argv.slice(2), providedClient?: AuthorityClient): Promise<void> {
  const flags = parseGlobalFlags(argv);
  const { jsonOutput, command, rest } = flags;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }

  switch (command) {
    case "version": {
      printResult(versionResult(CLI_VERSION), jsonOutput, formatVersion);
      return;
    }
    case "release-verify-artifacts": {
      const workspaceRootForLocal = path.resolve(flags.workspaceRoot ?? process.cwd());
      const options = parseReleaseVerifyCommandArgs(rest, workspaceRootForLocal);
      const result = verifyReleaseArtifacts(options);
      printResult(result, jsonOutput, formatReleaseArtifactVerifyResult);
      return;
    }
    case "cloud-roadmap": {
      if (rest.length > 0) {
        throw usageError("Usage: agentgit-authority [global-flags] cloud-roadmap");
      }
      const result = cloudRoadmapResult();
      printResult(result, jsonOutput, formatCloudRoadmapResult);
      return;
    }
    case "config": {
      const subcommand = rest[0];
      if (subcommand === "validate") {
        const result = validateCliConfig(process.cwd(), {
          configRoot: flags.configRoot,
          workspaceRoot: flags.workspaceRoot,
        });
        printResult(result, jsonOutput, formatConfigValidation);
        if (!result.valid) {
          process.exitCode = CLI_EXIT_CODES.CONFIG_ERROR;
        }
        return;
      }
      break;
    }
    case "policy": {
      const subcommand = rest[0];
      if (subcommand === "validate") {
        const policyPath = rest[1];
        if (!policyPath) {
          throw usageError("Usage: agentgit-authority [global-flags] policy validate <path>");
        }

        const result = validatePolicyConfigDocument(loadPolicyDocument(policyPath));
        printResult(result, jsonOutput, formatPolicyValidation);
        if (!result.valid) {
          process.exitCode = CLI_EXIT_CODES.CONFIG_ERROR;
        }
        return;
      }
      break;
    }
    default:
      break;
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
      connectTimeoutMs: resolvedConfig.connect_timeout_ms.value,
      responseTimeoutMs: resolvedConfig.response_timeout_ms.value,
      maxConnectRetries: resolvedConfig.max_connect_retries.value,
      connectRetryDelayMs: resolvedConfig.connect_retry_delay_ms.value,
    });

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
    case "onboard-mcp": {
      const planArg = rest[0];
      if (!planArg) {
        throw usageError("Usage: agentgit-authority [global-flags] onboard-mcp <plan-json-or-path>");
      }
      if (rest.length > 1) {
        throw usageError("Usage: agentgit-authority [global-flags] onboard-mcp <plan-json-or-path>");
      }

      const parsedPlan = parseMcpOnboardPlan(parseJsonArgOrFile(planArg));
      const result = await runMcpOnboardPlan(client, workspaceRoot, parsedPlan);
      printResult(result, jsonOutput, formatMcpOnboardResult);
      if (result.smoke_test && !result.smoke_test.success) {
        process.exitCode = CLI_EXIT_CODES.UNAVAILABLE;
      }
      return;
    }
    case "trust-review-mcp": {
      const planArg = rest[0];
      if (!planArg) {
        throw usageError("Usage: agentgit-authority [global-flags] trust-review-mcp <plan-json-or-path>");
      }
      if (rest.length > 1) {
        throw usageError("Usage: agentgit-authority [global-flags] trust-review-mcp <plan-json-or-path>");
      }

      const parsedPlan = parseMcpTrustReviewPlan(parseJsonArgOrFile(planArg));
      const result = await runMcpTrustReviewPlan(client, workspaceRoot, parsedPlan);
      printResult(result, jsonOutput, formatMcpTrustReviewResult);
      if ((result.smoke_test && !result.smoke_test.success) || !result.review.review.executable) {
        process.exitCode = CLI_EXIT_CODES.UNAVAILABLE;
      }
      return;
    }
    case "config": {
      const subcommand = rest[0];
      if (subcommand === "show") {
        printResult({ resolved: resolvedConfig } satisfies ConfigShowResult, jsonOutput, formatConfigShow);
        return;
      }

      throw usageError("Usage: agentgit-authority [global-flags] config <show|validate>");
    }
    case "policy": {
      const subcommand = rest[0];
      if (subcommand === "show") {
        const result = await client.getEffectivePolicy();
        printResult(result, jsonOutput, formatEffectivePolicy);
        return;
      }
      if (subcommand === "diff") {
        const policyPath = rest[1];
        if (!policyPath) {
          throw usageError("Usage: agentgit-authority [global-flags] policy diff <path>");
        }

        const validation = validatePolicyConfigDocument(loadPolicyDocument(policyPath));
        if (!validation.valid || !validation.normalized_config) {
          throw inputError(
            `Policy diff requires a valid policy file: ${validation.issues.join("; ") || "unknown validation error"}`,
          );
        }

        const effectivePolicy = await client.getEffectivePolicy();
        const result = buildPolicyDiffResult(effectivePolicy, validation.normalized_config);
        printResult(result, jsonOutput, formatPolicyDiff);
        return;
      }
      if (subcommand === "explain") {
        const definitionArg = rest[1];
        if (!definitionArg) {
          throw usageError("Usage: agentgit-authority [global-flags] policy explain <attempt-json-or-path>");
        }

        const result = await client.explainPolicyAction(
          parseJsonArgOrFile(definitionArg) as Parameters<AuthorityClient["explainPolicyAction"]>[0],
        );
        printResult(result, jsonOutput, formatPolicyExplanation);
        return;
      }
      if (subcommand === "calibration-report") {
        const args = rest.slice(1);
        let runId: string | undefined;
        let includeSamples = false;
        let sampleLimit: number | undefined;

        while (args.length > 0) {
          const current = args.shift()!;
          switch (current) {
            case "--run-id":
              runId = shiftCommandValue(args, "--run-id");
              break;
            case "--include-samples":
              includeSamples = true;
              break;
            case "--sample-limit":
              sampleLimit = parseIntegerFlag(shiftCommandValue(args, "--sample-limit"), "--sample-limit");
              if (sampleLimit <= 0) {
                throw inputError("--sample-limit expects a positive integer.", {
                  flag: "--sample-limit",
                  value: sampleLimit,
                });
              }
              break;
            default:
              throw inputError(`Unknown policy calibration-report flag: ${current}`, {
                flag: current,
              });
          }
        }

        const result = await client.getPolicyCalibrationReport({
          ...(runId ? { run_id: runId } : {}),
          include_samples: includeSamples,
          ...(sampleLimit !== undefined ? { sample_limit: sampleLimit } : {}),
        });
        printResult(result, jsonOutput, formatPolicyCalibrationReport);
        return;
      }
      if (subcommand === "recommend-thresholds") {
        const args = rest.slice(1);
        let runId: string | undefined;
        let minSamples: number | undefined;

        while (args.length > 0) {
          const current = args.shift()!;
          switch (current) {
            case "--run-id":
              runId = shiftCommandValue(args, "--run-id");
              break;
            case "--min-samples":
              minSamples = parseIntegerFlag(shiftCommandValue(args, "--min-samples"), "--min-samples");
              if (minSamples <= 0) {
                throw inputError("--min-samples expects a positive integer.", {
                  flag: "--min-samples",
                  value: minSamples,
                });
              }
              break;
            default:
              throw inputError(`Unknown policy recommend-thresholds flag: ${current}`, {
                flag: current,
              });
          }
        }

        const result = await client.getPolicyThresholdRecommendations({
          ...(runId ? { run_id: runId } : {}),
          ...(minSamples !== undefined ? { min_samples: minSamples } : {}),
        });
        printResult(result, jsonOutput, formatPolicyThresholdRecommendations);
        return;
      }
      if (subcommand === "replay-thresholds") {
        const args = rest.slice(1);
        let runId: string | undefined;
        let minSamples: number | undefined;
        let directionFilter: "tighten" | "relax" | "all" = "all";
        let candidatePolicyPath: string | undefined;
        let includeChangedSamples = false;
        let sampleLimit: number | undefined;

        while (args.length > 0) {
          const current = args.shift()!;
          switch (current) {
            case "--run-id":
              runId = shiftCommandValue(args, "--run-id");
              break;
            case "--candidate-policy":
              candidatePolicyPath = shiftCommandValue(args, "--candidate-policy");
              break;
            case "--min-samples":
              minSamples = parseIntegerFlag(shiftCommandValue(args, "--min-samples"), "--min-samples");
              if (minSamples <= 0) {
                throw inputError("--min-samples expects a positive integer.", {
                  flag: "--min-samples",
                  value: minSamples,
                });
              }
              break;
            case "--direction": {
              const parsed = shiftCommandValue(args, "--direction");
              if (parsed !== "tighten" && parsed !== "relax" && parsed !== "all") {
                throw inputError("--direction expects one of: tighten, relax, all.", {
                  flag: "--direction",
                  value: parsed,
                });
              }
              directionFilter = parsed;
              break;
            }
            case "--include-changed-samples":
              includeChangedSamples = true;
              break;
            case "--sample-limit":
              sampleLimit = parseIntegerFlag(shiftCommandValue(args, "--sample-limit"), "--sample-limit");
              if (sampleLimit <= 0) {
                throw inputError("--sample-limit expects a positive integer.", {
                  flag: "--sample-limit",
                  value: sampleLimit,
                });
              }
              break;
            default:
              throw inputError(`Unknown policy replay-thresholds flag: ${current}`, {
                flag: current,
              });
          }
        }

        const candidateThresholds = candidatePolicyPath
          ? loadPolicyThresholdCandidates(candidatePolicyPath)
          : renderThresholdPatch(
              await client.getPolicyThresholdRecommendations({
                ...(runId ? { run_id: runId } : {}),
                ...(minSamples !== undefined ? { min_samples: minSamples } : {}),
              }),
              directionFilter,
            ).included_recommendations.map((entry) => ({
              action_family: entry.action_family,
              ask_below: entry.recommended_ask_below!,
            }));

        const result = await client.replayPolicyThresholds({
          ...(runId ? { run_id: runId } : {}),
          candidate_thresholds: candidateThresholds,
          ...(includeChangedSamples ? { include_changed_samples: true } : {}),
          ...(sampleLimit !== undefined ? { sample_limit: sampleLimit } : {}),
        });
        printResult(result, jsonOutput, formatPolicyThresholdReplay);
        return;
      }
      if (subcommand === "render-threshold-patch") {
        const args = rest.slice(1);
        let runId: string | undefined;
        let minSamples: number | undefined;
        let directionFilter: "tighten" | "relax" | "all" = "all";

        while (args.length > 0) {
          const current = args.shift()!;
          switch (current) {
            case "--run-id":
              runId = shiftCommandValue(args, "--run-id");
              break;
            case "--min-samples":
              minSamples = parseIntegerFlag(shiftCommandValue(args, "--min-samples"), "--min-samples");
              if (minSamples <= 0) {
                throw inputError("--min-samples expects a positive integer.", {
                  flag: "--min-samples",
                  value: minSamples,
                });
              }
              break;
            case "--direction": {
              const parsed = shiftCommandValue(args, "--direction");
              if (parsed !== "tighten" && parsed !== "relax" && parsed !== "all") {
                throw inputError("--direction expects one of: tighten, relax, all.", {
                  flag: "--direction",
                  value: parsed,
                });
              }
              directionFilter = parsed;
              break;
            }
            default:
              throw inputError(`Unknown policy render-threshold-patch flag: ${current}`, {
                flag: current,
              });
          }
        }

        const recommendations = await client.getPolicyThresholdRecommendations({
          ...(runId ? { run_id: runId } : {}),
          ...(minSamples !== undefined ? { min_samples: minSamples } : {}),
        });
        const candidateThresholds = renderThresholdPatch(recommendations, directionFilter).included_recommendations.map(
          (entry) => ({
            action_family: entry.action_family,
            ask_below: entry.recommended_ask_below!,
          }),
        );
        const replay = await client.replayPolicyThresholds({
          ...(runId ? { run_id: runId } : {}),
          candidate_thresholds: candidateThresholds,
        });
        const result = renderThresholdPatch(recommendations, directionFilter, replay);
        printResult(result, jsonOutput, formatPolicyThresholdPatch);
        return;
      }

      throw usageError(
        "Usage: agentgit-authority [global-flags] policy <show|validate <path>|diff <path>|explain <attempt-json-or-path>|calibration-report [--run-id <run-id>] [--include-samples] [--sample-limit <n>]|recommend-thresholds [--run-id <run-id>] [--min-samples <n>]|replay-thresholds [--run-id <run-id>] [--candidate-policy <path>] [--min-samples <n>] [--direction <tighten|relax|all>] [--include-changed-samples] [--sample-limit <n>]|render-threshold-patch [--run-id <run-id>] [--min-samples <n>] [--direction <tighten|relax|all>]>",
      );
    }
    case "profile": {
      const subcommand = rest[0];
      if (subcommand === "list") {
        const result = {
          active_profile: resolvedConfig.active_profile,
          profiles: listProfileNames(resolvedConfig),
        } satisfies ProfileListResult;
        printResult(result, jsonOutput, formatProfileList);
        return;
      }

      const userConfig = readUserConfig(resolvedConfig.paths.configRoot, process.cwd(), process.env);

      if (subcommand === "show") {
        const selectedProfile = getProfileFromResolvedConfig(resolvedConfig, rest[1]);
        if (!selectedProfile) {
          throw inputError(`Profile ${rest[1] ?? resolvedConfig.active_profile ?? "<none>"} is not configured.`);
        }

        printResult(
          {
            profile: selectedProfile,
          },
          jsonOutput,
          (value: { profile: NonNullable<ReturnType<typeof getProfileFromResolvedConfig>> }) =>
            lines(
              `Profile ${value.profile.name}`,
              `Source: ${value.profile.source}`,
              `Socket path: ${value.profile.profile.socket_path ?? "unset"}`,
              `Workspace root: ${value.profile.profile.workspace_root ?? "unset"}`,
              `Connect timeout: ${value.profile.profile.connect_timeout_ms ?? "unset"}`,
              `Response timeout: ${value.profile.profile.response_timeout_ms ?? "unset"}`,
              `Max connect retries: ${value.profile.profile.max_connect_retries ?? "unset"}`,
              `Connect retry delay: ${value.profile.profile.connect_retry_delay_ms ?? "unset"}`,
            ),
        );
        return;
      }

      if (subcommand === "use") {
        const profileName = rest[1];
        if (!profileName) {
          throw usageError("Usage: agentgit-authority [global-flags] profile use <name>");
        }

        const updated = setActiveUserProfile(userConfig.config, profileName);
        writeUserConfig(userConfig.path, updated);
        printResult(
          {
            active_profile: profileName,
            config_path: userConfig.path,
          },
          jsonOutput,
          (value) => lines(`Active CLI profile: ${value.active_profile}`, `Config: ${value.config_path}`),
        );
        return;
      }

      if (subcommand === "upsert") {
        const parsed = parseProfileUpsertArgs(rest.slice(1));
        const updated = upsertUserProfile(userConfig.config, parsed.name, parsed.values);
        writeUserConfig(userConfig.path, updated);
        printResult(
          {
            profile_name: parsed.name,
            config_path: userConfig.path,
            values: parsed.values,
          },
          jsonOutput,
          (value) => lines(`Updated CLI profile ${value.profile_name}`, `Config: ${value.config_path}`),
        );
        return;
      }

      if (subcommand === "remove") {
        const profileName = rest[1];
        if (!profileName) {
          throw usageError("Usage: agentgit-authority [global-flags] profile remove <name>");
        }

        const updated = removeUserProfile(userConfig.config, profileName);
        writeUserConfig(userConfig.path, updated);
        printResult(
          {
            profile_name: profileName,
            removed: true,
            config_path: userConfig.path,
          },
          jsonOutput,
          (value) => lines(`Removed CLI profile ${value.profile_name}`, `Config: ${value.config_path}`),
        );
        return;
      }

      throw usageError("Usage: agentgit-authority [global-flags] profile <list|show|use|upsert|remove> [...]");
    }
    case "ping": {
      const result = await client.hello([workspaceRoot]);
      printResult(result, jsonOutput, formatHello);
      return;
    }
    case "register-run": {
      const workflowName = rest[0] ?? "cli-run";
      const maxMutatingActions = rest[1] ? Number(rest[1]) : null;
      const maxDestructiveActions = rest[2] ? Number(rest[2]) : null;
      const result = await client.registerRun({
        workflow_name: workflowName,
        agent_framework: "cli",
        agent_name: "agentgit-cli",
        workspace_roots: [workspaceRoot],
        client_metadata: {
          invoked_from: "authority-cli",
        },
        budget_config:
          maxMutatingActions !== null || maxDestructiveActions !== null
            ? {
                max_mutating_actions: Number.isFinite(maxMutatingActions) ? maxMutatingActions : null,
                max_destructive_actions: Number.isFinite(maxDestructiveActions) ? maxDestructiveActions : null,
              }
            : undefined,
      });
      printResult(result, jsonOutput, formatRegisterRun);
      return;
    }
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
    case "list-mcp-servers": {
      const result = await client.listMcpServers();
      printResult(result, jsonOutput, formatMcpServers);
      return;
    }
    case "list-mcp-server-candidates": {
      const result = await client.listMcpServerCandidates();
      printResult(result, jsonOutput, formatMcpServerCandidates);
      return;
    }
    case "submit-mcp-server-candidate": {
      const definitionArg = rest[0];

      if (!definitionArg) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] submit-mcp-server-candidate <definition-json-or-path>",
        );
      }

      const result = await client.submitMcpServerCandidate(
        parseJsonArgOrFile(definitionArg) as Parameters<AuthorityClient["submitMcpServerCandidate"]>[0],
      );
      printResult(result, jsonOutput, (value: SubmitMcpServerCandidateResult) =>
        lines(
          `Submitted MCP server candidate ${value.candidate.candidate_id}`,
          `Source: ${value.candidate.source_kind}`,
          `Resolution state: ${value.candidate.resolution_state}`,
          `Submitted: ${value.candidate.submitted_at}`,
        ),
      );
      return;
    }
    case "list-mcp-server-profiles": {
      const result = await client.listMcpServerProfiles();
      printResult(result, jsonOutput, formatMcpServerProfiles);
      return;
    }
    case "show-mcp-server-review": {
      const reviewTargetId = rest[0];

      if (!reviewTargetId) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] show-mcp-server-review <candidate-id|server-profile-id>",
        );
      }

      const result = await client.getMcpServerReview(
        reviewTargetId.startsWith("mcpcand_")
          ? { candidate_id: reviewTargetId }
          : { server_profile_id: reviewTargetId },
      );
      printResult(result, jsonOutput, formatMcpServerReview);
      return;
    }
    case "resolve-mcp-server-candidate": {
      const definitionArg = rest[0];

      if (!definitionArg) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] resolve-mcp-server-candidate <definition-json-or-path>",
        );
      }

      const result = await client.resolveMcpServerCandidate(
        parseJsonArgOrFile(definitionArg) as Parameters<AuthorityClient["resolveMcpServerCandidate"]>[0],
      );
      printResult(result, jsonOutput, (value: ResolveMcpServerCandidateResult) =>
        lines(
          `Resolved MCP server candidate ${value.candidate.candidate_id}`,
          `Profile: ${value.profile.server_profile_id}`,
          `Created profile: ${value.created_profile ? "yes" : "no"}`,
          `Drift detected: ${value.drift_detected ? "yes" : "no"}`,
          `Profile status: ${value.profile.status}`,
        ),
      );
      return;
    }
    case "list-mcp-server-trust-decisions": {
      const result = await client.listMcpServerTrustDecisions(rest[0]);
      printResult(result, jsonOutput, formatMcpServerTrustDecisions);
      return;
    }
    case "list-mcp-server-credential-bindings": {
      const result = await client.listMcpServerCredentialBindings(rest[0]);
      printResult(result, jsonOutput, formatMcpServerCredentialBindings);
      return;
    }
    case "bind-mcp-server-credentials": {
      const definitionArg = rest[0];

      if (!definitionArg) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] bind-mcp-server-credentials <definition-json-or-path>",
        );
      }

      const result = await client.bindMcpServerCredentials(
        parseJsonArgOrFile(definitionArg) as Parameters<AuthorityClient["bindMcpServerCredentials"]>[0],
      );
      printResult(result, jsonOutput, (value: BindMcpServerCredentialsResult) =>
        lines(
          `Bound MCP server credentials ${value.credential_binding.credential_binding_id}`,
          `Profile: ${value.profile.server_profile_id}`,
          `Binding mode: ${value.credential_binding.binding_mode}`,
          `Status: ${value.credential_binding.status}`,
        ),
      );
      return;
    }
    case "revoke-mcp-server-credentials": {
      const credentialBindingId = rest[0];

      if (!credentialBindingId) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] revoke-mcp-server-credentials <credential-binding-id>",
        );
      }

      const result = await client.revokeMcpServerCredentials(credentialBindingId);
      printResult(result, jsonOutput, (value: RevokeMcpServerCredentialsResult) =>
        lines(
          `Revoked MCP server credentials ${value.credential_binding.credential_binding_id}`,
          `Profile: ${value.credential_binding.server_profile_id}`,
          `Status: ${value.credential_binding.status}`,
        ),
      );
      return;
    }
    case "approve-mcp-server-profile": {
      const definitionArg = rest[0];

      if (!definitionArg) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] approve-mcp-server-profile <definition-json-or-path>",
        );
      }

      const result = await client.approveMcpServerProfile(
        parseJsonArgOrFile(definitionArg) as Parameters<AuthorityClient["approveMcpServerProfile"]>[0],
      );
      printResult(result, jsonOutput, (value: ApproveMcpServerProfileResult) =>
        lines(
          `Recorded MCP profile trust decision ${value.trust_decision.trust_decision_id}`,
          `Profile: ${value.profile.server_profile_id}`,
          `Decision: ${value.trust_decision.decision}`,
          `Profile status: ${value.profile.status}`,
        ),
      );
      return;
    }
    case "activate-mcp-server-profile": {
      const serverProfileId = rest[0];

      if (!serverProfileId) {
        throw usageError("Usage: agentgit-authority [global-flags] activate-mcp-server-profile <server-profile-id>");
      }

      const result = await client.activateMcpServerProfile(serverProfileId);
      printResult(result, jsonOutput, (value: ActivateMcpServerProfileResult) =>
        lines(`Activated MCP server profile ${value.profile.server_profile_id}`, `Status: ${value.profile.status}`),
      );
      return;
    }
    case "quarantine-mcp-server-profile": {
      const definitionArg = rest[0];

      if (!definitionArg) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] quarantine-mcp-server-profile <definition-json-or-path>",
        );
      }

      const result = await client.quarantineMcpServerProfile(
        parseJsonArgOrFile(definitionArg) as Parameters<AuthorityClient["quarantineMcpServerProfile"]>[0],
      );
      printResult(result, jsonOutput, (value: QuarantineMcpServerProfileResult) =>
        lines(
          `Quarantined MCP server profile ${value.profile.server_profile_id}`,
          `Status: ${value.profile.status}`,
          `Reason codes: ${value.profile.quarantine_reason_codes.join(", ") || "none"}`,
        ),
      );
      return;
    }
    case "revoke-mcp-server-profile": {
      const definitionArg = rest[0];

      if (!definitionArg) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] revoke-mcp-server-profile <definition-json-or-path>",
        );
      }

      const result = await client.revokeMcpServerProfile(
        parseJsonArgOrFile(definitionArg) as Parameters<AuthorityClient["revokeMcpServerProfile"]>[0],
      );
      printResult(result, jsonOutput, (value: RevokeMcpServerProfileResult) =>
        lines(
          `Revoked MCP server profile ${value.profile.server_profile_id}`,
          `Status: ${value.profile.status}`,
          `Reason codes: ${value.profile.quarantine_reason_codes.join(", ") || "none"}`,
        ),
      );
      return;
    }
    case "list-mcp-secrets": {
      const result = await client.listMcpSecrets();
      printResult(result, jsonOutput, formatMcpSecrets);
      return;
    }
    case "list-mcp-host-policies": {
      const result = await client.listMcpHostPolicies();
      printResult(result, jsonOutput, formatMcpHostPolicies);
      return;
    }
    case "upsert-mcp-secret": {
      if (rest.length === 0) {
        throw usageError(secretUsage());
      }

      const parsedSecret = await parseSecretCommandOptions(rest, workspaceRoot);

      const result = await client.upsertMcpSecret({
        secret_id: parsedSecret.secretId,
        ...(parsedSecret.displayName ? { display_name: parsedSecret.displayName } : {}),
        ...(parsedSecret.expiresAt ? { expires_at: parsedSecret.expiresAt } : {}),
        bearer_token: parsedSecret.bearerToken,
      } as Parameters<AuthorityClient["upsertMcpSecret"]>[0]);
      printResult(result, jsonOutput, (value: UpsertMcpSecretResult) =>
        lines(
          `${value.created ? "Stored" : value.rotated ? "Rotated" : "Updated"} MCP secret ${value.secret.secret_id}`,
          `Version: ${value.secret.version}`,
          `Updated: ${value.secret.updated_at}`,
        ),
      );
      return;
    }
    case "remove-mcp-secret": {
      const secretId = rest[0];

      if (!secretId) {
        throw usageError("Usage: agentgit-authority [global-flags] remove-mcp-secret <secret-id>");
      }

      const result = await client.removeMcpSecret(secretId);
      printResult(result, jsonOutput, (value: RemoveMcpSecretResult) =>
        value.removed
          ? `Removed MCP secret ${value.removed_secret?.secret_id ?? secretId}`
          : `No MCP secret named ${secretId} was stored.`,
      );
      return;
    }
    case "upsert-mcp-host-policy": {
      const definitionArg = rest[0];

      if (!definitionArg) {
        throw usageError("Usage: agentgit-authority [global-flags] upsert-mcp-host-policy <definition-json-or-path>");
      }

      const result = await client.upsertMcpHostPolicy(
        parseJsonArgOrFile(definitionArg) as Parameters<AuthorityClient["upsertMcpHostPolicy"]>[0],
      );
      printResult(result, jsonOutput, (value: UpsertMcpHostPolicyResult) =>
        lines(
          `${value.created ? "Registered" : "Updated"} MCP host policy ${value.policy.policy.host}`,
          `Allow subdomains: ${value.policy.policy.allow_subdomains ? "yes" : "no"}`,
          `Updated: ${value.policy.updated_at}`,
        ),
      );
      return;
    }
    case "remove-mcp-host-policy": {
      const host = rest[0];

      if (!host) {
        throw usageError("Usage: agentgit-authority [global-flags] remove-mcp-host-policy <host>");
      }

      const result = await client.removeMcpHostPolicy(host);
      printResult(result, jsonOutput, (value: RemoveMcpHostPolicyResult) =>
        value.removed
          ? `Removed MCP host policy ${value.removed_policy?.policy.host ?? host}`
          : `No MCP host policy for ${host} was registered.`,
      );
      return;
    }
    case "show-hosted-mcp-job": {
      const jobId = rest[0];

      if (!jobId) {
        throw usageError("Usage: agentgit-authority [global-flags] show-hosted-mcp-job <job-id>");
      }

      const result = await client.getHostedMcpJob(jobId);
      printResult(result, jsonOutput, formatHostedMcpJob);
      return;
    }
    case "list-hosted-mcp-jobs": {
      const serverProfileId = rest[0];
      const filter = parseHostedMcpJobFilter(rest[1]);
      const result = await client.listHostedMcpJobs({
        ...(serverProfileId ? { server_profile_id: serverProfileId } : {}),
        ...filter,
      });
      printResult(result, jsonOutput, formatHostedMcpJobs);
      return;
    }
    case "requeue-hosted-mcp-job": {
      const jobId = rest[0];

      if (!jobId) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] requeue-hosted-mcp-job <job-id> [--reset-attempts] [--max-attempts <n>] [--reason <text>]",
        );
      }

      const result = await client.requeueHostedMcpJob(jobId, parseRequeueHostedMcpJobOptions(rest.slice(1)));
      printResult(result, jsonOutput, formatRequeueHostedMcpJob);
      return;
    }
    case "cancel-hosted-mcp-job": {
      const jobId = rest[0];

      if (!jobId) {
        throw usageError("Usage: agentgit-authority [global-flags] cancel-hosted-mcp-job <job-id> [--reason <text>]");
      }

      const result = await client.cancelHostedMcpJob(jobId, parseCancelHostedMcpJobOptions(rest.slice(1)));
      printResult(result, jsonOutput, formatCancelHostedMcpJob);
      return;
    }
    case "upsert-mcp-server": {
      const definitionArg = rest[0];

      if (!definitionArg) {
        throw usageError("Usage: agentgit-authority [global-flags] upsert-mcp-server <definition-json-or-path>");
      }

      const result = await client.upsertMcpServer(
        parseJsonArgOrFile(definitionArg) as Parameters<AuthorityClient["upsertMcpServer"]>[0],
      );
      printResult(result, jsonOutput, (value: UpsertMcpServerResult) =>
        lines(
          `${value.created ? "Registered" : "Updated"} MCP server ${value.server.server.server_id}`,
          `Transport: ${value.server.server.transport}`,
          `Source: ${value.server.source}`,
          `Updated: ${value.server.updated_at}`,
        ),
      );
      return;
    }
    case "remove-mcp-server": {
      const serverId = rest[0];

      if (!serverId) {
        throw usageError("Usage: agentgit-authority [global-flags] remove-mcp-server <server-id>");
      }

      const result = await client.removeMcpServer(serverId);
      printResult(result, jsonOutput, (value: RemoveMcpServerResult) =>
        value.removed
          ? `Removed MCP server ${value.removed_server?.server.server_id ?? serverId}`
          : `No MCP server named ${serverId} was registered.`,
      );
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
      const result = await client.submitActionAttempt({
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
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-filesystem-delete": {
      const [runId, targetPath] = rest;

      if (!runId || !targetPath) {
        throw usageError("Usage: agentgit-authority [global-flags] submit-filesystem-delete <run-id> <path>");
      }

      const result = await client.submitActionAttempt({
        run_id: runId,
        tool_registration: {
          tool_name: "delete_file",
          tool_kind: "filesystem",
        },
        raw_call: {
          operation: "delete",
          path: targetPath,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-shell": {
      const [runId, ...commandParts] = rest;

      if (!runId || commandParts.length === 0) {
        throw usageError("Usage: agentgit-authority [global-flags] submit-shell <run-id> <command...>");
      }

      const result = await client.submitActionAttempt({
        run_id: runId,
        tool_registration: {
          tool_name: "exec_command",
          tool_kind: "shell",
        },
        raw_call: {
          command: commandParts.join(" "),
          argv: commandParts,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
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

      let toolArguments: Record<string, unknown> = {};
      if (argumentParts.length > 0) {
        try {
          const parsed = parseJsonArgOrFile(argumentParts.join(" "));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("arguments must be a JSON object");
          }
          toolArguments = parsed as Record<string, unknown>;
        } catch (error) {
          throw inputError(
            `submit-mcp-tool expects JSON like {"note":"launch blocker"} for tool arguments: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      const result = await client.submitActionAttempt({
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
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
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

      let toolArguments: Record<string, unknown> = {};
      if (argumentParts.length > 0) {
        try {
          const parsed = parseJsonArgOrFile(argumentParts.join(" "));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("arguments must be a JSON object");
          }
          toolArguments = parsed as Record<string, unknown>;
        } catch (error) {
          throw inputError(
            `submit-mcp-profile-tool expects JSON like {"note":"launch blocker"} for tool arguments: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      const result = await client.submitActionAttempt({
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
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-draft-create": {
      const [runId, subject, ...bodyParts] = rest;

      if (!runId || !subject) {
        throw usageError("Usage: agentgit-authority [global-flags] submit-draft-create <run-id> <subject> <body>");
      }

      const body = bodyParts.join(" ");
      const result = await client.submitActionAttempt({
        run_id: runId,
        tool_registration: {
          tool_name: "drafts_create",
          tool_kind: "function",
        },
        raw_call: {
          integration: "drafts",
          operation: "create_draft",
          subject,
          body,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-draft-archive": {
      const [runId, draftId] = rest;

      if (!runId || !draftId) {
        throw usageError("Usage: agentgit-authority [global-flags] submit-draft-archive <run-id> <draft-id>");
      }

      const result = await client.submitActionAttempt({
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
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-draft-delete": {
      const [runId, draftId] = rest;

      if (!runId || !draftId) {
        throw usageError("Usage: agentgit-authority [global-flags] submit-draft-delete <run-id> <draft-id>");
      }

      const result = await client.submitActionAttempt({
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
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-draft-unarchive": {
      const [runId, draftId] = rest;

      if (!runId || !draftId) {
        throw usageError("Usage: agentgit-authority [global-flags] submit-draft-unarchive <run-id> <draft-id>");
      }

      const result = await client.submitActionAttempt({
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
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
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

      const body = bodyParts.join(" ");
      const result = await client.submitActionAttempt({
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
          body,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-draft-add-label": {
      const [runId, draftId, label] = rest;

      if (!runId || !draftId || !label) {
        throw usageError("Usage: agentgit-authority [global-flags] submit-draft-add-label <run-id> <draft-id> <label>");
      }

      const result = await client.submitActionAttempt({
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
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
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

      const result = await client.submitActionAttempt({
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
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
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

      let state: Record<string, unknown>;
      try {
        const parsed = JSON.parse(stateParts.join(" "));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("state must be an object");
        }
        state = parsed as Record<string, unknown>;
      } catch (error) {
        throw inputError(
          `submit-draft-restore expects JSON like {"subject":"...","body":"...","status":"active|archived|deleted","labels":[]}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      const result = await client.submitActionAttempt({
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
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-note-create": {
      const [runId, title, ...bodyParts] = rest;

      if (!runId || !title) {
        throw usageError("Usage: agentgit-authority [global-flags] submit-note-create <run-id> <title> <body>");
      }

      const body = bodyParts.join(" ");
      const result = await client.submitActionAttempt({
        run_id: runId,
        tool_registration: {
          tool_name: "notes_create",
          tool_kind: "function",
        },
        raw_call: {
          integration: "notes",
          operation: "create_note",
          title,
          body,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-note-archive": {
      const [runId, noteId] = rest;

      if (!runId || !noteId) {
        throw usageError("Usage: agentgit-authority [global-flags] submit-note-archive <run-id> <note-id>");
      }

      const result = await client.submitActionAttempt({
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
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-note-unarchive": {
      const [runId, noteId] = rest;

      if (!runId || !noteId) {
        throw usageError("Usage: agentgit-authority [global-flags] submit-note-unarchive <run-id> <note-id>");
      }

      const result = await client.submitActionAttempt({
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
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-note-delete": {
      const [runId, noteId] = rest;

      if (!runId || !noteId) {
        throw usageError("Usage: agentgit-authority [global-flags] submit-note-delete <run-id> <note-id>");
      }

      const result = await client.submitActionAttempt({
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
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
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
      const result = await client.submitActionAttempt({
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
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
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

      let state: Record<string, unknown>;
      try {
        const parsed = JSON.parse(stateParts.join(" "));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("state must be an object");
        }
        state = parsed as Record<string, unknown>;
      } catch (error) {
        throw inputError(
          `submit-note-restore expects JSON like {"title":"...","body":"...","status":"active|archived|deleted"}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      const result = await client.submitActionAttempt({
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
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "none",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-ticket-create": {
      const [runId, title, ...bodyParts] = rest;

      if (!runId || !title) {
        throw usageError("Usage: agentgit-authority [global-flags] submit-ticket-create <run-id> <title> <body>");
      }

      const body = bodyParts.join(" ");
      const result = await client.submitActionAttempt({
        run_id: runId,
        tool_registration: {
          tool_name: "tickets_create",
          tool_kind: "function",
        },
        raw_call: {
          integration: "tickets",
          operation: "create_ticket",
          title,
          body,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "brokered",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
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

      const body = bodyParts.join(" ");
      const result = await client.submitActionAttempt({
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
          body,
        },
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "brokered",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-ticket-delete": {
      const [runId, ticketId] = rest;

      if (!runId || !ticketId) {
        throw usageError("Usage: agentgit-authority [global-flags] submit-ticket-delete <run-id> <ticket-id>");
      }

      const result = await client.submitActionAttempt({
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
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "brokered",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
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

      let state: Record<string, unknown>;
      try {
        const parsed = JSON.parse(stateParts.join(" "));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("state must be an object");
        }
        state = parsed as Record<string, unknown>;
      } catch (error) {
        throw inputError(
          `submit-ticket-restore expects JSON like {"title":"...","body":"...","status":"active","labels":[],"assigned_users":[]}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      const result = await client.submitActionAttempt({
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
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "brokered",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-ticket-close": {
      const [runId, ticketId] = rest;

      if (!runId || !ticketId) {
        throw usageError("Usage: agentgit-authority [global-flags] submit-ticket-close <run-id> <ticket-id>");
      }

      const result = await client.submitActionAttempt({
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
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "brokered",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
      });
      printResult(result, jsonOutput, formatSubmitAction);
      return;
    }
    case "submit-ticket-reopen": {
      const [runId, ticketId] = rest;

      if (!runId || !ticketId) {
        throw usageError("Usage: agentgit-authority [global-flags] submit-ticket-reopen <run-id> <ticket-id>");
      }

      const result = await client.submitActionAttempt({
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
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "brokered",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
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

      const result = await client.submitActionAttempt({
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
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "brokered",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
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

      const result = await client.submitActionAttempt({
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
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "brokered",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
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

      const result = await client.submitActionAttempt({
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
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "brokered",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
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

      const result = await client.submitActionAttempt({
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
        environment_context: {
          workspace_roots: [workspaceRoot],
          cwd: workspaceRoot,
          credential_mode: "brokered",
        },
        framework_context: {
          agent_name: "agentgit-cli",
          agent_framework: "cli",
        },
        received_at: new Date().toISOString(),
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
