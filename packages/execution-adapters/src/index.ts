import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SessionCredentialBroker } from "@agentgit/credential-broker";
import { IntegrationState } from "@agentgit/integration-state";
import {
  extractContainerRegistryHost,
  isContainerRegistryAllowed,
  isDigestPinnedContainerImage,
  McpPublicHostPolicyRegistry,
  McpServerRegistry,
  validateMcpServerDefinitions,
} from "@agentgit/mcp-registry";
import {
  AgentGitError,
  type ActionRecord,
  type ExecutionArtifact,
  type ExecutionResult,
  type McpServerDefinition,
  NotFoundError,
  type PolicyOutcomeRecord,
  PreconditionError,
} from "@agentgit/schemas";

export type { ExecutionArtifact, ExecutionResult } from "@agentgit/schemas";
export { validateMcpServerDefinitions } from "@agentgit/mcp-registry";

interface FilesystemFacet {
  operation?: string;
  byte_length?: number;
}

interface FilesystemRawInput {
  content?: string;
}

interface ShellFacet {
  argv?: string[];
  cwd?: string;
  target_paths?: string[];
  protected_paths?: string[];
  control_surface_paths?: string[];
  outside_workspace_paths?: string[];
}

interface FunctionFacet {
  integration?: string;
  operation?: string;
  object_locator?: string;
}

interface FunctionRawInput {
  draft_id?: string;
  note_id?: string;
  ticket_id?: string;
  status?: string;
  labels?: string[];
  assigned_users?: string[];
  user_id?: string;
  subject?: string;
  title?: string;
  body?: string;
  label?: string;
}

interface McpFacet {
  server_id?: string;
  tool_name?: string;
}

function resolveSqliteBusyTimeoutMs(): number {
  const configured = process.env.AGENTGIT_SQLITE_BUSY_TIMEOUT_MS?.trim();
  if (!configured) {
    return 5_000;
  }

  const parsed = Number.parseInt(configured, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new PreconditionError("Unsupported SQLite busy timeout.", {
      configured_timeout_ms: configured,
    });
  }

  return parsed;
}

interface McpRawInput {
  server_id?: string;
  tool_name?: string;
  arguments?: Record<string, unknown>;
}

interface TicketRestoreState {
  title: string;
  body: string;
  labels: string[];
  assigned_users: string[];
  status: TicketRecord["status"];
}

export interface DraftRecord {
  draft_id: string;
  subject: string;
  body: string;
  labels: string[];
  status: "active" | "archived" | "deleted";
  action_id: string;
  created_at: string;
  archived_at: string | null;
  deleted_at: string | null;
}

export interface NoteRecord {
  note_id: string;
  title: string;
  body: string;
  status: "active" | "archived" | "deleted";
  action_id: string;
  created_at: string;
  archived_at: string | null;
  deleted_at: string | null;
}

export interface TicketRecord {
  ticket_id: string;
  title: string;
  body: string;
  labels: string[];
  assigned_users: string[];
  status: "active" | "closed" | "deleted";
  action_id: string;
  remote_url: string;
  created_at: string;
  closed_at: string | null;
  deleted_at: string | null;
}

export interface ExecutionContext {
  action: ActionRecord;
  policy_outcome: PolicyOutcomeRecord;
  snapshot_record?: { snapshot_id: string } | null;
  workspace_root: string;
}

export interface ExecutionAdapter {
  readonly supported_domains: string[];
  canHandle(action: ActionRecord): boolean;
  verifyPreconditions(context: ExecutionContext): Promise<void>;
  execute(context: ExecutionContext): Promise<ExecutionResult>;
}

export class AdapterRegistry {
  private readonly adapters: ExecutionAdapter[] = [];

  register(adapter: ExecutionAdapter): void {
    this.adapters.push(adapter);
  }

  findAdapter(action: ActionRecord): ExecutionAdapter | null {
    return this.adapters.find((adapter) => adapter.canHandle(action)) ?? null;
  }

  supportedDomains(): string[] {
    return [...new Set(this.adapters.flatMap((adapter) => adapter.supported_domains))];
  }
}

const DEFAULT_MCP_TIMEOUT_MS = 30_000;
const MCP_CONCURRENCY_LEASE_GRACE_MS = 5_000;
const MAX_MCP_REDIRECTS = 5;
const MAX_MCP_STDERR_BYTES = 16 * 1024;
type McpClientTransport = StdioClientTransport | StreamableHTTPClientTransport;
type BetterSqliteDatabase = InstanceType<typeof Database>;
type HostnameResolution = {
  address: string;
  family: number;
};
type HostnameResolver = (hostname: string) => Promise<HostnameResolution[]>;

type HostReachability = "loopback" | "private" | "public" | "unknown";

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized === "::ffff:127.0.0.1" ||
    normalized.endsWith(".localhost")
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

  if (net.isIP(normalized) === 4) {
    return classifyIpv4Host(normalized);
  }

  if (net.isIP(normalized) === 6 || normalized.includes(":")) {
    return classifyIpv6Host(normalized);
  }

  if (normalized.length === 0 || normalized.endsWith(".local") || !normalized.includes(".")) {
    return "unknown";
  }

  return "public";
}

function isReachabilityAllowedForScope(
  scope: Extract<McpServerDefinition, { transport: "streamable_http" }>["network_scope"] | undefined,
  reachability: HostReachability,
): boolean {
  const effectiveScope = scope ?? "loopback";
  if (effectiveScope === "loopback") {
    return reachability === "loopback";
  }

  if (effectiveScope === "private") {
    return reachability === "loopback" || reachability === "private";
  }

  return reachability === "public";
}

class McpConcurrencyLeaseStore {
  private readonly db: BetterSqliteDatabase;
  private readonly leaseOwnerId: string;

  constructor(dbPath: string, options: { leaseOwnerId?: string } = {}) {
    fsSync.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.leaseOwnerId = options.leaseOwnerId ?? `${os.hostname()}:${process.pid}:${randomUUID()}`;
    this.db.pragma("journal_mode = WAL");
    this.db.pragma(`busy_timeout = ${resolveSqliteBusyTimeoutMs()}`);
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_streamable_http_leases (
        lease_id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        lease_owner_id TEXT NOT NULL,
        acquired_at_ms INTEGER NOT NULL,
        heartbeat_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_streamable_http_leases_server
        ON mcp_streamable_http_leases (server_id, expires_at_ms);
    `);
    const columns = new Set<string>(
      (
        this.db.prepare("PRAGMA table_info(mcp_streamable_http_leases)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    if (!columns.has("lease_owner_id")) {
      this.db.exec("ALTER TABLE mcp_streamable_http_leases ADD COLUMN lease_owner_id TEXT NOT NULL DEFAULT 'legacy';");
    }
    if (!columns.has("heartbeat_at_ms")) {
      this.db.exec("ALTER TABLE mcp_streamable_http_leases ADD COLUMN heartbeat_at_ms INTEGER NOT NULL DEFAULT 0;");
      this.db.exec("UPDATE mcp_streamable_http_leases SET heartbeat_at_ms = acquired_at_ms WHERE heartbeat_at_ms = 0;");
    }
  }

  acquire(serverId: string, maxConcurrentCalls: number, leaseTtlMs: number): string {
    const acquireLease = this.db.transaction(
      (candidateServerId: string, candidateMaxConcurrentCalls: number, candidateLeaseTtlMs: number) => {
        const nowMs = Date.now();
        this.db.prepare("DELETE FROM mcp_streamable_http_leases WHERE expires_at_ms <= ?").run(nowMs);

        const activeCalls = Number(
          (
            this.db
              .prepare(
                "SELECT COUNT(*) as count FROM mcp_streamable_http_leases WHERE server_id = ? AND expires_at_ms > ?",
              )
              .get(candidateServerId, nowMs) as { count: number }
          ).count,
        );

        if (activeCalls >= candidateMaxConcurrentCalls) {
          throw new AgentGitError(
            "Governed MCP server concurrency limit reached. Retry after an in-flight call completes.",
            "PRECONDITION_FAILED",
            {
              server_id: candidateServerId,
              transport: "streamable_http",
              active_calls: activeCalls,
              max_concurrent_calls: candidateMaxConcurrentCalls,
            },
            true,
          );
        }

        const leaseId = `mcp_lease_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
        this.db
          .prepare(
            "INSERT INTO mcp_streamable_http_leases (lease_id, server_id, lease_owner_id, acquired_at_ms, heartbeat_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(leaseId, candidateServerId, this.leaseOwnerId, nowMs, nowMs, nowMs + candidateLeaseTtlMs);
        return leaseId;
      },
    );

    return acquireLease(serverId, maxConcurrentCalls, leaseTtlMs);
  }

  renew(leaseId: string, leaseTtlMs: number): boolean {
    const nowMs = Date.now();
    const result = this.db
      .prepare(
        "UPDATE mcp_streamable_http_leases SET heartbeat_at_ms = ?, expires_at_ms = ? WHERE lease_id = ? AND lease_owner_id = ?",
      )
      .run(nowMs, nowMs + leaseTtlMs, leaseId, this.leaseOwnerId);
    return result.changes > 0;
  }

  release(leaseId: string): void {
    this.db
      .prepare("DELETE FROM mcp_streamable_http_leases WHERE lease_id = ? AND lease_owner_id = ?")
      .run(leaseId, this.leaseOwnerId);
  }

  close(): void {
    this.db.close();
  }
}

function defaultHostnameResolver(hostname: string): Promise<HostnameResolution[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, buildError: () => AgentGitError): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;

  return new Promise<T>((resolve, reject) => {
    timeout = setTimeout(() => {
      reject(buildError());
    }, timeoutMs);

    promise.then(
      (value) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        resolve(value);
      },
      (error) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        reject(error);
      },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolveMcpTimeoutMs(server: McpServerDefinition): number {
  return server.timeout_ms ?? DEFAULT_MCP_TIMEOUT_MS;
}

function assertStreamableHttpPublicEgressAllowed(
  server: Extract<McpServerDefinition, { transport: "streamable_http" }>,
  publicHostPolicyRegistry: McpPublicHostPolicyRegistry | null,
): void {
  if ((server.network_scope ?? "loopback") !== "public_https") {
    return;
  }

  if (!publicHostPolicyRegistry) {
    throw new PreconditionError("Governed public HTTPS MCP execution requires a configured host allowlist registry.", {
      server_id: server.server_id,
      transport: server.transport,
      network_scope: server.network_scope ?? "public_https",
      url: server.url,
    });
  }

  publicHostPolicyRegistry.assertUrlAllowed(new URL(server.url), server.server_id);
}

function resolveStreamableHttpHeaders(
  server: Extract<McpServerDefinition, { transport: "streamable_http" }>,
  broker: SessionCredentialBroker | null,
): Record<string, string> {
  const headers = {
    ...(server.headers ?? {}),
  };

  if (server.auth?.type === "bearer_env") {
    const envVar = server.auth.bearer_env_var?.trim() ?? "";
    const token = envVar.length > 0 ? (process.env[envVar]?.trim() ?? "") : "";
    if (token.length === 0) {
      throw new PreconditionError(
        "Governed streamable_http MCP execution requires an operator-configured bearer token env var.",
        {
          server_id: server.server_id,
          transport: server.transport,
          bearer_env_var: envVar || null,
        },
      );
    }
    headers.authorization = `Bearer ${token}`;
  }

  if (server.auth?.type === "bearer_secret_ref") {
    if (!broker) {
      throw new PreconditionError("Governed MCP bearer secret references require a configured credential broker.", {
        server_id: server.server_id,
        transport: server.transport,
        secret_id: server.auth.secret_id,
      });
    }

    const access = broker.resolveMcpBearerSecret(server.auth.secret_id);
    headers.authorization = access.authorization_header;
  }

  return headers;
}

function resolveStdioWorkspaceAccess(
  server: Extract<McpServerDefinition, { transport: "stdio" }>,
): "none" | "read_only" | "read_write" {
  const explicit = server.sandbox?.workspace_access;
  if (explicit) {
    return explicit;
  }

  return server.tools.some((tool) => tool.side_effect_level !== "read_only") ? "read_write" : "read_only";
}

function resolveExecutablePath(command: string, env: NodeJS.ProcessEnv): string | null {
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    const resolved = path.isAbsolute(command) ? path.resolve(command) : path.resolve(process.cwd(), command);
    return fsSync.existsSync(resolved) ? resolved : null;
  }

  const searchPath = (env.PATH ?? process.env.PATH ?? "").split(path.delimiter);
  for (const candidateDir of searchPath) {
    if (candidateDir.trim().length === 0) {
      continue;
    }
    const candidate = path.join(candidateDir, command);
    if (fsSync.existsSync(candidate)) {
      return fsSync.realpathSync(candidate);
    }
  }

  return null;
}

function commandExists(command: string): boolean {
  return resolveExecutablePath(command, getDefaultEnvironment()) !== null;
}

function containerRuntimeUsable(runtime: "docker" | "podman"): { usable: boolean; reason: string | null } {
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

function compactEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function extractContainerDigest(image: string): string | null {
  if (!isDigestPinnedContainerImage(image)) {
    return null;
  }

  return image
    .trim()
    .slice(image.indexOf("@") + 1)
    .toLowerCase();
}

function imageExists(runtime: "docker" | "podman", image: string): boolean {
  const result = spawnSync(runtime, ["image", "inspect", image], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });

  return result.status === 0 && !result.error;
}

function inspectImageRepoDigests(runtime: "docker" | "podman", image: string): string[] {
  const result = spawnSync(runtime, ["image", "inspect", image], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });
  if (result.error) {
    throw new PreconditionError("Governed stdio MCP OCI image inspection failed before execution.", {
      transport: "stdio",
      runtime,
      image,
      reason: result.error.message,
    });
  }

  if (result.status !== 0) {
    throw new PreconditionError("Governed stdio MCP OCI image inspection failed before execution.", {
      transport: "stdio",
      runtime,
      image,
      exit_code: result.status,
      stderr: result.stderr.trim() || null,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new PreconditionError("Governed stdio MCP OCI image inspection returned invalid JSON.", {
      transport: "stdio",
      runtime,
      image,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  if (!Array.isArray(parsed) || parsed.length === 0 || typeof parsed[0] !== "object" || parsed[0] === null) {
    throw new PreconditionError("Governed stdio MCP OCI image inspection did not return an inspectable image record.", {
      transport: "stdio",
      runtime,
      image,
    });
  }

  const repoDigests = (parsed[0] as { RepoDigests?: unknown }).RepoDigests;
  if (!Array.isArray(repoDigests)) {
    return [];
  }

  return repoDigests.filter((digest): digest is string => typeof digest === "string");
}

function assertPinnedImageLocallyVerified(
  server: Extract<McpServerDefinition, { transport: "stdio" }>,
  runtime: "docker" | "podman",
): void {
  if (server.sandbox?.type !== "oci_container" || server.sandbox.build) {
    return;
  }

  const expectedDigest = extractContainerDigest(server.sandbox.image);
  if (!expectedDigest) {
    throw new PreconditionError(
      "Governed stdio MCP OCI images must be pinned by sha256 digest unless oci_container.build is configured for local development.",
      {
        server_id: server.server_id,
        transport: server.transport,
        runtime,
        image: server.sandbox.image,
      },
    );
  }

  const repoDigests = inspectImageRepoDigests(runtime, server.sandbox.image);
  if (!repoDigests.some((repoDigest) => repoDigest.toLowerCase().endsWith(expectedDigest))) {
    throw new PreconditionError(
      "Governed stdio MCP OCI image digest could not be verified from the local runtime cache.",
      {
        server_id: server.server_id,
        transport: server.transport,
        runtime,
        image: server.sandbox.image,
        expected_digest: expectedDigest,
        repo_digests: repoDigests,
        requires_local_digest_match: true,
      },
    );
  }
}

function assertAllowedContainerRegistry(server: Extract<McpServerDefinition, { transport: "stdio" }>): void {
  if (server.sandbox?.type !== "oci_container" || server.sandbox.build) {
    return;
  }

  const allowedRegistries = server.sandbox.allowed_registries ?? [];
  if (allowedRegistries.length === 0) {
    throw new PreconditionError(
      "Governed stdio MCP OCI images must declare allowed_registries unless oci_container.build is configured for local development.",
      {
        server_id: server.server_id,
        transport: server.transport,
        image: server.sandbox.image,
      },
    );
  }

  if (!isContainerRegistryAllowed(server.sandbox.image, allowedRegistries)) {
    throw new PreconditionError("Governed stdio MCP OCI image registry is not permitted by allowed_registries.", {
      server_id: server.server_id,
      transport: server.transport,
      image: server.sandbox.image,
      image_registry: extractContainerRegistryHost(server.sandbox.image),
      allowed_registries: allowedRegistries,
    });
  }
}

function assertCosignUsable(): void {
  const result = spawnSync("cosign", ["version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });

  if (result.error) {
    throw new PreconditionError("Governed stdio MCP OCI signature verification requires the cosign CLI on the host.", {
      verifier: "cosign",
      reason: result.error.message,
    });
  }

  if (result.status !== 0) {
    throw new PreconditionError("Governed stdio MCP OCI signature verification requires the cosign CLI on the host.", {
      verifier: "cosign",
      exit_code: result.status,
      stderr: result.stderr.trim() || null,
    });
  }
}

function resolveCosignVerificationArgs(
  server: Extract<McpServerDefinition, { transport: "stdio" }>,
  cwd: string,
): string[] {
  if (server.sandbox?.type !== "oci_container" || !server.sandbox.signature_verification) {
    throw new PreconditionError(
      "Governed stdio MCP OCI images must configure signature_verification unless oci_container.build is configured for local development.",
      {
        server_id: server.server_id,
        transport: server.transport,
        image: server.sandbox?.type === "oci_container" ? server.sandbox.image : null,
      },
    );
  }

  const verification = server.sandbox.signature_verification;
  if (verification.mode === "cosign_keyless") {
    return [
      "--certificate-identity",
      verification.certificate_identity,
      "--certificate-oidc-issuer",
      verification.certificate_oidc_issuer,
      ...Object.entries(verification.annotations ?? {}).flatMap(([key, value]) => ["-a", `${key}=${value}`]),
    ];
  }

  const keyPath = path.resolve(cwd, verification.public_key_path);
  if (!fsSync.existsSync(keyPath) || !fsSync.statSync(keyPath).isFile()) {
    throw new PreconditionError("Governed stdio MCP OCI signature verification key does not exist.", {
      server_id: server.server_id,
      transport: server.transport,
      image: server.sandbox.image,
      key_path: keyPath,
    });
  }

  return [
    "--key",
    keyPath,
    ...Object.entries(verification.annotations ?? {}).flatMap(([key, value]) => ["-a", `${key}=${value}`]),
  ];
}

function stripCosignAnnotations(args: string[]): string[] {
  const stripped: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-a") {
      index += 1;
      continue;
    }
    stripped.push(args[index]!);
  }

  return stripped;
}

function runCosignCommand(
  server: Extract<McpServerDefinition, { transport: "stdio" }>,
  cwd: string,
  args: string[],
  operation: "verify" | "verify-attestation",
): void {
  const result = spawnSync("cosign", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });

  if (result.error) {
    throw new PreconditionError(`Governed stdio MCP OCI ${operation} failed before execution.`, {
      server_id: server.server_id,
      transport: server.transport,
      image: server.sandbox?.type === "oci_container" ? server.sandbox.image : null,
      verifier: "cosign",
      operation,
      reason: result.error.message,
    });
  }

  if (result.status !== 0) {
    throw new PreconditionError(`Governed stdio MCP OCI ${operation} failed before execution.`, {
      server_id: server.server_id,
      transport: server.transport,
      image: server.sandbox?.type === "oci_container" ? server.sandbox.image : null,
      verifier: "cosign",
      operation,
      exit_code: result.status,
      stdout: result.stdout.trim() || null,
      stderr: result.stderr.trim() || null,
    });
  }
}

function assertContainerSignatureVerified(
  server: Extract<McpServerDefinition, { transport: "stdio" }>,
  cwd: string,
): void {
  if (server.sandbox?.type !== "oci_container" || server.sandbox.build) {
    return;
  }

  assertCosignUsable();
  const verificationArgs = resolveCosignVerificationArgs(server, cwd);
  runCosignCommand(server, cwd, ["verify", ...verificationArgs, server.sandbox.image], "verify");

  if (server.sandbox.signature_verification?.require_slsa_provenance === false) {
    return;
  }

  runCosignCommand(
    server,
    cwd,
    [
      "verify-attestation",
      ...stripCosignAnnotations(verificationArgs),
      "--type",
      "slsaprovenance",
      server.sandbox.image,
    ],
    "verify-attestation",
  );
}

function ensureBuiltOciImage(
  server: Extract<McpServerDefinition, { transport: "stdio" }>,
  runtime: "docker" | "podman",
  cwd: string,
): void {
  if (server.sandbox?.type !== "oci_container" || !server.sandbox.build) {
    return;
  }

  const rebuildPolicy = server.sandbox.build.rebuild_policy ?? "always";
  if (rebuildPolicy === "if_missing" && imageExists(runtime, server.sandbox.image)) {
    return;
  }

  const contextPath = path.resolve(cwd, server.sandbox.build.context_path);
  if (!fsSync.existsSync(contextPath) || !fsSync.statSync(contextPath).isDirectory()) {
    throw new PreconditionError("Governed stdio MCP OCI build context does not exist or is not a directory.", {
      server_id: server.server_id,
      transport: server.transport,
      runtime,
      image: server.sandbox.image,
      context_path: contextPath,
    });
  }

  const buildArgs = ["build", "--tag", server.sandbox.image];
  if (server.sandbox.build.dockerfile_path) {
    buildArgs.push("--file", path.resolve(cwd, server.sandbox.build.dockerfile_path));
  }
  if (server.sandbox.build.target) {
    buildArgs.push("--target", server.sandbox.build.target);
  }
  for (const [key, value] of Object.entries(server.sandbox.build.build_args ?? {})) {
    buildArgs.push("--build-arg", `${key}=${value}`);
  }
  buildArgs.push(contextPath);

  const buildResult = spawnSync(runtime, buildArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300_000,
  });
  if (buildResult.error) {
    throw new PreconditionError("Governed stdio MCP OCI image build failed before execution.", {
      server_id: server.server_id,
      transport: server.transport,
      runtime,
      image: server.sandbox.image,
      context_path: contextPath,
      reason: buildResult.error.message,
    });
  }
  if (buildResult.status !== 0) {
    throw new PreconditionError("Governed stdio MCP OCI image build failed before execution.", {
      server_id: server.server_id,
      transport: server.transport,
      runtime,
      image: server.sandbox.image,
      context_path: contextPath,
      exit_code: buildResult.status,
      stderr: buildResult.stderr.trim() || null,
    });
  }
}

function createSandboxedStdioLaunch(
  server: Extract<McpServerDefinition, { transport: "stdio" }>,
  workspaceRoot: string,
): {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
} {
  const cwd = path.resolve(server.cwd ?? workspaceRoot);
  const env = {
    ...getDefaultEnvironment(),
    ...server.env,
  };

  if (!server.sandbox) {
    throw new PreconditionError("Governed stdio MCP execution requires an explicit sandbox configuration.", {
      server_id: server.server_id,
      transport: server.transport,
      preferred_production_mode: "oci_container",
      local_dev_fallback_mode: null,
    });
  }

  if (server.sandbox.type !== "oci_container") {
    throw new PreconditionError("Governed stdio MCP sandbox configuration is unsupported. Migrate to oci_container.", {
      server_id: server.server_id,
      transport: server.transport,
      sandbox_type: server.sandbox.type,
      preferred_production_mode: "oci_container",
    });
  }

  const runtime = server.sandbox.runtime ?? "docker";
  const runtimeSupport = containerRuntimeUsable(runtime);
  if (!runtimeSupport.usable) {
    throw new PreconditionError("Governed stdio MCP container sandbox runtime is unavailable on this host.", {
      server_id: server.server_id,
      transport: server.transport,
      sandbox_type: server.sandbox.type,
      runtime,
      reason: runtimeSupport.reason,
    });
  }
  if (!server.sandbox.build && !imageExists(runtime, server.sandbox.image)) {
    throw new PreconditionError(
      "Governed stdio MCP OCI image is not available locally. Pre-pull it or configure oci_container.build.",
      {
        server_id: server.server_id,
        transport: server.transport,
        sandbox_type: server.sandbox.type,
        runtime,
        image: server.sandbox.image,
        requires_local_image: true,
      },
    );
  }
  assertAllowedContainerRegistry(server);
  ensureBuiltOciImage(server, runtime, cwd);
  assertPinnedImageLocallyVerified(server, runtime);
  assertContainerSignatureVerified(server, cwd);
  const workspaceAccess = resolveStdioWorkspaceAccess(server);
  const workspaceMountPath = server.sandbox.workspace_mount_path ?? "/workspace";
  const workdir = server.sandbox.workdir ?? (workspaceAccess === "none" ? "/tmp" : workspaceMountPath);
  const args = [
    "run",
    "--rm",
    "--interactive",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=128",
    `--network=${server.sandbox.network ?? "none"}`,
    `--workdir=${workdir}`,
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=64m",
    "--tmpfs",
    "/run:rw,noexec,nosuid,nodev,size=16m",
  ];

  if (typeof process.getuid === "function" && typeof process.getgid === "function") {
    args.push("--user", `${process.getuid()}:${process.getgid()}`);
  }

  if (workspaceAccess !== "none") {
    const mode = workspaceAccess === "read_only" ? ",readonly" : "";
    args.push("--mount", `type=bind,src=${path.resolve(workspaceRoot)},dst=${workspaceMountPath}${mode}`);
  }

  for (const mount of server.sandbox.additional_mounts ?? []) {
    const mountMode = mount.read_only === false ? "" : ",readonly";
    args.push("--mount", `type=bind,src=${path.resolve(mount.host_path)},dst=${mount.container_path}${mountMode}`);
  }

  const envAllowlist = new Set(server.sandbox.env_allowlist ?? Object.keys(server.env ?? {}));
  for (const [key, value] of Object.entries(server.env ?? {})) {
    if (!envAllowlist.has(key)) {
      continue;
    }
    args.push("--env", `${key}=${value}`);
  }

  args.push(server.sandbox.image, server.command, ...(server.args ?? []));

  return {
    command: runtime,
    args,
    cwd,
    env: compactEnv(env),
  };
}

async function assertRuntimeResolvedHostMatchesScope(
  server: Extract<McpServerDefinition, { transport: "streamable_http" }>,
  targetUrl: URL,
  hostnameResolver: HostnameResolver,
): Promise<void> {
  const literalReachability = classifyHostname(targetUrl.hostname);
  if (net.isIP(targetUrl.hostname) !== 0) {
    if (!isReachabilityAllowedForScope(server.network_scope, literalReachability)) {
      throw new PreconditionError(
        "Governed streamable_http MCP target resolved to a disallowed IP literal for its configured network scope.",
        {
          server_id: server.server_id,
          transport: server.transport,
          url: targetUrl.toString(),
          hostname: targetUrl.hostname,
          hostname_reachability: literalReachability,
          network_scope: server.network_scope ?? "loopback",
        },
      );
    }
    return;
  }

  const resolvedAddresses = await hostnameResolver(targetUrl.hostname);
  if (resolvedAddresses.length === 0) {
    throw new PreconditionError("Governed streamable_http MCP target hostname did not resolve to any IP addresses.", {
      server_id: server.server_id,
      transport: server.transport,
      url: targetUrl.toString(),
      hostname: targetUrl.hostname,
    });
  }

  const mismatches = resolvedAddresses
    .map((address) => ({
      address: address.address,
      reachability: classifyHostname(address.address),
    }))
    .filter((candidate) => !isReachabilityAllowedForScope(server.network_scope, candidate.reachability));

  if (mismatches.length > 0) {
    throw new PreconditionError("Governed streamable_http MCP target resolved outside its configured network scope.", {
      server_id: server.server_id,
      transport: server.transport,
      url: targetUrl.toString(),
      hostname: targetUrl.hostname,
      network_scope: server.network_scope ?? "loopback",
      resolved_addresses: mismatches,
    });
  }
}

async function assertRuntimeStreamableHttpTargetAllowed(
  server: Extract<McpServerDefinition, { transport: "streamable_http" }>,
  targetUrl: URL,
  publicHostPolicyRegistry: McpPublicHostPolicyRegistry | null,
  hostnameResolver: HostnameResolver,
): Promise<void> {
  assertStreamableHttpPublicEgressAllowed(
    {
      ...server,
      url: targetUrl.toString(),
    },
    publicHostPolicyRegistry,
  );
  await assertRuntimeResolvedHostMatchesScope(server, targetUrl, hostnameResolver);
}

function shouldFollowRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function createGovernedStreamableHttpFetch(
  server: Extract<McpServerDefinition, { transport: "streamable_http" }>,
  broker: SessionCredentialBroker | null,
  publicHostPolicyRegistry: McpPublicHostPolicyRegistry | null,
  hostnameResolver: HostnameResolver,
): typeof fetch {
  const baseHeaders = resolveStreamableHttpHeaders(server, broker);

  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    let url = new URL(request.url);
    let method = (init?.method ?? request.method ?? "GET").toUpperCase();
    let body = init?.body;
    const signal = init?.signal ?? request.signal;
    const headers = new Headers(request.headers);
    for (const [key, value] of Object.entries(baseHeaders)) {
      headers.set(key, value);
    }
    for (const [key, value] of new Headers(init?.headers).entries()) {
      headers.set(key, value);
    }

    for (let redirectCount = 0; redirectCount <= MAX_MCP_REDIRECTS; redirectCount += 1) {
      await assertRuntimeStreamableHttpTargetAllowed(server, url, publicHostPolicyRegistry, hostnameResolver);
      const response = await fetch(url, {
        ...init,
        method,
        body,
        headers,
        signal,
        redirect: "manual",
      });

      if (!shouldFollowRedirect(response.status)) {
        return response;
      }

      if (redirectCount === MAX_MCP_REDIRECTS) {
        if (response.body) {
          await response.body.cancel().catch(() => undefined);
        }
        throw new PreconditionError(
          "Governed streamable_http MCP redirect chain exceeded the maximum supported length.",
          {
            server_id: server.server_id,
            transport: server.transport,
            url: url.toString(),
            redirect_count: redirectCount,
          },
        );
      }

      const location = response.headers.get("location");
      if (!location) {
        return response;
      }

      const nextUrl = new URL(location, url);
      if (response.body) {
        await response.body.cancel().catch(() => undefined);
      }
      await assertRuntimeStreamableHttpTargetAllowed(server, nextUrl, publicHostPolicyRegistry, hostnameResolver);

      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
      url = nextUrl;
    }

    throw new PreconditionError("Governed streamable_http MCP redirect handling failed unexpectedly.", {
      server_id: server.server_id,
      transport: server.transport,
    });
  };
}

function createMcpTransport(
  server: McpServerDefinition,
  workspaceRoot: string,
  broker: SessionCredentialBroker | null,
  publicHostPolicyRegistry: McpPublicHostPolicyRegistry | null,
  hostnameResolver: HostnameResolver,
): {
  transport: McpClientTransport;
  readStderr: () => string;
} {
  if (server.transport === "stdio") {
    const launch = createSandboxedStdioLaunch(server, workspaceRoot);
    const transport = new StdioClientTransport({
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
      stderr: "pipe",
    });
    let stderr = "";
    const stderrStream = transport.stderr;
    if (stderrStream) {
      stderrStream.on("data", (chunk: string | Buffer) => {
        const value = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        stderr = `${stderr}${value}`.slice(0, MAX_MCP_STDERR_BYTES);
      });
    }

    return {
      transport,
      readStderr: () => stderr,
    };
  }

  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    fetch: createGovernedStreamableHttpFetch(server, broker, publicHostPolicyRegistry, hostnameResolver),
  });

  return {
    transport,
    readStderr: () => "",
  };
}

function summarizeMcpContent(result: unknown): string {
  const record = isRecord(result) ? result : {};
  const parts: string[] = [];

  if (Array.isArray(record.content)) {
    for (const entry of record.content) {
      if (!isRecord(entry) || typeof entry.type !== "string") {
        continue;
      }

      if (entry.type === "text" && typeof entry.text === "string") {
        parts.push(entry.text);
        continue;
      }

      if (entry.type === "resource" && isRecord(entry.resource) && typeof entry.resource.text === "string") {
        parts.push(entry.resource.text);
        continue;
      }
    }
  }

  if (parts.length > 0) {
    return textPreview(parts.join("\n"));
  }

  if (isRecord(record.structuredContent)) {
    return textPreview(JSON.stringify(record.structuredContent));
  }

  return record.isError === true
    ? "MCP tool returned an error result without textual content."
    : "MCP tool returned structured content.";
}

export class McpExecutionAdapter implements ExecutionAdapter {
  readonly supported_domains = ["mcp"];
  private readonly serversById = new Map<string, McpServerDefinition>();
  private readonly registry: McpServerRegistry | null;
  private readonly activeStreamableHttpCallsByServerId = new Map<string, number>();
  private readonly broker: SessionCredentialBroker | null;
  private readonly publicHostPolicyRegistry: McpPublicHostPolicyRegistry | null;
  private readonly concurrencyLeaseStore: McpConcurrencyLeaseStore | null;
  private readonly concurrencyLeaseGraceMs: number;
  private readonly concurrencyLeaseHeartbeatMs: number | null;
  private readonly concurrencyLeaseTtlMs: number | null;
  private readonly hostnameResolver: HostnameResolver;

  constructor(
    servers: McpServerDefinition[] | McpServerRegistry,
    options: {
      credentialBroker?: SessionCredentialBroker | null;
      publicHostPolicyRegistry?: McpPublicHostPolicyRegistry | null;
      concurrencyLeaseStore?: McpConcurrencyLeaseStore | null;
      concurrencyLeaseDbPath?: string;
      concurrencyLeaseGraceMs?: number;
      concurrencyLeaseHeartbeatMs?: number;
      concurrencyLeaseTtlMs?: number;
      hostnameResolver?: HostnameResolver;
    } = {},
  ) {
    this.broker = options.credentialBroker ?? null;
    this.publicHostPolicyRegistry = options.publicHostPolicyRegistry ?? null;
    this.concurrencyLeaseGraceMs = Math.max(1_000, options.concurrencyLeaseGraceMs ?? MCP_CONCURRENCY_LEASE_GRACE_MS);
    this.concurrencyLeaseHeartbeatMs = options.concurrencyLeaseHeartbeatMs ?? null;
    this.concurrencyLeaseTtlMs = options.concurrencyLeaseTtlMs ?? null;
    this.hostnameResolver = options.hostnameResolver ?? defaultHostnameResolver;
    this.concurrencyLeaseStore =
      options.concurrencyLeaseStore ??
      (options.concurrencyLeaseDbPath ? new McpConcurrencyLeaseStore(options.concurrencyLeaseDbPath) : null);
    if (servers instanceof McpServerRegistry) {
      this.registry = servers;
      return;
    }

    this.registry = null;
    for (const server of validateMcpServerDefinitions(servers)) {
      this.serversById.set(server.server_id, server);
    }
  }

  private getRegisteredServer(serverId: string): McpServerDefinition | null {
    if (this.registry) {
      return this.registry.getServer(serverId)?.server ?? null;
    }

    return this.serversById.get(serverId) ?? null;
  }

  private acquireStreamableHttpExecutionSlot(server: McpServerDefinition, timeoutMs: number): () => void {
    if (server.transport !== "streamable_http") {
      return () => undefined;
    }

    const maxConcurrentCalls = server.max_concurrent_calls ?? 1;
    const leaseTtlMs = Math.max(1_000, this.concurrencyLeaseTtlMs ?? timeoutMs + this.concurrencyLeaseGraceMs);
    if (this.concurrencyLeaseStore) {
      const leaseId = this.concurrencyLeaseStore.acquire(server.server_id, maxConcurrentCalls, leaseTtlMs);
      const leaseHeartbeatMs = Math.max(
        250,
        Math.min(this.concurrencyLeaseHeartbeatMs ?? Math.floor(leaseTtlMs / 3), Math.max(250, leaseTtlMs - 100)),
      );
      const renewalTimer =
        leaseHeartbeatMs < leaseTtlMs
          ? setInterval(() => {
              this.concurrencyLeaseStore?.renew(leaseId, leaseTtlMs);
            }, leaseHeartbeatMs)
          : null;
      renewalTimer?.unref?.();
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        if (renewalTimer) {
          clearInterval(renewalTimer);
        }
        this.concurrencyLeaseStore?.release(leaseId);
      };
    }

    const activeCalls = this.activeStreamableHttpCallsByServerId.get(server.server_id) ?? 0;
    if (activeCalls >= maxConcurrentCalls) {
      throw new AgentGitError(
        "Governed MCP server concurrency limit reached. Retry after an in-flight call completes.",
        "PRECONDITION_FAILED",
        {
          server_id: server.server_id,
          transport: server.transport,
          network_scope: server.network_scope ?? "loopback",
          active_calls: activeCalls,
          max_concurrent_calls: maxConcurrentCalls,
        },
        true,
      );
    }

    this.activeStreamableHttpCallsByServerId.set(server.server_id, activeCalls + 1);
    let released = false;

    return () => {
      if (released) {
        return;
      }
      released = true;

      const currentActiveCalls = this.activeStreamableHttpCallsByServerId.get(server.server_id) ?? 0;
      if (currentActiveCalls <= 1) {
        this.activeStreamableHttpCallsByServerId.delete(server.server_id);
        return;
      }

      this.activeStreamableHttpCallsByServerId.set(server.server_id, currentActiveCalls - 1);
    };
  }

  canHandle(action: ActionRecord): boolean {
    if (action.operation.domain !== "mcp") {
      return false;
    }

    const mcpFacet = action.facets.mcp as McpFacet | undefined;
    return typeof mcpFacet?.server_id === "string" && this.getRegisteredServer(mcpFacet.server_id) !== null;
  }

  async verifyPreconditions(context: ExecutionContext): Promise<void> {
    const mcpFacet = context.action.facets.mcp as McpFacet | undefined;
    const serverId = typeof mcpFacet?.server_id === "string" ? mcpFacet.server_id : "";
    const toolName = typeof mcpFacet?.tool_name === "string" ? mcpFacet.tool_name : "";
    const server = this.getRegisteredServer(serverId);

    if (!server) {
      throw new PreconditionError("MCP action target is not backed by a registered governed server.", {
        action_id: context.action.action_id,
        server_id: serverId,
      });
    }

    if (!server.tools.some((tool) => tool.tool_name === toolName)) {
      throw new PreconditionError("MCP action target is not backed by a registered governed tool.", {
        action_id: context.action.action_id,
        server_id: serverId,
        tool_name: toolName,
      });
    }

    if (context.action.execution_path.credential_mode === "direct") {
      throw new PreconditionError("Governed MCP execution does not accept direct client-provided credentials.", {
        action_id: context.action.action_id,
        server_id: serverId,
        tool_name: toolName,
      });
    }

    if (server.transport === "streamable_http") {
      assertStreamableHttpPublicEgressAllowed(server, this.publicHostPolicyRegistry);
      resolveStreamableHttpHeaders(server, this.broker);
    } else {
      createSandboxedStdioLaunch(server, context.workspace_root);
    }
  }

  async execute(context: ExecutionContext): Promise<ExecutionResult> {
    const mcpFacet = context.action.facets.mcp as McpFacet | undefined;
    const rawInput = context.action.input.raw as McpRawInput;
    const serverId = typeof mcpFacet?.server_id === "string" ? mcpFacet.server_id : "";
    const toolName = typeof mcpFacet?.tool_name === "string" ? mcpFacet.tool_name : "";
    const server = this.getRegisteredServer(serverId);
    if (!server) {
      throw new AgentGitError("MCP server is not registered for governed execution.", "CAPABILITY_UNAVAILABLE", {
        action_id: context.action.action_id,
        server_id: serverId,
      });
    }

    const executionId = `exec_mcp_${Date.now()}`;
    const startedAt = new Date().toISOString();
    const argumentsObject = isRecord(rawInput.arguments) ? rawInput.arguments : {};
    const timeoutMs = resolveMcpTimeoutMs(server);
    const releaseExecutionSlot = this.acquireStreamableHttpExecutionSlot(server, timeoutMs);
    if (server.transport === "streamable_http") {
      assertStreamableHttpPublicEgressAllowed(server, this.publicHostPolicyRegistry);
    }
    const { transport, readStderr } = createMcpTransport(
      server,
      context.workspace_root,
      this.broker,
      this.publicHostPolicyRegistry,
      this.hostnameResolver,
    );
    const client = new Client({
      name: "agentgit-governed-mcp-proxy",
      version: "0.1.0",
    });

    try {
      await withTimeout(
        client.connect(transport),
        timeoutMs,
        () =>
          new AgentGitError("Timed out while connecting to the governed MCP server.", "PRECONDITION_FAILED", {
            action_id: context.action.action_id,
            server_id: server.server_id,
            tool_name: toolName,
            timeout_ms: timeoutMs,
            transport: server.transport,
          }),
      );

      const listedTools: Array<{ name: string; annotations?: Record<string, unknown> }> = [];
      let cursor: string | undefined;
      do {
        const listed = await withTimeout(
          client.listTools(cursor ? { cursor } : undefined),
          timeoutMs,
          () =>
            new AgentGitError("Timed out while listing tools from the governed MCP server.", "PRECONDITION_FAILED", {
              action_id: context.action.action_id,
              server_id: server.server_id,
              timeout_ms: timeoutMs,
              transport: server.transport,
            }),
        );
        listedTools.push(...listed.tools);
        cursor = typeof listed.nextCursor === "string" && listed.nextCursor.length > 0 ? listed.nextCursor : undefined;
      } while (cursor);

      const upstreamTool = listedTools.find((tool) => tool.name === toolName);
      if (!upstreamTool) {
        throw new AgentGitError("Governed MCP server did not advertise the requested tool.", "CAPABILITY_UNAVAILABLE", {
          action_id: context.action.action_id,
          server_id: server.server_id,
          tool_name: toolName,
        });
      }

      const result = await withTimeout(
        client.callTool({
          name: toolName,
          arguments: argumentsObject,
        }),
        timeoutMs,
        () =>
          new AgentGitError("Timed out while waiting for the governed MCP tool response.", "PRECONDITION_FAILED", {
            action_id: context.action.action_id,
            server_id: server.server_id,
            tool_name: toolName,
            timeout_ms: timeoutMs,
            transport: server.transport,
          }),
      );
      const stderr = readStderr();
      const preview = JSON.stringify(
        {
          request: {
            server_id: server.server_id,
            tool_name: toolName,
            arguments: argumentsObject,
            transport: server.transport,
            transport_target: server.transport === "streamable_http" ? server.url : server.command,
          },
          response: {
            isError: result.isError ?? false,
            content: result.content ?? [],
            structuredContent: result.structuredContent ?? null,
          },
        },
        null,
        2,
      );
      const completedAt = new Date().toISOString();
      const artifacts: ExecutionArtifact[] = [
        inlineArtifact("request_response", executionId, Buffer.byteLength(preview, "utf8")),
      ];
      if (stderr.length > 0) {
        artifacts.push(inlineArtifact("stderr", executionId, Buffer.byteLength(stderr, "utf8")));
      }

      return {
        execution_id: executionId,
        action_id: context.action.action_id,
        mode: "executed",
        success: !(result.isError ?? false),
        output: {
          executed: true,
          domain: "mcp",
          server_id: server.server_id,
          tool_name: toolName,
          transport: server.transport,
          transport_target: server.transport === "streamable_http" ? server.url : server.command,
          auth_type: server.transport === "streamable_http" ? (server.auth?.type ?? "none") : "none",
          network_scope: server.transport === "streamable_http" ? (server.network_scope ?? "loopback") : null,
          max_concurrent_calls: server.transport === "streamable_http" ? (server.max_concurrent_calls ?? 1) : null,
          tool_display_name: server.display_name ?? server.server_id,
          listed_tool_count: listedTools.length,
          upstream_annotations: upstreamTool.annotations ?? null,
          is_error: result.isError ?? false,
          content: result.content ?? [],
          structured_content: result.structuredContent ?? null,
          summary: summarizeMcpContent(result),
          preview,
          stderr,
        },
        artifacts,
        error:
          result.isError === true
            ? {
                code: "MCP_TOOL_ERROR",
                message: `MCP tool ${server.server_id}/${toolName} returned an error result.`,
                partial_effects: false,
              }
            : undefined,
        started_at: startedAt,
        completed_at: completedAt,
      };
    } catch (error) {
      if (error instanceof AgentGitError) {
        throw error;
      }

      throw new AgentGitError("Governed MCP execution failed.", "CAPABILITY_UNAVAILABLE", {
        action_id: context.action.action_id,
        server_id: server.server_id,
        tool_name: toolName,
        transport: server.transport,
        network_scope: server.transport === "streamable_http" ? (server.network_scope ?? "loopback") : null,
        cause: error instanceof Error ? error.message : String(error),
      });
    } finally {
      releaseExecutionSlot();
      await transport.close().catch(() => undefined);
    }
  }

  close(): void {
    this.concurrencyLeaseStore?.close();
  }
}

function isNormalizedPathInsideRoot(targetPath: string, rootPath: string): boolean {
  return targetPath === rootPath || targetPath.startsWith(`${rootPath}${path.sep}`);
}

async function resolveExistingPath(
  targetPath: string,
): Promise<{ status: "resolved"; path: string } | { status: "missing" | "error" }> {
  try {
    return {
      status: "resolved",
      path: await fs.realpath(path.resolve(targetPath)),
    };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
    return {
      status: code === "ENOENT" ? "missing" : "error",
    };
  }
}

async function canonicalizeTargetPath(targetPath: string): Promise<string | null> {
  const missingSegments: string[] = [];
  let currentPath = path.resolve(targetPath);

  while (true) {
    const resolved = await resolveExistingPath(currentPath);
    if (resolved.status === "resolved") {
      return missingSegments.length === 0 ? resolved.path : path.join(resolved.path, ...missingSegments.reverse());
    }

    if (resolved.status === "error") {
      return null;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return path.resolve(targetPath);
    }

    missingSegments.push(path.basename(currentPath));
    currentPath = parentPath;
  }
}

async function isPathInsideRoot(targetPath: string, rootPath: string): Promise<boolean> {
  const [normalizedRoot, normalizedTarget] = await Promise.all([
    resolveExistingPath(rootPath),
    canonicalizeTargetPath(targetPath),
  ]);

  if (normalizedRoot.status !== "resolved" || normalizedTarget === null) {
    return false;
  }

  return isNormalizedPathInsideRoot(normalizedTarget, normalizedRoot.path);
}

async function resolvePathInsideRoot(targetPath: string, rootPath: string): Promise<string> {
  const [normalizedRoot, normalizedTarget] = await Promise.all([
    resolveExistingPath(rootPath),
    canonicalizeTargetPath(targetPath),
  ]);

  if (
    normalizedRoot.status !== "resolved" ||
    normalizedTarget === null ||
    !isNormalizedPathInsideRoot(normalizedTarget, normalizedRoot.path)
  ) {
    throw new PreconditionError("Resolved path is outside the governed workspace root.", {
      target: targetPath,
      workspace_root: rootPath,
    });
  }

  return normalizedTarget;
}

function fileContentArtifact(targetPath: string, byteSize: number): ExecutionArtifact {
  return {
    artifact_id: `artifact_file_${Date.now()}`,
    type: "file_content",
    content_ref: targetPath,
    byte_size: byteSize,
    visibility: "user",
  };
}

function inlineArtifact(type: ExecutionArtifact["type"], executionId: string, byteSize: number): ExecutionArtifact {
  return {
    artifact_id: `artifact_${type}_${Date.now()}`,
    type,
    content_ref: `inline://${executionId}/${type}`,
    byte_size: byteSize,
    visibility: "user",
  };
}

function textPreview(value: string, maxLength = 160): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

async function readExistingText(targetPath: string): Promise<string | null> {
  try {
    return await fs.readFile(targetPath, "utf8");
  } catch {
    return null;
  }
}

function buildDiffPreview(before: string | null, after: string): string {
  if (before === null || before.length === 0) {
    return `+ ${textPreview(after)}`;
  }

  if (before === after) {
    return `= ${textPreview(after)}`;
  }

  return `- ${textPreview(before)}\n+ ${textPreview(after)}`;
}

function isDraftStatus(value: unknown): value is DraftRecord["status"] {
  return value === "active" || value === "archived" || value === "deleted";
}

function isNoteStatus(value: unknown): value is NoteRecord["status"] {
  return value === "active" || value === "archived" || value === "deleted";
}

function isTicketStatus(value: unknown): value is TicketRecord["status"] {
  return value === "active" || value === "closed" || value === "deleted";
}

function normalizeTicketLabels(value: unknown, ticketId: string): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new AgentGitError("Owned ticket store contains a malformed ticket record.", "STORAGE_UNAVAILABLE", {
      ticket_id: ticketId,
    });
  }

  return [...new Set(value)];
}

function normalizeTicketAssignedUsers(value: unknown, ticketId: string): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new AgentGitError("Owned ticket store contains a malformed ticket record.", "STORAGE_UNAVAILABLE", {
      ticket_id: ticketId,
    });
  }

  return [...new Set(value)];
}

function normalizeDraftLabels(value: unknown, draftId: string): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new AgentGitError("Owned draft store contains a malformed draft record.", "STORAGE_UNAVAILABLE", {
      draft_id: draftId,
    });
  }

  return [...new Set(value)];
}

function coerceDraftRecord(draftId: string, value: unknown): DraftRecord {
  if (!isRecord(value)) {
    throw new AgentGitError("Owned draft store contains an invalid draft entry.", "STORAGE_UNAVAILABLE", {
      draft_id: draftId,
    });
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.draft_id !== "string" ||
    typeof record.subject !== "string" ||
    typeof record.body !== "string" ||
    !isDraftStatus(record.status) ||
    typeof record.action_id !== "string" ||
    typeof record.created_at !== "string" ||
    (record.archived_at !== null && typeof record.archived_at !== "string") ||
    (record.deleted_at !== null && typeof record.deleted_at !== "string")
  ) {
    throw new AgentGitError("Owned draft store contains a malformed draft record.", "STORAGE_UNAVAILABLE", {
      draft_id: draftId,
    });
  }

  return {
    draft_id: record.draft_id,
    subject: record.subject,
    body: record.body,
    labels: normalizeDraftLabels(record.labels, draftId),
    status: record.status,
    action_id: record.action_id,
    created_at: record.created_at,
    archived_at: record.archived_at,
    deleted_at: record.deleted_at,
  };
}

export function parseDraftLocator(locator: string): string | null {
  const prefix = "drafts://message_draft/";
  if (!locator.startsWith(prefix)) {
    return null;
  }

  const suffix = locator.slice(prefix.length);
  const labelSeparatorIndex = suffix.indexOf("/labels/");
  const draftId = labelSeparatorIndex >= 0 ? suffix.slice(0, labelSeparatorIndex) : suffix;
  return draftId.length > 0 ? draftId : null;
}

export function parseDraftLabelLocator(locator: string): { draftId: string; label: string } | null {
  const prefix = "drafts://message_draft/";
  if (!locator.startsWith(prefix)) {
    return null;
  }

  const suffix = locator.slice(prefix.length);
  const labelSeparator = "/labels/";
  const labelSeparatorIndex = suffix.indexOf(labelSeparator);
  if (labelSeparatorIndex < 0) {
    return null;
  }

  const draftId = suffix.slice(0, labelSeparatorIndex);
  const encodedLabel = suffix.slice(labelSeparatorIndex + labelSeparator.length);
  if (draftId.length === 0 || encodedLabel.length === 0) {
    return null;
  }

  return {
    draftId,
    label: decodeURIComponent(encodedLabel),
  };
}

function coerceNoteRecord(noteId: string, value: unknown): NoteRecord {
  if (!isRecord(value)) {
    throw new AgentGitError("Owned note store contains an invalid note entry.", "STORAGE_UNAVAILABLE", {
      note_id: noteId,
    });
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.note_id !== "string" ||
    typeof record.title !== "string" ||
    typeof record.body !== "string" ||
    !isNoteStatus(record.status) ||
    typeof record.action_id !== "string" ||
    typeof record.created_at !== "string" ||
    (record.archived_at !== null && typeof record.archived_at !== "string") ||
    (record.deleted_at !== null && typeof record.deleted_at !== "string")
  ) {
    throw new AgentGitError("Owned note store contains a malformed note record.", "STORAGE_UNAVAILABLE", {
      note_id: noteId,
    });
  }

  return {
    note_id: record.note_id,
    title: record.title,
    body: record.body,
    status: record.status,
    action_id: record.action_id,
    created_at: record.created_at,
    archived_at: record.archived_at,
    deleted_at: record.deleted_at,
  };
}

export function parseNoteLocator(locator: string): string | null {
  const prefix = "notes://workspace_note/";
  if (!locator.startsWith(prefix)) {
    return null;
  }

  const noteId = locator.slice(prefix.length);
  return noteId.length > 0 ? noteId : null;
}

function coerceTicketRecord(ticketId: string, value: unknown): TicketRecord {
  if (!isRecord(value)) {
    throw new AgentGitError("Owned ticket store contains an invalid ticket entry.", "STORAGE_UNAVAILABLE", {
      ticket_id: ticketId,
    });
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.ticket_id !== "string" ||
    typeof record.title !== "string" ||
    typeof record.body !== "string" ||
    !isTicketStatus(record.status) ||
    typeof record.action_id !== "string" ||
    typeof record.remote_url !== "string" ||
    typeof record.created_at !== "string" ||
    (record.closed_at !== null && typeof record.closed_at !== "string") ||
    (record.deleted_at !== null && typeof record.deleted_at !== "string")
  ) {
    throw new AgentGitError("Owned ticket store contains a malformed ticket record.", "STORAGE_UNAVAILABLE", {
      ticket_id: ticketId,
    });
  }

  return {
    ticket_id: record.ticket_id,
    title: record.title,
    body: record.body,
    labels: normalizeTicketLabels(record.labels, ticketId),
    assigned_users: normalizeTicketAssignedUsers(record.assigned_users, ticketId),
    status: record.status,
    action_id: record.action_id,
    remote_url: record.remote_url,
    created_at: record.created_at,
    closed_at: record.closed_at,
    deleted_at: record.deleted_at,
  };
}

function buildRestoredTicketRecord(existing: TicketRecord, restoredState: TicketRestoreState): TicketRecord {
  const transitionAt = new Date().toISOString();

  return {
    ...existing,
    title: restoredState.title,
    body: restoredState.body,
    labels: [...restoredState.labels],
    assigned_users: [...restoredState.assigned_users],
    status: restoredState.status,
    closed_at:
      restoredState.status === "closed"
        ? (existing.closed_at ?? transitionAt)
        : restoredState.status === "deleted"
          ? existing.closed_at
          : null,
    deleted_at: restoredState.status === "deleted" ? (existing.deleted_at ?? transitionAt) : null,
  };
}

export function parseTicketLocator(locator: string): string | null {
  const prefix = "tickets://issue/";
  if (!locator.startsWith(prefix)) {
    return null;
  }

  const suffix = locator.slice(prefix.length);
  const firstNestedSeparatorIndex = [suffix.indexOf("/labels/"), suffix.indexOf("/assignees/")]
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  const ticketId = firstNestedSeparatorIndex !== undefined ? suffix.slice(0, firstNestedSeparatorIndex) : suffix;
  return ticketId.length > 0 ? ticketId : null;
}

export function parseTicketLabelLocator(locator: string): { ticketId: string; label: string } | null {
  const prefix = "tickets://issue/";
  if (!locator.startsWith(prefix)) {
    return null;
  }

  const suffix = locator.slice(prefix.length);
  const labelSeparator = "/labels/";
  const labelSeparatorIndex = suffix.indexOf(labelSeparator);
  if (labelSeparatorIndex < 0) {
    return null;
  }

  const ticketId = suffix.slice(0, labelSeparatorIndex);
  const encodedLabel = suffix.slice(labelSeparatorIndex + labelSeparator.length);
  if (ticketId.length === 0 || encodedLabel.length === 0) {
    return null;
  }

  return {
    ticketId,
    label: decodeURIComponent(encodedLabel),
  };
}

export function parseTicketAssigneeLocator(locator: string): { ticketId: string; userId: string } | null {
  const prefix = "tickets://issue/";
  if (!locator.startsWith(prefix)) {
    return null;
  }

  const suffix = locator.slice(prefix.length);
  const assigneeSeparator = "/assignees/";
  const assigneeSeparatorIndex = suffix.indexOf(assigneeSeparator);
  if (assigneeSeparatorIndex < 0) {
    return null;
  }

  const ticketId = suffix.slice(0, assigneeSeparatorIndex);
  const encodedUserId = suffix.slice(assigneeSeparatorIndex + assigneeSeparator.length);
  if (ticketId.length === 0 || encodedUserId.length === 0) {
    return null;
  }

  return {
    ticketId,
    userId: decodeURIComponent(encodedUserId),
  };
}

export class OwnedDraftStore {
  private readonly state: IntegrationState<{ drafts: DraftRecord }>;
  private readonly storePath: string;

  constructor(storePath: string) {
    this.storePath = storePath;
    this.state = new IntegrationState({
      dbPath: storePath,
      collections: {
        drafts: {
          parse(key, value) {
            return coerceDraftRecord(key, value);
          },
        },
      },
    });
  }

  async createDraft(params: {
    draftId: string;
    subject: string;
    body: string;
    actionId: string;
  }): Promise<DraftRecord> {
    const record: DraftRecord = {
      draft_id: params.draftId,
      subject: params.subject,
      body: params.body,
      labels: [],
      status: "active",
      action_id: params.actionId,
      created_at: new Date().toISOString(),
      archived_at: null,
      deleted_at: null,
    };

    const inserted = this.state.putIfAbsent("drafts", params.draftId, record);
    if (inserted) {
      return record;
    }

    const existing = this.state.get("drafts", params.draftId);
    if (
      existing &&
      existing.action_id === params.actionId &&
      existing.subject === params.subject &&
      existing.body === params.body &&
      existing.status === "active"
    ) {
      return existing;
    }

    throw new AgentGitError("Draft identifier is already in use.", "CONFLICT", {
      draft_id: params.draftId,
      existing_action_id: existing?.action_id ?? null,
      attempted_action_id: params.actionId,
      existing_status: existing?.status ?? null,
    });
  }

  async archiveDraft(draftId: string): Promise<DraftRecord | null> {
    const existing = this.state.get("drafts", draftId);
    if (!existing) {
      return null;
    }

    if (existing.status === "archived") {
      return existing;
    }

    if (existing.status === "deleted") {
      throw new AgentGitError("Deleted drafts cannot be archived.", "CONFLICT", {
        draft_id: draftId,
        existing_status: existing.status,
      });
    }

    const updated: DraftRecord = {
      ...existing,
      status: "archived",
      archived_at: new Date().toISOString(),
      deleted_at: null,
    };
    return this.state.put("drafts", draftId, updated);
  }

  async updateDraft(
    draftId: string,
    updates: {
      subject?: string;
      body?: string;
    },
  ): Promise<DraftRecord | null> {
    const existing = this.state.get("drafts", draftId);
    if (!existing) {
      return null;
    }

    if (existing.status !== "active") {
      throw new AgentGitError("Non-active drafts cannot be updated.", "CONFLICT", {
        draft_id: draftId,
        existing_status: existing.status,
      });
    }

    const updated: DraftRecord = {
      ...existing,
      subject: updates.subject ?? existing.subject,
      body: updates.body ?? existing.body,
    };
    return this.state.put("drafts", draftId, updated);
  }

  async addLabel(draftId: string, label: string): Promise<DraftRecord | null> {
    const existing = this.state.get("drafts", draftId);
    if (!existing) {
      return null;
    }

    if (existing.status !== "active") {
      throw new AgentGitError("Non-active drafts cannot be labeled.", "CONFLICT", {
        draft_id: draftId,
        existing_status: existing.status,
      });
    }

    if (existing.labels.includes(label)) {
      return existing;
    }

    const updated: DraftRecord = {
      ...existing,
      labels: [...existing.labels, label],
    };
    return this.state.put("drafts", draftId, updated);
  }

  async removeLabel(draftId: string, label: string): Promise<DraftRecord | null> {
    const existing = this.state.get("drafts", draftId);
    if (!existing) {
      return null;
    }

    if (!existing.labels.includes(label)) {
      return existing;
    }

    const updated: DraftRecord = {
      ...existing,
      labels: existing.labels.filter((entry) => entry !== label),
    };
    return this.state.put("drafts", draftId, updated);
  }

  async unarchiveDraft(draftId: string): Promise<DraftRecord | null> {
    const existing = this.state.get("drafts", draftId);
    if (!existing) {
      return null;
    }

    if (existing.status === "active") {
      return existing;
    }

    if (existing.status === "deleted") {
      throw new AgentGitError("Deleted drafts cannot be unarchived.", "CONFLICT", {
        draft_id: draftId,
        existing_status: existing.status,
      });
    }

    const updated: DraftRecord = {
      ...existing,
      status: "active",
      archived_at: null,
      deleted_at: null,
    };
    return this.state.put("drafts", draftId, updated);
  }

  async deleteDraft(draftId: string): Promise<DraftRecord | null> {
    const existing = this.state.get("drafts", draftId);
    if (!existing) {
      return null;
    }

    if (existing.status === "deleted") {
      return existing;
    }

    const updated: DraftRecord = {
      ...existing,
      status: "deleted",
      deleted_at: new Date().toISOString(),
    };
    return this.state.put("drafts", draftId, updated);
  }

  async restoreDraftFromSnapshot(draftId: string, snapshotValue: unknown): Promise<DraftRecord> {
    const restored = coerceDraftRecord(draftId, snapshotValue);
    return this.state.put("drafts", draftId, restored);
  }

  async getDraft(draftId: string): Promise<DraftRecord | null> {
    return this.state.get("drafts", draftId);
  }

  close(): void {
    this.state.close();
  }

  checkpointWal() {
    return this.state.checkpointWal();
  }
}

export class OwnedNoteStore {
  private readonly state: IntegrationState<{ notes: NoteRecord }>;

  constructor(storePath: string) {
    this.state = new IntegrationState({
      dbPath: storePath,
      collections: {
        notes: {
          parse(key, value) {
            return coerceNoteRecord(key, value);
          },
        },
      },
    });
  }

  async createNote(params: { noteId: string; title: string; body: string; actionId: string }): Promise<NoteRecord> {
    const record: NoteRecord = {
      note_id: params.noteId,
      title: params.title,
      body: params.body,
      status: "active",
      action_id: params.actionId,
      created_at: new Date().toISOString(),
      archived_at: null,
      deleted_at: null,
    };

    const inserted = this.state.putIfAbsent("notes", params.noteId, record);
    if (inserted) {
      return record;
    }

    const existing = this.state.get("notes", params.noteId);
    if (
      existing &&
      existing.action_id === params.actionId &&
      existing.title === params.title &&
      existing.body === params.body &&
      existing.status === "active"
    ) {
      return existing;
    }

    throw new AgentGitError("Note identifier is already in use.", "CONFLICT", {
      note_id: params.noteId,
      existing_action_id: existing?.action_id ?? null,
      attempted_action_id: params.actionId,
      existing_status: existing?.status ?? null,
    });
  }

  async archiveNote(noteId: string): Promise<NoteRecord | null> {
    const existing = this.state.get("notes", noteId);
    if (!existing) {
      return null;
    }

    if (existing.status === "archived") {
      return existing;
    }

    if (existing.status === "deleted") {
      throw new AgentGitError("Deleted notes cannot be archived.", "CONFLICT", {
        note_id: noteId,
        existing_status: existing.status,
      });
    }

    const updated: NoteRecord = {
      ...existing,
      status: "archived",
      archived_at: new Date().toISOString(),
    };
    return this.state.put("notes", noteId, updated);
  }

  async updateNote(
    noteId: string,
    updates: {
      title?: string;
      body?: string;
    },
  ): Promise<NoteRecord | null> {
    const existing = this.state.get("notes", noteId);
    if (!existing) {
      return null;
    }

    if (existing.status !== "active") {
      throw new AgentGitError("Non-active notes cannot be updated.", "CONFLICT", {
        note_id: noteId,
        existing_status: existing.status,
      });
    }

    const updated: NoteRecord = {
      ...existing,
      title: updates.title ?? existing.title,
      body: updates.body ?? existing.body,
    };
    return this.state.put("notes", noteId, updated);
  }

  async unarchiveNote(noteId: string): Promise<NoteRecord | null> {
    const existing = this.state.get("notes", noteId);
    if (!existing) {
      return null;
    }

    if (existing.status === "active") {
      return existing;
    }

    if (existing.status === "deleted") {
      throw new AgentGitError("Deleted notes cannot be unarchived.", "CONFLICT", {
        note_id: noteId,
        existing_status: existing.status,
      });
    }

    const updated: NoteRecord = {
      ...existing,
      status: "active",
      archived_at: null,
    };
    return this.state.put("notes", noteId, updated);
  }

  async deleteNote(noteId: string): Promise<NoteRecord | null> {
    const existing = this.state.get("notes", noteId);
    if (!existing) {
      return null;
    }

    if (existing.status === "deleted") {
      return existing;
    }

    const updated: NoteRecord = {
      ...existing,
      status: "deleted",
      deleted_at: new Date().toISOString(),
    };
    return this.state.put("notes", noteId, updated);
  }

  async restoreNoteFromSnapshot(noteId: string, snapshotValue: unknown): Promise<NoteRecord> {
    const restored = coerceNoteRecord(noteId, snapshotValue);
    return this.state.put("notes", noteId, restored);
  }

  async getNote(noteId: string): Promise<NoteRecord | null> {
    return this.state.get("notes", noteId);
  }

  close(): void {
    this.state.close();
  }

  checkpointWal() {
    return this.state.checkpointWal();
  }
}

export class OwnedTicketStore {
  private readonly state: IntegrationState<{ tickets: TicketRecord }>;

  constructor(storePath: string) {
    this.state = new IntegrationState({
      dbPath: storePath,
      collections: {
        tickets: {
          parse(key, value) {
            return coerceTicketRecord(key, value);
          },
        },
      },
    });
  }

  async recordCreatedTicket(params: {
    ticketId: string;
    title: string;
    body: string;
    actionId: string;
    remoteUrl: string;
  }): Promise<TicketRecord> {
    const record: TicketRecord = {
      ticket_id: params.ticketId,
      title: params.title,
      body: params.body,
      labels: [],
      assigned_users: [],
      status: "active",
      action_id: params.actionId,
      remote_url: params.remoteUrl,
      created_at: new Date().toISOString(),
      closed_at: null,
      deleted_at: null,
    };

    const inserted = this.state.putIfAbsent("tickets", params.ticketId, record);
    if (inserted) {
      return record;
    }

    const existing = this.state.get("tickets", params.ticketId);
    if (
      existing &&
      existing.action_id === params.actionId &&
      existing.title === params.title &&
      existing.body === params.body &&
      existing.remote_url === params.remoteUrl &&
      existing.status === "active"
    ) {
      return existing;
    }

    throw new AgentGitError("Ticket identifier is already in use.", "CONFLICT", {
      ticket_id: params.ticketId,
      existing_action_id: existing?.action_id ?? null,
      attempted_action_id: params.actionId,
      existing_status: existing?.status ?? null,
    });
  }

  async markDeleted(ticketId: string): Promise<TicketRecord | null> {
    const existing = this.state.get("tickets", ticketId);
    if (!existing) {
      return null;
    }

    if (existing.status === "deleted") {
      return existing;
    }

    const updated: TicketRecord = {
      ...existing,
      status: "deleted",
      closed_at: existing.closed_at,
      deleted_at: new Date().toISOString(),
    };
    return this.state.put("tickets", ticketId, updated);
  }

  async closeTicket(ticketId: string): Promise<TicketRecord | null> {
    const existing = this.state.get("tickets", ticketId);
    if (!existing) {
      return null;
    }

    if (existing.status === "deleted") {
      throw new AgentGitError("Deleted tickets cannot be closed.", "CONFLICT", {
        ticket_id: ticketId,
        existing_status: existing.status,
      });
    }

    if (existing.status === "closed") {
      return existing;
    }

    const updated: TicketRecord = {
      ...existing,
      status: "closed",
      closed_at: new Date().toISOString(),
    };
    return this.state.put("tickets", ticketId, updated);
  }

  async addLabel(ticketId: string, label: string): Promise<TicketRecord | null> {
    const existing = this.state.get("tickets", ticketId);
    if (!existing) {
      return null;
    }

    if (existing.status !== "active") {
      throw new AgentGitError("Only active tickets can be labeled.", "CONFLICT", {
        ticket_id: ticketId,
        existing_status: existing.status,
      });
    }

    if (existing.labels.includes(label)) {
      return existing;
    }

    const updated: TicketRecord = {
      ...existing,
      labels: [...existing.labels, label],
    };
    return this.state.put("tickets", ticketId, updated);
  }

  async removeLabel(ticketId: string, label: string): Promise<TicketRecord | null> {
    const existing = this.state.get("tickets", ticketId);
    if (!existing) {
      return null;
    }

    if (!existing.labels.includes(label)) {
      return existing;
    }

    const updated: TicketRecord = {
      ...existing,
      labels: existing.labels.filter((entry) => entry !== label),
    };
    return this.state.put("tickets", ticketId, updated);
  }

  async assignUser(ticketId: string, userId: string): Promise<TicketRecord | null> {
    const existing = this.state.get("tickets", ticketId);
    if (!existing) {
      return null;
    }

    if (existing.status !== "active") {
      throw new AgentGitError("Only active tickets can be assigned.", "CONFLICT", {
        ticket_id: ticketId,
        existing_status: existing.status,
        user_id: userId,
      });
    }

    if (existing.assigned_users.includes(userId)) {
      return existing;
    }

    const updated: TicketRecord = {
      ...existing,
      assigned_users: [...existing.assigned_users, userId],
    };
    return this.state.put("tickets", ticketId, updated);
  }

  async unassignUser(ticketId: string, userId: string): Promise<TicketRecord | null> {
    const existing = this.state.get("tickets", ticketId);
    if (!existing) {
      return null;
    }

    if (!existing.assigned_users.includes(userId)) {
      return existing;
    }

    const updated: TicketRecord = {
      ...existing,
      assigned_users: existing.assigned_users.filter((entry) => entry !== userId),
    };
    return this.state.put("tickets", ticketId, updated);
  }

  async reopenTicket(ticketId: string): Promise<TicketRecord | null> {
    const existing = this.state.get("tickets", ticketId);
    if (!existing) {
      return null;
    }

    if (existing.status === "deleted") {
      throw new AgentGitError("Deleted tickets cannot be reopened.", "CONFLICT", {
        ticket_id: ticketId,
        existing_status: existing.status,
      });
    }

    if (existing.status === "active") {
      return existing;
    }

    const updated: TicketRecord = {
      ...existing,
      status: "active",
      closed_at: null,
    };
    return this.state.put("tickets", ticketId, updated);
  }

  async updateTicket(
    ticketId: string,
    updates: {
      title?: string;
      body?: string;
    },
  ): Promise<TicketRecord | null> {
    const existing = this.state.get("tickets", ticketId);
    if (!existing) {
      return null;
    }

    if (existing.status !== "active") {
      throw new AgentGitError("Only active tickets can be updated.", "CONFLICT", {
        ticket_id: ticketId,
        existing_status: existing.status,
      });
    }

    const updated: TicketRecord = {
      ...existing,
      title: updates.title ?? existing.title,
      body: updates.body ?? existing.body,
    };
    return this.state.put("tickets", ticketId, updated);
  }

  async restoreTicketFromSnapshot(ticketId: string, snapshotValue: unknown): Promise<TicketRecord> {
    const restored = coerceTicketRecord(ticketId, snapshotValue);
    return this.state.put("tickets", ticketId, restored);
  }

  async getTicket(ticketId: string): Promise<TicketRecord | null> {
    return this.state.get("tickets", ticketId);
  }

  close(): void {
    this.state.close();
  }

  checkpointWal() {
    return this.state.checkpointWal();
  }
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function resolveTicketUrl(baseUrl: string, ticketId: string): string {
  const encodedTicketId = encodeURIComponent(ticketId);
  return new URL(`tickets/${encodedTicketId}`, baseUrl).toString();
}

function responsePreview(status: number, bodyText: string): string {
  const normalizedBody = bodyText.trim();
  if (normalizedBody.length === 0) {
    return `HTTP ${status}`;
  }

  const parsed = safeJsonParse(normalizedBody);
  if (isRecord(parsed)) {
    if (typeof parsed.message === "string" && parsed.message.length > 0) {
      return `HTTP ${status}: ${textPreview(parsed.message)}`;
    }
    if (typeof parsed.error === "string" && parsed.error.length > 0) {
      return `HTTP ${status}: ${textPreview(parsed.error)}`;
    }
  }

  return `HTTP ${status}: ${textPreview(normalizedBody)}`;
}

export class OwnedTicketIntegration {
  constructor(
    private readonly store: OwnedTicketStore,
    private readonly broker: SessionCredentialBroker,
  ) {}

  async createTicket(params: { ticketId: string; title: string; body: string; actionId: string }): Promise<{
    record: TicketRecord;
    artifactPreview: string;
    brokerHandleId: string;
    brokerProfileId: string;
    responseStatus: number;
    requestUrl: string;
  }> {
    const access = this.broker.resolveBearerAccess({
      integration: "tickets",
      required_scope: "tickets:write",
    });
    const requestUrl = resolveTicketUrl(access.base_url, params.ticketId);
    const response = await fetch(requestUrl, {
      method: "PUT",
      headers: {
        authorization: access.authorization_header,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ticket_id: params.ticketId,
        title: params.title,
        body: params.body,
      }),
    });
    const responseText = await response.text();

    if (!response.ok) {
      throw new AgentGitError("Owned ticket request failed.", "UPSTREAM_FAILURE", {
        integration: "tickets",
        operation: "create_ticket",
        status_code: response.status,
        request_url: requestUrl,
        broker_handle_id: access.handle.handle_id,
        broker_profile_id: access.handle.profile_id,
        response_preview: responsePreview(response.status, responseText),
      });
    }

    const record = await this.store.recordCreatedTicket({
      ticketId: params.ticketId,
      title: params.title,
      body: params.body,
      actionId: params.actionId,
      remoteUrl: requestUrl,
    });

    return {
      record,
      artifactPreview: `PUT ${requestUrl}\n${responsePreview(response.status, responseText)}`,
      brokerHandleId: access.handle.handle_id,
      brokerProfileId: access.handle.profile_id,
      responseStatus: response.status,
      requestUrl,
    };
  }

  async updateTicket(params: { ticketId: string; title?: string; body?: string }): Promise<{
    record: TicketRecord;
    artifactPreview: string;
    brokerHandleId: string;
    brokerProfileId: string;
    responseStatus: number;
    requestUrl: string;
  }> {
    const access = this.broker.resolveBearerAccess({
      integration: "tickets",
      required_scope: "tickets:write",
    });
    const existing = await this.store.getTicket(params.ticketId);
    if (!existing) {
      throw new NotFoundError("Owned ticket could not be found for update.", {
        ticket_id: params.ticketId,
      });
    }
    if (existing.status !== "active") {
      throw new AgentGitError("Only active tickets can be updated.", "CONFLICT", {
        ticket_id: params.ticketId,
        existing_status: existing.status,
      });
    }

    const title = params.title ?? existing.title;
    const body = params.body ?? existing.body;
    const requestUrl = resolveTicketUrl(access.base_url, params.ticketId);
    const response = await fetch(requestUrl, {
      method: "PATCH",
      headers: {
        authorization: access.authorization_header,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ticket_id: params.ticketId,
        ...(params.title === undefined ? {} : { title }),
        ...(params.body === undefined ? {} : { body }),
      }),
    });
    const responseText = await response.text();

    if (response.status === 404) {
      throw new NotFoundError("Owned ticket could not be found upstream for update.", {
        integration: "tickets",
        operation: "update_ticket",
        ticket_id: params.ticketId,
        request_url: requestUrl,
      });
    }

    if (!response.ok) {
      throw new AgentGitError("Owned ticket request failed.", "UPSTREAM_FAILURE", {
        integration: "tickets",
        operation: "update_ticket",
        status_code: response.status,
        request_url: requestUrl,
        broker_handle_id: access.handle.handle_id,
        broker_profile_id: access.handle.profile_id,
        response_preview: responsePreview(response.status, responseText),
      });
    }

    const record = await this.store.updateTicket(params.ticketId, {
      title: params.title,
      body: params.body,
    });
    if (!record) {
      throw new NotFoundError("Owned ticket could not be found for update.", {
        ticket_id: params.ticketId,
      });
    }

    return {
      record,
      artifactPreview: `PATCH ${requestUrl}\n${responsePreview(response.status, responseText)}`,
      brokerHandleId: access.handle.handle_id,
      brokerProfileId: access.handle.profile_id,
      responseStatus: response.status,
      requestUrl,
    };
  }

  async closeTicket(ticketId: string): Promise<{
    record: TicketRecord;
    artifactPreview: string;
    brokerHandleId: string;
    brokerProfileId: string;
    responseStatus: number;
    requestUrl: string;
  }> {
    const access = this.broker.resolveBearerAccess({
      integration: "tickets",
      required_scope: "tickets:write",
    });
    const existing = await this.store.getTicket(ticketId);
    if (!existing) {
      throw new NotFoundError("Owned ticket could not be found for close.", {
        ticket_id: ticketId,
      });
    }
    if (existing.status === "deleted") {
      throw new AgentGitError("Deleted tickets cannot be closed.", "CONFLICT", {
        ticket_id: ticketId,
        existing_status: existing.status,
      });
    }

    const requestUrl = resolveTicketUrl(access.base_url, ticketId);
    const response = await fetch(requestUrl, {
      method: "PATCH",
      headers: {
        authorization: access.authorization_header,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ticket_id: ticketId,
        status: "closed",
      }),
    });
    const responseText = await response.text();

    if (response.status === 404) {
      throw new NotFoundError("Owned ticket could not be found upstream for close.", {
        integration: "tickets",
        operation: "close_ticket",
        ticket_id: ticketId,
        request_url: requestUrl,
      });
    }

    if (!response.ok) {
      throw new AgentGitError("Owned ticket request failed.", "UPSTREAM_FAILURE", {
        integration: "tickets",
        operation: "close_ticket",
        status_code: response.status,
        request_url: requestUrl,
        broker_handle_id: access.handle.handle_id,
        broker_profile_id: access.handle.profile_id,
        response_preview: responsePreview(response.status, responseText),
      });
    }

    const record = await this.store.closeTicket(ticketId);
    if (!record) {
      throw new NotFoundError("Owned ticket could not be found for close.", {
        ticket_id: ticketId,
      });
    }

    return {
      record,
      artifactPreview: `PATCH ${requestUrl}\n${responsePreview(response.status, responseText)}`,
      brokerHandleId: access.handle.handle_id,
      brokerProfileId: access.handle.profile_id,
      responseStatus: response.status,
      requestUrl,
    };
  }

  async addLabel(
    ticketId: string,
    label: string,
  ): Promise<{
    record: TicketRecord;
    artifactPreview: string;
    brokerHandleId: string;
    brokerProfileId: string;
    responseStatus: number;
    requestUrl: string;
  }> {
    const access = this.broker.resolveBearerAccess({
      integration: "tickets",
      required_scope: "tickets:write",
    });
    const existing = await this.store.getTicket(ticketId);
    if (!existing) {
      throw new NotFoundError("Owned ticket could not be found for labeling.", {
        ticket_id: ticketId,
        label,
      });
    }
    if (existing.status !== "active") {
      throw new AgentGitError("Only active tickets can be labeled.", "CONFLICT", {
        ticket_id: ticketId,
        existing_status: existing.status,
        label,
      });
    }

    const requestUrl = resolveTicketUrl(access.base_url, ticketId);
    const response = await fetch(requestUrl, {
      method: "PATCH",
      headers: {
        authorization: access.authorization_header,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ticket_id: ticketId,
        label,
        label_operation: "add",
      }),
    });
    const responseText = await response.text();

    if (response.status === 404) {
      throw new NotFoundError("Owned ticket could not be found upstream for labeling.", {
        integration: "tickets",
        operation: "add_label",
        ticket_id: ticketId,
        label,
        request_url: requestUrl,
      });
    }

    if (!response.ok) {
      throw new AgentGitError("Owned ticket request failed.", "UPSTREAM_FAILURE", {
        integration: "tickets",
        operation: "add_label",
        status_code: response.status,
        request_url: requestUrl,
        broker_handle_id: access.handle.handle_id,
        broker_profile_id: access.handle.profile_id,
        response_preview: responsePreview(response.status, responseText),
      });
    }

    const record = await this.store.addLabel(ticketId, label);
    if (!record) {
      throw new NotFoundError("Owned ticket could not be found for labeling.", {
        ticket_id: ticketId,
        label,
      });
    }

    return {
      record,
      artifactPreview: `PATCH ${requestUrl}\n${responsePreview(response.status, responseText)}`,
      brokerHandleId: access.handle.handle_id,
      brokerProfileId: access.handle.profile_id,
      responseStatus: response.status,
      requestUrl,
    };
  }

  async assignUser(
    ticketId: string,
    userId: string,
  ): Promise<{
    record: TicketRecord;
    artifactPreview: string;
    brokerHandleId: string;
    brokerProfileId: string;
    responseStatus: number;
    requestUrl: string;
  }> {
    const access = this.broker.resolveBearerAccess({
      integration: "tickets",
      required_scope: "tickets:write",
    });
    const existing = await this.store.getTicket(ticketId);
    if (!existing) {
      throw new NotFoundError("Owned ticket could not be found for assignment.", {
        ticket_id: ticketId,
        user_id: userId,
      });
    }
    if (existing.status !== "active") {
      throw new AgentGitError("Only active tickets can be assigned.", "CONFLICT", {
        ticket_id: ticketId,
        existing_status: existing.status,
        user_id: userId,
      });
    }

    const requestUrl = resolveTicketUrl(access.base_url, ticketId);
    const response = await fetch(requestUrl, {
      method: "PATCH",
      headers: {
        authorization: access.authorization_header,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ticket_id: ticketId,
        user_id: userId,
        assignment_operation: "add",
      }),
    });
    const responseText = await response.text();

    if (response.status === 404) {
      throw new NotFoundError("Owned ticket could not be found upstream for assignment.", {
        integration: "tickets",
        operation: "assign_user",
        ticket_id: ticketId,
        user_id: userId,
        request_url: requestUrl,
      });
    }

    if (!response.ok) {
      throw new AgentGitError("Owned ticket request failed.", "UPSTREAM_FAILURE", {
        integration: "tickets",
        operation: "assign_user",
        status_code: response.status,
        request_url: requestUrl,
        broker_handle_id: access.handle.handle_id,
        broker_profile_id: access.handle.profile_id,
        response_preview: responsePreview(response.status, responseText),
      });
    }

    const record = await this.store.assignUser(ticketId, userId);
    if (!record) {
      throw new NotFoundError("Owned ticket could not be found for assignment.", {
        ticket_id: ticketId,
        user_id: userId,
      });
    }

    return {
      record,
      artifactPreview: `PATCH ${requestUrl}\n${responsePreview(response.status, responseText)}`,
      brokerHandleId: access.handle.handle_id,
      brokerProfileId: access.handle.profile_id,
      responseStatus: response.status,
      requestUrl,
    };
  }

  async deleteTicket(ticketId: string): Promise<{
    record: TicketRecord | null;
    artifactPreview: string;
    brokerHandleId: string;
    brokerProfileId: string;
    responseStatus: number;
    requestUrl: string;
  }> {
    const access = this.broker.resolveBearerAccess({
      integration: "tickets",
      required_scope: "tickets:write",
    });
    const requestUrl = resolveTicketUrl(access.base_url, ticketId);
    const response = await fetch(requestUrl, {
      method: "DELETE",
      headers: {
        authorization: access.authorization_header,
      },
    });
    const responseText = await response.text();

    if (response.status !== 404 && !response.ok) {
      throw new AgentGitError("Owned ticket compensation request failed.", "UPSTREAM_FAILURE", {
        integration: "tickets",
        operation: "delete_ticket",
        status_code: response.status,
        request_url: requestUrl,
        broker_handle_id: access.handle.handle_id,
        broker_profile_id: access.handle.profile_id,
        response_preview: responsePreview(response.status, responseText),
      });
    }

    const record = await this.store.markDeleted(ticketId);
    return {
      record,
      artifactPreview: `DELETE ${requestUrl}\n${responsePreview(response.status, responseText)}`,
      brokerHandleId: access.handle.handle_id,
      brokerProfileId: access.handle.profile_id,
      responseStatus: response.status,
      requestUrl,
    };
  }

  async getTicket(ticketId: string): Promise<TicketRecord | null> {
    return this.store.getTicket(ticketId);
  }

  async restoreTicket(params: {
    ticketId: string;
    title: string;
    body: string;
    labels: string[];
    assigned_users: string[];
    status: "active" | "closed";
  }): Promise<{
    record: TicketRecord;
    artifactPreview: string;
    brokerHandleId: string;
    brokerProfileId: string;
    responseStatus: number;
    requestUrl: string;
  }> {
    const existing = await this.store.getTicket(params.ticketId);
    if (!existing) {
      throw new NotFoundError("Owned ticket could not be found for restore.", {
        ticket_id: params.ticketId,
      });
    }

    const restored = buildRestoredTicketRecord(existing, {
      title: params.title,
      body: params.body,
      labels: params.labels,
      assigned_users: params.assigned_users,
      status: params.status,
    });

    return this.restoreTicketFromSnapshot(params.ticketId, restored);
  }

  async restoreTicketFromSnapshot(
    ticketId: string,
    snapshotValue: unknown,
  ): Promise<{
    record: TicketRecord;
    artifactPreview: string;
    brokerHandleId: string;
    brokerProfileId: string;
    responseStatus: number;
    requestUrl: string;
  }> {
    const restored = coerceTicketRecord(ticketId, snapshotValue);
    const access = this.broker.resolveBearerAccess({
      integration: "tickets",
      required_scope: "tickets:write",
    });
    const requestUrl = resolveTicketUrl(access.base_url, ticketId);
    let responseStatus: number;
    let responseText: string;
    let artifactMethod: "PATCH" | "PUT" | "DELETE";

    if (restored.status === "deleted") {
      const deleteResponse = await fetch(requestUrl, {
        method: "DELETE",
        headers: {
          authorization: access.authorization_header,
        },
      });
      responseStatus = deleteResponse.status;
      responseText = await deleteResponse.text();
      artifactMethod = "DELETE";

      if (responseStatus !== 404 && !deleteResponse.ok) {
        throw new AgentGitError("Owned ticket compensation request failed.", "UPSTREAM_FAILURE", {
          integration: "tickets",
          operation: "restore_ticket",
          status_code: responseStatus,
          request_url: requestUrl,
          broker_handle_id: access.handle.handle_id,
          broker_profile_id: access.handle.profile_id,
          response_preview: responsePreview(responseStatus, responseText),
        });
      }
    } else {
      const patchPayload = {
        ticket_id: ticketId,
        status: restored.status,
        title: restored.title,
        body: restored.body,
        labels: restored.labels,
        assigned_users: restored.assigned_users,
      };

      const patchResponse = await fetch(requestUrl, {
        method: "PATCH",
        headers: {
          authorization: access.authorization_header,
          "content-type": "application/json",
        },
        body: JSON.stringify(patchPayload),
      });
      responseStatus = patchResponse.status;
      responseText = await patchResponse.text();
      artifactMethod = "PATCH";

      if (responseStatus === 404) {
        const createResponse = await fetch(requestUrl, {
          method: "PUT",
          headers: {
            authorization: access.authorization_header,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            ticket_id: ticketId,
            title: restored.title,
            body: restored.body,
          }),
        });
        const createResponseText = await createResponse.text();

        if (!createResponse.ok) {
          throw new AgentGitError("Owned ticket compensation request failed.", "UPSTREAM_FAILURE", {
            integration: "tickets",
            operation: "restore_ticket",
            status_code: createResponse.status,
            request_url: requestUrl,
            broker_handle_id: access.handle.handle_id,
            broker_profile_id: access.handle.profile_id,
            response_preview: responsePreview(createResponse.status, createResponseText),
          });
        }

        const restoreResponse = await fetch(requestUrl, {
          method: "PATCH",
          headers: {
            authorization: access.authorization_header,
            "content-type": "application/json",
          },
          body: JSON.stringify(patchPayload),
        });
        responseStatus = restoreResponse.status;
        responseText = await restoreResponse.text();
        artifactMethod = "PUT";

        if (responseStatus === 404) {
          throw new NotFoundError("Owned ticket could not be found upstream for restore.", {
            integration: "tickets",
            operation: "restore_ticket",
            ticket_id: ticketId,
            request_url: requestUrl,
          });
        }
      }

      if (responseStatus === 404) {
        throw new NotFoundError("Owned ticket could not be found upstream for restore.", {
          integration: "tickets",
          operation: "restore_ticket",
          ticket_id: ticketId,
          request_url: requestUrl,
        });
      }

      if (responseStatus < 200 || responseStatus >= 300) {
        throw new AgentGitError("Owned ticket compensation request failed.", "UPSTREAM_FAILURE", {
          integration: "tickets",
          operation: "restore_ticket",
          status_code: responseStatus,
          request_url: requestUrl,
          broker_handle_id: access.handle.handle_id,
          broker_profile_id: access.handle.profile_id,
          response_preview: responsePreview(responseStatus, responseText),
        });
      }
    }

    const record = await this.store.restoreTicketFromSnapshot(ticketId, restored);
    return {
      record,
      artifactPreview: `${artifactMethod} ${requestUrl}\n${responsePreview(responseStatus, responseText)}`,
      brokerHandleId: access.handle.handle_id,
      brokerProfileId: access.handle.profile_id,
      responseStatus,
      requestUrl,
    };
  }

  async reopenTicket(ticketId: string): Promise<{
    record: TicketRecord;
    artifactPreview: string;
    brokerHandleId: string;
    brokerProfileId: string;
    responseStatus: number;
    requestUrl: string;
  }> {
    const access = this.broker.resolveBearerAccess({
      integration: "tickets",
      required_scope: "tickets:write",
    });
    const existing = await this.store.getTicket(ticketId);
    if (!existing) {
      throw new NotFoundError("Owned ticket could not be found for reopen.", {
        ticket_id: ticketId,
      });
    }
    if (existing.status === "deleted") {
      throw new AgentGitError("Deleted tickets cannot be reopened.", "CONFLICT", {
        ticket_id: ticketId,
        existing_status: existing.status,
      });
    }

    const requestUrl = resolveTicketUrl(access.base_url, ticketId);
    const response = await fetch(requestUrl, {
      method: "PATCH",
      headers: {
        authorization: access.authorization_header,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ticket_id: ticketId,
        status: "active",
      }),
    });
    const responseText = await response.text();

    if (response.status === 404) {
      throw new NotFoundError("Owned ticket could not be found upstream for reopen.", {
        integration: "tickets",
        operation: "reopen_ticket",
        ticket_id: ticketId,
        request_url: requestUrl,
      });
    }

    if (!response.ok) {
      throw new AgentGitError("Owned ticket compensation request failed.", "UPSTREAM_FAILURE", {
        integration: "tickets",
        operation: "reopen_ticket",
        status_code: response.status,
        request_url: requestUrl,
        broker_handle_id: access.handle.handle_id,
        broker_profile_id: access.handle.profile_id,
        response_preview: responsePreview(response.status, responseText),
      });
    }

    const record = await this.store.reopenTicket(ticketId);
    if (!record) {
      throw new NotFoundError("Owned ticket could not be found for reopen.", {
        ticket_id: ticketId,
      });
    }

    return {
      record,
      artifactPreview: `PATCH ${requestUrl}\n${responsePreview(response.status, responseText)}`,
      brokerHandleId: access.handle.handle_id,
      brokerProfileId: access.handle.profile_id,
      responseStatus: response.status,
      requestUrl,
    };
  }

  async removeLabel(
    ticketId: string,
    label: string,
  ): Promise<{
    record: TicketRecord | null;
    artifactPreview: string;
    brokerHandleId: string;
    brokerProfileId: string;
    responseStatus: number;
    requestUrl: string;
  }> {
    const access = this.broker.resolveBearerAccess({
      integration: "tickets",
      required_scope: "tickets:write",
    });
    const requestUrl = resolveTicketUrl(access.base_url, ticketId);
    const response = await fetch(requestUrl, {
      method: "PATCH",
      headers: {
        authorization: access.authorization_header,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ticket_id: ticketId,
        label,
        label_operation: "remove",
      }),
    });
    const responseText = await response.text();

    if (response.status !== 404 && !response.ok) {
      throw new AgentGitError("Owned ticket compensation request failed.", "UPSTREAM_FAILURE", {
        integration: "tickets",
        operation: "remove_label",
        status_code: response.status,
        request_url: requestUrl,
        broker_handle_id: access.handle.handle_id,
        broker_profile_id: access.handle.profile_id,
        response_preview: responsePreview(response.status, responseText),
      });
    }

    const record = await this.store.removeLabel(ticketId, label);
    return {
      record,
      artifactPreview: `PATCH ${requestUrl}\n${responsePreview(response.status, responseText)}`,
      brokerHandleId: access.handle.handle_id,
      brokerProfileId: access.handle.profile_id,
      responseStatus: response.status,
      requestUrl,
    };
  }

  async unassignUser(
    ticketId: string,
    userId: string,
  ): Promise<{
    record: TicketRecord | null;
    artifactPreview: string;
    brokerHandleId: string;
    brokerProfileId: string;
    responseStatus: number;
    requestUrl: string;
  }> {
    const access = this.broker.resolveBearerAccess({
      integration: "tickets",
      required_scope: "tickets:write",
    });
    const requestUrl = resolveTicketUrl(access.base_url, ticketId);
    const response = await fetch(requestUrl, {
      method: "PATCH",
      headers: {
        authorization: access.authorization_header,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ticket_id: ticketId,
        user_id: userId,
        assignment_operation: "remove",
      }),
    });
    const responseText = await response.text();

    if (response.status !== 404 && !response.ok) {
      throw new AgentGitError("Owned ticket compensation request failed.", "UPSTREAM_FAILURE", {
        integration: "tickets",
        operation: "unassign_user",
        status_code: response.status,
        request_url: requestUrl,
        broker_handle_id: access.handle.handle_id,
        broker_profile_id: access.handle.profile_id,
        response_preview: responsePreview(response.status, responseText),
      });
    }

    const record = await this.store.unassignUser(ticketId, userId);
    return {
      record,
      artifactPreview: `PATCH ${requestUrl}\n${responsePreview(response.status, responseText)}`,
      brokerHandleId: access.handle.handle_id,
      brokerProfileId: access.handle.profile_id,
      responseStatus: response.status,
      requestUrl,
    };
  }
}

export class FilesystemExecutionAdapter implements ExecutionAdapter {
  readonly supported_domains = ["filesystem"];

  canHandle(action: ActionRecord): boolean {
    return action.operation.domain === "filesystem";
  }

  async verifyPreconditions(context: ExecutionContext): Promise<void> {
    if (!(await isPathInsideRoot(context.action.target.primary.locator, context.workspace_root))) {
      throw new PreconditionError("Filesystem action target is outside the governed workspace root.", {
        target: context.action.target.primary.locator,
        workspace_root: context.workspace_root,
      });
    }

    if (context.policy_outcome.preconditions.snapshot_required && !context.snapshot_record) {
      throw new PreconditionError("Snapshot-required action is missing a snapshot boundary.", {
        action_id: context.action.action_id,
      });
    }
  }

  async execute(context: ExecutionContext): Promise<ExecutionResult> {
    const startedAt = new Date().toISOString();
    const targetPath = await resolvePathInsideRoot(context.action.target.primary.locator, context.workspace_root);
    const filesystemFacet = context.action.facets.filesystem as FilesystemFacet | undefined;
    const operation = filesystemFacet?.operation ?? context.action.operation.kind;
    const rawInput = context.action.input.raw as FilesystemRawInput;

    if (operation === "write" || operation === "overwrite") {
      const executionId = `exec_fs_${Date.now()}`;
      const content = typeof rawInput.content === "string" ? rawInput.content : "";
      const previousContent = await readExistingText(targetPath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, content, "utf8");

      const completedAt = new Date().toISOString();
      const diffPreview = buildDiffPreview(previousContent, content);
      const artifacts: ExecutionArtifact[] = [fileContentArtifact(targetPath, Buffer.byteLength(content, "utf8"))];
      if (previousContent !== content) {
        artifacts.push(inlineArtifact("diff", executionId, Buffer.byteLength(diffPreview, "utf8")));
      }

      return {
        execution_id: executionId,
        action_id: context.action.action_id,
        mode: "executed",
        success: true,
        output: {
          executed: true,
          domain: "filesystem",
          operation,
          target: targetPath,
          bytes_written: Buffer.byteLength(content, "utf8"),
          before_preview: previousContent === null ? null : textPreview(previousContent),
          after_preview: textPreview(content),
          diff_preview: diffPreview,
        },
        artifacts,
        started_at: startedAt,
        completed_at: completedAt,
      };
    }

    if (operation === "delete") {
      const executionId = `exec_fs_${Date.now()}`;
      const previousContent = await readExistingText(targetPath);
      await fs.rm(targetPath, { recursive: true, force: true });

      const completedAt = new Date().toISOString();
      const diffPreview = previousContent !== null ? `- ${textPreview(previousContent)}` : `Removed ${targetPath}.`;
      const artifacts: ExecutionArtifact[] = [];
      if (previousContent !== null) {
        artifacts.push(inlineArtifact("diff", executionId, Buffer.byteLength(diffPreview, "utf8")));
      }
      return {
        execution_id: executionId,
        action_id: context.action.action_id,
        mode: "executed",
        success: true,
        output: {
          executed: true,
          domain: "filesystem",
          operation,
          target: targetPath,
          deleted: true,
          expected_bytes: filesystemFacet?.byte_length ?? 0,
          before_preview: previousContent === null ? null : textPreview(previousContent),
          diff_preview: diffPreview,
        },
        artifacts,
        started_at: startedAt,
        completed_at: completedAt,
      };
    }

    throw new AgentGitError("Filesystem adapter does not support this operation yet.", "CAPABILITY_UNAVAILABLE", {
      action_id: context.action.action_id,
      operation,
    });
  }
}

const DEFAULT_SHELL_TIMEOUT_MS = 30_000;
const MAX_CAPTURE_BYTES = 64 * 1024;
const SHELL_PROTECTED_SECRET_PATH_PATTERNS = [
  /(^|\/)\.env(\.[^/]+)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)\.aws(\/|$)/i,
  /(^|\/)\.gnupg(\/|$)/i,
  /\.(pem|key)$/i,
];
const SHELL_CONTROL_SURFACE_PATH_PATTERNS = [
  /(^|\/)\.claude(\/|$)/i,
  /(^|\/)\.codex(\/|$)/i,
  /(^|\/)\.agentgit(\/|$)/i,
  /(^|\/)\.mcp\.json$/i,
];

function shellOperandLooksLikePath(value: string): boolean {
  if (value.length === 0 || value.startsWith("-")) {
    return false;
  }

  if (path.isAbsolute(value) || value === "." || value === ".." || value.startsWith("./") || value.startsWith("../")) {
    return true;
  }

  if (value.startsWith("~") || value.startsWith(".")) {
    return true;
  }

  return value.includes(path.sep) || /[./\\]/.test(value);
}

function isProtectedShellPath(targetPath: string): boolean {
  return SHELL_PROTECTED_SECRET_PATH_PATTERNS.some((pattern) => pattern.test(targetPath));
}

function isControlSurfaceShellPath(targetPath: string): boolean {
  return SHELL_CONTROL_SURFACE_PATH_PATTERNS.some((pattern) => pattern.test(targetPath));
}

function extractShellTargetPaths(shellFacet: ShellFacet | undefined, action: ActionRecord): string[] {
  const explicitPaths = Array.isArray(shellFacet?.target_paths)
    ? shellFacet.target_paths.filter((value) => typeof value === "string" && value.trim().length > 0)
    : [];

  if (explicitPaths.length > 0) {
    return [...new Set(explicitPaths.map((entry) => path.resolve(entry)))];
  }

  if (action.target.primary.type === "path" && action.target.primary.locator.length > 0) {
    return [path.resolve(action.target.primary.locator)];
  }

  const cwd = shellFacet?.cwd ?? action.target.primary.locator;
  const argv = Array.isArray(shellFacet?.argv) ? shellFacet.argv.filter((value) => typeof value === "string") : [];
  return [
    ...new Set(
      argv
        .slice(1)
        .filter((entry) => shellOperandLooksLikePath(entry))
        .map((entry) => path.resolve(cwd, entry)),
    ),
  ];
}

async function verifyShellTargetPaths(
  shellFacet: ShellFacet | undefined,
  action: ActionRecord,
  workspaceRoot: string,
): Promise<void> {
  const targetPaths = extractShellTargetPaths(shellFacet, action);

  for (const targetPath of targetPaths) {
    if (!(await isPathInsideRoot(targetPath, workspaceRoot))) {
      throw new PreconditionError("Shell action target path is outside the governed workspace root.", {
        action_id: action.action_id,
        target: targetPath,
        workspace_root: workspaceRoot,
      });
    }

    const resolvedTargetPath = await resolvePathInsideRoot(targetPath, workspaceRoot);
    if (isProtectedShellPath(resolvedTargetPath)) {
      throw new PreconditionError("Shell action target path is a protected secret path.", {
        action_id: action.action_id,
        target: resolvedTargetPath,
      });
    }

    if (isControlSurfaceShellPath(resolvedTargetPath)) {
      throw new PreconditionError("Shell action target path is a protected control surface.", {
        action_id: action.action_id,
        target: resolvedTargetPath,
      });
    }
  }
}

export class ShellExecutionAdapter implements ExecutionAdapter {
  readonly supported_domains = ["shell"];

  canHandle(action: ActionRecord): boolean {
    return action.operation.domain === "shell";
  }

  async verifyPreconditions(context: ExecutionContext): Promise<void> {
    const shellFacet = context.action.facets.shell as ShellFacet | undefined;
    const argv = Array.isArray(shellFacet?.argv) ? shellFacet.argv.filter((value) => typeof value === "string") : [];
    const cwd = shellFacet?.cwd ?? context.action.target.primary.locator;

    if (argv.length === 0 || argv[0] === undefined || argv[0].trim().length === 0) {
      throw new PreconditionError("Shell action is missing an executable argv[0].", {
        action_id: context.action.action_id,
      });
    }

    if (!(await isPathInsideRoot(cwd, context.workspace_root))) {
      throw new PreconditionError("Shell action cwd is outside the governed workspace root.", {
        action_id: context.action.action_id,
        cwd,
        workspace_root: context.workspace_root,
      });
    }

    await verifyShellTargetPaths(shellFacet, context.action, context.workspace_root);

    if (context.policy_outcome.preconditions.snapshot_required && !context.snapshot_record) {
      throw new PreconditionError("Snapshot-required action is missing a snapshot boundary.", {
        action_id: context.action.action_id,
      });
    }
  }

  async execute(context: ExecutionContext): Promise<ExecutionResult> {
    const shellFacet = context.action.facets.shell as ShellFacet | undefined;
    const argv = Array.isArray(shellFacet?.argv) ? shellFacet.argv.filter((value) => typeof value === "string") : [];
    const cwd = await resolvePathInsideRoot(
      shellFacet?.cwd ?? context.action.target.primary.locator,
      context.workspace_root,
    );
    await verifyShellTargetPaths(shellFacet, context.action, context.workspace_root);
    const executionId = `exec_sh_${Date.now()}`;
    const startedAt = new Date().toISOString();

    return new Promise<ExecutionResult>((resolve, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const settle = (callback: () => void) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        callback();
      };

      const timeout = setTimeout(() => {
        settle(() => {
          child.kill("SIGTERM");
          reject(
            new AgentGitError("Shell command timed out during execution.", "PRECONDITION_FAILED", {
              action_id: context.action.action_id,
              timeout_ms: DEFAULT_SHELL_TIMEOUT_MS,
              argv,
            }),
          );
        });
      }, DEFAULT_SHELL_TIMEOUT_MS);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      child.stdout.on("data", (chunk: string) => {
        stdout = `${stdout}${chunk}`.slice(0, MAX_CAPTURE_BYTES);
      });

      child.stderr.on("data", (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(0, MAX_CAPTURE_BYTES);
      });

      child.once("error", (error) => {
        settle(() => {
          reject(
            new AgentGitError("Shell command failed to start.", "CAPABILITY_UNAVAILABLE", {
              action_id: context.action.action_id,
              argv,
              cause: error.message,
            }),
          );
        });
      });

      child.once("close", (code, signal) => {
        settle(() => {
          const completedAt = new Date().toISOString();

          if (code !== 0) {
            reject(
              new AgentGitError("Shell command exited with a non-zero status.", "PRECONDITION_FAILED", {
                action_id: context.action.action_id,
                argv,
                exit_code: code,
                signal,
                stdout,
                stderr,
              }),
            );
            return;
          }

          const artifacts: ExecutionArtifact[] = [];
          if (stdout.length > 0) {
            artifacts.push(inlineArtifact("stdout", executionId, Buffer.byteLength(stdout, "utf8")));
          }
          if (stderr.length > 0) {
            artifacts.push(inlineArtifact("stderr", executionId, Buffer.byteLength(stderr, "utf8")));
          }

          resolve({
            execution_id: executionId,
            action_id: context.action.action_id,
            mode: "executed",
            success: true,
            output: {
              executed: true,
              domain: "shell",
              cwd,
              argv,
              exit_code: 0,
              stdout,
              stderr,
            },
            artifacts,
            started_at: startedAt,
            completed_at: completedAt,
          });
        });
      });
    });
  }
}

export class FunctionExecutionAdapter implements ExecutionAdapter {
  readonly supported_domains = ["function"];

  constructor(
    private readonly draftStore: OwnedDraftStore,
    private readonly noteStore?: OwnedNoteStore,
    private readonly ticketIntegration?: OwnedTicketIntegration,
  ) {}

  canHandle(action: ActionRecord): boolean {
    return action.operation.domain === "function";
  }

  async verifyPreconditions(context: ExecutionContext): Promise<void> {
    const functionFacet = context.action.facets.function as FunctionFacet | undefined;
    const integration = functionFacet?.integration ?? "";
    const operation = functionFacet?.operation ?? "";

    const draftsSupported =
      integration === "drafts" &&
      (operation === "create_draft" ||
        operation === "archive_draft" ||
        operation === "delete_draft" ||
        operation === "unarchive_draft" ||
        operation === "update_draft" ||
        operation === "restore_draft" ||
        operation === "add_label" ||
        operation === "remove_label");
    const notesSupported =
      integration === "notes" &&
      (operation === "create_note" ||
        operation === "archive_note" ||
        operation === "unarchive_note" ||
        operation === "update_note" ||
        operation === "restore_note" ||
        operation === "delete_note");
    const ticketsSupported =
      integration === "tickets" &&
      (operation === "create_ticket" ||
        operation === "update_ticket" ||
        operation === "delete_ticket" ||
        operation === "restore_ticket" ||
        operation === "close_ticket" ||
        operation === "reopen_ticket" ||
        operation === "add_label" ||
        operation === "remove_label" ||
        operation === "assign_user" ||
        operation === "unassign_user") &&
      Boolean(this.ticketIntegration);

    if (!draftsSupported && !notesSupported && !ticketsSupported) {
      throw new PreconditionError("Function action is not backed by a trusted owned integration.", {
        action_id: context.action.action_id,
        integration,
        operation,
      });
    }

    if (context.policy_outcome.preconditions.snapshot_required && !context.snapshot_record) {
      throw new PreconditionError("Snapshot-required function action is missing a snapshot boundary.", {
        action_id: context.action.action_id,
      });
    }
  }

  async execute(context: ExecutionContext): Promise<ExecutionResult> {
    const functionFacet = context.action.facets.function as FunctionFacet | undefined;
    const rawInput = context.action.input.raw as FunctionRawInput;
    const integration = functionFacet?.integration ?? "";
    const operation = functionFacet?.operation ?? "";
    const locator = functionFacet?.object_locator ?? context.action.target.primary.locator;
    const draftId = parseDraftLocator(locator);
    const noteId = parseNoteLocator(locator);
    const ticketId = parseTicketLocator(locator);
    const ticketLabelTarget = parseTicketLabelLocator(locator);
    const ticketAssigneeTarget = parseTicketAssigneeLocator(locator);

    if (
      !(
        (integration === "drafts" &&
          (operation === "create_draft" ||
            operation === "archive_draft" ||
            operation === "delete_draft" ||
            operation === "unarchive_draft" ||
            operation === "update_draft" ||
            operation === "restore_draft" ||
            operation === "add_label" ||
            operation === "remove_label") &&
          draftId) ||
        (integration === "notes" &&
          (operation === "create_note" ||
            operation === "archive_note" ||
            operation === "unarchive_note" ||
            operation === "update_note" ||
            operation === "restore_note" ||
            operation === "delete_note") &&
          noteId &&
          this.noteStore) ||
        (integration === "tickets" &&
          (operation === "create_ticket" ||
            operation === "update_ticket" ||
            operation === "delete_ticket" ||
            operation === "restore_ticket" ||
            operation === "close_ticket" ||
            operation === "reopen_ticket") &&
          ticketId &&
          this.ticketIntegration) ||
        (integration === "tickets" && operation === "add_label" && ticketLabelTarget && this.ticketIntegration) ||
        (integration === "tickets" && operation === "remove_label" && ticketLabelTarget && this.ticketIntegration) ||
        (integration === "tickets" && operation === "assign_user" && ticketAssigneeTarget && this.ticketIntegration) ||
        (integration === "tickets" && operation === "unassign_user" && ticketAssigneeTarget && this.ticketIntegration)
      )
    ) {
      throw new AgentGitError("Function adapter does not support this action.", "CAPABILITY_UNAVAILABLE", {
        action_id: context.action.action_id,
        integration,
        operation,
      });
    }

    const executionId = "exec_fn_" + Date.now();
    const startedAt = new Date().toISOString();
    let objectId: string;
    let objectStatus: string;
    let subject: string;
    let labels: string[] | undefined;
    let assignedUsers: string[] | undefined;
    let preview: string;
    let requestUrl: string | undefined;
    let responseStatus: number | undefined;
    let brokerHandleId: string | undefined;
    let brokerProfileId: string | undefined;

    if (integration === "drafts" && operation === "create_draft") {
      const rawSubject = typeof rawInput.subject === "string" ? rawInput.subject : "";
      const body = typeof rawInput.body === "string" ? rawInput.body : "";
      const record = await this.draftStore.createDraft({
        draftId: draftId!,
        subject: rawSubject,
        body,
        actionId: context.action.action_id,
      });
      objectId = record.draft_id;
      objectStatus = record.status;
      subject = record.subject;
      labels = record.labels;
      preview = 'Created draft "' + textPreview(record.subject) + '" (' + record.draft_id + ").";
    } else if (integration === "drafts" && operation === "archive_draft") {
      const archived = await this.draftStore.archiveDraft(draftId!);
      if (archived === null) {
        throw new NotFoundError("Owned draft could not be found for archive.", {
          action_id: context.action.action_id,
          draft_id: draftId!,
        });
      }
      objectId = archived.draft_id;
      objectStatus = archived.status;
      subject = archived.subject;
      labels = archived.labels;
      preview = 'Archived draft "' + textPreview(archived.subject) + '" (' + archived.draft_id + ").";
    } else if (integration === "drafts" && operation === "delete_draft") {
      const deleted = await this.draftStore.deleteDraft(draftId!);
      if (deleted === null) {
        throw new NotFoundError("Owned draft could not be found for delete.", {
          action_id: context.action.action_id,
          draft_id: draftId!,
        });
      }
      objectId = deleted.draft_id;
      objectStatus = deleted.status;
      subject = deleted.subject;
      labels = deleted.labels;
      preview = 'Deleted draft "' + textPreview(deleted.subject) + '" (' + deleted.draft_id + ").";
    } else if (integration === "drafts" && operation === "unarchive_draft") {
      const unarchived = await this.draftStore.unarchiveDraft(draftId!);
      if (unarchived === null) {
        throw new NotFoundError("Owned draft could not be found for unarchive.", {
          action_id: context.action.action_id,
          draft_id: draftId!,
        });
      }
      objectId = unarchived.draft_id;
      objectStatus = unarchived.status;
      subject = unarchived.subject;
      labels = unarchived.labels;
      preview = 'Unarchived draft "' + textPreview(unarchived.subject) + '" (' + unarchived.draft_id + ").";
    } else if (integration === "drafts" && operation === "update_draft") {
      const updates: { subject?: string; body?: string } = {};
      if (typeof rawInput.subject === "string") {
        updates.subject = rawInput.subject;
      }
      if (typeof rawInput.body === "string") {
        updates.body = rawInput.body;
      }

      const updated = await this.draftStore.updateDraft(draftId!, updates);
      if (updated === null) {
        throw new NotFoundError("Owned draft could not be found for update.", {
          action_id: context.action.action_id,
          draft_id: draftId!,
        });
      }
      objectId = updated.draft_id;
      objectStatus = updated.status;
      subject = updated.subject;
      labels = updated.labels;
      preview = 'Updated draft "' + textPreview(updated.subject) + '" (' + updated.draft_id + ").";
    } else if (integration === "drafts" && operation === "restore_draft") {
      const restoredSubject = typeof rawInput.subject === "string" ? rawInput.subject.trim() : "";
      const restoredBody = typeof rawInput.body === "string" ? rawInput.body : "";
      const restoredStatus = rawInput.status;
      const existing = await this.draftStore.getDraft(draftId!);
      if (existing === null) {
        throw new NotFoundError("Owned draft could not be found for restore.", {
          action_id: context.action.action_id,
          draft_id: draftId!,
        });
      }
      if (restoredSubject.length === 0) {
        throw new PreconditionError("Owned draft restore requires a non-empty subject.", {
          action_id: context.action.action_id,
          draft_id: draftId!,
        });
      }
      if (restoredStatus !== "active" && restoredStatus !== "archived" && restoredStatus !== "deleted") {
        throw new PreconditionError("Owned draft restore requires an active, archived, or deleted status.", {
          action_id: context.action.action_id,
          draft_id: draftId!,
          status: restoredStatus,
        });
      }
      if (!Array.isArray(rawInput.labels) || rawInput.labels.some((entry) => typeof entry !== "string")) {
        throw new PreconditionError("Owned draft restore requires a labels array.", {
          action_id: context.action.action_id,
          draft_id: draftId!,
        });
      }

      const normalizedLabels = [...new Set(rawInput.labels.map((entry) => entry.trim()))];
      if (normalizedLabels.some((entry) => entry.length === 0)) {
        throw new PreconditionError("Owned draft restore labels must be non-empty strings.", {
          action_id: context.action.action_id,
          draft_id: draftId!,
        });
      }

      const restored = await this.draftStore.restoreDraftFromSnapshot(draftId!, {
        draft_id: draftId!,
        subject: restoredSubject,
        body: restoredBody,
        labels: normalizedLabels,
        status: restoredStatus,
        action_id: existing.action_id,
        created_at: existing.created_at,
        archived_at: restoredStatus === "archived" ? (existing.archived_at ?? new Date().toISOString()) : null,
        deleted_at: restoredStatus === "deleted" ? (existing.deleted_at ?? new Date().toISOString()) : null,
      });
      objectId = restored.draft_id;
      objectStatus = restored.status;
      subject = restored.subject;
      labels = restored.labels;
      preview = 'Restored draft "' + textPreview(restored.subject) + '" (' + restored.draft_id + ").";
    } else if (integration === "drafts" && operation === "add_label") {
      const label = typeof rawInput.label === "string" ? rawInput.label.trim() : "";
      if (label.length === 0) {
        throw new PreconditionError("Owned draft labeling requires a non-empty label.", {
          action_id: context.action.action_id,
          draft_id: draftId!,
        });
      }
      const labeled = await this.draftStore.addLabel(draftId!, label);
      if (labeled === null) {
        throw new NotFoundError("Owned draft could not be found for labeling.", {
          action_id: context.action.action_id,
          draft_id: draftId!,
          label,
        });
      }
      objectId = labeled.draft_id;
      objectStatus = labeled.status;
      subject = labeled.subject;
      labels = labeled.labels;
      preview =
        'Added label "' +
        textPreview(label) +
        '" to draft "' +
        textPreview(labeled.subject) +
        '" (' +
        labeled.draft_id +
        ").";
    } else if (integration === "drafts" && operation === "remove_label") {
      const label = typeof rawInput.label === "string" ? rawInput.label.trim() : "";
      if (label.length === 0) {
        throw new PreconditionError("Owned draft label removal requires a non-empty label.", {
          action_id: context.action.action_id,
          draft_id: draftId!,
        });
      }
      const unlabeled = await this.draftStore.removeLabel(draftId!, label);
      if (unlabeled === null) {
        throw new NotFoundError("Owned draft could not be found for label removal.", {
          action_id: context.action.action_id,
          draft_id: draftId!,
          label,
        });
      }
      objectId = unlabeled.draft_id;
      objectStatus = unlabeled.status;
      subject = unlabeled.subject;
      labels = unlabeled.labels;
      preview =
        'Removed label "' +
        textPreview(label) +
        '" from draft "' +
        textPreview(unlabeled.subject) +
        '" (' +
        unlabeled.draft_id +
        ").";
    } else if (integration === "notes" && operation === "create_note") {
      const title = typeof rawInput.title === "string" ? rawInput.title : "";
      const body = typeof rawInput.body === "string" ? rawInput.body : "";
      const record = await this.noteStore!.createNote({
        noteId: noteId!,
        title,
        body,
        actionId: context.action.action_id,
      });
      objectId = record.note_id;
      objectStatus = record.status;
      subject = record.title;
      preview = 'Created note "' + textPreview(record.title) + '" (' + record.note_id + ").";
    } else if (integration === "notes" && operation === "archive_note") {
      const archived = await this.noteStore!.archiveNote(noteId!);
      if (archived === null) {
        throw new NotFoundError("Owned note could not be found for archive.", {
          action_id: context.action.action_id,
          note_id: noteId!,
        });
      }
      objectId = archived.note_id;
      objectStatus = archived.status;
      subject = archived.title;
      preview = 'Archived note "' + textPreview(archived.title) + '" (' + archived.note_id + ").";
    } else if (integration === "notes" && operation === "delete_note") {
      const deleted = await this.noteStore!.deleteNote(noteId!);
      if (deleted === null) {
        throw new NotFoundError("Owned note could not be found for delete.", {
          action_id: context.action.action_id,
          note_id: noteId!,
        });
      }
      objectId = deleted.note_id;
      objectStatus = deleted.status;
      subject = deleted.title;
      preview = 'Deleted note "' + textPreview(deleted.title) + '" (' + deleted.note_id + ").";
    } else if (integration === "notes" && operation === "update_note") {
      const updates: { title?: string; body?: string } = {};
      if (typeof rawInput.title === "string") {
        updates.title = rawInput.title;
      }
      if (typeof rawInput.body === "string") {
        updates.body = rawInput.body;
      }

      const updated = await this.noteStore!.updateNote(noteId!, updates);
      if (updated === null) {
        throw new NotFoundError("Owned note could not be found for update.", {
          action_id: context.action.action_id,
          note_id: noteId!,
        });
      }
      objectId = updated.note_id;
      objectStatus = updated.status;
      subject = updated.title;
      preview = 'Updated note "' + textPreview(updated.title) + '" (' + updated.note_id + ").";
    } else if (integration === "notes" && operation === "restore_note") {
      const restoredTitle = typeof rawInput.title === "string" ? rawInput.title.trim() : "";
      const restoredBody = typeof rawInput.body === "string" ? rawInput.body : "";
      const restoredStatus = rawInput.status;
      const existing = await this.noteStore!.getNote(noteId!);
      if (existing === null) {
        throw new NotFoundError("Owned note could not be found for restore.", {
          action_id: context.action.action_id,
          note_id: noteId!,
        });
      }
      if (restoredTitle.length === 0) {
        throw new PreconditionError("Owned note restore requires a non-empty title.", {
          action_id: context.action.action_id,
          note_id: noteId!,
        });
      }
      if (restoredStatus !== "active" && restoredStatus !== "archived" && restoredStatus !== "deleted") {
        throw new PreconditionError("Owned note restore requires an active, archived, or deleted status.", {
          action_id: context.action.action_id,
          note_id: noteId!,
          status: restoredStatus,
        });
      }

      const restored = await this.noteStore!.restoreNoteFromSnapshot(noteId!, {
        note_id: noteId!,
        title: restoredTitle,
        body: restoredBody,
        status: restoredStatus,
        action_id: existing.action_id,
        created_at: existing.created_at,
        archived_at:
          restoredStatus === "archived"
            ? (existing.archived_at ?? new Date().toISOString())
            : restoredStatus === "deleted"
              ? existing.archived_at
              : null,
        deleted_at: restoredStatus === "deleted" ? (existing.deleted_at ?? new Date().toISOString()) : null,
      });
      objectId = restored.note_id;
      objectStatus = restored.status;
      subject = restored.title;
      preview = 'Restored note "' + textPreview(restored.title) + '" (' + restored.note_id + ").";
    } else if (integration === "notes" && operation === "unarchive_note") {
      const unarchived = await this.noteStore!.unarchiveNote(noteId!);
      if (unarchived === null) {
        throw new NotFoundError("Owned note could not be found for unarchive.", {
          action_id: context.action.action_id,
          note_id: noteId!,
        });
      }
      objectId = unarchived.note_id;
      objectStatus = unarchived.status;
      subject = unarchived.title;
      preview = 'Unarchived note "' + textPreview(unarchived.title) + '" (' + unarchived.note_id + ").";
    } else if (integration === "tickets" && operation === "create_ticket") {
      const title = typeof rawInput.title === "string" ? rawInput.title : "";
      const body = typeof rawInput.body === "string" ? rawInput.body : "";
      const created = await this.ticketIntegration!.createTicket({
        ticketId: ticketId!,
        title,
        body,
        actionId: context.action.action_id,
      });
      objectId = created.record.ticket_id;
      objectStatus = created.record.status;
      subject = created.record.title;
      labels = created.record.labels;
      assignedUsers = created.record.assigned_users;
      preview = 'Created ticket "' + textPreview(created.record.title) + '" (' + created.record.ticket_id + ").";
      requestUrl = created.requestUrl;
      responseStatus = created.responseStatus;
      brokerHandleId = created.brokerHandleId;
      brokerProfileId = created.brokerProfileId;
    } else if (integration === "tickets" && operation === "update_ticket") {
      const updates: { title?: string; body?: string } = {};
      if (typeof rawInput.title === "string") {
        updates.title = rawInput.title;
      }
      if (typeof rawInput.body === "string") {
        updates.body = rawInput.body;
      }
      const updated = await this.ticketIntegration!.updateTicket({
        ticketId: ticketId!,
        ...updates,
      });
      objectId = updated.record.ticket_id;
      objectStatus = updated.record.status;
      subject = updated.record.title;
      labels = updated.record.labels;
      assignedUsers = updated.record.assigned_users;
      preview = 'Updated ticket "' + textPreview(updated.record.title) + '" (' + updated.record.ticket_id + ").";
      requestUrl = updated.requestUrl;
      responseStatus = updated.responseStatus;
      brokerHandleId = updated.brokerHandleId;
      brokerProfileId = updated.brokerProfileId;
    } else if (integration === "tickets" && operation === "delete_ticket") {
      const existing = await this.ticketIntegration!.getTicket(ticketId!);
      if (!existing) {
        throw new NotFoundError("Owned ticket could not be found for delete.", {
          action_id: context.action.action_id,
          ticket_id: ticketId!,
        });
      }
      const deleted = await this.ticketIntegration!.deleteTicket(ticketId!);
      if (!deleted.record) {
        throw new NotFoundError("Owned ticket could not be found for delete.", {
          action_id: context.action.action_id,
          ticket_id: ticketId!,
        });
      }
      objectId = deleted.record.ticket_id;
      objectStatus = deleted.record.status;
      subject = deleted.record.title;
      labels = deleted.record.labels;
      assignedUsers = deleted.record.assigned_users;
      preview = 'Deleted ticket "' + textPreview(deleted.record.title) + '" (' + deleted.record.ticket_id + ").";
      requestUrl = deleted.requestUrl;
      responseStatus = deleted.responseStatus;
      brokerHandleId = deleted.brokerHandleId;
      brokerProfileId = deleted.brokerProfileId;
    } else if (integration === "tickets" && operation === "restore_ticket") {
      const title = typeof rawInput.title === "string" ? rawInput.title.trim() : "";
      const body = typeof rawInput.body === "string" ? rawInput.body : "";
      const status = rawInput.status;
      if (title.length === 0) {
        throw new PreconditionError("Owned ticket restore requires a non-empty title.", {
          action_id: context.action.action_id,
          ticket_id: ticketId!,
        });
      }
      if (status !== "active" && status !== "closed") {
        throw new PreconditionError("Owned ticket restore requires an active or closed status.", {
          action_id: context.action.action_id,
          ticket_id: ticketId!,
          status,
        });
      }
      if (!Array.isArray(rawInput.labels) || rawInput.labels.some((entry) => typeof entry !== "string")) {
        throw new PreconditionError("Owned ticket restore requires a labels array.", {
          action_id: context.action.action_id,
          ticket_id: ticketId!,
        });
      }
      if (
        !Array.isArray(rawInput.assigned_users) ||
        rawInput.assigned_users.some((entry) => typeof entry !== "string")
      ) {
        throw new PreconditionError("Owned ticket restore requires an assigned_users array.", {
          action_id: context.action.action_id,
          ticket_id: ticketId!,
        });
      }

      const normalizedLabels = [...new Set(rawInput.labels.map((entry) => entry.trim()))];
      const normalizedAssignedUsers = [...new Set(rawInput.assigned_users.map((entry) => entry.trim()))];
      if (normalizedLabels.some((entry) => entry.length === 0)) {
        throw new PreconditionError("Owned ticket restore labels must be non-empty strings.", {
          action_id: context.action.action_id,
          ticket_id: ticketId!,
        });
      }
      if (normalizedAssignedUsers.some((entry) => entry.length === 0)) {
        throw new PreconditionError("Owned ticket restore assigned_users must be non-empty strings.", {
          action_id: context.action.action_id,
          ticket_id: ticketId!,
        });
      }

      const restored = await this.ticketIntegration!.restoreTicket({
        ticketId: ticketId!,
        title,
        body,
        status,
        labels: normalizedLabels,
        assigned_users: normalizedAssignedUsers,
      });
      objectId = restored.record.ticket_id;
      objectStatus = restored.record.status;
      subject = restored.record.title;
      labels = restored.record.labels;
      assignedUsers = restored.record.assigned_users;
      preview = 'Restored ticket "' + textPreview(restored.record.title) + '" (' + restored.record.ticket_id + ").";
      requestUrl = restored.requestUrl;
      responseStatus = restored.responseStatus;
      brokerHandleId = restored.brokerHandleId;
      brokerProfileId = restored.brokerProfileId;
    } else if (integration === "tickets" && operation === "close_ticket") {
      const closed = await this.ticketIntegration!.closeTicket(ticketId!);
      objectId = closed.record.ticket_id;
      objectStatus = closed.record.status;
      subject = closed.record.title;
      labels = closed.record.labels;
      assignedUsers = closed.record.assigned_users;
      preview = 'Closed ticket "' + textPreview(closed.record.title) + '" (' + closed.record.ticket_id + ").";
      requestUrl = closed.requestUrl;
      responseStatus = closed.responseStatus;
      brokerHandleId = closed.brokerHandleId;
      brokerProfileId = closed.brokerProfileId;
    } else if (integration === "tickets" && operation === "reopen_ticket") {
      const reopened = await this.ticketIntegration!.reopenTicket(ticketId!);
      objectId = reopened.record.ticket_id;
      objectStatus = reopened.record.status;
      subject = reopened.record.title;
      labels = reopened.record.labels;
      assignedUsers = reopened.record.assigned_users;
      preview = 'Reopened ticket "' + textPreview(reopened.record.title) + '" (' + reopened.record.ticket_id + ").";
      requestUrl = reopened.requestUrl;
      responseStatus = reopened.responseStatus;
      brokerHandleId = reopened.brokerHandleId;
      brokerProfileId = reopened.brokerProfileId;
    } else if (integration === "tickets" && operation === "add_label") {
      const label = typeof rawInput.label === "string" ? rawInput.label.trim() : "";
      if (label.length === 0) {
        throw new PreconditionError("Owned ticket labeling requires a non-empty label.", {
          action_id: context.action.action_id,
          ticket_id: ticketId!,
        });
      }
      const labeled = await this.ticketIntegration!.addLabel(ticketId!, label);
      objectId = labeled.record.ticket_id;
      objectStatus = labeled.record.status;
      subject = labeled.record.title;
      labels = labeled.record.labels;
      assignedUsers = labeled.record.assigned_users;
      preview =
        'Added label "' +
        textPreview(label) +
        '" to ticket "' +
        textPreview(labeled.record.title) +
        '" (' +
        labeled.record.ticket_id +
        ").";
      requestUrl = labeled.requestUrl;
      responseStatus = labeled.responseStatus;
      brokerHandleId = labeled.brokerHandleId;
      brokerProfileId = labeled.brokerProfileId;
    } else if (integration === "tickets" && operation === "remove_label") {
      const labelTicketId = ticketLabelTarget?.ticketId ?? ticketId;
      const label = typeof rawInput.label === "string" ? rawInput.label.trim() : "";
      if (label.length === 0) {
        throw new PreconditionError("Owned ticket label removal requires a non-empty label.", {
          action_id: context.action.action_id,
          ticket_id: labelTicketId!,
        });
      }
      const unlabeled = await this.ticketIntegration!.removeLabel(labelTicketId!, label);
      if (!unlabeled.record) {
        throw new NotFoundError("Owned ticket could not be found for label removal.", {
          action_id: context.action.action_id,
          ticket_id: labelTicketId!,
          label,
        });
      }
      objectId = unlabeled.record.ticket_id;
      objectStatus = unlabeled.record.status;
      subject = unlabeled.record.title;
      labels = unlabeled.record.labels;
      assignedUsers = unlabeled.record.assigned_users;
      preview =
        'Removed label "' +
        textPreview(label) +
        '" from ticket "' +
        textPreview(unlabeled.record.title) +
        '" (' +
        unlabeled.record.ticket_id +
        ").";
      requestUrl = unlabeled.requestUrl;
      responseStatus = unlabeled.responseStatus;
      brokerHandleId = unlabeled.brokerHandleId;
      brokerProfileId = unlabeled.brokerProfileId;
    } else if (integration === "tickets" && operation === "assign_user") {
      const assigneeTicketId = ticketAssigneeTarget?.ticketId ?? ticketId;
      const userId = typeof rawInput.user_id === "string" ? rawInput.user_id.trim() : "";
      if (userId.length === 0) {
        throw new PreconditionError("Owned ticket assignment requires a non-empty user_id.", {
          action_id: context.action.action_id,
          ticket_id: assigneeTicketId!,
        });
      }
      const assigned = await this.ticketIntegration!.assignUser(assigneeTicketId!, userId);
      objectId = assigned.record.ticket_id;
      objectStatus = assigned.record.status;
      subject = assigned.record.title;
      labels = assigned.record.labels;
      assignedUsers = assigned.record.assigned_users;
      preview =
        'Assigned user "' +
        textPreview(userId) +
        '" to ticket "' +
        textPreview(assigned.record.title) +
        '" (' +
        assigned.record.ticket_id +
        ").";
      requestUrl = assigned.requestUrl;
      responseStatus = assigned.responseStatus;
      brokerHandleId = assigned.brokerHandleId;
      brokerProfileId = assigned.brokerProfileId;
    } else if (integration === "tickets" && operation === "unassign_user") {
      const assigneeTicketId = ticketAssigneeTarget?.ticketId ?? ticketId;
      const userId = typeof rawInput.user_id === "string" ? rawInput.user_id.trim() : "";
      if (userId.length === 0) {
        throw new PreconditionError("Owned ticket unassignment requires a non-empty user_id.", {
          action_id: context.action.action_id,
          ticket_id: assigneeTicketId!,
        });
      }
      const unassigned = await this.ticketIntegration!.unassignUser(assigneeTicketId!, userId);
      if (!unassigned.record) {
        throw new NotFoundError("Owned ticket could not be found for unassignment.", {
          action_id: context.action.action_id,
          ticket_id: assigneeTicketId!,
          user_id: userId,
        });
      }
      objectId = unassigned.record.ticket_id;
      objectStatus = unassigned.record.status;
      subject = unassigned.record.title;
      labels = unassigned.record.labels;
      assignedUsers = unassigned.record.assigned_users;
      preview =
        'Unassigned user "' +
        textPreview(userId) +
        '" from ticket "' +
        textPreview(unassigned.record.title) +
        '" (' +
        unassigned.record.ticket_id +
        ").";
      requestUrl = unassigned.requestUrl;
      responseStatus = unassigned.responseStatus;
      brokerHandleId = unassigned.brokerHandleId;
      brokerProfileId = unassigned.brokerProfileId;
    } else {
      throw new AgentGitError("Function adapter does not support this action.", "CAPABILITY_UNAVAILABLE", {
        action_id: context.action.action_id,
        integration,
        operation,
      });
    }

    const completedAt = new Date().toISOString();

    return {
      execution_id: executionId,
      action_id: context.action.action_id,
      mode: "executed",
      success: true,
      output: {
        executed: true,
        domain: "function",
        integration,
        operation,
        target: locator,
        external_object_id: objectId,
        external_object_status: objectStatus,
        subject,
        ...(requestUrl ? { request_url: requestUrl } : {}),
        ...(typeof responseStatus === "number" ? { response_status: responseStatus } : {}),
        ...(brokerHandleId ? { broker_handle_id: brokerHandleId } : {}),
        ...(brokerProfileId ? { broker_profile_id: brokerProfileId } : {}),
        ...(labels ? { labels } : {}),
        ...(assignedUsers ? { assigned_users: assignedUsers } : {}),
        preview,
      },
      artifacts: [inlineArtifact("request_response", executionId, Buffer.byteLength(preview, "utf8"))],
      started_at: startedAt,
      completed_at: completedAt,
    };
  }
}
