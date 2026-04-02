import { spawn, type ChildProcess } from "node:child_process";
import { createPublicKey, verify } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AgentGitError,
  HostedMcpWorkerCancelResponsePayloadSchema,
  HostedMcpWorkerExecuteResponsePayloadSchema,
  HostedMcpWorkerHelloResponsePayloadSchema,
  HostedMcpWorkerResponseEnvelopeSchema,
  type HostedMcpWorkerCancelResponsePayload,
  type HostedMcpWorkerExecuteRequestPayload,
  type HostedMcpWorkerExecuteResponsePayload,
  type HostedMcpWorkerHelloResponsePayload,
  validate,
} from "@agentgit/schemas";

interface ParsedHostedWorkerEndpointUnix {
  kind: "unix";
  socketPath: string;
}

interface ParsedHostedWorkerEndpointTcp {
  kind: "tcp";
  host: string;
  port: number;
}

type ParsedHostedWorkerEndpoint = ParsedHostedWorkerEndpointUnix | ParsedHostedWorkerEndpointTcp;

interface HostedMcpWorkerLaunchSpec {
  command: string;
  args: string[];
  cwd: string;
}

type AgentGitErrorCode = ConstructorParameters<typeof AgentGitError>[1];

export interface HostedMcpWorkerClientOptions {
  endpoint: string;
  autostart: boolean;
  attestationKeyPath: string;
  controlToken?: string | null;
  command?: string;
  args?: string[];
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

function parseEndpoint(endpoint: string): ParsedHostedWorkerEndpoint {
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

function resolveManagedLaunchSpec(options: HostedMcpWorkerClientOptions): HostedMcpWorkerLaunchSpec {
  if (options.command) {
    return {
      command: options.command,
      args: options.args ?? [],
      cwd: process.cwd(),
    };
  }

  const currentFilePath = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFilePath);
  const repoRoot = path.resolve(currentDir, "../../..");
  const distEntry = path.resolve(currentDir, "../../hosted-mcp-worker/dist/main.js");
  const sourceEntry = path.resolve(currentDir, "../../hosted-mcp-worker/src/main.ts");

  if (fs.existsSync(distEntry)) {
    return {
      command: process.execPath,
      args: [distEntry],
      cwd: repoRoot,
    };
  }

  if (fs.existsSync(sourceEntry)) {
    return {
      command: process.execPath,
      args: ["--import", "tsx", sourceEntry],
      cwd: repoRoot,
    };
  }

  throw new Error("Unable to resolve a hosted MCP worker entrypoint.");
}

async function connectAndExchange(
  endpoint: ParsedHostedWorkerEndpoint,
  request: Record<string, unknown>,
  timeoutMs = 3_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket =
      endpoint.kind === "unix"
        ? net.createConnection(endpoint.socketPath)
        : net.createConnection({
            host: endpoint.host,
            port: endpoint.port,
          });
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => {
      socket.destroy();
      if (!settled) {
        settled = true;
        reject(
          new AgentGitError("Timed out while waiting for the hosted MCP worker.", "CAPABILITY_UNAVAILABLE", {
            endpoint: endpoint.kind === "unix" ? endpoint.socketPath : `${endpoint.host}:${endpoint.port}`,
          }),
        );
      }
    }, timeoutMs);
    timer.unref?.();

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1 || settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const line = buffer.slice(0, newlineIndex);
      socket.end();
      resolve(JSON.parse(line));
    });
    socket.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    socket.on("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error("Hosted MCP worker connection closed before a response was received."));
      }
    });
  });
}

export class HostedMcpWorkerClient {
  private readonly options: HostedMcpWorkerClientOptions;
  private readonly endpoint: ParsedHostedWorkerEndpoint;
  private readonly controlToken: string | null;
  private child: ChildProcess | null = null;
  private lastErrorMessage: string | null = null;
  private identity: HostedMcpWorkerHelloResponsePayload | null = null;
  private warmupPromise: Promise<void> | null = null;

  constructor(options: HostedMcpWorkerClientOptions) {
    this.options = options;
    this.endpoint = parseEndpoint(options.endpoint);
    this.controlToken = options.controlToken?.trim() || null;
  }

  get available(): boolean {
    return this.identity !== null;
  }

  get workerRuntimeId(): string | null {
    return this.identity?.worker_runtime_id ?? null;
  }

  get workerImageDigest(): string | null {
    return this.identity?.worker_image_digest ?? null;
  }

  get endpointKind(): "unix" | "tcp" {
    return this.endpoint.kind;
  }

  get endpointLabel(): string {
    return this.endpoint.kind === "unix"
      ? `unix:${this.endpoint.socketPath}`
      : `tcp://${this.endpoint.host}:${this.endpoint.port}`;
  }

  get managed(): boolean {
    return this.options.autostart;
  }

  get controlPlaneAuthRequired(): boolean {
    return this.controlToken !== null;
  }

  get lastError(): string | null {
    return this.lastErrorMessage;
  }

  async warmup(): Promise<void> {
    if (!this.warmupPromise) {
      this.warmupPromise = this.ensureReady().catch((error) => {
        this.lastErrorMessage = error instanceof Error ? error.message : String(error);
      });
    }
    await this.warmupPromise;
  }

  async executeHostedMcp(
    payload: HostedMcpWorkerExecuteRequestPayload,
    cancelSignal?: AbortSignal,
  ): Promise<HostedMcpWorkerExecuteResponsePayload> {
    await this.ensureReady();
    let abortListener: (() => void) | null = null;
    if (cancelSignal) {
      abortListener = () => {
        void this.cancelHostedExecution(payload.job_id).catch(() => undefined);
      };
      if (cancelSignal.aborted) {
        abortListener();
      } else {
        cancelSignal.addEventListener("abort", abortListener, { once: true });
      }
    }
    const response = validate(
      HostedMcpWorkerResponseEnvelopeSchema,
      await (async () => {
        try {
          return await connectAndExchange(this.endpoint, {
            request_id: `hosted_worker_exec_${Date.now()}`,
            method: "execute_hosted_mcp",
            auth_token: this.controlToken,
            payload,
          });
        } finally {
          if (cancelSignal && abortListener) {
            cancelSignal.removeEventListener("abort", abortListener);
          }
        }
      })(),
    );
    if (!response.ok) {
      throw new AgentGitError(
        response.error?.message ?? "Hosted MCP worker execution failed.",
        normalizeWorkerErrorCode(response.error?.code),
        response.error?.details,
        response.error?.retryable ?? false,
      );
    }

    const result = validate(HostedMcpWorkerExecuteResponsePayloadSchema, response.result);
    this.lastErrorMessage = null;
    return result;
  }

  async cancelHostedExecution(jobId: string): Promise<HostedMcpWorkerCancelResponsePayload> {
    await this.ensureReady();
    const response = validate(
      HostedMcpWorkerResponseEnvelopeSchema,
      await connectAndExchange(this.endpoint, {
        request_id: `hosted_worker_cancel_${Date.now()}`,
        method: "cancel_execution",
        auth_token: this.controlToken,
        payload: {
          job_id: jobId,
        },
      }),
    );
    if (!response.ok) {
      throw new AgentGitError(
        response.error?.message ?? "Hosted MCP worker cancellation failed.",
        normalizeWorkerErrorCode(response.error?.code),
        response.error?.details,
        response.error?.retryable ?? false,
      );
    }

    return validate(HostedMcpWorkerCancelResponsePayloadSchema, response.result);
  }

  verifyBundle(value: unknown, signatureB64: string): boolean {
    if (!this.identity) {
      throw new AgentGitError(
        "Hosted MCP worker public identity is unavailable for attestation verification.",
        "CAPABILITY_UNAVAILABLE",
      );
    }

    return verify(
      null,
      Buffer.from(stableJsonStringify(value), "utf8"),
      createPublicKey(this.identity.public_key_pem),
      Buffer.from(signatureB64, "base64"),
    );
  }

  async close(): Promise<void> {
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        this.child?.once("exit", () => resolve());
        setTimeout(resolve, 1_000).unref?.();
      });
    }
    this.child = null;
    this.identity = null;
  }

  private async ensureReady(): Promise<void> {
    if (this.identity) {
      return;
    }

    if (this.options.autostart) {
      await this.startManagedWorker();
    }

    const response = validate(
      HostedMcpWorkerResponseEnvelopeSchema,
      await connectAndExchange(this.endpoint, {
        request_id: `hosted_worker_hello_${Date.now()}`,
        method: "hello",
        auth_token: this.controlToken,
        payload: {},
      }),
    );
    if (!response.ok) {
      throw new AgentGitError(
        response.error?.message ?? "Hosted MCP worker hello failed.",
        normalizeWorkerErrorCode(response.error?.code),
        response.error?.details,
        response.error?.retryable ?? false,
      );
    }

    this.identity = validate(HostedMcpWorkerHelloResponsePayloadSchema, response.result);
    this.lastErrorMessage = null;
  }

  private async startManagedWorker(): Promise<void> {
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      return;
    }

    const launchSpec = resolveManagedLaunchSpec(this.options);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AGENTGIT_HOSTED_MCP_WORKER_ENDPOINT: this.options.endpoint,
      AGENTGIT_HOSTED_MCP_WORKER_ATTESTATION_KEY_PATH: this.options.attestationKeyPath,
    };
    if (this.controlToken) {
      env.AGENTGIT_HOSTED_MCP_WORKER_CONTROL_TOKEN = this.controlToken;
    } else {
      delete env.AGENTGIT_HOSTED_MCP_WORKER_CONTROL_TOKEN;
    }

    const child = spawn(launchSpec.command, launchSpec.args, {
      cwd: launchSpec.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    let stderr = "";
    child.stderr?.on("data", (chunk: string | Buffer) => {
      stderr = `${stderr}${typeof chunk === "string" ? chunk : chunk.toString("utf8")}`.slice(-4096);
    });
    child.on("exit", (code, signal) => {
      this.identity = null;
      if (code !== null && code !== 0) {
        this.lastErrorMessage = `Hosted MCP worker exited with code ${code}.${stderr.length > 0 ? ` ${stderr.trim()}` : ""}`;
      } else if (signal) {
        this.lastErrorMessage = `Hosted MCP worker exited due to signal ${signal}.`;
      }
    });

    const deadline = Date.now() + 5_000;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      try {
        await connectAndExchange(
          this.endpoint,
          {
            request_id: `hosted_worker_probe_${Date.now()}`,
            method: "hello",
            auth_token: this.controlToken,
            payload: {},
          },
          500,
        );
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    throw new AgentGitError("Managed hosted MCP worker did not become ready in time.", "CAPABILITY_UNAVAILABLE", {
      endpoint: this.endpointLabel,
      cause: lastError instanceof Error ? lastError.message : String(lastError),
      stderr: stderr.trim() || null,
    });
  }
}

function normalizeWorkerErrorCode(code: string | undefined): AgentGitErrorCode {
  switch (code) {
    case "BAD_REQUEST":
    case "VALIDATION_FAILED":
    case "NOT_FOUND":
    case "CONFLICT":
    case "TIMEOUT":
    case "PRECONDITION_FAILED":
    case "POLICY_BLOCKED":
    case "UPSTREAM_FAILURE":
    case "STORAGE_UNAVAILABLE":
    case "BROKER_UNAVAILABLE":
    case "INTERNAL_ERROR":
    case "CAPABILITY_UNAVAILABLE":
      return code;
    default:
      return "CAPABILITY_UNAVAILABLE";
  }
}
