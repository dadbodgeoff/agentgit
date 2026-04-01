import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SessionCredentialBroker } from "@agentgit/credential-broker";
import { IntegrationState } from "@agentgit/integration-state";
import {
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
const MAX_MCP_STDERR_BYTES = 16 * 1024;
type McpClientTransport = StdioClientTransport | StreamableHTTPClientTransport;

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
    const token = envVar.length > 0 ? process.env[envVar]?.trim() ?? "" : "";
    if (token.length === 0) {
      throw new PreconditionError("Governed streamable_http MCP execution requires an operator-configured bearer token env var.", {
        server_id: server.server_id,
        transport: server.transport,
        bearer_env_var: envVar || null,
      });
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

function createMcpTransport(
  server: McpServerDefinition,
  workspaceRoot: string,
  broker: SessionCredentialBroker | null,
): {
  transport: McpClientTransport;
  readStderr: () => string;
} {
  if (server.transport === "stdio") {
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      cwd: server.cwd ?? workspaceRoot,
      env: {
        ...getDefaultEnvironment(),
        ...server.env,
      },
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
    requestInit: {
      headers: resolveStreamableHttpHeaders(server, broker),
    },
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

  constructor(
    servers: McpServerDefinition[] | McpServerRegistry,
    options: {
      credentialBroker?: SessionCredentialBroker | null;
      publicHostPolicyRegistry?: McpPublicHostPolicyRegistry | null;
    } = {},
  ) {
    this.broker = options.credentialBroker ?? null;
    this.publicHostPolicyRegistry = options.publicHostPolicyRegistry ?? null;
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

  private acquireStreamableHttpExecutionSlot(server: McpServerDefinition): () => void {
    if (server.transport !== "streamable_http") {
      return () => undefined;
    }

    const maxConcurrentCalls = server.max_concurrent_calls ?? 1;
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
    const releaseExecutionSlot = this.acquireStreamableHttpExecutionSlot(server);
    if (server.transport === "streamable_http") {
      assertStreamableHttpPublicEgressAllowed(server, this.publicHostPolicyRegistry);
    }
    const { transport, readStderr } = createMcpTransport(server, context.workspace_root, this.broker);
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
          auth_type: server.transport === "streamable_http" ? server.auth?.type ?? "none" : "none",
          network_scope: server.transport === "streamable_http" ? server.network_scope ?? "loopback" : null,
          max_concurrent_calls: server.transport === "streamable_http" ? server.max_concurrent_calls ?? 1 : null,
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
        network_scope: server.transport === "streamable_http" ? server.network_scope ?? "loopback" : null,
        cause: error instanceof Error ? error.message : String(error),
      });
    } finally {
      releaseExecutionSlot();
      await transport.close().catch(() => undefined);
    }
  }
}

function isPathInsideRoot(targetPath: string, rootPath: string): boolean {
  const normalizedRoot = path.resolve(rootPath);
  const normalizedTarget = path.resolve(targetPath);

  return (
    normalizedTarget === normalizedRoot ||
    normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)
  );
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
        ? existing.closed_at ?? transitionAt
        : restoredState.status === "deleted"
          ? existing.closed_at
          : null,
    deleted_at: restoredState.status === "deleted" ? existing.deleted_at ?? transitionAt : null,
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

  async createNote(params: {
    noteId: string;
    title: string;
    body: string;
    actionId: string;
  }): Promise<NoteRecord> {
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

  async createTicket(params: {
    ticketId: string;
    title: string;
    body: string;
    actionId: string;
  }): Promise<{
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

  async updateTicket(params: {
    ticketId: string;
    title?: string;
    body?: string;
  }): Promise<{
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

  async addLabel(ticketId: string, label: string): Promise<{
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

  async assignUser(ticketId: string, userId: string): Promise<{
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

  async restoreTicketFromSnapshot(ticketId: string, snapshotValue: unknown): Promise<{
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

  async removeLabel(ticketId: string, label: string): Promise<{
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

  async unassignUser(ticketId: string, userId: string): Promise<{
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
    if (!isPathInsideRoot(context.action.target.primary.locator, context.workspace_root)) {
      throw new PreconditionError("Filesystem action target is outside the governed workspace root.", {
        target: context.action.target.primary.locator,
        workspace_root: context.workspace_root,
      });
    }

    if (
      context.policy_outcome.preconditions.snapshot_required &&
      !context.snapshot_record
    ) {
      throw new PreconditionError("Snapshot-required action is missing a snapshot boundary.", {
        action_id: context.action.action_id,
      });
    }
  }

  async execute(context: ExecutionContext): Promise<ExecutionResult> {
    const startedAt = new Date().toISOString();
    const targetPath = context.action.target.primary.locator;
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
      const artifacts: ExecutionArtifact[] = [
        fileContentArtifact(targetPath, Buffer.byteLength(content, "utf8")),
      ];
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
      const diffPreview =
        previousContent !== null ? `- ${textPreview(previousContent)}` : `Removed ${targetPath}.`;
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

    if (!isPathInsideRoot(cwd, context.workspace_root)) {
      throw new PreconditionError("Shell action cwd is outside the governed workspace root.", {
        action_id: context.action.action_id,
        cwd,
        workspace_root: context.workspace_root,
      });
    }

    if (
      context.policy_outcome.preconditions.snapshot_required &&
      !context.snapshot_record
    ) {
      throw new PreconditionError("Snapshot-required action is missing a snapshot boundary.", {
        action_id: context.action.action_id,
      });
    }
  }

  async execute(context: ExecutionContext): Promise<ExecutionResult> {
    const shellFacet = context.action.facets.shell as ShellFacet | undefined;
    const argv = Array.isArray(shellFacet?.argv) ? shellFacet.argv.filter((value) => typeof value === "string") : [];
    const cwd = shellFacet?.cwd ?? context.action.target.primary.locator;
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
        (integration === "tickets" &&
          operation === "add_label" &&
          ticketLabelTarget &&
          this.ticketIntegration) ||
        (integration === "tickets" &&
          operation === "remove_label" &&
          ticketLabelTarget &&
          this.ticketIntegration) ||
        (integration === "tickets" &&
          operation === "assign_user" &&
          ticketAssigneeTarget &&
          this.ticketIntegration) ||
        (integration === "tickets" &&
          operation === "unassign_user" &&
          ticketAssigneeTarget &&
          this.ticketIntegration)
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
      preview = 'Created draft "' + textPreview(record.subject) + '" (' + record.draft_id + ').';
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
      preview = 'Archived draft "' + textPreview(archived.subject) + '" (' + archived.draft_id + ').';
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
      preview = 'Deleted draft "' + textPreview(deleted.subject) + '" (' + deleted.draft_id + ').';
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
      preview = 'Unarchived draft "' + textPreview(unarchived.subject) + '" (' + unarchived.draft_id + ').';
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
      preview = 'Updated draft "' + textPreview(updated.subject) + '" (' + updated.draft_id + ').';
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
        archived_at: restoredStatus === "archived" ? existing.archived_at ?? new Date().toISOString() : null,
        deleted_at: restoredStatus === "deleted" ? existing.deleted_at ?? new Date().toISOString() : null,
      });
      objectId = restored.draft_id;
      objectStatus = restored.status;
      subject = restored.subject;
      labels = restored.labels;
      preview = 'Restored draft "' + textPreview(restored.subject) + '" (' + restored.draft_id + ').';
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
      preview = 'Added label "' + textPreview(label) + '" to draft "' + textPreview(labeled.subject) + '" (' + labeled.draft_id + ').';
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
        'Removed label "' + textPreview(label) + '" from draft "' + textPreview(unlabeled.subject) + '" (' + unlabeled.draft_id + ').';
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
      preview = 'Created note "' + textPreview(record.title) + '" (' + record.note_id + ').';
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
      preview = 'Archived note "' + textPreview(archived.title) + '" (' + archived.note_id + ').';
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
      preview = 'Deleted note "' + textPreview(deleted.title) + '" (' + deleted.note_id + ').';
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
      preview = 'Updated note "' + textPreview(updated.title) + '" (' + updated.note_id + ').';
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
            ? existing.archived_at ?? new Date().toISOString()
            : restoredStatus === "deleted"
              ? existing.archived_at
              : null,
        deleted_at: restoredStatus === "deleted" ? existing.deleted_at ?? new Date().toISOString() : null,
      });
      objectId = restored.note_id;
      objectStatus = restored.status;
      subject = restored.title;
      preview = 'Restored note "' + textPreview(restored.title) + '" (' + restored.note_id + ').';
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
      preview = 'Unarchived note "' + textPreview(unarchived.title) + '" (' + unarchived.note_id + ').';
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
      preview = 'Created ticket "' + textPreview(created.record.title) + '" (' + created.record.ticket_id + ').';
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
      preview = 'Updated ticket "' + textPreview(updated.record.title) + '" (' + updated.record.ticket_id + ').';
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
      preview = 'Deleted ticket "' + textPreview(deleted.record.title) + '" (' + deleted.record.ticket_id + ').';
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
      preview = 'Restored ticket "' + textPreview(restored.record.title) + '" (' + restored.record.ticket_id + ').';
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
      preview = 'Closed ticket "' + textPreview(closed.record.title) + '" (' + closed.record.ticket_id + ').';
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
      preview = 'Reopened ticket "' + textPreview(reopened.record.title) + '" (' + reopened.record.ticket_id + ').';
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
      preview = 'Added label "' + textPreview(label) + '" to ticket "' + textPreview(labeled.record.title) + '" (' + labeled.record.ticket_id + ').';
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
      preview = 'Removed label "' + textPreview(label) + '" from ticket "' + textPreview(unlabeled.record.title) + '" (' + unlabeled.record.ticket_id + ').';
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
        ').';
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
        ').';
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
      artifacts: [
        inlineArtifact("request_response", executionId, Buffer.byteLength(preview, "utf8")),
      ],
      started_at: startedAt,
      completed_at: completedAt,
    };
  }
}
