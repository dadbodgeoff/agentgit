import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  AgentGitError,
  type ExecutionArtifact,
  type ExecutionResult,
  HostedMcpWorkerCancelRequestPayloadSchema,
  type HostedMcpWorkerExecuteRequestPayload,
  HostedMcpWorkerCancelResponsePayloadSchema,
  HostedMcpWorkerExecuteRequestPayloadSchema,
  HostedMcpWorkerHelloRequestPayloadSchema,
  type HostedMcpWorkerMethod,
  HostedMcpWorkerRequestEnvelopeSchema,
  type HostedMcpWorkerResponseEnvelope,
  InternalError,
  type McpNetworkScope,
  PreconditionError,
  validate,
} from "@agentgit/schemas";

export interface HostedMcpWorkerServerOptions {
  endpoint: string;
  attestationKeyPath: string;
  controlToken?: string | null;
  workerImageDigest?: string;
}

interface HostedMcpWorkerIdentityMaterial {
  private_key_pem: string;
  public_key_pem: string;
  worker_runtime_id: string;
  worker_image_digest: string;
}

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJsonStringify(entryValue)}`).join(",")}}`;
  }

  return JSON.stringify(value);
}

function createInlineArtifact(
  type: ExecutionArtifact["type"],
  executionId: string,
  byteSize: number,
): ExecutionArtifact {
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

function summarizeMcpContent(result: unknown): string {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const parts: string[] = [];

  if (Array.isArray(record.content)) {
    for (const entry of record.content) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const contentEntry = entry as Record<string, unknown>;
      if (contentEntry.type === "text" && typeof contentEntry.text === "string") {
        parts.push(contentEntry.text);
        continue;
      }

      if (
        contentEntry.type === "resource" &&
        contentEntry.resource &&
        typeof contentEntry.resource === "object" &&
        typeof (contentEntry.resource as Record<string, unknown>).text === "string"
      ) {
        parts.push((contentEntry.resource as Record<string, string>).text);
      }
    }
  }

  if (parts.length > 0) {
    return textPreview(parts.join("\n"));
  }

  if (record.structuredContent && typeof record.structuredContent === "object") {
    return textPreview(JSON.stringify(record.structuredContent));
  }

  return record.isError === true
    ? "MCP tool returned an error result without textual content."
    : "MCP tool returned structured content.";
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new AgentGitError("Hosted MCP worker execution was canceled.", "CONFLICT"),
      );
      return;
    }
    const timer = setTimeout(() => {
      reject(onTimeout());
    }, timeoutMs);
    timer.unref?.();
    const abortListener = () => {
      clearTimeout(timer);
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new AgentGitError("Hosted MCP worker execution was canceled.", "CONFLICT"),
      );
    };
    if (signal) {
      signal.addEventListener("abort", abortListener, { once: true });
    }

    promise.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abortListener);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abortListener);
        reject(error);
      },
    );
  });
}

function shouldFollowRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function classifyIpv4Host(hostname: string): "loopback" | "private" | "public" | "unknown" {
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

function classifyIpv6Host(hostname: string): "loopback" | "private" | "public" | "unknown" {
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

function classifyHostname(hostname: string): "loopback" | "private" | "public" | "unknown" {
  const normalized = hostname.trim().toLowerCase();
  if (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized === "::ffff:127.0.0.1" ||
    normalized.endsWith(".localhost")
  ) {
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
  scope: McpNetworkScope,
  reachability: "loopback" | "private" | "public" | "unknown",
): boolean {
  if (scope === "loopback") {
    return reachability === "loopback";
  }

  if (scope === "private") {
    return reachability === "loopback" || reachability === "private";
  }

  return reachability === "public";
}

async function assertTargetAllowed(url: URL, networkScope: McpNetworkScope, allowedHosts: string[]): Promise<void> {
  if (!allowedHosts.includes(url.hostname)) {
    throw new PreconditionError("Hosted MCP worker target host is outside the lease allowlist.", {
      hostname: url.hostname,
      allowed_hosts: allowedHosts,
      url: url.toString(),
    });
  }

  if (networkScope === "public_https" && url.protocol !== "https:") {
    throw new PreconditionError("Hosted MCP worker public endpoints must use HTTPS.", {
      url: url.toString(),
      network_scope: networkScope,
    });
  }

  if (networkScope !== "public_https" && url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PreconditionError("Hosted MCP worker target protocol is unsupported.", {
      url: url.toString(),
      protocol: url.protocol,
      network_scope: networkScope,
    });
  }

  const literalReachability = classifyHostname(url.hostname);
  if (net.isIP(url.hostname) !== 0) {
    if (!isReachabilityAllowedForScope(networkScope, literalReachability)) {
      throw new PreconditionError("Hosted MCP worker target IP literal violates the requested network scope.", {
        url: url.toString(),
        hostname: url.hostname,
        network_scope: networkScope,
        reachability: literalReachability,
      });
    }
    return;
  }

  const resolvedAddresses = await dnsLookup(url.hostname, { all: true });
  if (resolvedAddresses.length === 0) {
    throw new PreconditionError("Hosted MCP worker target hostname did not resolve to any IP addresses.", {
      url: url.toString(),
      hostname: url.hostname,
    });
  }

  const mismatches = resolvedAddresses
    .map((entry) => ({
      address: entry.address,
      family: entry.family,
      reachability: classifyHostname(entry.address),
    }))
    .filter((entry) => !isReachabilityAllowedForScope(networkScope, entry.reachability));

  if (mismatches.length > 0) {
    throw new PreconditionError("Hosted MCP worker target resolved outside the allowed network scope.", {
      url: url.toString(),
      hostname: url.hostname,
      network_scope: networkScope,
      resolved_addresses: mismatches,
    });
  }
}

function createHostedFetch(params: {
  canonicalEndpoint: string;
  networkScope: McpNetworkScope;
  allowedHosts: string[];
  authorizationHeader: string | null;
}): typeof fetch {
  const baseHeaders = new Headers();
  if (params.authorizationHeader) {
    baseHeaders.set("authorization", params.authorizationHeader);
  }

  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    let url = new URL(request.url);
    let method = (init?.method ?? request.method ?? "GET").toUpperCase();
    let body = init?.body;
    const signal = init?.signal ?? request.signal;
    const headers = new Headers(request.headers);
    for (const [key, value] of baseHeaders.entries()) {
      headers.set(key, value);
    }
    for (const [key, value] of new Headers(init?.headers).entries()) {
      headers.set(key, value);
    }

    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      await assertTargetAllowed(url, params.networkScope, params.allowedHosts);
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

      if (redirectCount === 5) {
        if (response.body) {
          await response.body.cancel().catch(() => undefined);
        }
        throw new PreconditionError("Hosted MCP worker redirect chain exceeded the maximum supported length.", {
          url: url.toString(),
          redirect_count: redirectCount,
        });
      }

      const location = response.headers.get("location");
      if (!location) {
        return response;
      }

      const nextUrl = new URL(location, url);
      if (response.body) {
        await response.body.cancel().catch(() => undefined);
      }
      await assertTargetAllowed(nextUrl, params.networkScope, params.allowedHosts);

      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
      url = nextUrl;
    }

    throw new InternalError("Hosted MCP worker redirect handling failed unexpectedly.", {});
  };
}

class HostedMcpWorkerAttestor {
  private readonly privateKeyPem: string;
  readonly publicKeyPem: string;
  readonly workerRuntimeId: string;
  readonly workerImageDigest: string;

  constructor(keyPath: string, workerImageDigest?: string) {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    if (fs.existsSync(keyPath)) {
      const stored = JSON.parse(fs.readFileSync(keyPath, "utf8")) as Partial<HostedMcpWorkerIdentityMaterial>;
      if (
        typeof stored.private_key_pem !== "string" ||
        typeof stored.public_key_pem !== "string" ||
        typeof stored.worker_runtime_id !== "string" ||
        typeof stored.worker_image_digest !== "string"
      ) {
        throw new InternalError("Hosted MCP worker attestation key material is malformed.", {
          key_path: keyPath,
        });
      }
      this.privateKeyPem = stored.private_key_pem;
      this.publicKeyPem = stored.public_key_pem;
      this.workerRuntimeId = stored.worker_runtime_id;
      this.workerImageDigest = stored.worker_image_digest;
      return;
    }

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    this.privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    this.publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
    this.workerRuntimeId = createHash("sha256").update(this.publicKeyPem, "utf8").digest("hex").slice(0, 16);
    this.workerImageDigest =
      workerImageDigest ??
      `sha256:${createHash("sha256").update("agentgit-hosted-mcp-worker-v2", "utf8").digest("hex")}`;
    fs.writeFileSync(
      keyPath,
      JSON.stringify(
        {
          private_key_pem: this.privateKeyPem,
          public_key_pem: this.publicKeyPem,
          worker_runtime_id: this.workerRuntimeId,
          worker_image_digest: this.workerImageDigest,
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  signBundle(value: unknown): string {
    return sign(null, Buffer.from(stableJsonStringify(value), "utf8"), this.privateKeyPem).toString("base64");
  }

  static verifyBundle(publicKeyPem: string, value: unknown, signatureB64: string): boolean {
    return verify(
      null,
      Buffer.from(stableJsonStringify(value), "utf8"),
      createPublicKey(publicKeyPem),
      Buffer.from(signatureB64, "base64"),
    );
  }
}

function resolveHostedActionHash(value: unknown): string {
  return createHash("sha256").update(stableJsonStringify(value), "utf8").digest("hex");
}

function parseEndpoint(
  endpoint: string,
): { kind: "unix"; socketPath: string } | { kind: "tcp"; host: string; port: number } {
  const normalized = endpoint.trim();
  if (normalized.startsWith("unix:")) {
    const socketPath = normalized.slice("unix:".length).trim();
    if (socketPath.length === 0) {
      throw new Error("Hosted MCP worker unix endpoint must include a socket path.");
    }
    return { kind: "unix", socketPath };
  }

  if (normalized.startsWith("tcp://")) {
    const url = new URL(normalized);
    const port = Number.parseInt(url.port, 10);
    if (!url.hostname || !Number.isInteger(port) || port <= 0) {
      throw new Error("Hosted MCP worker tcp endpoint must include a hostname and port.");
    }
    return { kind: "tcp", host: url.hostname, port };
  }

  throw new Error("Hosted MCP worker endpoint must use unix:<path> or tcp://host:port syntax.");
}

async function executeHostedMcp(
  payload: HostedMcpWorkerExecuteRequestPayload,
  attestor: HostedMcpWorkerAttestor,
  cancelSignal?: AbortSignal,
): Promise<
  ExecutionResult & {
    attestation: {
      payload: {
        lease_id: string;
        worker_runtime_id: string;
        worker_image_digest: string;
        result_hash: string;
        artifact_manifest_hash: string;
      };
      signature: string;
      started_at: string;
      completed_at: string;
    };
  }
> {
  const endpoint = new URL(payload.canonical_endpoint);
  const nowMs = Date.now();
  if (Date.parse(payload.lease.expires_at) <= nowMs) {
    throw new PreconditionError("Hosted MCP worker rejected an expired execution lease.", {
      lease_id: payload.lease.lease_id,
      expires_at: payload.lease.expires_at,
    });
  }

  await assertTargetAllowed(endpoint, payload.network_scope, payload.lease.allowed_hosts);
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: createHostedFetch({
      canonicalEndpoint: payload.canonical_endpoint,
      networkScope: payload.network_scope,
      allowedHosts: payload.lease.allowed_hosts,
      authorizationHeader: payload.auth.type === "delegated_bearer" ? payload.auth.authorization_header : null,
    }),
  });
  const client = new Client({
    name: "agentgit-hosted-mcp-worker",
    version: "0.1.0",
  });

  const timeoutMs = 30_000;
  const startedAt = new Date().toISOString();
  const executionId = `exec_mcp_${Date.now()}`;
  const cancelTransport = () => {
    void transport.close().catch(() => undefined);
  };
  cancelSignal?.addEventListener("abort", cancelTransport, { once: true });
  try {
    await withTimeout(
      client.connect(transport),
      timeoutMs,
      () =>
        new AgentGitError("Timed out while connecting to the hosted MCP server.", "PRECONDITION_FAILED", {
          action_id: payload.action_id,
          server_id: payload.server_id,
          tool_name: payload.tool_name,
          timeout_ms: timeoutMs,
        }),
      cancelSignal,
    );

    const listedTools: Array<{ name: string; annotations?: Record<string, unknown> }> = [];
    let cursor: string | undefined;
    do {
      const listed = await withTimeout(
        client.listTools(cursor ? { cursor } : undefined),
        timeoutMs,
        () =>
          new AgentGitError("Timed out while listing tools from the hosted MCP server.", "PRECONDITION_FAILED", {
            action_id: payload.action_id,
            server_id: payload.server_id,
            timeout_ms: timeoutMs,
          }),
        cancelSignal,
      );
      listedTools.push(...listed.tools);
      cursor = typeof listed.nextCursor === "string" && listed.nextCursor.length > 0 ? listed.nextCursor : undefined;
    } while (cursor);

    const upstreamTool = listedTools.find((tool) => tool.name === payload.tool_name);
    if (!upstreamTool) {
      throw new AgentGitError("Hosted MCP server did not advertise the requested tool.", "CAPABILITY_UNAVAILABLE", {
        action_id: payload.action_id,
        server_id: payload.server_id,
        tool_name: payload.tool_name,
      });
    }

    const result = await withTimeout(
      client.callTool({
        name: payload.tool_name,
        arguments: payload.arguments,
      }),
      timeoutMs,
      () =>
        new AgentGitError("Timed out while waiting for the hosted MCP tool response.", "PRECONDITION_FAILED", {
          action_id: payload.action_id,
          server_id: payload.server_id,
          tool_name: payload.tool_name,
          timeout_ms: timeoutMs,
        }),
      cancelSignal,
    );
    const preview = JSON.stringify(
      {
        request: {
          server_id: payload.server_id,
          tool_name: payload.tool_name,
          arguments: payload.arguments,
          transport: "streamable_http",
          transport_target: payload.canonical_endpoint,
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
      createInlineArtifact("request_response", executionId, Buffer.byteLength(preview, "utf8")),
    ];

    const totalArtifactBytes = artifacts.reduce((total, artifact) => total + artifact.byte_size, 0);
    if (
      artifacts.length > payload.lease.artifact_budget.max_artifacts ||
      totalArtifactBytes > payload.lease.artifact_budget.max_total_bytes
    ) {
      throw new PreconditionError("Hosted MCP worker artifact budget exceeded the lease allowance.", {
        lease_id: payload.lease.lease_id,
        artifact_count: artifacts.length,
        total_artifact_bytes: totalArtifactBytes,
        artifact_budget: payload.lease.artifact_budget,
      });
    }

    const executionResult: ExecutionResult = {
      execution_id: executionId,
      action_id: payload.action_id,
      mode: "executed",
      success: !(result.isError ?? false),
      output: {
        executed: true,
        domain: "mcp",
        server_id: payload.server_id,
        tool_name: payload.tool_name,
        transport: "streamable_http",
        transport_target: payload.canonical_endpoint,
        auth_type: payload.auth.type,
        network_scope: payload.network_scope,
        max_concurrent_calls: payload.max_concurrent_calls,
        tool_display_name: payload.server_display_name,
        listed_tool_count: listedTools.length,
        upstream_annotations: upstreamTool.annotations ?? null,
        is_error: result.isError ?? false,
        content: result.content ?? [],
        structured_content: result.structuredContent ?? null,
        summary: summarizeMcpContent(result),
        preview,
        stderr: "",
      },
      artifacts,
      error:
        result.isError === true
          ? {
              code: "MCP_TOOL_ERROR",
              message: `MCP tool ${payload.server_id}/${payload.tool_name} returned an error result.`,
              partial_effects: false,
            }
          : undefined,
      started_at: startedAt,
      completed_at: completedAt,
    };
    const artifactManifest = executionResult.artifacts.map((artifact) => ({
      artifact_id: artifact.artifact_id,
      type: artifact.type,
      content_ref: artifact.content_ref,
      byte_size: artifact.byte_size,
      visibility: artifact.visibility,
    }));
    const attestationPayload = {
      lease_id: payload.lease.lease_id,
      worker_runtime_id: attestor.workerRuntimeId,
      worker_image_digest: attestor.workerImageDigest,
      result_hash: resolveHostedActionHash(executionResult.output),
      artifact_manifest_hash: resolveHostedActionHash(artifactManifest),
    };
    const signature = attestor.signBundle(attestationPayload);
    if (!HostedMcpWorkerAttestor.verifyBundle(attestor.publicKeyPem, attestationPayload, signature)) {
      throw new InternalError("Hosted MCP worker self-verification failed.", {
        lease_id: payload.lease.lease_id,
      });
    }

    return {
      ...executionResult,
      attestation: {
        payload: attestationPayload,
        signature,
        started_at: startedAt,
        completed_at: completedAt,
      },
    };
  } finally {
    cancelSignal?.removeEventListener("abort", cancelTransport);
    await transport.close().catch(() => undefined);
  }
}

function makeSuccessResponse(requestId: string, result: unknown): HostedMcpWorkerResponseEnvelope {
  return {
    request_id: requestId,
    ok: true,
    result,
  };
}

function makeErrorResponse(requestId: string, error: unknown): HostedMcpWorkerResponseEnvelope {
  if (error instanceof AgentGitError) {
    return {
      request_id: requestId,
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: error.details,
      },
    };
  }

  return {
    request_id: requestId,
    ok: false,
    error: {
      code: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    },
  };
}

export function startHostedMcpWorkerServer(options: HostedMcpWorkerServerOptions): Promise<net.Server> {
  const attestor = new HostedMcpWorkerAttestor(options.attestationKeyPath, options.workerImageDigest);
  const endpoint = parseEndpoint(options.endpoint);
  const controlToken = options.controlToken?.trim() || null;
  const activeExecutions = new Map<string, AbortController>();

  if (endpoint.kind === "unix") {
    fs.mkdirSync(path.dirname(endpoint.socketPath), { recursive: true });
    if (fs.existsSync(endpoint.socketPath)) {
      fs.rmSync(endpoint.socketPath, { force: true });
    }
  }

  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", async (chunk) => {
      buffer += chunk;

      while (buffer.includes("\n")) {
        const newlineIndex = buffer.indexOf("\n");
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (!line) {
          continue;
        }

        let requestId = "unknown";
        try {
          const envelope = validate(HostedMcpWorkerRequestEnvelopeSchema, JSON.parse(line));
          requestId = envelope.request_id;
          if (controlToken && envelope.auth_token !== controlToken) {
            throw new PreconditionError("Hosted MCP worker control-plane authentication failed.", {
              request_id: envelope.request_id,
            });
          }

          let response: HostedMcpWorkerResponseEnvelope;
          switch (envelope.method as HostedMcpWorkerMethod) {
            case "hello": {
              validate(HostedMcpWorkerHelloRequestPayloadSchema, envelope.payload);
              response = makeSuccessResponse(envelope.request_id, {
                worker_runtime_id: attestor.workerRuntimeId,
                worker_image_digest: attestor.workerImageDigest,
                public_key_pem: attestor.publicKeyPem,
                endpoint_kind: endpoint.kind,
                control_plane_auth_required: controlToken !== null,
              });
              break;
            }
            case "execute_hosted_mcp": {
              const payload = validate(HostedMcpWorkerExecuteRequestPayloadSchema, envelope.payload);
              const cancelController = new AbortController();
              activeExecutions.set(payload.job_id, cancelController);
              try {
                const execution = await executeHostedMcp(payload, attestor, cancelController.signal);
                response = makeSuccessResponse(envelope.request_id, {
                  execution_result: {
                    execution_id: execution.execution_id,
                    action_id: execution.action_id,
                    mode: execution.mode,
                    success: execution.success,
                    output: execution.output,
                    artifacts: execution.artifacts,
                    ...(execution.error ? { error: execution.error } : {}),
                    started_at: execution.started_at,
                    completed_at: execution.completed_at,
                  },
                  attestation: execution.attestation,
                });
              } finally {
                activeExecutions.delete(payload.job_id);
              }
              break;
            }
            case "cancel_execution": {
              const payload = validate(HostedMcpWorkerCancelRequestPayloadSchema, envelope.payload);
              const activeExecution = activeExecutions.get(payload.job_id);
              if (activeExecution) {
                activeExecution.abort(
                  new AgentGitError("Hosted MCP worker execution was canceled by the control plane.", "CONFLICT", {
                    job_id: payload.job_id,
                  }),
                );
              }
              response = makeSuccessResponse(
                envelope.request_id,
                validate(HostedMcpWorkerCancelResponsePayloadSchema, {
                  job_id: payload.job_id,
                  cancellation_requested: true,
                  active: activeExecution !== undefined,
                }),
              );
              break;
            }
            default:
              throw new PreconditionError("Hosted MCP worker method is unsupported.", {
                method: envelope.method,
              });
          }

          socket.write(`${JSON.stringify(response)}\n`);
        } catch (error) {
          socket.write(`${JSON.stringify(makeErrorResponse(requestId, error))}\n`);
        }
      }
    });
  });

  server.on("close", () => {
    if (endpoint.kind === "unix" && fs.existsSync(endpoint.socketPath)) {
      fs.rmSync(endpoint.socketPath, { force: true });
    }
  });

  return new Promise<net.Server>((resolve, reject) => {
    server.on("error", reject);
    if (endpoint.kind === "unix") {
      server.listen(endpoint.socketPath, () => {
        server.off("error", reject);
        resolve(server);
      });
      return;
    }

    server.listen(endpoint.port, endpoint.host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
