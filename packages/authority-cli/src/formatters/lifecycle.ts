import type { AuthorityDaemonListeningSummary } from "@agentgit/authority-daemon";
import { API_VERSION } from "@agentgit/schemas";

import {
  CLI_CONFIG_SCHEMA_VERSION,
  CLI_EXIT_CODE_REGISTRY_VERSION,
  CLI_JSON_CONTRACT_VERSION,
} from "../cli-contract.js";
import type { CliConfigValidationResult } from "../cli-config.js";
import { bulletList, indentBlock, joinOrNone, lines, maybeLine } from "./core.js";
import type {
  CloudRoadmapResult,
  ConfigShowResult,
  DoctorResult,
  HelloResult,
  InitCommandResult,
  ProfileListResult,
  RegisterRunResult,
  SetupCommandResult,
  TrustReportResult,
  VersionResult,
} from "../commands/lifecycle-types.js";

export function versionResult(cliVersion: string): VersionResult {
  return {
    cli_version: cliVersion,
    supported_api_version: API_VERSION,
    json_contract_version: CLI_JSON_CONTRACT_VERSION,
    exit_code_registry_version: CLI_EXIT_CODE_REGISTRY_VERSION,
    config_schema_version: CLI_CONFIG_SCHEMA_VERSION,
  };
}

export function formatVersion(result: VersionResult): string {
  return lines(
    `agentgit-authority ${result.cli_version}`,
    `Supported API version: ${result.supported_api_version}`,
    `JSON contract: ${result.json_contract_version}`,
    `Exit code registry: ${result.exit_code_registry_version}`,
    `Config schema: ${result.config_schema_version}`,
  );
}

export function formatHello(result: HelloResult): string {
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

export function formatConfigShow(result: ConfigShowResult): string {
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

export function formatConfigValidation(result: CliConfigValidationResult): string {
  return lines(
    "CLI config validation",
    `Valid: ${result.valid ? "yes" : "no"}`,
    `Config root: ${result.paths.configRoot}`,
    `User config: ${result.paths.userConfigPath}${result.user_config_exists ? "" : " (not present)"}`,
    `Workspace config: ${result.paths.workspaceConfigPath}${result.workspace_config_exists ? "" : " (not present)"}`,
    result.issues.length === 0 ? "Issues: none" : `Issues:\n${bulletList(result.issues)}`,
  );
}

export function formatProfileList(result: ProfileListResult): string {
  const profileLines =
    result.profiles.length === 0
      ? "No CLI profiles are configured."
      : result.profiles
          .map((profile) => `${profile.name} [${profile.source}]${profile.active ? " (active)" : ""}`)
          .join("\n");

  return lines("CLI profiles", `Active profile: ${result.active_profile ?? "none"}`, profileLines);
}

export function formatDoctor(result: DoctorResult): string {
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

export function formatInitResult(result: InitCommandResult): string {
  return lines(
    `Initialized ${result.mode} profile ${result.profile_name}`,
    `Config path: ${result.config_path}`,
    `Profile created: ${result.profile_created ? "yes" : "no"}`,
    `Profile overwritten: ${result.profile_overwritten ? "yes" : "no"}`,
    `Readiness passed: ${result.readiness_passed ? "yes" : "no"}`,
    "",
    formatDoctor(result.doctor),
  );
}

export function formatSetupResult(result: SetupCommandResult): string {
  const createdDirectories =
    result.created_directories.length === 0 ? "none" : `\n${bulletList(result.created_directories)}`;
  return lines(
    "CLI setup complete",
    `Profile: ${result.profile_name}`,
    `Config path: ${result.config_path}`,
    `Profile created: ${result.profile_created ? "yes" : "no"}`,
    `Profile overwritten: ${result.profile_overwritten ? "yes" : "no"}`,
    `Workspace root: ${result.workspace_root}`,
    `Socket path: ${result.socket_path}`,
    `Created directories:${createdDirectories}`,
    `Next step: ${result.daemon_start_command}`,
    `Health check: ${result.doctor_command}`,
  );
}

export function formatDaemonStart(result: AuthorityDaemonListeningSummary): string {
  return lines(
    "Authority daemon listening",
    `Socket path: ${result.socket_path}`,
    `Journal path: ${result.journal_path}`,
    `Snapshot root: ${result.snapshot_root_path}`,
    `MCP registry path: ${result.mcp_registry_path}`,
    `MCP secret store path: ${result.mcp_secret_store_path}`,
    `MCP host policy path: ${result.mcp_host_policy_path}`,
    `Hosted worker endpoint: ${result.mcp_hosted_worker_endpoint}`,
    `Policy workspace config: ${result.policy_workspace_config_path}`,
  );
}

export function formatTrustReport(result: TrustReportResult): string {
  const timelineSummary = result.timeline_trust
    ? lines(
        `Run id: ${result.timeline_trust.run_id}`,
        `Visibility: ${result.timeline_trust.visibility_scope}`,
        `Timeline steps: ${result.timeline_trust.step_count}`,
        `Non-governed steps: ${result.timeline_trust.trust_summary.nonGoverned}`,
        `Imported: ${result.timeline_trust.trust_summary.imported}`,
        `Observed: ${result.timeline_trust.trust_summary.observed}`,
        `Unknown: ${result.timeline_trust.trust_summary.unknown}`,
      )
    : "none";
  return lines(
    "Trust report",
    `Generated: ${result.generated_at}`,
    `Workspace root: ${result.workspace_root}`,
    `Daemon reachable: ${result.daemon.reachable ? "yes" : "no"}`,
    maybeLine("Session", result.daemon.session_id),
    `Security posture: ${result.security_posture_status}`,
    `MCP profiles: ${result.mcp.profile_count}`,
    `MCP active profiles: ${result.mcp.active_profile_count}`,
    `MCP pending profiles: ${result.mcp.pending_profile_count}`,
    `MCP quarantined profiles: ${result.mcp.quarantined_profile_count}`,
    `MCP revoked profiles: ${result.mcp.revoked_profile_count}`,
    `MCP profiles missing trust decision: ${result.mcp.profiles_without_active_trust_decision}`,
    `MCP profiles requiring credentials: ${result.mcp.profiles_requiring_credentials}`,
    `MCP profiles missing credentials: ${result.mcp.profiles_missing_credentials}`,
    `Active non-deny trust decisions: ${result.mcp.active_non_deny_trust_decision_count}`,
    `Active credential bindings: ${result.mcp.active_credential_binding_count}`,
    `Timeline trust summary:\n${indentBlock(timelineSummary, 2)}`,
    result.recommendations.length === 0
      ? "Recommendations: none"
      : `Recommendations:\n${bulletList(result.recommendations)}`,
  );
}

export function cloudRoadmapResult(): CloudRoadmapResult {
  return {
    generated_at: new Date().toISOString(),
    launch_contract: "local-first-mvp",
    mvp_scope_exclusions: [
      "Hosted MCP execution control plane",
      "Durable hosted worker orchestration",
      "Browser/computer governance",
      "Generic governed HTTP adapter",
      "Cloud-owned journal or snapshot truth",
    ],
    phases: [
      {
        phase_id: "cloud-1",
        title: "Hosted MCP Worker Reliability",
        status: "deferred",
        target_window: "post-mvp + 0-2 quarters",
        deliverables: [
          "Harden hosted worker control plane and queue lease semantics.",
          "Add dead-letter replay guardrails and operator replay workflows.",
          "Ship hosted worker disaster-recovery runbooks and game days.",
        ],
        entry_criteria: [
          "Local-first MVP adoption and support load are stable.",
          "Signed artifact and provenance requirements are enforced in hosted images.",
        ],
      },
      {
        phase_id: "cloud-2",
        title: "Hosted Trust And Credential Brokering",
        status: "deferred",
        target_window: "post-mvp + 2-4 quarters",
        deliverables: [
          "Promote profile onboarding and trust review into hosted control workflows.",
          "Add brokered token exchange for hosted delegated execution.",
          "Ship tenant isolation and hosted audit narrative exports.",
        ],
        entry_criteria: [
          "Hosted worker reliability phase is complete with SLOs.",
          "Credential broker has rotation and revocation evidence hooks.",
        ],
      },
      {
        phase_id: "cloud-3",
        title: "Extended Governance Surfaces",
        status: "deferred",
        target_window: "post-mvp + 4+ quarters",
        deliverables: [
          "Browser/computer governance with deterministic policy mapping.",
          "Generic HTTP governance adapter with fail-closed semantics.",
          "Cross-workspace policy packs and organization-level trust narratives.",
        ],
        entry_criteria: [
          "Cloud phases 1 and 2 are production-stable.",
          "Operator runbooks and audit artifacts cover the hosted boundary.",
        ],
      },
    ],
  };
}

export function formatCloudRoadmapResult(result: CloudRoadmapResult): string {
  const phaseLines =
    result.phases.length === 0
      ? "none"
      : result.phases
          .map((phase) =>
            lines(
              `- ${phase.phase_id}: ${phase.title} [${phase.status}]`,
              `  Target window: ${phase.target_window}`,
              `  Deliverables:\n${bulletList(phase.deliverables, "    ")}`,
              `  Entry criteria:\n${bulletList(phase.entry_criteria, "    ")}`,
            ),
          )
          .join("\n\n");

  return lines(
    "Cloud roadmap",
    `Generated: ${result.generated_at}`,
    `Launch contract: ${result.launch_contract}`,
    `MVP scope exclusions:\n${bulletList(result.mvp_scope_exclusions)}`,
    `Deferred phases:\n${phaseLines}`,
  );
}

export function formatRegisterRun(result: RegisterRunResult): string {
  return lines(
    `Registered run ${result.run_id}`,
    `Workflow: ${result.run_handle.workflow_name}`,
    `Session: ${result.run_handle.session_id}`,
    `Effective policy profile: ${result.effective_policy_profile}`,
  );
}
