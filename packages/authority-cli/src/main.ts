#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as TOML from "@iarna/toml";
import { AuthorityClient, AuthorityDaemonResponseError } from "@agentgit/authority-sdk";
import { API_VERSION, type PolicyConfig, PolicyConfigSchema, type PolicyRule } from "@agentgit/schemas";

import {
  CLI_CONFIG_SCHEMA_VERSION,
  CLI_EXIT_CODE_REGISTRY_VERSION,
  CLI_JSON_CONTRACT_VERSION,
  CLI_EXIT_CODES,
  formatCliJsonError,
  inputError,
  ioError,
  toCliError,
  usageError,
} from "./cli-contract.js";
import {
  type CliConfigValidationResult,
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
type ArtifactResult = Awaited<ReturnType<AuthorityClient["queryArtifact"]>>;
interface ArtifactExportResult {
  artifact_id: string;
  output_path: string;
  bytes_written: number;
  visibility_scope: ArtifactResult["visibility_scope"];
  artifact_status: ArtifactResult["artifact_status"];
  integrity_digest: string | null;
}
interface RunAuditExportedArtifact {
  artifact_id: string;
  type: string;
  output_path: string;
  relative_path: string;
  bytes_written: number;
  visibility_scope: ArtifactResult["visibility_scope"];
  sha256: string;
  integrity_digest: string | null;
}
interface RunAuditSkippedArtifact {
  artifact_id: string;
  type: string;
  reason: string;
  artifact_status: ArtifactResult["artifact_status"] | "not_found";
}
interface RunAuditExportResult {
  run_id: string;
  output_dir: string;
  manifest_version: string;
  visibility_scope: TimelineResult["visibility_scope"];
  files_written: string[];
  exported_artifacts: RunAuditExportedArtifact[];
  skipped_artifacts: RunAuditSkippedArtifact[];
}
interface RunAuditVerifyIssue {
  code:
    | "MANIFEST_MISSING"
    | "MANIFEST_INVALID"
    | "MISSING_BUNDLE_FILE"
    | "MISSING_ARTIFACT_FILE"
    | "ARTIFACT_SIZE_MISMATCH"
    | "ARTIFACT_SHA256_MISMATCH"
    | "ARTIFACT_INTEGRITY_MISMATCH";
  message: string;
  file_path?: string;
  artifact_id?: string;
}
interface RunAuditVerifyResult {
  run_id: string;
  output_dir: string;
  manifest_version: string | null;
  verified: boolean;
  files_checked: number;
  exported_artifacts_checked: number;
  issues: RunAuditVerifyIssue[];
}
interface RunAuditReportResult {
  run_id: string;
  bundle_dir: string;
  manifest_version: string | null;
  visibility_scope: TimelineResult["visibility_scope"] | "unknown";
  exported_at: string | null;
  verified: boolean;
  verification_issue_count: number;
  run_summary: {
    workflow_name: string | null;
    session_id: string | null;
    event_count: number | null;
    action_count: number | null;
    approval_count: number | null;
    created_at: string | null;
    started_at: string | null;
  };
  timeline: {
    step_count: number;
    approvals_required: number;
    approvals_resolved: number;
    reversible_step_count: number;
    external_effect_step_count: number;
  };
  artifacts: {
    exported_count: number;
    skipped_count: number;
    available_exported_count: number;
    missing_or_withheld_count: number;
  };
}
interface RunAuditCompareDifference {
  code:
    | "RUN_ID_CHANGED"
    | "VISIBILITY_SCOPE_CHANGED"
    | "EVENT_COUNT_CHANGED"
    | "ACTION_COUNT_CHANGED"
    | "TIMELINE_STEP_COUNT_CHANGED"
    | "APPROVAL_COUNT_CHANGED"
    | "APPROVAL_INBOX_COUNT_CHANGED"
    | "EXPORTED_ARTIFACT_ADDED"
    | "EXPORTED_ARTIFACT_REMOVED"
    | "EXPORTED_ARTIFACT_DIGEST_CHANGED"
    | "SKIPPED_ARTIFACT_ADDED"
    | "SKIPPED_ARTIFACT_REMOVED"
    | "DIAGNOSTICS_CHANGED"
    | "VERIFICATION_STATUS_CHANGED";
  message: string;
  artifact_id?: string;
  left_value?: unknown;
  right_value?: unknown;
}
interface RunAuditCompareResult {
  left_bundle_dir: string;
  right_bundle_dir: string;
  left_run_id: string;
  right_run_id: string;
  left_manifest_version: string | null;
  right_manifest_version: string | null;
  left_verified: boolean;
  right_verified: boolean;
  comparable: boolean;
  differences: RunAuditCompareDifference[];
}
interface RunAuditShareArtifactRecord {
  artifact_id: string;
  type: string;
  relative_path: string;
  output_path: string;
}
interface RunAuditShareResult {
  run_id: string;
  source_bundle_dir: string;
  output_dir: string;
  manifest_version: string;
  include_artifact_content: boolean;
  copied_files: string[];
  copied_artifacts: RunAuditShareArtifactRecord[];
  withheld_artifacts: Array<{
    artifact_id: string;
    type: string;
    reason: string;
    relative_path: string;
  }>;
}
interface VersionResult {
  cli_version: string;
  supported_api_version: string;
  json_contract_version: string;
  exit_code_registry_version: string;
  config_schema_version: string;
}
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
interface DoctorCheck {
  code: string;
  status: "pass" | "warn" | "fail";
  summary: string;
  details?: Record<string, unknown>;
}
interface DoctorResult {
  cli_version: string;
  config: {
    config_root: string;
    user_config_path: string;
    workspace_config_path: string;
    active_profile: string | null;
    workspace_root: string;
    socket_path: string;
  };
  daemon: {
    reachable: boolean;
    session_id: string | null;
    accepted_api_version: string | null;
    runtime_version: string | null;
    schema_pack_version: string | null;
  };
  security_posture_status: "healthy" | "degraded" | "unknown";
  checks: DoctorCheck[];
  recommendations: string[];
}
type PlanRecoveryResult = Awaited<ReturnType<AuthorityClient["planRecovery"]>>;
type ExecuteRecoveryResult = Awaited<ReturnType<AuthorityClient["executeRecovery"]>>;
type HelperQuestionType = Parameters<AuthorityClient["queryHelper"]>[1];
type TimelineStep = TimelineResult["steps"][number];
type AuditBundleManifestVersion = "agentgit.run-audit-bundle.v2";
type AuditShareManifestVersion = "agentgit.run-audit-share.v1";

const RUN_AUDIT_BUNDLE_MANIFEST_VERSION: AuditBundleManifestVersion = "agentgit.run-audit-bundle.v2";
const RUN_AUDIT_SHARE_MANIFEST_VERSION: AuditShareManifestVersion = "agentgit.run-audit-share.v1";

interface RunAuditBundleManifest {
  manifest_version?: string;
  run_id?: string;
  output_dir?: string;
  visibility_scope?: TimelineResult["visibility_scope"];
  exported_at?: string;
  files_written?: string[];
  exported_artifacts?: RunAuditExportedArtifact[];
  skipped_artifacts?: RunAuditSkippedArtifact[];
  counts?: {
    timeline_steps?: number;
    approvals?: number;
    approval_inbox_items?: number;
    exported_artifacts?: number;
    skipped_artifacts?: number;
  };
}

interface LoadedAuditBundle {
  manifest: RunAuditBundleManifest;
  manifest_version: string | null;
  run_id: string;
  bundle_dir: string;
  run_summary: RunSummaryResult | null;
  timeline: TimelineResult | null;
  approvals: ListApprovalsResult | null;
  approval_inbox: ApprovalInboxResult | null;
  diagnostics: DiagnosticsResult | null;
  verify_result: RunAuditVerifyResult;
}
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

const VISIBILITY_SCOPES = new Set(["user", "model", "internal", "sensitive_internal"]);
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

function lines(...values: Array<string | null | undefined | false>): string {
  return values.filter((value): value is string => typeof value === "string" && value.length > 0).join("\n");
}

function bulletList(items: string[], indent = "  "): string {
  return items.map((item) => `${indent}- ${item}`).join("\n");
}

function clipText(value: string, maxChars = 320, maxLines = 4): string {
  const clippedChars = value.length > maxChars ? `${value.slice(0, maxChars - 3)}...` : value;
  const lineParts = clippedChars.split(/\r?\n/);

  if (lineParts.length <= maxLines) {
    return clippedChars;
  }

  return `${lineParts.slice(0, maxLines).join("\n")}\n...`;
}

function indentBlock(value: string, spaces = 2): string {
  const prefix = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatBudget(used: number, limit: number | null): string {
  return limit === null ? `${used} / unlimited` : `${used} / ${limit}`;
}

function joinOrNone(items: string[]): string {
  return items.length > 0 ? items.join(", ") : "none";
}

function maybeLine(label: string, value: string | null | undefined): string | null {
  return value ? `${label}: ${value}` : null;
}

function parseJsonArgOrFile(value: string): unknown {
  const source = fs.existsSync(value) ? fs.readFileSync(value, "utf8") : value;
  return JSON.parse(source);
}

function formatReasonDetail(reason: ReasonDetail | null | undefined): string | null {
  return reason ? `${reason.code}: ${reason.message}` : null;
}

function parseVisibilityScopeArg(
  value: string | undefined,
): "user" | "model" | "internal" | "sensitive_internal" | undefined {
  return value && VISIBILITY_SCOPES.has(value)
    ? (value as "user" | "model" | "internal" | "sensitive_internal")
    : undefined;
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

export function formatArtifact(result: ArtifactResult): string {
  return lines(
    `Artifact ${result.artifact.artifact_id}`,
    `Type: ${result.artifact.type}`,
    `Status: ${result.artifact_status}`,
    `Visibility: ${result.visibility_scope}`,
    `Stored visibility: ${result.artifact.visibility}`,
    `Run: ${result.artifact.run_id}`,
    `Action: ${result.artifact.action_id}`,
    `Execution: ${result.artifact.execution_id}`,
    `Bytes: ${result.artifact.byte_size}`,
    `Content ref: ${result.artifact.content_ref}`,
    `Integrity: ${result.artifact.integrity.schema_version} ${result.artifact.integrity.digest_algorithm}`,
    maybeLine("Integrity digest", result.artifact.integrity.digest),
    maybeLine("Expires", result.artifact.expires_at),
    maybeLine("Expired", result.artifact.expired_at),
    `Content available: ${result.content_available ? "yes" : "no"}`,
    `Returned chars: ${result.returned_chars}/${result.max_inline_chars}`,
    `Truncated: ${result.content_truncated ? "yes" : "no"}`,
    "",
    result.content,
  );
}

function formatArtifactExport(result: ArtifactExportResult): string {
  return lines(
    `Exported artifact ${result.artifact_id}`,
    `Output path: ${result.output_path}`,
    `Bytes written: ${result.bytes_written}`,
    `Visibility: ${result.visibility_scope}`,
    `Status: ${result.artifact_status}`,
    maybeLine("Integrity digest", result.integrity_digest),
  );
}

function formatRunAuditExport(result: RunAuditExportResult): string {
  const exportedArtifacts =
    result.exported_artifacts.length === 0
      ? "none"
      : `\n${bulletList(
          result.exported_artifacts.map(
            (artifact) =>
              `${artifact.artifact_id} [${artifact.type}] -> ${artifact.output_path} (${artifact.bytes_written} bytes)`,
          ),
        )}`;
  const skippedArtifacts =
    result.skipped_artifacts.length === 0
      ? "none"
      : `\n${bulletList(
          result.skipped_artifacts.map(
            (artifact) => `${artifact.artifact_id} [${artifact.type}] ${artifact.artifact_status}: ${artifact.reason}`,
          ),
        )}`;

  return lines(
    `Exported run audit bundle for ${result.run_id}`,
    `Output dir: ${result.output_dir}`,
    `Visibility: ${result.visibility_scope}`,
    `Files written: ${result.files_written.length}`,
    `Artifacts exported: ${result.exported_artifacts.length}`,
    `Artifacts skipped: ${result.skipped_artifacts.length}`,
    `Exported artifacts:${exportedArtifacts}`,
    `Skipped artifacts:${skippedArtifacts}`,
  );
}

function formatRunAuditVerify(result: RunAuditVerifyResult): string {
  const issues =
    result.issues.length === 0
      ? "none"
      : `\n${bulletList(
          result.issues.map(
            (issue) => `${issue.code}: ${issue.message}${issue.file_path ? ` [${issue.file_path}]` : ""}`,
          ),
        )}`;

  return lines(
    `Verified run audit bundle for ${result.run_id}`,
    `Output dir: ${result.output_dir}`,
    `Audit bundle verified: ${result.verified ? "yes" : "no"}`,
    `Files checked: ${result.files_checked}`,
    `Exported artifacts checked: ${result.exported_artifacts_checked}`,
    `Issues:${issues}`,
  );
}

function formatRunAuditReport(result: RunAuditReportResult): string {
  return lines(
    `Audit report for ${result.run_id}`,
    `Bundle dir: ${result.bundle_dir}`,
    `Manifest version: ${result.manifest_version ?? "unknown"}`,
    `Visibility: ${result.visibility_scope}`,
    `Exported at: ${result.exported_at ?? "unknown"}`,
    `Verified: ${result.verified ? "yes" : "no"}`,
    `Verification issues: ${result.verification_issue_count}`,
    `Workflow: ${result.run_summary.workflow_name ?? "unknown"}`,
    `Session: ${result.run_summary.session_id ?? "unknown"}`,
    `Events: ${result.run_summary.event_count ?? "unknown"}`,
    `Actions: ${result.run_summary.action_count ?? "unknown"}`,
    `Approvals: ${result.run_summary.approval_count ?? "unknown"}`,
    `Timeline steps: ${result.timeline.step_count}`,
    `Approvals required: ${result.timeline.approvals_required}`,
    `Approvals resolved: ${result.timeline.approvals_resolved}`,
    `Reversible steps: ${result.timeline.reversible_step_count}`,
    `External-effect steps: ${result.timeline.external_effect_step_count}`,
    `Artifacts exported: ${result.artifacts.exported_count}`,
    `Artifacts skipped: ${result.artifacts.skipped_count}`,
    `Artifacts available in bundle: ${result.artifacts.available_exported_count}`,
    `Artifacts missing or withheld: ${result.artifacts.missing_or_withheld_count}`,
  );
}

function formatRunAuditCompare(result: RunAuditCompareResult): string {
  const differences =
    result.differences.length === 0
      ? "none"
      : `\n${bulletList(
          result.differences.map(
            (difference) =>
              `${difference.code}: ${difference.message}${difference.artifact_id ? ` [${difference.artifact_id}]` : ""}`,
          ),
        )}`;

  return lines(
    `Compared audit bundles ${result.left_run_id} -> ${result.right_run_id}`,
    `Left bundle: ${result.left_bundle_dir}`,
    `Right bundle: ${result.right_bundle_dir}`,
    `Comparable: ${result.comparable ? "yes" : "no"}`,
    `Left verified: ${result.left_verified ? "yes" : "no"}`,
    `Right verified: ${result.right_verified ? "yes" : "no"}`,
    `Differences: ${result.differences.length}`,
    `Difference details:${differences}`,
  );
}

function formatRunAuditShare(result: RunAuditShareResult): string {
  const copiedArtifacts =
    result.copied_artifacts.length === 0
      ? "none"
      : `\n${bulletList(
          result.copied_artifacts.map(
            (artifact) => `${artifact.artifact_id} [${artifact.type}] -> ${artifact.output_path}`,
          ),
        )}`;
  const withheldArtifacts =
    result.withheld_artifacts.length === 0
      ? "none"
      : `\n${bulletList(
          result.withheld_artifacts.map((artifact) => `${artifact.artifact_id} [${artifact.type}] ${artifact.reason}`),
        )}`;

  return lines(
    `Created audit share package for ${result.run_id}`,
    `Source bundle: ${result.source_bundle_dir}`,
    `Output dir: ${result.output_dir}`,
    `Manifest version: ${result.manifest_version}`,
    `Include artifact content: ${result.include_artifact_content ? "yes" : "no"}`,
    `Files copied: ${result.copied_files.length}`,
    `Artifacts copied: ${result.copied_artifacts.length}`,
    `Artifacts withheld: ${result.withheld_artifacts.length}`,
    `Copied artifacts:${copiedArtifacts}`,
    `Withheld artifacts:${withheldArtifacts}`,
  );
}

function ensurePathDoesNotExist(targetPath: string, commandName: string): void {
  if (fs.existsSync(targetPath)) {
    throw new Error(`${commandName} refuses to overwrite existing path: ${targetPath}`);
  }
}

function writeJsonFile(targetPath: string, value: unknown): void {
  fs.writeFileSync(targetPath, JSON.stringify(value, null, 2), "utf8");
}

function readJsonFile<T>(targetPath: string): T {
  return JSON.parse(fs.readFileSync(targetPath, "utf8")) as T;
}

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeFileComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function copyFileAndTrack(sourcePath: string, targetPath: string, copiedFiles: string[]): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  copiedFiles.push(targetPath);
}

async function exportRunAuditBundle(
  client: AuthorityClient,
  runId: string,
  outputDir: string,
  visibilityScope: TimelineResult["visibility_scope"],
): Promise<RunAuditExportResult> {
  const runSummary = await client.getRunSummary(runId);
  const timeline = await client.queryTimeline(runId, visibilityScope);
  const approvals = await client.listApprovals({ run_id: runId });
  const approvalInbox = await client.queryApprovalInbox({ run_id: runId });
  const diagnostics = await client.diagnostics([
    "daemon_health",
    "journal_health",
    "maintenance_backlog",
    "projection_lag",
    "storage_summary",
    "capability_summary",
  ]);

  ensurePathDoesNotExist(outputDir, "run-audit-export");
  fs.mkdirSync(outputDir, { recursive: true });
  const artifactsDir = path.join(outputDir, "artifacts");
  fs.mkdirSync(artifactsDir, { recursive: true });

  const filesWritten: string[] = [];
  const writeAuditFile = (fileName: string, content: string): void => {
    const targetPath = path.join(outputDir, fileName);
    fs.writeFileSync(targetPath, content, "utf8");
    filesWritten.push(targetPath);
  };

  writeAuditFile("run-summary.json", JSON.stringify(runSummary, null, 2));
  writeAuditFile("run-summary.txt", formatRunSummary(runSummary));
  writeAuditFile("timeline.json", JSON.stringify(timeline, null, 2));
  writeAuditFile("timeline.txt", formatTimeline(timeline));
  writeAuditFile("approvals.json", JSON.stringify(approvals, null, 2));
  writeAuditFile("approvals.txt", formatApprovalList(approvals));
  writeAuditFile("approval-inbox.json", JSON.stringify(approvalInbox, null, 2));
  writeAuditFile("approval-inbox.txt", formatApprovalInbox(approvalInbox));
  writeAuditFile("diagnostics.json", JSON.stringify(diagnostics, null, 2));
  writeAuditFile("diagnostics.txt", formatDiagnostics(diagnostics));

  const seenArtifactIds = new Set<string>();
  const exportedArtifacts: RunAuditExportedArtifact[] = [];
  const skippedArtifacts: RunAuditSkippedArtifact[] = [];

  for (const step of timeline.steps) {
    for (const artifact of step.primary_artifacts) {
      if (typeof artifact.artifact_id !== "string" || seenArtifactIds.has(artifact.artifact_id)) {
        continue;
      }
      seenArtifactIds.add(artifact.artifact_id);

      try {
        const artifactResult = await client.queryArtifact(artifact.artifact_id, visibilityScope, {
          fullContent: true,
        });

        if (artifactResult.content_truncated) {
          throw new Error(
            `Artifact ${artifact.artifact_id} export returned truncated content even though full export was requested.`,
          );
        }

        if (!artifactResult.content_available) {
          skippedArtifacts.push({
            artifact_id: artifact.artifact_id,
            type: artifact.type,
            reason: "artifact content is not durably available",
            artifact_status: artifactResult.artifact_status,
          });
          continue;
        }

        const artifactPath = path.join(
          artifactsDir,
          `${safeFileComponent(artifact.artifact_id)}.${safeFileComponent(artifact.type)}.txt`,
        );
        fs.writeFileSync(artifactPath, artifactResult.content, "utf8");
        filesWritten.push(artifactPath);
        const contentSha256 = sha256Hex(artifactResult.content);
        exportedArtifacts.push({
          artifact_id: artifact.artifact_id,
          type: artifact.type,
          output_path: artifactPath,
          relative_path: path.relative(outputDir, artifactPath),
          bytes_written: Buffer.byteLength(artifactResult.content, "utf8"),
          visibility_scope: artifactResult.visibility_scope,
          sha256: contentSha256,
          integrity_digest: artifactResult.artifact.integrity.digest,
        });
      } catch (error) {
        if (error instanceof AuthorityDaemonResponseError && error.code === "NOT_FOUND") {
          skippedArtifacts.push({
            artifact_id: artifact.artifact_id,
            type: artifact.type,
            reason: error.message,
            artifact_status: "not_found",
          });
          continue;
        }

        throw error;
      }
    }
  }

  const manifestPath = path.join(outputDir, "manifest.json");
  writeJsonFile(manifestPath, {
    manifest_version: RUN_AUDIT_BUNDLE_MANIFEST_VERSION,
    run_id: runId,
    output_dir: outputDir,
    visibility_scope: visibilityScope,
    exported_at: new Date().toISOString(),
    files_written: filesWritten,
    exported_artifacts: exportedArtifacts,
    skipped_artifacts: skippedArtifacts,
    counts: {
      timeline_steps: timeline.steps.length,
      approvals: approvals.approvals.length,
      approval_inbox_items: approvalInbox.items.length,
      exported_artifacts: exportedArtifacts.length,
      skipped_artifacts: skippedArtifacts.length,
    },
  });
  filesWritten.push(manifestPath);

  return {
    run_id: runId,
    output_dir: outputDir,
    manifest_version: RUN_AUDIT_BUNDLE_MANIFEST_VERSION,
    visibility_scope: visibilityScope,
    files_written: filesWritten,
    exported_artifacts: exportedArtifacts,
    skipped_artifacts: skippedArtifacts,
  };
}

function verifyRunAuditBundle(outputDir: string): RunAuditVerifyResult {
  const manifestPath = path.join(outputDir, "manifest.json");
  const issues: RunAuditVerifyIssue[] = [];
  const requiredBundleFiles = [
    "manifest.json",
    "run-summary.json",
    "run-summary.txt",
    "timeline.json",
    "timeline.txt",
    "approvals.json",
    "approvals.txt",
    "approval-inbox.json",
    "approval-inbox.txt",
    "diagnostics.json",
    "diagnostics.txt",
  ];

  let filesChecked = 0;
  for (const fileName of requiredBundleFiles) {
    filesChecked += 1;
    const targetPath = path.join(outputDir, fileName);
    if (!fs.existsSync(targetPath)) {
      issues.push({
        code: "MISSING_BUNDLE_FILE",
        message: `Required audit bundle file is missing: ${fileName}`,
        file_path: targetPath,
      });
    }
  }

  if (!fs.existsSync(manifestPath)) {
    return {
      run_id: "unknown",
      output_dir: outputDir,
      manifest_version: null,
      verified: false,
      files_checked: filesChecked,
      exported_artifacts_checked: 0,
      issues: [
        {
          code: "MANIFEST_MISSING",
          message: "Audit bundle manifest.json is missing.",
          file_path: manifestPath,
        },
        ...issues,
      ],
    };
  }

  let manifest: {
    run_id?: unknown;
    manifest_version?: unknown;
    exported_artifacts?: unknown;
  };
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      run_id?: unknown;
      manifest_version?: unknown;
      exported_artifacts?: unknown;
    };
  } catch (error) {
    return {
      run_id: "unknown",
      output_dir: outputDir,
      manifest_version: null,
      verified: false,
      files_checked: filesChecked,
      exported_artifacts_checked: 0,
      issues: [
        {
          code: "MANIFEST_INVALID",
          message: error instanceof Error ? error.message : String(error),
          file_path: manifestPath,
        },
        ...issues,
      ],
    };
  }

  const runId = typeof manifest.run_id === "string" ? manifest.run_id : "unknown";
  const manifestVersion = typeof manifest.manifest_version === "string" ? manifest.manifest_version : null;
  const exportedArtifacts = Array.isArray(manifest.exported_artifacts) ? manifest.exported_artifacts : [];
  let exportedArtifactsChecked = 0;

  for (const record of exportedArtifacts) {
    if (!record || typeof record !== "object") {
      continue;
    }

    const artifact = record as Partial<RunAuditExportedArtifact>;
    if (typeof artifact.artifact_id !== "string" || typeof artifact.type !== "string") {
      continue;
    }

    exportedArtifactsChecked += 1;
    filesChecked += 1;
    const artifactPath =
      typeof artifact.relative_path === "string"
        ? path.resolve(outputDir, artifact.relative_path)
        : typeof artifact.output_path === "string"
          ? artifact.output_path
          : null;

    if (!artifactPath || !fs.existsSync(artifactPath)) {
      issues.push({
        code: "MISSING_ARTIFACT_FILE",
        artifact_id: artifact.artifact_id,
        message: `Exported artifact file is missing for ${artifact.artifact_id}.`,
        file_path: artifactPath ?? undefined,
      });
      continue;
    }

    const content = fs.readFileSync(artifactPath);
    if (typeof artifact.bytes_written === "number" && content.byteLength !== artifact.bytes_written) {
      issues.push({
        code: "ARTIFACT_SIZE_MISMATCH",
        artifact_id: artifact.artifact_id,
        message: `Expected ${artifact.bytes_written} bytes but found ${content.byteLength}.`,
        file_path: artifactPath,
      });
    }

    const digest = sha256Hex(content);
    if (typeof artifact.sha256 === "string" && digest !== artifact.sha256) {
      issues.push({
        code: "ARTIFACT_SHA256_MISMATCH",
        artifact_id: artifact.artifact_id,
        message: `Expected SHA256 ${artifact.sha256} but found ${digest}.`,
        file_path: artifactPath,
      });
    }

    if (typeof artifact.integrity_digest === "string" && digest !== artifact.integrity_digest) {
      issues.push({
        code: "ARTIFACT_INTEGRITY_MISMATCH",
        artifact_id: artifact.artifact_id,
        message: `Expected integrity digest ${artifact.integrity_digest} but found ${digest}.`,
        file_path: artifactPath,
      });
    }
  }

  return {
    run_id: runId,
    output_dir: outputDir,
    manifest_version: manifestVersion,
    verified: issues.length === 0,
    files_checked: filesChecked,
    exported_artifacts_checked: exportedArtifactsChecked,
    issues,
  };
}

function loadRunAuditBundle(outputDir: string): LoadedAuditBundle {
  const verifyResult = verifyRunAuditBundle(outputDir);
  const manifestPath = path.join(outputDir, "manifest.json");
  const manifest = fs.existsSync(manifestPath) ? readJsonFile<RunAuditBundleManifest>(manifestPath) : {};
  const runId = typeof manifest.run_id === "string" ? manifest.run_id : verifyResult.run_id;
  const readOptional = <T>(fileName: string): T | null => {
    const targetPath = path.join(outputDir, fileName);
    if (!fs.existsSync(targetPath)) {
      return null;
    }

    return readJsonFile<T>(targetPath);
  };

  return {
    manifest,
    manifest_version: typeof manifest.manifest_version === "string" ? manifest.manifest_version : null,
    run_id: runId,
    bundle_dir: outputDir,
    run_summary: readOptional<RunSummaryResult>("run-summary.json"),
    timeline: readOptional<TimelineResult>("timeline.json"),
    approvals: readOptional<ListApprovalsResult>("approvals.json"),
    approval_inbox: readOptional<ApprovalInboxResult>("approval-inbox.json"),
    diagnostics: readOptional<DiagnosticsResult>("diagnostics.json"),
    verify_result: verifyResult,
  };
}

function createRunAuditReport(outputDir: string): RunAuditReportResult {
  const bundle = loadRunAuditBundle(outputDir);
  const timelineSteps = bundle.timeline?.steps ?? [];
  const exportedArtifacts = Array.isArray(bundle.manifest.exported_artifacts) ? bundle.manifest.exported_artifacts : [];
  const skippedArtifacts = Array.isArray(bundle.manifest.skipped_artifacts) ? bundle.manifest.skipped_artifacts : [];
  const actionCount = timelineSteps.length;
  const approvalCount = bundle.approvals?.approvals.length ?? null;

  return {
    run_id: bundle.run_id,
    bundle_dir: outputDir,
    manifest_version: bundle.manifest_version,
    visibility_scope:
      bundle.timeline?.visibility_scope ??
      (typeof bundle.manifest.visibility_scope === "string" ? bundle.manifest.visibility_scope : "unknown"),
    exported_at: typeof bundle.manifest.exported_at === "string" ? bundle.manifest.exported_at : null,
    verified: bundle.verify_result.verified,
    verification_issue_count: bundle.verify_result.issues.length,
    run_summary: {
      workflow_name: bundle.run_summary?.run.workflow_name ?? null,
      session_id: bundle.run_summary?.run.session_id ?? null,
      event_count: bundle.run_summary?.run.event_count ?? null,
      action_count: actionCount,
      approval_count: approvalCount,
      created_at: bundle.run_summary?.run.created_at ?? null,
      started_at: bundle.run_summary?.run.started_at ?? null,
    },
    timeline: {
      step_count: timelineSteps.length,
      approvals_required:
        bundle.approval_inbox?.counts.pending ??
        timelineSteps.filter((step) => step.status === "awaiting_approval").length,
      approvals_resolved:
        bundle.approval_inbox?.counts.approved !== undefined && bundle.approval_inbox?.counts.denied !== undefined
          ? bundle.approval_inbox.counts.approved + bundle.approval_inbox.counts.denied
          : 0,
      reversible_step_count: timelineSteps.filter((step) => step.reversibility_class !== "irreversible").length,
      external_effect_step_count: timelineSteps.filter((step) => step.external_effects.length > 0).length,
    },
    artifacts: {
      exported_count: exportedArtifacts.length,
      skipped_count: skippedArtifacts.length,
      available_exported_count: exportedArtifacts.length,
      missing_or_withheld_count: skippedArtifacts.length,
    },
  };
}

function compareAuditArtifactRecords(
  leftArtifacts: RunAuditExportedArtifact[],
  rightArtifacts: RunAuditExportedArtifact[],
): RunAuditCompareDifference[] {
  const differences: RunAuditCompareDifference[] = [];
  const normalizedRelativePath = (artifact: RunAuditExportedArtifact) => {
    const baseName = path.basename(artifact.relative_path);
    return baseName.replace(/^[^.]+\./, "");
  };
  const signatureFor = (artifact: RunAuditExportedArtifact) =>
    `${artifact.type}:${artifact.visibility_scope}:${normalizedRelativePath(artifact)}`;
  const groupBySignature = (artifacts: RunAuditExportedArtifact[]) => {
    const grouped = new Map<string, RunAuditExportedArtifact[]>();
    for (const artifact of artifacts) {
      const signature = signatureFor(artifact);
      const existing = grouped.get(signature);
      if (existing) {
        existing.push(artifact);
      } else {
        grouped.set(signature, [artifact]);
      }
    }
    return grouped;
  };
  const sortArtifacts = (artifacts: RunAuditExportedArtifact[]) =>
    [...artifacts].sort((left, right) =>
      `${left.sha256}:${left.integrity_digest ?? ""}:${left.artifact_id}`.localeCompare(
        `${right.sha256}:${right.integrity_digest ?? ""}:${right.artifact_id}`,
      ),
    );
  const leftBySignature = groupBySignature(leftArtifacts);
  const rightBySignature = groupBySignature(rightArtifacts);

  for (const [signature, leftGroup] of leftBySignature) {
    const rightGroup = rightBySignature.get(signature) ?? [];
    const sortedLeft = sortArtifacts(leftGroup);
    const sortedRight = sortArtifacts(rightGroup);
    const comparableCount = Math.min(sortedLeft.length, sortedRight.length);

    for (let index = 0; index < comparableCount; index += 1) {
      const artifact = sortedLeft[index]!;
      const other = sortedRight[index]!;
      if (artifact.sha256 !== other.sha256 || artifact.integrity_digest !== other.integrity_digest) {
        differences.push({
          code: "EXPORTED_ARTIFACT_DIGEST_CHANGED",
          artifact_id: artifact.artifact_id,
          message: `Exported artifact ${signature} changed digest between bundles.`,
          left_value: {
            artifact_id: artifact.artifact_id,
            sha256: artifact.sha256,
            integrity_digest: artifact.integrity_digest,
          },
          right_value: {
            artifact_id: other.artifact_id,
            sha256: other.sha256,
            integrity_digest: other.integrity_digest,
          },
        });
      }
    }

    for (const artifact of sortedLeft.slice(comparableCount)) {
      differences.push({
        code: "EXPORTED_ARTIFACT_REMOVED",
        artifact_id: artifact.artifact_id,
        message: `Artifact ${artifact.artifact_id} was exported in the left bundle but not the right bundle.`,
      });
    }
    for (const artifact of sortedRight.slice(comparableCount)) {
      differences.push({
        code: "EXPORTED_ARTIFACT_ADDED",
        artifact_id: artifact.artifact_id,
        message: `Artifact ${artifact.artifact_id} was exported in the right bundle but not the left bundle.`,
      });
    }
  }

  for (const [signature, rightGroup] of rightBySignature) {
    if (leftBySignature.has(signature)) {
      continue;
    }

    for (const artifact of rightGroup) {
      differences.push({
        code: "EXPORTED_ARTIFACT_ADDED",
        artifact_id: artifact.artifact_id,
        message: `Artifact ${artifact.artifact_id} was exported in the right bundle but not the left bundle.`,
      });
    }
  }

  return differences;
}

function compareAuditSkippedArtifactRecords(
  leftArtifacts: RunAuditSkippedArtifact[],
  rightArtifacts: RunAuditSkippedArtifact[],
): RunAuditCompareDifference[] {
  const differences: RunAuditCompareDifference[] = [];
  const serialize = (artifact: RunAuditSkippedArtifact) =>
    `${artifact.artifact_id}:${artifact.type}:${artifact.artifact_status}:${artifact.reason}`;
  const leftSet = new Set(leftArtifacts.map(serialize));
  const rightSet = new Set(rightArtifacts.map(serialize));

  for (const artifact of leftArtifacts) {
    const encoded = serialize(artifact);
    if (!rightSet.has(encoded)) {
      differences.push({
        code: "SKIPPED_ARTIFACT_REMOVED",
        artifact_id: artifact.artifact_id,
        message: `Skipped artifact ${artifact.artifact_id} no longer appears in the right bundle.`,
      });
    }
  }

  for (const artifact of rightArtifacts) {
    const encoded = serialize(artifact);
    if (!leftSet.has(encoded)) {
      differences.push({
        code: "SKIPPED_ARTIFACT_ADDED",
        artifact_id: artifact.artifact_id,
        message: `Skipped artifact ${artifact.artifact_id} appears in the right bundle but not the left bundle.`,
      });
    }
  }

  return differences;
}

function compareRunAuditBundles(leftOutputDir: string, rightOutputDir: string): RunAuditCompareResult {
  const leftBundle = loadRunAuditBundle(leftOutputDir);
  const rightBundle = loadRunAuditBundle(rightOutputDir);
  const differences: RunAuditCompareDifference[] = [];
  const leftActionCount = leftBundle.timeline?.steps.length ?? null;
  const rightActionCount = rightBundle.timeline?.steps.length ?? null;

  const compareScalar = (
    code: RunAuditCompareDifference["code"],
    message: string,
    leftValue: unknown,
    rightValue: unknown,
  ): void => {
    if (JSON.stringify(leftValue) !== JSON.stringify(rightValue)) {
      differences.push({
        code,
        message,
        left_value: leftValue,
        right_value: rightValue,
      });
    }
  };

  compareScalar("RUN_ID_CHANGED", "Run id changed between audit bundles.", leftBundle.run_id, rightBundle.run_id);
  compareScalar(
    "VISIBILITY_SCOPE_CHANGED",
    "Visibility scope changed between audit bundles.",
    leftBundle.timeline?.visibility_scope ?? leftBundle.manifest.visibility_scope ?? null,
    rightBundle.timeline?.visibility_scope ?? rightBundle.manifest.visibility_scope ?? null,
  );
  compareScalar(
    "EVENT_COUNT_CHANGED",
    "Run event count changed between audit bundles.",
    leftBundle.run_summary?.run.event_count ?? null,
    rightBundle.run_summary?.run.event_count ?? null,
  );
  compareScalar(
    "ACTION_COUNT_CHANGED",
    "Run action count changed between audit bundles.",
    leftActionCount,
    rightActionCount,
  );
  compareScalar(
    "TIMELINE_STEP_COUNT_CHANGED",
    "Timeline step count changed between audit bundles.",
    leftBundle.timeline?.steps.length ?? 0,
    rightBundle.timeline?.steps.length ?? 0,
  );
  compareScalar(
    "APPROVAL_COUNT_CHANGED",
    "Approval count changed between audit bundles.",
    leftBundle.approvals?.approvals.length ?? 0,
    rightBundle.approvals?.approvals.length ?? 0,
  );
  compareScalar(
    "APPROVAL_INBOX_COUNT_CHANGED",
    "Approval inbox item count changed between audit bundles.",
    leftBundle.approval_inbox?.items.length ?? 0,
    rightBundle.approval_inbox?.items.length ?? 0,
  );
  compareScalar(
    "VERIFICATION_STATUS_CHANGED",
    "Bundle verification status changed between audit bundles.",
    leftBundle.verify_result.verified,
    rightBundle.verify_result.verified,
  );

  differences.push(
    ...compareAuditArtifactRecords(
      Array.isArray(leftBundle.manifest.exported_artifacts) ? leftBundle.manifest.exported_artifacts : [],
      Array.isArray(rightBundle.manifest.exported_artifacts) ? rightBundle.manifest.exported_artifacts : [],
    ),
  );
  differences.push(
    ...compareAuditSkippedArtifactRecords(
      Array.isArray(leftBundle.manifest.skipped_artifacts) ? leftBundle.manifest.skipped_artifacts : [],
      Array.isArray(rightBundle.manifest.skipped_artifacts) ? rightBundle.manifest.skipped_artifacts : [],
    ),
  );

  if (JSON.stringify(leftBundle.diagnostics ?? null) !== JSON.stringify(rightBundle.diagnostics ?? null)) {
    differences.push({
      code: "DIAGNOSTICS_CHANGED",
      message: "Diagnostics payload changed between audit bundles.",
    });
  }

  return {
    left_bundle_dir: leftOutputDir,
    right_bundle_dir: rightOutputDir,
    left_run_id: leftBundle.run_id,
    right_run_id: rightBundle.run_id,
    left_manifest_version: leftBundle.manifest_version,
    right_manifest_version: rightBundle.manifest_version,
    left_verified: leftBundle.verify_result.verified,
    right_verified: rightBundle.verify_result.verified,
    comparable: true,
    differences,
  };
}

function createRunAuditSharePackage(
  bundleDir: string,
  outputDir: string,
  includeArtifactContent: boolean,
): RunAuditShareResult {
  const bundle = loadRunAuditBundle(bundleDir);
  if (!bundle.verify_result.verified) {
    throw inputError(`run-audit-share requires a verified source bundle: ${bundleDir}`, {
      verification_issues: bundle.verify_result.issues,
    });
  }

  ensurePathDoesNotExist(outputDir, "run-audit-share");
  fs.mkdirSync(outputDir, { recursive: true });
  const copiedFiles: string[] = [];

  const reportFiles = [
    "run-summary.json",
    "run-summary.txt",
    "timeline.json",
    "timeline.txt",
    "approvals.json",
    "approvals.txt",
    "approval-inbox.json",
    "approval-inbox.txt",
    "diagnostics.json",
    "diagnostics.txt",
  ];
  for (const fileName of reportFiles) {
    const sourcePath = path.join(bundleDir, fileName);
    if (fs.existsSync(sourcePath)) {
      copyFileAndTrack(sourcePath, path.join(outputDir, fileName), copiedFiles);
    }
  }

  const copiedArtifacts: RunAuditShareArtifactRecord[] = [];
  const withheldArtifacts: RunAuditShareResult["withheld_artifacts"] = [];
  const exportedArtifacts = Array.isArray(bundle.manifest.exported_artifacts) ? bundle.manifest.exported_artifacts : [];

  for (const artifact of exportedArtifacts) {
    const relativePath = artifact.relative_path;
    const sourceArtifactPath = path.resolve(bundleDir, relativePath);
    if (includeArtifactContent) {
      const targetArtifactPath = path.join(outputDir, relativePath);
      copyFileAndTrack(sourceArtifactPath, targetArtifactPath, copiedFiles);
      copiedArtifacts.push({
        artifact_id: artifact.artifact_id,
        type: artifact.type,
        relative_path: relativePath,
        output_path: targetArtifactPath,
      });
      continue;
    }

    withheldArtifacts.push({
      artifact_id: artifact.artifact_id,
      type: artifact.type,
      reason: "artifact content omitted from share package",
      relative_path: relativePath,
    });
  }

  const shareManifest = {
    manifest_version: RUN_AUDIT_SHARE_MANIFEST_VERSION,
    source_bundle_dir: bundleDir,
    source_run_id: bundle.run_id,
    source_manifest_version: bundle.manifest_version,
    output_dir: outputDir,
    shared_at: new Date().toISOString(),
    include_artifact_content: includeArtifactContent,
    copied_files: copiedFiles,
    copied_artifacts: copiedArtifacts,
    withheld_artifacts: withheldArtifacts,
  };
  const shareManifestPath = path.join(outputDir, "share-manifest.json");
  writeJsonFile(shareManifestPath, shareManifest);
  copiedFiles.push(shareManifestPath);

  return {
    run_id: bundle.run_id,
    source_bundle_dir: bundleDir,
    output_dir: outputDir,
    manifest_version: RUN_AUDIT_SHARE_MANIFEST_VERSION,
    include_artifact_content: includeArtifactContent,
    copied_files: copiedFiles,
    copied_artifacts: copiedArtifacts,
    withheld_artifacts: withheldArtifacts,
  };
}

function formatTimestamp(value: string | null | undefined): string {
  return value ?? "unknown";
}

function formatVersion(result: VersionResult): string {
  return lines(
    `agentgit-authority ${result.cli_version}`,
    `Supported API version: ${result.supported_api_version}`,
    `JSON contract: ${result.json_contract_version}`,
    `Exit code registry: ${result.exit_code_registry_version}`,
    `Config schema: ${result.config_schema_version}`,
  );
}

function formatHello(result: HelloResult): string {
  return lines(
    "Authority daemon reachable",
    `Session: ${result.session_id}`,
    `Accepted API version: ${result.accepted_api_version}`,
    `Runtime version: ${result.runtime_version}`,
    `Schema pack: ${result.schema_pack_version}`,
    `Local only: ${result.capabilities.local_only ? "yes" : "no"}`,
    `Capabilities: ${joinOrNone(result.capabilities.methods)}`,
  );
}

function formatConfigShow(result: ConfigShowResult): string {
  const config = result.resolved;
  return lines(
    "CLI config",
    `Config root: ${config.paths.configRoot}`,
    `User config: ${config.paths.userConfigPath}${config.user_config_exists ? "" : " (not present)"}`,
    `Workspace config: ${config.paths.workspaceConfigPath}${config.workspace_config_exists ? "" : " (not present)"}`,
    `Active profile: ${config.active_profile ?? "none"}`,
    `Workspace root: ${config.workspace_root.value} [${config.workspace_root.source}]`,
    `Socket path: ${config.socket_path.value} [${config.socket_path.source}]`,
    `Connect timeout: ${config.connect_timeout_ms.value}ms [${config.connect_timeout_ms.source}]`,
    `Response timeout: ${config.response_timeout_ms.value}ms [${config.response_timeout_ms.source}]`,
    `Max connect retries: ${config.max_connect_retries.value} [${config.max_connect_retries.source}]`,
    `Connect retry delay: ${config.connect_retry_delay_ms.value}ms [${config.connect_retry_delay_ms.source}]`,
  );
}

function formatConfigValidation(result: CliConfigValidationResult): string {
  return lines(
    "CLI config validation",
    `Valid: ${result.valid ? "yes" : "no"}`,
    `Config root: ${result.paths.configRoot}`,
    `User config: ${result.paths.userConfigPath}${result.user_config_exists ? "" : " (not present)"}`,
    `Workspace config: ${result.paths.workspaceConfigPath}${result.workspace_config_exists ? "" : " (not present)"}`,
    result.issues.length === 0 ? "Issues: none" : `Issues:\n${bulletList(result.issues)}`,
  );
}

function formatProfileList(result: ProfileListResult): string {
  const profileLines =
    result.profiles.length === 0
      ? "No CLI profiles are configured."
      : result.profiles
          .map((profile) => `${profile.name} [${profile.source}]${profile.active ? " (active)" : ""}`)
          .join("\n");

  return lines("CLI profiles", `Active profile: ${result.active_profile ?? "none"}`, profileLines);
}

function formatDoctor(result: DoctorResult): string {
  return lines(
    "CLI doctor",
    `CLI version: ${result.cli_version}`,
    `Config root: ${result.config.config_root}`,
    `User config: ${result.config.user_config_path}`,
    `Workspace config: ${result.config.workspace_config_path}`,
    `Active profile: ${result.config.active_profile ?? "none"}`,
    `Workspace root: ${result.config.workspace_root}`,
    `Socket path: ${result.config.socket_path}`,
    `Daemon reachable: ${result.daemon.reachable ? "yes" : "no"}`,
    maybeLine("Session", result.daemon.session_id),
    maybeLine("Accepted API", result.daemon.accepted_api_version),
    maybeLine("Runtime version", result.daemon.runtime_version),
    maybeLine("Schema pack version", result.daemon.schema_pack_version),
    `Security posture: ${result.security_posture_status}`,
    result.checks.length === 0
      ? "Checks: none"
      : `Checks:\n${bulletList(result.checks.map((check) => `[${check.status}] ${check.code}: ${check.summary}`))}`,
    result.recommendations.length === 0
      ? "Recommendations: none"
      : `Recommendations:\n${bulletList(result.recommendations)}`,
  );
}

function formatRegisterRun(result: RegisterRunResult): string {
  return lines(
    `Registered run ${result.run_id}`,
    `Workflow: ${result.run_handle.workflow_name}`,
    `Session: ${result.run_handle.session_id}`,
    `Effective policy profile: ${result.effective_policy_profile}`,
  );
}

function loadPolicyDocument(policyPath: string): unknown {
  const resolvedPath = path.resolve(policyPath);
  const document = fs.readFileSync(resolvedPath, "utf8");
  return resolvedPath.endsWith(".json") ? JSON.parse(document) : TOML.parse(document);
}

function validatePolicyConfigDocument(document: unknown): PolicyValidationResult {
  const parsed = PolicyConfigSchema.safeParse(document);
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map((issue) =>
        issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
      ),
      normalized_config: null,
      compiled_policy: null,
    };
  }

  return {
    valid: true,
    issues: [],
    normalized_config: parsed.data,
    // CLI only needs rule count for user-facing validation output.
    compiled_policy: {
      rules: parsed.data.rules,
    },
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function buildPolicyDiffResult(
  effectivePolicy: EffectivePolicyResult,
  candidateConfig: NonNullable<PolicyValidationResult["normalized_config"]>,
): PolicyDiffResult {
  const effectiveThresholds = new Map(
    (effectivePolicy.policy.thresholds?.low_confidence ?? []).map((entry) => [entry.action_family, entry.ask_below]),
  );
  const candidateThresholds = candidateConfig.thresholds?.low_confidence ?? [];
  const thresholdAdditions: PolicyDiffResult["threshold_additions"] = [];
  const thresholdChanges: PolicyDiffResult["threshold_changes"] = [];
  let thresholdUnchangedCount = 0;

  for (const threshold of candidateThresholds) {
    const current = effectiveThresholds.get(threshold.action_family);
    if (current === undefined) {
      thresholdAdditions.push({
        action_family: threshold.action_family,
        ask_below: threshold.ask_below,
      });
      continue;
    }

    if (current === threshold.ask_below) {
      thresholdUnchangedCount += 1;
      continue;
    }

    thresholdChanges.push({
      action_family: threshold.action_family,
      current_ask_below: current,
      candidate_ask_below: threshold.ask_below,
    });
  }

  const effectiveRules = new Map(effectivePolicy.policy.rules.map((rule) => [rule.rule_id, rule]));
  const addedRuleIds: string[] = [];
  const changedRuleIds: string[] = [];
  const unchangedRuleIds: string[] = [];

  for (const rule of candidateConfig.rules) {
    const current = effectiveRules.get(rule.rule_id);
    if (!current) {
      addedRuleIds.push(rule.rule_id);
      continue;
    }

    if (stableJson(current) === stableJson(rule)) {
      unchangedRuleIds.push(rule.rule_id);
    } else {
      changedRuleIds.push(rule.rule_id);
    }
  }

  return {
    comparison_mode: "candidate_overlay",
    effective_profile_name: effectivePolicy.summary.profile_name,
    candidate_profile_name: candidateConfig.profile_name,
    effective_policy_version: effectivePolicy.policy.policy_version,
    candidate_policy_version: candidateConfig.policy_version,
    threshold_additions: thresholdAdditions.sort((left, right) =>
      left.action_family.localeCompare(right.action_family),
    ),
    threshold_changes: thresholdChanges.sort((left, right) => left.action_family.localeCompare(right.action_family)),
    threshold_unchanged_count: thresholdUnchangedCount,
    added_rule_ids: addedRuleIds.sort(),
    changed_rule_ids: changedRuleIds.sort(),
    unchanged_rule_ids: unchangedRuleIds.sort(),
    omitted_effective_rule_count: Math.max(0, effectivePolicy.policy.rules.length - candidateConfig.rules.length),
  };
}

function renderThresholdPatch(
  result: PolicyThresholdRecommendationsResult,
  directionFilter: "tighten" | "relax" | "all",
): PolicyThresholdPatchResult {
  const includedRecommendations = result.recommendations
    .filter((entry) => entry.requires_policy_update)
    .filter((entry) => directionFilter === "all" || entry.direction === directionFilter)
    .filter((entry) => entry.recommended_ask_below !== null)
    .map((entry) => ({
      action_family: entry.action_family,
      current_ask_below: entry.current_ask_below,
      recommended_ask_below: entry.recommended_ask_below,
      direction: entry.direction,
      rationale: entry.rationale,
    }))
    .sort((left, right) => left.action_family.localeCompare(right.action_family));

  const patchLines =
    includedRecommendations.length === 0
      ? [
          "# No threshold changes matched the current recommendation filter.",
          "# Review the recommendation report before making manual policy edits.",
        ]
      : [
          "# Suggested threshold patch (report only; review before applying)",
          "[thresholds]",
          "low_confidence = [",
          ...includedRecommendations.map(
            (entry) =>
              `  { action_family = ${JSON.stringify(entry.action_family)}, ask_below = ${entry.recommended_ask_below!.toFixed(3)} },`,
          ),
          "]",
        ];

  return {
    generated_at: result.generated_at,
    effective_policy_profile: result.effective_policy_profile,
    run_id: result.filters.run_id,
    min_samples: result.filters.min_samples,
    direction_filter: directionFilter,
    included_recommendations: includedRecommendations,
    patch_toml: patchLines.join("\n"),
    report_only: true,
  };
}

function formatEffectivePolicy(result: EffectivePolicyResult): string {
  const thresholdLines = result.policy.thresholds?.low_confidence.length
    ? result.policy.thresholds.low_confidence
        .map((threshold) => `${threshold.action_family}: ask_below=${threshold.ask_below.toFixed(3)}`)
        .join("\n")
    : "none";
  const sourceLines =
    result.summary.loaded_sources.length === 0
      ? "none"
      : result.summary.loaded_sources
          .map(
            (source) =>
              `${source.scope}: ${source.profile_name}@${source.policy_version} (${source.rule_count} rule${source.rule_count === 1 ? "" : "s"})${source.path ? ` [${source.path}]` : ""}`,
          )
          .join("\n");
  const ruleLines =
    result.policy.rules.length === 0
      ? "none"
      : result.policy.rules
          .map(
            (rule) =>
              `${rule.rule_id} [${rule.enforcement_mode}/${rule.decision}] priority=${rule.priority} scope=${rule.binding_scope}`,
          )
          .join("\n");

  return lines(
    "Effective policy",
    `Profile: ${result.summary.profile_name}`,
    `Policy versions: ${joinOrNone(result.summary.policy_versions)}`,
    `Compiled rules: ${result.summary.compiled_rule_count}`,
    `Low-confidence thresholds:\n${thresholdLines}`,
    result.summary.warnings.length === 0 ? "Warnings: none" : `Warnings:\n${bulletList(result.summary.warnings)}`,
    `Sources:\n${sourceLines}`,
    `Rules:\n${ruleLines}`,
  );
}

function formatPolicyValidation(result: PolicyValidationResult): string {
  return lines(
    "Policy validation",
    `Valid: ${result.valid ? "yes" : "no"}`,
    result.normalized_config ? `Profile: ${result.normalized_config.profile_name}` : null,
    result.normalized_config ? `Policy version: ${result.normalized_config.policy_version}` : null,
    result.compiled_policy ? `Compiled rules: ${result.compiled_policy.rules.length}` : null,
    result.issues.length === 0 ? "Issues: none" : `Issues:\n${bulletList(result.issues)}`,
  );
}

function formatPolicyCalibrationReport(result: PolicyCalibrationReportResult): string {
  const families =
    result.report.action_families.length === 0
      ? "none"
      : result.report.action_families
          .map((family) => {
            const confidence =
              family.confidence.average === null
                ? "n/a"
                : `${family.confidence.average.toFixed(3)} (${family.confidence.min?.toFixed(3) ?? "n/a"}-${family.confidence.max?.toFixed(3) ?? "n/a"})`;
            return [
              `${family.action_family}: ${family.sample_count} sample${family.sample_count === 1 ? "" : "s"}`,
              `  decisions: allow=${family.decisions.allow}, allow_with_snapshot=${family.decisions.allow_with_snapshot}, ask=${family.decisions.ask}, deny=${family.decisions.deny}`,
              `  approvals: requested=${family.approvals.requested}, pending=${family.approvals.pending}, approved=${family.approvals.approved}, denied=${family.approvals.denied}`,
              `  confidence: ${confidence}`,
              `  snapshot classes: ${family.snapshot_classes.length === 0 ? "none" : family.snapshot_classes.map((entry) => `${entry.key}=${entry.count}`).join(", ")}`,
            ].join("\n");
          })
          .join("\n");
  const sampleSection =
    result.report.samples && result.report.samples.length > 0
      ? `Samples:\n${result.report.samples
          .map(
            (sample) =>
              `${sample.action_id} [${sample.action_family}] decision=${sample.decision} confidence=${sample.normalization_confidence.toFixed(3)} approval=${sample.approval_status ?? "none"} recovery=${sample.recovery_attempted ? (sample.recovery_result ?? "attempted") : "none"}`,
          )
          .join("\n")}`
      : result.report.filters.include_samples
        ? "Samples: none"
        : null;

  return lines(
    "Policy calibration report",
    `Generated: ${result.report.generated_at}`,
    `Run filter: ${result.report.filters.run_id ?? "all"}`,
    `Samples: ${result.report.totals.sample_count}`,
    `Action families: ${result.report.totals.unique_action_families}`,
    `Confidence average: ${result.report.totals.confidence.average === null ? "n/a" : result.report.totals.confidence.average.toFixed(3)}`,
    `Decisions: allow=${result.report.totals.decisions.allow}, allow_with_snapshot=${result.report.totals.decisions.allow_with_snapshot}, ask=${result.report.totals.decisions.ask}, deny=${result.report.totals.decisions.deny}`,
    `Approvals: requested=${result.report.totals.approvals.requested}, pending=${result.report.totals.approvals.pending}, approved=${result.report.totals.approvals.approved}, denied=${result.report.totals.approvals.denied}`,
    `Recovery attempted: ${result.report.totals.recovery_attempted_count}`,
    `Samples truncated: ${result.report.samples_truncated ? "yes" : "no"}`,
    `Action families:\n${families}`,
    sampleSection,
  );
}

function formatPolicyExplanation(result: ExplainPolicyActionResult): string {
  const reasonLines =
    result.policy_outcome.reasons.length === 0
      ? "none"
      : result.policy_outcome.reasons
          .map((reason) => `${reason.code} [${reason.severity}] ${reason.message}`)
          .join("\n");
  const matchedRules =
    result.policy_outcome.policy_context.matched_rules.length === 0
      ? "none"
      : result.policy_outcome.policy_context.matched_rules.join(", ");
  const snapshotLine = result.snapshot_selection
    ? `${result.snapshot_selection.snapshot_class} (${joinOrNone(result.snapshot_selection.reason_codes)})`
    : "none";

  return lines(
    "Policy explanation",
    `Profile: ${result.effective_policy_profile}`,
    `Action family: ${result.action_family}`,
    `Decision: ${result.policy_outcome.decision}`,
    `Normalization confidence: ${result.action.normalization.normalization_confidence.toFixed(3)}`,
    `Low-confidence threshold: ${result.low_confidence_threshold === null ? "none" : result.low_confidence_threshold.toFixed(3)}`,
    `Confidence-triggered: ${result.confidence_triggered ? "yes" : "no"}`,
    `Matched rules: ${matchedRules}`,
    `Snapshot selection: ${snapshotLine}`,
    `Reasons:\n${reasonLines}`,
  );
}

function formatPolicyThresholdRecommendations(result: PolicyThresholdRecommendationsResult): string {
  const recommendationLines =
    result.recommendations.length === 0
      ? "none"
      : result.recommendations
          .map((entry) => {
            const thresholdLine =
              entry.recommended_ask_below === null
                ? "none"
                : `${entry.current_ask_below === null ? "unset" : entry.current_ask_below.toFixed(3)} -> ${entry.recommended_ask_below.toFixed(3)}`;
            return [
              `${entry.action_family}: ${entry.direction}`,
              `  threshold: ${thresholdLine}`,
              `  samples: ${entry.sample_count}`,
              `  approvals: requested=${entry.approvals_requested}, approved=${entry.approvals_approved}, denied=${entry.approvals_denied}`,
              `  confidence: observed=${entry.observed_confidence_min?.toFixed(3) ?? "n/a"}-${entry.observed_confidence_max?.toFixed(3) ?? "n/a"}, denied_max=${entry.denied_confidence_max?.toFixed(3) ?? "n/a"}, approved_min=${entry.approved_confidence_min?.toFixed(3) ?? "n/a"}`,
              `  policy update required: ${entry.requires_policy_update ? "yes" : "no"}`,
              `  rationale: ${entry.rationale}`,
            ].join("\n");
          })
          .join("\n");

  return lines(
    "Policy threshold recommendations",
    `Generated: ${result.generated_at}`,
    `Profile: ${result.effective_policy_profile}`,
    `Run filter: ${result.filters.run_id ?? "all"}`,
    `Minimum samples: ${result.filters.min_samples}`,
    "Report only: yes",
    `Recommendations:\n${recommendationLines}`,
  );
}

function formatPolicyDiff(result: PolicyDiffResult): string {
  const thresholdAdditionLines =
    result.threshold_additions.length === 0
      ? "none"
      : result.threshold_additions
          .map((entry) => `${entry.action_family}: add ask_below=${entry.ask_below.toFixed(3)}`)
          .join("\n");
  const thresholdChangeLines =
    result.threshold_changes.length === 0
      ? "none"
      : result.threshold_changes
          .map(
            (entry) =>
              `${entry.action_family}: ${entry.current_ask_below.toFixed(3)} -> ${entry.candidate_ask_below.toFixed(3)}`,
          )
          .join("\n");

  return lines(
    "Policy diff",
    `Comparison mode: ${result.comparison_mode}`,
    `Effective profile: ${result.effective_profile_name} @ ${result.effective_policy_version}`,
    `Candidate profile: ${result.candidate_profile_name} @ ${result.candidate_policy_version}`,
    `Threshold additions:\n${thresholdAdditionLines}`,
    `Threshold changes:\n${thresholdChangeLines}`,
    `Thresholds unchanged: ${result.threshold_unchanged_count}`,
    `Rule additions: ${joinOrNone(result.added_rule_ids)}`,
    `Rule changes: ${joinOrNone(result.changed_rule_ids)}`,
    `Rule unchanged: ${joinOrNone(result.unchanged_rule_ids)}`,
    `Effective rules omitted by candidate overlay: ${result.omitted_effective_rule_count}`,
    "Note: this compares the candidate file as an overlay against the current effective policy; rules not mentioned by the candidate may still exist from other loaded sources.",
  );
}

function formatPolicyThresholdPatch(result: PolicyThresholdPatchResult): string {
  const included =
    result.included_recommendations.length === 0
      ? "none"
      : result.included_recommendations
          .map(
            (entry) =>
              `${entry.action_family}: ${entry.direction} ${entry.current_ask_below === null ? "unset" : entry.current_ask_below.toFixed(3)} -> ${entry.recommended_ask_below?.toFixed(3) ?? "none"}`,
          )
          .join("\n");

  return lines(
    "Policy threshold patch",
    `Generated: ${result.generated_at}`,
    `Profile: ${result.effective_policy_profile}`,
    `Run filter: ${result.run_id ?? "all"}`,
    `Minimum samples: ${result.min_samples}`,
    `Direction filter: ${result.direction_filter}`,
    `Report only: ${result.report_only ? "yes" : "no"}`,
    `Included recommendations:\n${included}`,
    `Patch:\n${result.patch_toml}`,
    "Apply step: review this patch and merge it into your policy TOML manually.",
  );
}

export function formatRunSummary(result: RunSummaryResult): string {
  const { run } = result;
  const latestEvent = run.latest_event
    ? `#${run.latest_event.sequence} ${run.latest_event.event_type} at ${run.latest_event.occurred_at}`
    : "none";

  return lines(
    "Run summary",
    `Run: ${run.run_id}`,
    `Workflow: ${run.workflow_name}`,
    `Agent: ${run.agent_name} (${run.agent_framework})`,
    `Session: ${run.session_id}`,
    `Workspace roots: ${joinOrNone(run.workspace_roots)}`,
    `Events: ${run.event_count}`,
    `Latest event: ${latestEvent}`,
    `Mutating budget: ${formatBudget(run.budget_usage.mutating_actions, run.budget_config.max_mutating_actions)}`,
    `Destructive budget: ${formatBudget(run.budget_usage.destructive_actions, run.budget_config.max_destructive_actions)}`,
    `Projection: ${run.maintenance_status.projection_status} (${run.maintenance_status.projection_lag_events} lag events)`,
    `Artifact health: ${run.maintenance_status.artifact_health.available}/${run.maintenance_status.artifact_health.total} available, ${run.maintenance_status.artifact_health.missing} missing, ${run.maintenance_status.artifact_health.expired} expired, ${run.maintenance_status.artifact_health.corrupted} corrupted, ${run.maintenance_status.artifact_health.tampered} tampered`,
    `Degraded artifact captures: ${run.maintenance_status.degraded_artifact_capture_actions}`,
    `Low-disk pressure signals: ${run.maintenance_status.low_disk_pressure_signals}`,
    `Created: ${run.created_at}`,
    `Started: ${run.started_at}`,
  );
}

export function formatCapabilities(result: CapabilitiesResult): string {
  const capabilityLines =
    result.capabilities.length === 0
      ? "No capability records detected."
      : result.capabilities
          .map((capability: CapabilityRecord) =>
            lines(
              `- ${capability.capability_name} [${capability.status}]`,
              `  Scope: ${capability.scope}`,
              `  Source: ${capability.source}`,
              `  Detected: ${capability.detected_at}`,
              `  Details: ${JSON.stringify(capability.details)}`,
            ),
          )
          .join("\n\n");
  const warnings =
    result.degraded_mode_warnings.length === 0 ? "none" : `\n${bulletList(result.degraded_mode_warnings)}`;

  return lines(
    "Capabilities",
    `Detection started: ${result.detection_timestamps.started_at}`,
    `Detection completed: ${result.detection_timestamps.completed_at}`,
    `Degraded mode warnings:${warnings}`,
    "",
    capabilityLines,
  );
}

export function formatMcpServers(result: ListMcpServersResult): string {
  const serverLines =
    result.servers.length === 0
      ? "No local governed MCP servers are registered."
      : result.servers
          .map((record: RegisteredMcpServer) => {
            const transportTarget =
              record.server.transport === "streamable_http" ? record.server.url : record.server.command;
            return lines(
              `- ${record.server.server_id} [${record.server.transport}]`,
              maybeLine("  Display name", record.server.display_name),
              `  Source: ${record.source}`,
              `  Transport target: ${transportTarget}`,
              record.server.transport === "streamable_http"
                ? `  Network scope: ${record.server.network_scope ?? "loopback"}`
                : null,
              record.server.transport === "streamable_http"
                ? `  Max concurrent calls: ${record.server.max_concurrent_calls ?? 1}`
                : null,
              `  Tools: ${record.server.tools.map((tool) => `${tool.tool_name}:${tool.side_effect_level}:${tool.approval_mode ?? "ask"}`).join(", ")}`,
              `  Created: ${record.created_at}`,
              `  Updated: ${record.updated_at}`,
            );
          })
          .join("\n\n");

  return lines("Local governed MCP servers", serverLines);
}

export function formatMcpServerCandidates(result: ListMcpServerCandidatesResult): string {
  const candidateLines =
    result.candidates.length === 0
      ? "No MCP server candidates have been submitted."
      : result.candidates
          .map((candidate) =>
            lines(
              `- ${candidate.candidate_id} [${candidate.source_kind}]`,
              `  Raw endpoint: ${candidate.raw_endpoint}`,
              `  Transport hint: ${candidate.transport_hint ?? "unspecified"}`,
              `  Resolution state: ${candidate.resolution_state}`,
              `  Submitted by session: ${candidate.submitted_by_session_id ?? "unknown"}`,
              `  Submitted by run: ${candidate.submitted_by_run_id ?? "none"}`,
              `  Workspace: ${candidate.workspace_id ?? "none"}`,
              maybeLine("  Notes", candidate.notes ?? undefined),
              maybeLine("  Resolution error", candidate.resolution_error ?? undefined),
              `  Submitted: ${candidate.submitted_at}`,
              `  Updated: ${candidate.updated_at}`,
            ),
          )
          .join("\n\n");

  return lines("MCP server candidates", candidateLines);
}

export function formatMcpServerProfiles(result: ListMcpServerProfilesResult): string {
  const profileLines =
    result.profiles.length === 0
      ? "No MCP server profiles have been resolved yet."
      : result.profiles
          .map((profile) =>
            lines(
              `- ${profile.server_profile_id} [${profile.status}]`,
              maybeLine("  Display name", profile.display_name ?? undefined),
              `  Transport: ${profile.transport}`,
              `  Canonical endpoint: ${profile.canonical_endpoint}`,
              `  Network scope: ${profile.network_scope}`,
              `  Trust tier: ${profile.trust_tier}`,
              `  Drift state: ${profile.drift_state}`,
              `  Quarantine reasons: ${profile.quarantine_reason_codes.join(", ") || "none"}`,
              `  Execution modes: ${profile.allowed_execution_modes.join(", ") || "none"}`,
              `  Active trust decision: ${profile.active_trust_decision_id ?? "none"}`,
              `  Auth mode: ${profile.auth_descriptor.mode}`,
              `  Candidate: ${profile.candidate_id ?? "none"}`,
              `  Tool inventory version: ${profile.tool_inventory_version ?? "none"}`,
              `  Last resolved: ${profile.last_resolved_at ?? "never"}`,
              `  Created: ${profile.created_at}`,
              `  Updated: ${profile.updated_at}`,
            ),
          )
          .join("\n\n");

  return lines("MCP server profiles", profileLines);
}

export function formatMcpServerReview(result: GetMcpServerReviewResult): string {
  return lines(
    "MCP server review",
    result.candidate
      ? lines(
          `Candidate: ${result.candidate.candidate_id} [${result.candidate.source_kind}]`,
          `Candidate endpoint: ${result.candidate.raw_endpoint}`,
          `Candidate resolution: ${result.candidate.resolution_state}`,
          maybeLine("Candidate resolution error", result.candidate.resolution_error ?? undefined),
        )
      : "Candidate: none",
    result.profile
      ? lines(
          `Profile: ${result.profile.server_profile_id} [${result.profile.status}]`,
          `Profile endpoint: ${result.profile.canonical_endpoint}`,
          `Trust tier: ${result.profile.trust_tier}`,
          `Drift state: ${result.profile.drift_state}`,
          `Execution modes: ${result.profile.allowed_execution_modes.join(", ") || "none"}`,
          `Quarantine reasons: ${result.profile.quarantine_reason_codes.join(", ") || "none"}`,
          `Active trust decision: ${result.active_trust_decision?.trust_decision_id ?? "none"}`,
          `Active credential binding: ${result.active_credential_binding?.credential_binding_id ?? "none"}`,
        )
      : "Profile: none",
    `Executable: ${result.review.executable ? "yes" : "no"}`,
    `Activation ready: ${result.review.activation_ready ? "yes" : "no"}`,
    `Requires resolution: ${result.review.requires_resolution ? "yes" : "no"}`,
    `Requires approval: ${result.review.requires_approval ? "yes" : "no"}`,
    `Requires credentials: ${result.review.requires_credentials ? "yes" : "no"}`,
    `Requires reapproval: ${result.review.requires_reapproval ? "yes" : "no"}`,
    `Execution support: local_proxy=${result.review.local_proxy_supported ? "yes" : "no"}, hosted=${result.review.hosted_execution_supported ? "yes" : "no"}`,
    result.review.warnings.length > 0 ? `Warnings:\n${bulletList(result.review.warnings)}` : "Warnings: none",
    result.review.recommended_actions.length > 0
      ? `Recommended actions:\n${bulletList(result.review.recommended_actions)}`
      : "Recommended actions: none",
  );
}

export function formatMcpServerTrustDecisions(result: ListMcpServerTrustDecisionsResult): string {
  const decisionLines =
    result.trust_decisions.length === 0
      ? "No MCP server trust decisions are recorded."
      : result.trust_decisions
          .map((decision) =>
            lines(
              `- ${decision.trust_decision_id} [${decision.decision}]`,
              `  Profile: ${decision.server_profile_id}`,
              `  Trust tier: ${decision.trust_tier}`,
              `  Execution modes: ${decision.allowed_execution_modes.join(", ") || "none"}`,
              `  Max side effect without approval: ${decision.max_side_effect_level_without_approval}`,
              `  Reason codes: ${decision.reason_codes.join(", ") || "none"}`,
              `  Reapproval triggers: ${decision.reapproval_triggers.join(", ") || "none"}`,
              `  Approved by session: ${decision.approved_by_session_id ?? "unknown"}`,
              `  Approved at: ${decision.approved_at}`,
              `  Valid until: ${decision.valid_until ?? "none"}`,
            ),
          )
          .join("\n\n");

  return lines("MCP server trust decisions", decisionLines);
}

export function formatMcpServerCredentialBindings(result: ListMcpServerCredentialBindingsResult): string {
  const bindingLines =
    result.credential_bindings.length === 0
      ? "No MCP server credential bindings are recorded."
      : result.credential_bindings
          .map((binding) =>
            lines(
              `- ${binding.credential_binding_id} [${binding.binding_mode}]`,
              `  Profile: ${binding.server_profile_id}`,
              `  Broker profile: ${binding.broker_profile_id}`,
              `  Status: ${binding.status}`,
              `  Scope labels: ${binding.scope_labels.join(", ") || "none"}`,
              `  Audience: ${binding.audience ?? "none"}`,
              `  Created: ${binding.created_at}`,
              `  Updated: ${binding.updated_at}`,
              `  Revoked: ${binding.revoked_at ?? "not revoked"}`,
            ),
          )
          .join("\n\n");

  return lines("MCP server credential bindings", bindingLines);
}

export function formatMcpSecrets(result: ListMcpSecretsResult): string {
  const secretLines =
    result.secrets.length === 0
      ? "No governed MCP secrets are stored."
      : result.secrets
          .map((secret: RegisteredMcpSecret) =>
            lines(
              `- ${secret.secret_id} [${secret.auth_type}]`,
              maybeLine("  Display name", secret.display_name ?? undefined),
              `  Version: ${secret.version}`,
              `  Status: ${secret.status}`,
              `  Source: ${secret.source}`,
              `  Created: ${secret.created_at}`,
              `  Updated: ${secret.updated_at}`,
              `  Rotated: ${secret.rotated_at ?? "never"}`,
              `  Last used: ${secret.last_used_at ?? "never"}`,
              `  Expires: ${secret.expires_at ?? "never"}`,
            ),
          )
          .join("\n\n");

  return lines("Governed MCP secrets", secretLines);
}

export function formatMcpHostPolicies(result: ListMcpHostPoliciesResult): string {
  const policyLines =
    result.policies.length === 0
      ? "No governed MCP public host policies are registered."
      : result.policies
          .map((record: RegisteredMcpHostPolicy) =>
            lines(
              `- ${record.policy.host}`,
              maybeLine("  Display name", record.policy.display_name),
              `  Allow subdomains: ${record.policy.allow_subdomains ? "yes" : "no"}`,
              `  Allowed ports: ${record.policy.allowed_ports?.join(", ") ?? "any"}`,
              `  Source: ${record.source}`,
              `  Created: ${record.created_at}`,
              `  Updated: ${record.updated_at}`,
            ),
          )
          .join("\n\n");

  return lines("Governed MCP public host policies", policyLines);
}

export function formatDiagnostics(result: DiagnosticsResult): string {
  return lines(
    "Diagnostics",
    result.daemon_health
      ? lines(
          `Daemon health: ${result.daemon_health.status}`,
          `Active sessions: ${result.daemon_health.active_sessions}`,
          `Active runs: ${result.daemon_health.active_runs}`,
          maybeLine("Daemon primary reason", formatReasonDetail(result.daemon_health.primary_reason)),
          result.daemon_health.warnings.length > 0
            ? `Daemon warnings: ${result.daemon_health.warnings.join(" | ")}`
            : null,
        )
      : null,
    result.journal_health
      ? lines(
          `Journal health: ${result.journal_health.status}`,
          `Journal totals: ${result.journal_health.total_runs} runs, ${result.journal_health.total_events} events, ${result.journal_health.pending_approvals} pending approvals`,
          maybeLine("Journal primary reason", formatReasonDetail(result.journal_health.primary_reason)),
          result.journal_health.warnings.length > 0
            ? `Journal warnings: ${result.journal_health.warnings.join(" | ")}`
            : null,
        )
      : null,
    result.maintenance_backlog
      ? lines(
          `Maintenance backlog: ${result.maintenance_backlog.pending_critical_jobs} critical, ${result.maintenance_backlog.pending_maintenance_jobs} maintenance`,
          `Oldest pending critical job: ${result.maintenance_backlog.oldest_pending_critical_job ?? "none"}`,
          `Current heavy job: ${result.maintenance_backlog.current_heavy_job ?? "none"}`,
          `Snapshot compaction debt: ${result.maintenance_backlog.snapshot_compaction_debt ?? "unknown"}`,
          maybeLine("Maintenance primary reason", formatReasonDetail(result.maintenance_backlog.primary_reason)),
          result.maintenance_backlog.warnings.length > 0
            ? `Maintenance warnings: ${result.maintenance_backlog.warnings.join(" | ")}`
            : null,
        )
      : null,
    result.projection_lag
      ? `Projection lag: ${result.projection_lag.projection_status} (${result.projection_lag.lag_events} lag events)`
      : null,
    result.storage_summary
      ? lines(
          `Storage evidence: ${result.storage_summary.artifact_health.available}/${result.storage_summary.artifact_health.total} available, ${result.storage_summary.artifact_health.missing} missing, ${result.storage_summary.artifact_health.expired} expired, ${result.storage_summary.artifact_health.corrupted} corrupted, ${result.storage_summary.artifact_health.tampered} tampered`,
          `Degraded artifact captures: ${result.storage_summary.degraded_artifact_capture_actions}`,
          `Low-disk pressure signals: ${result.storage_summary.low_disk_pressure_signals}`,
          maybeLine("Storage primary reason", formatReasonDetail(result.storage_summary.primary_reason)),
          result.storage_summary.warnings.length > 0
            ? `Storage warnings: ${result.storage_summary.warnings.join(" | ")}`
            : null,
        )
      : null,
    result.capability_summary
      ? lines(
          `Capability summary: ${result.capability_summary.cached ? "cached" : "not cached"}`,
          `Capability refresh age: ${result.capability_summary.refreshed_at ?? "never"}`,
          `Capability workspace root: ${result.capability_summary.workspace_root ?? "none"}`,
          `Capability counts: ${result.capability_summary.capability_count} total, ${result.capability_summary.degraded_capabilities} degraded, ${result.capability_summary.unavailable_capabilities} unavailable`,
          `Capability stale after: ${result.capability_summary.stale_after_ms}ms`,
          `Capability stale: ${result.capability_summary.is_stale ? "yes" : "no"}`,
          maybeLine("Capability primary reason", formatReasonDetail(result.capability_summary.primary_reason)),
          result.capability_summary.warnings.length > 0
            ? `Capability warnings: ${result.capability_summary.warnings.join(" | ")}`
            : null,
        )
      : null,
    result.policy_summary
      ? lines(
          `Policy summary: ${result.policy_summary.profile_name}`,
          `Policy versions: ${joinOrNone(result.policy_summary.policy_versions)}`,
          `Compiled rules: ${result.policy_summary.compiled_rule_count}`,
          result.policy_summary.loaded_sources.length > 0
            ? `Policy sources: ${result.policy_summary.loaded_sources
                .map((source) => `${source.scope}:${source.profile_name}@${source.policy_version}`)
                .join(", ")}`
            : null,
          result.policy_summary.warnings.length > 0
            ? `Policy warnings: ${result.policy_summary.warnings.join(" | ")}`
            : null,
        )
      : null,
    result.security_posture
      ? lines(
          `Security posture: ${result.security_posture.status}`,
          `Secret storage: ${result.security_posture.secret_storage.mode} (${result.security_posture.secret_storage.provider ?? "no provider"})`,
          `Secret storage durable: ${result.security_posture.secret_storage.durable ? "yes" : "no"}`,
          `Secret expiry enforced: ${result.security_posture.secret_storage.secret_expiry_enforced ? "yes" : "no"}`,
          `Stdio sandbox: ${result.security_posture.stdio_sandbox.protected_server_count}/${result.security_posture.stdio_sandbox.registered_server_count} protected`,
          `Stdio production-ready: ${result.security_posture.stdio_sandbox.production_ready_server_count}`,
          `Stdio digest-pinned: ${result.security_posture.stdio_sandbox.digest_pinned_server_count}`,
          `Stdio mutable-tag OCI: ${result.security_posture.stdio_sandbox.mutable_tag_server_count}`,
          `Stdio local-build OCI: ${result.security_posture.stdio_sandbox.local_build_server_count}`,
          `Stdio registry policy-covered: ${result.security_posture.stdio_sandbox.registry_policy_server_count}`,
          `Stdio signature-verification policy: ${result.security_posture.stdio_sandbox.signature_verification_server_count}`,
          `Stdio provenance-attested policy: ${result.security_posture.stdio_sandbox.provenance_attestation_server_count}`,
          `Stdio fallback-only: ${result.security_posture.stdio_sandbox.fallback_server_count}`,
          `Stdio unconfigured: ${result.security_posture.stdio_sandbox.unconfigured_server_count}`,
          `Stdio preferred production mode: ${result.security_posture.stdio_sandbox.preferred_production_mode}`,
          `Stdio local dev fallback: ${result.security_posture.stdio_sandbox.local_dev_fallback_mode ?? "none"}`,
          `Stdio current host mode: ${result.security_posture.stdio_sandbox.current_host_mode}`,
          maybeLine("Stdio current host reason", result.security_posture.stdio_sandbox.current_host_mode_reason),
          `Sandbox runtimes: docker=${result.security_posture.stdio_sandbox.docker_runtime_usable ? "yes" : "no"}, podman=${result.security_posture.stdio_sandbox.podman_runtime_usable ? "yes" : "no"}`,
          `Windows plan: ${result.security_posture.stdio_sandbox.windows_plan.summary}`,
          `Streamable HTTP hardening: dns=${result.security_posture.streamable_http.connect_time_dns_scope_validation ? "on" : "off"}, redirects=${result.security_posture.streamable_http.redirect_chain_revalidation ? "on" : "off"}, sqlite leases=${result.security_posture.streamable_http.shared_sqlite_leases ? "on" : "off"}, heartbeat=${result.security_posture.streamable_http.lease_heartbeat_renewal ? "on" : "off"}`,
          `Streamable HTTP exceptions: legacy env=${result.security_posture.streamable_http.legacy_bearer_env_servers.length}, missing secrets=${result.security_posture.streamable_http.missing_secret_ref_servers.length}, missing host policies=${result.security_posture.streamable_http.missing_public_host_policy_servers.length}`,
          maybeLine("Security primary reason", formatReasonDetail(result.security_posture.primary_reason)),
          result.security_posture.warnings.length > 0
            ? `Security warnings: ${result.security_posture.warnings.join(" | ")}`
            : null,
        )
      : null,
    result.hosted_worker
      ? lines(
          `Hosted worker: ${result.hosted_worker.status}`,
          `Hosted worker reachable: ${result.hosted_worker.reachable ? "yes" : "no"}`,
          `Hosted worker endpoint: ${result.hosted_worker.endpoint}`,
          `Hosted worker managed by daemon: ${result.hosted_worker.managed_by_daemon ? "yes" : "no"}`,
          `Hosted worker runtime: ${result.hosted_worker.runtime_id ?? "unknown"}`,
          `Hosted worker image digest: ${result.hosted_worker.image_digest ?? "unknown"}`,
          `Hosted worker control plane auth: ${result.hosted_worker.control_plane_auth_required ? "required" : "not required"}`,
          maybeLine("Hosted worker last error", result.hosted_worker.last_error),
          maybeLine("Hosted worker primary reason", formatReasonDetail(result.hosted_worker.primary_reason)),
          result.hosted_worker.warnings.length > 0
            ? `Hosted worker warnings: ${result.hosted_worker.warnings.join(" | ")}`
            : null,
        )
      : null,
    result.hosted_queue
      ? lines(
          `Hosted queue: ${result.hosted_queue.status}`,
          `Hosted queue counts: ${result.hosted_queue.queued_jobs} queued, ${result.hosted_queue.running_jobs} running, ${result.hosted_queue.cancel_requested_jobs} cancel requested, ${result.hosted_queue.succeeded_jobs} succeeded, ${result.hosted_queue.failed_jobs} failed, ${result.hosted_queue.canceled_jobs} canceled`,
          `Hosted queue retryable failed: ${result.hosted_queue.retryable_failed_jobs}`,
          `Hosted queue dead-letter: ${result.hosted_queue.dead_letter_retryable_jobs} retryable, ${result.hosted_queue.dead_letter_non_retryable_jobs} non-retryable`,
          `Hosted queue oldest queued: ${result.hosted_queue.oldest_queued_at ?? "none"}`,
          `Hosted queue oldest failed: ${result.hosted_queue.oldest_failed_at ?? "none"}`,
          `Hosted queue active server profiles: ${joinOrNone(result.hosted_queue.active_server_profiles)}`,
          maybeLine("Hosted queue primary reason", formatReasonDetail(result.hosted_queue.primary_reason)),
          result.hosted_queue.warnings.length > 0
            ? `Hosted queue warnings: ${result.hosted_queue.warnings.join(" | ")}`
            : null,
        )
      : null,
  );
}

function formatHostedMcpJobs(result: ListHostedMcpJobsResult): string {
  const jobLines =
    result.jobs.length === 0
      ? "No hosted MCP execution jobs matched the requested filters."
      : result.jobs
          .map((job: ListHostedMcpJobsResult["jobs"][number]) =>
            lines(
              `- ${job.job_id} [${job.status}]`,
              `  Server profile: ${job.server_profile_id}`,
              `  Tool: ${job.server_display_name}/${job.tool_name}`,
              `  Attempts: ${job.attempt_count}/${job.max_attempts}`,
              `  Updated: ${job.updated_at}`,
              `  Next attempt: ${job.next_attempt_at}`,
              maybeLine("  Last error", job.last_error?.message ?? null),
            ),
          )
          .join("\n\n");

  return lines(
    "Hosted MCP execution jobs",
    `Summary: ${result.summary.queued} queued, ${result.summary.running} running, ${result.summary.cancel_requested} cancel requested, ${result.summary.succeeded} succeeded, ${result.summary.failed} failed, ${result.summary.canceled} canceled`,
    `Dead-letter summary: ${result.summary.dead_letter_retryable} retryable, ${result.summary.dead_letter_non_retryable} non-retryable`,
    jobLines,
  );
}

function formatHostedMcpJob(result: ShowHostedMcpJobResult): string {
  return lines(
    `Hosted MCP job ${result.job.job_id}`,
    `Lifecycle: ${result.lifecycle.state}`,
    `Dead-lettered: ${result.lifecycle.dead_lettered ? "yes" : "no"}`,
    `Eligible for requeue: ${result.lifecycle.eligible_for_requeue ? "yes" : "no"}`,
    `Retry budget remaining: ${result.lifecycle.retry_budget_remaining}`,
    `Server profile: ${result.job.server_profile_id}`,
    `Tool: ${result.job.server_display_name}/${result.job.tool_name}`,
    `Attempts: ${result.job.attempt_count}/${result.job.max_attempts}`,
    `Current lease: ${result.job.current_lease_id ?? "none"}`,
    `Cancel requested: ${result.job.cancel_requested_at ?? "no"}`,
    `Cancel reason: ${result.job.cancel_reason ?? "none"}`,
    `Canceled at: ${result.job.canceled_at ?? "not canceled"}`,
    `Last error: ${result.job.last_error?.message ?? "none"}`,
    `Leases: ${result.leases.length}`,
    `Attestations: ${result.attestations.length}`,
    result.recent_events.length > 0
      ? `Recent events:\n${bulletList(
          result.recent_events.map(
            (event) =>
              `${event.sequence} ${event.event_type} @ ${event.occurred_at}${
                event.payload ? ` ${JSON.stringify(event.payload)}` : ""
              }`,
          ),
        )}`
      : "Recent events: none",
  );
}

function formatRequeueHostedMcpJob(result: RequeueHostedMcpJobResult): string {
  return lines(
    `Requeued hosted MCP job ${result.job.job_id}`,
    `Previous status: ${result.previous_status}`,
    `Current status: ${result.job.status}`,
    `Server profile: ${result.job.server_profile_id}`,
    `Tool: ${result.job.server_display_name}/${result.job.tool_name}`,
    `Attempts: ${result.job.attempt_count}/${result.job.max_attempts}`,
    `Attempt count reset: ${result.attempt_count_reset ? "yes" : "no"}`,
    `Max attempts updated: ${result.max_attempts_updated ? "yes" : "no"}`,
    `Next attempt: ${result.job.next_attempt_at}`,
  );
}

function formatCancelHostedMcpJob(result: CancelHostedMcpJobResult): string {
  return lines(
    `${result.terminal ? "Canceled" : "Cancellation requested for"} hosted MCP job ${result.job.job_id}`,
    `Previous status: ${result.previous_status}`,
    `Current status: ${result.job.status}`,
    `Server profile: ${result.job.server_profile_id}`,
    `Tool: ${result.job.server_display_name}/${result.job.tool_name}`,
    `Reason: ${result.job.cancel_reason ?? "none"}`,
    `Cancel requested at: ${result.job.cancel_requested_at ?? "unknown"}`,
    `Canceled at: ${result.job.canceled_at ?? "not yet canceled"}`,
  );
}

export function formatMaintenance(result: MaintenanceResult): string {
  return lines(
    `Maintenance accepted at priority ${result.accepted_priority}`,
    `Scope: ${result.scope ? JSON.stringify(result.scope) : "global"}`,
    ...result.jobs.map((job) =>
      lines(
        `${job.job_type}: ${job.status}${job.performed_inline ? " (inline)" : ""}`,
        `  ${job.summary}`,
        job.stats ? `  Stats: ${JSON.stringify(job.stats)}` : null,
      ),
    ),
  );
}

function formatArtifacts(step: TimelineStep): string | null {
  if (step.primary_artifacts.length === 0) {
    return null;
  }

  const values = step.primary_artifacts.map((artifact: TimelineArtifact) => {
    const suffixParts = [
      artifact.label ?? (typeof artifact.count === "number" ? `x${artifact.count}` : null),
      artifact.artifact_id ?? null,
      artifact.artifact_status ?? null,
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    const suffix = suffixParts.length > 0 ? suffixParts.join(", ") : null;
    return suffix ? `${artifact.type} (${suffix})` : artifact.type;
  });

  return `Artifacts: ${values.join(", ")}`;
}

function formatPreviewBlocks(step: TimelineStep): string | null {
  if (step.artifact_previews.length === 0) {
    return null;
  }

  return step.artifact_previews
    .map((preview: TimelineArtifactPreview) =>
      lines(`Preview ${preview.label ?? preview.type}:`, indentBlock(clipText(preview.preview), 4)),
    )
    .join("\n");
}

export function formatTimelineStep(step: TimelineStep): string {
  const previewBlocks = formatPreviewBlocks(step);
  const trustAdvisory =
    step.provenance === "governed"
      ? null
      : step.provenance === "imported"
        ? "Trust advisory: imported action from external history; it was not governed pre-execution."
        : step.provenance === "observed"
          ? "Trust advisory: observed-only action; evidence was captured after execution rather than controlled before it."
          : "Trust advisory: insufficient trustworthy provenance to claim governed pre-execution control.";
  const relatedLines = [
    maybeLine("Action", step.action_id),
    maybeLine("Decision", step.decision),
    maybeLine("Reversibility", step.reversibility_class),
    trustAdvisory,
    maybeLine("Target", step.related.target_locator ?? null),
    maybeLine("Snapshot", step.related.snapshot_id ?? null),
    maybeLine("Execution", step.related.execution_id ?? null),
    step.related.recovery_target_type && step.related.recovery_target_label
      ? `Recovery target: ${step.related.recovery_target_type} (${step.related.recovery_target_label})`
      : null,
    step.related.recovery_scope_paths && step.related.recovery_scope_paths.length > 0
      ? `Recovery scope: ${step.related.recovery_scope_paths.join(", ")}`
      : null,
    maybeLine("Recovery strategy", step.related.recovery_strategy ?? null),
    step.related.recovery_downgrade_reason
      ? `Recovery downgrade: ${step.related.recovery_downgrade_reason.code} (${step.related.recovery_downgrade_reason.message})`
      : null,
    step.related.later_actions_affected !== null && step.related.later_actions_affected !== undefined
      ? `Later actions affected: ${step.related.later_actions_affected}`
      : null,
    step.related.overlapping_paths && step.related.overlapping_paths.length > 0
      ? `Overlapping paths: ${step.related.overlapping_paths.join(", ")}`
      : null,
    maybeLine("Data loss risk", step.related.data_loss_risk ?? null),
    step.related.recovery_plan_ids && step.related.recovery_plan_ids.length > 0
      ? `Recovery plans: ${step.related.recovery_plan_ids.join(", ")}`
      : null,
    formatArtifacts(step),
    `External effects: ${step.external_effects.length > 0 ? step.external_effects.join(", ") : "none"}`,
    step.warnings && step.warnings.length > 0 ? `Warnings:\n${bulletList(step.warnings, "     - ")}` : null,
  ].filter((value): value is string => Boolean(value));

  return lines(
    `${step.sequence}. [${step.status}] ${step.title}`,
    `   ${step.summary}`,
    `   Type: ${step.step_type}`,
    `   Provenance: ${step.provenance}`,
    `   Confidence: ${formatConfidence(step.confidence)}`,
    `   Occurred: ${step.occurred_at}`,
    ...(relatedLines.map((line) => `   ${line}`) as string[]),
    previewBlocks ? indentBlock(previewBlocks, 3) : null,
  );
}

export function formatTimeline(result: TimelineResult): string {
  if (result.steps.length === 0) {
    return lines(
      `Timeline for ${result.run_summary.run_id}`,
      `Workflow: ${result.run_summary.workflow_name}`,
      `Projection status: ${result.projection_status}`,
      `Visibility: ${result.visibility_scope}`,
      `Redactions applied: ${result.redactions_applied}`,
      formatPreviewBudget(result),
      "No timeline steps recorded yet.",
    );
  }

  return lines(
    `Timeline for ${result.run_summary.run_id}`,
    `Workflow: ${result.run_summary.workflow_name}`,
    `Projection status: ${result.projection_status}`,
    `Visibility: ${result.visibility_scope}`,
    `Redactions applied: ${result.redactions_applied}`,
    formatPreviewBudget(result),
    `Steps: ${result.steps.length}`,
    formatTimelineTrustSummary(result.steps),
    "",
    result.steps.map((step: TimelineStep) => formatTimelineStep(step)).join("\n\n"),
  );
}

function formatSubmitAction(result: SubmitActionResult): string {
  const actionName = result.action.operation.display_name ?? result.action.operation.name;
  const reasons = result.policy_outcome.reasons.map((reason: PolicyReason) => `${reason.severity}: ${reason.message}`);
  const execution =
    result.execution_result === null || result.execution_result === undefined
      ? "not executed"
      : `${result.execution_result.mode} ${result.execution_result.success ? "successfully" : "with errors"} (${result.execution_result.execution_id})`;
  const approval =
    result.approval_request === null || result.approval_request === undefined
      ? null
      : `${result.approval_request.status} (${result.approval_request.approval_id})`;
  const approvalPrimaryReason = formatReasonDetail(result.approval_request?.primary_reason);
  const snapshot =
    result.snapshot_record === null || result.snapshot_record === undefined
      ? null
      : `${result.snapshot_record.snapshot_id} (${result.snapshot_record.fidelity})`;
  const artifactCapture =
    result.execution_result?.artifact_capture?.degraded === true
      ? `${result.execution_result.artifact_capture.stored_count}/${result.execution_result.artifact_capture.requested_count} stored; ${result.execution_result.artifact_capture.failures.length} capture failure(s)`
      : null;

  return lines(
    `Action ${result.action.action_id}`,
    `Operation: ${actionName}`,
    `Domain: ${result.action.operation.domain}`,
    `Target: ${result.action.target.primary.locator}`,
    `Tool: ${result.action.actor.tool_name} (${result.action.actor.tool_kind})`,
    `Policy decision: ${result.policy_outcome.decision}`,
    `Side effect level: ${result.action.risk_hints.side_effect_level}`,
    maybeLine("Approval", approval),
    maybeLine("Approval primary reason", approvalPrimaryReason),
    maybeLine("Snapshot", snapshot),
    `Execution: ${execution}`,
    maybeLine("Artifact capture", artifactCapture),
    reasons.length > 0 ? `Reasons:\n${bulletList(reasons)}` : null,
  );
}

function formatApprovalList(result: ListApprovalsResult): string {
  if (result.approvals.length === 0) {
    return "No approval requests matched.";
  }

  return lines(
    `Approvals: ${result.approvals.length}`,
    "",
    result.approvals
      .map((approval: ApprovalRequest) =>
        lines(
          `- ${approval.approval_id} [${approval.status}] ${approval.action_summary}`,
          `  Run: ${approval.run_id}`,
          `  Action: ${approval.action_id}`,
          `  Requested: ${approval.requested_at}`,
          `  Resolved: ${formatTimestamp(approval.resolved_at)}`,
          maybeLine("  Primary reason", formatReasonDetail(approval.primary_reason)),
          maybeLine("  Note", approval.resolution_note),
        ),
      )
      .join("\n\n"),
  );
}

function formatApprovalInbox(result: ApprovalInboxResult): string {
  if (result.items.length === 0) {
    return lines(
      "Approval inbox",
      `Counts: pending ${result.counts.pending}, approved ${result.counts.approved}, denied ${result.counts.denied}`,
      "No approval inbox items matched.",
    );
  }

  return lines(
    "Approval inbox",
    `Counts: pending ${result.counts.pending}, approved ${result.counts.approved}, denied ${result.counts.denied}`,
    "",
    result.items
      .map((item: ApprovalInboxItem) =>
        lines(
          `- ${item.approval_id} [${item.status}] ${item.action_summary}`,
          `  Workflow: ${item.workflow_name}`,
          `  Run: ${item.run_id}`,
          `  Action: ${item.action_id}`,
          `  Domain: ${item.action_domain}`,
          `  Side effect level: ${item.side_effect_level}`,
          `  Snapshot required: ${item.snapshot_required ? "yes" : "no"}`,
          `  Target: ${item.target_label ?? item.target_locator}`,
          `  Requested: ${item.requested_at}`,
          `  Resolved: ${formatTimestamp(item.resolved_at)}`,
          maybeLine("  Reason", item.reason_summary),
          maybeLine("  Primary reason", formatReasonDetail(item.primary_reason)),
          maybeLine("  Note", item.resolution_note),
        ),
      )
      .join("\n\n"),
  );
}

function formatResolveApproval(result: ResolveApprovalResult, resolution: "approved" | "denied"): string {
  const execution =
    result.execution_result === null || result.execution_result === undefined
      ? null
      : `${result.execution_result.mode} ${result.execution_result.success ? "successfully" : "with errors"} (${result.execution_result.execution_id})`;
  const snapshot =
    result.snapshot_record === null || result.snapshot_record === undefined
      ? null
      : `${result.snapshot_record.snapshot_id} (${result.snapshot_record.fidelity})`;
  const artifactCapture =
    result.execution_result?.artifact_capture?.degraded === true
      ? `${result.execution_result.artifact_capture.stored_count}/${result.execution_result.artifact_capture.requested_count} stored; ${result.execution_result.artifact_capture.failures.length} capture failure(s)`
      : null;

  return lines(
    `Approval ${resolution}`,
    `Approval: ${result.approval_request.approval_id}`,
    `Run: ${result.approval_request.run_id}`,
    `Action: ${result.approval_request.action_id}`,
    `Status: ${result.approval_request.status}`,
    `Requested: ${result.approval_request.requested_at}`,
    `Resolved: ${formatTimestamp(result.approval_request.resolved_at)}`,
    maybeLine("Primary reason", formatReasonDetail(result.approval_request.primary_reason)),
    maybeLine("Resolution note", result.approval_request.resolution_note),
    maybeLine("Snapshot", snapshot),
    maybeLine("Execution", execution),
    maybeLine("Artifact capture", artifactCapture),
  );
}

export function formatHelper(result: HelperResult, questionType: HelperQuestionType): string {
  const evidence =
    result.evidence.length === 0
      ? "none"
      : `\n${bulletList(result.evidence.map((item: HelperEvidence) => `#${item.sequence} ${item.title} (${item.step_id})`))}`;
  const uncertainty = result.uncertainty.length === 0 ? "none" : `\n${bulletList(result.uncertainty)}`;
  const primaryReason = formatReasonDetail(result.primary_reason);

  return lines(
    `Helper answer for ${questionType}`,
    `Confidence: ${formatConfidence(result.confidence)}`,
    `Visibility: ${result.visibility_scope}`,
    `Redactions applied: ${result.redactions_applied}`,
    formatPreviewBudget(result),
    maybeLine("Primary reason", primaryReason),
    "",
    result.answer,
    "",
    `Evidence:${evidence}`,
    `Uncertainty:${uncertainty}`,
  );
}

export function formatRecoveryPlan(plan: RecoveryPlan): string {
  const targetLabel =
    plan.target.type === "snapshot_id"
      ? `Target snapshot: ${plan.target.snapshot_id}`
      : plan.target.type === "action_boundary"
        ? `Target action: ${plan.target.action_id}`
        : plan.target.type === "external_object"
          ? `Target external object: ${plan.target.external_object_id}`
          : plan.target.type === "run_checkpoint"
            ? `Target run checkpoint: ${plan.target.run_checkpoint}`
            : plan.target.type === "branch_point"
              ? `Target branch point: ${plan.target.run_id}#${plan.target.sequence}`
              : `Target subset: ${plan.target.snapshot_id} @ ${plan.target.paths.join(", ")}`;
  const steps =
    plan.steps.length === 0
      ? "none"
      : `\n${plan.steps
          .map((step: RecoveryPlanStep, index: number) =>
            lines(
              `${index + 1}. ${step.type} (${step.step_id})`,
              `   Idempotent: ${step.idempotent ? "yes" : "no"}`,
              `   Depends on: ${step.depends_on.length > 0 ? step.depends_on.join(", ") : "none"}`,
            ),
          )
          .join("\n")}`;
  const pathsToChange =
    typeof plan.impact_preview.paths_to_change === "number" ? String(plan.impact_preview.paths_to_change) : "unknown";
  const overlappingPaths =
    plan.impact_preview.overlapping_paths.length > 0 ? plan.impact_preview.overlapping_paths.join(", ") : "none";
  const warnings =
    plan.warnings.length === 0
      ? "none"
      : `\n${bulletList(plan.warnings.map((warning) => `${warning.code}: ${warning.message}`))}`;
  const reviewGuidance = !plan.review_guidance
    ? null
    : lines(
        `Systems touched: ${joinOrNone(plan.review_guidance.systems_touched)}`,
        `Objects touched: ${joinOrNone(plan.review_guidance.objects_touched)}`,
        `Manual steps: ${
          plan.review_guidance.manual_steps.length > 0 ? `\n${bulletList(plan.review_guidance.manual_steps)}` : "none"
        }`,
        `Uncertainty: ${
          plan.review_guidance.uncertainty.length > 0 ? `\n${bulletList(plan.review_guidance.uncertainty)}` : "none"
        }`,
      );
  const downgradeReason = plan.downgrade_reason
    ? `${plan.downgrade_reason.code}: ${plan.downgrade_reason.message}`
    : null;

  return lines(
    `Recovery plan ${plan.recovery_plan_id}`,
    targetLabel,
    `Class: ${plan.recovery_class}`,
    `Strategy: ${plan.strategy}`,
    `Confidence: ${formatConfidence(plan.confidence)}`,
    `Created: ${plan.created_at}`,
    maybeLine("Downgrade reason", downgradeReason),
    `Paths to change: ${pathsToChange}`,
    `Later actions affected: ${plan.impact_preview.later_actions_affected}`,
    `Overlapping paths: ${overlappingPaths}`,
    `Data loss risk: ${plan.impact_preview.data_loss_risk}`,
    `External effects: ${plan.impact_preview.external_effects.length > 0 ? plan.impact_preview.external_effects.join(", ") : "none"}`,
    `Warnings:${warnings}`,
    reviewGuidance ? `Review guidance:\n${indentBlock(reviewGuidance, 2)}` : null,
    `Steps:${steps}`,
  );
}

function versionResult(): VersionResult {
  return {
    cli_version: CLI_VERSION,
    supported_api_version: API_VERSION,
    json_contract_version: CLI_JSON_CONTRACT_VERSION,
    exit_code_registry_version: CLI_EXIT_CODE_REGISTRY_VERSION,
    config_schema_version: CLI_CONFIG_SCHEMA_VERSION,
  };
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

function shiftCommandValue(args: string[], flag: string): string {
  const value = args.shift();
  if (!value || value.startsWith("--")) {
    throw inputError(`${flag} requires a value.`, {
      flag,
    });
  }

  return value;
}

function parseIntegerFlag(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw inputError(`${flag} expects a non-negative integer.`, {
      flag,
      value,
    });
  }

  return parsed;
}

async function buildDoctorResult(client: AuthorityClient, resolvedConfig: CliResolvedConfig): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const recommendations: string[] = [];
  const workspaceExists = fs.existsSync(resolvedConfig.workspace_root.value);
  checks.push({
    code: "WORKSPACE_ROOT",
    status: workspaceExists ? "pass" : "fail",
    summary: workspaceExists ? "Workspace root exists." : "Workspace root does not exist.",
    details: {
      workspace_root: resolvedConfig.workspace_root.value,
      source: resolvedConfig.workspace_root.source,
    },
  });

  let daemonReachable = false;
  let sessionId: string | null = null;
  let acceptedApiVersion: string | null = null;
  let runtimeVersion: string | null = null;
  let schemaPackVersion: string | null = null;
  let securityPostureStatus: DoctorResult["security_posture_status"] = "unknown";

  try {
    const hello = await client.hello([resolvedConfig.workspace_root.value]);
    daemonReachable = true;
    sessionId = hello.session_id;
    acceptedApiVersion = hello.accepted_api_version;
    runtimeVersion = hello.runtime_version;
    schemaPackVersion = hello.schema_pack_version;
    checks.push({
      code: "DAEMON_REACHABLE",
      status: "pass",
      summary: "Authority daemon handshake succeeded.",
      details: {
        session_id: hello.session_id,
        accepted_api_version: hello.accepted_api_version,
        runtime_version: hello.runtime_version,
        schema_pack_version: hello.schema_pack_version,
      },
    });

    const capabilities = await client.getCapabilities(resolvedConfig.workspace_root.value);
    const credentialMode = capabilities.capabilities.find(
      (capability) => capability.capability_name === "host.credential_broker_mode",
    );
    checks.push({
      code: "CAPABILITIES",
      status: capabilities.degraded_mode_warnings.length > 0 ? "warn" : "pass",
      summary:
        capabilities.degraded_mode_warnings.length > 0
          ? `${capabilities.degraded_mode_warnings.length} degraded capability warning(s) detected.`
          : "Capability surface is healthy.",
      details: {
        warnings: capabilities.degraded_mode_warnings,
      },
    });
    checks.push({
      code: "SECRET_STORAGE_MODE",
      status: credentialMode?.status === "available" ? "pass" : credentialMode?.status === "degraded" ? "warn" : "fail",
      summary:
        credentialMode && typeof credentialMode.details.mode === "string"
          ? `Credential broker mode: ${credentialMode.details.mode}${
              typeof credentialMode.details.key_provider === "string"
                ? ` via ${credentialMode.details.key_provider}`
                : ""
            }.`
          : "Credential broker mode is unavailable.",
      details: credentialMode?.details as Record<string, unknown> | undefined,
    });

    const [servers, secrets, policies, diagnostics] = await Promise.all([
      client.listMcpServers(),
      client.listMcpSecrets(),
      client.listMcpHostPolicies(),
      client.diagnostics(["security_posture", "hosted_worker", "hosted_queue"]),
    ]);
    checks.push({
      code: "MCP_REGISTRY",
      status: "pass",
      summary: `MCP registry contains ${servers.servers.length} server(s), ${secrets.secrets.length} secret(s), and ${policies.policies.length} host policy item(s).`,
      details: {
        servers: servers.servers.length,
        secrets: secrets.secrets.length,
        host_policies: policies.policies.length,
      },
    });

    if (diagnostics.security_posture) {
      const posture = diagnostics.security_posture;
      securityPostureStatus = posture.status;
      checks.push({
        code: "SECURITY_POSTURE",
        status: posture.status === "healthy" ? "pass" : "warn",
        summary:
          posture.status === "healthy"
            ? `Security posture is production-ready on this host (${posture.stdio_sandbox.current_host_mode}).`
            : `${posture.primary_reason?.message ?? "Security posture is degraded on this host."} Host mode: ${posture.stdio_sandbox.current_host_mode}.`,
        details: {
          primary_reason: posture.primary_reason,
          warnings: posture.warnings,
          current_host_mode: posture.stdio_sandbox.current_host_mode,
          current_host_mode_reason: posture.stdio_sandbox.current_host_mode_reason,
        },
      });

      if (posture.secret_storage.provider === null) {
        recommendations.push("Configure an OS-backed secret provider before treating this daemon as production-ready.");
      }
      if (posture.secret_storage.legacy_key_path) {
        recommendations.push(
          `Remove the legacy local key file once migration is confirmed: ${posture.secret_storage.legacy_key_path}`,
        );
      }
      if (
        posture.stdio_sandbox.registered_server_count > 0 &&
        posture.stdio_sandbox.production_ready_server_count < posture.stdio_sandbox.registered_server_count
      ) {
        recommendations.push(
          posture.stdio_sandbox.docker_runtime_usable || posture.stdio_sandbox.podman_runtime_usable
            ? "Set all stdio MCP servers to the `oci_container` sandbox. That is the required production path on Linux, macOS, and Windows."
            : "Install Docker or Podman and re-register stdio MCP servers with `oci_container`; governed stdio execution now requires an OCI sandbox.",
        );
      }
      if (posture.stdio_sandbox.fallback_server_count > 0) {
        recommendations.push(
          `Remove ${posture.stdio_sandbox.fallback_server_count} legacy stdio MCP server registration(s) that still report fallback-only posture; OCI is the only supported governed sandbox path.`,
        );
      }
      if (posture.stdio_sandbox.mutable_tag_server_count > 0) {
        recommendations.push(
          `Replace mutable-tag OCI images for ${posture.stdio_sandbox.mutable_tag_server_count} stdio MCP server(s) with sha256-pinned refs; new governed registrations now reject mutable tags unless oci_container.build is configured for local development.`,
        );
      }
      if (posture.stdio_sandbox.local_build_server_count > 0) {
        recommendations.push(
          `Move ${posture.stdio_sandbox.local_build_server_count} stdio MCP server(s) off oci_container.build before production rollout; local OCI builds are a development path, not a release supply-chain policy.`,
        );
      }
      if (posture.stdio_sandbox.registry_policy_server_count < posture.stdio_sandbox.digest_pinned_server_count) {
        recommendations.push(
          "Add allowed_registries coverage for every remote OCI stdio MCP image so the configured registry trust boundary is explicit.",
        );
      }
      if (
        posture.stdio_sandbox.signature_verification_server_count < posture.stdio_sandbox.digest_pinned_server_count
      ) {
        recommendations.push(
          "Configure cosign-based signature_verification for every remote OCI stdio MCP image; digest pinning alone is not the full production trust bar.",
        );
      }
      if (
        posture.stdio_sandbox.provenance_attestation_server_count <
        posture.stdio_sandbox.signature_verification_server_count
      ) {
        recommendations.push(
          "Require SLSA provenance attestations for OCI stdio MCP images so production trust covers provenance as well as signatures.",
        );
      }
      recommendations.push(
        "For local development, prefer `oci_container` with a `build` config so developers can build from source locally while staying on the same OCI boundary used in production.",
      );
      if (posture.stdio_sandbox.unconfigured_server_count > 0) {
        recommendations.push(
          `Add explicit sandbox configuration for ${posture.stdio_sandbox.unconfigured_server_count} stdio MCP server(s); the runtime now fails closed when sandbox config is missing.`,
        );
      }
      if (posture.streamable_http.legacy_bearer_env_servers.length > 0) {
        recommendations.push(
          `Move ${posture.streamable_http.legacy_bearer_env_servers.length} streamable_http server(s) from bearer env vars to brokered secret refs.`,
        );
      }
      if (posture.streamable_http.missing_secret_ref_servers.length > 0) {
        recommendations.push(
          `Bind managed secrets for ${posture.streamable_http.missing_secret_ref_servers.length} streamable_http server(s) before production use.`,
        );
      }
      if (posture.streamable_http.missing_public_host_policy_servers.length > 0) {
        recommendations.push(
          `Add explicit public host policies for ${posture.streamable_http.missing_public_host_policy_servers.length} streamable_http server(s) so runtime host validation stays fail-closed.`,
        );
      }
      if (recommendations.length === 0) {
        recommendations.push(
          "Keep OCI sandboxing as the default production stdio path, and use GitHub Actions only to validate that the host protections stay intact across releases.",
        );
      }
      recommendations.push(`Windows plan: ${posture.stdio_sandbox.windows_plan.summary}`);
    }

    if (diagnostics.hosted_worker) {
      const hostedWorker = diagnostics.hosted_worker;
      checks.push({
        code: "HOSTED_WORKER",
        status: hostedWorker.status === "healthy" ? "pass" : "warn",
        summary:
          hostedWorker.status === "healthy"
            ? `Hosted MCP worker is reachable at ${hostedWorker.endpoint}.`
            : (hostedWorker.primary_reason?.message ?? "Hosted MCP worker is degraded."),
        details: {
          endpoint: hostedWorker.endpoint,
          endpoint_kind: hostedWorker.endpoint_kind,
          managed_by_daemon: hostedWorker.managed_by_daemon,
          runtime_id: hostedWorker.runtime_id,
          image_digest: hostedWorker.image_digest,
          warnings: hostedWorker.warnings,
        },
      });

      if (!hostedWorker.reachable) {
        recommendations.push(
          hostedWorker.managed_by_daemon
            ? "Fix hosted worker startup before relying on hosted delegated MCP execution; queued jobs cannot drain while the managed worker is unreachable."
            : "Start or repair the external hosted MCP worker before relying on hosted delegated MCP execution.",
        );
      }
    }

    if (diagnostics.hosted_queue) {
      const hostedQueue = diagnostics.hosted_queue;
      checks.push({
        code: "HOSTED_QUEUE",
        status: hostedQueue.status === "healthy" ? "pass" : "warn",
        summary:
          hostedQueue.status === "healthy"
            ? `Hosted MCP queue is healthy (${hostedQueue.queued_jobs} queued, ${hostedQueue.running_jobs} running).`
            : (hostedQueue.primary_reason?.message ?? "Hosted MCP queue is degraded."),
        details: {
          queued_jobs: hostedQueue.queued_jobs,
          running_jobs: hostedQueue.running_jobs,
          failed_jobs: hostedQueue.failed_jobs,
          retryable_failed_jobs: hostedQueue.retryable_failed_jobs,
          active_server_profiles: hostedQueue.active_server_profiles,
          warnings: hostedQueue.warnings,
        },
      });

      if (hostedQueue.failed_jobs > 0) {
        recommendations.push(
          `Inspect failed hosted MCP jobs with \`list-hosted-mcp-jobs\` or \`show-hosted-mcp-job\`, then recover them with \`requeue-hosted-mcp-job\` once the underlying worker or endpoint issue is fixed.`,
        );
      }
    }
  } catch (error) {
    const cliError = toCliError(error);
    checks.push({
      code: "DAEMON_REACHABLE",
      status: "fail",
      summary: cliError.message,
      details: {
        error_code: cliError.code,
        exit_code: cliError.exitCode,
      },
    });
    recommendations.push(
      "Fix daemon reachability first; runtime security checks cannot be verified until the daemon is reachable.",
    );
  }

  return {
    cli_version: CLI_VERSION,
    config: {
      config_root: resolvedConfig.paths.configRoot,
      user_config_path: resolvedConfig.paths.userConfigPath,
      workspace_config_path: resolvedConfig.paths.workspaceConfigPath,
      active_profile: resolvedConfig.active_profile,
      workspace_root: resolvedConfig.workspace_root.value,
      socket_path: resolvedConfig.socket_path.value,
    },
    daemon: {
      reachable: daemonReachable,
      session_id: sessionId,
      accepted_api_version: acceptedApiVersion,
      runtime_version: runtimeVersion,
      schema_pack_version: schemaPackVersion,
    },
    security_posture_status: securityPostureStatus,
    checks,
    recommendations,
  };
}

function formatPlanRecovery(result: PlanRecoveryResult): string {
  return formatRecoveryPlan(result.recovery_plan);
}

function formatExecuteRecovery(result: ExecuteRecoveryResult): string {
  return lines(
    `Recovery ${result.outcome === "compensated" ? "completed via compensation" : result.restored ? "completed" : "planned but not restored"}`,
    `Executed at: ${result.executed_at}`,
    `Outcome: ${result.outcome}`,
    "",
    formatRecoveryPlan(result.recovery_plan),
  );
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
      printResult(versionResult(), jsonOutput, formatVersion);
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
      const result = await buildDoctorResult(client, resolvedConfig);
      printResult(result, jsonOutput, formatDoctor);
      if (result.checks.some((check) => check.status === "fail")) {
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
        const result = renderThresholdPatch(recommendations, directionFilter);
        printResult(result, jsonOutput, formatPolicyThresholdPatch);
        return;
      }

      throw usageError(
        "Usage: agentgit-authority [global-flags] policy <show|validate <path>|diff <path>|explain <attempt-json-or-path>|calibration-report [--run-id <run-id>] [--include-samples] [--sample-limit <n>]|recommend-thresholds [--run-id <run-id>] [--min-samples <n>]|render-threshold-patch [--run-id <run-id>] [--min-samples <n>] [--direction <tighten|relax|all>]>",
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

      const result = await client.queryArtifact(artifactId, visibilityScope, {
        fullContent: true,
      });

      if (!result.content_available) {
        throw ioError(`Artifact ${artifactId} content is not available for export (${result.artifact_status}).`);
      }

      if (result.content_truncated) {
        throw ioError(`Artifact ${artifactId} export returned truncated content; export aborted.`);
      }

      const resolvedDestinationPath = path.isAbsolute(destinationPath)
        ? destinationPath
        : path.resolve(workspaceRoot, destinationPath);
      if (fs.existsSync(resolvedDestinationPath)) {
        throw ioError(`artifact-export refuses to overwrite existing file: ${resolvedDestinationPath}`);
      }

      fs.mkdirSync(path.dirname(resolvedDestinationPath), { recursive: true });
      fs.writeFileSync(resolvedDestinationPath, result.content, "utf8");

      printResult(
        {
          artifact_id: artifactId,
          output_path: resolvedDestinationPath,
          bytes_written: Buffer.byteLength(result.content, "utf8"),
          visibility_scope: result.visibility_scope,
          artifact_status: result.artifact_status,
          integrity_digest: result.artifact.integrity.digest,
        } satisfies ArtifactExportResult,
        jsonOutput,
        formatArtifactExport,
      );
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
      const result = await exportRunAuditBundle(client, runId, resolvedOutputDir, visibilityScope);
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
