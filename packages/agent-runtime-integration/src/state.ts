import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { IntegrationState } from "@agentgit/integration-state";
import { AgentGitError } from "@agentgit/schemas";

import type {
  AssuranceLevel,
  CheckpointIntent,
  ContainedEgressAssurance,
  ContainedEgressMode,
  ContainedRunDocument,
  ContainedSecretFileBinding,
  DefaultCheckpointPolicy,
  RuntimeCredentialBindingDocument,
  ConfigBackupDocument,
  DockerCapabilitySnapshot,
  DemoRunDocument,
  GovernanceGuarantee,
  GovernanceMode,
  ProductStateCollections,
  ProductStateDocument,
  RunCheckpointDocument,
  RestoreShortcutDocument,
  RuntimeInstallDocument,
  RuntimeProfileDocument,
} from "./types.js";

const CURRENT_SCHEMA_VERSION = 11;
const PRODUCT_STATE_DIR = "runtime-integration";
const PRODUCT_STATE_DB_NAME = "state.db";
const DEFAULT_ASSURANCE_LEVEL: AssuranceLevel = "attached";
const DEFAULT_EXECUTION_MODE = "host_attached";
const DEFAULT_GOVERNANCE_MODE: GovernanceMode = "attached_live";
const DEFAULT_CONTAINER_NETWORK_POLICY = "inherit";
const DEFAULT_CONTAINED_CREDENTIAL_MODE = "none";
const DEFAULT_CHECKPOINT_POLICY: DefaultCheckpointPolicy = "never";

function deriveGovernanceModeFromRecord(record: Record<string, unknown>): GovernanceMode {
  const runtimeId = typeof record.runtime_id === "string" ? record.runtime_id : undefined;
  const executionMode = typeof record.execution_mode === "string" ? record.execution_mode : DEFAULT_EXECUTION_MODE;
  if (runtimeId === "openclaw") {
    return "native_integrated";
  }
  if (executionMode === "docker_contained") {
    return "contained_projection";
  }
  return DEFAULT_GOVERNANCE_MODE;
}

function normalizeContainedCredentialMode(value: unknown): RuntimeProfileDocument["contained_credential_mode"] {
  if (value === "brokered_secret_refs") {
    return "brokered_bindings";
  }
  return typeof value === "string" ? (value as RuntimeProfileDocument["contained_credential_mode"]) : undefined;
}

function deriveContainedEgressModeFromRecord(record: Record<string, unknown>): ContainedEgressMode {
  if (typeof record.contained_egress_mode === "string") {
    return record.contained_egress_mode as ContainedEgressMode;
  }

  const networkPolicy =
    typeof record.container_network_policy === "string"
      ? record.container_network_policy
      : DEFAULT_CONTAINER_NETWORK_POLICY;
  const allowlistHosts = Array.isArray(record.contained_proxy_allowlist_hosts)
    ? record.contained_proxy_allowlist_hosts.filter((entry): entry is string => typeof entry === "string")
    : [];

  if (networkPolicy === "none") {
    return "none";
  }

  if (allowlistHosts.length > 0) {
    return "proxy_http_https";
  }

  return "inherit";
}

function deriveContainedEgressAssuranceFromRecord(record: Record<string, unknown>): ContainedEgressAssurance {
  if (typeof record.contained_egress_assurance === "string") {
    return record.contained_egress_assurance as ContainedEgressAssurance;
  }

  const egressMode = deriveContainedEgressModeFromRecord(record);
  if (egressMode === "none") {
    return "boundary_enforced";
  }

  if (egressMode === "backend_enforced_allowlist") {
    return "degraded";
  }

  return "degraded";
}

function deriveCheckpointPolicyFromRecord(record: Record<string, unknown>): DefaultCheckpointPolicy {
  if (typeof record.default_checkpoint_policy === "string") {
    return record.default_checkpoint_policy as DefaultCheckpointPolicy;
  }
  return DEFAULT_CHECKPOINT_POLICY;
}

function deriveCheckpointIntentFromRecord(record: Record<string, unknown>): CheckpointIntent | undefined {
  return typeof record.checkpoint_intent === "string" ? (record.checkpoint_intent as CheckpointIntent) : undefined;
}

function deriveGuaranteesFromRecord(record: Record<string, unknown>): GovernanceGuarantee[] {
  const governanceMode = deriveGovernanceModeFromRecord(record);
  if (governanceMode === "native_integrated") {
    return ["native_runtime_integration", "known_plugin_surfaces_governed", "known_shell_entrypoints_governed"];
  }

  if (governanceMode === "contained_projection") {
    const guarantees: GovernanceGuarantee[] = ["real_workspace_protected", "publish_path_governed"];
    const egressMode = deriveContainedEgressModeFromRecord(record);
    const credentialMode =
      normalizeContainedCredentialMode(record.contained_credential_mode) ?? DEFAULT_CONTAINED_CREDENTIAL_MODE;
    const selectedDirectEnvKeys = Array.isArray(record.credential_passthrough_env_keys)
      ? record.credential_passthrough_env_keys.filter((entry): entry is string => typeof entry === "string")
      : [];
    if (egressMode !== "inherit") {
      guarantees.push("egress_policy_applied");
    }
    if (credentialMode !== "direct_env" || selectedDirectEnvKeys.length === 0) {
      guarantees.push("brokered_credentials_only");
    }
    return guarantees;
  }

  return ["known_shell_entrypoints_governed"];
}

function deriveCapabilitySnapshotFromRecord(record: Record<string, unknown>): DockerCapabilitySnapshot | undefined {
  const governanceMode = deriveGovernanceModeFromRecord(record);
  if (governanceMode !== "contained_projection") {
    return undefined;
  }

  const adapterMetadata =
    record.adapter_metadata && typeof record.adapter_metadata === "object" && !Array.isArray(record.adapter_metadata)
      ? (record.adapter_metadata as Record<string, unknown>)
      : {};
  const serverPlatform =
    typeof record.docker_server_platform === "string"
      ? record.docker_server_platform
      : typeof adapterMetadata.docker_server_platform === "string"
        ? adapterMetadata.docker_server_platform
        : undefined;
  const serverOs =
    typeof record.docker_server_os === "string"
      ? record.docker_server_os
      : typeof adapterMetadata.docker_server_os === "string"
        ? adapterMetadata.docker_server_os
        : undefined;
  const serverArch =
    typeof record.docker_server_arch === "string"
      ? record.docker_server_arch
      : typeof adapterMetadata.docker_server_arch === "string"
        ? adapterMetadata.docker_server_arch
        : undefined;
  const egressMode = deriveContainedEgressModeFromRecord(record);
  const egressAssurance = deriveContainedEgressAssuranceFromRecord(record);
  const credentialMode =
    normalizeContainedCredentialMode(record.contained_credential_mode) ?? DEFAULT_CONTAINED_CREDENTIAL_MODE;
  const dockerDesktopVm =
    typeof record.docker_desktop_vm === "boolean"
      ? record.docker_desktop_vm
      : typeof adapterMetadata.docker_desktop_vm === "boolean"
        ? adapterMetadata.docker_desktop_vm
        : typeof serverPlatform === "string"
          ? serverPlatform.toLowerCase().includes("docker desktop")
          : false;
  const rootlessDocker =
    typeof record.rootless_docker === "boolean"
      ? record.rootless_docker
      : typeof adapterMetadata.rootless_docker === "boolean"
        ? adapterMetadata.rootless_docker
        : false;
  const dockerAvailable =
    typeof record.docker_available === "boolean"
      ? record.docker_available
      : typeof adapterMetadata.docker_available === "boolean"
        ? adapterMetadata.docker_available
        : true;

  return {
    backend_kind: "docker",
    capability_version: 1,
    docker_available: dockerAvailable,
    docker_desktop_vm: dockerDesktopVm,
    rootless_docker: rootlessDocker,
    projection_enforced: true,
    read_only_rootfs_enabled: true,
    network_restricted: egressMode === "none",
    credential_brokering_enabled: credentialMode === "brokered_bindings",
    egress_mode: egressMode,
    egress_assurance: egressAssurance,
    backend_enforced_allowlist_supported: false,
    raw_socket_egress_blocked: egressMode === "none",
    proxy_egress_allowlist_applied:
      egressMode === "proxy_http_https" &&
      Array.isArray(record.contained_proxy_allowlist_hosts) &&
      record.contained_proxy_allowlist_hosts.length > 0,
    egress_allowlist_hosts:
      egressMode !== "none" && Array.isArray(record.contained_proxy_allowlist_hosts)
        ? record.contained_proxy_allowlist_hosts.filter((entry): entry is string => typeof entry === "string")
        : [],
    server_platform: serverPlatform,
    server_os: serverOs,
    server_arch: serverArch,
  };
}

function parseContainedSecretEnvBindings(
  record: Record<string, unknown>,
  field: string,
  collection: string,
  key: string,
): RuntimeProfileDocument["contained_secret_env_bindings"] {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new AgentGitError(`Stored ${collection} document ${key} has invalid ${field}.`, "PRECONDITION_FAILED", {
      collection,
      key,
      field,
    });
  }

  return value.map((entry, index) => {
    const binding = expectObject(entry, collection, `${key}:${field}:${index}`);
    return {
      env_key: expectString(binding, "env_key", collection, `${key}:${field}:${index}`)!,
      secret_id: expectString(binding, "secret_id", collection, `${key}:${field}:${index}`)!,
    };
  });
}

function parseContainedSecretFileBindings(
  record: Record<string, unknown>,
  field: string,
  collection: string,
  key: string,
): ContainedSecretFileBinding[] | undefined {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new AgentGitError(`Stored ${collection} document ${key} has invalid ${field}.`, "PRECONDITION_FAILED", {
      collection,
      key,
      field,
    });
  }

  return value.map((entry, index) => {
    const binding = expectObject(entry, collection, `${key}:${field}:${index}`);
    return {
      relative_path: expectString(binding, "relative_path", collection, `${key}:${field}:${index}`)!,
      secret_id: expectString(binding, "secret_id", collection, `${key}:${field}:${index}`)!,
    };
  });
}

function parseRuntimeCredentialBindings(
  record: Record<string, unknown>,
  field: string,
  collection: string,
  key: string,
): RuntimeCredentialBindingDocument[] | undefined {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new AgentGitError(`Stored ${collection} document ${key} has invalid ${field}.`, "PRECONDITION_FAILED", {
      collection,
      key,
      field,
    });
  }

  return value.map((entry, index) => {
    const binding = expectObject(entry, collection, `${key}:${field}:${index}`);
    const target = expectObject(binding.target, collection, `${key}:${field}:${index}:target`);
    const surface = expectString(target, "surface", collection, `${key}:${field}:${index}:target`)!;
    if (surface === "env") {
      return {
        binding_id: expectString(binding, "binding_id", collection, `${key}:${field}:${index}`)!,
        kind: expectString(
          binding,
          "kind",
          collection,
          `${key}:${field}:${index}`,
        )! as RuntimeCredentialBindingDocument["kind"],
        target: {
          surface: "env",
          env_key: expectString(target, "env_key", collection, `${key}:${field}:${index}:target`)!,
        },
        broker_source_ref: expectString(binding, "broker_source_ref", collection, `${key}:${field}:${index}`)!,
        redacted_delivery_metadata:
          binding.redacted_delivery_metadata &&
          typeof binding.redacted_delivery_metadata === "object" &&
          !Array.isArray(binding.redacted_delivery_metadata)
            ? (binding.redacted_delivery_metadata as Record<string, unknown>)
            : {},
        expires_at: expectString(binding, "expires_at", collection, `${key}:${field}:${index}`, { optional: true }),
        rotates: typeof binding.rotates === "boolean" ? binding.rotates : false,
      };
    }

    if (surface === "file") {
      return {
        binding_id: expectString(binding, "binding_id", collection, `${key}:${field}:${index}`)!,
        kind: expectString(
          binding,
          "kind",
          collection,
          `${key}:${field}:${index}`,
        )! as RuntimeCredentialBindingDocument["kind"],
        target: {
          surface: "file",
          relative_path: expectString(target, "relative_path", collection, `${key}:${field}:${index}:target`)!,
        },
        broker_source_ref: expectString(binding, "broker_source_ref", collection, `${key}:${field}:${index}`)!,
        redacted_delivery_metadata:
          binding.redacted_delivery_metadata &&
          typeof binding.redacted_delivery_metadata === "object" &&
          !Array.isArray(binding.redacted_delivery_metadata)
            ? (binding.redacted_delivery_metadata as Record<string, unknown>)
            : {},
        expires_at: expectString(binding, "expires_at", collection, `${key}:${field}:${index}`, { optional: true }),
        rotates: typeof binding.rotates === "boolean" ? binding.rotates : false,
      };
    }

    throw new AgentGitError(
      `Stored ${collection} document ${key} has unsupported runtime binding target ${surface}.`,
      "PRECONDITION_FAILED",
      {
        collection,
        key,
        field,
        surface,
      },
    );
  });
}

export function createRuntimeCredentialBindingId(input: {
  kind: string;
  target: string;
  broker_source_ref: string;
}): string {
  return `rcb_${createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 12)}`;
}

function deriveRuntimeCredentialBindingsFromLegacyRecord(
  record: Record<string, unknown>,
): RuntimeCredentialBindingDocument[] | undefined {
  const envBindings =
    parseContainedSecretEnvBindings(record, "contained_secret_env_bindings", "runtime_profiles", "legacy") ?? [];
  const fileBindings =
    parseContainedSecretFileBindings(record, "contained_secret_file_bindings", "runtime_profiles", "legacy") ?? [];
  const migrated = [
    ...envBindings.map((binding) => ({
      binding_id: createRuntimeCredentialBindingId({
        kind: "env",
        target: `env:${binding.env_key}`,
        broker_source_ref: binding.secret_id,
      }),
      kind: "env" as const,
      target: {
        surface: "env" as const,
        env_key: binding.env_key,
      },
      broker_source_ref: binding.secret_id,
      redacted_delivery_metadata: {
        legacy_migrated_from: "contained_secret_env_bindings",
      },
      rotates: true,
    })),
    ...fileBindings.map((binding) => ({
      binding_id: createRuntimeCredentialBindingId({
        kind: "file",
        target: `file:${binding.relative_path}`,
        broker_source_ref: binding.secret_id,
      }),
      kind: "file" as const,
      target: {
        surface: "file" as const,
        relative_path: binding.relative_path,
      },
      broker_source_ref: binding.secret_id,
      redacted_delivery_metadata: {
        legacy_migrated_from: "contained_secret_file_bindings",
      },
      rotates: true,
    })),
  ];

  return migrated.length > 0 ? migrated : undefined;
}

interface ProductStatePaths {
  config_root: string;
  state_root: string;
  db_path: string;
  backup_root: string;
  demo_root: string;
}

function failClosedFutureVersion(collection: string, key: string, schemaVersion: number): never {
  throw new AgentGitError(
    `Stored ${collection} document ${key} uses future schema version ${schemaVersion}. Run agentgit setup --repair after upgrading.`,
    "PRECONDITION_FAILED",
    {
      collection,
      key,
      schema_version: schemaVersion,
      supported_schema_version: CURRENT_SCHEMA_VERSION,
      recommended_command: "agentgit setup --repair",
    },
  );
}

function hashWorkspaceRoot(workspaceRoot: string): string {
  return createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 12);
}

function defaultProductConfigRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.AGENTGIT_CLI_CONFIG_ROOT?.trim();
  if (configured) {
    return path.resolve(configured);
  }

  const xdgRoot = env.XDG_CONFIG_HOME?.trim();
  if (xdgRoot) {
    return path.resolve(xdgRoot, "agentgit");
  }

  return path.resolve(os.homedir(), ".config", "agentgit");
}

export function resolveProductStatePaths(env: NodeJS.ProcessEnv = process.env): ProductStatePaths {
  const configRoot = defaultProductConfigRoot(env);
  const stateRoot = path.join(configRoot, PRODUCT_STATE_DIR);
  return {
    config_root: configRoot,
    state_root: stateRoot,
    db_path: path.join(stateRoot, PRODUCT_STATE_DB_NAME),
    backup_root: path.join(stateRoot, "backups"),
    demo_root: path.join(stateRoot, "demos"),
  };
}

function expectObject(value: unknown, collection: string, key: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentGitError(`Stored ${collection} document ${key} is not an object.`, "PRECONDITION_FAILED", {
      collection,
      key,
    });
  }

  return value as Record<string, unknown>;
}

function expectString(
  record: Record<string, unknown>,
  field: string,
  collection: string,
  key: string,
  options: { optional?: boolean } = {},
): string | undefined {
  const value = record[field];
  if (value === undefined || value === null) {
    if (options.optional) {
      return undefined;
    }
    throw new AgentGitError(`Stored ${collection} document ${key} is missing ${field}.`, "PRECONDITION_FAILED", {
      collection,
      key,
      field,
    });
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new AgentGitError(`Stored ${collection} document ${key} has invalid ${field}.`, "PRECONDITION_FAILED", {
      collection,
      key,
      field,
    });
  }

  return value;
}

function expectStringArray(record: Record<string, unknown>, field: string, collection: string, key: string): string[] {
  const value = record[field];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new AgentGitError(`Stored ${collection} document ${key} has invalid ${field}.`, "PRECONDITION_FAILED", {
      collection,
      key,
      field,
    });
  }

  return [...value];
}

function expectNumber(record: Record<string, unknown>, field: string, collection: string, key: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AgentGitError(`Stored ${collection} document ${key} has invalid ${field}.`, "PRECONDITION_FAILED", {
      collection,
      key,
      field,
    });
  }

  return value;
}

function normalizeDocumentBase(
  collection: string,
  key: string,
  record: Record<string, unknown>,
): ProductStateDocument & Record<string, unknown> {
  const schemaVersion =
    record.schema_version === undefined ? 0 : expectNumber(record, "schema_version", collection, key);
  if (schemaVersion > CURRENT_SCHEMA_VERSION) {
    failClosedFutureVersion(collection, key, schemaVersion);
  }

  const createdAt =
    typeof record.created_at === "string" && record.created_at.length > 0
      ? record.created_at
      : "2026-04-02T00:00:00.000Z";
  const updatedAt =
    typeof record.updated_at === "string" && record.updated_at.length > 0 ? record.updated_at : createdAt;

  return {
    ...record,
    schema_version: CURRENT_SCHEMA_VERSION,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function parseRuntimeProfile(key: string, value: unknown): RuntimeProfileDocument {
  const base = normalizeDocumentBase("runtime_profiles", key, expectObject(value, "runtime_profiles", key));
  const assuranceLevel = expectString(base, "assurance_level", "runtime_profiles", key, { optional: true });
  const governanceMode = expectString(base, "governance_mode", "runtime_profiles", key, { optional: true });
  const guarantees =
    base.guarantees === undefined
      ? deriveGuaranteesFromRecord(base)
      : (expectStringArray(base, "guarantees", "runtime_profiles", key) as GovernanceGuarantee[]);
  const degradedReasons =
    base.degraded_reasons === undefined ? [] : expectStringArray(base, "degraded_reasons", "runtime_profiles", key);
  const credentialPassthroughEnvKeys =
    base.credential_passthrough_env_keys === undefined
      ? undefined
      : expectStringArray(base, "credential_passthrough_env_keys", "runtime_profiles", key);
  const runtimeCredentialBindings =
    parseRuntimeCredentialBindings(base, "runtime_credential_bindings", "runtime_profiles", key) ??
    deriveRuntimeCredentialBindingsFromLegacyRecord(base);
  return {
    profile_id: expectString(base, "profile_id", "runtime_profiles", key)!,
    workspace_root: expectString(base, "workspace_root", "runtime_profiles", key)!,
    runtime_id: expectString(base, "runtime_id", "runtime_profiles", key)! as RuntimeProfileDocument["runtime_id"],
    launch_command: expectString(base, "launch_command", "runtime_profiles", key)!,
    integration_method: expectString(
      base,
      "integration_method",
      "runtime_profiles",
      key,
    )! as RuntimeProfileDocument["integration_method"],
    install_scope: expectString(
      base,
      "install_scope",
      "runtime_profiles",
      key,
    )! as RuntimeProfileDocument["install_scope"],
    assurance_level: (assuranceLevel ?? DEFAULT_ASSURANCE_LEVEL) as AssuranceLevel,
    governance_mode: (governanceMode ?? deriveGovernanceModeFromRecord(base)) as GovernanceMode,
    guarantees,
    execution_mode: (expectString(base, "execution_mode", "runtime_profiles", key, {
      optional: true,
    }) ?? DEFAULT_EXECUTION_MODE) as RuntimeProfileDocument["execution_mode"],
    governed_surfaces: expectStringArray(base, "governed_surfaces", "runtime_profiles", key),
    degraded_reasons: degradedReasons,
    default_checkpoint_policy: deriveCheckpointPolicyFromRecord(base),
    checkpoint_intent: deriveCheckpointIntentFromRecord(base),
    checkpoint_reason_template: expectString(base, "checkpoint_reason_template", "runtime_profiles", key, {
      optional: true,
    }),
    containment_backend: expectString(base, "containment_backend", "runtime_profiles", key, { optional: true }) as
      | RuntimeProfileDocument["containment_backend"]
      | undefined,
    container_image: expectString(base, "container_image", "runtime_profiles", key, { optional: true }),
    container_network_policy: (expectString(base, "container_network_policy", "runtime_profiles", key, {
      optional: true,
    }) ?? DEFAULT_CONTAINER_NETWORK_POLICY) as RuntimeProfileDocument["container_network_policy"],
    contained_egress_mode: deriveContainedEgressModeFromRecord(base),
    contained_egress_assurance: deriveContainedEgressAssuranceFromRecord(base),
    contained_credential_mode:
      normalizeContainedCredentialMode(
        expectString(base, "contained_credential_mode", "runtime_profiles", key, {
          optional: true,
        }),
      ) ?? DEFAULT_CONTAINED_CREDENTIAL_MODE,
    runtime_credential_bindings: runtimeCredentialBindings,
    credential_passthrough_env_keys: credentialPassthroughEnvKeys,
    contained_secret_env_bindings: parseContainedSecretEnvBindings(
      base,
      "contained_secret_env_bindings",
      "runtime_profiles",
      key,
    ),
    contained_secret_file_bindings: parseContainedSecretFileBindings(
      base,
      "contained_secret_file_bindings",
      "runtime_profiles",
      key,
    ),
    contained_proxy_allowlist_hosts:
      base.contained_proxy_allowlist_hosts === undefined
        ? undefined
        : expectStringArray(base, "contained_proxy_allowlist_hosts", "runtime_profiles", key),
    capability_snapshot:
      base.capability_snapshot &&
      typeof base.capability_snapshot === "object" &&
      !Array.isArray(base.capability_snapshot)
        ? (base.capability_snapshot as DockerCapabilitySnapshot)
        : deriveCapabilitySnapshotFromRecord(base),
    schema_version: CURRENT_SCHEMA_VERSION,
    created_at: base.created_at,
    updated_at: base.updated_at,
    runtime_display_name: expectString(base, "runtime_display_name", "runtime_profiles", key, { optional: true }),
    runtime_config_path: expectString(base, "runtime_config_path", "runtime_profiles", key, { optional: true }),
    last_run_id: expectString(base, "last_run_id", "runtime_profiles", key, { optional: true }),
    adapter_metadata:
      base.adapter_metadata && typeof base.adapter_metadata === "object" && !Array.isArray(base.adapter_metadata)
        ? (base.adapter_metadata as Record<string, unknown>)
        : undefined,
  };
}

function parseAppliedMutation(
  collection: string,
  key: string,
  value: unknown,
): RuntimeInstallDocument["applied_mutations"][number] {
  const record = expectObject(value, collection, key);
  return {
    type: expectString(record, "type", collection, key)! as RuntimeInstallDocument["applied_mutations"][number]["type"],
    config_file_path: expectString(record, "config_file_path", collection, key)!,
    path: expectString(record, "path", collection, key)!,
    previous_value: record.previous_value,
    applied_value: record.applied_value,
    target_digest_after: expectString(record, "target_digest_after", collection, key, { optional: true }),
  };
}

function parseRuntimeInstall(key: string, value: unknown): RuntimeInstallDocument {
  const base = normalizeDocumentBase("runtime_installs", key, expectObject(value, "runtime_installs", key));
  const appliedMutations = Array.isArray(base.applied_mutations)
    ? base.applied_mutations.map((entry) => parseAppliedMutation("runtime_installs", key, entry))
    : [];
  const assuranceLevel = expectString(base, "assurance_level", "runtime_installs", key, { optional: true });
  const governanceMode = expectString(base, "governance_mode", "runtime_installs", key, { optional: true });
  const runtimeCredentialBindings =
    parseRuntimeCredentialBindings(base, "runtime_credential_bindings", "runtime_installs", key) ??
    deriveRuntimeCredentialBindingsFromLegacyRecord(base);
  const guarantees =
    base.guarantees === undefined
      ? deriveGuaranteesFromRecord(base)
      : (expectStringArray(base, "guarantees", "runtime_installs", key) as GovernanceGuarantee[]);
  return {
    install_id: expectString(base, "install_id", "runtime_installs", key)!,
    profile_id: expectString(base, "profile_id", "runtime_installs", key)!,
    runtime_id: expectString(base, "runtime_id", "runtime_installs", key)! as RuntimeInstallDocument["runtime_id"],
    workspace_root: expectString(base, "workspace_root", "runtime_installs", key)!,
    install_scope: expectString(
      base,
      "install_scope",
      "runtime_installs",
      key,
    )! as RuntimeInstallDocument["install_scope"],
    plan_digest: expectString(base, "plan_digest", "runtime_installs", key)!,
    applied_mutations: appliedMutations,
    status: expectString(base, "status", "runtime_installs", key)! as RuntimeInstallDocument["status"],
    integration_method: expectString(
      base,
      "integration_method",
      "runtime_installs",
      key,
    )! as RuntimeInstallDocument["integration_method"],
    assurance_level: (assuranceLevel ?? DEFAULT_ASSURANCE_LEVEL) as AssuranceLevel,
    governance_mode: (governanceMode ?? deriveGovernanceModeFromRecord(base)) as GovernanceMode,
    guarantees,
    execution_mode: (expectString(base, "execution_mode", "runtime_installs", key, {
      optional: true,
    }) ?? DEFAULT_EXECUTION_MODE) as RuntimeInstallDocument["execution_mode"],
    default_checkpoint_policy: deriveCheckpointPolicyFromRecord(base),
    checkpoint_intent: deriveCheckpointIntentFromRecord(base),
    checkpoint_reason_template: expectString(base, "checkpoint_reason_template", "runtime_installs", key, {
      optional: true,
    }),
    containment_backend: expectString(base, "containment_backend", "runtime_installs", key, { optional: true }) as
      | RuntimeInstallDocument["containment_backend"]
      | undefined,
    container_network_policy: (expectString(base, "container_network_policy", "runtime_installs", key, {
      optional: true,
    }) ?? DEFAULT_CONTAINER_NETWORK_POLICY) as RuntimeInstallDocument["container_network_policy"],
    contained_egress_mode: deriveContainedEgressModeFromRecord(base),
    contained_egress_assurance: deriveContainedEgressAssuranceFromRecord(base),
    contained_credential_mode:
      normalizeContainedCredentialMode(
        expectString(base, "contained_credential_mode", "runtime_installs", key, {
          optional: true,
        }),
      ) ?? DEFAULT_CONTAINED_CREDENTIAL_MODE,
    runtime_credential_bindings: runtimeCredentialBindings,
    contained_secret_env_bindings: parseContainedSecretEnvBindings(
      base,
      "contained_secret_env_bindings",
      "runtime_installs",
      key,
    ),
    contained_secret_file_bindings: parseContainedSecretFileBindings(
      base,
      "contained_secret_file_bindings",
      "runtime_installs",
      key,
    ),
    contained_proxy_allowlist_hosts:
      base.contained_proxy_allowlist_hosts === undefined
        ? undefined
        : expectStringArray(base, "contained_proxy_allowlist_hosts", "runtime_installs", key),
    config_path: expectString(base, "config_path", "runtime_installs", key, { optional: true }),
    capability_snapshot:
      base.capability_snapshot &&
      typeof base.capability_snapshot === "object" &&
      !Array.isArray(base.capability_snapshot)
        ? (base.capability_snapshot as DockerCapabilitySnapshot)
        : deriveCapabilitySnapshotFromRecord(base),
    schema_version: CURRENT_SCHEMA_VERSION,
    created_at: base.created_at,
    updated_at: base.updated_at,
  };
}

function parseConfigBackup(key: string, value: unknown): ConfigBackupDocument {
  const base = normalizeDocumentBase("config_backups", key, expectObject(value, "config_backups", key));
  return {
    backup_id: expectString(base, "backup_id", "config_backups", key)!,
    workspace_root: expectString(base, "workspace_root", "config_backups", key)!,
    target_path: expectString(base, "target_path", "config_backups", key)!,
    target_existed_before: typeof base.target_existed_before === "boolean" ? base.target_existed_before : undefined,
    target_digest_before: expectString(base, "target_digest_before", "config_backups", key)!,
    backup_path: expectString(base, "backup_path", "config_backups", key)!,
    schema_version: CURRENT_SCHEMA_VERSION,
    created_at: base.created_at,
    updated_at: base.updated_at,
  };
}

function parseDemoRun(key: string, value: unknown): DemoRunDocument {
  const base = normalizeDocumentBase("demo_runs", key, expectObject(value, "demo_runs", key));
  return {
    demo_run_id: expectString(base, "demo_run_id", "demo_runs", key)!,
    workspace_root: expectString(base, "workspace_root", "demo_runs", key)!,
    demo_workspace_root: expectString(base, "demo_workspace_root", "demo_runs", key)!,
    run_id: expectString(base, "run_id", "demo_runs", key)!,
    dangerous_action_id: expectString(base, "dangerous_action_id", "demo_runs", key)!,
    restore_boundary_id: expectString(base, "restore_boundary_id", "demo_runs", key)!,
    deleted_path: expectString(base, "deleted_path", "demo_runs", key)!,
    schema_version: CURRENT_SCHEMA_VERSION,
    created_at: base.created_at,
    updated_at: base.updated_at,
  };
}

function parseRestoreTarget(
  collection: string,
  key: string,
  value: unknown,
): RestoreShortcutDocument["preferred_restore_target"] {
  const record = expectObject(value, collection, key);
  const type = expectString(record, "type", collection, key)!;
  if (type === "path_subset") {
    return {
      type: "path_subset",
      snapshot_id: expectString(record, "snapshot_id", collection, key)!,
      paths: expectStringArray(record, "paths", collection, key),
    };
  }

  if (type === "action_boundary") {
    return {
      type: "action_boundary",
      action_id: expectString(record, "action_id", collection, key)!,
    };
  }

  if (type === "snapshot_id") {
    return {
      type: "snapshot_id",
      snapshot_id: expectString(record, "snapshot_id", collection, key)!,
    };
  }

  throw new AgentGitError(
    `Stored ${collection} document ${key} has unsupported restore target ${type}.`,
    "PRECONDITION_FAILED",
    {
      collection,
      key,
      type,
    },
  );
}

function parseRestoreShortcut(key: string, value: unknown): RestoreShortcutDocument {
  const base = normalizeDocumentBase("restore_shortcuts", key, expectObject(value, "restore_shortcuts", key));
  return {
    shortcut_id: expectString(base, "shortcut_id", "restore_shortcuts", key)!,
    workspace_root: expectString(base, "workspace_root", "restore_shortcuts", key)!,
    governed_workspace_root: expectString(base, "governed_workspace_root", "restore_shortcuts", key)!,
    run_id: expectString(base, "run_id", "restore_shortcuts", key)!,
    action_id: expectString(base, "action_id", "restore_shortcuts", key)!,
    preferred_restore_target: parseRestoreTarget("restore_shortcuts", key, base.preferred_restore_target),
    restore_boundary_id: expectString(base, "restore_boundary_id", "restore_shortcuts", key)!,
    display_path: expectString(base, "display_path", "restore_shortcuts", key, { optional: true }),
    schema_version: CURRENT_SCHEMA_VERSION,
    created_at: base.created_at,
    updated_at: base.updated_at,
  };
}

function parseRunCheckpoint(key: string, value: unknown): RunCheckpointDocument {
  const base = normalizeDocumentBase("run_checkpoints", key, expectObject(value, "run_checkpoints", key));
  return {
    checkpoint_id: expectString(base, "checkpoint_id", "run_checkpoints", key)!,
    workspace_root: expectString(base, "workspace_root", "run_checkpoints", key)!,
    governed_workspace_root: expectString(base, "governed_workspace_root", "run_checkpoints", key)!,
    run_id: expectString(base, "run_id", "run_checkpoints", key)!,
    run_checkpoint: expectString(base, "run_checkpoint", "run_checkpoints", key)!,
    snapshot_id: expectString(base, "snapshot_id", "run_checkpoints", key)!,
    sequence: expectNumber(base, "sequence", "run_checkpoints", key),
    checkpoint_kind: expectString(
      base,
      "checkpoint_kind",
      "run_checkpoints",
      key,
    )! as RunCheckpointDocument["checkpoint_kind"],
    trigger:
      expectString(base, "trigger", "run_checkpoints", key, { optional: true }) === "default_policy"
        ? "default_policy"
        : "explicit_run_flag",
    checkpoint_policy: expectString(base, "checkpoint_policy", "run_checkpoints", key, { optional: true }) as
      | RunCheckpointDocument["checkpoint_policy"]
      | undefined,
    checkpoint_intent: expectString(base, "checkpoint_intent", "run_checkpoints", key, { optional: true }) as
      | RunCheckpointDocument["checkpoint_intent"]
      | undefined,
    reason: expectString(base, "reason", "run_checkpoints", key, { optional: true }),
    schema_version: CURRENT_SCHEMA_VERSION,
    created_at: base.created_at,
    updated_at: base.updated_at,
  };
}

function parseContainedRun(key: string, value: unknown): ContainedRunDocument {
  const base = normalizeDocumentBase("contained_runs", key, expectObject(value, "contained_runs", key));
  const runtimeCredentialBindings =
    parseRuntimeCredentialBindings(base, "runtime_credential_bindings", "contained_runs", key) ??
    deriveRuntimeCredentialBindingsFromLegacyRecord(base);
  return {
    contained_run_id: expectString(base, "contained_run_id", "contained_runs", key)!,
    workspace_root: expectString(base, "workspace_root", "contained_runs", key)!,
    run_id: expectString(base, "run_id", "contained_runs", key)!,
    projection_root: expectString(base, "projection_root", "contained_runs", key)!,
    baseline_manifest_path: expectString(base, "baseline_manifest_path", "contained_runs", key)!,
    status: expectString(base, "status", "contained_runs", key)! as ContainedRunDocument["status"],
    launch_command: expectString(base, "launch_command", "contained_runs", key)!,
    container_image: expectString(base, "container_image", "contained_runs", key)!,
    container_network_policy: (expectString(base, "container_network_policy", "contained_runs", key, {
      optional: true,
    }) ?? DEFAULT_CONTAINER_NETWORK_POLICY) as ContainedRunDocument["container_network_policy"],
    contained_egress_mode: deriveContainedEgressModeFromRecord(base),
    contained_egress_assurance: deriveContainedEgressAssuranceFromRecord(base),
    contained_credential_mode:
      normalizeContainedCredentialMode(
        expectString(base, "contained_credential_mode", "contained_runs", key, {
          optional: true,
        }),
      ) ?? DEFAULT_CONTAINED_CREDENTIAL_MODE,
    runtime_credential_bindings: runtimeCredentialBindings,
    credential_passthrough_env_keys:
      base.credential_passthrough_env_keys === undefined
        ? undefined
        : expectStringArray(base, "credential_passthrough_env_keys", "contained_runs", key),
    contained_secret_env_bindings: parseContainedSecretEnvBindings(
      base,
      "contained_secret_env_bindings",
      "contained_runs",
      key,
    ),
    contained_secret_file_bindings: parseContainedSecretFileBindings(
      base,
      "contained_secret_file_bindings",
      "contained_runs",
      key,
    ),
    contained_proxy_allowlist_hosts:
      base.contained_proxy_allowlist_hosts === undefined
        ? undefined
        : expectStringArray(base, "contained_proxy_allowlist_hosts", "contained_runs", key),
    changed_paths: expectStringArray(base, "changed_paths", "contained_runs", key),
    conflicting_paths: expectStringArray(base, "conflicting_paths", "contained_runs", key),
    governed_action_ids: expectStringArray(base, "governed_action_ids", "contained_runs", key),
    publication_error: expectString(base, "publication_error", "contained_runs", key, { optional: true }),
    schema_version: CURRENT_SCHEMA_VERSION,
    created_at: base.created_at,
    updated_at: base.updated_at,
  };
}

function stampDocument<TDocument extends ProductStateDocument>(
  document: Omit<TDocument, keyof ProductStateDocument>,
  existing?: TDocument | null,
): TDocument {
  const now = new Date().toISOString();
  return {
    ...document,
    schema_version: CURRENT_SCHEMA_VERSION,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  } as TDocument;
}

export class ProductStateStore {
  readonly paths: ProductStatePaths;
  private readonly state: IntegrationState<ProductStateCollections>;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.paths = resolveProductStatePaths(env);
    fs.mkdirSync(this.paths.state_root, { recursive: true });
    fs.mkdirSync(this.paths.backup_root, { recursive: true });
    fs.mkdirSync(this.paths.demo_root, { recursive: true });
    this.state = new IntegrationState<ProductStateCollections>({
      dbPath: this.paths.db_path,
      collections: {
        runtime_profiles: { parse: parseRuntimeProfile },
        runtime_installs: { parse: parseRuntimeInstall },
        config_backups: { parse: parseConfigBackup },
        demo_runs: { parse: parseDemoRun },
        restore_shortcuts: { parse: parseRestoreShortcut },
        run_checkpoints: { parse: parseRunCheckpoint },
        contained_runs: { parse: parseContainedRun },
      },
    });
  }

  close(): void {
    this.state.close();
  }

  checkpointWal() {
    return this.state.checkpointWal();
  }

  getProfileForWorkspace(workspaceRoot: string): RuntimeProfileDocument | null {
    const profileId = buildWorkspaceProfileId(workspaceRoot);
    return this.state.get("runtime_profiles", profileId);
  }

  saveRuntimeProfile(document: Omit<RuntimeProfileDocument, keyof ProductStateDocument>): RuntimeProfileDocument {
    const existing = this.state.get("runtime_profiles", document.profile_id);
    return this.state.put("runtime_profiles", document.profile_id, stampDocument(document, existing));
  }

  listRuntimeInstalls(workspaceRoot: string): RuntimeInstallDocument[] {
    return this.state.list("runtime_installs", { workspace_root: workspaceRoot });
  }

  latestRuntimeInstall(workspaceRoot: string): RuntimeInstallDocument | null {
    return latestByUpdatedAt(this.listRuntimeInstalls(workspaceRoot));
  }

  saveRuntimeInstall(document: Omit<RuntimeInstallDocument, keyof ProductStateDocument>): RuntimeInstallDocument {
    const existing = this.state.get("runtime_installs", document.install_id);
    return this.state.put("runtime_installs", document.install_id, stampDocument(document, existing));
  }

  deleteRuntimeInstall(installId: string): boolean {
    return this.state.delete("runtime_installs", installId);
  }

  saveConfigBackup(document: Omit<ConfigBackupDocument, keyof ProductStateDocument>): ConfigBackupDocument {
    const existing = this.state.get("config_backups", document.backup_id);
    return this.state.put("config_backups", document.backup_id, stampDocument(document, existing));
  }

  listConfigBackups(workspaceRoot: string): ConfigBackupDocument[] {
    return this.state.list("config_backups", { workspace_root: workspaceRoot });
  }

  latestConfigBackup(workspaceRoot: string, targetPath: string): ConfigBackupDocument | null {
    const backups = this.state.list("config_backups", {
      workspace_root: workspaceRoot,
      target_path: targetPath,
    });
    return latestByUpdatedAt(backups);
  }

  deleteConfigBackup(backupId: string): boolean {
    return this.state.delete("config_backups", backupId);
  }

  saveDemoRun(document: Omit<DemoRunDocument, keyof ProductStateDocument>): DemoRunDocument {
    const existing = this.state.get("demo_runs", document.demo_run_id);
    return this.state.put("demo_runs", document.demo_run_id, stampDocument(document, existing));
  }

  listDemoRuns(workspaceRoot: string): DemoRunDocument[] {
    return this.state.list("demo_runs", { workspace_root: workspaceRoot });
  }

  latestDemoRun(workspaceRoot: string): DemoRunDocument | null {
    return latestByUpdatedAt(this.state.list("demo_runs", { workspace_root: workspaceRoot }));
  }

  deleteDemoRun(demoRunId: string): boolean {
    return this.state.delete("demo_runs", demoRunId);
  }

  saveRestoreShortcut(document: Omit<RestoreShortcutDocument, keyof ProductStateDocument>): RestoreShortcutDocument {
    const existing = this.state.get("restore_shortcuts", document.shortcut_id);
    return this.state.put("restore_shortcuts", document.shortcut_id, stampDocument(document, existing));
  }

  latestRestoreShortcut(workspaceRoot: string): RestoreShortcutDocument | null {
    return latestByUpdatedAt(this.state.list("restore_shortcuts", { workspace_root: workspaceRoot }));
  }

  listRestoreShortcuts(workspaceRoot: string): RestoreShortcutDocument[] {
    return this.state.list("restore_shortcuts", { workspace_root: workspaceRoot });
  }

  deleteRestoreShortcut(shortcutId: string): boolean {
    return this.state.delete("restore_shortcuts", shortcutId);
  }

  saveRunCheckpoint(document: Omit<RunCheckpointDocument, keyof ProductStateDocument>): RunCheckpointDocument {
    const existing = this.state.get("run_checkpoints", document.checkpoint_id);
    return this.state.put("run_checkpoints", document.checkpoint_id, stampDocument(document, existing));
  }

  listRunCheckpoints(workspaceRoot: string): RunCheckpointDocument[] {
    return this.state.list("run_checkpoints", { workspace_root: workspaceRoot });
  }

  latestRunCheckpoint(workspaceRoot: string): RunCheckpointDocument | null {
    return latestByUpdatedAt(this.state.list("run_checkpoints", { workspace_root: workspaceRoot }));
  }

  deleteRunCheckpoint(checkpointId: string): boolean {
    return this.state.delete("run_checkpoints", checkpointId);
  }

  saveContainedRun(document: Omit<ContainedRunDocument, keyof ProductStateDocument>): ContainedRunDocument {
    const existing = this.state.get("contained_runs", document.contained_run_id);
    return this.state.put("contained_runs", document.contained_run_id, stampDocument(document, existing));
  }

  listContainedRuns(workspaceRoot: string): ContainedRunDocument[] {
    return this.state.list("contained_runs", { workspace_root: workspaceRoot });
  }

  latestContainedRun(workspaceRoot: string): ContainedRunDocument | null {
    return latestByUpdatedAt(this.state.list("contained_runs", { workspace_root: workspaceRoot }));
  }

  deleteContainedRun(containedRunId: string): boolean {
    return this.state.delete("contained_runs", containedRunId);
  }

  deleteRuntimeProfile(profileId: string): boolean {
    return this.state.delete("runtime_profiles", profileId);
  }
}

export function buildWorkspaceProfileId(workspaceRoot: string): string {
  return `profile_${hashWorkspaceRoot(workspaceRoot)}`;
}

export function createInstallId(runtimeId: string): string {
  return `install_${runtimeId}_${randomUUID().replaceAll("-", "")}`;
}

export function createBackupId(targetPath: string): string {
  return `backup_${createHash("sha256").update(targetPath).digest("hex").slice(0, 12)}_${Date.now()}`;
}

export function createDemoRunId(workspaceRoot: string): string {
  return `demo_${hashWorkspaceRoot(workspaceRoot)}_${Date.now()}`;
}

export function createRestoreShortcutId(actionId: string): string {
  return `shortcut_${actionId}`;
}

export function createRunCheckpointId(runCheckpoint: string): string {
  return `checkpoint_${createHash("sha256").update(runCheckpoint).digest("hex").slice(0, 12)}`;
}

export function createContainedRunId(runId: string): string {
  return `contained_${runId}`;
}

export function createBackupFilePath(paths: ProductStatePaths, workspaceRoot: string, targetPath: string): string {
  const workspaceHash = hashWorkspaceRoot(workspaceRoot);
  const fileName = `${path.basename(targetPath)}.${Date.now()}.bak`;
  return path.join(paths.backup_root, workspaceHash, fileName);
}

export function createDemoWorkspaceRoot(paths: ProductStatePaths, workspaceRoot: string): string {
  return path.join(paths.demo_root, hashWorkspaceRoot(workspaceRoot), "workspace");
}

export function createContainedRunRoot(paths: ProductStatePaths, workspaceRoot: string, runId: string): string {
  return path.join(paths.state_root, "contained", hashWorkspaceRoot(workspaceRoot), runId);
}

export function fileDigest(targetPath: string): string {
  if (!fs.existsSync(targetPath)) {
    return createHash("sha256").update("").digest("hex");
  }

  return createHash("sha256").update(fs.readFileSync(targetPath)).digest("hex");
}

function latestByUpdatedAt<TDocument extends ProductStateDocument>(documents: TDocument[]): TDocument | null {
  if (documents.length === 0) {
    return null;
  }

  return [...documents].sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0] ?? null;
}
