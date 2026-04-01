import { IntegrationState, type SqliteCheckpointResult } from "@agentgit/integration-state";
import {
  AgentGitError,
  type McpPublicHostPolicy,
  type McpPublicHostPolicyRecord,
  McpPublicHostPolicyRecordSchema,
  McpPublicHostPolicySchema,
  type McpRegistrySource,
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

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();

  if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]" || normalized === "::ffff:127.0.0.1") {
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
  return octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) && octets[0] === 127;
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
  const normalized = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");

  if (normalized === "::1" || normalized === "::ffff:127.0.0.1") {
    return "loopback";
  }

  if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) {
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
    allowed_ports: parsed.allowed_ports ? [...new Set(parsed.allowed_ports)].sort((left, right) => left - right) : undefined,
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
              throw new AgentGitError("Stored MCP host policy key does not match the configured host.", "STORAGE_UNAVAILABLE", {
                key,
                host: record.policy.host,
              });
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

function normalizeRegistrationRecord(
  record: McpServerRegistrationRecord,
): McpServerRegistrationRecord {
  const parsed = validate(McpServerRegistrationRecordSchema, record);
  return {
    ...parsed,
    server: normalizeServerDefinition(parsed.server),
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
  private readonly state: IntegrationState<{ servers: McpServerRegistrationRecord }>;
  private readonly publicHostPolicyRegistry: McpPublicHostPolicyRegistry | null;

  constructor(options: McpServerRegistryOptions) {
    this.publicHostPolicyRegistry = options.publicHostPolicyRegistry ?? null;
    this.state = new IntegrationState({
      dbPath: options.dbPath,
      collections: {
        servers: {
          parse(key: string, value: unknown) {
            const record = normalizeRegistrationRecord(value as McpServerRegistrationRecord);
            if (record.server.server_id !== key) {
              throw new AgentGitError("Stored MCP registry key does not match the registered server_id.", "STORAGE_UNAVAILABLE", {
                key,
                server_id: record.server.server_id,
              });
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

  upsertServer(server: McpServerDefinition, source: McpRegistrySource = "operator_api"): {
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
