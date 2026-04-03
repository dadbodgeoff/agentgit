#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

import { AgentGitError } from "@agentgit/schemas";

import { AgentRuntimeIntegrationService, type ProductRunResult, type ProductSetupOptions } from "./service.js";
import { isSupportedDirectCredentialEnvKey } from "./containment.js";
import type {
  AssuranceLevel,
  ContainedSecretFileBinding,
  ContainedSecretEnvBinding,
  ContainedCredentialMode,
  ContainmentBackend,
  ContainerNetworkPolicy,
  DockerCapabilitySnapshot,
  GovernanceGuarantee,
  GovernanceMode,
  PolicyStrictness,
  SetupExperience,
  SetupPreferences,
} from "./types.js";

const USAGE = [
  "Usage: agentgit [global-flags] <command> [options]",
  "",
  "Global flags:",
  "  --json",
  "  --workspace-root <path>",
  "",
  "Commands:",
  "  setup [--command <agent command>] [--remove] [--repair] [--yes] [--advanced] [--recommended] [--contained] [--image <container-image>] [--policy <balanced|strict>] [--network <inherit|none>] [--credentials <none|direct-env|brokered-secret-refs>] [--credential-env <ENV_KEY>] [--secret-env <ENV_KEY=secret-id>] [--secret-file <relative/path=secret-id>] [--egress-host <host[:port]>] [--assurance <observed|attached|contained|integrated>] [--scope <workspace>]",
  "  run",
  "  demo",
  "  inspect",
  "  restore [--preview] [--force] [--path <file-or-dir>] [--action-id <id>] [--snapshot-id <id>] [--contained-run-id <id>]",
].join("\n");

interface GlobalFlags {
  json: boolean;
  workspace_root?: string;
  command?: string;
  rest: string[];
}

function parseGlobalFlags(argv: string[]): GlobalFlags {
  const flags: GlobalFlags = {
    json: false,
    rest: [],
  };
  const rest = [...argv];
  while (rest.length > 0) {
    const current = rest[0]!;
    if (!current.startsWith("--")) {
      break;
    }
    rest.shift();
    switch (current) {
      case "--json":
        flags.json = true;
        break;
      case "--workspace-root":
        flags.workspace_root = path.resolve(shiftValue(rest, "--workspace-root"));
        break;
      default:
        rest.unshift(current);
        flags.rest = rest;
        return flags;
    }
  }

  flags.rest = rest;
  return flags;
}

function shiftValue(args: string[], flag: string): string {
  const value = args.shift();
  if (!value) {
    throw new AgentGitError(`${flag} expects a value.`, "BAD_REQUEST", {
      flag,
    });
  }
  return value;
}

async function promptText(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function promptConfirm(question: string): Promise<boolean> {
  const answer = (await promptText(`${question} [y/N] `)).toLowerCase();
  return answer === "y" || answer === "yes";
}

function formatAssuranceLevel(level: AssuranceLevel | null): string {
  return level ?? "none";
}

function assuranceStatement(level: AssuranceLevel | null): string {
  switch (level) {
    case "observed":
      return "AgentGit is observing activity without owning a governed execution boundary.";
    case "attached":
      return "AgentGit is governing supported launch surfaces.";
    case "contained":
      return "AgentGit is governing the runtime boundary.";
    case "integrated":
      return "AgentGit is governing this runtime through a native integration path.";
    default:
      return "No active governed runtime profile is installed in this workspace.";
  }
}

function formatGovernanceMode(mode: GovernanceMode | null): string {
  switch (mode) {
    case "attached_live":
      return "attached live launch";
    case "contained_projection":
      return "contained projection";
    case "native_integrated":
      return "native integrated runtime";
    default:
      return "none";
  }
}

function formatGuarantee(guarantee: GovernanceGuarantee): string {
  switch (guarantee) {
    case "native_runtime_integration":
      return "native runtime integration";
    case "known_plugin_surfaces_governed":
      return "supported plugin surfaces governed";
    case "known_shell_entrypoints_governed":
      return "supported shell entrypoints governed";
    case "real_workspace_protected":
      return "real workspace protected";
    case "publish_path_governed":
      return "publish-back path governed";
    case "brokered_credentials_only":
      return "no direct host credential passthrough";
    case "egress_policy_applied":
      return "contained egress policy applied";
  }
}

function formatGuarantees(guarantees: GovernanceGuarantee[]): string {
  return guarantees.length > 0 ? guarantees.map((entry) => formatGuarantee(entry)).join(", ") : "none";
}

function containedCredentialStatement(details: {
  credential_mode: ContainedCredentialMode;
  credential_env_keys: string[];
  credential_file_paths: string[];
}): string {
  switch (details.credential_mode) {
    case "direct_env":
      return details.credential_env_keys.length > 0
        ? `direct host env allowlist (${details.credential_env_keys.join(", ")})`
        : "direct host env allowlist (no keys selected)";
    case "brokered_secret_refs":
      return details.credential_env_keys.length > 0 || details.credential_file_paths.length > 0
        ? [
            details.credential_env_keys.length > 0
              ? `env ${details.credential_env_keys.join(", ")}`
              : null,
            details.credential_file_paths.length > 0
              ? `files ${details.credential_file_paths.join(", ")}`
              : null,
          ]
            .filter((value): value is string => value !== null)
            .join("; ")
            .replace(/^/, "brokered secret refs (")
            .concat(")")
        : "brokered secret refs (no bindings configured)";
    default:
      return "none injected";
  }
}

function formatContainedCapabilities(snapshot?: DockerCapabilitySnapshot): string | null {
  if (!snapshot) {
    return null;
  }

  const parts = [
    snapshot.projection_enforced ? "projected workspace enforced" : "projection not enforced",
    snapshot.read_only_rootfs_enabled ? "read-only rootfs" : "writable rootfs",
    snapshot.network_restricted ? "network restricted" : "network inherited",
    snapshot.credential_brokering_enabled ? "credential brokering enabled" : "credential brokering not enabled",
    snapshot.proxy_egress_allowlist_applied
      ? `proxy allowlist (${(snapshot.egress_allowlist_hosts ?? []).join(", ") || "configured"})`
      : "no proxy allowlist",
    snapshot.rootless_docker
      ? "rootless Docker"
      : snapshot.docker_desktop_vm
        ? "Docker Desktop VM"
        : "standard Docker daemon",
  ];

  const platformDetails = [snapshot.server_platform, snapshot.server_os, snapshot.server_arch].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return platformDetails.length > 0 ? `${parts.join(", ")} [${platformDetails.join(" / ")}]` : parts.join(", ");
}

function containsValue<TValue extends string>(value: string, values: readonly TValue[]): value is TValue {
  return (values as readonly string[]).includes(value);
}

interface SetupCliOptions {
  command?: string;
  remove: boolean;
  repair: boolean;
  yes: boolean;
  experience?: SetupExperience;
  policy_strictness?: PolicyStrictness;
  assurance_target?: AssuranceLevel;
  install_scope?: "workspace";
  containment_backend?: ContainmentBackend;
  container_image?: string;
  container_network_policy?: ContainerNetworkPolicy;
  contained_credential_mode?: ContainedCredentialMode;
  credential_passthrough_env_keys?: string[];
  contained_secret_env_bindings?: ContainedSecretEnvBinding[];
  contained_secret_file_bindings?: ContainedSecretFileBinding[];
  contained_proxy_allowlist_hosts?: string[];
}

const POLICY_STRICTNESS_VALUES = ["balanced", "strict"] as const;
const ASSURANCE_LEVEL_VALUES = ["observed", "attached", "contained", "integrated"] as const;
const CONTAINER_NETWORK_POLICY_VALUES = ["inherit", "none"] as const;
const CONTAINED_CREDENTIAL_MODE_VALUES = ["none", "direct_env", "brokered_secret_refs"] as const;

function parseSecretEnvBinding(input: string): ContainedSecretEnvBinding {
  const separatorIndex = input.indexOf("=");
  if (separatorIndex <= 0 || separatorIndex === input.length - 1) {
    throw new AgentGitError(`Invalid --secret-env binding: ${input}`, "BAD_REQUEST", {
      flag: "--secret-env",
      value: input,
      expected_format: "ENV_KEY=secret-id",
    });
  }

  const envKey = input.slice(0, separatorIndex).trim();
  const secretId = input.slice(separatorIndex + 1).trim();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(envKey)) {
    throw new AgentGitError(`Invalid contained secret env key: ${envKey}`, "BAD_REQUEST", {
      flag: "--secret-env",
      env_key: envKey,
    });
  }

  if (secretId.length === 0) {
    throw new AgentGitError(`Invalid contained secret id in --secret-env: ${input}`, "BAD_REQUEST", {
      flag: "--secret-env",
      value: input,
    });
  }

  return {
    env_key: envKey,
    secret_id: secretId,
  };
}

function parseSecretFileBinding(input: string): ContainedSecretFileBinding {
  const separatorIndex = input.indexOf("=");
  if (separatorIndex <= 0 || separatorIndex === input.length - 1) {
    throw new AgentGitError(`Invalid --secret-file binding: ${input}`, "BAD_REQUEST", {
      flag: "--secret-file",
      value: input,
      expected_format: "relative/path=secret-id",
    });
  }

  const rawPath = input.slice(0, separatorIndex).trim();
  const relativePath = rawPath;
  const secretId = input.slice(separatorIndex + 1).trim();
  if (
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new AgentGitError(`Invalid contained secret file path: ${relativePath || input}`, "BAD_REQUEST", {
      flag: "--secret-file",
      relative_path: relativePath,
    });
  }

  if (secretId.length === 0) {
    throw new AgentGitError(`Invalid contained secret id in --secret-file: ${input}`, "BAD_REQUEST", {
      flag: "--secret-file",
      value: input,
    });
  }

  return {
    relative_path: relativePath,
    secret_id: secretId,
  };
}

function parseContainedEgressHost(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const parts = trimmed.split(":");
  if (
    trimmed.length === 0 ||
    parts.length > 2 ||
    !/^[a-z0-9.-]+$/.test(parts[0]!) ||
    (parts[1] !== undefined && (!/^\d+$/.test(parts[1]) || Number(parts[1]) < 1 || Number(parts[1]) > 65535))
  ) {
    throw new AgentGitError(`Invalid --egress-host entry: ${input}`, "BAD_REQUEST", {
      flag: "--egress-host",
      value: input,
    });
  }
  return trimmed;
}

function parseCredentialEnvKey(input: string): string {
  const value = input.trim().toUpperCase();
  if (!/^[A-Z_][A-Z0-9_]*$/.test(value) || !isSupportedDirectCredentialEnvKey(value)) {
    throw new AgentGitError(`Invalid --credential-env key: ${input}`, "BAD_REQUEST", {
      flag: "--credential-env",
      value: input,
    });
  }
  return value;
}

function buildSetupPreferences(options: SetupCliOptions): SetupPreferences {
  return {
    experience: options.experience ?? "recommended",
    policy_strictness: options.policy_strictness ?? "balanced",
    install_scope: options.install_scope ?? "workspace",
    assurance_target: options.assurance_target,
    containment_backend: options.containment_backend,
    container_image: options.container_image,
    container_network_policy: options.container_network_policy,
    contained_credential_mode: options.contained_credential_mode,
    credential_passthrough_env_keys: options.credential_passthrough_env_keys,
    contained_secret_env_bindings: options.contained_secret_env_bindings,
    contained_secret_file_bindings: options.contained_secret_file_bindings,
    contained_proxy_allowlist_hosts: options.contained_proxy_allowlist_hosts,
  };
}

async function promptSetupExperience(): Promise<SetupExperience> {
  const answer = (await promptText("Press Enter for Recommended setup, or type 'a' for Advanced: ")).toLowerCase();
  return answer === "a" || answer === "advanced" ? "advanced" : "recommended";
}

async function promptAdvancedSetupPreferences(existing: SetupCliOptions): Promise<SetupCliOptions> {
  const next = { ...existing };
  if (!next.containment_backend) {
    const containmentAnswer = (await promptText("Containment backend [Enter=none, d=docker]: ")).toLowerCase();
    if (containmentAnswer === "d" || containmentAnswer === "docker") {
      next.containment_backend = "docker";
      next.assurance_target ??= "contained";
    }
  }

  if (!next.policy_strictness) {
    const policyAnswer = (await promptText("Policy strictness [Enter=balanced, s=strict]: ")).toLowerCase();
    next.policy_strictness = policyAnswer === "s" || policyAnswer === "strict" ? "strict" : "balanced";
  }

  if (!next.assurance_target) {
    const assuranceAnswer = (
      await promptText("Assurance target [Enter=best available, attached, contained, integrated]: ")
    ).toLowerCase();
    if (assuranceAnswer.length > 0 && containsValue(assuranceAnswer, ASSURANCE_LEVEL_VALUES)) {
      next.assurance_target = assuranceAnswer;
    }
  }

  if (next.containment_backend === "docker" && !next.container_image) {
    const imageAnswer = await promptText("Container image [Enter=auto-detect]: ");
    next.container_image = imageAnswer.trim().length > 0 ? imageAnswer.trim() : undefined;
  }

  if (next.containment_backend === "docker" && !next.container_network_policy) {
    const networkAnswer = (await promptText("Contained network policy [Enter=inherit, n=none]: ")).toLowerCase();
    next.container_network_policy = networkAnswer === "n" || networkAnswer === "none" ? "none" : "inherit";
  }

  if (
    next.containment_backend === "docker" &&
    next.container_network_policy !== "none" &&
    (!next.contained_proxy_allowlist_hosts || next.contained_proxy_allowlist_hosts.length === 0)
  ) {
    const egressAnswer = await promptText(
      "Contained HTTP(S) egress allowlist [Enter=none, format host or host:port, comma-separated]: ",
    );
    next.contained_proxy_allowlist_hosts =
      egressAnswer.trim().length === 0
        ? []
        : egressAnswer
            .split(",")
            .map((entry) => parseContainedEgressHost(entry.trim()));
  }

  if (next.containment_backend === "docker" && !next.contained_credential_mode) {
    const credentialAnswer = (
      await promptText("Contained credentials [Enter=direct-env, n=none, b=brokered-secret-refs]: ")
    ).toLowerCase();
    next.contained_credential_mode =
      credentialAnswer === "n" || credentialAnswer === "none"
        ? "none"
        : credentialAnswer === "b" || credentialAnswer === "brokered-secret-refs"
          ? "brokered_secret_refs"
          : "direct_env";
  }

  if (
    next.containment_backend === "docker" &&
    next.contained_credential_mode === "direct_env" &&
    (!next.credential_passthrough_env_keys || next.credential_passthrough_env_keys.length === 0)
  ) {
    const credentialEnvAnswer = await promptText(
      "Contained host env allowlist [Enter=none, comma-separated like OPENAI_API_KEY]: ",
    );
    next.credential_passthrough_env_keys =
      credentialEnvAnswer.trim().length === 0
        ? []
        : Array.from(
            new Set(
              credentialEnvAnswer
                .split(",")
                .map((entry) => parseCredentialEnvKey(entry.trim())),
            ),
          );
  }

  if (
    next.containment_backend === "docker" &&
    next.contained_credential_mode === "brokered_secret_refs" &&
    (!next.contained_secret_env_bindings || next.contained_secret_env_bindings.length === 0) &&
    (!next.contained_secret_file_bindings || next.contained_secret_file_bindings.length === 0)
  ) {
    const envBindingsAnswer = await promptText(
      "Contained secret bindings [Enter=none, format OPENAI_API_KEY=secret-id, comma-separated]: ",
    );
    next.contained_secret_env_bindings =
      envBindingsAnswer.trim().length === 0
        ? []
        : envBindingsAnswer
            .split(",")
            .map((entry) => parseSecretEnvBinding(entry.trim()));
    const fileBindingsAnswer = await promptText(
      "Contained secret files [Enter=none, format openai.key=secret-id, comma-separated]: ",
    );
    next.contained_secret_file_bindings =
      fileBindingsAnswer.trim().length === 0
        ? []
        : fileBindingsAnswer
            .split(",")
            .map((entry) => parseSecretFileBinding(entry.trim()));
  }

  next.install_scope ??= "workspace";
  return next;
}

export function formatSetupResult(result: Awaited<ReturnType<AgentRuntimeIntegrationService["setup"]>>): string {
  return [
    `Action: ${result.action}`,
    `Runtime: ${result.runtime ?? "none"}`,
    `Workspace: ${result.workspace_root}`,
    `Assurance level: ${formatAssuranceLevel(result.assurance_level)}`,
    `Assurance: ${assuranceStatement(result.assurance_level)}`,
    `Governance mode: ${formatGovernanceMode(result.governance_mode)}`,
    `Guarantees: ${formatGuarantees(result.guarantees)}`,
    `Governed surfaces: ${result.governed_surfaces.length > 0 ? result.governed_surfaces.join(", ") : "none"}`,
    result.contained_details ? `Contained backend: ${result.contained_details.backend}` : null,
    result.contained_details ? `Contained network policy: ${result.contained_details.network_policy}` : null,
    result.contained_details ? `Contained credentials: ${containedCredentialStatement(result.contained_details)}` : null,
    result.contained_details && result.contained_details.egress_allowlist_hosts.length > 0
      ? `Contained egress allowlist: ${result.contained_details.egress_allowlist_hosts.join(", ")}`
      : null,
    result.contained_details && result.contained_details.capability_snapshot
      ? `Contained capabilities: ${formatContainedCapabilities(result.contained_details.capability_snapshot)}`
      : null,
    `Changed anything: ${result.changed ? "yes" : "no"}`,
    `Next command: ${result.next_command ?? "none"}`,
    result.health_checks.length === 0
      ? "Health checks: none"
      : `Health checks:\n${result.health_checks
          .map((check) => `  - [${check.ok ? "pass" : "fail"}] ${check.label}: ${check.detail}`)
          .join("\n")}`,
    result.degraded_reasons.length === 0
      ? null
      : `Degraded reasons:\n${result.degraded_reasons.map((entry) => `  - ${entry}`).join("\n")}`,
    result.preserved_user_changes.length === 0
      ? null
      : `Preserved user changes:\n${result.preserved_user_changes.map((entry) => `  - ${entry}`).join("\n")}`,
  ]
    .filter((value): value is string => value !== null)
    .join("\n");
}

export function formatDemoResult(result: Awaited<ReturnType<AgentRuntimeIntegrationService["demo"]>>): string {
  return [
    "Demo ready",
    `Workspace: ${result.workspace_root}`,
    `Safe demo workspace: ${result.demo_workspace_root}`,
    `Run: ${result.run_id}`,
    `Dangerous action: ${result.dangerous_action_id}`,
    `Deleted file: ${result.deleted_path}`,
    `Inspect next: ${result.inspect_command}`,
    `Restore next: ${result.restore_command}`,
  ].join("\n");
}

export function formatInspectResult(result: Awaited<ReturnType<AgentRuntimeIntegrationService["inspect"]>>): string {
  if (!result.found) {
    return [
      result.summary,
      `Assurance level: ${formatAssuranceLevel(result.assurance_level)}`,
      `Assurance: ${assuranceStatement(result.assurance_level)}`,
      `Governance mode: ${formatGovernanceMode(result.governance_mode)}`,
      `Guarantees: ${formatGuarantees(result.guarantees)}`,
      result.degraded_reasons.length === 0 ? null : `Degraded reasons: ${result.degraded_reasons.join("; ")}`,
      result.contained_details ? `Contained backend: ${result.contained_details.backend}` : null,
      result.contained_details ? `Contained network policy: ${result.contained_details.network_policy}` : null,
      result.contained_details ? `Contained credentials: ${containedCredentialStatement(result.contained_details)}` : null,
      result.contained_details && result.contained_details.egress_allowlist_hosts.length > 0
        ? `Contained egress allowlist: ${result.contained_details.egress_allowlist_hosts.join(", ")}`
        : null,
      result.contained_details && result.contained_details.capability_snapshot
        ? `Contained capabilities: ${formatContainedCapabilities(result.contained_details.capability_snapshot)}`
        : null,
    ]
      .filter((value): value is string => value !== null)
      .join("\n");
  }

  return [
    "Latest notable governed run",
    `Workspace: ${result.workspace_root}`,
    `Governed workspace: ${result.governed_workspace_root ?? "unknown"}`,
    `Run: ${result.run_id ?? "unknown"}`,
    `Assurance level: ${formatAssuranceLevel(result.assurance_level)}`,
    `Assurance: ${assuranceStatement(result.assurance_level)}`,
    `Governance mode: ${formatGovernanceMode(result.governance_mode)}`,
    `Guarantees: ${formatGuarantees(result.guarantees)}`,
    `What happened: ${result.summary}`,
    `Action: ${result.action_title ?? "unknown"}`,
    `Status: ${result.action_status ?? "unknown"}`,
    `Changed paths: ${result.changed_paths.length > 0 ? result.changed_paths.join(", ") : "unknown"}`,
    `Restore available: ${result.restore_available ? "yes" : "no"}`,
    `Next restore command: ${result.restore_command ?? "none"}`,
    result.contained_details ? `Contained backend: ${result.contained_details.backend}` : null,
    result.contained_details ? `Contained network policy: ${result.contained_details.network_policy}` : null,
    result.contained_details ? `Contained credentials: ${containedCredentialStatement(result.contained_details)}` : null,
    result.contained_details && result.contained_details.egress_allowlist_hosts.length > 0
      ? `Contained egress allowlist: ${result.contained_details.egress_allowlist_hosts.join(", ")}`
      : null,
    result.contained_details && result.contained_details.capability_snapshot
      ? `Contained capabilities: ${formatContainedCapabilities(result.contained_details.capability_snapshot)}`
      : null,
    result.degraded_reasons.length === 0 ? null : `Degraded reasons: ${result.degraded_reasons.join("; ")}`,
  ]
    .filter((value): value is string => value !== null)
    .join("\n");
}

export function formatRestoreResult(result: Awaited<ReturnType<AgentRuntimeIntegrationService["restore"]>>): string {
  return [
    result.restored ? "Restore complete" : result.preview_only ? "Restore preview" : "Restore planned",
    `Workspace: ${result.workspace_root}`,
    `Governed workspace: ${result.governed_workspace_root}`,
    `Target: ${result.target_summary}`,
    `Source of truth: ${result.restore_source}`,
    `Recovery class: ${result.recovery_class}`,
    `Restore mode: ${result.exactness}`,
    `Preview only: ${result.preview_only ? "yes" : "no"}`,
    `Conflicts detected: ${result.conflict_detected ? "yes" : "no"}`,
    `Files affected: ${result.changed_path_count ?? "unknown"}`,
    `Files deleted by restore: ${result.deletes_files === null ? "unknown" : result.deletes_files ? "yes" : "no"}`,
    `Overlapping paths: ${result.overlapping_paths.length > 0 ? result.overlapping_paths.join(", ") : "none"}`,
    `Next command: ${result.restore_command}`,
    result.advanced_command ? `Advanced command: ${result.advanced_command}` : null,
  ]
    .filter((value): value is string => value !== null)
    .join("\n");
}

export function formatRunResult(result: ProductRunResult): string {
  return [
    `Runtime: ${result.runtime}`,
    `Workspace: ${result.workspace_root}`,
    `Run: ${result.run_id}`,
    `Exit code: ${result.exit_code}`,
    `Signal: ${result.signal ?? "none"}`,
    `Daemon started by AgentGit: ${result.daemon_started ? "yes" : "no"}`,
  ].join("\n");
}

function parseSetupOptions(args: string[]): SetupCliOptions {
  const options: SetupCliOptions = {
    command: undefined as string | undefined,
    remove: false,
    repair: false,
    yes: false,
    experience: undefined,
    policy_strictness: undefined,
    assurance_target: undefined,
    install_scope: undefined,
    containment_backend: undefined,
    container_image: undefined,
    container_network_policy: undefined,
    contained_credential_mode: undefined,
    credential_passthrough_env_keys: undefined,
    contained_secret_env_bindings: undefined,
    contained_secret_file_bindings: undefined,
    contained_proxy_allowlist_hosts: undefined,
  };
  const rest = [...args];
  while (rest.length > 0) {
    const current = rest.shift()!;
    switch (current) {
      case "--command":
        options.command = shiftValue(rest, "--command");
        break;
      case "--remove":
        options.remove = true;
        break;
      case "--repair":
        options.repair = true;
        break;
      case "--yes":
        options.yes = true;
        break;
      case "--advanced":
        options.experience = "advanced";
        break;
      case "--recommended":
        options.experience = "recommended";
        break;
      case "--contained":
        options.containment_backend = "docker";
        options.assurance_target ??= "contained";
        break;
      case "--image":
        options.container_image = shiftValue(rest, "--image");
        break;
      case "--network": {
        const value = shiftValue(rest, "--network");
        if (!containsValue(value, CONTAINER_NETWORK_POLICY_VALUES)) {
          throw new AgentGitError(`Unsupported container network policy: ${value}`, "BAD_REQUEST", {
            flag: "--network",
            value,
          });
        }
        options.container_network_policy = value;
        break;
      }
      case "--credentials": {
        const value = shiftValue(rest, "--credentials").replaceAll("-", "_");
        if (!containsValue(value, CONTAINED_CREDENTIAL_MODE_VALUES)) {
          throw new AgentGitError(`Unsupported contained credential mode: ${value}`, "BAD_REQUEST", {
            flag: "--credentials",
            value,
          });
        }
        options.contained_credential_mode = value;
        break;
      }
      case "--credential-env":
        options.credential_passthrough_env_keys ??= [];
        options.credential_passthrough_env_keys.push(parseCredentialEnvKey(shiftValue(rest, "--credential-env")));
        options.contained_credential_mode ??= "direct_env";
        break;
      case "--secret-env":
        options.contained_secret_env_bindings ??= [];
        options.contained_secret_env_bindings.push(parseSecretEnvBinding(shiftValue(rest, "--secret-env")));
        options.contained_credential_mode ??= "brokered_secret_refs";
        break;
      case "--secret-file":
        options.contained_secret_file_bindings ??= [];
        options.contained_secret_file_bindings.push(parseSecretFileBinding(shiftValue(rest, "--secret-file")));
        options.contained_credential_mode ??= "brokered_secret_refs";
        break;
      case "--egress-host":
        options.contained_proxy_allowlist_hosts ??= [];
        options.contained_proxy_allowlist_hosts.push(parseContainedEgressHost(shiftValue(rest, "--egress-host")));
        break;
      case "--policy": {
        const value = shiftValue(rest, "--policy");
        if (!containsValue(value, POLICY_STRICTNESS_VALUES)) {
          throw new AgentGitError(`Unsupported policy strictness: ${value}`, "BAD_REQUEST", {
            flag: "--policy",
            value,
          });
        }
        options.policy_strictness = value;
        break;
      }
      case "--assurance": {
        const value = shiftValue(rest, "--assurance");
        if (!containsValue(value, ASSURANCE_LEVEL_VALUES)) {
          throw new AgentGitError(`Unsupported assurance level: ${value}`, "BAD_REQUEST", {
            flag: "--assurance",
            value,
          });
        }
        options.assurance_target = value;
        break;
      }
      case "--scope": {
        const value = shiftValue(rest, "--scope");
        if (value !== "workspace") {
          throw new AgentGitError(`Unsupported setup scope: ${value}`, "BAD_REQUEST", {
            flag: "--scope",
            value,
          });
        }
        options.install_scope = "workspace";
        break;
      }
      default:
        throw new AgentGitError(`Unknown setup flag: ${current}`, "BAD_REQUEST", {
          flag: current,
        });
    }
  }
  return options;
}

function parseRestoreOptions(args: string[]): {
  preview: boolean;
  force: boolean;
  path?: string;
  action_id?: string;
  snapshot_id?: string;
  contained_run_id?: string;
} {
  const options = {
    preview: false,
    force: false,
    path: undefined as string | undefined,
    action_id: undefined as string | undefined,
    snapshot_id: undefined as string | undefined,
    contained_run_id: undefined as string | undefined,
  };
  const rest = [...args];
  while (rest.length > 0) {
    const current = rest.shift()!;
    switch (current) {
      case "--preview":
        options.preview = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--path":
        options.path = path.resolve(shiftValue(rest, "--path"));
        break;
      case "--action-id":
        options.action_id = shiftValue(rest, "--action-id");
        break;
      case "--snapshot-id":
        options.snapshot_id = shiftValue(rest, "--snapshot-id");
        break;
      case "--contained-run-id":
        options.contained_run_id = shiftValue(rest, "--contained-run-id");
        break;
      default:
        throw new AgentGitError(`Unknown restore flag: ${current}`, "BAD_REQUEST", {
          flag: current,
        });
    }
  }
  return options;
}

function printValue(value: unknown, json: boolean, formatter: (result: unknown) => string): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  console.log(formatter(value));
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<ProductRunResult | null> {
  const flags = parseGlobalFlags(argv);
  const [command, ...rest] = flags.rest;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return null;
  }

  const service = new AgentRuntimeIntegrationService({
    cwd: process.cwd(),
    env: process.env,
  });
  try {
    const workspaceRoot = service.resolveWorkspaceRoot(flags.workspace_root);
    switch (command) {
      case "setup": {
        let options = parseSetupOptions(rest);
        if (options.remove) {
          const result = service.remove(workspaceRoot);
          printValue(result, flags.json, (value) => formatSetupResult(value as Awaited<ReturnType<typeof service.remove>>));
          return null;
        }
        if (options.repair) {
          const result = service.repair(workspaceRoot, options.command, buildSetupPreferences(options));
          printValue(result, flags.json, (value) => formatSetupResult(value as Awaited<ReturnType<typeof service.repair>>));
          return null;
        }

        if (!options.experience && process.stdin.isTTY && process.stdout.isTTY && !options.yes) {
          options = {
            ...options,
            experience: await promptSetupExperience(),
          };
        }

        if (options.experience === "advanced" && process.stdin.isTTY && process.stdout.isTTY && !options.yes) {
          options = await promptAdvancedSetupPreferences(options);
        }

        const setupOptions: ProductSetupOptions = {
          user_command: options.command,
          setup_preferences: buildSetupPreferences(options),
        };
        let commandValue = options.command;
        let planned;
        try {
          planned = service.previewSetup(workspaceRoot, setupOptions);
        } catch (error) {
          if (
            error instanceof AgentGitError &&
            error.code === "BAD_REQUEST" &&
            process.stdin.isTTY &&
            process.stdout.isTTY &&
            (!commandValue || commandValue.trim().length === 0)
          ) {
            commandValue = await promptText("What command starts your agent? ");
            planned = service.previewSetup(workspaceRoot, {
              ...setupOptions,
              user_command: commandValue,
            });
          } else {
            throw error;
          }
        }

        if (planned.plan.user_confirmation_required && !options.yes) {
          const confirmed = await promptConfirm(
            `AgentGit needs to update ${planned.plan.runtime_display_name} so it points at ${workspaceRoot}. Continue?`,
          );
          if (!confirmed) {
            throw new AgentGitError("Setup cancelled before any runtime config was changed.", "CONFLICT", {
              runtime: planned.plan.runtime_display_name,
              workspace_root: workspaceRoot,
            });
          }
        }

        const result = service.setup(workspaceRoot, {
          ...setupOptions,
          user_command: commandValue,
        });
        printValue(result, flags.json, (value) => formatSetupResult(value as typeof result));
        return null;
      }
      case "demo": {
        const result = await service.demo(workspaceRoot);
        printValue(result, flags.json, (value) => formatDemoResult(value as Awaited<ReturnType<typeof service.demo>>));
        return null;
      }
      case "inspect": {
        const result = await service.inspect(workspaceRoot);
        printValue(result, flags.json, (value) =>
          formatInspectResult(value as Awaited<ReturnType<typeof service.inspect>>),
        );
        return null;
      }
      case "restore": {
        const options = parseRestoreOptions(rest);
        const result = await service.restore(workspaceRoot, options);
        printValue(result, flags.json, (value) =>
          formatRestoreResult(value as Awaited<ReturnType<typeof service.restore>>),
        );
        return null;
      }
      case "run": {
        const result = await service.run(workspaceRoot);
        if (flags.json) {
          console.log(JSON.stringify(result, null, 2));
        }
        return result;
      }
      default:
        throw new AgentGitError(`Unknown command: ${command}`, "BAD_REQUEST", {
          command,
        });
    }
  } finally {
    service.close();
  }
}

async function main(): Promise<void> {
  try {
    const outcome = await runCli();
    if (outcome) {
      if (outcome.signal) {
        process.kill(process.pid, outcome.signal);
        return;
      }
      process.exitCode = outcome.exit_code;
    }
  } catch (error) {
    const wantsJson = process.argv.includes("--json");
    if (wantsJson) {
      console.error(
        JSON.stringify(
          {
            error: error instanceof Error ? error.message : String(error),
            code: error instanceof AgentGitError ? error.code : "INTERNAL_ERROR",
            details: error instanceof AgentGitError ? error.details : undefined,
          },
          null,
          2,
        ),
      );
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  }
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
  await main();
}
