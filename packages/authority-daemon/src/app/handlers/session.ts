import type { RequestContext } from "@agentgit/core-ports";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { SessionCredentialBroker } from "@agentgit/credential-broker";
import {
  extractContainerRegistryHost,
  isContainerRegistryAllowed,
  isDigestPinnedContainerImage,
  type McpPublicHostPolicyRegistry,
  type McpServerRegistry,
} from "@agentgit/mcp-registry";
import type { RunJournal } from "@agentgit/run-journal";
import {
  DiagnosticsRequestPayloadSchema,
  type DiagnosticsResponsePayload,
  GetCapabilitiesRequestPayloadSchema,
  type GetCapabilitiesResponsePayload,
  type McpServerDefinition,
  type McpServerRegistrationRecord,
  type ReasonDetail,
  type RequestEnvelope,
  type ResponseEnvelope,
  validate,
} from "@agentgit/schemas";

import { primaryCapabilityReason, primaryStorageReason, resolveCapabilityRefreshStaleMs } from "../capabilities.js";
import { makeSuccessResponse } from "../response-helpers.js";
import type { ServiceOptions } from "../types.js";
import type { HostedExecutionQueue } from "../../hosted-execution-queue.js";
import type { HostedMcpWorkerClient } from "../../hosted-worker-client.js";
import type { PolicyRuntimeState } from "../../policy-runtime.js";
import type { AuthorityState } from "../../state.js";
import type { LatencyMetricsStore } from "../../latency-metrics.js";

type RegisteredStdioMcpServer = McpServerRegistrationRecord & {
  server: Extract<McpServerDefinition, { transport: "stdio" }>;
};

type RegisteredStreamableHttpMcpServer = McpServerRegistrationRecord & {
  server: Extract<McpServerDefinition, { transport: "streamable_http" }>;
};

function isRegisteredStdioMcpServer(record: McpServerRegistrationRecord): record is RegisteredStdioMcpServer {
  return record.server.transport === "stdio";
}

function isRegisteredStreamableHttpMcpServer(
  record: McpServerRegistrationRecord,
): record is RegisteredStreamableHttpMcpServer {
  return record.server.transport === "streamable_http";
}

function canAccessPath(targetPath: string, mode: number): boolean {
  try {
    fs.accessSync(targetPath, mode);
    return true;
  } catch {
    return false;
  }
}

function canWriteDirectoryOrCreate(targetPath: string): boolean {
  if (fs.existsSync(targetPath)) {
    try {
      return fs.statSync(targetPath).isDirectory() && canAccessPath(targetPath, fs.constants.W_OK);
    } catch {
      return false;
    }
  }

  return canAccessPath(path.dirname(targetPath), fs.constants.W_OK);
}

function commandExists(command: string): boolean {
  const searchPath = (process.env.PATH ?? "").split(path.delimiter);
  for (const candidateDir of searchPath) {
    if (candidateDir.trim().length === 0) {
      continue;
    }

    if (fs.existsSync(path.join(candidateDir, command))) {
      return true;
    }
  }

  return false;
}

function probeContainerRuntime(runtime: "docker" | "podman"): { usable: boolean; reason: string | null } {
  if (!commandExists(runtime)) {
    return {
      usable: false,
      reason: `${runtime} CLI is not installed.`,
    };
  }

  const result = spawnSync(runtime, ["info"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 2_000,
  });
  if (result.error) {
    return {
      usable: false,
      reason: result.error.message,
    };
  }

  if (result.status !== 0) {
    return {
      usable: false,
      reason: result.stderr.trim() || `${runtime} info exited with status ${result.status}.`,
    };
  }

  return {
    usable: true,
    reason: null,
  };
}

function detectMcpSecurityState(
  broker: SessionCredentialBroker,
  runtimeOptions: Pick<ServiceOptions, "mcpConcurrencyLeasePath">,
  mcpRegistry: McpServerRegistry,
  publicHostPolicyRegistry: McpPublicHostPolicyRegistry,
) {
  const credentialStoreDetails = broker.durableSecretStorageDetails();
  const credentialBrokerMode = broker.durableSecretStorageMode();
  const durableSecretStorageAvailable = broker.supportsDurableSecretStorage();
  const registeredMcpServers = mcpRegistry.listServers();
  const registeredStdioServers = registeredMcpServers.filter(isRegisteredStdioMcpServer);
  const registeredStreamableHttpServers = registeredMcpServers.filter(isRegisteredStreamableHttpMcpServer);
  const dockerRuntime = probeContainerRuntime("docker");
  const podmanRuntime = probeContainerRuntime("podman");
  const stdioSandboxIssues: string[] = [];
  const stdioDegradedServers: string[] = [];
  const stdioFallbackServers: string[] = [];
  const stdioProductionReadyServers: string[] = [];
  const stdioUnconfiguredServers: string[] = [];
  const stdioDigestPinnedServers: string[] = [];
  const stdioMutableTagServers: string[] = [];
  const stdioLocalBuildServers: string[] = [];
  const stdioRegistryPolicyServers: string[] = [];
  const stdioSignatureVerificationServers: string[] = [];
  const stdioProvenanceAttestationServers: string[] = [];
  const ociRuntimeUsable = dockerRuntime.usable || podmanRuntime.usable;
  const preferredProductionMode = "oci_container";
  const localDevFallbackMode = null;

  const currentHostMode = ociRuntimeUsable ? "oci_container_ready" : "oci_runtime_required";
  const currentHostModeReason = ociRuntimeUsable
    ? dockerRuntime.usable
      ? "Docker is usable on this host for OCI sandboxing."
      : "Podman is usable on this host for OCI sandboxing."
    : process.platform === "win32"
      ? "Windows requires Docker Desktop with WSL2 or Podman machine for OCI sandboxing; no native host-process fallback is supported."
      : "No usable OCI runtime is available on this host. Governed stdio MCP execution requires OCI sandboxing.";

  for (const record of registeredStdioServers) {
    const sandbox = record.server.sandbox;
    const sandboxType = sandbox?.type ?? "none";
    if (sandboxType === "oci_container") {
      const runtime = sandbox?.type === "oci_container" ? (sandbox.runtime ?? "docker") : "docker";
      const runtimeProbe = runtime === "podman" ? podmanRuntime : dockerRuntime;
      if (!runtimeProbe.usable) {
        stdioDegradedServers.push(record.server.server_id);
        stdioSandboxIssues.push(
          `${record.server.server_id} requires ${runtime} OCI sandboxing, but the runtime is not usable${runtimeProbe.reason ? `: ${runtimeProbe.reason}` : "."}`,
        );
      } else {
        if (sandbox?.type === "oci_container" && sandbox.build) {
          stdioLocalBuildServers.push(record.server.server_id);
          stdioSandboxIssues.push(
            `${record.server.server_id} is configured with oci_container.build for local development; publish a pinned, signed image from an allowed registry before production rollout.`,
          );
        } else if (sandbox?.type === "oci_container" && isDigestPinnedContainerImage(sandbox.image)) {
          stdioDigestPinnedServers.push(record.server.server_id);
          const allowedRegistries = sandbox.allowed_registries ?? [];
          if (allowedRegistries.length > 0 && isContainerRegistryAllowed(sandbox.image, allowedRegistries)) {
            stdioRegistryPolicyServers.push(record.server.server_id);
            if (sandbox.signature_verification) {
              stdioSignatureVerificationServers.push(record.server.server_id);
              if (sandbox.signature_verification.require_slsa_provenance !== false) {
                stdioProvenanceAttestationServers.push(record.server.server_id);
                stdioProductionReadyServers.push(record.server.server_id);
              } else {
                stdioSandboxIssues.push(
                  `${record.server.server_id} verifies OCI signatures but does not require SLSA provenance attestations; enable provenance verification before production rollout.`,
                );
              }
            } else {
              stdioSandboxIssues.push(
                `${record.server.server_id} is missing OCI signature_verification policy and cannot meet the production trust bar.`,
              );
            }
          } else {
            stdioSandboxIssues.push(
              `${record.server.server_id} is missing an allowed_registries policy for ${extractContainerRegistryHost(sandbox.image)}.`,
            );
          }
        } else {
          stdioMutableTagServers.push(record.server.server_id);
          stdioSandboxIssues.push(
            `${record.server.server_id} uses an OCI image without a pinned sha256 digest; pin container images before production rollout.`,
          );
        }
      }
      continue;
    }

    stdioDegradedServers.push(record.server.server_id);
    stdioUnconfiguredServers.push(record.server.server_id);
    stdioSandboxIssues.push(
      `${record.server.server_id} has no explicit stdio sandbox configuration; configure oci_container before registering it for governed execution.`,
    );
  }

  const protectedStdioServerCount = registeredStdioServers.length - stdioDegradedServers.length;
  const streamableHttpMissingAuth = registeredStreamableHttpServers
    .filter((record) => record.server.auth?.type === "bearer_env")
    .filter((record) => {
      const envVar = record.server.auth?.type === "bearer_env" ? record.server.auth.bearer_env_var.trim() : "";
      return envVar.length > 0 && (process.env[envVar]?.trim() ?? "").length === 0;
    });
  const streamableHttpLegacyEnvAuthServers = registeredStreamableHttpServers.filter(
    (record) => record.server.auth?.type === "bearer_env",
  );
  const streamableHttpSecretRefServers = registeredStreamableHttpServers.filter(
    (record) => record.server.auth?.type === "bearer_secret_ref",
  );
  const streamableHttpMissingSecretRefs = streamableHttpSecretRefServers.filter((record) => {
    const auth = record.server.auth;
    return (
      auth?.type === "bearer_secret_ref" &&
      !broker.listMcpBearerSecrets().some((secret) => secret.secret_id === auth.secret_id)
    );
  });
  const publicHttpsPolicyMismatches = registeredStreamableHttpServers.filter((record) => {
    return (
      (record.server.network_scope ?? "loopback") === "public_https" &&
      publicHostPolicyRegistry.findPolicyForUrl(new URL(record.server.url)) === null
    );
  });

  return {
    credentialStoreDetails,
    credentialBrokerMode,
    durableSecretStorageAvailable,
    registeredMcpServers,
    registeredStdioServers,
    registeredStreamableHttpServers,
    dockerRuntime,
    podmanRuntime,
    ociRuntimeUsable,
    preferredProductionMode,
    localDevFallbackMode,
    currentHostMode,
    currentHostModeReason,
    stdioDegradedServers,
    stdioSandboxIssues,
    stdioFallbackServers,
    stdioProductionReadyServers,
    stdioUnconfiguredServers,
    stdioDigestPinnedServers,
    stdioMutableTagServers,
    stdioLocalBuildServers,
    stdioRegistryPolicyServers,
    stdioSignatureVerificationServers,
    stdioProvenanceAttestationServers,
    protectedStdioServerCount,
    streamableHttpMissingAuth,
    streamableHttpLegacyEnvAuthServers,
    streamableHttpSecretRefServers,
    streamableHttpMissingSecretRefs,
    publicHttpsPolicyMismatches,
    concurrencyLeasePath: runtimeOptions.mcpConcurrencyLeasePath ?? null,
  };
}

export function detectCapabilities(
  broker: SessionCredentialBroker,
  runtimeOptions: Pick<ServiceOptions, "socketPath" | "journalPath" | "snapshotRootPath" | "mcpConcurrencyLeasePath">,
  mcpRegistry: McpServerRegistry,
  publicHostPolicyRegistry: McpPublicHostPolicyRegistry,
  hostedWorkerClient: HostedMcpWorkerClient,
  workspaceRoot?: string,
): GetCapabilitiesResponsePayload {
  const startedAt = new Date().toISOString();
  const capabilities: GetCapabilitiesResponsePayload["capabilities"] = [];
  const degradedModeWarnings: string[] = [];
  const securityState = detectMcpSecurityState(broker, runtimeOptions, mcpRegistry, publicHostPolicyRegistry);

  const runtimeStorageWritable =
    canAccessPath(path.dirname(runtimeOptions.socketPath), fs.constants.W_OK) &&
    canAccessPath(path.dirname(runtimeOptions.journalPath), fs.constants.W_OK) &&
    canWriteDirectoryOrCreate(runtimeOptions.snapshotRootPath);
  capabilities.push({
    capability_name: "host.runtime_storage",
    status: runtimeStorageWritable ? "available" : "degraded",
    scope: "host",
    detected_at: startedAt,
    source: "authority_daemon",
    details: {
      socket_path: runtimeOptions.socketPath,
      journal_path: runtimeOptions.journalPath,
      snapshot_root_path: runtimeOptions.snapshotRootPath,
      writable: runtimeStorageWritable,
    },
  });
  if (!runtimeStorageWritable) {
    degradedModeWarnings.push(
      "Local runtime storage is not fully writable; daemon behavior may degrade or fail closed.",
    );
  }

  capabilities.push({
    capability_name: "host.credential_broker_mode",
    status: securityState.durableSecretStorageAvailable ? "available" : "degraded",
    scope: "host",
    detected_at: startedAt,
    source: "authority_daemon",
    details: {
      mode: securityState.credentialBrokerMode,
      secure_store: securityState.durableSecretStorageAvailable,
      encrypted_at_rest: securityState.durableSecretStorageAvailable,
      secret_expiry_enforced: true,
      rotation_metadata_tracked: true,
      key_provider: securityState.credentialStoreDetails?.provider ?? null,
      key_identifier: securityState.credentialStoreDetails?.key_identifier ?? null,
      legacy_key_path: securityState.credentialStoreDetails?.legacy_key_path ?? null,
      legacy_session_env_profiles_enabled: true,
    },
  });
  if (!securityState.durableSecretStorageAvailable) {
    degradedModeWarnings.push(
      "Credential brokering is operating without durable MCP secret storage; only legacy session environment profiles are available.",
    );
  }

  const ticketsConfigured = broker.hasProfile("tickets");
  capabilities.push({
    capability_name: "adapter.tickets_brokered_credentials",
    status: ticketsConfigured ? "available" : "unavailable",
    scope: "adapter",
    detected_at: startedAt,
    source: "session_env",
    details: {
      integration: "tickets",
      brokered_profile_configured: ticketsConfigured,
      required_env: ["AGENTGIT_TICKETS_BASE_URL", "AGENTGIT_TICKETS_BEARER_TOKEN"],
    },
  });
  if (!ticketsConfigured) {
    degradedModeWarnings.push(
      "Owned ticket mutations are unavailable until brokered ticket credentials are configured.",
    );
  }

  const mcpProfiles = mcpRegistry.listProfiles();
  const mcpBindings = mcpRegistry.listCredentialBindings();
  const registeredMcpToolCount = securityState.registeredMcpServers.reduce(
    (total, record) => total + record.server.tools.length,
    0,
  );
  const transportCounts = {
    stdio: securityState.registeredStdioServers.length,
    streamable_http: securityState.registeredStreamableHttpServers.length,
  };
  const streamableHttpNetworkScopes = [
    ...new Set(
      securityState.registeredStreamableHttpServers.map((record) =>
        record.server.transport === "streamable_http" ? (record.server.network_scope ?? "loopback") : "loopback",
      ),
    ),
  ];
  const bootstrapEnvServerCount = securityState.registeredMcpServers.filter(
    (record) => record.source === "bootstrap_env",
  ).length;
  const operatorManagedServerCount = securityState.registeredMcpServers.filter(
    (record) => record.source === "operator_api",
  ).length;

  capabilities.push({
    capability_name: "adapter.mcp_registry",
    status: "available",
    scope: "adapter",
    detected_at: startedAt,
    source: "mcp_registry",
    details: {
      registered_server_count: securityState.registeredMcpServers.length,
      registered_tool_count: registeredMcpToolCount,
      bootstrap_env_servers: bootstrapEnvServerCount,
      operator_managed_servers: operatorManagedServerCount,
      candidate_registry_available: true,
      server_profile_count: mcpProfiles.length,
      hosted_profile_count: mcpProfiles.filter((profile) =>
        profile.allowed_execution_modes.includes("hosted_delegated"),
      ).length,
      launch_scope: "local_operator_owned",
      transport_counts: transportCounts,
      streamable_http_network_scopes: streamableHttpNetworkScopes,
      registered_secret_count: broker.listMcpBearerSecrets().length,
      supported_auth_binding_modes: [
        "oauth_session",
        "derived_token",
        "bearer_secret_ref",
        "session_token",
        "hosted_token_exchange",
      ],
      degraded_credential_binding_ids: mcpBindings
        .filter((binding) => binding.status === "degraded")
        .map((binding) => binding.credential_binding_id),
      public_host_policy_count: publicHostPolicyRegistry.listPolicies().length,
      public_https_requirements: {
        https_only: true,
        bearer_secret_ref_recommended: true,
        supported_auth_types: ["bearer_secret_ref", "bearer_env"],
        disallowed_custom_headers: ["authorization", "proxy-authorization", "cookie"],
      },
    },
  });

  capabilities.push({
    capability_name: "adapter.mcp_hosted_delegated",
    status: hostedWorkerClient.available ? "available" : "degraded",
    scope: "adapter",
    detected_at: startedAt,
    source: "mcp_registry",
    details: {
      supported: true,
      hosted_delegated_execution_available: hostedWorkerClient.available,
      hosted_attestation_verification_available: hostedWorkerClient.available,
      worker_runtime_id: hostedWorkerClient.workerRuntimeId,
      worker_image_digest: hostedWorkerClient.workerImageDigest,
      worker_endpoint_kind: hostedWorkerClient.endpointKind,
      worker_endpoint: hostedWorkerClient.endpointLabel,
      worker_managed_by_daemon: hostedWorkerClient.managed,
      worker_control_plane_auth_required: hostedWorkerClient.controlPlaneAuthRequired,
      worker_last_error: hostedWorkerClient.lastError,
      active_profile_count: mcpProfiles.filter(
        (profile) => profile.status === "active" && profile.allowed_execution_modes.includes("hosted_delegated"),
      ).length,
      supported_auth_binding_modes: ["oauth_session", "derived_token", "bearer_secret_ref", "hosted_token_exchange"],
      degraded_binding_modes: ["session_token"],
    },
  });

  capabilities.push({
    capability_name: "adapter.mcp_streamable_http",
    status:
      securityState.streamableHttpMissingAuth.length > 0 ||
      securityState.streamableHttpMissingSecretRefs.length > 0 ||
      securityState.publicHttpsPolicyMismatches.length > 0 ||
      (securityState.streamableHttpSecretRefServers.length > 0 && !securityState.durableSecretStorageAvailable) ||
      securityState.streamableHttpLegacyEnvAuthServers.length > 0
        ? "degraded"
        : "available",
    scope: "adapter",
    detected_at: startedAt,
    source: "mcp_registry",
    details: {
      supported: true,
      launch_scope: "local_operator_owned",
      supported_network_scopes: ["loopback", "private", "public_https"],
      concurrency_limits_enforced: true,
      connect_time_dns_scope_validation: true,
      redirect_chain_revalidation: true,
      shared_sqlite_leases: true,
      lease_heartbeat_renewal: true,
      supported_auth_types: ["none", "bearer_secret_ref", "bearer_env"],
      durable_secret_storage_available: securityState.durableSecretStorageAvailable,
      public_https_requirements: {
        https_only: true,
        explicit_host_policy_required: true,
        bearer_secret_ref_recommended: true,
        disallowed_custom_headers: ["authorization", "proxy-authorization", "cookie"],
      },
      concurrency_lease_path: securityState.concurrencyLeasePath,
      legacy_bearer_env_servers: securityState.streamableHttpLegacyEnvAuthServers.map(
        (record) => record.server.server_id,
      ),
      missing_secret_ref_servers: securityState.streamableHttpMissingSecretRefs.map(
        (record) => record.server.server_id,
      ),
      missing_public_host_policy_servers: securityState.publicHttpsPolicyMismatches.map(
        (record) => record.server.server_id,
      ),
      registered_server_count: transportCounts.streamable_http,
      missing_bearer_env_servers: securityState.streamableHttpMissingAuth.map((record) => {
        if (record.server.transport !== "streamable_http") {
          return {
            server_id: record.server.server_id,
            bearer_env_var: null,
            network_scope: null,
            max_concurrent_calls: null,
          };
        }

        return {
          server_id: record.server.server_id,
          bearer_env_var: record.server.auth?.type === "bearer_env" ? record.server.auth.bearer_env_var : null,
          network_scope: record.server.network_scope ?? "loopback",
          max_concurrent_calls: record.server.max_concurrent_calls ?? 1,
        };
      }),
    },
  });

  capabilities.push({
    capability_name: "adapter.mcp_stdio_sandbox",
    status:
      securityState.stdioDegradedServers.length > 0 ||
      securityState.stdioMutableTagServers.length > 0 ||
      securityState.stdioLocalBuildServers.length > 0 ||
      securityState.stdioRegistryPolicyServers.length < securityState.stdioDigestPinnedServers.length ||
      securityState.stdioSignatureVerificationServers.length < securityState.stdioDigestPinnedServers.length ||
      securityState.stdioProvenanceAttestationServers.length < securityState.stdioSignatureVerificationServers.length
        ? "degraded"
        : "available",
    scope: "adapter",
    detected_at: startedAt,
    source: "mcp_registry",
    details: {
      protected_execution_required: true,
      preferred_production_mode: securityState.preferredProductionMode,
      local_dev_fallback_mode: securityState.localDevFallbackMode,
      current_host_mode: securityState.currentHostMode,
      current_host_mode_reason: securityState.currentHostModeReason,
      registered_server_count: securityState.registeredStdioServers.length,
      protected_server_count: securityState.protectedStdioServerCount,
      production_ready_server_count: securityState.stdioProductionReadyServers.length,
      digest_pinned_server_count: securityState.stdioDigestPinnedServers.length,
      mutable_tag_server_count: securityState.stdioMutableTagServers.length,
      local_build_server_count: securityState.stdioLocalBuildServers.length,
      registry_policy_server_count: securityState.stdioRegistryPolicyServers.length,
      signature_verification_server_count: securityState.stdioSignatureVerificationServers.length,
      provenance_attestation_server_count: securityState.stdioProvenanceAttestationServers.length,
      fallback_server_count: securityState.stdioFallbackServers.length,
      unconfigured_server_count: securityState.stdioUnconfiguredServers.length,
      macos_seatbelt_available: false,
      docker_runtime_usable: securityState.dockerRuntime.usable,
      podman_runtime_usable: securityState.podmanRuntime.usable,
      windows_plan: {
        supported_via_oci: true,
        recommended_runtime: "docker_desktop_wsl2_or_podman_machine",
        native_fallback_available: false,
        summary:
          "On Windows, use Docker Desktop with WSL2 or Podman machine for OCI sandboxing. No native host-process fallback is supported.",
      },
      degraded_servers: securityState.stdioDegradedServers,
    },
  });

  if (securityState.streamableHttpMissingAuth.length > 0) {
    degradedModeWarnings.push(
      `Some registered streamable_http MCP servers are missing required bearer token env vars: ${securityState.streamableHttpMissingAuth
        .map((record) => record.server.server_id)
        .join(", ")}.`,
    );
  }
  if (securityState.stdioMutableTagServers.length > 0) {
    degradedModeWarnings.push(
      `Some registered stdio MCP servers use OCI images without pinned digests: ${securityState.stdioMutableTagServers.join(", ")}.`,
    );
  }
  if (securityState.streamableHttpLegacyEnvAuthServers.length > 0) {
    degradedModeWarnings.push(
      `Some registered streamable_http MCP servers still use legacy bearer_env authentication instead of durable secret references: ${securityState.streamableHttpLegacyEnvAuthServers
        .map((record) => record.server.server_id)
        .join(", ")}.`,
    );
  }
  if (securityState.streamableHttpMissingSecretRefs.length > 0) {
    degradedModeWarnings.push(
      `Some registered streamable_http MCP servers reference missing durable secret records: ${securityState.streamableHttpMissingSecretRefs
        .map((record) => record.server.server_id)
        .join(", ")}.`,
    );
  }
  if (securityState.publicHttpsPolicyMismatches.length > 0) {
    degradedModeWarnings.push(
      `Some registered public_https MCP servers are missing an active host allowlist policy: ${securityState.publicHttpsPolicyMismatches
        .map((record) => record.server.server_id)
        .join(", ")}.`,
    );
  }
  degradedModeWarnings.push(...securityState.stdioSandboxIssues);

  if (workspaceRoot) {
    const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
    const exists = fs.existsSync(resolvedWorkspaceRoot);
    const isDirectory = exists ? fs.statSync(resolvedWorkspaceRoot).isDirectory() : false;
    const readable = exists && isDirectory ? canAccessPath(resolvedWorkspaceRoot, fs.constants.R_OK) : false;
    const writable = exists && isDirectory ? canAccessPath(resolvedWorkspaceRoot, fs.constants.W_OK) : false;
    const status = exists && isDirectory && readable && writable ? "available" : "unavailable";

    capabilities.push({
      capability_name: "workspace.root_access",
      status,
      scope: "workspace",
      detected_at: startedAt,
      source: "filesystem_probe",
      details: {
        workspace_root: resolvedWorkspaceRoot,
        exists,
        is_directory: isDirectory,
        readable,
        writable,
      },
    });
    if (status !== "available") {
      degradedModeWarnings.push(
        `Workspace root ${resolvedWorkspaceRoot} is not available for governed read/write access.`,
      );
    }
  }

  return {
    capabilities,
    detection_timestamps: {
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    },
    degraded_mode_warnings: [...new Set(degradedModeWarnings)],
  };
}

export function handleGetCapabilities(
  broker: SessionCredentialBroker,
  runtimeOptions: Pick<ServiceOptions, "socketPath" | "journalPath" | "snapshotRootPath" | "mcpConcurrencyLeasePath">,
  mcpRegistry: McpServerRegistry,
  publicHostPolicyRegistry: McpPublicHostPolicyRegistry,
  hostedWorkerClient: HostedMcpWorkerClient,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
): ResponseEnvelope<GetCapabilitiesResponsePayload> {
  const payload = validate(GetCapabilitiesRequestPayloadSchema, request.payload);
  return makeSuccessResponse(
    request.request_id,
    request.session_id,
    detectCapabilities(
      broker,
      runtimeOptions,
      mcpRegistry,
      publicHostPolicyRegistry,
      hostedWorkerClient,
      payload.workspace_root,
    ),
  );
}

export function handleDiagnostics(
  state: AuthorityState,
  journal: RunJournal,
  broker: SessionCredentialBroker,
  mcpRegistry: McpServerRegistry,
  publicHostPolicyRegistry: McpPublicHostPolicyRegistry,
  hostedWorkerClient: HostedMcpWorkerClient,
  hostedExecutionQueue: HostedExecutionQueue,
  latencyMetrics: LatencyMetricsStore,
  policyRuntime: PolicyRuntimeState,
  runtimeOptions: Pick<
    ServiceOptions,
    "capabilityRefreshStaleMs" | "socketPath" | "journalPath" | "snapshotRootPath" | "mcpConcurrencyLeasePath"
  >,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
): ResponseEnvelope<DiagnosticsResponsePayload> {
  const payload = validate(DiagnosticsRequestPayloadSchema, request.payload);
  const requestedSections = new Set(
    payload.sections ?? [
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
    ],
  );
  const overview = journal.getDiagnosticsOverview();
  const liveSecurityState = detectMcpSecurityState(broker, runtimeOptions, mcpRegistry, publicHostPolicyRegistry);
  const capabilityHealthWarnings: string[] = [];
  const capabilityMaintenanceWarnings: string[] = [];
  const capabilitySnapshot = overview.capability_snapshot;
  const capabilityRefreshStaleMs = resolveCapabilityRefreshStaleMs(runtimeOptions);
  const capabilityPrimaryReason = primaryCapabilityReason(capabilitySnapshot, capabilityRefreshStaleMs);
  const storagePrimaryReason = primaryStorageReason(overview);
  let capabilitySummaryWarnings: string[] = [];
  let capabilitySummaryRefreshedAt: string | null = null;
  let capabilitySummaryWorkspaceRoot: string | null = null;
  let capabilitySummaryCount = 0;
  let capabilitySummaryDegraded = 0;
  let capabilitySummaryUnavailable = 0;
  let capabilitySummaryIsStale = false;

  if (!capabilitySnapshot) {
    capabilityMaintenanceWarnings.push(
      "Capability state has not been refreshed durably yet; run capability_refresh to cache current host and workspace capability state.",
    );
  } else {
    const degradedCount = capabilitySnapshot.capabilities.filter(
      (capability) => capability.status === "degraded",
    ).length;
    const unavailableCount = capabilitySnapshot.capabilities.filter(
      (capability) => capability.status === "unavailable",
    ).length;
    const refreshedAtMillis = Date.parse(capabilitySnapshot.refreshed_at);
    capabilitySummaryWarnings = [...capabilitySnapshot.degraded_mode_warnings];
    capabilitySummaryRefreshedAt = capabilitySnapshot.refreshed_at;
    capabilitySummaryWorkspaceRoot = capabilitySnapshot.workspace_root;
    capabilitySummaryCount = capabilitySnapshot.capabilities.length;
    capabilitySummaryDegraded = degradedCount;
    capabilitySummaryUnavailable = unavailableCount;

    if (!Number.isNaN(refreshedAtMillis) && Date.now() - refreshedAtMillis > capabilityRefreshStaleMs) {
      capabilitySummaryIsStale = true;
      capabilityHealthWarnings.push(
        "Latest capability refresh is stale; rerun capability_refresh if the host or workspace may have changed.",
      );
    }

    if (degradedCount > 0 || unavailableCount > 0) {
      capabilityHealthWarnings.push(
        `Latest capability refresh reported ${degradedCount} degraded and ${unavailableCount} unavailable capability record(s).`,
      );
    }

    capabilityHealthWarnings.push(...capabilitySnapshot.degraded_mode_warnings);
  }

  const storageWarnings: string[] = [];
  if (overview.maintenance_status.degraded_artifact_capture_actions > 0) {
    storageWarnings.push(
      `${overview.maintenance_status.degraded_artifact_capture_actions} action(s) completed with degraded durable evidence capture.`,
    );
  }
  if (overview.maintenance_status.low_disk_pressure_signals > 0) {
    storageWarnings.push(
      `${overview.maintenance_status.low_disk_pressure_signals} low-disk pressure signal(s) were recorded while storing evidence.`,
    );
  }
  if (overview.maintenance_status.artifact_health.missing > 0) {
    storageWarnings.push(`${overview.maintenance_status.artifact_health.missing} artifact blob(s) are missing.`);
  }
  if (overview.maintenance_status.artifact_health.expired > 0) {
    storageWarnings.push(
      `${overview.maintenance_status.artifact_health.expired} artifact blob(s) have expired by retention policy.`,
    );
  }
  if (overview.maintenance_status.artifact_health.corrupted > 0) {
    storageWarnings.push(
      `${overview.maintenance_status.artifact_health.corrupted} artifact blob(s) are structurally corrupted.`,
    );
  }
  if (overview.maintenance_status.artifact_health.tampered > 0) {
    storageWarnings.push(
      `${overview.maintenance_status.artifact_health.tampered} artifact blob(s) failed integrity verification.`,
    );
  }

  const journalWarnings: string[] = [];
  if (storageWarnings.length > 0) {
    journalWarnings.push("Journal metadata is intact, but some durable execution evidence is unavailable or degraded.");
  }
  if (overview.pending_approvals > 0) {
    journalWarnings.push(`${overview.pending_approvals} approval request(s) remain unresolved.`);
  }

  const maintenanceWarnings: string[] = [];
  if (overview.maintenance_status.low_disk_pressure_signals > 0) {
    maintenanceWarnings.push(
      "Storage pressure has been observed, but no queued maintenance worker is tracking disk recovery at launch.",
    );
  }
  maintenanceWarnings.push(...capabilityMaintenanceWarnings, ...capabilityHealthWarnings);

  const securityWarnings: string[] = [];
  if (!liveSecurityState.durableSecretStorageAvailable) {
    securityWarnings.push(
      "Durable MCP secret storage is unavailable on this host; streamable_http secret references cannot meet the production storage bar.",
    );
  }
  securityWarnings.push(...liveSecurityState.stdioSandboxIssues);
  if (liveSecurityState.stdioMutableTagServers.length > 0) {
    securityWarnings.push(
      `${liveSecurityState.stdioMutableTagServers.length} stored stdio MCP server registration(s) still use OCI images without pinned sha256 digests and must be updated before governed execution can meet the production bar.`,
    );
  }
  if (liveSecurityState.stdioLocalBuildServers.length > 0) {
    securityWarnings.push(
      `${liveSecurityState.stdioLocalBuildServers.length} stdio MCP server(s) rely on oci_container.build and are suitable for local development only, not production rollout.`,
    );
  }
  if (liveSecurityState.stdioRegistryPolicyServers.length < liveSecurityState.stdioDigestPinnedServers.length) {
    securityWarnings.push(
      "Some digest-pinned stdio MCP server registrations are missing allowed_registries coverage and cannot meet the OCI supply-chain trust bar.",
    );
  }
  if (liveSecurityState.stdioSignatureVerificationServers.length < liveSecurityState.stdioDigestPinnedServers.length) {
    securityWarnings.push(
      "Some digest-pinned stdio MCP server registrations are missing cosign signature verification policy and cannot meet the OCI supply-chain trust bar.",
    );
  }
  if (
    liveSecurityState.stdioProvenanceAttestationServers.length <
    liveSecurityState.stdioSignatureVerificationServers.length
  ) {
    securityWarnings.push(
      "Some stdio MCP server registrations verify OCI signatures but do not require SLSA provenance attestations.",
    );
  }
  if (liveSecurityState.streamableHttpLegacyEnvAuthServers.length > 0) {
    securityWarnings.push(
      `Legacy bearer_env auth is still configured for ${liveSecurityState.streamableHttpLegacyEnvAuthServers.length} streamable_http MCP server(s).`,
    );
  }
  if (liveSecurityState.streamableHttpMissingSecretRefs.length > 0) {
    securityWarnings.push(
      `Missing durable secret references were detected for ${liveSecurityState.streamableHttpMissingSecretRefs.length} streamable_http MCP server(s).`,
    );
  }
  if (liveSecurityState.publicHttpsPolicyMismatches.length > 0) {
    securityWarnings.push(
      `Missing public host allowlist policies were detected for ${liveSecurityState.publicHttpsPolicyMismatches.length} public_https MCP server(s).`,
    );
  }
  if (liveSecurityState.streamableHttpMissingAuth.length > 0) {
    securityWarnings.push(
      `Missing bearer_env values were detected for ${liveSecurityState.streamableHttpMissingAuth.length} streamable_http MCP server(s).`,
    );
  }
  const securityPrimaryReason: ReasonDetail | null = (() => {
    if (!liveSecurityState.durableSecretStorageAvailable) {
      return {
        code: "MCP_SECRET_STORAGE_UNAVAILABLE",
        message: "Durable MCP secret storage is unavailable on this host.",
      };
    }

    if (liveSecurityState.stdioDegradedServers.length > 0) {
      return {
        code: "STDIO_SANDBOX_DEGRADED",
        message: `${liveSecurityState.stdioDegradedServers.length} governed stdio MCP server(s) do not have a usable sandbox on this host.`,
      };
    }

    if (liveSecurityState.stdioLocalBuildServers.length > 0) {
      return {
        code: "STDIO_OCI_LOCAL_BUILD_ONLY",
        message: "Some governed stdio MCP servers are configured for local OCI builds instead of production images.",
      };
    }

    if (liveSecurityState.stdioMutableTagServers.length > 0) {
      return {
        code: "STDIO_OCI_IMAGE_NOT_PINNED",
        message: "Some stored governed stdio MCP registrations still use OCI images without pinned sha256 digests.",
      };
    }

    if (liveSecurityState.stdioRegistryPolicyServers.length < liveSecurityState.stdioDigestPinnedServers.length) {
      return {
        code: "STDIO_OCI_REGISTRY_POLICY_MISSING",
        message: "Some digest-pinned governed stdio MCP registrations are missing allowed_registries coverage.",
      };
    }

    if (
      liveSecurityState.stdioSignatureVerificationServers.length < liveSecurityState.stdioDigestPinnedServers.length
    ) {
      return {
        code: "STDIO_OCI_SIGNATURE_POLICY_MISSING",
        message:
          "Some digest-pinned governed stdio MCP registrations are missing cosign signature verification policy.",
      };
    }

    if (
      liveSecurityState.stdioProvenanceAttestationServers.length <
      liveSecurityState.stdioSignatureVerificationServers.length
    ) {
      return {
        code: "STDIO_OCI_PROVENANCE_POLICY_MISSING",
        message: "Some governed stdio MCP registrations do not require SLSA provenance attestations.",
      };
    }

    if (liveSecurityState.streamableHttpLegacyEnvAuthServers.length > 0) {
      return {
        code: "LEGACY_STREAMABLE_HTTP_AUTH",
        message: "Some streamable_http MCP servers still rely on legacy bearer_env authentication.",
      };
    }

    if (liveSecurityState.streamableHttpMissingSecretRefs.length > 0) {
      return {
        code: "MISSING_STREAMABLE_HTTP_SECRET_REF",
        message: "Some streamable_http MCP servers reference missing durable secrets.",
      };
    }

    if (liveSecurityState.publicHttpsPolicyMismatches.length > 0) {
      return {
        code: "MISSING_PUBLIC_HOST_POLICY",
        message: "Some public_https MCP servers are missing an allowlisted host policy.",
      };
    }

    return null;
  })();
  const hostedWorkerWarnings: string[] = [];
  if (!hostedWorkerClient.available) {
    hostedWorkerWarnings.push(
      hostedWorkerClient.lastError
        ? `Hosted MCP worker is unreachable: ${hostedWorkerClient.lastError}`
        : "Hosted MCP worker is unreachable.",
    );
  }
  const hostedWorkerPrimaryReason = hostedWorkerClient.available
    ? null
    : {
        code: "HOSTED_WORKER_UNREACHABLE",
        message: hostedWorkerClient.lastError ?? "Hosted MCP worker is unreachable.",
      };

  const hostedQueueSnapshot = hostedExecutionQueue.diagnostics();
  const hostedQueueWarnings: string[] = [];
  if (hostedQueueSnapshot.failed_jobs > 0) {
    hostedQueueWarnings.push(
      `${hostedQueueSnapshot.failed_jobs} hosted MCP execution job(s) are in a failed terminal state and require operator action.`,
    );
  }
  if (!hostedWorkerClient.available && hostedQueueSnapshot.queued_jobs > 0) {
    hostedQueueWarnings.push(
      `${hostedQueueSnapshot.queued_jobs} queued hosted MCP execution job(s) are waiting for the worker to become reachable.`,
    );
  }
  const hostedQueuePrimaryReason =
    hostedQueueSnapshot.failed_jobs > 0
      ? {
          code: "HOSTED_QUEUE_FAILED_JOBS",
          message: `${hostedQueueSnapshot.failed_jobs} hosted MCP execution job(s) are in a failed terminal state.`,
        }
      : !hostedWorkerClient.available && hostedQueueSnapshot.queued_jobs > 0
        ? {
            code: "HOSTED_QUEUE_BLOCKED_ON_WORKER",
            message: `${hostedQueueSnapshot.queued_jobs} queued hosted MCP execution job(s) are blocked on worker reachability.`,
        }
      : null;
  const latencyMetricsSnapshot = latencyMetrics.snapshot();
  const policySummaryWarnings = [...policyRuntime.effective_policy.summary.warnings];
  if (latencyMetricsSnapshot.policy_eval_ms.within_target === false) {
    policySummaryWarnings.push(
      `Policy evaluation p95 is ${latencyMetricsSnapshot.policy_eval_ms.p95_ms}ms, above the ${latencyMetricsSnapshot.policy_eval_ms.target_ms}ms target.`,
    );
  }
  if (latencyMetricsSnapshot.fast_action_ms.within_target === false) {
    policySummaryWarnings.push(
      `Fast local action p95 is ${latencyMetricsSnapshot.fast_action_ms.p95_ms}ms, above the ${latencyMetricsSnapshot.fast_action_ms.target_ms}ms target.`,
    );
  }

  return makeSuccessResponse(request.request_id, request.session_id, {
    daemon_health: requestedSections.has("daemon_health")
      ? {
          status: storageWarnings.length > 0 || capabilityHealthWarnings.length > 0 ? "degraded" : "healthy",
          active_sessions: state.getSessionCount(),
          active_runs: state.getRunCount(),
          primary_reason: storagePrimaryReason ?? capabilityPrimaryReason,
          warnings: [
            ...(storageWarnings.length > 0
              ? ["Runtime is healthy enough to serve requests, but durable evidence health is degraded."]
              : []),
            ...capabilityHealthWarnings,
          ],
        }
      : null,
    journal_health: requestedSections.has("journal_health")
      ? {
          status: journalWarnings.length > 0 ? "degraded" : "healthy",
          total_runs: overview.total_runs,
          total_events: overview.total_events,
          pending_approvals: overview.pending_approvals,
          primary_reason:
            overview.pending_approvals > 0
              ? {
                  code: "PENDING_APPROVALS",
                  message: `${overview.pending_approvals} approval request(s) remain unresolved.`,
                }
              : storagePrimaryReason,
          warnings: journalWarnings,
        }
      : null,
    maintenance_backlog: requestedSections.has("maintenance_backlog")
      ? {
          pending_critical_jobs: 0,
          pending_maintenance_jobs: 0,
          oldest_pending_critical_job: null,
          current_heavy_job: null,
          snapshot_compaction_debt: null,
          primary_reason:
            overview.maintenance_status.low_disk_pressure_signals > 0
              ? {
                  code: "LOW_DISK_PRESSURE_OBSERVED",
                  message: `${overview.maintenance_status.low_disk_pressure_signals} low-disk pressure signal(s) were recorded while storing evidence.`,
                }
              : capabilityPrimaryReason,
          warnings: maintenanceWarnings,
        }
      : null,
    projection_lag: requestedSections.has("projection_lag")
      ? {
          projection_status: "fresh",
          lag_events: 0,
        }
      : null,
    storage_summary: requestedSections.has("storage_summary")
      ? {
          artifact_health: overview.maintenance_status.artifact_health,
          degraded_artifact_capture_actions: overview.maintenance_status.degraded_artifact_capture_actions,
          low_disk_pressure_signals: overview.maintenance_status.low_disk_pressure_signals,
          primary_reason: storagePrimaryReason,
          warnings: storageWarnings,
        }
      : null,
    capability_summary: requestedSections.has("capability_summary")
      ? {
          cached: capabilitySnapshot !== null,
          refreshed_at: capabilitySummaryRefreshedAt,
          workspace_root: capabilitySummaryWorkspaceRoot,
          capability_count: capabilitySummaryCount,
          degraded_capabilities: capabilitySummaryDegraded,
          unavailable_capabilities: capabilitySummaryUnavailable,
          stale_after_ms: capabilityRefreshStaleMs,
          is_stale: capabilitySummaryIsStale,
          primary_reason: capabilityPrimaryReason,
          warnings: capabilitySnapshot === null ? capabilityMaintenanceWarnings : capabilitySummaryWarnings,
        }
      : null,
    policy_summary: requestedSections.has("policy_summary")
      ? {
          ...policyRuntime.effective_policy.summary,
          warnings: policySummaryWarnings,
          latency_metrics: latencyMetricsSnapshot,
        }
      : null,
    security_posture: requestedSections.has("security_posture")
      ? {
          status: securityWarnings.length > 0 ? "degraded" : "healthy",
          secret_storage: {
            mode: liveSecurityState.credentialBrokerMode,
            provider: liveSecurityState.credentialStoreDetails?.provider ?? null,
            durable: liveSecurityState.durableSecretStorageAvailable,
            encrypted_at_rest: liveSecurityState.durableSecretStorageAvailable,
            secret_expiry_enforced: true,
            rotation_metadata_tracked: true,
            legacy_key_path: liveSecurityState.credentialStoreDetails?.legacy_key_path ?? null,
          },
          stdio_sandbox: {
            registered_server_count: liveSecurityState.registeredStdioServers.length,
            protected_server_count: liveSecurityState.protectedStdioServerCount,
            production_ready_server_count: liveSecurityState.stdioProductionReadyServers.length,
            digest_pinned_server_count: liveSecurityState.stdioDigestPinnedServers.length,
            mutable_tag_server_count: liveSecurityState.stdioMutableTagServers.length,
            local_build_server_count: liveSecurityState.stdioLocalBuildServers.length,
            registry_policy_server_count: liveSecurityState.stdioRegistryPolicyServers.length,
            signature_verification_server_count: liveSecurityState.stdioSignatureVerificationServers.length,
            provenance_attestation_server_count: liveSecurityState.stdioProvenanceAttestationServers.length,
            fallback_server_count: liveSecurityState.stdioFallbackServers.length,
            unconfigured_server_count: liveSecurityState.stdioUnconfiguredServers.length,
            preferred_production_mode: liveSecurityState.preferredProductionMode,
            local_dev_fallback_mode: liveSecurityState.localDevFallbackMode,
            current_host_mode: liveSecurityState.currentHostMode,
            current_host_mode_reason: liveSecurityState.currentHostModeReason,
            macos_seatbelt_available: false,
            docker_runtime_usable: liveSecurityState.dockerRuntime.usable,
            podman_runtime_usable: liveSecurityState.podmanRuntime.usable,
            windows_plan: {
              supported_via_oci: true,
              recommended_runtime: "docker_desktop_wsl2_or_podman_machine",
              native_fallback_available: false,
              summary:
                "On Windows, use Docker Desktop with WSL2 or Podman machine for OCI sandboxing. No native host-process fallback is supported.",
            },
            degraded_servers: liveSecurityState.stdioDegradedServers,
          },
          streamable_http: {
            registered_server_count: liveSecurityState.registeredStreamableHttpServers.length,
            connect_time_dns_scope_validation: true,
            redirect_chain_revalidation: true,
            concurrency_limits_enforced: true,
            shared_sqlite_leases: true,
            lease_heartbeat_renewal: true,
            legacy_bearer_env_servers: liveSecurityState.streamableHttpLegacyEnvAuthServers.map(
              (record) => record.server.server_id,
            ),
            missing_secret_ref_servers: liveSecurityState.streamableHttpMissingSecretRefs.map(
              (record) => record.server.server_id,
            ),
            missing_public_host_policy_servers: liveSecurityState.publicHttpsPolicyMismatches.map(
              (record) => record.server.server_id,
            ),
          },
          primary_reason: securityPrimaryReason,
          warnings: [...new Set(securityWarnings)],
        }
      : null,
    hosted_worker: requestedSections.has("hosted_worker")
      ? {
          status: hostedWorkerWarnings.length > 0 ? "degraded" : "healthy",
          reachable: hostedWorkerClient.available,
          managed_by_daemon: hostedWorkerClient.managed,
          endpoint_kind: hostedWorkerClient.endpointKind,
          endpoint: hostedWorkerClient.endpointLabel,
          runtime_id: hostedWorkerClient.workerRuntimeId,
          image_digest: hostedWorkerClient.workerImageDigest,
          control_plane_auth_required: hostedWorkerClient.controlPlaneAuthRequired,
          last_error: hostedWorkerClient.lastError,
          primary_reason: hostedWorkerPrimaryReason,
          warnings: hostedWorkerWarnings,
        }
      : null,
    hosted_queue: requestedSections.has("hosted_queue")
      ? {
          status: hostedQueueWarnings.length > 0 ? "degraded" : "healthy",
          queued_jobs: hostedQueueSnapshot.queued_jobs,
          running_jobs: hostedQueueSnapshot.running_jobs,
          cancel_requested_jobs: hostedQueueSnapshot.cancel_requested_jobs,
          succeeded_jobs: hostedQueueSnapshot.succeeded_jobs,
          failed_jobs: hostedQueueSnapshot.failed_jobs,
          canceled_jobs: hostedQueueSnapshot.canceled_jobs,
          retryable_failed_jobs: hostedQueueSnapshot.retryable_failed_jobs,
          dead_letter_retryable_jobs: hostedQueueSnapshot.dead_letter_retryable_jobs,
          dead_letter_non_retryable_jobs: hostedQueueSnapshot.dead_letter_non_retryable_jobs,
          oldest_queued_at: hostedQueueSnapshot.oldest_queued_at,
          oldest_failed_at: hostedQueueSnapshot.oldest_failed_at,
          active_server_profiles: hostedQueueSnapshot.active_server_profiles,
          primary_reason: hostedQueuePrimaryReason,
          warnings: hostedQueueWarnings,
        }
      : null,
  });
}
