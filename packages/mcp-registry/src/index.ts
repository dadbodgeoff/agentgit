import { IntegrationState, type SqliteCheckpointResult } from "@agentgit/integration-state";
import {
  AgentGitError,
  type HostedMcpExecutionAttestationRecord,
  HostedMcpExecutionAttestationRecordSchema,
  type HostedMcpExecutionJobRecord,
  HostedMcpExecutionJobRecordSchema,
  type HostedMcpExecutionLeaseRecord,
  HostedMcpExecutionLeaseRecordSchema,
  type ImportedMcpToolRecord,
  ImportedMcpToolRecordSchema,
  type McpCredentialBindingRecord,
  McpCredentialBindingRecordSchema,
  type McpServerCandidateRecord,
  McpServerCandidateRecordSchema,
  type McpServerTrustDecisionRecord,
  McpServerTrustDecisionRecordSchema,
  type McpPublicHostPolicy,
  type McpPublicHostPolicyRecord,
  McpPublicHostPolicyRecordSchema,
  McpPublicHostPolicySchema,
  type McpRegistrySource,
  type McpServerProfileRecord,
  McpServerProfileRecordSchema,
  type McpServerDefinition,
  McpServerDefinitionSchema,
  type McpServerRegistrationRecord,
  McpServerRegistrationRecordSchema,
  validate,
} from "@agentgit/schemas";

export interface McpRegistryBootstrapSummary {
  imported: number;
  skipped: number;
}

export interface McpServerRegistryOptions {
  dbPath: string;
  publicHostPolicyRegistry?: McpPublicHostPolicyRegistry | null;
}

export interface McpPublicHostPolicyRegistryOptions {
  dbPath: string;
}

type HostReachability = "loopback" | "private" | "public" | "unknown";
const DISALLOWED_STREAMABLE_HTTP_HEADER_NAMES = new Set(["authorization", "proxy-authorization", "cookie"]);
const CONTAINER_DIGEST_PIN_PREFIX = "@sha256:";

export function isDigestPinnedContainerImage(image: string): boolean {
  const normalized = image.trim();
  const digestIndex = normalized.indexOf(CONTAINER_DIGEST_PIN_PREFIX);
  return digestIndex > 0 && digestIndex < normalized.length - CONTAINER_DIGEST_PIN_PREFIX.length;
}

export function normalizeContainerRegistryHost(host: string): string {
  return host.trim().toLowerCase();
}

export function extractContainerRegistryHost(image: string): string {
  const normalized = image.trim().split("@", 1)[0] ?? "";
  const firstSegment = normalized.split("/", 1)[0] ?? "";
  if (firstSegment.includes(".") || firstSegment.includes(":") || firstSegment === "localhost") {
    return normalizeContainerRegistryHost(firstSegment);
  }

  return "docker.io";
}

export function isContainerRegistryAllowed(image: string, allowedRegistries: readonly string[]): boolean {
  const registryHost = extractContainerRegistryHost(image);
  return allowedRegistries.map(normalizeContainerRegistryHost).includes(registryHost);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();

  if (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized === "::ffff:127.0.0.1"
  ) {
    return true;
  }

  if (normalized.endsWith(".localhost")) {
    return true;
  }

  const ipv4Match = normalized.match(/^(\d{1,3})(?:\.(\d{1,3})){3}$/);
  if (!ipv4Match) {
    return false;
  }

  const octets = normalized.split(".").map((part) => Number.parseInt(part, 10));
  return (
    octets.length === 4 &&
    octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) &&
    octets[0] === 127
  );
}

function classifyIpv4Host(hostname: string): HostReachability {
  const octets = hostname.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return "unknown";
  }

  if (octets[0] === 127) {
    return "loopback";
  }

  if (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
  ) {
    return "private";
  }

  return "public";
}

function classifyIpv6Host(hostname: string): HostReachability {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");

  if (normalized === "::1" || normalized === "::ffff:127.0.0.1") {
    return "loopback";
  }

  if (
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) {
    return "private";
  }

  return normalized.includes(":") ? "public" : "unknown";
}

function classifyHostname(hostname: string): HostReachability {
  const normalized = hostname.trim().toLowerCase();

  if (isLoopbackHostname(normalized)) {
    return "loopback";
  }

  const ipv4Match = normalized.match(/^(\d{1,3})(?:\.(\d{1,3})){3}$/);
  if (ipv4Match) {
    return classifyIpv4Host(normalized);
  }

  if (normalized.includes(":")) {
    return classifyIpv6Host(normalized);
  }

  if (normalized.length === 0) {
    return "unknown";
  }

  if (normalized.endsWith(".local") || !normalized.includes(".")) {
    return "unknown";
  }

  return "public";
}

export function classifyMcpNetworkScope(url: URL): "loopback" | "private" | "public_https" {
  const reachability = classifyHostname(url.hostname);
  return reachability === "loopback" ? "loopback" : reachability === "private" ? "private" : "public_https";
}

function normalizeIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new AgentGitError("MCP server configuration is malformed.", "CAPABILITY_UNAVAILABLE", {
      field,
    });
  }

  return normalized;
}

function normalizeHostname(value: string, field: string): string {
  const normalized = normalizeIdentifier(value, field).toLowerCase();
  if (normalized.includes("/") || normalized.includes("@") || normalized.includes("*")) {
    throw new AgentGitError("MCP public host policy host is malformed.", "CAPABILITY_UNAVAILABLE", {
      field,
      host: normalized,
    });
  }

  return normalized;
}

function normalizePublicHostPolicy(policy: McpPublicHostPolicy): McpPublicHostPolicy {
  const parsed = validate(McpPublicHostPolicySchema, policy);
  return {
    host: normalizeHostname(parsed.host, "host"),
    display_name: parsed.display_name?.trim() || undefined,
    allow_subdomains: parsed.allow_subdomains ?? false,
    allowed_ports: parsed.allowed_ports
      ? [...new Set(parsed.allowed_ports)].sort((left, right) => left - right)
      : undefined,
  };
}

function normalizePublicHostPolicyRecord(record: McpPublicHostPolicyRecord): McpPublicHostPolicyRecord {
  const parsed = validate(McpPublicHostPolicyRecordSchema, record);
  return {
    ...parsed,
    policy: normalizePublicHostPolicy(parsed.policy),
  };
}

function resolveUrlPort(url: URL): number {
  if (url.port.length > 0) {
    return Number.parseInt(url.port, 10);
  }

  return url.protocol === "https:" ? 443 : 80;
}

function hostMatchesPolicy(hostname: string, policy: McpPublicHostPolicy): boolean {
  const normalizedHost = hostname.trim().toLowerCase();
  const normalizedPolicyHost = policy.host.trim().toLowerCase();

  if (normalizedHost === normalizedPolicyHost) {
    return true;
  }

  return Boolean(policy.allow_subdomains) && normalizedHost.endsWith(`.${normalizedPolicyHost}`);
}

export class McpPublicHostPolicyRegistry {
  private readonly state: IntegrationState<{ policies: McpPublicHostPolicyRecord }>;

  constructor(options: McpPublicHostPolicyRegistryOptions) {
    this.state = new IntegrationState({
      dbPath: options.dbPath,
      collections: {
        policies: {
          parse(key: string, value: unknown) {
            const record = normalizePublicHostPolicyRecord(value as McpPublicHostPolicyRecord);
            if (record.policy.host !== key) {
              throw new AgentGitError(
                "Stored MCP host policy key does not match the configured host.",
                "STORAGE_UNAVAILABLE",
                {
                  key,
                  host: record.policy.host,
                },
              );
            }

            return record;
          },
        },
      },
    });
  }

  listPolicies(): McpPublicHostPolicyRecord[] {
    return this.state.list("policies");
  }

  getPolicy(host: string): McpPublicHostPolicyRecord | null {
    return this.state.get("policies", normalizeHostname(host, "host"));
  }

  upsertPolicy(policy: McpPublicHostPolicy): {
    policy: McpPublicHostPolicyRecord;
    created: boolean;
  } {
    const normalizedPolicy = normalizePublicHostPolicy(policy);
    const existing = this.state.get("policies", normalizedPolicy.host);
    const now = new Date().toISOString();
    const record: McpPublicHostPolicyRecord = {
      policy: normalizedPolicy,
      source: "operator_api",
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };

    this.state.put("policies", normalizedPolicy.host, record);
    return {
      policy: record,
      created: existing === null,
    };
  }

  removePolicy(host: string): McpPublicHostPolicyRecord | null {
    const normalizedHost = normalizeHostname(host, "host");
    const existing = this.state.get("policies", normalizedHost);
    if (!existing) {
      return null;
    }

    this.state.delete("policies", normalizedHost);
    return existing;
  }

  findPolicyForUrl(url: URL): McpPublicHostPolicyRecord | null {
    const resolvedPort = resolveUrlPort(url);

    return (
      this.listPolicies().find((record) => {
        if (!hostMatchesPolicy(url.hostname, record.policy)) {
          return false;
        }

        return !record.policy.allowed_ports || record.policy.allowed_ports.includes(resolvedPort);
      }) ?? null
    );
  }

  assertUrlAllowed(url: URL, serverId?: string): McpPublicHostPolicyRecord {
    const policy = this.findPolicyForUrl(url);
    if (!policy) {
      throw new AgentGitError(
        "Governed public HTTPS MCP execution requires an explicit operator-managed host allowlist policy for the target host and port.",
        "CAPABILITY_UNAVAILABLE",
        {
          server_id: serverId ?? null,
          hostname: url.hostname,
          port: resolveUrlPort(url),
          url: url.toString(),
        },
      );
    }

    return policy;
  }

  checkpointWal(): SqliteCheckpointResult {
    return this.state.checkpointWal();
  }

  close(): void {
    this.state.close();
  }
}

function normalizeServerDefinition(
  server: McpServerDefinition,
  options: { publicHostPolicyRegistry?: McpPublicHostPolicyRegistry | null } = {},
): McpServerDefinition {
  const parsed = validate(McpServerDefinitionSchema, server);
  const serverId = normalizeIdentifier(parsed.server_id, "server_id");
  const seenToolNames = new Set<string>();
  const tools = parsed.tools.map((tool: McpServerDefinition["tools"][number]) => {
    const toolName = normalizeIdentifier(tool.tool_name, "tool_name");
    if (seenToolNames.has(toolName)) {
      throw new AgentGitError("Duplicate MCP tool_name configured for a governed server.", "CAPABILITY_UNAVAILABLE", {
        server_id: serverId,
        tool_name: toolName,
      });
    }
    seenToolNames.add(toolName);

    if (tool.approval_mode === "allow" && tool.side_effect_level !== "read_only") {
      throw new AgentGitError(
        "Only explicitly read-only MCP tools can be auto-approved in the governed runtime.",
        "CAPABILITY_UNAVAILABLE",
        {
          server_id: serverId,
          tool_name: toolName,
          side_effect_level: tool.side_effect_level,
        },
      );
    }

    return {
      ...tool,
      tool_name: toolName,
    };
  });

  if (parsed.transport === "stdio") {
    if (!parsed.sandbox) {
      throw new AgentGitError(
        "Governed stdio MCP registration requires an explicit oci_container sandbox configuration.",
        "CAPABILITY_UNAVAILABLE",
        {
          server_id: serverId,
          transport: parsed.transport,
          preferred_production_mode: "oci_container",
        },
      );
    }

    if (
      parsed.sandbox.type === "oci_container" &&
      !parsed.sandbox.build &&
      !isDigestPinnedContainerImage(parsed.sandbox.image)
    ) {
      throw new AgentGitError(
        "Governed stdio MCP OCI images must be pinned by sha256 digest unless oci_container.build is configured for local development.",
        "CAPABILITY_UNAVAILABLE",
        {
          server_id: serverId,
          transport: parsed.transport,
          sandbox_type: parsed.sandbox.type,
          image: parsed.sandbox.image,
          preferred_production_mode: "oci_container",
          allowed_local_dev_mode: "oci_container.build",
        },
      );
    }

    if (
      parsed.sandbox.type === "oci_container" &&
      !parsed.sandbox.build &&
      (parsed.sandbox.allowed_registries?.length ?? 0) === 0
    ) {
      throw new AgentGitError(
        "Governed stdio MCP OCI images must declare allowed_registries unless oci_container.build is configured for local development.",
        "CAPABILITY_UNAVAILABLE",
        {
          server_id: serverId,
          transport: parsed.transport,
          sandbox_type: parsed.sandbox.type,
          image: parsed.sandbox.image,
          preferred_production_mode: "oci_container",
          allowed_local_dev_mode: "oci_container.build",
        },
      );
    }

    if (
      parsed.sandbox.type === "oci_container" &&
      !parsed.sandbox.build &&
      !isContainerRegistryAllowed(parsed.sandbox.image, parsed.sandbox.allowed_registries ?? [])
    ) {
      throw new AgentGitError(
        "Governed stdio MCP OCI image registry is not permitted by allowed_registries.",
        "CAPABILITY_UNAVAILABLE",
        {
          server_id: serverId,
          transport: parsed.transport,
          sandbox_type: parsed.sandbox.type,
          image: parsed.sandbox.image,
          image_registry: extractContainerRegistryHost(parsed.sandbox.image),
          allowed_registries: parsed.sandbox.allowed_registries ?? [],
        },
      );
    }

    if (parsed.sandbox.type === "oci_container" && !parsed.sandbox.build && !parsed.sandbox.signature_verification) {
      throw new AgentGitError(
        "Governed stdio MCP OCI images must configure signature_verification unless oci_container.build is configured for local development.",
        "CAPABILITY_UNAVAILABLE",
        {
          server_id: serverId,
          transport: parsed.transport,
          sandbox_type: parsed.sandbox.type,
          image: parsed.sandbox.image,
          preferred_production_mode: "oci_container",
          allowed_local_dev_mode: "oci_container.build",
        },
      );
    }

    return {
      ...parsed,
      server_id: serverId,
      display_name: parsed.display_name?.trim() || undefined,
      command: normalizeIdentifier(parsed.command, "command"),
      args: parsed.args ?? [],
      env: parsed.env ?? {},
      tools,
    };
  }

  for (const headerName of Object.keys(parsed.headers ?? {})) {
    if (DISALLOWED_STREAMABLE_HTTP_HEADER_NAMES.has(headerName.trim().toLowerCase())) {
      throw new AgentGitError(
        "Governed streamable_http MCP headers may not override authorization, proxy-authorization, or cookie state.",
        "CAPABILITY_UNAVAILABLE",
        {
          server_id: serverId,
          transport: parsed.transport,
          header_name: headerName,
        },
      );
    }
  }

  const url = new URL(parsed.url);
  const networkScope = parsed.network_scope ?? "loopback";
  const reachability = classifyHostname(url.hostname);
  const allowedForScope =
    networkScope === "loopback"
      ? reachability === "loopback"
      : networkScope === "private"
        ? reachability === "loopback" || reachability === "private"
        : reachability === "public";
  if (!allowedForScope) {
    throw new AgentGitError(
      networkScope === "loopback"
        ? "Governed streamable_http MCP execution is currently limited to operator-managed local loopback URLs."
        : networkScope === "private"
          ? "Governed private-network streamable_http MCP execution requires an explicit private or loopback IP target."
          : "Governed public HTTPS MCP execution requires an explicit public hostname or public IP target.",
      "CAPABILITY_UNAVAILABLE",
      {
        server_id: serverId,
        transport: parsed.transport,
        url: parsed.url,
        hostname: url.hostname,
        network_scope: networkScope,
        hostname_reachability: reachability,
      },
    );
  }

  if (networkScope === "public_https" && url.protocol !== "https:") {
    throw new AgentGitError(
      "Governed public HTTPS MCP execution requires an https URL with platform TLS validation.",
      "CAPABILITY_UNAVAILABLE",
      {
        server_id: serverId,
        transport: parsed.transport,
        url: parsed.url,
        network_scope: networkScope,
      },
    );
  }

  if (networkScope === "public_https" && !["bearer_env", "bearer_secret_ref"].includes(parsed.auth?.type ?? "none")) {
    throw new AgentGitError(
      "Governed public HTTPS MCP execution requires operator-managed bearer authentication backed by a secret reference or legacy env configuration.",
      "CAPABILITY_UNAVAILABLE",
      {
        server_id: serverId,
        transport: parsed.transport,
        url: parsed.url,
        network_scope: networkScope,
        auth_type: parsed.auth?.type ?? "none",
      },
    );
  }

  if (networkScope === "public_https" && options.publicHostPolicyRegistry) {
    options.publicHostPolicyRegistry.assertUrlAllowed(url, serverId);
  }

  if (url.username || url.password) {
    throw new AgentGitError("Governed streamable_http MCP URLs must not embed credentials.", "CAPABILITY_UNAVAILABLE", {
      server_id: serverId,
      transport: parsed.transport,
      url: parsed.url,
    });
  }

  return {
    ...parsed,
    server_id: serverId,
    display_name: parsed.display_name?.trim() || undefined,
    url: url.toString(),
    network_scope: networkScope,
    max_concurrent_calls: parsed.max_concurrent_calls ?? 1,
    headers: parsed.headers ?? {},
    auth: parsed.auth ?? { type: "none" },
    tools,
  };
}

function normalizeRegistrationRecord(record: McpServerRegistrationRecord): McpServerRegistrationRecord {
  const parsed = validate(McpServerRegistrationRecordSchema, record);
  return {
    ...parsed,
    server: normalizeServerDefinition(parsed.server),
  };
}

function normalizeCandidateRecord(record: McpServerCandidateRecord): McpServerCandidateRecord {
  const parsed = validate(McpServerCandidateRecordSchema, record);
  return {
    candidate_id: normalizeIdentifier(parsed.candidate_id, "candidate_id"),
    source_kind: parsed.source_kind,
    raw_endpoint: normalizeIdentifier(parsed.raw_endpoint, "raw_endpoint"),
    transport_hint: parsed.transport_hint ?? null,
    workspace_id: parsed.workspace_id?.trim() || null,
    submitted_by_session_id: parsed.submitted_by_session_id?.trim() || null,
    submitted_by_run_id: parsed.submitted_by_run_id?.trim() || null,
    notes: parsed.notes?.trim() || null,
    resolution_state: parsed.resolution_state,
    resolution_error: parsed.resolution_error?.trim() || null,
    submitted_at: parsed.submitted_at,
    updated_at: parsed.updated_at,
  };
}

function normalizeProfileRecord(record: McpServerProfileRecord): McpServerProfileRecord {
  const parsed = validate(McpServerProfileRecordSchema, record);
  const canonicalEndpoint =
    parsed.transport === "streamable_http"
      ? new URL(parsed.canonical_endpoint).toString()
      : normalizeIdentifier(parsed.canonical_endpoint, "canonical_endpoint");

  return {
    server_profile_id: normalizeIdentifier(parsed.server_profile_id, "server_profile_id"),
    candidate_id: parsed.candidate_id?.trim() || null,
    display_name: parsed.display_name?.trim() || null,
    transport: parsed.transport,
    canonical_endpoint: canonicalEndpoint,
    network_scope: parsed.network_scope,
    trust_tier: parsed.trust_tier,
    status: parsed.status,
    drift_state: parsed.drift_state,
    quarantine_reason_codes: [
      ...new Set(parsed.quarantine_reason_codes.map((code) => normalizeIdentifier(code, "quarantine_reason_codes"))),
    ],
    allowed_execution_modes: [...new Set(parsed.allowed_execution_modes)],
    active_trust_decision_id: parsed.active_trust_decision_id?.trim() || null,
    active_credential_binding_id: parsed.active_credential_binding_id?.trim() || null,
    auth_descriptor: {
      mode: parsed.auth_descriptor.mode,
      audience: parsed.auth_descriptor.audience?.trim() || null,
      scope_labels: [
        ...new Set(parsed.auth_descriptor.scope_labels.map((label) => normalizeIdentifier(label, "scope_labels"))),
      ],
    },
    identity_baseline: {
      canonical_host: parsed.identity_baseline.canonical_host?.trim() || null,
      canonical_port: parsed.identity_baseline.canonical_port ?? null,
      tls_identity_summary: parsed.identity_baseline.tls_identity_summary?.trim() || null,
      auth_issuer: parsed.identity_baseline.auth_issuer?.trim() || null,
      publisher_identity: parsed.identity_baseline.publisher_identity?.trim() || null,
      tool_inventory_hash: parsed.identity_baseline.tool_inventory_hash?.trim() || null,
      fetched_at: parsed.identity_baseline.fetched_at,
    },
    imported_tools: parsed.imported_tools.map((tool) => normalizeImportedToolRecord(tool)),
    tool_inventory_version: parsed.tool_inventory_version?.trim() || null,
    last_resolved_at: parsed.last_resolved_at ?? null,
    created_at: parsed.created_at,
    updated_at: parsed.updated_at,
  };
}

function normalizeImportedToolRecord(record: ImportedMcpToolRecord): ImportedMcpToolRecord {
  const parsed = validate(ImportedMcpToolRecordSchema, record);
  return {
    tool_name: normalizeIdentifier(parsed.tool_name, "tool_name"),
    side_effect_level: parsed.side_effect_level,
    approval_mode: parsed.approval_mode,
    input_schema_hash: parsed.input_schema_hash?.trim() || null,
    output_schema_hash: parsed.output_schema_hash?.trim() || null,
    annotations: parsed.annotations
      ? Object.fromEntries(Object.entries(parsed.annotations).sort(([left], [right]) => left.localeCompare(right)))
      : null,
    imported_at: parsed.imported_at,
  };
}

function normalizeTrustDecisionRecord(record: McpServerTrustDecisionRecord): McpServerTrustDecisionRecord {
  const parsed = validate(McpServerTrustDecisionRecordSchema, record);
  return {
    trust_decision_id: normalizeIdentifier(parsed.trust_decision_id, "trust_decision_id"),
    server_profile_id: normalizeIdentifier(parsed.server_profile_id, "server_profile_id"),
    decision: parsed.decision,
    trust_tier: parsed.trust_tier,
    allowed_execution_modes: [...new Set(parsed.allowed_execution_modes)],
    max_side_effect_level_without_approval: parsed.max_side_effect_level_without_approval,
    reason_codes: [...new Set(parsed.reason_codes.map((code) => normalizeIdentifier(code, "reason_codes")))],
    approved_by_session_id: normalizeIdentifier(parsed.approved_by_session_id, "approved_by_session_id"),
    approved_at: parsed.approved_at,
    valid_until: parsed.valid_until ?? null,
    reapproval_triggers: [
      ...new Set(parsed.reapproval_triggers.map((trigger) => normalizeIdentifier(trigger, "reapproval_triggers"))),
    ],
  };
}

function normalizeCredentialBindingRecord(record: McpCredentialBindingRecord): McpCredentialBindingRecord {
  const parsed = validate(McpCredentialBindingRecordSchema, record);
  return {
    credential_binding_id: normalizeIdentifier(parsed.credential_binding_id, "credential_binding_id"),
    server_profile_id: normalizeIdentifier(parsed.server_profile_id, "server_profile_id"),
    binding_mode: parsed.binding_mode,
    broker_profile_id: normalizeIdentifier(parsed.broker_profile_id, "broker_profile_id"),
    scope_labels: [...new Set(parsed.scope_labels.map((scope) => normalizeIdentifier(scope, "scope_labels")))],
    audience: parsed.audience?.trim() || null,
    status: parsed.status,
    created_at: parsed.created_at,
    updated_at: parsed.updated_at,
    revoked_at: parsed.revoked_at ?? null,
  };
}

function normalizeHostedExecutionLeaseRecord(record: HostedMcpExecutionLeaseRecord): HostedMcpExecutionLeaseRecord {
  const parsed = validate(HostedMcpExecutionLeaseRecordSchema, record);
  return {
    lease_id: normalizeIdentifier(parsed.lease_id, "lease_id"),
    run_id: normalizeIdentifier(parsed.run_id, "run_id"),
    action_id: normalizeIdentifier(parsed.action_id, "action_id"),
    server_profile_id: normalizeIdentifier(parsed.server_profile_id, "server_profile_id"),
    tool_name: normalizeIdentifier(parsed.tool_name, "tool_name"),
    auth_context_ref: normalizeIdentifier(parsed.auth_context_ref, "auth_context_ref"),
    allowed_hosts: [...new Set(parsed.allowed_hosts.map((host) => normalizeHostname(host, "allowed_hosts")))],
    issued_at: parsed.issued_at,
    expires_at: parsed.expires_at,
    artifact_budget: {
      max_artifacts: parsed.artifact_budget.max_artifacts,
      max_total_bytes: parsed.artifact_budget.max_total_bytes,
    },
    single_use: parsed.single_use,
    status: parsed.status,
    consumed_at: parsed.consumed_at ?? null,
    revoked_at: parsed.revoked_at ?? null,
  };
}

function normalizeHostedExecutionAttestationRecord(
  record: HostedMcpExecutionAttestationRecord,
): HostedMcpExecutionAttestationRecord {
  const parsed = validate(HostedMcpExecutionAttestationRecordSchema, record);
  return {
    attestation_id: normalizeIdentifier(parsed.attestation_id, "attestation_id"),
    lease_id: normalizeIdentifier(parsed.lease_id, "lease_id"),
    worker_runtime_id: normalizeIdentifier(parsed.worker_runtime_id, "worker_runtime_id"),
    worker_image_digest: normalizeIdentifier(parsed.worker_image_digest, "worker_image_digest"),
    started_at: parsed.started_at,
    completed_at: parsed.completed_at,
    result_hash: normalizeIdentifier(parsed.result_hash, "result_hash"),
    artifact_manifest_hash: normalizeIdentifier(parsed.artifact_manifest_hash, "artifact_manifest_hash"),
    signature: normalizeIdentifier(parsed.signature, "signature"),
    verified_at: parsed.verified_at ?? null,
  };
}

function normalizeHostedExecutionJobRecord(record: HostedMcpExecutionJobRecord): HostedMcpExecutionJobRecord {
  const parsed = validate(HostedMcpExecutionJobRecordSchema, record);
  return {
    job_id: normalizeIdentifier(parsed.job_id, "job_id"),
    run_id: normalizeIdentifier(parsed.run_id, "run_id"),
    action_id: normalizeIdentifier(parsed.action_id, "action_id"),
    server_profile_id: normalizeIdentifier(parsed.server_profile_id, "server_profile_id"),
    tool_name: normalizeIdentifier(parsed.tool_name, "tool_name"),
    server_display_name: normalizeIdentifier(parsed.server_display_name, "server_display_name"),
    canonical_endpoint: parsed.canonical_endpoint,
    network_scope: parsed.network_scope,
    allowed_hosts: [...new Set(parsed.allowed_hosts.map((host) => normalizeHostname(host, "allowed_hosts")))],
    auth_context_ref: normalizeIdentifier(parsed.auth_context_ref, "auth_context_ref"),
    arguments: parsed.arguments,
    status: parsed.status,
    attempt_count: parsed.attempt_count,
    max_attempts: parsed.max_attempts,
    current_lease_id: parsed.current_lease_id?.trim() || null,
    claimed_by: parsed.claimed_by?.trim() || null,
    claimed_at: parsed.claimed_at ?? null,
    last_heartbeat_at: parsed.last_heartbeat_at ?? null,
    cancel_requested_at: parsed.cancel_requested_at ?? null,
    cancel_requested_by_session_id: parsed.cancel_requested_by_session_id?.trim() || null,
    cancel_reason: parsed.cancel_reason?.trim() || null,
    canceled_at: parsed.canceled_at ?? null,
    next_attempt_at: parsed.next_attempt_at,
    created_at: parsed.created_at,
    updated_at: parsed.updated_at,
    completed_at: parsed.completed_at ?? null,
    last_error: parsed.last_error ?? null,
    execution_result: parsed.execution_result ?? null,
  };
}

export function validateMcpServerDefinitions(servers: McpServerDefinition[]): McpServerDefinition[] {
  const seenServerIds = new Set<string>();

  return servers.map((server) => {
    const normalized = normalizeServerDefinition(server);
    if (seenServerIds.has(normalized.server_id)) {
      throw new AgentGitError("Duplicate MCP server_id configured for governed execution.", "CAPABILITY_UNAVAILABLE", {
        server_id: normalized.server_id,
      });
    }
    seenServerIds.add(normalized.server_id);
    return normalized;
  });
}

export class McpServerRegistry {
  private readonly state: IntegrationState<{
    servers: McpServerRegistrationRecord;
    candidates: McpServerCandidateRecord;
    profiles: McpServerProfileRecord;
    trust_decisions: McpServerTrustDecisionRecord;
    credential_bindings: McpCredentialBindingRecord;
    hosted_execution_leases: HostedMcpExecutionLeaseRecord;
    hosted_execution_attestations: HostedMcpExecutionAttestationRecord;
    hosted_execution_jobs: HostedMcpExecutionJobRecord;
  }>;
  private readonly publicHostPolicyRegistry: McpPublicHostPolicyRegistry | null;

  constructor(options: McpServerRegistryOptions) {
    this.publicHostPolicyRegistry = options.publicHostPolicyRegistry ?? null;
    this.state = new IntegrationState({
      dbPath: options.dbPath,
      collections: {
        candidates: {
          parse(key: string, value: unknown) {
            const record = normalizeCandidateRecord(value as McpServerCandidateRecord);
            if (record.candidate_id !== key) {
              throw new AgentGitError(
                "Stored MCP candidate key does not match the candidate_id.",
                "STORAGE_UNAVAILABLE",
                {
                  key,
                  candidate_id: record.candidate_id,
                },
              );
            }

            return record;
          },
        },
        profiles: {
          parse(key: string, value: unknown) {
            const record = normalizeProfileRecord(value as McpServerProfileRecord);
            if (record.server_profile_id !== key) {
              throw new AgentGitError(
                "Stored MCP profile key does not match the server_profile_id.",
                "STORAGE_UNAVAILABLE",
                {
                  key,
                  server_profile_id: record.server_profile_id,
                },
              );
            }

            return record;
          },
        },
        trust_decisions: {
          parse(key: string, value: unknown) {
            const record = normalizeTrustDecisionRecord(value as McpServerTrustDecisionRecord);
            if (record.trust_decision_id !== key) {
              throw new AgentGitError(
                "Stored MCP trust decision key does not match the trust_decision_id.",
                "STORAGE_UNAVAILABLE",
                {
                  key,
                  trust_decision_id: record.trust_decision_id,
                },
              );
            }
            return record;
          },
        },
        credential_bindings: {
          parse(key: string, value: unknown) {
            const record = normalizeCredentialBindingRecord(value as McpCredentialBindingRecord);
            if (record.credential_binding_id !== key) {
              throw new AgentGitError(
                "Stored MCP credential binding key does not match the credential_binding_id.",
                "STORAGE_UNAVAILABLE",
                {
                  key,
                  credential_binding_id: record.credential_binding_id,
                },
              );
            }
            return record;
          },
        },
        hosted_execution_leases: {
          parse(key: string, value: unknown) {
            const record = normalizeHostedExecutionLeaseRecord(value as HostedMcpExecutionLeaseRecord);
            if (record.lease_id !== key) {
              throw new AgentGitError(
                "Stored hosted MCP execution lease key does not match the lease_id.",
                "STORAGE_UNAVAILABLE",
                {
                  key,
                  lease_id: record.lease_id,
                },
              );
            }
            return record;
          },
        },
        hosted_execution_attestations: {
          parse(key: string, value: unknown) {
            const record = normalizeHostedExecutionAttestationRecord(value as HostedMcpExecutionAttestationRecord);
            if (record.attestation_id !== key) {
              throw new AgentGitError(
                "Stored hosted MCP execution attestation key does not match the attestation_id.",
                "STORAGE_UNAVAILABLE",
                {
                  key,
                  attestation_id: record.attestation_id,
                },
              );
            }
            return record;
          },
        },
        hosted_execution_jobs: {
          parse(key: string, value: unknown) {
            const record = normalizeHostedExecutionJobRecord(value as HostedMcpExecutionJobRecord);
            if (record.job_id !== key) {
              throw new AgentGitError(
                "Stored hosted MCP execution job key does not match the job_id.",
                "STORAGE_UNAVAILABLE",
                {
                  key,
                  job_id: record.job_id,
                },
              );
            }
            return record;
          },
        },
        servers: {
          parse(key: string, value: unknown) {
            const record = normalizeRegistrationRecord(value as McpServerRegistrationRecord);
            if (record.server.server_id !== key) {
              throw new AgentGitError(
                "Stored MCP registry key does not match the registered server_id.",
                "STORAGE_UNAVAILABLE",
                {
                  key,
                  server_id: record.server.server_id,
                },
              );
            }

            return record;
          },
        },
      },
    });
  }

  listServers(): McpServerRegistrationRecord[] {
    return this.state.list("servers");
  }

  listDefinitions(): McpServerDefinition[] {
    return this.listServers().map((record) => record.server);
  }

  getServer(serverId: string): McpServerRegistrationRecord | null {
    return this.state.get("servers", serverId.trim());
  }

  listCandidates(): McpServerCandidateRecord[] {
    return this.state.list("candidates");
  }

  getCandidate(candidateId: string): McpServerCandidateRecord | null {
    return this.state.get("candidates", candidateId.trim());
  }

  submitCandidate(candidate: McpServerCandidateRecord): McpServerCandidateRecord {
    const normalizedCandidate = normalizeCandidateRecord(candidate);
    this.state.put("candidates", normalizedCandidate.candidate_id, normalizedCandidate);
    return normalizedCandidate;
  }

  upsertCandidate(candidate: McpServerCandidateRecord): McpServerCandidateRecord {
    return this.submitCandidate(candidate);
  }

  listProfiles(): McpServerProfileRecord[] {
    return this.state.list("profiles");
  }

  getProfile(serverProfileId: string): McpServerProfileRecord | null {
    return this.state.get("profiles", serverProfileId.trim());
  }

  getProfileByCandidateId(candidateId: string): McpServerProfileRecord | null {
    const normalizedCandidateId = candidateId.trim();
    return this.listProfiles().find((profile) => profile.candidate_id === normalizedCandidateId) ?? null;
  }

  upsertProfile(profile: McpServerProfileRecord): {
    profile: McpServerProfileRecord;
    created: boolean;
  } {
    const normalizedProfile = normalizeProfileRecord(profile);
    const existing = this.state.get("profiles", normalizedProfile.server_profile_id);
    this.state.put("profiles", normalizedProfile.server_profile_id, normalizedProfile);
    return {
      profile: normalizedProfile,
      created: existing === null,
    };
  }

  listTrustDecisions(serverProfileId?: string): McpServerTrustDecisionRecord[] {
    const records = this.state.list("trust_decisions");
    return serverProfileId ? records.filter((record) => record.server_profile_id === serverProfileId.trim()) : records;
  }

  getTrustDecision(trustDecisionId: string): McpServerTrustDecisionRecord | null {
    return this.state.get("trust_decisions", trustDecisionId.trim());
  }

  getActiveTrustDecision(serverProfileId: string): McpServerTrustDecisionRecord | null {
    const profile = this.getProfile(serverProfileId);
    if (!profile?.active_trust_decision_id) {
      return null;
    }
    return this.getTrustDecision(profile.active_trust_decision_id);
  }

  listCredentialBindings(serverProfileId?: string): McpCredentialBindingRecord[] {
    const records = this.state.list("credential_bindings");
    return serverProfileId ? records.filter((record) => record.server_profile_id === serverProfileId.trim()) : records;
  }

  getCredentialBinding(credentialBindingId: string): McpCredentialBindingRecord | null {
    return this.state.get("credential_bindings", credentialBindingId.trim());
  }

  getActiveCredentialBinding(serverProfileId: string): McpCredentialBindingRecord | null {
    const profile = this.getProfile(serverProfileId);
    if (!profile?.active_credential_binding_id) {
      return null;
    }
    return this.getCredentialBinding(profile.active_credential_binding_id);
  }

  upsertTrustDecision(trustDecision: McpServerTrustDecisionRecord): {
    trust_decision: McpServerTrustDecisionRecord;
    created: boolean;
  } {
    const normalizedTrustDecision = normalizeTrustDecisionRecord(trustDecision);
    const existing = this.state.get("trust_decisions", normalizedTrustDecision.trust_decision_id);
    this.state.put("trust_decisions", normalizedTrustDecision.trust_decision_id, normalizedTrustDecision);
    return {
      trust_decision: normalizedTrustDecision,
      created: existing === null,
    };
  }

  upsertCredentialBinding(binding: McpCredentialBindingRecord): {
    credential_binding: McpCredentialBindingRecord;
    created: boolean;
  } {
    const normalizedBinding = normalizeCredentialBindingRecord(binding);
    const existing = this.state.get("credential_bindings", normalizedBinding.credential_binding_id);
    this.state.put("credential_bindings", normalizedBinding.credential_binding_id, normalizedBinding);
    return {
      credential_binding: normalizedBinding,
      created: existing === null,
    };
  }

  listHostedExecutionLeases(serverProfileId?: string): HostedMcpExecutionLeaseRecord[] {
    const records = this.state.list("hosted_execution_leases");
    return serverProfileId ? records.filter((record) => record.server_profile_id === serverProfileId.trim()) : records;
  }

  getHostedExecutionLease(leaseId: string): HostedMcpExecutionLeaseRecord | null {
    return this.state.get("hosted_execution_leases", leaseId.trim());
  }

  upsertHostedExecutionLease(lease: HostedMcpExecutionLeaseRecord): {
    lease: HostedMcpExecutionLeaseRecord;
    created: boolean;
  } {
    const normalizedLease = normalizeHostedExecutionLeaseRecord(lease);
    const existing = this.state.get("hosted_execution_leases", normalizedLease.lease_id);
    this.state.put("hosted_execution_leases", normalizedLease.lease_id, normalizedLease);
    return {
      lease: normalizedLease,
      created: existing === null,
    };
  }

  listHostedExecutionAttestations(leaseId?: string): HostedMcpExecutionAttestationRecord[] {
    const records = this.state.list("hosted_execution_attestations");
    return leaseId ? records.filter((record) => record.lease_id === leaseId.trim()) : records;
  }

  getHostedExecutionAttestation(attestationId: string): HostedMcpExecutionAttestationRecord | null {
    return this.state.get("hosted_execution_attestations", attestationId.trim());
  }

  upsertHostedExecutionAttestation(attestation: HostedMcpExecutionAttestationRecord): {
    attestation: HostedMcpExecutionAttestationRecord;
    created: boolean;
  } {
    const normalizedAttestation = normalizeHostedExecutionAttestationRecord(attestation);
    const existing = this.state.get("hosted_execution_attestations", normalizedAttestation.attestation_id);
    this.state.put("hosted_execution_attestations", normalizedAttestation.attestation_id, normalizedAttestation);
    return {
      attestation: normalizedAttestation,
      created: existing === null,
    };
  }

  listHostedExecutionJobs(serverProfileId?: string): HostedMcpExecutionJobRecord[] {
    const records = this.state.list("hosted_execution_jobs");
    return serverProfileId ? records.filter((record) => record.server_profile_id === serverProfileId.trim()) : records;
  }

  getHostedExecutionJob(jobId: string): HostedMcpExecutionJobRecord | null {
    return this.state.get("hosted_execution_jobs", jobId.trim());
  }

  upsertHostedExecutionJob(job: HostedMcpExecutionJobRecord): {
    job: HostedMcpExecutionJobRecord;
    created: boolean;
  } {
    const normalizedJob = normalizeHostedExecutionJobRecord(job);
    const existing = this.state.get("hosted_execution_jobs", normalizedJob.job_id);
    this.state.put("hosted_execution_jobs", normalizedJob.job_id, normalizedJob);
    return {
      job: normalizedJob,
      created: existing === null,
    };
  }

  upsertServer(
    server: McpServerDefinition,
    source: McpRegistrySource = "operator_api",
  ): {
    server: McpServerRegistrationRecord;
    created: boolean;
  } {
    const normalizedServer = normalizeServerDefinition(server, {
      publicHostPolicyRegistry: this.publicHostPolicyRegistry,
    });
    const existing = this.state.get("servers", normalizedServer.server_id);
    const now = new Date().toISOString();
    const record: McpServerRegistrationRecord = {
      server: normalizedServer,
      source: existing?.source ?? source,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };

    this.state.put("servers", normalizedServer.server_id, record);

    return {
      server: record,
      created: existing === null,
    };
  }

  removeServer(serverId: string): McpServerRegistrationRecord | null {
    const normalizedServerId = normalizeIdentifier(serverId, "server_id");
    const existing = this.state.get("servers", normalizedServerId);
    if (!existing) {
      return null;
    }

    this.state.delete("servers", normalizedServerId);
    return existing;
  }

  bootstrapServers(servers: McpServerDefinition[]): McpRegistryBootstrapSummary {
    const normalizedServers = validateMcpServerDefinitions(servers);
    let imported = 0;
    let skipped = 0;

    for (const server of normalizedServers) {
      if (this.getServer(server.server_id)) {
        skipped += 1;
        continue;
      }

      this.upsertServer(server, "bootstrap_env");
      imported += 1;
    }

    return {
      imported,
      skipped,
    };
  }

  checkpointWal(): SqliteCheckpointResult {
    return this.state.checkpointWal();
  }

  close(): void {
    this.state.close();
  }
}
