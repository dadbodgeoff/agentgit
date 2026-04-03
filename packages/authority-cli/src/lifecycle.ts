import fs from "node:fs";
import path from "node:path";

import type { AuthorityDaemonListeningSummary } from "@agentgit/authority-daemon";
import { AuthorityClient } from "@agentgit/authority-sdk";
import { API_VERSION } from "@agentgit/schemas";

import {
  CLI_CONFIG_SCHEMA_VERSION,
  CLI_EXIT_CODE_REGISTRY_VERSION,
  CLI_JSON_CONTRACT_VERSION,
  inputError,
  toCliError,
  usageError,
} from "./cli-contract.js";
import {
  type CliConfigValidationResult,
  type CliProfileRecord,
  type CliResolvedConfig,
  listProfileNames,
  readUserConfig,
  setActiveUserProfile,
  upsertUserProfile,
  writeUserConfig,
} from "./cli-config.js";
import { bulletList, indentBlock, joinOrNone, lines, maybeLine } from "./formatters/core.js";
import { parseVisibilityScopeArg, shiftCommandValue } from "./parsers/common.js";

type HelloResult = Awaited<ReturnType<AuthorityClient["hello"]>>;
type RegisterRunResult = Awaited<ReturnType<AuthorityClient["registerRun"]>>;
type TimelineResult = Awaited<ReturnType<AuthorityClient["queryTimeline"]>>;
type ListMcpServerProfilesResult = Awaited<ReturnType<AuthorityClient["listMcpServerProfiles"]>>;
type ListMcpServerTrustDecisionsResult = Awaited<ReturnType<AuthorityClient["listMcpServerTrustDecisions"]>>;
type ListMcpServerCredentialBindingsResult = Awaited<
  ReturnType<AuthorityClient["listMcpServerCredentialBindings"]>
>;
type DiagnosticsResult = Awaited<ReturnType<AuthorityClient["diagnostics"]>>;

export interface VersionResult {
  cli_version: string;
  supported_api_version: string;
  json_contract_version: string;
  exit_code_registry_version: string;
  config_schema_version: string;
}

export interface ConfigShowResult {
  resolved: CliResolvedConfig;
}

export interface ProfileListResult {
  active_profile: string | null;
  profiles: Array<{
    name: string;
    source: "user" | "workspace" | "both";
    active: boolean;
  }>;
}

export interface DoctorCheck {
  code: string;
  status: "pass" | "warn" | "fail";
  summary: string;
  details?: Record<string, unknown>;
}

export interface DoctorResult {
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

export interface InitCommandResult {
  mode: "production";
  profile_name: string;
  config_path: string;
  profile_created: boolean;
  profile_overwritten: boolean;
  readiness_passed: boolean;
  doctor: DoctorResult;
}

export interface SetupCommandResult {
  mode: "local";
  profile_name: string;
  config_path: string;
  profile_created: boolean;
  profile_overwritten: boolean;
  created_directories: string[];
  workspace_root: string;
  socket_path: string;
  daemon_start_command: string;
  doctor_command: string;
}

interface TimelineTrustSummary {
  nonGoverned: number;
  imported: number;
  observed: number;
  unknown: number;
}

export interface TrustReportResult {
  generated_at: string;
  workspace_root: string;
  daemon: DoctorResult["daemon"];
  security_posture_status: DoctorResult["security_posture_status"];
  mcp: {
    profile_count: number;
    active_profile_count: number;
    pending_profile_count: number;
    quarantined_profile_count: number;
    revoked_profile_count: number;
    profiles_without_active_trust_decision: number;
    profiles_requiring_credentials: number;
    profiles_missing_credentials: number;
    active_non_deny_trust_decision_count: number;
    active_credential_binding_count: number;
  };
  timeline_trust: null | {
    run_id: string;
    visibility_scope: TimelineResult["visibility_scope"];
    step_count: number;
    trust_summary: TimelineTrustSummary;
  };
  recommendations: string[];
}

export interface CloudRoadmapResult {
  generated_at: string;
  launch_contract: "local-first-mvp";
  mvp_scope_exclusions: string[];
  phases: Array<{
    phase_id: string;
    title: string;
    status: "deferred";
    target_window: string;
    deliverables: string[];
    entry_criteria: string[];
  }>;
}

async function loadAuthorityDaemonModule(): Promise<typeof import("@agentgit/authority-daemon")> {
  return await import("@agentgit/authority-daemon");
}

function summarizeTimelineTrust(steps: TimelineResult["steps"]): TimelineTrustSummary {
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

export function parseInitCommandOptions(args: string[]): {
  profileName: string;
  force: boolean;
} {
  let productionMode = false;
  let profileName = "production";
  let force = false;
  const rest = [...args];

  while (rest.length > 0) {
    const current = rest.shift()!;
    switch (current) {
      case "--production":
        productionMode = true;
        break;
      case "--profile-name":
        profileName = shiftCommandValue(rest, "--profile-name");
        break;
      case "--force":
        force = true;
        break;
      default:
        throw inputError(`Unknown init flag: ${current}`, {
          flag: current,
        });
    }
  }

  if (!productionMode) {
    throw usageError("Usage: agentgit-authority [global-flags] init --production [--profile-name <name>] [--force]");
  }

  return {
    profileName,
    force,
  };
}

export function parseSetupCommandOptions(args: string[]): {
  profileName: string;
  force: boolean;
} {
  let profileName = "local";
  let force = false;
  const rest = [...args];

  while (rest.length > 0) {
    const current = rest.shift()!;
    switch (current) {
      case "--profile-name":
        profileName = shiftCommandValue(rest, "--profile-name");
        break;
      case "--force":
        force = true;
        break;
      default:
        throw inputError(`Unknown setup flag: ${current}`, {
          flag: current,
        });
    }
  }

  return {
    profileName,
    force,
  };
}

export function parseTrustReportOptions(args: string[]): {
  runId?: string;
  visibilityScope: TimelineResult["visibility_scope"];
} {
  let runId: string | undefined;
  let visibilityScope: TimelineResult["visibility_scope"] = "user";
  const rest = [...args];

  while (rest.length > 0) {
    const current = rest.shift()!;
    switch (current) {
      case "--run-id":
        runId = shiftCommandValue(rest, "--run-id");
        break;
      case "--visibility": {
        const parsed = shiftCommandValue(rest, "--visibility");
        const scope = parseVisibilityScopeArg(parsed);
        if (!scope) {
          throw inputError("--visibility expects one of user, model, internal, or sensitive_internal.", {
            flag: "--visibility",
            value: parsed,
          });
        }
        visibilityScope = scope;
        break;
      }
      default:
        throw inputError(`Unknown trust-report flag: ${current}`, {
          flag: current,
        });
    }
  }

  return {
    runId,
    visibilityScope,
  };
}

export async function buildDoctorResult(
  client: AuthorityClient,
  resolvedConfig: CliResolvedConfig,
  cliVersion: string,
): Promise<DoctorResult> {
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
          "Inspect failed hosted MCP jobs with `list-hosted-mcp-jobs` or `show-hosted-mcp-job`, then recover them with `requeue-hosted-mcp-job` once the underlying worker or endpoint issue is fixed.",
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
    cli_version: cliVersion,
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

export async function runInitProductionCommand(
  client: AuthorityClient,
  resolvedConfig: CliResolvedConfig,
  options: {
    profileName: string;
    force: boolean;
  },
  cliVersion: string,
): Promise<InitCommandResult> {
  const userConfig = readUserConfig(resolvedConfig.paths.configRoot, process.cwd(), process.env);
  const existingProfile = userConfig.config.profiles?.[options.profileName];
  if (existingProfile && !options.force) {
    throw inputError(
      `Profile ${options.profileName} already exists in ${userConfig.path}. Re-run with --force to overwrite it.`,
      {
        profile: options.profileName,
        config_path: userConfig.path,
      },
    );
  }

  const configured = upsertUserProfile(userConfig.config, options.profileName, {
    socket_path: resolvedConfig.socket_path.value,
    workspace_root: resolvedConfig.workspace_root.value,
    connect_timeout_ms: resolvedConfig.connect_timeout_ms.value,
    response_timeout_ms: resolvedConfig.response_timeout_ms.value,
    max_connect_retries: resolvedConfig.max_connect_retries.value,
    connect_retry_delay_ms: resolvedConfig.connect_retry_delay_ms.value,
  });
  const activated = setActiveUserProfile(configured, options.profileName);
  writeUserConfig(userConfig.path, activated);

  const doctor = await buildDoctorResult(client, resolvedConfig, cliVersion);
  return {
    mode: "production",
    profile_name: options.profileName,
    config_path: userConfig.path,
    profile_created: !existingProfile,
    profile_overwritten: Boolean(existingProfile),
    readiness_passed: doctor.checks.every((check) => check.status !== "fail"),
    doctor,
  };
}

function daemonStateLayout(workspaceRoot: string): {
  agentgitRoot: string;
  stateRoot: string;
  mcpRoot: string;
  journalPath: string;
  snapshotRootPath: string;
  mcpRegistryPath: string;
  mcpSecretStorePath: string;
  mcpSecretKeyPath: string;
  mcpHostPolicyPath: string;
  mcpConcurrencyLeasePath: string;
  mcpHostedWorkerEndpoint: string;
  mcpHostedWorkerAttestationKeyPath: string;
  policyWorkspaceConfigPath: string;
  policyCalibrationConfigPath: string;
} {
  const agentgitRoot = path.resolve(workspaceRoot, ".agentgit");
  const stateRoot = path.join(agentgitRoot, "state");
  const mcpRoot = path.join(stateRoot, "mcp");

  return {
    agentgitRoot,
    stateRoot,
    mcpRoot,
    journalPath: path.join(stateRoot, "authority.db"),
    snapshotRootPath: path.join(stateRoot, "snapshots"),
    mcpRegistryPath: path.join(mcpRoot, "registry.db"),
    mcpSecretStorePath: path.join(mcpRoot, "secret-store.db"),
    mcpSecretKeyPath: path.join(mcpRoot, "secret-store.key"),
    mcpHostPolicyPath: path.join(mcpRoot, "host-policies.db"),
    mcpConcurrencyLeasePath: path.join(mcpRoot, "concurrency-leases.db"),
    mcpHostedWorkerEndpoint: `unix:${path.join(mcpRoot, "hosted-worker.sock")}`,
    mcpHostedWorkerAttestationKeyPath: path.join(mcpRoot, "hosted-worker-attestation-key.json"),
    policyWorkspaceConfigPath: path.join(agentgitRoot, "policy.toml"),
    policyCalibrationConfigPath: path.join(agentgitRoot, "policy.calibration.generated.json"),
  };
}

function buildDaemonRuntimeEnvironment(
  resolvedConfig: CliResolvedConfig,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const workspaceRoot = resolvedConfig.workspace_root.value;
  const layout = daemonStateLayout(workspaceRoot);

  return {
    ...env,
    AGENTGIT_ROOT: workspaceRoot,
    INIT_CWD: workspaceRoot,
    AGENTGIT_SOCKET_PATH: resolvedConfig.socket_path.value,
    AGENTGIT_JOURNAL_PATH: env.AGENTGIT_JOURNAL_PATH?.trim() || layout.journalPath,
    AGENTGIT_SNAPSHOT_ROOT: env.AGENTGIT_SNAPSHOT_ROOT?.trim() || layout.snapshotRootPath,
    AGENTGIT_MCP_REGISTRY_PATH: env.AGENTGIT_MCP_REGISTRY_PATH?.trim() || layout.mcpRegistryPath,
    AGENTGIT_MCP_SECRET_STORE_PATH: env.AGENTGIT_MCP_SECRET_STORE_PATH?.trim() || layout.mcpSecretStorePath,
    AGENTGIT_MCP_SECRET_KEY_PATH: env.AGENTGIT_MCP_SECRET_KEY_PATH?.trim() || layout.mcpSecretKeyPath,
    AGENTGIT_MCP_HOST_POLICY_PATH: env.AGENTGIT_MCP_HOST_POLICY_PATH?.trim() || layout.mcpHostPolicyPath,
    AGENTGIT_MCP_CONCURRENCY_LEASE_PATH:
      env.AGENTGIT_MCP_CONCURRENCY_LEASE_PATH?.trim() || layout.mcpConcurrencyLeasePath,
    AGENTGIT_MCP_HOSTED_WORKER_ENDPOINT:
      env.AGENTGIT_MCP_HOSTED_WORKER_ENDPOINT?.trim() || layout.mcpHostedWorkerEndpoint,
    AGENTGIT_MCP_HOSTED_WORKER_ATTESTATION_KEY_PATH:
      env.AGENTGIT_MCP_HOSTED_WORKER_ATTESTATION_KEY_PATH?.trim() || layout.mcpHostedWorkerAttestationKeyPath,
    AGENTGIT_POLICY_WORKSPACE_CONFIG_PATH:
      env.AGENTGIT_POLICY_WORKSPACE_CONFIG_PATH?.trim() || layout.policyWorkspaceConfigPath,
    AGENTGIT_POLICY_CALIBRATION_CONFIG_PATH:
      env.AGENTGIT_POLICY_CALIBRATION_CONFIG_PATH?.trim() || layout.policyCalibrationConfigPath,
  };
}

function profileValuesEqual(left: CliProfileRecord | undefined, right: CliProfileRecord): boolean {
  return (
    (left?.socket_path ?? undefined) === right.socket_path &&
    (left?.workspace_root ?? undefined) === right.workspace_root &&
    (left?.connect_timeout_ms ?? undefined) === right.connect_timeout_ms &&
    (left?.response_timeout_ms ?? undefined) === right.response_timeout_ms &&
    (left?.max_connect_retries ?? undefined) === right.max_connect_retries &&
    (left?.connect_retry_delay_ms ?? undefined) === right.connect_retry_delay_ms
  );
}

function ensureSetupDirectories(daemonEnv: NodeJS.ProcessEnv, configRoot: string): string[] {
  const created = new Set<string>();

  const ensureDir = (value: string | undefined, kind: "dir" | "file" | "unix-endpoint" = "dir") => {
    if (!value) {
      return;
    }

    const target =
      kind === "dir"
        ? value
        : kind === "unix-endpoint"
          ? value.startsWith("unix:")
            ? path.dirname(value.slice("unix:".length))
            : null
          : path.dirname(value);
    if (!target) {
      return;
    }

    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
      created.add(target);
    }
  };

  ensureDir(configRoot);
  ensureDir(path.resolve(daemonEnv.AGENTGIT_ROOT ?? process.cwd(), ".agentgit"));
  ensureDir(daemonEnv.AGENTGIT_SOCKET_PATH, "file");
  ensureDir(daemonEnv.AGENTGIT_JOURNAL_PATH, "file");
  ensureDir(daemonEnv.AGENTGIT_SNAPSHOT_ROOT);
  ensureDir(daemonEnv.AGENTGIT_MCP_REGISTRY_PATH, "file");
  ensureDir(daemonEnv.AGENTGIT_MCP_SECRET_STORE_PATH, "file");
  ensureDir(daemonEnv.AGENTGIT_MCP_SECRET_KEY_PATH, "file");
  ensureDir(daemonEnv.AGENTGIT_MCP_HOST_POLICY_PATH, "file");
  ensureDir(daemonEnv.AGENTGIT_MCP_CONCURRENCY_LEASE_PATH, "file");
  ensureDir(daemonEnv.AGENTGIT_MCP_HOSTED_WORKER_ENDPOINT, "unix-endpoint");
  ensureDir(daemonEnv.AGENTGIT_MCP_HOSTED_WORKER_ATTESTATION_KEY_PATH, "file");
  ensureDir(daemonEnv.AGENTGIT_POLICY_WORKSPACE_CONFIG_PATH, "file");
  ensureDir(daemonEnv.AGENTGIT_POLICY_CALIBRATION_CONFIG_PATH, "file");
  ensureDir(daemonEnv.AGENTGIT_POLICY_GLOBAL_CONFIG_PATH, "file");

  return [...created].sort();
}

function setupCommandExample(configRoot: string, command: string): string {
  return `agentgit-authority --config-root ${JSON.stringify(configRoot)} ${command}`;
}

export function runSetupCommand(
  resolvedConfig: CliResolvedConfig,
  options: {
    profileName: string;
    force: boolean;
  },
): SetupCommandResult {
  const userConfig = readUserConfig(resolvedConfig.paths.configRoot, process.cwd(), process.env);
  const nextProfile: CliProfileRecord = {
    socket_path: resolvedConfig.socket_path.value,
    workspace_root: resolvedConfig.workspace_root.value,
    connect_timeout_ms: resolvedConfig.connect_timeout_ms.value,
    response_timeout_ms: resolvedConfig.response_timeout_ms.value,
    max_connect_retries: resolvedConfig.max_connect_retries.value,
    connect_retry_delay_ms: resolvedConfig.connect_retry_delay_ms.value,
  };
  const existingProfile = userConfig.config.profiles?.[options.profileName];

  if (existingProfile && !options.force && !profileValuesEqual(existingProfile, nextProfile)) {
    throw inputError(
      `Profile ${options.profileName} already exists in ${userConfig.path} with different settings. Re-run with --force to overwrite it.`,
      {
        profile: options.profileName,
        config_path: userConfig.path,
      },
    );
  }

  const configured = upsertUserProfile(userConfig.config, options.profileName, nextProfile);
  const activated = setActiveUserProfile(configured, options.profileName);
  writeUserConfig(userConfig.path, activated);

  const daemonEnv = buildDaemonRuntimeEnvironment(resolvedConfig);
  const createdDirectories = ensureSetupDirectories(daemonEnv, resolvedConfig.paths.configRoot);

  return {
    mode: "local",
    profile_name: options.profileName,
    config_path: userConfig.path,
    profile_created: !existingProfile,
    profile_overwritten: Boolean(existingProfile && !profileValuesEqual(existingProfile, nextProfile)),
    created_directories: createdDirectories,
    workspace_root: resolvedConfig.workspace_root.value,
    socket_path: resolvedConfig.socket_path.value,
    daemon_start_command: setupCommandExample(resolvedConfig.paths.configRoot, "daemon start"),
    doctor_command: setupCommandExample(resolvedConfig.paths.configRoot, "doctor"),
  };
}

export async function runDaemonStartCommand(resolvedConfig: CliResolvedConfig): Promise<AuthorityDaemonListeningSummary> {
  const { runAuthorityDaemonFromEnv } = await loadAuthorityDaemonModule();
  Object.assign(process.env, buildDaemonRuntimeEnvironment(resolvedConfig));
  const daemon = await runAuthorityDaemonFromEnv({
    registerSignalHandlers: true,
  });
  return daemon.summary;
}

export async function buildTrustReport(
  client: AuthorityClient,
  resolvedConfig: CliResolvedConfig,
  options: {
    runId?: string;
    visibilityScope: TimelineResult["visibility_scope"];
  },
  cliVersion: string,
): Promise<TrustReportResult> {
  const [doctor, profilesResult, trustDecisionsResult, bindingsResult, timeline] = await Promise.all([
    buildDoctorResult(client, resolvedConfig, cliVersion),
    client.listMcpServerProfiles(),
    client.listMcpServerTrustDecisions(),
    client.listMcpServerCredentialBindings(),
    options.runId ? client.queryTimeline(options.runId, options.visibilityScope) : Promise.resolve(null),
  ]);

  const activeTrustDecisions = new Set(
    trustDecisionsResult.trust_decisions
      .filter((decision) => decision.decision !== "deny")
      .map((decision) => decision.trust_decision_id),
  );
  const activeCredentialBindings = new Set(
    bindingsResult.credential_bindings
      .filter((binding) => binding.status === "active" || binding.status === "degraded")
      .map((binding) => binding.credential_binding_id),
  );

  let activeProfileCount = 0;
  let pendingProfileCount = 0;
  let quarantinedProfileCount = 0;
  let revokedProfileCount = 0;
  let profilesWithoutActiveTrustDecision = 0;
  let profilesRequiringCredentials = 0;
  let profilesMissingCredentials = 0;

  for (const profile of profilesResult.profiles) {
    if (profile.status === "active") {
      activeProfileCount += 1;
    } else if (profile.status === "pending_approval") {
      pendingProfileCount += 1;
    } else if (profile.status === "quarantined") {
      quarantinedProfileCount += 1;
    } else if (profile.status === "revoked") {
      revokedProfileCount += 1;
    }

    if (!profile.active_trust_decision_id || !activeTrustDecisions.has(profile.active_trust_decision_id)) {
      profilesWithoutActiveTrustDecision += 1;
    }

    if (profile.auth_descriptor.mode !== "none") {
      profilesRequiringCredentials += 1;
      if (
        !profile.active_credential_binding_id ||
        !activeCredentialBindings.has(profile.active_credential_binding_id)
      ) {
        profilesMissingCredentials += 1;
      }
    }
  }

  const recommendations = [...doctor.recommendations];
  if (profilesWithoutActiveTrustDecision > 0) {
    recommendations.push(
      `Record non-deny trust decisions for ${profilesWithoutActiveTrustDecision} MCP profile(s) before production activation.`,
    );
  }
  if (profilesMissingCredentials > 0) {
    recommendations.push(
      `Bind active credentials for ${profilesMissingCredentials} MCP profile(s) that declare non-none auth modes.`,
    );
  }
  if (timeline) {
    const summary = summarizeTimelineTrust(timeline.steps);
    if (summary.nonGoverned > 0) {
      recommendations.push(
        `Run ${timeline.run_summary.run_id} includes ${summary.nonGoverned} non-governed timeline step(s); inspect imported/observed provenance before using it as control evidence.`,
      );
    }
  }

  return {
    generated_at: new Date().toISOString(),
    workspace_root: resolvedConfig.workspace_root.value,
    daemon: doctor.daemon,
    security_posture_status: doctor.security_posture_status,
    mcp: {
      profile_count: profilesResult.profiles.length,
      active_profile_count: activeProfileCount,
      pending_profile_count: pendingProfileCount,
      quarantined_profile_count: quarantinedProfileCount,
      revoked_profile_count: revokedProfileCount,
      profiles_without_active_trust_decision: profilesWithoutActiveTrustDecision,
      profiles_requiring_credentials: profilesRequiringCredentials,
      profiles_missing_credentials: profilesMissingCredentials,
      active_non_deny_trust_decision_count: activeTrustDecisions.size,
      active_credential_binding_count: activeCredentialBindings.size,
    },
    timeline_trust: timeline
      ? {
          run_id: timeline.run_summary.run_id,
          visibility_scope: timeline.visibility_scope,
          step_count: timeline.steps.length,
          trust_summary: summarizeTimelineTrust(timeline.steps),
        }
      : null,
    recommendations,
  };
}
