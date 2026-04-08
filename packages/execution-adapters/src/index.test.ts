import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { LocalEncryptedSecretStore, SessionCredentialBroker } from "@agentgit/credential-broker";
import { IntegrationState } from "@agentgit/integration-state";
import { McpPublicHostPolicyRegistry } from "@agentgit/mcp-registry";
import type { ActionRecord, McpServerDefinition, PolicyOutcomeRecord } from "@agentgit/schemas";
import { createTempDirTracker } from "@agentgit/test-fixtures";

import {
  FilesystemExecutionAdapter,
  FunctionExecutionAdapter,
  McpExecutionAdapter,
  OwnedDraftStore as OwnedDraftStoreBase,
  OwnedNoteStore as OwnedNoteStoreBase,
  OwnedTicketIntegration,
  OwnedTicketStore as OwnedTicketStoreBase,
  ShellExecutionAdapter,
  validateMcpServerDefinitions,
} from "./index.js";

let tempDir: string | null = null;
const tempDirs = createTempDirTracker("agentgit-exec-");
const ticketServers = new Set<http.Server>();
const storeClosers: Array<{ close(): void }> = [];
const mcpTestServerScript = decodeURIComponent(new URL("./mcp-test-server.mjs", import.meta.url).pathname);
const ociTestImageRoot = decodeURIComponent(new URL("./oci-test-image", import.meta.url).pathname);
const TEST_OCI_BUILD_IMAGE = `agentgit/test-stdio:${process.pid}`;

function detectOciSandbox(): { runtime: "docker" | "podman"; image: string } | null {
  for (const runtime of ["docker", "podman"] as const) {
    const result = spawnSync(runtime, ["info"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (result.status === 0 && !result.error) {
      const imageResult = spawnSync(runtime, ["image", "inspect", "node:22-bookworm-slim"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (imageResult.status !== 0 || imageResult.error) {
        continue;
      }

      try {
        const parsed = JSON.parse(imageResult.stdout) as Array<{ RepoDigests?: string[] }>;
        const repoDigest = parsed[0]?.RepoDigests?.find(
          (digest) => typeof digest === "string" && digest.includes("@sha256:"),
        );
        if (repoDigest) {
          return {
            runtime,
            image: repoDigest,
          };
        }
      } catch {
        // Try the next runtime.
      }
    }
  }

  return null;
}

const TEST_OCI_SANDBOX = detectOciSandbox();

function makeConfidenceAssessment(score: number): ActionRecord["confidence_assessment"] {
  return {
    engine_version: "test-confidence/v1",
    score,
    band: score >= 0.85 ? "high" : score >= 0.65 ? "guarded" : "low",
    requires_human_review: score < 0.65,
    factors: [
      {
        factor_id: "test_baseline",
        label: "Test baseline",
        kind: "baseline",
        delta: score,
        rationale: "Test confidence baseline.",
      },
    ],
  };
}

function makeGovernedTestStdioServer(
  scenario: string,
  extraEnv: Record<string, string> = {},
): Extract<McpServerDefinition, { transport: "stdio" }> | null {
  if (!TEST_OCI_SANDBOX) {
    return null;
  }
  return {
    server_id: "notes_server",
    transport: "stdio",
    command: "node",
    args: ["/agentgit-test/mcp-test-server.mjs"],
    env: {
      AGENTGIT_TEST_MCP_SCENARIO: scenario,
      ...extraEnv,
    },
    sandbox: {
      type: "oci_container",
      runtime: TEST_OCI_SANDBOX.runtime,
      image: TEST_OCI_BUILD_IMAGE,
      build: {
        context_path: ociTestImageRoot,
        dockerfile_path: path.join(ociTestImageRoot, "Dockerfile"),
        rebuild_policy: "if_missing",
      },
      workspace_mount_path: "/workspace",
      workdir: "/workspace",
      workspace_access: "read_only",
      additional_mounts: [
        {
          host_path: path.dirname(mcpTestServerScript),
          container_path: "/agentgit-test",
          read_only: true,
        },
      ],
    },
    tools: [
      {
        tool_name: "echo_note",
        side_effect_level: "read_only",
        approval_mode: "allow",
      },
    ],
  };
}

function trackStore<T extends { close(): void }>(store: T): T {
  storeClosers.push(store);
  return store;
}

class OwnedDraftStore extends OwnedDraftStoreBase {
  constructor(storePath: string) {
    super(storePath);
    trackStore(this);
  }
}

class OwnedNoteStore extends OwnedNoteStoreBase {
  constructor(storePath: string) {
    super(storePath);
    trackStore(this);
  }
}

class OwnedTicketStore extends OwnedTicketStoreBase {
  constructor(storePath: string) {
    super(storePath);
    trackStore(this);
  }
}

function createLooseDraftState(dbPath: string): IntegrationState<{ drafts: Record<string, unknown> }> {
  return new IntegrationState({
    dbPath,
    collections: {
      drafts: {
        parse(_key, value) {
          return value as Record<string, unknown>;
        },
      },
    },
  });
}

function createLooseNoteState(dbPath: string): IntegrationState<{ notes: Record<string, unknown> }> {
  return new IntegrationState({
    dbPath,
    collections: {
      notes: {
        parse(_key, value) {
          return value as Record<string, unknown>;
        },
      },
    },
  });
}

function createLooseTicketState(dbPath: string): IntegrationState<{ tickets: Record<string, unknown> }> {
  return new IntegrationState({
    dbPath,
    collections: {
      tickets: {
        parse(_key, value) {
          return value as Record<string, unknown>;
        },
      },
    },
  });
}

function makeMcpAction(overrides: Partial<ActionRecord> = {}): ActionRecord {
  const confidenceScore = 0.9;
  return {
    schema_version: "action.v1",
    action_id: "act_mcp_test",
    run_id: "run_test",
    session_id: "sess_test",
    status: "normalized",
    timestamps: {
      requested_at: "2026-03-31T12:00:00.000Z",
      normalized_at: "2026-03-31T12:00:01.000Z",
    },
    provenance: {
      mode: "governed",
      source: "test",
      confidence: 0.9,
    },
    actor: {
      type: "agent",
      agent_name: "test-agent",
      agent_framework: "test-framework",
      tool_name: "mcp_call_tool",
      tool_kind: "mcp",
    },
    operation: {
      domain: "mcp",
      kind: "call_tool",
      name: "mcp.notes_server.echo_note",
      display_name: "Call MCP tool notes_server/echo_note",
    },
    execution_path: {
      surface: "mcp_proxy",
      mode: "pre_execution",
      credential_mode: "none",
    },
    target: {
      primary: {
        type: "external_object",
        locator: "mcp://server/notes_server/tools/echo_note",
        label: "notes_server/echo_note",
      },
      scope: {
        breadth: "single",
        estimated_count: 1,
        unknowns: [],
      },
    },
    input: {
      raw: {
        server_id: "notes_server",
        tool_name: "echo_note",
        arguments: {
          note: "launch blocker",
        },
      },
      redacted: {
        server_id: "notes_server",
        tool_name: "echo_note",
        arguments: {
          note: "launch blocker",
        },
      },
      schema_ref: null,
      contains_sensitive_data: false,
    },
    risk_hints: {
      side_effect_level: "unknown",
      external_effects: "network",
      reversibility_hint: "unknown",
      sensitivity_hint: "moderate",
      batch: false,
    },
    facets: {
      mcp: {
        server_id: "notes_server",
        tool_name: "echo_note",
      },
    },
    normalization: {
      mapper: "mcp/v1",
      inferred_fields: [],
      warnings: [],
      normalization_confidence: confidenceScore,
    },
    confidence_assessment: makeConfidenceAssessment(confidenceScore),
    ...overrides,
  };
}

function makeMcpPolicyOutcome(action: ActionRecord): PolicyOutcomeRecord {
  return {
    schema_version: "policy-outcome.v1",
    policy_outcome_id: "pol_mcp_test",
    action_id: action.action_id,
    decision: "allow",
    reasons: [],
    trust_requirements: {
      wrapped_path_required: true,
      brokered_credentials_required: false,
      direct_credentials_forbidden: true,
    },
    preconditions: {
      snapshot_required: false,
      approval_required: false,
      simulation_supported: false,
    },
    approval: null,
    budget_effects: {
      budget_check: "passed",
      estimated_cost: 0,
      remaining_mutating_actions: null,
      remaining_destructive_actions: null,
    },
    policy_context: {
      matched_rules: [],
      sticky_decision_applied: false,
    },
    evaluated_at: "2026-03-31T12:00:02.000Z",
  };
}

async function startTicketService(
  options: {
    token?: string;
    failCreateStatus?: number;
    failUpdateStatus?: number;
    failRestoreStatus?: number;
    failCloseStatus?: number;
    failReopenStatus?: number;
    failDeleteStatus?: number;
  } = {},
): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  requests: Array<{ method: string; url: string; authorization: string | undefined }>;
}> {
  const requests: Array<{ method: string; url: string; authorization: string | undefined }> = [];
  const expectedToken = options.token ?? "test-ticket-token";
  const tickets = new Map<
    string,
    { title: string; body: string; labels: string[]; assigned_users: string[]; status: "active" | "closed" | "deleted" }
  >();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push({
      method: req.method ?? "UNKNOWN",
      url: url.pathname,
      authorization: req.headers.authorization,
    });

    if (req.headers.authorization !== `Bearer ${expectedToken}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    const ticketMatch = url.pathname.match(/^\/api\/tickets\/([^/]+)$/);
    if (!ticketMatch) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not-found" }));
      return;
    }

    const ticketId = decodeURIComponent(ticketMatch[1] ?? "");
    if (req.method === "PUT") {
      if (options.failCreateStatus) {
        res.writeHead(options.failCreateStatus, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "create-failed" }));
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        title: string;
        body: string;
      };
      const existing = tickets.get(ticketId);

      if (!existing || existing.status === "deleted") {
        tickets.set(ticketId, {
          title: payload.title,
          body: payload.body,
          labels: [],
          assigned_users: [],
          status: "active",
        });
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ ticket_id: ticketId, status: "active", message: "created" }));
        return;
      }

      if (existing.title === payload.title && existing.body === payload.body) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ticket_id: ticketId, status: "active", message: "idempotent" }));
        return;
      }

      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "conflict" }));
      return;
    }

    if (req.method === "DELETE") {
      if (options.failDeleteStatus) {
        res.writeHead(options.failDeleteStatus, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "delete-failed" }));
        return;
      }

      const existing = tickets.get(ticketId);
      if (!existing || existing.status === "deleted") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing" }));
        return;
      }

      tickets.set(ticketId, {
        ...existing,
        status: "deleted",
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ticket_id: ticketId, status: "deleted", message: "deleted" }));
      return;
    }

    if (req.method === "PATCH") {
      const existing = tickets.get(ticketId);
      if (!existing || existing.status === "deleted") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing" }));
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        title?: string;
        body?: string;
        status?: "active" | "closed";
        labels?: string[];
        assigned_users?: string[];
        label?: string;
        label_operation?: "add" | "remove";
        user_id?: string;
        assignment_operation?: "add" | "remove";
      };

      const failureStatus =
        payload.status === "closed" && options.failCloseStatus
          ? options.failCloseStatus
          : payload.status === "active" && existing.status === "closed" && options.failReopenStatus
            ? options.failReopenStatus
            : payload.title === "Restored launch blocker" && options.failRestoreStatus
              ? options.failRestoreStatus
              : options.failUpdateStatus;
      if (failureStatus) {
        res.writeHead(failureStatus, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "update-failed" }));
        return;
      }

      tickets.set(ticketId, {
        title: payload.title ?? existing.title,
        body: payload.body ?? existing.body,
        labels: Array.isArray(payload.labels)
          ? [...payload.labels]
          : payload.label_operation === "add" && payload.label
            ? existing.labels.includes(payload.label)
              ? existing.labels
              : [...existing.labels, payload.label]
            : payload.label_operation === "remove" && payload.label
              ? existing.labels.filter((entry) => entry !== payload.label)
              : existing.labels,
        assigned_users: Array.isArray(payload.assigned_users)
          ? [...payload.assigned_users]
          : payload.assignment_operation === "add" && payload.user_id
            ? existing.assigned_users.includes(payload.user_id)
              ? existing.assigned_users
              : [...existing.assigned_users, payload.user_id]
            : payload.assignment_operation === "remove" && payload.user_id
              ? existing.assigned_users.filter((entry) => entry !== payload.user_id)
              : existing.assigned_users,
        status: payload.status ?? existing.status,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ticket_id: ticketId, status: payload.status ?? existing.status, message: "updated" }));
      return;
    }

    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unsupported-method" }));
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  ticketServers.add(server);

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Ticket service did not start with a TCP address.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      ticketServers.delete(server);
    },
    requests,
  };
}

async function startMcpHttpService(
  options: {
    requireBearerToken?: string;
    scenario?: "default" | "missing_tool" | "call_error" | "redirect";
    toolDelayMs?: number;
    redirectLocation?: string;
  } = {},
): Promise<{
  url: string;
  close: () => Promise<void>;
  waitForCallCount: (count: number) => Promise<void>;
}> {
  let startedCallCount = 0;
  const waiters: Array<{ count: number; resolve: () => void }> = [];

  const notifyWaiters = () => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      if (startedCallCount >= waiters[index]!.count) {
        waiters.splice(index, 1)[0]!.resolve();
      }
    }
  };

  const server = http.createServer(async (req, res) => {
    if (options.scenario === "redirect") {
      res.writeHead(307, {
        location: options.redirectLocation ?? "http://192.168.0.10/mcp",
      });
      res.end();
      return;
    }

    if (options.requireBearerToken && req.headers.authorization !== `Bearer ${options.requireBearerToken}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: "Unauthorized",
          },
          id: null,
        }),
      );
      return;
    }

    const mcpServer = new McpServer({
      name: "agentgit-test-http-mcp-server",
      version: "1.0.0",
    });
    const scenario = options.scenario ?? "default";

    if (scenario === "missing_tool") {
      mcpServer.registerTool(
        "other_tool",
        {
          description: "A different tool than requested.",
          inputSchema: {
            note: z.string(),
          },
          annotations: {
            readOnlyHint: true,
          },
        },
        async ({ note }) => ({
          content: [{ type: "text", text: `other:${note}` }],
        }),
      );
    } else {
      mcpServer.registerTool(
        "echo_note",
        {
          description: "Echo a note back to the caller.",
          inputSchema: {
            note: z.string(),
          },
          annotations: {
            readOnlyHint: true,
          },
        },
        async ({ note }) => {
          startedCallCount += 1;
          notifyWaiters();
          if ((options.toolDelayMs ?? 0) > 0) {
            await new Promise((resolve) => setTimeout(resolve, options.toolDelayMs));
          }

          if (scenario === "call_error") {
            return {
              isError: true,
              content: [{ type: "text", text: `http-upstream-error:${note}` }],
            };
          }

          return {
            content: [{ type: "text", text: `http-echo:${note}` }],
            structuredContent: { echoed_note: note },
          };
        },
      );
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    try {
      await mcpServer.connect(transport);
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const bodyText = Buffer.concat(chunks).toString("utf8");
        await transport.handleRequest(req, res, bodyText.length > 0 ? JSON.parse(bodyText) : undefined);
      } else {
        await transport.handleRequest(req, res);
      }
    } finally {
      res.on("close", () => {
        void transport.close().catch(() => undefined);
        void mcpServer.close().catch(() => undefined);
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  ticketServers.add(server);

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("MCP HTTP service did not start with a TCP address.");
  }

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: async () => {
      await closeTicketServer(server);
      ticketServers.delete(server);
    },
    waitForCallCount: async (count: number) => {
      if (startedCallCount >= count) {
        return;
      }

      await new Promise<void>((resolve) => {
        waiters.push({ count, resolve });
      });
    },
  };
}

function makeAction(targetPath: string, operation: "write" | "delete" = "write"): ActionRecord {
  const confidenceScore = 0.99;
  return {
    schema_version: "action.v1",
    action_id: "act_test",
    run_id: "run_test",
    session_id: "sess_test",
    status: "normalized",
    timestamps: {
      requested_at: "2026-03-29T12:00:00.000Z",
      normalized_at: "2026-03-29T12:00:01.000Z",
    },
    provenance: {
      mode: "governed",
      source: "test",
      confidence: 0.99,
    },
    actor: {
      type: "agent",
      tool_name: "write_file",
      tool_kind: "filesystem",
    },
    operation: {
      domain: "filesystem",
      kind: operation,
      name: `filesystem.${operation}`,
      display_name: operation === "delete" ? "Delete file" : "Write file",
    },
    execution_path: {
      surface: "governed_fs",
      mode: "pre_execution",
      credential_mode: "none",
    },
    target: {
      primary: {
        type: "path",
        locator: targetPath,
      },
      scope: {
        breadth: "single",
        estimated_count: 1,
        unknowns: [],
      },
    },
    input: {
      raw: {
        operation,
        path: targetPath,
        content: "hello from adapter",
      },
      redacted: {
        operation,
        path: targetPath,
        content: "hello from adapter",
      },
      schema_ref: null,
      contains_sensitive_data: false,
    },
    risk_hints: {
      side_effect_level: operation === "delete" ? "destructive" : "mutating",
      external_effects: "none",
      reversibility_hint: "reversible",
      sensitivity_hint: "low",
      batch: false,
    },
    facets: {
      filesystem: {
        operation,
        byte_length: 18,
      },
    },
    normalization: {
      mapper: "test",
      inferred_fields: [],
      warnings: [],
      normalization_confidence: confidenceScore,
    },
    confidence_assessment: makeConfidenceAssessment(confidenceScore),
  };
}

function makePolicyOutcome(snapshotRequired = false): PolicyOutcomeRecord {
  return {
    schema_version: "policy-outcome.v1",
    policy_outcome_id: "pol_test",
    action_id: "act_test",
    decision: snapshotRequired ? "allow_with_snapshot" : "allow",
    reasons: [],
    trust_requirements: {
      wrapped_path_required: true,
      brokered_credentials_required: false,
      direct_credentials_forbidden: false,
    },
    preconditions: {
      snapshot_required: snapshotRequired,
      approval_required: false,
      simulation_supported: false,
    },
    approval: null,
    budget_effects: {
      budget_check: "passed",
      estimated_cost: 0,
    },
    policy_context: {
      matched_rules: [],
      sticky_decision_applied: false,
    },
    evaluated_at: "2026-03-29T12:00:02.000Z",
  };
}

function makeFunctionAction(): ActionRecord {
  const locator = "drafts://message_draft/draft_act_test";
  const confidenceScore = 0.95;

  return {
    schema_version: "action.v1",
    action_id: "act_test",
    run_id: "run_test",
    session_id: "sess_test",
    status: "normalized",
    timestamps: {
      requested_at: "2026-03-29T12:00:00.000Z",
      normalized_at: "2026-03-29T12:00:01.000Z",
    },
    provenance: {
      mode: "governed",
      source: "test",
      confidence: 0.95,
    },
    actor: {
      type: "agent",
      agent_name: "test-agent",
      agent_framework: "test-framework",
      tool_name: "drafts_create",
      tool_kind: "function",
    },
    operation: {
      domain: "function",
      kind: "create_draft",
      name: "drafts.create_draft",
      display_name: "Create draft message",
    },
    execution_path: {
      surface: "sdk_function",
      mode: "pre_execution",
      credential_mode: "none",
    },
    target: {
      primary: {
        type: "external_object",
        locator,
        label: "Launch plan",
      },
      scope: {
        breadth: "single",
        estimated_count: 1,
        unknowns: [],
      },
    },
    input: {
      raw: {
        integration: "drafts",
        operation: "create_draft",
        subject: "Launch plan",
        body: "Build the first owned compensator.",
      },
      redacted: {
        integration: "drafts",
        operation: "create_draft",
        subject: "Launch plan",
        body: "Build the first owned compensator.",
      },
      schema_ref: null,
      contains_sensitive_data: false,
    },
    risk_hints: {
      side_effect_level: "mutating",
      external_effects: "network",
      reversibility_hint: "compensatable",
      sensitivity_hint: "moderate",
      batch: false,
    },
    facets: {
      function: {
        integration: "drafts",
        operation: "create_draft",
        object_locator: locator,
      },
    },
    normalization: {
      mapper: "test",
      inferred_fields: [],
      warnings: [],
      normalization_confidence: confidenceScore,
    },
    confidence_assessment: makeConfidenceAssessment(confidenceScore),
  };
}

function makeArchiveFunctionAction(): ActionRecord {
  return {
    ...makeFunctionAction(),
    action_id: "act_archive_test",
    actor: {
      ...makeFunctionAction().actor,
      tool_name: "drafts_archive",
    },
    operation: {
      domain: "function",
      kind: "archive_draft",
      name: "drafts.archive_draft",
      display_name: "Archive draft message",
    },
    target: {
      primary: {
        type: "external_object",
        locator: "drafts://message_draft/draft_existing",
        label: "Draft draft_existing",
      },
      scope: {
        breadth: "single",
        estimated_count: 1,
        unknowns: [],
      },
    },
    input: {
      raw: {
        integration: "drafts",
        operation: "archive_draft",
        draft_id: "draft_existing",
      },
      redacted: {
        integration: "drafts",
        operation: "archive_draft",
        draft_id: "draft_existing",
      },
      schema_ref: null,
      contains_sensitive_data: false,
    },
    facets: {
      function: {
        integration: "drafts",
        operation: "archive_draft",
        object_locator: "drafts://message_draft/draft_existing",
      },
    },
  };
}

function makeDeleteFunctionAction(): ActionRecord {
  return {
    ...makeFunctionAction(),
    action_id: "act_delete_test",
    actor: {
      ...makeFunctionAction().actor,
      tool_name: "drafts_delete",
    },
    operation: {
      domain: "function",
      kind: "delete_draft",
      name: "drafts.delete_draft",
      display_name: "Delete draft message",
    },
    target: {
      primary: {
        type: "external_object",
        locator: "drafts://message_draft/draft_existing",
        label: "Draft draft_existing",
      },
      scope: {
        breadth: "single",
        estimated_count: 1,
        unknowns: [],
      },
    },
    input: {
      raw: {
        integration: "drafts",
        operation: "delete_draft",
        draft_id: "draft_existing",
      },
      redacted: {
        integration: "drafts",
        operation: "delete_draft",
        draft_id: "draft_existing",
      },
      schema_ref: null,
      contains_sensitive_data: false,
    },
    facets: {
      function: {
        integration: "drafts",
        operation: "delete_draft",
        object_locator: "drafts://message_draft/draft_existing",
      },
    },
  };
}

function makeUpdateFunctionAction(): ActionRecord {
  return {
    ...makeFunctionAction(),
    action_id: "act_update_test",
    actor: {
      ...makeFunctionAction().actor,
      tool_name: "drafts_update",
    },
    operation: {
      domain: "function",
      kind: "update_draft",
      name: "drafts.update_draft",
      display_name: "Update draft message",
    },
    target: {
      primary: {
        type: "external_object",
        locator: "drafts://message_draft/draft_existing",
        label: "Draft draft_existing",
      },
      scope: {
        breadth: "single",
        estimated_count: 1,
        unknowns: [],
      },
    },
    input: {
      raw: {
        integration: "drafts",
        operation: "update_draft",
        draft_id: "draft_existing",
        subject: "Updated launch plan",
        body: "Tighten the compensator with preimage restore.",
      },
      redacted: {
        integration: "drafts",
        operation: "update_draft",
        draft_id: "draft_existing",
        subject: "Updated launch plan",
        body: "Tighten the compensator with preimage restore.",
      },
      schema_ref: null,
      contains_sensitive_data: false,
    },
    facets: {
      function: {
        integration: "drafts",
        operation: "update_draft",
        object_locator: "drafts://message_draft/draft_existing",
      },
    },
  };
}

function makeAddLabelFunctionAction(): ActionRecord {
  return {
    ...makeFunctionAction(),
    action_id: "act_label_test",
    actor: {
      ...makeFunctionAction().actor,
      tool_name: "drafts_add_label",
    },
    operation: {
      domain: "function",
      kind: "add_label",
      name: "drafts.add_label",
      display_name: "Add draft label",
    },
    target: {
      primary: {
        type: "external_object",
        locator: "drafts://message_draft/draft_existing/labels/priority%2Fhigh",
        label: "Draft draft_existing label priority/high",
      },
      scope: {
        breadth: "single",
        estimated_count: 1,
        unknowns: [],
      },
    },
    input: {
      raw: {
        integration: "drafts",
        operation: "add_label",
        draft_id: "draft_existing",
        label: "priority/high",
      },
      redacted: {
        integration: "drafts",
        operation: "add_label",
        draft_id: "draft_existing",
        label: "priority/high",
      },
      schema_ref: null,
      contains_sensitive_data: false,
    },
    facets: {
      function: {
        integration: "drafts",
        operation: "add_label",
        object_locator: "drafts://message_draft/draft_existing/labels/priority%2Fhigh",
      },
    },
  };
}

function makeRemoveLabelFunctionAction(): ActionRecord {
  return {
    ...makeFunctionAction(),
    action_id: "act_remove_label_test",
    actor: {
      ...makeFunctionAction().actor,
      tool_name: "drafts_remove_label",
    },
    operation: {
      domain: "function",
      kind: "remove_label",
      name: "drafts.remove_label",
      display_name: "Remove draft label",
    },
    target: {
      primary: {
        type: "external_object",
        locator: "drafts://message_draft/draft_existing/labels/priority%2Fhigh",
        label: "Draft draft_existing label priority/high",
      },
      scope: {
        breadth: "single",
        estimated_count: 1,
        unknowns: [],
      },
    },
    input: {
      raw: {
        integration: "drafts",
        operation: "remove_label",
        draft_id: "draft_existing",
        label: "priority/high",
      },
      redacted: {
        integration: "drafts",
        operation: "remove_label",
        draft_id: "draft_existing",
        label: "priority/high",
      },
      schema_ref: null,
      contains_sensitive_data: false,
    },
    facets: {
      function: {
        integration: "drafts",
        operation: "remove_label",
        object_locator: "drafts://message_draft/draft_existing/labels/priority%2Fhigh",
      },
    },
  };
}

function makeUnarchiveFunctionAction(): ActionRecord {
  return {
    ...makeFunctionAction(),
    action_id: "act_unarchive_test",
    actor: {
      ...makeFunctionAction().actor,
      tool_name: "drafts_unarchive",
    },
    operation: {
      domain: "function",
      kind: "unarchive_draft",
      name: "drafts.unarchive_draft",
      display_name: "Unarchive draft message",
    },
    target: {
      primary: {
        type: "external_object",
        locator: "drafts://message_draft/draft_existing",
        label: "Draft draft_existing",
      },
      scope: {
        breadth: "single",
        estimated_count: 1,
        unknowns: [],
      },
    },
    input: {
      raw: {
        integration: "drafts",
        operation: "unarchive_draft",
        draft_id: "draft_existing",
      },
      redacted: {
        integration: "drafts",
        operation: "unarchive_draft",
        draft_id: "draft_existing",
      },
      schema_ref: null,
      contains_sensitive_data: false,
    },
    facets: {
      function: {
        integration: "drafts",
        operation: "unarchive_draft",
        object_locator: "drafts://message_draft/draft_existing",
      },
    },
  };
}

function makeRestoreFunctionAction(): ActionRecord {
  return {
    ...makeFunctionAction(),
    action_id: "act_restore_test",
    actor: {
      ...makeFunctionAction().actor,
      tool_name: "drafts_restore",
    },
    operation: {
      domain: "function",
      kind: "restore_draft",
      name: "drafts.restore_draft",
      display_name: "Restore draft message",
    },
    target: {
      primary: {
        type: "external_object",
        locator: "drafts://message_draft/draft_existing",
        label: "Draft draft_existing",
      },
      scope: {
        breadth: "single",
        estimated_count: 1,
        unknowns: [],
      },
    },
    input: {
      raw: {
        integration: "drafts",
        operation: "restore_draft",
        draft_id: "draft_existing",
        subject: "Restored launch plan",
        body: "Return the original draft body.",
        status: "archived",
        labels: ["priority/high", "ops"],
      },
      redacted: {
        integration: "drafts",
        operation: "restore_draft",
        draft_id: "draft_existing",
        subject: "Restored launch plan",
        body: "Return the original draft body.",
        status: "archived",
        labels: ["priority/high", "ops"],
      },
      schema_ref: null,
      contains_sensitive_data: false,
    },
    facets: {
      function: {
        integration: "drafts",
        operation: "restore_draft",
        object_locator: "drafts://message_draft/draft_existing",
      },
    },
  };
}

function makeNoteFunctionAction(): ActionRecord {
  const locator = "notes://workspace_note/note_act_test";

  return {
    ...makeFunctionAction(),
    actor: {
      ...makeFunctionAction().actor,
      tool_name: "notes_create",
    },
    operation: {
      domain: "function",
      kind: "create_note",
      name: "notes.create_note",
      display_name: "Create workspace note",
    },
    target: {
      primary: {
        type: "external_object",
        locator,
        label: "Launch notes",
      },
      scope: {
        breadth: "single",
        estimated_count: 1,
        unknowns: [],
      },
    },
    input: {
      raw: {
        integration: "notes",
        operation: "create_note",
        title: "Launch notes",
        body: "Track the second owned integration.",
      },
      redacted: {
        integration: "notes",
        operation: "create_note",
        title: "Launch notes",
        body: "Track the second owned integration.",
      },
      schema_ref: null,
      contains_sensitive_data: false,
    },
    facets: {
      function: {
        integration: "notes",
        operation: "create_note",
        object_locator: locator,
      },
    },
  };
}

function makeNoteArchiveFunctionAction(): ActionRecord {
  return {
    ...makeNoteFunctionAction(),
    action_id: "act_note_archive_test",
    actor: {
      ...makeFunctionAction().actor,
      tool_name: "notes_archive",
    },
    operation: {
      domain: "function",
      kind: "archive_note",
      name: "notes.archive_note",
      display_name: "Archive workspace note",
    },
    target: {
      primary: {
        type: "external_object",
        locator: "notes://workspace_note/note_existing",
        label: "Note note_existing",
      },
      scope: {
        breadth: "single",
        estimated_count: 1,
        unknowns: [],
      },
    },
    input: {
      raw: {
        integration: "notes",
        operation: "archive_note",
        note_id: "note_existing",
      },
      redacted: {
        integration: "notes",
        operation: "archive_note",
        note_id: "note_existing",
      },
      schema_ref: null,
      contains_sensitive_data: false,
    },
    facets: {
      function: {
        integration: "notes",
        operation: "archive_note",
        object_locator: "notes://workspace_note/note_existing",
      },
    },
  };
}

function makeNoteUnarchiveFunctionAction(): ActionRecord {
  return {
    ...makeNoteFunctionAction(),
    action_id: "act_note_unarchive_test",
    actor: {
      ...makeFunctionAction().actor,
      tool_name: "notes_unarchive",
    },
    operation: {
      domain: "function",
      kind: "unarchive_note",
      name: "notes.unarchive_note",
      display_name: "Unarchive workspace note",
    },
    target: {
      primary: {
        type: "external_object",
        locator: "notes://workspace_note/note_existing",
        label: "Note note_existing",
      },
      scope: {
        breadth: "single",
        estimated_count: 1,
        unknowns: [],
      },
    },
    input: {
      raw: {
        integration: "notes",
        operation: "unarchive_note",
        note_id: "note_existing",
      },
      redacted: {
        integration: "notes",
        operation: "unarchive_note",
        note_id: "note_existing",
      },
      schema_ref: null,
      contains_sensitive_data: false,
    },
    facets: {
      function: {
        integration: "notes",
        operation: "unarchive_note",
        object_locator: "notes://workspace_note/note_existing",
      },
    },
  };
}

function makeNoteDeleteFunctionAction(): ActionRecord {
  return {
    ...makeNoteFunctionAction(),
    action_id: "act_note_delete_test",
    actor: {
      ...makeFunctionAction().actor,
      tool_name: "notes_delete",
    },
    operation: {
      domain: "function",
      kind: "delete_note",
      name: "notes.delete_note",
      display_name: "Delete workspace note",
    },
    target: {
      primary: {
        type: "external_object",
        locator: "notes://workspace_note/note_existing",
        label: "Note note_existing",
      },
      scope: {
        breadth: "single",
        estimated_count: 1,
        unknowns: [],
      },
    },
    input: {
      raw: {
        integration: "notes",
        operation: "delete_note",
        note_id: "note_existing",
      },
      redacted: {
        integration: "notes",
        operation: "delete_note",
        note_id: "note_existing",
      },
      schema_ref: null,
      contains_sensitive_data: false,
    },
    facets: {
      function: {
        integration: "notes",
        operation: "delete_note",
        object_locator: "notes://workspace_note/note_existing",
      },
    },
  };
}

function makeNoteUpdateFunctionAction(): ActionRecord {
  return {
    ...makeNoteFunctionAction(),
    action_id: "act_note_update_test",
    actor: {
      ...makeFunctionAction().actor,
      tool_name: "notes_update",
    },
    operation: {
      domain: "function",
      kind: "update_note",
      name: "notes.update_note",
      display_name: "Update workspace note",
    },
    target: {
      primary: {
        type: "external_object",
        locator: "notes://workspace_note/note_existing",
        label: "Note note_existing",
      },
      scope: {
        breadth: "single",
        estimated_count: 1,
        unknowns: [],
      },
    },
    input: {
      raw: {
        integration: "notes",
        operation: "update_note",
        note_id: "note_existing",
        title: "Updated launch notes",
        body: "Refine the second owned integration.",
      },
      redacted: {
        integration: "notes",
        operation: "update_note",
        note_id: "note_existing",
        title: "Updated launch notes",
        body: "Refine the second owned integration.",
      },
      schema_ref: null,
      contains_sensitive_data: false,
    },
    facets: {
      function: {
        integration: "notes",
        operation: "update_note",
        object_locator: "notes://workspace_note/note_existing",
      },
    },
  };
}

function makeNoteRestoreFunctionAction(): ActionRecord {
  return {
    ...makeNoteFunctionAction(),
    action_id: "act_note_restore_test",
    actor: {
      ...makeFunctionAction().actor,
      tool_name: "notes_restore",
    },
    operation: {
      domain: "function",
      kind: "restore_note",
      name: "notes.restore_note",
      display_name: "Restore workspace note",
    },
    target: {
      primary: {
        type: "external_object",
        locator: "notes://workspace_note/note_existing",
        label: "Note note_existing",
      },
      scope: {
        breadth: "single",
        estimated_count: 1,
        unknowns: [],
      },
    },
    input: {
      raw: {
        integration: "notes",
        operation: "restore_note",
        note_id: "note_existing",
        title: "Restored launch notes",
        body: "Return the original note body.",
        status: "archived",
      },
      redacted: {
        integration: "notes",
        operation: "restore_note",
        note_id: "note_existing",
        title: "Restored launch notes",
        body: "Return the original note body.",
        status: "archived",
      },
      schema_ref: null,
      contains_sensitive_data: false,
    },
    facets: {
      function: {
        integration: "notes",
        operation: "restore_note",
        object_locator: "notes://workspace_note/note_existing",
      },
    },
  };
}

function makeTicketFunctionAction(): ActionRecord {
  const locator = "tickets://issue/ticket_act_test";

  return {
    ...makeFunctionAction(),
    actor: {
      ...makeFunctionAction().actor,
      tool_name: "tickets_create",
    },
    execution_path: {
      surface: "sdk_function",
      mode: "pre_execution",
      credential_mode: "brokered",
    },
    operation: {
      domain: "function",
      kind: "create_ticket",
      name: "tickets.create_ticket",
      display_name: "Create external ticket",
    },
    target: {
      primary: {
        type: "external_object",
        locator,
        label: "Launch blocker",
      },
      scope: {
        breadth: "single",
        estimated_count: 1,
        unknowns: [],
      },
    },
    input: {
      raw: {
        integration: "tickets",
        operation: "create_ticket",
        ticket_id: "ticket_act_test",
        title: "Launch blocker",
        body: "Credentialed adapters must use brokered auth.",
      },
      redacted: {
        integration: "tickets",
        operation: "create_ticket",
        ticket_id: "ticket_act_test",
        title: "Launch blocker",
        body: "Credentialed adapters must use brokered auth.",
      },
      schema_ref: null,
      contains_sensitive_data: false,
    },
    facets: {
      function: {
        integration: "tickets",
        operation: "create_ticket",
        object_locator: locator,
        trusted_compensator: "tickets.delete_ticket",
      },
    },
  };
}

function makeTicketUpdateFunctionAction(): ActionRecord {
  const locator = "tickets://issue/ticket_existing";

  return {
    ...makeFunctionAction(),
    actor: {
      ...makeFunctionAction().actor,
      tool_name: "tickets_update",
    },
    execution_path: {
      surface: "sdk_function",
      mode: "pre_execution",
      credential_mode: "brokered",
    },
    operation: {
      domain: "function",
      kind: "update_ticket",
      name: "tickets.update_ticket",
      display_name: "Update external ticket",
    },
    target: {
      primary: {
        type: "external_object",
        locator,
        label: "Ticket ticket_existing",
      },
      scope: {
        breadth: "single",
        estimated_count: 1,
        unknowns: [],
      },
    },
    input: {
      raw: {
        integration: "tickets",
        operation: "update_ticket",
        ticket_id: "ticket_existing",
        title: "Updated launch blocker",
        body: "Recovered ticket flow needs preimage restore.",
      },
      redacted: {
        integration: "tickets",
        operation: "update_ticket",
        ticket_id: "ticket_existing",
        title: "Updated launch blocker",
        body: "Recovered ticket flow needs preimage restore.",
      },
      schema_ref: null,
      contains_sensitive_data: false,
    },
    facets: {
      function: {
        integration: "tickets",
        operation: "update_ticket",
        object_locator: locator,
        trusted_compensator: "tickets.restore_ticket",
      },
    },
  };
}

function makeTicketDeleteFunctionAction(): ActionRecord {
  const locator = "tickets://issue/ticket_existing";

  return {
    ...makeFunctionAction(),
    actor: {
      ...makeFunctionAction().actor,
      tool_name: "tickets_delete",
    },
    execution_path: {
      surface: "sdk_function",
      mode: "pre_execution",
      credential_mode: "brokered",
    },
    operation: {
      domain: "function",
      kind: "delete_ticket",
      name: "tickets.delete_ticket",
      display_name: "Delete external ticket",
    },
    target: {
      primary: {
        type: "external_object",
        locator,
        label: "Ticket ticket_existing",
      },
      scope: {
        breadth: "single",
        estimated_count: 1,
        unknowns: [],
      },
    },
    input: {
      raw: {
        integration: "tickets",
        operation: "delete_ticket",
        ticket_id: "ticket_existing",
      },
      redacted: {
        integration: "tickets",
        operation: "delete_ticket",
        ticket_id: "ticket_existing",
      },
      schema_ref: null,
      contains_sensitive_data: false,
    },
    facets: {
      function: {
        integration: "tickets",
        operation: "delete_ticket",
        object_locator: locator,
        trusted_compensator: "tickets.restore_ticket",
      },
    },
  };
}

function makeTicketRestoreFunctionAction(): ActionRecord {
  const locator = "tickets://issue/ticket_existing";

  return {
    ...makeFunctionAction(),
    actor: {
      ...makeFunctionAction().actor,
      tool_name: "tickets_restore",
    },
    execution_path: {
      surface: "sdk_function",
      mode: "pre_execution",
      credential_mode: "brokered",
    },
    operation: {
      domain: "function",
      kind: "restore_ticket",
      name: "tickets.restore_ticket",
      display_name: "Restore external ticket",
    },
    target: {
      primary: {
        type: "external_object",
        locator,
        label: "Ticket ticket_existing",
      },
      scope: {
        breadth: "single",
        estimated_count: 1,
        unknowns: [],
      },
    },
    input: {
      raw: {
        integration: "tickets",
        operation: "restore_ticket",
        ticket_id: "ticket_existing",
        title: "Restored launch blocker",
        body: "Restore the full external ticket state.",
        status: "closed",
        labels: ["priority/high"],
        assigned_users: ["user_123"],
      },
      redacted: {
        integration: "tickets",
        operation: "restore_ticket",
        ticket_id: "ticket_existing",
        title: "Restored launch blocker",
        body: "Restore the full external ticket state.",
        status: "closed",
        labels: ["priority/high"],
        assigned_users: ["user_123"],
      },
      schema_ref: null,
      contains_sensitive_data: false,
    },
    facets: {
      function: {
        integration: "tickets",
        operation: "restore_ticket",
        object_locator: locator,
        trusted_compensator: "tickets.restore_ticket",
      },
    },
  };
}

function makeTicketCloseFunctionAction(): ActionRecord {
  const locator = "tickets://issue/ticket_existing";

  return {
    ...makeFunctionAction(),
    actor: {
      ...makeFunctionAction().actor,
      tool_name: "tickets_close",
    },
    execution_path: {
      surface: "sdk_function",
      mode: "pre_execution",
      credential_mode: "brokered",
    },
    operation: {
      domain: "function",
      kind: "close_ticket",
      name: "tickets.close_ticket",
      display_name: "Close external ticket",
    },
    target: {
      primary: {
        type: "external_object",
        locator,
        label: "Ticket ticket_existing",
      },
      scope: {
        breadth: "single",
        estimated_count: 1,
        unknowns: [],
      },
    },
    input: {
      raw: {
        integration: "tickets",
        operation: "close_ticket",
        ticket_id: "ticket_existing",
      },
      redacted: {
        integration: "tickets",
        operation: "close_ticket",
        ticket_id: "ticket_existing",
      },
      schema_ref: null,
      contains_sensitive_data: false,
    },
    facets: {
      function: {
        integration: "tickets",
        operation: "close_ticket",
        object_locator: locator,
        trusted_compensator: "tickets.reopen_ticket",
      },
    },
  };
}

function makeTicketAddLabelFunctionAction(): ActionRecord {
  const locator = "tickets://issue/ticket_existing/labels/priority%2Fhigh";

  return {
    ...makeFunctionAction(),
    actor: {
      ...makeFunctionAction().actor,
      tool_name: "tickets_add_label",
    },
    execution_path: {
      surface: "sdk_function",
      mode: "pre_execution",
      credential_mode: "brokered",
    },
    operation: {
      domain: "function",
      kind: "add_label",
      name: "tickets.add_label",
      display_name: "Add external ticket label",
    },
    target: {
      primary: {
        type: "external_object",
        locator,
        label: "Ticket ticket_existing label priority/high",
      },
      scope: {
        breadth: "single",
        estimated_count: 1,
        unknowns: [],
      },
    },
    input: {
      raw: {
        integration: "tickets",
        operation: "add_label",
        ticket_id: "ticket_existing",
        label: "priority/high",
      },
      redacted: {
        integration: "tickets",
        operation: "add_label",
        ticket_id: "ticket_existing",
        label: "priority/high",
      },
      schema_ref: null,
      contains_sensitive_data: false,
    },
    facets: {
      function: {
        integration: "tickets",
        operation: "add_label",
        object_locator: locator,
        trusted_compensator: "tickets.remove_label",
      },
    },
  };
}

function makeTicketReopenFunctionAction(): ActionRecord {
  const locator = "tickets://issue/ticket_existing";

  return {
    ...makeFunctionAction(),
    actor: {
      ...makeFunctionAction().actor,
      tool_name: "tickets_reopen",
    },
    execution_path: {
      surface: "sdk_function",
      mode: "pre_execution",
      credential_mode: "brokered",
    },
    operation: {
      domain: "function",
      kind: "reopen_ticket",
      name: "tickets.reopen_ticket",
      display_name: "Reopen external ticket",
    },
    target: {
      primary: {
        type: "external_object",
        locator,
        label: "Ticket ticket_existing",
      },
      scope: {
        breadth: "single",
        estimated_count: 1,
        unknowns: [],
      },
    },
    input: {
      raw: {
        integration: "tickets",
        operation: "reopen_ticket",
        ticket_id: "ticket_existing",
      },
      redacted: {
        integration: "tickets",
        operation: "reopen_ticket",
        ticket_id: "ticket_existing",
      },
      schema_ref: null,
      contains_sensitive_data: false,
    },
    facets: {
      function: {
        integration: "tickets",
        operation: "reopen_ticket",
        object_locator: locator,
        trusted_compensator: "tickets.close_ticket",
      },
    },
  };
}

function makeTicketAssignUserFunctionAction(): ActionRecord {
  const locator = "tickets://issue/ticket_existing/assignees/user_123";

  return {
    ...makeFunctionAction(),
    actor: {
      ...makeFunctionAction().actor,
      tool_name: "tickets_assign_user",
    },
    execution_path: {
      surface: "sdk_function",
      mode: "pre_execution",
      credential_mode: "brokered",
    },
    operation: {
      domain: "function",
      kind: "assign_user",
      name: "tickets.assign_user",
      display_name: "Assign external ticket user",
    },
    target: {
      primary: {
        type: "external_object",
        locator,
        label: "Ticket ticket_existing assignee user_123",
      },
      scope: {
        breadth: "single",
        estimated_count: 1,
        unknowns: [],
      },
    },
    input: {
      raw: {
        integration: "tickets",
        operation: "assign_user",
        ticket_id: "ticket_existing",
        user_id: "user_123",
      },
      redacted: {
        integration: "tickets",
        operation: "assign_user",
        ticket_id: "ticket_existing",
        user_id: "user_123",
      },
      schema_ref: null,
      contains_sensitive_data: false,
    },
    facets: {
      function: {
        integration: "tickets",
        operation: "assign_user",
        object_locator: locator,
        trusted_compensator: "tickets.unassign_user",
      },
    },
  };
}

function makeTicketRemoveLabelFunctionAction(): ActionRecord {
  const locator = "tickets://issue/ticket_existing/labels/priority%2Fhigh";

  return {
    ...makeFunctionAction(),
    actor: {
      ...makeFunctionAction().actor,
      tool_name: "tickets_remove_label",
    },
    execution_path: {
      surface: "sdk_function",
      mode: "pre_execution",
      credential_mode: "brokered",
    },
    operation: {
      domain: "function",
      kind: "remove_label",
      name: "tickets.remove_label",
      display_name: "Remove external ticket label",
    },
    target: {
      primary: {
        type: "external_object",
        locator,
        label: "Ticket ticket_existing label priority/high",
      },
      scope: {
        breadth: "single",
        estimated_count: 1,
        unknowns: [],
      },
    },
    input: {
      raw: {
        integration: "tickets",
        operation: "remove_label",
        ticket_id: "ticket_existing",
        label: "priority/high",
      },
      redacted: {
        integration: "tickets",
        operation: "remove_label",
        ticket_id: "ticket_existing",
        label: "priority/high",
      },
      schema_ref: null,
      contains_sensitive_data: false,
    },
    facets: {
      function: {
        integration: "tickets",
        operation: "remove_label",
        object_locator: locator,
        trusted_compensator: "tickets.add_label",
      },
    },
  };
}

function makeTicketUnassignUserFunctionAction(): ActionRecord {
  const locator = "tickets://issue/ticket_existing/assignees/user_123";

  return {
    ...makeFunctionAction(),
    actor: {
      ...makeFunctionAction().actor,
      tool_name: "tickets_unassign_user",
    },
    execution_path: {
      surface: "sdk_function",
      mode: "pre_execution",
      credential_mode: "brokered",
    },
    operation: {
      domain: "function",
      kind: "unassign_user",
      name: "tickets.unassign_user",
      display_name: "Unassign external ticket user",
    },
    target: {
      primary: {
        type: "external_object",
        locator,
        label: "Ticket ticket_existing assignee user_123",
      },
      scope: {
        breadth: "single",
        estimated_count: 1,
        unknowns: [],
      },
    },
    input: {
      raw: {
        integration: "tickets",
        operation: "unassign_user",
        ticket_id: "ticket_existing",
        user_id: "user_123",
      },
      redacted: {
        integration: "tickets",
        operation: "unassign_user",
        ticket_id: "ticket_existing",
        user_id: "user_123",
      },
      schema_ref: null,
      contains_sensitive_data: false,
    },
    facets: {
      function: {
        integration: "tickets",
        operation: "unassign_user",
        object_locator: locator,
        trusted_compensator: "tickets.assign_user",
      },
    },
  };
}

async function closeTicketServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

afterEach(async () => {
  while (storeClosers.length > 0) {
    storeClosers.pop()!.close();
  }
  for (const server of [...ticketServers]) {
    ticketServers.delete(server);
    await closeTicketServer(server);
  }
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  tempDirs.cleanup();
});

describe("FilesystemExecutionAdapter", () => {
  it("writes a governed file inside the workspace", async () => {
    tempDir = tempDirs.make("agentgit-exec-");
    const targetPath = path.join(tempDir, "nested", "file.txt");
    const adapter = new FilesystemExecutionAdapter();

    await adapter.verifyPreconditions({
      action: makeAction(targetPath, "write"),
      policy_outcome: makePolicyOutcome(false),
      workspace_root: tempDir,
      snapshot_record: null,
    });

    const result = await adapter.execute({
      action: makeAction(targetPath, "write"),
      policy_outcome: makePolicyOutcome(false),
      workspace_root: tempDir,
      snapshot_record: null,
    });

    expect(fs.readFileSync(targetPath, "utf8")).toBe("hello from adapter");
    expect(result.mode).toBe("executed");
    expect(result.success).toBe(true);
    expect(result.output.executed).toBe(true);
    expect(result.output.after_preview).toBe("hello from adapter");
    expect(result.output.diff_preview).toContain("+ hello from adapter");
    expect(result.artifacts.some((artifact) => artifact.type === "diff")).toBe(true);
  });

  it("rejects filesystem writes that escape the workspace through a symlinked directory", async () => {
    tempDir = tempDirs.make("agentgit-exec-");
    const outsideDir = tempDirs.make("agentgit-exec-outside-");
    const symlinkPath = path.join(tempDir, "linked-outside");
    const targetPath = path.join(symlinkPath, "escape.txt");
    fs.symlinkSync(outsideDir, symlinkPath, "dir");
    const adapter = new FilesystemExecutionAdapter();

    await expect(
      adapter.verifyPreconditions({
        action: makeAction(targetPath, "write"),
        policy_outcome: makePolicyOutcome(false),
        workspace_root: tempDir,
        snapshot_record: null,
      }),
    ).rejects.toThrow("Filesystem action target is outside the governed workspace root.");
  });

  it("rechecks filesystem targets at execution time to block symlink swaps after preflight", async () => {
    tempDir = tempDirs.make("agentgit-exec-");
    const insideDir = path.join(tempDir, "safe-target");
    const outsideDir = tempDirs.make("agentgit-exec-outside-");
    const symlinkPath = path.join(tempDir, "linked-target");
    const targetPath = path.join(symlinkPath, "escape.txt");
    fs.mkdirSync(insideDir, { recursive: true });
    fs.symlinkSync(insideDir, symlinkPath, "dir");
    const adapter = new FilesystemExecutionAdapter();
    const context = {
      action: makeAction(targetPath, "write"),
      policy_outcome: makePolicyOutcome(false),
      workspace_root: tempDir,
      snapshot_record: null,
    } as const;

    await adapter.verifyPreconditions(context);
    fs.rmSync(symlinkPath, { recursive: true, force: true });
    fs.symlinkSync(outsideDir, symlinkPath, "dir");

    await expect(adapter.execute(context)).rejects.toThrow("Resolved path is outside the governed workspace root.");
    expect(fs.existsSync(path.join(outsideDir, "escape.txt"))).toBe(false);
  });

  it("captures a before/after diff preview when overwriting an existing file", async () => {
    tempDir = tempDirs.make("agentgit-exec-");
    const targetPath = path.join(tempDir, "nested", "file.txt");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "before text", "utf8");
    const adapter = new FilesystemExecutionAdapter();

    const result = await adapter.execute({
      action: makeAction(targetPath, "write"),
      policy_outcome: makePolicyOutcome(false),
      workspace_root: tempDir,
      snapshot_record: null,
    });

    expect(result.output.before_preview).toBe("before text");
    expect(result.output.after_preview).toBe("hello from adapter");
    expect(String(result.output.diff_preview)).toContain("- before text");
    expect(String(result.output.diff_preview)).toContain("+ hello from adapter");
  });

  it("captures a removal preview when deleting an existing file", async () => {
    tempDir = tempDirs.make("agentgit-exec-");
    const targetPath = path.join(tempDir, "nested", "file.txt");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "goodbye text", "utf8");
    const adapter = new FilesystemExecutionAdapter();

    const result = await adapter.execute({
      action: makeAction(targetPath, "delete"),
      policy_outcome: makePolicyOutcome(false),
      workspace_root: tempDir,
      snapshot_record: null,
    });

    expect(result.output.deleted).toBe(true);
    expect(result.output.before_preview).toBe("goodbye text");
    expect(String(result.output.diff_preview)).toContain("- goodbye text");
    expect(fs.existsSync(targetPath)).toBe(false);
  });

  it("requires a snapshot boundary when policy says so", async () => {
    tempDir = tempDirs.make("agentgit-exec-");
    const adapter = new FilesystemExecutionAdapter();

    await expect(
      adapter.verifyPreconditions({
        action: makeAction(path.join(tempDir, "file.txt"), "delete"),
        policy_outcome: makePolicyOutcome(true),
        workspace_root: tempDir,
        snapshot_record: null,
      }),
    ).rejects.toThrow("Snapshot-required action is missing a snapshot boundary.");
  });
});

describe("ShellExecutionAdapter", () => {
  it("executes a governed shell command inside the workspace root", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-shell-"));
    const adapter = new ShellExecutionAdapter();
    const shellAction: ActionRecord = {
      ...makeAction(path.join(tempDir, "ignored.txt"), "write"),
      operation: {
        domain: "shell",
        kind: "exec",
        name: "shell.exec",
        display_name: "Print working directory",
      },
      execution_path: {
        surface: "governed_shell",
        mode: "pre_execution",
        credential_mode: "none",
      },
      target: {
        primary: {
          type: "workspace",
          locator: tempDir,
          label: path.basename(tempDir),
        },
        scope: {
          breadth: "workspace",
          unknowns: [],
        },
      },
      input: {
        raw: {
          command: `${process.execPath} -e process.stdout.write(process.cwd())`,
          argv: [process.execPath, "-e", "process.stdout.write(process.cwd())"],
        },
        redacted: {
          command: `${process.execPath} -e process.stdout.write(process.cwd())`,
          argv: [process.execPath, "-e", "process.stdout.write(process.cwd())"],
        },
        schema_ref: null,
        contains_sensitive_data: false,
      },
      facets: {
        shell: {
          argv: [process.execPath, "-e", "process.stdout.write(process.cwd())"],
          cwd: tempDir,
          interpreter: "node",
          command_family: "read_only_shell",
          classifier_rule: "test.shell.read_only",
          declared_env_keys: [],
          stdin_kind: "none",
        },
      },
      risk_hints: {
        side_effect_level: "read_only",
        external_effects: "none",
        reversibility_hint: "reversible",
        sensitivity_hint: "low",
        batch: false,
      },
      normalization: {
        mapper: "test-shell",
        inferred_fields: [],
        warnings: [],
        normalization_confidence: 0.99,
      },
    };

    await adapter.verifyPreconditions({
      action: shellAction,
      policy_outcome: makePolicyOutcome(false),
      workspace_root: tempDir,
      snapshot_record: null,
    });

    const result = await adapter.execute({
      action: shellAction,
      policy_outcome: makePolicyOutcome(false),
      workspace_root: tempDir,
      snapshot_record: null,
    });

    expect(result.mode).toBe("executed");
    expect(result.output.exit_code).toBe(0);
    expect(fs.realpathSync(result.output.stdout as string)).toBe(fs.realpathSync(tempDir));
    expect(result.artifacts.some((artifact) => artifact.type === "stdout")).toBe(true);
  });

  it("rejects shell execution when cwd is outside the governed workspace root", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-shell-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-shell-outside-"));
    const adapter = new ShellExecutionAdapter();
    const shellAction: ActionRecord = {
      ...makeAction(path.join(tempDir, "ignored.txt"), "write"),
      operation: {
        domain: "shell",
        kind: "exec",
        name: "shell.exec",
        display_name: "Inspect workspace",
      },
      target: {
        primary: {
          type: "workspace",
          locator: outsideDir,
          label: path.basename(outsideDir),
        },
        scope: {
          breadth: "workspace",
          unknowns: [],
        },
      },
      facets: {
        shell: {
          argv: ["pwd"],
          cwd: outsideDir,
          interpreter: "pwd",
          command_family: "read_only_shell",
          classifier_rule: "test.shell.outside",
          declared_env_keys: [],
          stdin_kind: "none",
        },
      },
    };

    await expect(
      adapter.verifyPreconditions({
        action: shellAction,
        policy_outcome: makePolicyOutcome(false),
        workspace_root: tempDir,
        snapshot_record: null,
      }),
    ).rejects.toThrow("Shell action cwd is outside the governed workspace root.");

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("rejects shell execution when cwd escapes through a symlinked workspace path", async () => {
    tempDir = tempDirs.make("agentgit-shell-");
    const outsideDir = tempDirs.make("agentgit-shell-outside-");
    const symlinkPath = path.join(tempDir, "linked-outside");
    fs.symlinkSync(outsideDir, symlinkPath, "dir");
    const adapter = new ShellExecutionAdapter();
    const shellAction: ActionRecord = {
      ...makeAction(path.join(tempDir, "ignored.txt"), "write"),
      operation: {
        domain: "shell",
        kind: "exec",
        name: "shell.exec",
        display_name: "Inspect escaped workspace",
      },
      target: {
        primary: {
          type: "workspace",
          locator: symlinkPath,
          label: path.basename(symlinkPath),
        },
        scope: {
          breadth: "workspace",
          unknowns: [],
        },
      },
      facets: {
        shell: {
          argv: ["pwd"],
          cwd: symlinkPath,
          interpreter: "pwd",
          command_family: "read_only_shell",
          classifier_rule: "test.shell.symlink_escape",
          declared_env_keys: [],
          stdin_kind: "none",
        },
      },
    };

    await expect(
      adapter.verifyPreconditions({
        action: shellAction,
        policy_outcome: makePolicyOutcome(false),
        workspace_root: tempDir,
        snapshot_record: null,
      }),
    ).rejects.toThrow("Shell action cwd is outside the governed workspace root.");
  });

  it("rechecks shell cwd at execution time to block symlink swaps after preflight", async () => {
    tempDir = tempDirs.make("agentgit-shell-");
    const insideDir = path.join(tempDir, "safe-cwd");
    const outsideDir = tempDirs.make("agentgit-shell-outside-");
    const symlinkPath = path.join(tempDir, "linked-cwd");
    fs.mkdirSync(insideDir, { recursive: true });
    fs.symlinkSync(insideDir, symlinkPath, "dir");
    const adapter = new ShellExecutionAdapter();
    const shellAction: ActionRecord = {
      ...makeAction(path.join(tempDir, "ignored.txt"), "write"),
      operation: {
        domain: "shell",
        kind: "exec",
        name: "shell.exec",
        display_name: "Inspect swapped workspace",
      },
      target: {
        primary: {
          type: "workspace",
          locator: symlinkPath,
          label: path.basename(symlinkPath),
        },
        scope: {
          breadth: "workspace",
          unknowns: [],
        },
      },
      facets: {
        shell: {
          argv: ["pwd"],
          cwd: symlinkPath,
          interpreter: "pwd",
          command_family: "read_only_shell",
          classifier_rule: "test.shell.symlink_swap",
          declared_env_keys: [],
          stdin_kind: "none",
        },
      },
    };
    const context = {
      action: shellAction,
      policy_outcome: makePolicyOutcome(false),
      workspace_root: tempDir,
      snapshot_record: null,
    } as const;

    await adapter.verifyPreconditions(context);
    fs.rmSync(symlinkPath, { recursive: true, force: true });
    fs.symlinkSync(outsideDir, symlinkPath, "dir");

    await expect(adapter.execute(context)).rejects.toThrow("Resolved path is outside the governed workspace root.");
  });
});

describe("FunctionExecutionAdapter", () => {
  it("creates a draft through the owned drafts store", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const store = new OwnedDraftStore(path.join(tempDir, "drafts.json"));
    const adapter = new FunctionExecutionAdapter(store);

    await adapter.verifyPreconditions({
      action: makeFunctionAction(),
      policy_outcome: makePolicyOutcome(true),
      workspace_root: tempDir,
      snapshot_record: { snapshot_id: "snap_test" },
    });

    const result = await adapter.execute({
      action: makeFunctionAction(),
      policy_outcome: makePolicyOutcome(true),
      workspace_root: tempDir,
      snapshot_record: { snapshot_id: "snap_test" },
    });

    const draft = await store.getDraft("draft_act_test");
    expect(result.mode).toBe("executed");
    expect(result.output.external_object_id).toBe("draft_act_test");
    expect(draft?.status).toBe("active");
    expect(draft?.subject).toBe("Launch plan");
  });

  it("archives a draft through the owned drafts store", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const store = new OwnedDraftStore(path.join(tempDir, "drafts.json"));
    await store.createDraft({
      draftId: "draft_existing",
      subject: "Launch plan",
      body: "Archive this draft.",
      actionId: "act_create_test",
    });
    const adapter = new FunctionExecutionAdapter(store);

    const result = await adapter.execute({
      action: makeArchiveFunctionAction(),
      policy_outcome: makePolicyOutcome(true),
      workspace_root: tempDir,
      snapshot_record: { snapshot_id: "snap_test" },
    });

    expect(result.mode).toBe("executed");
    expect(result.output.external_object_status).toBe("archived");
    expect((await store.getDraft("draft_existing"))?.status).toBe("archived");
  });

  it("returns not found when archiving a missing draft", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const store = new OwnedDraftStore(path.join(tempDir, "drafts.json"));
    const adapter = new FunctionExecutionAdapter(store);

    await expect(
      adapter.execute({
        action: makeArchiveFunctionAction(),
        policy_outcome: makePolicyOutcome(true),
        workspace_root: tempDir,
        snapshot_record: { snapshot_id: "snap_test" },
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("deletes a draft through the owned drafts store idempotently", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const store = new OwnedDraftStore(path.join(tempDir, "drafts.json"));
    await store.createDraft({
      draftId: "draft_existing",
      subject: "Launch plan",
      body: "Delete this draft.",
      actionId: "act_create_test",
    });
    const adapter = new FunctionExecutionAdapter(store);

    const first = await adapter.execute({
      action: makeDeleteFunctionAction(),
      policy_outcome: makePolicyOutcome(true),
      workspace_root: tempDir,
      snapshot_record: { snapshot_id: "snap_test" },
    });
    const second = await adapter.execute({
      action: makeDeleteFunctionAction(),
      policy_outcome: makePolicyOutcome(true),
      workspace_root: tempDir,
      snapshot_record: { snapshot_id: "snap_test" },
    });

    expect(first.mode).toBe("executed");
    expect(first.output.external_object_status).toBe("deleted");
    expect(second.output.external_object_status).toBe("deleted");
    expect((await store.getDraft("draft_existing"))?.status).toBe("deleted");
  });

  it("returns not found when deleting a missing draft", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const store = new OwnedDraftStore(path.join(tempDir, "drafts.json"));
    const adapter = new FunctionExecutionAdapter(store);

    await expect(
      adapter.execute({
        action: makeDeleteFunctionAction(),
        policy_outcome: makePolicyOutcome(true),
        workspace_root: tempDir,
        snapshot_record: { snapshot_id: "snap_test" },
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("unarchives an archived draft through the owned drafts store", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const store = new OwnedDraftStore(path.join(tempDir, "drafts.json"));
    await store.createDraft({
      draftId: "draft_existing",
      subject: "Launch plan",
      body: "Archive this draft first.",
      actionId: "act_create_test",
    });
    await store.archiveDraft("draft_existing");
    const adapter = new FunctionExecutionAdapter(store);

    const result = await adapter.execute({
      action: makeUnarchiveFunctionAction(),
      policy_outcome: makePolicyOutcome(true),
      workspace_root: tempDir,
      snapshot_record: { snapshot_id: "snap_test" },
    });

    expect(result.mode).toBe("executed");
    expect(result.output.external_object_status).toBe("active");
    expect((await store.getDraft("draft_existing"))?.status).toBe("active");
  });

  it("returns not found when unarchiving a missing draft", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const store = new OwnedDraftStore(path.join(tempDir, "drafts.json"));
    const adapter = new FunctionExecutionAdapter(store);

    await expect(
      adapter.execute({
        action: makeUnarchiveFunctionAction(),
        policy_outcome: makePolicyOutcome(true),
        workspace_root: tempDir,
        snapshot_record: { snapshot_id: "snap_test" },
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("updates a draft through the owned drafts store", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const store = new OwnedDraftStore(path.join(tempDir, "drafts.json"));
    await store.createDraft({
      draftId: "draft_existing",
      subject: "Launch plan",
      body: "Original body.",
      actionId: "act_create_test",
    });
    const adapter = new FunctionExecutionAdapter(store);

    const result = await adapter.execute({
      action: makeUpdateFunctionAction(),
      policy_outcome: makePolicyOutcome(true),
      workspace_root: tempDir,
      snapshot_record: { snapshot_id: "snap_test" },
    });

    expect(result.mode).toBe("executed");
    expect(result.output.external_object_status).toBe("active");
    expect(result.output.subject).toBe("Updated launch plan");
    expect(await store.getDraft("draft_existing")).toMatchObject({
      subject: "Updated launch plan",
      body: "Tighten the compensator with preimage restore.",
      status: "active",
    });
  });

  it("adds a label through the owned drafts store", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const store = new OwnedDraftStore(path.join(tempDir, "drafts.json"));
    await store.createDraft({
      draftId: "draft_existing",
      subject: "Launch plan",
      body: "Original body.",
      actionId: "act_create_test",
    });
    const adapter = new FunctionExecutionAdapter(store);

    const result = await adapter.execute({
      action: makeAddLabelFunctionAction(),
      policy_outcome: makePolicyOutcome(true),
      workspace_root: tempDir,
      snapshot_record: { snapshot_id: "snap_test" },
    });

    expect(result.mode).toBe("executed");
    expect(result.output.labels).toEqual(["priority/high"]);
    expect((await store.getDraft("draft_existing"))?.labels).toEqual(["priority/high"]);
  });

  it("removes draft labels idempotently through the owned drafts store", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const store = new OwnedDraftStore(path.join(tempDir, "drafts.json"));
    await store.createDraft({
      draftId: "draft_existing",
      subject: "Launch plan",
      body: "Original body.",
      actionId: "act_create_test",
    });
    await store.addLabel("draft_existing", "priority/high");
    const adapter = new FunctionExecutionAdapter(store);

    const first = await adapter.execute({
      action: makeRemoveLabelFunctionAction(),
      policy_outcome: makePolicyOutcome(true),
      workspace_root: tempDir,
      snapshot_record: { snapshot_id: "snap_test" },
    });
    const second = await adapter.execute({
      action: makeRemoveLabelFunctionAction(),
      policy_outcome: makePolicyOutcome(true),
      workspace_root: tempDir,
      snapshot_record: { snapshot_id: "snap_test" },
    });

    expect(first.mode).toBe("executed");
    expect(first.output.labels).toEqual([]);
    expect(second.output.labels).toEqual([]);
    expect((await store.getDraft("draft_existing"))?.labels).toEqual([]);
  });

  it("restores a draft through the owned drafts store with the requested full state", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const store = new OwnedDraftStore(path.join(tempDir, "drafts.json"));
    await store.createDraft({
      draftId: "draft_existing",
      subject: "Launch plan",
      body: "Original body.",
      actionId: "act_create_test",
    });
    await store.addLabel("draft_existing", "stale");
    const adapter = new FunctionExecutionAdapter(store);

    const result = await adapter.execute({
      action: makeRestoreFunctionAction(),
      policy_outcome: makePolicyOutcome(true),
      workspace_root: tempDir,
      snapshot_record: { snapshot_id: "snap_test" },
    });

    expect(result.mode).toBe("executed");
    expect(result.output.external_object_status).toBe("archived");
    expect(result.output.subject).toBe("Restored launch plan");
    expect(result.output.labels).toEqual(["priority/high", "ops"]);
    expect(await store.getDraft("draft_existing")).toMatchObject({
      subject: "Restored launch plan",
      body: "Return the original draft body.",
      status: "archived",
      labels: ["priority/high", "ops"],
      action_id: "act_create_test",
    });
  });

  it("restores a draft into deleted state through the owned drafts store", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const store = new OwnedDraftStore(path.join(tempDir, "drafts.json"));
    await store.createDraft({
      draftId: "draft_existing",
      subject: "Launch plan",
      body: "Original body.",
      actionId: "act_create_test",
    });
    const adapter = new FunctionExecutionAdapter(store);
    const restoreAction = makeRestoreFunctionAction();

    const result = await adapter.execute({
      action: {
        ...restoreAction,
        input: {
          ...restoreAction.input,
          raw: {
            ...restoreAction.input.raw,
            status: "deleted",
          },
          redacted: {
            ...restoreAction.input.redacted,
            status: "deleted",
          },
        },
      },
      policy_outcome: makePolicyOutcome(true),
      workspace_root: tempDir,
      snapshot_record: { snapshot_id: "snap_test" },
    });

    expect(result.mode).toBe("executed");
    expect(result.output.external_object_status).toBe("deleted");
    expect(await store.getDraft("draft_existing")).toMatchObject({
      status: "deleted",
      subject: "Restored launch plan",
      body: "Return the original draft body.",
      labels: ["priority/high", "ops"],
    });
  });

  it("rejects malformed draft restore labels during direct execution", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const store = new OwnedDraftStore(path.join(tempDir, "drafts.json"));
    await store.createDraft({
      draftId: "draft_existing",
      subject: "Launch plan",
      body: "Original body.",
      actionId: "act_create_test",
    });
    const adapter = new FunctionExecutionAdapter(store);
    const restoreAction = makeRestoreFunctionAction();

    await expect(
      adapter.execute({
        action: {
          ...restoreAction,
          input: {
            ...restoreAction.input,
            raw: {
              ...restoreAction.input.raw,
              labels: ["priority/high", ""],
            },
            redacted: {
              ...restoreAction.input.redacted,
              labels: ["priority/high", ""],
            },
          },
        },
        policy_outcome: makePolicyOutcome(true),
        workspace_root: tempDir,
        snapshot_record: { snapshot_id: "snap_test" },
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it("returns not found when restoring a missing draft", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const store = new OwnedDraftStore(path.join(tempDir, "drafts.json"));
    const adapter = new FunctionExecutionAdapter(store);

    await expect(
      adapter.execute({
        action: makeRestoreFunctionAction(),
        policy_outcome: makePolicyOutcome(true),
        workspace_root: tempDir,
        snapshot_record: { snapshot_id: "snap_test" },
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("creates a note through the owned notes store", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const draftStore = new OwnedDraftStore(path.join(tempDir, "state.db"));
    const noteStore = new OwnedNoteStore(path.join(tempDir, "state.db"));
    const adapter = new FunctionExecutionAdapter(draftStore, noteStore);

    const result = await adapter.execute({
      action: makeNoteFunctionAction(),
      policy_outcome: makePolicyOutcome(true),
      workspace_root: tempDir,
      snapshot_record: { snapshot_id: "snap_test" },
    });

    expect(result.mode).toBe("executed");
    expect(result.output.external_object_id).toBe("note_act_test");
    expect(result.output.external_object_status).toBe("active");
    expect(result.output.subject).toBe("Launch notes");
    expect(await noteStore.getNote("note_act_test")).toMatchObject({
      title: "Launch notes",
      body: "Track the second owned integration.",
      status: "active",
    });
  });

  it("archives and unarchives notes through the owned notes store", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const draftStore = new OwnedDraftStore(path.join(tempDir, "state.db"));
    const noteStore = new OwnedNoteStore(path.join(tempDir, "state.db"));
    await noteStore.createNote({
      noteId: "note_existing",
      title: "Launch notes",
      body: "Track the second owned integration.",
      actionId: "act_note_create",
    });
    const adapter = new FunctionExecutionAdapter(draftStore, noteStore);

    const archived = await adapter.execute({
      action: makeNoteArchiveFunctionAction(),
      policy_outcome: makePolicyOutcome(true),
      workspace_root: tempDir,
      snapshot_record: { snapshot_id: "snap_test" },
    });
    const unarchived = await adapter.execute({
      action: makeNoteUnarchiveFunctionAction(),
      policy_outcome: makePolicyOutcome(true),
      workspace_root: tempDir,
      snapshot_record: { snapshot_id: "snap_test" },
    });

    expect(archived.output.external_object_status).toBe("archived");
    expect(unarchived.output.external_object_status).toBe("active");
    expect(await noteStore.getNote("note_existing")).toMatchObject({
      status: "active",
      title: "Launch notes",
    });
  });

  it("deletes notes idempotently through the owned notes store", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const draftStore = new OwnedDraftStore(path.join(tempDir, "state.db"));
    const noteStore = new OwnedNoteStore(path.join(tempDir, "state.db"));
    await noteStore.createNote({
      noteId: "note_existing",
      title: "Launch notes",
      body: "Track the second owned integration.",
      actionId: "act_note_create",
    });
    const adapter = new FunctionExecutionAdapter(draftStore, noteStore);

    const first = await adapter.execute({
      action: makeNoteDeleteFunctionAction(),
      policy_outcome: makePolicyOutcome(true),
      workspace_root: tempDir,
      snapshot_record: { snapshot_id: "snap_test" },
    });
    const second = await adapter.execute({
      action: makeNoteDeleteFunctionAction(),
      policy_outcome: makePolicyOutcome(true),
      workspace_root: tempDir,
      snapshot_record: { snapshot_id: "snap_test" },
    });

    expect(first.output.external_object_status).toBe("deleted");
    expect(second.output.external_object_status).toBe("deleted");
    expect(await noteStore.getNote("note_existing")).toMatchObject({
      status: "deleted",
    });
  });

  it("updates notes through the owned notes store", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const draftStore = new OwnedDraftStore(path.join(tempDir, "state.db"));
    const noteStore = new OwnedNoteStore(path.join(tempDir, "state.db"));
    await noteStore.createNote({
      noteId: "note_existing",
      title: "Launch notes",
      body: "Track the second owned integration.",
      actionId: "act_note_create",
    });
    const adapter = new FunctionExecutionAdapter(draftStore, noteStore);

    const result = await adapter.execute({
      action: makeNoteUpdateFunctionAction(),
      policy_outcome: makePolicyOutcome(true),
      workspace_root: tempDir,
      snapshot_record: { snapshot_id: "snap_test" },
    });

    expect(result.mode).toBe("executed");
    expect(result.output.external_object_status).toBe("active");
    expect(result.output.subject).toBe("Updated launch notes");
    expect(await noteStore.getNote("note_existing")).toMatchObject({
      title: "Updated launch notes",
      body: "Refine the second owned integration.",
      status: "active",
    });
  });

  it("rejects note updates when the note is archived", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const draftStore = new OwnedDraftStore(path.join(tempDir, "state.db"));
    const noteStore = new OwnedNoteStore(path.join(tempDir, "state.db"));
    await noteStore.createNote({
      noteId: "note_existing",
      title: "Launch notes",
      body: "Track the second owned integration.",
      actionId: "act_note_create",
    });
    await noteStore.archiveNote("note_existing");
    const adapter = new FunctionExecutionAdapter(draftStore, noteStore);

    await expect(
      adapter.execute({
        action: makeNoteUpdateFunctionAction(),
        policy_outcome: makePolicyOutcome(true),
        workspace_root: tempDir,
        snapshot_record: { snapshot_id: "snap_test" },
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("restores a note through the owned notes store with the requested full state", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const draftStore = new OwnedDraftStore(path.join(tempDir, "state.db"));
    const noteStore = new OwnedNoteStore(path.join(tempDir, "state.db"));
    await noteStore.createNote({
      noteId: "note_existing",
      title: "Launch notes",
      body: "Original note body.",
      actionId: "act_note_create",
    });
    const adapter = new FunctionExecutionAdapter(draftStore, noteStore);

    const result = await adapter.execute({
      action: makeNoteRestoreFunctionAction(),
      policy_outcome: makePolicyOutcome(true),
      workspace_root: tempDir,
      snapshot_record: { snapshot_id: "snap_test" },
    });

    expect(result.mode).toBe("executed");
    expect(result.output.external_object_status).toBe("archived");
    expect(result.output.subject).toBe("Restored launch notes");
    expect(await noteStore.getNote("note_existing")).toMatchObject({
      title: "Restored launch notes",
      body: "Return the original note body.",
      status: "archived",
      action_id: "act_note_create",
    });
  });

  it("restores notes into deleted state through the owned notes store", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const draftStore = new OwnedDraftStore(path.join(tempDir, "state.db"));
    const noteStore = new OwnedNoteStore(path.join(tempDir, "state.db"));
    await noteStore.createNote({
      noteId: "note_existing",
      title: "Launch notes",
      body: "Original note body.",
      actionId: "act_note_create",
    });
    const adapter = new FunctionExecutionAdapter(draftStore, noteStore);
    const restoreAction = makeNoteRestoreFunctionAction();

    const result = await adapter.execute({
      action: {
        ...restoreAction,
        input: {
          ...restoreAction.input,
          raw: {
            ...restoreAction.input.raw,
            status: "deleted",
          },
          redacted: {
            ...restoreAction.input.redacted,
            status: "deleted",
          },
        },
      },
      policy_outcome: makePolicyOutcome(true),
      workspace_root: tempDir,
      snapshot_record: { snapshot_id: "snap_test" },
    });

    expect(result.output.external_object_status).toBe("deleted");
    expect(await noteStore.getNote("note_existing")).toMatchObject({
      status: "deleted",
    });
  });

  it("returns not found when restoring a missing note", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const draftStore = new OwnedDraftStore(path.join(tempDir, "state.db"));
    const noteStore = new OwnedNoteStore(path.join(tempDir, "state.db"));
    const adapter = new FunctionExecutionAdapter(draftStore, noteStore);

    await expect(
      adapter.execute({
        action: makeNoteRestoreFunctionAction(),
        policy_outcome: makePolicyOutcome(true),
        workspace_root: tempDir,
        snapshot_record: { snapshot_id: "snap_test" },
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("returns not found when archiving a missing note", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const draftStore = new OwnedDraftStore(path.join(tempDir, "state.db"));
    const noteStore = new OwnedNoteStore(path.join(tempDir, "state.db"));
    const adapter = new FunctionExecutionAdapter(draftStore, noteStore);

    await expect(
      adapter.execute({
        action: makeNoteArchiveFunctionAction(),
        policy_outcome: makePolicyOutcome(true),
        workspace_root: tempDir,
        snapshot_record: { snapshot_id: "snap_test" },
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("returns not found when deleting a missing note", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const draftStore = new OwnedDraftStore(path.join(tempDir, "state.db"));
    const noteStore = new OwnedNoteStore(path.join(tempDir, "state.db"));
    const adapter = new FunctionExecutionAdapter(draftStore, noteStore);

    await expect(
      adapter.execute({
        action: makeNoteDeleteFunctionAction(),
        policy_outcome: makePolicyOutcome(true),
        workspace_root: tempDir,
        snapshot_record: { snapshot_id: "snap_test" },
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("creates a ticket through the brokered owned ticket integration", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const service = await startTicketService();
    const draftStore = new OwnedDraftStore(path.join(tempDir, "state.db"));
    const noteStore = new OwnedNoteStore(path.join(tempDir, "state.db"));
    const ticketStore = new OwnedTicketStore(path.join(tempDir, "state.db"));
    const broker = new SessionCredentialBroker();
    broker.registerBearerProfile({
      integration: "tickets",
      base_url: service.baseUrl,
      token: "test-ticket-token",
      scopes: ["tickets:write"],
      profile_id: "credprof_tickets",
    });
    const ticketIntegration = new OwnedTicketIntegration(ticketStore, broker);
    const adapter = new FunctionExecutionAdapter(draftStore, noteStore, ticketIntegration);

    const result = await adapter.execute({
      action: makeTicketFunctionAction(),
      policy_outcome: makePolicyOutcome(true),
      workspace_root: tempDir,
      snapshot_record: { snapshot_id: "snap_test" },
    });

    expect(result.mode).toBe("executed");
    expect(result.output.external_object_id).toBe("ticket_act_test");
    expect(result.output.external_object_status).toBe("active");
    expect(result.output.subject).toBe("Launch blocker");
    expect(result.output.request_url).toBe(`${service.baseUrl}tickets/ticket_act_test`);
    expect(result.output.broker_profile_id).toBe("credprof_tickets");
    expect(service.requests).toEqual([
      {
        method: "PUT",
        url: "/api/tickets/ticket_act_test",
        authorization: "Bearer test-ticket-token",
      },
    ]);
    expect(await ticketStore.getTicket("ticket_act_test")).toMatchObject({
      title: "Launch blocker",
      body: "Credentialed adapters must use brokered auth.",
      status: "active",
    });

    await service.close();
  });

  it("updates a ticket through the brokered owned ticket integration", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const service = await startTicketService();
    const draftStore = new OwnedDraftStore(path.join(tempDir, "state.db"));
    const noteStore = new OwnedNoteStore(path.join(tempDir, "state.db"));
    const ticketStore = new OwnedTicketStore(path.join(tempDir, "state.db"));
    const broker = new SessionCredentialBroker();
    broker.registerBearerProfile({
      integration: "tickets",
      base_url: service.baseUrl,
      token: "test-ticket-token",
      scopes: ["tickets:write"],
      profile_id: "credprof_tickets",
    });
    const ticketIntegration = new OwnedTicketIntegration(ticketStore, broker);
    await ticketIntegration.createTicket({
      ticketId: "ticket_existing",
      title: "Launch blocker",
      body: "Credentialed adapters must use brokered auth.",
      actionId: "act_create",
    });
    const adapter = new FunctionExecutionAdapter(draftStore, noteStore, ticketIntegration);

    const result = await adapter.execute({
      action: makeTicketUpdateFunctionAction(),
      policy_outcome: makePolicyOutcome(true),
      workspace_root: tempDir,
      snapshot_record: { snapshot_id: "snap_test" },
    });

    expect(result.mode).toBe("executed");
    expect(result.output.external_object_id).toBe("ticket_existing");
    expect(result.output.external_object_status).toBe("active");
    expect(result.output.subject).toBe("Updated launch blocker");
    expect(result.output.request_url).toBe(`${service.baseUrl}tickets/ticket_existing`);
    expect(result.output.response_status).toBe(200);
    expect(service.requests).toEqual([
      {
        method: "PUT",
        url: "/api/tickets/ticket_existing",
        authorization: "Bearer test-ticket-token",
      },
      {
        method: "PATCH",
        url: "/api/tickets/ticket_existing",
        authorization: "Bearer test-ticket-token",
      },
    ]);
    expect(await ticketStore.getTicket("ticket_existing")).toMatchObject({
      title: "Updated launch blocker",
      body: "Recovered ticket flow needs preimage restore.",
      status: "active",
    });

    await service.close();
  });

  it("deletes a ticket through the brokered owned ticket integration when the owned record exists", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const service = await startTicketService();
    const draftStore = new OwnedDraftStore(path.join(tempDir, "state.db"));
    const noteStore = new OwnedNoteStore(path.join(tempDir, "state.db"));
    const ticketStore = new OwnedTicketStore(path.join(tempDir, "state.db"));
    const broker = new SessionCredentialBroker();
    broker.registerBearerProfile({
      integration: "tickets",
      base_url: service.baseUrl,
      token: "test-ticket-token",
      scopes: ["tickets:write"],
      profile_id: "credprof_tickets",
    });
    const ticketIntegration = new OwnedTicketIntegration(ticketStore, broker);
    await ticketIntegration.createTicket({
      ticketId: "ticket_existing",
      title: "Launch blocker",
      body: "Delete only when the owned record exists.",
      actionId: "act_create",
    });
    const adapter = new FunctionExecutionAdapter(draftStore, noteStore, ticketIntegration);

    const result = await adapter.execute({
      action: makeTicketDeleteFunctionAction(),
      policy_outcome: makePolicyOutcome(true),
      workspace_root: tempDir,
      snapshot_record: { snapshot_id: "snap_test" },
    });

    expect(result.mode).toBe("executed");
    expect(result.output.external_object_id).toBe("ticket_existing");
    expect(result.output.external_object_status).toBe("deleted");
    expect(await ticketStore.getTicket("ticket_existing")).toMatchObject({
      status: "deleted",
    });

    await service.close();
  });

  it("restores a ticket through the brokered owned ticket integration with full remote state sync", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const service = await startTicketService();
    const draftStore = new OwnedDraftStore(path.join(tempDir, "state.db"));
    const noteStore = new OwnedNoteStore(path.join(tempDir, "state.db"));
    const ticketStore = new OwnedTicketStore(path.join(tempDir, "state.db"));
    const broker = new SessionCredentialBroker();
    broker.registerBearerProfile({
      integration: "tickets",
      base_url: service.baseUrl,
      token: "test-ticket-token",
      scopes: ["tickets:write"],
      profile_id: "credprof_tickets",
    });
    const ticketIntegration = new OwnedTicketIntegration(ticketStore, broker);
    await ticketIntegration.createTicket({
      ticketId: "ticket_existing",
      title: "Launch blocker",
      body: "Original remote state.",
      actionId: "act_create",
    });
    await ticketIntegration.addLabel("ticket_existing", "priority/low");
    await ticketIntegration.assignUser("ticket_existing", "user_old");
    await ticketIntegration.deleteTicket("ticket_existing");
    const adapter = new FunctionExecutionAdapter(draftStore, noteStore, ticketIntegration);

    const result = await adapter.execute({
      action: makeTicketRestoreFunctionAction(),
      policy_outcome: makePolicyOutcome(true),
      workspace_root: tempDir,
      snapshot_record: { snapshot_id: "snap_test" },
    });

    expect(result.mode).toBe("executed");
    expect(result.output.external_object_status).toBe("closed");
    expect(result.output.labels).toEqual(["priority/high"]);
    expect(result.output.assigned_users).toEqual(["user_123"]);
    expect(await ticketStore.getTicket("ticket_existing")).toMatchObject({
      title: "Restored launch blocker",
      body: "Restore the full external ticket state.",
      status: "closed",
      labels: ["priority/high"],
      assigned_users: ["user_123"],
      deleted_at: null,
    });

    await service.close();
  });

  it("rejects direct ticket delete when the owned record is missing before any upstream mutation", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const service = await startTicketService();
    const draftStore = new OwnedDraftStore(path.join(tempDir, "state.db"));
    const noteStore = new OwnedNoteStore(path.join(tempDir, "state.db"));
    const ticketStore = new OwnedTicketStore(path.join(tempDir, "state.db"));
    const broker = new SessionCredentialBroker();
    broker.registerBearerProfile({
      integration: "tickets",
      base_url: service.baseUrl,
      token: "test-ticket-token",
      scopes: ["tickets:write"],
      profile_id: "credprof_tickets",
    });
    const ticketIntegration = new OwnedTicketIntegration(ticketStore, broker);
    const adapter = new FunctionExecutionAdapter(draftStore, noteStore, ticketIntegration);

    await expect(
      adapter.execute({
        action: makeTicketDeleteFunctionAction(),
        policy_outcome: makePolicyOutcome(true),
        workspace_root: tempDir,
        snapshot_record: { snapshot_id: "snap_test" },
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(service.requests).toEqual([]);

    await service.close();
  });

  it("closes a ticket through the brokered owned ticket integration", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const service = await startTicketService();
    const draftStore = new OwnedDraftStore(path.join(tempDir, "state.db"));
    const noteStore = new OwnedNoteStore(path.join(tempDir, "state.db"));
    const ticketStore = new OwnedTicketStore(path.join(tempDir, "state.db"));
    const broker = new SessionCredentialBroker();
    broker.registerBearerProfile({
      integration: "tickets",
      base_url: service.baseUrl,
      token: "test-ticket-token",
      scopes: ["tickets:write"],
      profile_id: "credprof_tickets",
    });
    const ticketIntegration = new OwnedTicketIntegration(ticketStore, broker);
    await ticketIntegration.createTicket({
      ticketId: "ticket_existing",
      title: "Launch blocker",
      body: "Credentialed adapters must use brokered auth.",
      actionId: "act_create",
    });
    const adapter = new FunctionExecutionAdapter(draftStore, noteStore, ticketIntegration);

    const result = await adapter.execute({
      action: makeTicketCloseFunctionAction(),
      policy_outcome: makePolicyOutcome(true),
      workspace_root: tempDir,
      snapshot_record: { snapshot_id: "snap_test" },
    });

    expect(result.mode).toBe("executed");
    expect(result.output.external_object_id).toBe("ticket_existing");
    expect(result.output.external_object_status).toBe("closed");
    expect(result.output.subject).toBe("Launch blocker");
    expect(service.requests).toEqual([
      {
        method: "PUT",
        url: "/api/tickets/ticket_existing",
        authorization: "Bearer test-ticket-token",
      },
      {
        method: "PATCH",
        url: "/api/tickets/ticket_existing",
        authorization: "Bearer test-ticket-token",
      },
    ]);
    expect(await ticketStore.getTicket("ticket_existing")).toMatchObject({
      title: "Launch blocker",
      body: "Credentialed adapters must use brokered auth.",
      status: "closed",
    });

    await service.close();
  });

  it("reopens a ticket through the brokered owned ticket integration", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const service = await startTicketService();
    const draftStore = new OwnedDraftStore(path.join(tempDir, "state.db"));
    const noteStore = new OwnedNoteStore(path.join(tempDir, "state.db"));
    const ticketStore = new OwnedTicketStore(path.join(tempDir, "state.db"));
    const broker = new SessionCredentialBroker();
    broker.registerBearerProfile({
      integration: "tickets",
      base_url: service.baseUrl,
      token: "test-ticket-token",
      scopes: ["tickets:write"],
      profile_id: "credprof_tickets",
    });
    const ticketIntegration = new OwnedTicketIntegration(ticketStore, broker);
    await ticketIntegration.createTicket({
      ticketId: "ticket_existing",
      title: "Launch blocker",
      body: "Credentialed adapters must use brokered auth.",
      actionId: "act_create",
    });
    await ticketIntegration.closeTicket("ticket_existing");
    const adapter = new FunctionExecutionAdapter(draftStore, noteStore, ticketIntegration);

    const result = await adapter.execute({
      action: makeTicketReopenFunctionAction(),
      policy_outcome: makePolicyOutcome(true),
      workspace_root: tempDir,
      snapshot_record: { snapshot_id: "snap_test" },
    });

    expect(result.mode).toBe("executed");
    expect(result.output.external_object_id).toBe("ticket_existing");
    expect(result.output.external_object_status).toBe("active");
    expect(await ticketStore.getTicket("ticket_existing")).toMatchObject({
      status: "active",
      closed_at: null,
    });

    await service.close();
  });

  it("adds a label through the brokered owned ticket integration", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const service = await startTicketService();
    const draftStore = new OwnedDraftStore(path.join(tempDir, "state.db"));
    const noteStore = new OwnedNoteStore(path.join(tempDir, "state.db"));
    const ticketStore = new OwnedTicketStore(path.join(tempDir, "state.db"));
    const broker = new SessionCredentialBroker();
    broker.registerBearerProfile({
      integration: "tickets",
      base_url: service.baseUrl,
      token: "test-ticket-token",
      scopes: ["tickets:write"],
      profile_id: "credprof_tickets",
    });
    const ticketIntegration = new OwnedTicketIntegration(ticketStore, broker);
    await ticketIntegration.createTicket({
      ticketId: "ticket_existing",
      title: "Launch blocker",
      body: "Credentialed adapters must use brokered auth.",
      actionId: "act_create",
    });
    const adapter = new FunctionExecutionAdapter(draftStore, noteStore, ticketIntegration);

    const result = await adapter.execute({
      action: makeTicketAddLabelFunctionAction(),
      policy_outcome: makePolicyOutcome(true),
      workspace_root: tempDir,
      snapshot_record: { snapshot_id: "snap_test" },
    });

    expect(result.mode).toBe("executed");
    expect(result.output.external_object_id).toBe("ticket_existing");
    expect(result.output.external_object_status).toBe("active");
    expect(result.output.labels).toEqual(["priority/high"]);
    expect(await ticketStore.getTicket("ticket_existing")).toMatchObject({
      labels: ["priority/high"],
      status: "active",
    });

    await service.close();
  });

  it("assigns a user through the brokered owned ticket integration", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const service = await startTicketService();
    const draftStore = new OwnedDraftStore(path.join(tempDir, "state.db"));
    const noteStore = new OwnedNoteStore(path.join(tempDir, "state.db"));
    const ticketStore = new OwnedTicketStore(path.join(tempDir, "state.db"));
    const broker = new SessionCredentialBroker();
    broker.registerBearerProfile({
      integration: "tickets",
      base_url: service.baseUrl,
      token: "test-ticket-token",
      scopes: ["tickets:write"],
      profile_id: "credprof_tickets",
    });
    const ticketIntegration = new OwnedTicketIntegration(ticketStore, broker);
    await ticketIntegration.createTicket({
      ticketId: "ticket_existing",
      title: "Launch blocker",
      body: "Credentialed adapters must use brokered auth.",
      actionId: "act_create",
    });
    const adapter = new FunctionExecutionAdapter(draftStore, noteStore, ticketIntegration);

    const result = await adapter.execute({
      action: makeTicketAssignUserFunctionAction(),
      policy_outcome: makePolicyOutcome(true),
      workspace_root: tempDir,
      snapshot_record: { snapshot_id: "snap_test" },
    });

    expect(result.mode).toBe("executed");
    expect(result.output.external_object_id).toBe("ticket_existing");
    expect(result.output.external_object_status).toBe("active");
    expect(result.output.assigned_users).toEqual(["user_123"]);
    expect(await ticketStore.getTicket("ticket_existing")).toMatchObject({
      assigned_users: ["user_123"],
      status: "active",
    });

    await service.close();
  });

  it("unassigns a user through the brokered owned ticket integration", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const service = await startTicketService();
    const draftStore = new OwnedDraftStore(path.join(tempDir, "state.db"));
    const noteStore = new OwnedNoteStore(path.join(tempDir, "state.db"));
    const ticketStore = new OwnedTicketStore(path.join(tempDir, "state.db"));
    const broker = new SessionCredentialBroker();
    broker.registerBearerProfile({
      integration: "tickets",
      base_url: service.baseUrl,
      token: "test-ticket-token",
      scopes: ["tickets:write"],
      profile_id: "credprof_tickets",
    });
    const ticketIntegration = new OwnedTicketIntegration(ticketStore, broker);
    await ticketIntegration.createTicket({
      ticketId: "ticket_existing",
      title: "Launch blocker",
      body: "Credentialed adapters must use brokered auth.",
      actionId: "act_create",
    });
    await ticketIntegration.assignUser("ticket_existing", "user_123");
    const adapter = new FunctionExecutionAdapter(draftStore, noteStore, ticketIntegration);

    const result = await adapter.execute({
      action: makeTicketUnassignUserFunctionAction(),
      policy_outcome: makePolicyOutcome(true),
      workspace_root: tempDir,
      snapshot_record: { snapshot_id: "snap_test" },
    });

    expect(result.mode).toBe("executed");
    expect(result.output.external_object_id).toBe("ticket_existing");
    expect(result.output.external_object_status).toBe("active");
    expect(result.output.assigned_users).toEqual([]);
    expect(await ticketStore.getTicket("ticket_existing")).toMatchObject({
      assigned_users: [],
      status: "active",
    });

    await service.close();
  });

  it("removes a label through the brokered owned ticket integration", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-function-"));
    const service = await startTicketService();
    const draftStore = new OwnedDraftStore(path.join(tempDir, "state.db"));
    const noteStore = new OwnedNoteStore(path.join(tempDir, "state.db"));
    const ticketStore = new OwnedTicketStore(path.join(tempDir, "state.db"));
    const broker = new SessionCredentialBroker();
    broker.registerBearerProfile({
      integration: "tickets",
      base_url: service.baseUrl,
      token: "test-ticket-token",
      scopes: ["tickets:write"],
      profile_id: "credprof_tickets",
    });
    const ticketIntegration = new OwnedTicketIntegration(ticketStore, broker);
    await ticketIntegration.createTicket({
      ticketId: "ticket_existing",
      title: "Launch blocker",
      body: "Credentialed adapters must use brokered auth.",
      actionId: "act_create",
    });
    await ticketIntegration.addLabel("ticket_existing", "priority/high");
    const adapter = new FunctionExecutionAdapter(draftStore, noteStore, ticketIntegration);

    const result = await adapter.execute({
      action: makeTicketRemoveLabelFunctionAction(),
      policy_outcome: makePolicyOutcome(true),
      workspace_root: tempDir,
      snapshot_record: { snapshot_id: "snap_test" },
    });

    expect(result.mode).toBe("executed");
    expect(result.output.external_object_id).toBe("ticket_existing");
    expect(result.output.external_object_status).toBe("active");
    expect(result.output.labels).toEqual([]);
    expect(await ticketStore.getTicket("ticket_existing")).toMatchObject({
      labels: [],
      status: "active",
    });

    await service.close();
  });
});

describe("OwnedDraftStore", () => {
  it("treats duplicate create requests for the same action as idempotent", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-drafts-"));
    const store = new OwnedDraftStore(path.join(tempDir, "drafts.json"));

    const first = await store.createDraft({
      draftId: "draft_1",
      subject: "Launch plan",
      body: "Ship it carefully.",
      actionId: "act_same",
    });
    const second = await store.createDraft({
      draftId: "draft_1",
      subject: "Launch plan",
      body: "Ship it carefully.",
      actionId: "act_same",
    });

    expect(second).toEqual(first);
    expect(await store.getDraft("draft_1")).toEqual(first);
  });

  it("rejects conflicting draft identifier reuse", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-drafts-"));
    const store = new OwnedDraftStore(path.join(tempDir, "drafts.json"));

    await store.createDraft({
      draftId: "draft_1",
      subject: "Launch plan",
      body: "Original body",
      actionId: "act_first",
    });

    await expect(
      store.createDraft({
        draftId: "draft_1",
        subject: "Launch plan",
        body: "Conflicting body",
        actionId: "act_second",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("serializes create and archive operations without losing state", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-drafts-"));
    const store = new OwnedDraftStore(path.join(tempDir, "drafts.json"));

    await Promise.all([
      store.createDraft({
        draftId: "draft_1",
        subject: "Launch plan",
        body: "Ship it carefully.",
        actionId: "act_1",
      }),
      (async () => {
        await store.createDraft({
          draftId: "draft_2",
          subject: "Rollback plan",
          body: "Make it safe.",
          actionId: "act_2",
        });
        await store.archiveDraft("draft_2");
      })(),
    ]);

    expect((await store.getDraft("draft_1"))?.status).toBe("active");
    expect((await store.getDraft("draft_2"))?.status).toBe("archived");
  });

  it("unarchives archived drafts idempotently", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-drafts-"));
    const store = new OwnedDraftStore(path.join(tempDir, "drafts.json"));

    await store.createDraft({
      draftId: "draft_1",
      subject: "Launch plan",
      body: "Ship it carefully.",
      actionId: "act_1",
    });
    await store.archiveDraft("draft_1");

    const first = await store.unarchiveDraft("draft_1");
    const second = await store.unarchiveDraft("draft_1");

    expect(first?.status).toBe("active");
    expect(second?.status).toBe("active");
    expect(second?.archived_at).toBeNull();
  });

  it("rejects updates to archived drafts with a conflict", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-drafts-"));
    const store = new OwnedDraftStore(path.join(tempDir, "drafts.json"));

    await store.createDraft({
      draftId: "draft_1",
      subject: "Launch plan",
      body: "Ship it carefully.",
      actionId: "act_1",
    });
    await store.archiveDraft("draft_1");

    await expect(
      store.updateDraft("draft_1", {
        subject: "Should fail",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("deletes drafts idempotently and preserves deleted state", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-drafts-"));
    const store = new OwnedDraftStore(path.join(tempDir, "drafts.json"));

    await store.createDraft({
      draftId: "draft_1",
      subject: "Launch plan",
      body: "Ship it carefully.",
      actionId: "act_1",
    });

    const first = await store.deleteDraft("draft_1");
    const second = await store.deleteDraft("draft_1");

    expect(first?.status).toBe("deleted");
    expect(second?.status).toBe("deleted");
    expect(second?.deleted_at).not.toBeNull();
  });

  it("restores a draft from a captured preimage", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-drafts-"));
    const store = new OwnedDraftStore(path.join(tempDir, "drafts.json"));

    await store.createDraft({
      draftId: "draft_1",
      subject: "Launch plan",
      body: "Original body",
      actionId: "act_1",
    });
    await store.updateDraft("draft_1", {
      subject: "Changed subject",
      body: "Changed body",
    });

    const restored = await store.restoreDraftFromSnapshot("draft_1", {
      draft_id: "draft_1",
      subject: "Launch plan",
      body: "Original body",
      status: "active",
      action_id: "act_1",
      created_at: "2026-03-29T12:00:00.000Z",
      archived_at: null,
      deleted_at: null,
    });

    expect(restored).toMatchObject({
      draft_id: "draft_1",
      subject: "Launch plan",
      body: "Original body",
      status: "active",
      action_id: "act_1",
    });
    expect(await store.getDraft("draft_1")).toMatchObject({
      subject: "Launch plan",
      body: "Original body",
      status: "active",
    });
  });

  it("adds labels idempotently and removes them for compensation", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-drafts-"));
    const store = new OwnedDraftStore(path.join(tempDir, "drafts.json"));

    await store.createDraft({
      draftId: "draft_1",
      subject: "Launch plan",
      body: "Original body",
      actionId: "act_1",
    });

    const first = await store.addLabel("draft_1", "priority/high");
    const second = await store.addLabel("draft_1", "priority/high");
    expect(first?.labels).toEqual(["priority/high"]);
    expect(second?.labels).toEqual(["priority/high"]);

    const removed = await store.removeLabel("draft_1", "priority/high");
    const removedAgain = await store.removeLabel("draft_1", "priority/high");
    expect(removed?.labels).toEqual([]);
    expect(removedAgain?.labels).toEqual([]);
  });

  it("rejects labeling archived drafts with a conflict", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-drafts-"));
    const store = new OwnedDraftStore(path.join(tempDir, "drafts.json"));

    await store.createDraft({
      draftId: "draft_1",
      subject: "Launch plan",
      body: "Ship it carefully.",
      actionId: "act_1",
    });
    await store.archiveDraft("draft_1");

    await expect(store.addLabel("draft_1", "priority/high")).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("rejects labeling deleted drafts with a conflict", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-drafts-"));
    const store = new OwnedDraftStore(path.join(tempDir, "drafts.json"));

    await store.createDraft({
      draftId: "draft_1",
      subject: "Launch plan",
      body: "Ship it carefully.",
      actionId: "act_1",
    });
    await store.deleteDraft("draft_1");

    await expect(store.addLabel("draft_1", "priority/high")).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("rejects non-object persisted draft values with a storage error", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-drafts-"));
    const storePath = path.join(tempDir, "state.db");
    const looseState = createLooseDraftState(storePath);
    looseState.put("drafts", "draft_1", "{not-valid-json" as unknown as Record<string, unknown>);
    looseState.close();
    const store = new OwnedDraftStore(storePath);

    await expect(store.getDraft("draft_1")).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
  });

  it("rejects malformed stored draft records with a storage error", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-drafts-"));
    const storePath = path.join(tempDir, "state.db");
    const looseState = createLooseDraftState(storePath);
    looseState.put("drafts", "draft_1", {
      draft_id: "draft_1",
      subject: "Broken record",
      body: "missing action id and timestamps",
      status: "active",
    });
    looseState.close();
    const store = new OwnedDraftStore(storePath);

    await expect(store.getDraft("draft_1")).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
  });
});

describe("OwnedTicketIntegration", () => {
  it("fails closed when the broker profile is missing", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-ticket-"));
    const store = new OwnedTicketStore(path.join(tempDir, "state.db"));
    const broker = new SessionCredentialBroker();
    const integration = new OwnedTicketIntegration(store, broker);

    await expect(
      integration.createTicket({
        ticketId: "ticket_1",
        title: "Launch blocker",
        body: "Broker required",
        actionId: "act_ticket_1",
      }),
    ).rejects.toMatchObject({
      code: "BROKER_UNAVAILABLE",
    });
  });

  it("does not leak raw bearer tokens when upstream create fails", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-ticket-"));
    const service = await startTicketService({ failCreateStatus: 502 });
    const store = new OwnedTicketStore(path.join(tempDir, "state.db"));
    const broker = new SessionCredentialBroker();
    broker.registerBearerProfile({
      integration: "tickets",
      base_url: service.baseUrl,
      token: "super-secret-ticket-token",
      scopes: ["tickets:write"],
      profile_id: "credprof_tickets",
    });
    const integration = new OwnedTicketIntegration(store, broker);

    await expect(
      integration.createTicket({
        ticketId: "ticket_1",
        title: "Launch blocker",
        body: "Broker required",
        actionId: "act_ticket_1",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      const serialized = JSON.stringify(error);
      return serialized.includes("super-secret-ticket-token") === false;
    });

    await service.close();
  });

  it("treats repeated delete requests as idempotent when the remote ticket is already gone", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-ticket-"));
    const service = await startTicketService();
    const store = new OwnedTicketStore(path.join(tempDir, "state.db"));
    const broker = new SessionCredentialBroker();
    broker.registerBearerProfile({
      integration: "tickets",
      base_url: service.baseUrl,
      token: "test-ticket-token",
      scopes: ["tickets:write"],
    });
    const integration = new OwnedTicketIntegration(store, broker);

    await integration.createTicket({
      ticketId: "ticket_1",
      title: "Launch blocker",
      body: "Broker required",
      actionId: "act_ticket_1",
    });
    const firstDelete = await integration.deleteTicket("ticket_1");
    const secondDelete = await integration.deleteTicket("ticket_1");

    expect(firstDelete.record?.status).toBe("deleted");
    expect(secondDelete.record?.status).toBe("deleted");
    expect(await store.getTicket("ticket_1")).toMatchObject({
      status: "deleted",
    });

    await service.close();
  });

  it("restores an owned ticket from captured preimage", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-ticket-"));
    const service = await startTicketService();
    const store = new OwnedTicketStore(path.join(tempDir, "state.db"));
    const broker = new SessionCredentialBroker();
    broker.registerBearerProfile({
      integration: "tickets",
      base_url: service.baseUrl,
      token: "test-ticket-token",
      scopes: ["tickets:write"],
    });
    const integration = new OwnedTicketIntegration(store, broker);

    await integration.createTicket({
      ticketId: "ticket_1",
      title: "Launch blocker",
      body: "Original body",
      actionId: "act_ticket_1",
    });
    await integration.addLabel("ticket_1", "priority/low");
    await integration.assignUser("ticket_1", "user_old");
    await integration.updateTicket({
      ticketId: "ticket_1",
      title: "Updated blocker",
      body: "Updated body",
    });

    const restored = await integration.restoreTicketFromSnapshot("ticket_1", {
      ticket_id: "ticket_1",
      title: "Launch blocker",
      body: "Original body",
      status: "active",
      labels: ["priority/high"],
      assigned_users: ["user_123"],
      action_id: "act_ticket_1",
      remote_url: `${service.baseUrl}tickets/ticket_1`,
      created_at: new Date().toISOString(),
      closed_at: null,
      deleted_at: null,
    });

    expect(restored.record).toMatchObject({
      ticket_id: "ticket_1",
      title: "Launch blocker",
      body: "Original body",
      status: "active",
      labels: ["priority/high"],
      assigned_users: ["user_123"],
    });
    expect(service.requests).toHaveLength(5);
    expect(service.requests[0]).toEqual({
      method: "PUT",
      url: "/api/tickets/ticket_1",
      authorization: "Bearer test-ticket-token",
    });
    expect(service.requests.slice(1)).toEqual([
      {
        method: "PATCH",
        url: "/api/tickets/ticket_1",
        authorization: "Bearer test-ticket-token",
      },
      {
        method: "PATCH",
        url: "/api/tickets/ticket_1",
        authorization: "Bearer test-ticket-token",
      },
      {
        method: "PATCH",
        url: "/api/tickets/ticket_1",
        authorization: "Bearer test-ticket-token",
      },
      {
        method: "PATCH",
        url: "/api/tickets/ticket_1",
        authorization: "Bearer test-ticket-token",
      },
    ]);

    await service.close();
  });

  it("surfaces not found when the upstream ticket disappears before update", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-ticket-"));
    const service = await startTicketService({ failUpdateStatus: 404 });
    const store = new OwnedTicketStore(path.join(tempDir, "state.db"));
    const broker = new SessionCredentialBroker();
    broker.registerBearerProfile({
      integration: "tickets",
      base_url: service.baseUrl,
      token: "test-ticket-token",
      scopes: ["tickets:write"],
    });
    const integration = new OwnedTicketIntegration(store, broker);

    await integration.createTicket({
      ticketId: "ticket_missing",
      title: "Launch blocker",
      body: "Original body",
      actionId: "act_ticket_1",
    });

    await expect(
      integration.updateTicket({
        ticketId: "ticket_missing",
        title: "Updated blocker",
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    await service.close();
  });

  it("recreates the upstream ticket when restore runs after a delete", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-ticket-"));
    const service = await startTicketService();
    const store = new OwnedTicketStore(path.join(tempDir, "state.db"));
    const broker = new SessionCredentialBroker();
    broker.registerBearerProfile({
      integration: "tickets",
      base_url: service.baseUrl,
      token: "test-ticket-token",
      scopes: ["tickets:write"],
    });
    const integration = new OwnedTicketIntegration(store, broker);

    await integration.createTicket({
      ticketId: "ticket_1",
      title: "Launch blocker",
      body: "Original body",
      actionId: "act_ticket_1",
    });
    await integration.addLabel("ticket_1", "priority/high");
    await integration.assignUser("ticket_1", "user_123");
    await integration.deleteTicket("ticket_1");

    const restored = await integration.restoreTicketFromSnapshot("ticket_1", {
      ticket_id: "ticket_1",
      title: "Restored launch blocker",
      body: "Original body",
      status: "active",
      labels: ["priority/high"],
      assigned_users: ["user_123"],
      action_id: "act_ticket_1",
      remote_url: `${service.baseUrl}tickets/ticket_1`,
      created_at: new Date().toISOString(),
      closed_at: null,
      deleted_at: null,
    });

    expect(restored.record).toMatchObject({
      ticket_id: "ticket_1",
      title: "Restored launch blocker",
      status: "active",
      labels: ["priority/high"],
      assigned_users: ["user_123"],
      deleted_at: null,
    });

    await service.close();
  });

  it("surfaces upstream failure when restore recreation cannot converge to the desired state", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-ticket-"));
    const service = await startTicketService({ failRestoreStatus: 503 });
    const store = new OwnedTicketStore(path.join(tempDir, "state.db"));
    const broker = new SessionCredentialBroker();
    broker.registerBearerProfile({
      integration: "tickets",
      base_url: service.baseUrl,
      token: "test-ticket-token",
      scopes: ["tickets:write"],
    });
    const integration = new OwnedTicketIntegration(store, broker);

    await integration.createTicket({
      ticketId: "ticket_1",
      title: "Launch blocker",
      body: "Original body",
      actionId: "act_ticket_1",
    });
    await integration.deleteTicket("ticket_1");

    await expect(
      integration.restoreTicketFromSnapshot("ticket_1", {
        ticket_id: "ticket_1",
        title: "Restored launch blocker",
        body: "Original body",
        status: "active",
        labels: [],
        assigned_users: [],
        action_id: "act_ticket_1",
        remote_url: `${service.baseUrl}tickets/ticket_1`,
        created_at: new Date().toISOString(),
        closed_at: null,
        deleted_at: null,
      }),
    ).rejects.toMatchObject({
      code: "UPSTREAM_FAILURE",
    });

    await service.close();
  });

  it("reopens a closed ticket idempotently during compensation", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-ticket-"));
    const service = await startTicketService();
    const store = new OwnedTicketStore(path.join(tempDir, "state.db"));
    const broker = new SessionCredentialBroker();
    broker.registerBearerProfile({
      integration: "tickets",
      base_url: service.baseUrl,
      token: "test-ticket-token",
      scopes: ["tickets:write"],
    });
    const integration = new OwnedTicketIntegration(store, broker);

    await integration.createTicket({
      ticketId: "ticket_1",
      title: "Launch blocker",
      body: "Original body",
      actionId: "act_ticket_1",
    });
    await integration.closeTicket("ticket_1");

    const first = await integration.reopenTicket("ticket_1");
    const second = await integration.reopenTicket("ticket_1");

    expect(first.record.status).toBe("active");
    expect(second.record.status).toBe("active");
    expect(await store.getTicket("ticket_1")).toMatchObject({
      status: "active",
      closed_at: null,
    });

    await service.close();
  });

  it("surfaces not found when the upstream ticket disappears before close", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-ticket-"));
    const service = await startTicketService({ failCloseStatus: 404 });
    const store = new OwnedTicketStore(path.join(tempDir, "state.db"));
    const broker = new SessionCredentialBroker();
    broker.registerBearerProfile({
      integration: "tickets",
      base_url: service.baseUrl,
      token: "test-ticket-token",
      scopes: ["tickets:write"],
    });
    const integration = new OwnedTicketIntegration(store, broker);

    await integration.createTicket({
      ticketId: "ticket_1",
      title: "Launch blocker",
      body: "Original body",
      actionId: "act_ticket_1",
    });

    await expect(integration.closeTicket("ticket_1")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    await service.close();
  });

  it("surfaces not found when the upstream ticket disappears before reopen", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-ticket-"));
    const service = await startTicketService({ failReopenStatus: 404 });
    const store = new OwnedTicketStore(path.join(tempDir, "state.db"));
    const broker = new SessionCredentialBroker();
    broker.registerBearerProfile({
      integration: "tickets",
      base_url: service.baseUrl,
      token: "test-ticket-token",
      scopes: ["tickets:write"],
    });
    const integration = new OwnedTicketIntegration(store, broker);

    await integration.createTicket({
      ticketId: "ticket_1",
      title: "Launch blocker",
      body: "Original body",
      actionId: "act_ticket_1",
    });
    await integration.closeTicket("ticket_1");

    await expect(integration.reopenTicket("ticket_1")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    await service.close();
  });

  it("adds labels idempotently and removes them for compensation", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-ticket-"));
    const service = await startTicketService();
    const store = new OwnedTicketStore(path.join(tempDir, "state.db"));
    const broker = new SessionCredentialBroker();
    broker.registerBearerProfile({
      integration: "tickets",
      base_url: service.baseUrl,
      token: "test-ticket-token",
      scopes: ["tickets:write"],
    });
    const integration = new OwnedTicketIntegration(store, broker);

    await integration.createTicket({
      ticketId: "ticket_1",
      title: "Launch blocker",
      body: "Original body",
      actionId: "act_ticket_1",
    });

    const first = await integration.addLabel("ticket_1", "priority/high");
    const second = await integration.addLabel("ticket_1", "priority/high");
    const removed = await integration.removeLabel("ticket_1", "priority/high");
    const removedAgain = await integration.removeLabel("ticket_1", "priority/high");

    expect(first.record.labels).toEqual(["priority/high"]);
    expect(second.record.labels).toEqual(["priority/high"]);
    expect(removed.record?.labels).toEqual([]);
    expect(removedAgain.record?.labels).toEqual([]);

    await service.close();
  });

  it("assigns users idempotently and unassigns them for compensation", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-ticket-"));
    const service = await startTicketService();
    const store = new OwnedTicketStore(path.join(tempDir, "state.db"));
    const broker = new SessionCredentialBroker();
    broker.registerBearerProfile({
      integration: "tickets",
      base_url: service.baseUrl,
      token: "test-ticket-token",
      scopes: ["tickets:write"],
    });
    const integration = new OwnedTicketIntegration(store, broker);

    await integration.createTicket({
      ticketId: "ticket_1",
      title: "Launch blocker",
      body: "Original body",
      actionId: "act_ticket_1",
    });

    const first = await integration.assignUser("ticket_1", "user_123");
    const second = await integration.assignUser("ticket_1", "user_123");
    const removed = await integration.unassignUser("ticket_1", "user_123");
    const removedAgain = await integration.unassignUser("ticket_1", "user_123");

    expect(first.record.assigned_users).toEqual(["user_123"]);
    expect(second.record.assigned_users).toEqual(["user_123"]);
    expect(removed.record?.assigned_users).toEqual([]);
    expect(removedAgain.record?.assigned_users).toEqual([]);

    await service.close();
  });
});

describe("OwnedTicketStore", () => {
  it("rejects malformed persisted ticket records", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-ticket-store-"));
    const dbPath = path.join(tempDir, "state.db");
    const looseState = createLooseTicketState(dbPath);
    looseState.put("tickets", "ticket_1", {
      ticket_id: "ticket_1",
      title: "Launch blocker",
      body: "Missing remote URL",
      status: "active",
      action_id: "act_ticket_1",
      created_at: new Date().toISOString(),
      closed_at: null,
      deleted_at: null,
    });
    looseState.close();

    const store = new OwnedTicketStore(dbPath);
    await expect(store.getTicket("ticket_1")).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
  });
});

describe("OwnedNoteStore", () => {
  it("treats duplicate create requests for the same action as idempotent", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-notes-"));
    const store = new OwnedNoteStore(path.join(tempDir, "state.db"));

    const first = await store.createNote({
      noteId: "note_1",
      title: "Launch notes",
      body: "Ship the second integration.",
      actionId: "act_same",
    });
    const second = await store.createNote({
      noteId: "note_1",
      title: "Launch notes",
      body: "Ship the second integration.",
      actionId: "act_same",
    });

    expect(second).toEqual(first);
    expect(await store.getNote("note_1")).toEqual(first);
  });

  it("archives notes idempotently for compensation", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-notes-"));
    const store = new OwnedNoteStore(path.join(tempDir, "state.db"));

    await store.createNote({
      noteId: "note_1",
      title: "Launch notes",
      body: "Ship the second integration.",
      actionId: "act_same",
    });

    const first = await store.archiveNote("note_1");
    const second = await store.archiveNote("note_1");

    expect(first?.status).toBe("archived");
    expect(second?.status).toBe("archived");
  });

  it("unarchives notes idempotently for compensation", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-notes-"));
    const store = new OwnedNoteStore(path.join(tempDir, "state.db"));

    await store.createNote({
      noteId: "note_1",
      title: "Launch notes",
      body: "Ship the second integration.",
      actionId: "act_same",
    });
    await store.archiveNote("note_1");

    const first = await store.unarchiveNote("note_1");
    const second = await store.unarchiveNote("note_1");

    expect(first?.status).toBe("active");
    expect(second?.status).toBe("active");
  });

  it("deletes notes idempotently for compensation", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-notes-"));
    const store = new OwnedNoteStore(path.join(tempDir, "state.db"));

    await store.createNote({
      noteId: "note_1",
      title: "Launch notes",
      body: "Ship the second integration.",
      actionId: "act_same",
    });

    const first = await store.deleteNote("note_1");
    const second = await store.deleteNote("note_1");

    expect(first?.status).toBe("deleted");
    expect(second?.status).toBe("deleted");
  });

  it("updates notes while preserving identity metadata", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-notes-"));
    const store = new OwnedNoteStore(path.join(tempDir, "state.db"));

    const created = await store.createNote({
      noteId: "note_1",
      title: "Launch notes",
      body: "Ship the second integration.",
      actionId: "act_same",
    });
    const updated = await store.updateNote("note_1", {
      title: "Updated launch notes",
      body: "Refine the second integration.",
    });

    expect(updated).toMatchObject({
      note_id: "note_1",
      title: "Updated launch notes",
      body: "Refine the second integration.",
      action_id: created.action_id,
      created_at: created.created_at,
      status: "active",
    });
  });

  it("rejects updates to archived notes with conflict", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-notes-"));
    const store = new OwnedNoteStore(path.join(tempDir, "state.db"));

    await store.createNote({
      noteId: "note_1",
      title: "Launch notes",
      body: "Ship the second integration.",
      actionId: "act_same",
    });
    await store.archiveNote("note_1");

    await expect(
      store.updateNote("note_1", {
        title: "Updated launch notes",
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("restores notes from persisted preimage snapshots", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-notes-"));
    const store = new OwnedNoteStore(path.join(tempDir, "state.db"));

    const created = await store.createNote({
      noteId: "note_1",
      title: "Launch notes",
      body: "Ship the second integration.",
      actionId: "act_same",
    });
    await store.restoreNoteFromSnapshot("note_1", {
      note_id: "note_1",
      title: "Restored launch notes",
      body: "Return the original note.",
      status: "archived",
      action_id: created.action_id,
      created_at: created.created_at,
      archived_at: "2026-03-29T12:00:02.000Z",
      deleted_at: null,
    });

    expect(await store.getNote("note_1")).toMatchObject({
      title: "Restored launch notes",
      body: "Return the original note.",
      status: "archived",
      action_id: created.action_id,
    });
  });

  it("rejects malformed stored note records with a storage error", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-notes-"));
    const storePath = path.join(tempDir, "state.db");
    const looseState = createLooseNoteState(storePath);
    looseState.put("notes", "note_1", {
      note_id: "note_1",
      title: "Broken note",
      body: "missing metadata",
      status: "active",
    });
    looseState.close();
    const store = new OwnedNoteStore(storePath);

    await expect(store.getNote("note_1")).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
  });

  it("executes a governed MCP stdio tool call and captures request/response evidence", async () => {
    const server = makeGovernedTestStdioServer("stderr_noise");
    if (!server) {
      return;
    }
    const adapter = new McpExecutionAdapter([
      {
        ...server,
        display_name: "Notes server",
      },
    ]);
    const action = makeMcpAction();
    const policyOutcome = makeMcpPolicyOutcome(action);

    await adapter.verifyPreconditions({
      action,
      policy_outcome: policyOutcome,
      workspace_root: process.cwd(),
    });
    const result = await adapter.execute({
      action,
      policy_outcome: policyOutcome,
      workspace_root: process.cwd(),
    });

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      domain: "mcp",
      server_id: "notes_server",
      tool_name: "echo_note",
      is_error: false,
      summary: "echo:launch blocker",
    });
    expect(result.artifacts.map((artifact) => artifact.type)).toContain("request_response");
    expect(result.artifacts.map((artifact) => artifact.type)).toContain("stderr");
  }, 20_000);

  it("sandboxes a governed stdio MCP server against file and network escape attempts with OCI isolation", async () => {
    if (!TEST_OCI_SANDBOX) {
      return;
    }

    const workspaceRoot = tempDirs.make();
    const forbiddenRoot = path.join(os.homedir(), `.agentgit-sandbox-test-${process.pid}-${Date.now()}`);
    const forbiddenReadPath = path.join(forbiddenRoot, "secret.txt");
    const forbiddenWritePath = path.join(forbiddenRoot, "written.txt");
    fs.mkdirSync(forbiddenRoot, { recursive: true });
    fs.writeFileSync(forbiddenReadPath, "launch-secrets", "utf8");

    let networkCallCount = 0;
    const networkServer = http.createServer((req, res) => {
      networkCallCount += 1;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("reachable");
    });
    await new Promise<void>((resolve, reject) => {
      networkServer.listen(0, "127.0.0.1", () => resolve());
      networkServer.once("error", reject);
    });

    const address = networkServer.address();
    if (!address || typeof address === "string") {
      throw new Error("sandbox network server did not bind to a TCP address");
    }

    try {
      const adapter = new McpExecutionAdapter([
        {
          server_id: "notes_server_sandboxed",
          transport: "stdio",
          command: "node",
          args: ["/agentgit-test/mcp-test-server.mjs"],
          sandbox: {
            type: "oci_container",
            runtime: TEST_OCI_SANDBOX.runtime,
            image: TEST_OCI_BUILD_IMAGE,
            build: {
              context_path: ociTestImageRoot,
              dockerfile_path: path.join(ociTestImageRoot, "Dockerfile"),
              rebuild_policy: "if_missing",
            },
            workspace_mount_path: "/workspace",
            workdir: "/workspace",
            workspace_access: "read_only",
            additional_mounts: [
              {
                host_path: path.dirname(mcpTestServerScript),
                container_path: "/agentgit-test",
                read_only: true,
              },
            ],
          },
          env: {
            AGENTGIT_TEST_MCP_SCENARIO: "sandbox_probe",
            AGENTGIT_SANDBOX_READ_PATH: forbiddenReadPath,
            AGENTGIT_SANDBOX_WRITE_PATH: forbiddenWritePath,
            AGENTGIT_SANDBOX_NETWORK_URL: `http://127.0.0.1:${address.port}/probe`,
          },
          tools: [
            {
              tool_name: "echo_note",
              side_effect_level: "read_only",
              approval_mode: "allow",
            },
          ],
        },
      ]);

      const action = makeMcpAction({
        facets: {
          mcp: {
            server_id: "notes_server_sandboxed",
            tool_name: "echo_note",
          },
        },
      });
      const result = await adapter.execute({
        action,
        policy_outcome: makeMcpPolicyOutcome(action),
        workspace_root: workspaceRoot,
      });

      expect(result.success).toBe(true);
      expect(result.output.structured_content).toMatchObject({
        read_success: false,
        write_success: false,
        network_success: false,
      });
      expect(fs.existsSync(forbiddenWritePath)).toBe(false);
      expect(networkCallCount).toBe(0);
    } finally {
      await closeTicketServer(networkServer);
      fs.rmSync(forbiddenRoot, { recursive: true, force: true });
    }
  }, 20_000);

  it("sandboxes a governed stdio MCP server inside an OCI container on Linux", async () => {
    if (process.platform !== "linux" || !TEST_OCI_SANDBOX) {
      return;
    }

    const workspaceRoot = process.cwd();
    const forbiddenRoot = path.join(os.tmpdir(), `agentgit-linux-sandbox-test-${process.pid}-${Date.now()}`);
    const forbiddenReadPath = path.join(forbiddenRoot, "secret.txt");
    const forbiddenWritePath = path.join(forbiddenRoot, "written.txt");
    fs.mkdirSync(forbiddenRoot, { recursive: true });
    fs.writeFileSync(forbiddenReadPath, "launch-secrets", "utf8");

    let networkCallCount = 0;
    const networkServer = http.createServer((req, res) => {
      networkCallCount += 1;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("reachable");
    });
    await new Promise<void>((resolve, reject) => {
      networkServer.listen(0, "127.0.0.1", () => resolve());
      networkServer.once("error", reject);
    });

    const address = networkServer.address();
    if (!address || typeof address === "string") {
      throw new Error("sandbox network server did not bind to a TCP address");
    }

    try {
      const adapter = new McpExecutionAdapter([
        {
          server_id: "notes_server_oci_sandboxed",
          transport: "stdio",
          command: "node",
          args: ["packages/execution-adapters/src/mcp-test-server.mjs"],
          sandbox: {
            type: "oci_container",
            runtime: TEST_OCI_SANDBOX.runtime,
            image: TEST_OCI_BUILD_IMAGE,
            build: {
              context_path: ociTestImageRoot,
              dockerfile_path: path.join(ociTestImageRoot, "Dockerfile"),
              rebuild_policy: "if_missing",
            },
            workspace_access: "read_only",
            network: "none",
          },
          env: {
            AGENTGIT_TEST_MCP_SCENARIO: "sandbox_probe",
            AGENTGIT_SANDBOX_READ_PATH: forbiddenReadPath,
            AGENTGIT_SANDBOX_WRITE_PATH: forbiddenWritePath,
            AGENTGIT_SANDBOX_NETWORK_URL: `http://127.0.0.1:${address.port}/probe`,
          },
          tools: [
            {
              tool_name: "echo_note",
              side_effect_level: "read_only",
              approval_mode: "allow",
            },
          ],
        },
      ]);

      const action = makeMcpAction({
        facets: {
          mcp: {
            server_id: "notes_server_oci_sandboxed",
            tool_name: "echo_note",
          },
        },
      });
      const result = await adapter.execute({
        action,
        policy_outcome: makeMcpPolicyOutcome(action),
        workspace_root: workspaceRoot,
      });

      expect(result.success).toBe(true);
      expect(result.output.structured_content).toMatchObject({
        read_success: false,
        write_success: false,
        network_success: false,
      });
      expect((result.output.structured_content as { uid?: number | null }).uid).not.toBe(0);
      expect(fs.existsSync(forbiddenWritePath)).toBe(false);
      expect(networkCallCount).toBe(0);
    } finally {
      await closeTicketServer(networkServer);
      fs.rmSync(forbiddenRoot, { recursive: true, force: true });
    }
  });

  it("executes a governed MCP streamable_http tool call with operator-owned bearer auth", async () => {
    const service = await startMcpHttpService({
      requireBearerToken: "http-secret-token",
    });
    process.env.AGENTGIT_TEST_MCP_HTTP_TOKEN = "http-secret-token";

    try {
      const adapter = new McpExecutionAdapter([
        {
          server_id: "notes_http",
          display_name: "Notes HTTP server",
          transport: "streamable_http",
          url: service.url,
          network_scope: "private",
          max_concurrent_calls: 2,
          auth: {
            type: "bearer_env",
            bearer_env_var: "AGENTGIT_TEST_MCP_HTTP_TOKEN",
          },
          headers: {
            "x-agentgit-origin": "test",
          },
          tools: [
            {
              tool_name: "echo_note",
              side_effect_level: "read_only",
              approval_mode: "allow",
            },
          ],
        },
      ]);
      const action = makeMcpAction({
        facets: {
          mcp: {
            server_id: "notes_http",
            tool_name: "echo_note",
          },
        },
      });
      const policyOutcome = makeMcpPolicyOutcome(action);

      await adapter.verifyPreconditions({
        action,
        policy_outcome: policyOutcome,
        workspace_root: process.cwd(),
      });
      const result = await adapter.execute({
        action,
        policy_outcome: policyOutcome,
        workspace_root: process.cwd(),
      });

      expect(result.success).toBe(true);
      expect(result.output).toMatchObject({
        domain: "mcp",
        server_id: "notes_http",
        tool_name: "echo_note",
        transport: "streamable_http",
        network_scope: "private",
        max_concurrent_calls: 2,
        is_error: false,
        summary: "http-echo:launch blocker",
      });
      expect(result.artifacts.map((artifact) => artifact.type)).toContain("request_response");
    } finally {
      delete process.env.AGENTGIT_TEST_MCP_HTTP_TOKEN;
      await service.close();
    }
  });

  it("executes a governed MCP streamable_http tool call with a durable bearer secret reference", async () => {
    const service = await startMcpHttpService({
      requireBearerToken: "http-secret-ref-token",
    });
    const secretsRoot = tempDirs.make();
    const secretStore = trackStore(
      new LocalEncryptedSecretStore({
        dbPath: path.join(secretsRoot, "mcp-secrets.db"),
        keyPath: path.join(secretsRoot, "mcp-secrets.key"),
      }),
    );
    const broker = new SessionCredentialBroker({
      mcpSecretStore: secretStore,
    });
    broker.upsertMcpBearerSecret({
      secret_id: "mcp_secret_notes_http",
      display_name: "Notes HTTP MCP",
      bearer_token: "http-secret-ref-token",
    });

    try {
      const adapter = new McpExecutionAdapter(
        [
          {
            server_id: "notes_http_secret_ref",
            display_name: "Notes HTTP server",
            transport: "streamable_http",
            url: service.url,
            network_scope: "private",
            auth: {
              type: "bearer_secret_ref",
              secret_id: "mcp_secret_notes_http",
            },
            tools: [
              {
                tool_name: "echo_note",
                side_effect_level: "read_only",
                approval_mode: "allow",
              },
            ],
          },
        ],
        {
          credentialBroker: broker,
        },
      );
      const action = makeMcpAction({
        facets: {
          mcp: {
            server_id: "notes_http_secret_ref",
            tool_name: "echo_note",
          },
        },
      });
      const policyOutcome = makeMcpPolicyOutcome(action);

      await adapter.verifyPreconditions({
        action,
        policy_outcome: policyOutcome,
        workspace_root: process.cwd(),
      });
      const result = await adapter.execute({
        action,
        policy_outcome: policyOutcome,
        workspace_root: process.cwd(),
      });

      expect(result.success).toBe(true);
      expect(result.output).toMatchObject({
        domain: "mcp",
        server_id: "notes_http_secret_ref",
        tool_name: "echo_note",
        transport: "streamable_http",
        auth_type: "bearer_secret_ref",
        network_scope: "private",
        is_error: false,
        summary: "http-echo:launch blocker",
      });
      expect(broker.listMcpBearerSecrets()).toEqual([
        expect.objectContaining({
          secret_id: "mcp_secret_notes_http",
          last_used_at: expect.any(String),
        }),
      ]);
    } finally {
      await service.close();
    }
  });

  it("fails closed when a durable MCP secret has expired", async () => {
    const service = await startMcpHttpService({
      requireBearerToken: "http-secret-ref-token",
    });
    const secretsRoot = tempDirs.make();
    const secretStore = trackStore(
      new LocalEncryptedSecretStore({
        dbPath: path.join(secretsRoot, "mcp-secrets.db"),
        keyPath: path.join(secretsRoot, "mcp-secrets.key"),
      }),
    );
    const broker = new SessionCredentialBroker({
      mcpSecretStore: secretStore,
    });
    broker.upsertMcpBearerSecret({
      secret_id: "mcp_secret_expired",
      display_name: "Expired Notes HTTP MCP",
      bearer_token: "http-secret-ref-token",
      expires_at: "2000-01-01T00:00:00.000Z",
    });

    try {
      const adapter = new McpExecutionAdapter(
        [
          {
            server_id: "notes_http_expired_secret",
            transport: "streamable_http",
            url: service.url,
            network_scope: "private",
            auth: {
              type: "bearer_secret_ref",
              secret_id: "mcp_secret_expired",
            },
            tools: [
              {
                tool_name: "echo_note",
                side_effect_level: "read_only",
                approval_mode: "allow",
              },
            ],
          },
        ],
        {
          credentialBroker: broker,
        },
      );
      const action = makeMcpAction({
        facets: {
          mcp: {
            server_id: "notes_http_expired_secret",
            tool_name: "echo_note",
          },
        },
      });

      await expect(
        adapter.verifyPreconditions({
          action,
          policy_outcome: makeMcpPolicyOutcome(action),
          workspace_root: process.cwd(),
        }),
      ).rejects.toMatchObject({
        code: "BROKER_UNAVAILABLE",
      });
    } finally {
      await service.close();
    }
  }, 20_000);

  it("fails closed when the upstream MCP server does not advertise the requested tool", async () => {
    const server = makeGovernedTestStdioServer("missing_tool");
    if (!server) {
      return;
    }
    const adapter = new McpExecutionAdapter([server]);
    const action = makeMcpAction();

    await expect(
      adapter.execute({
        action,
        policy_outcome: makeMcpPolicyOutcome(action),
        workspace_root: process.cwd(),
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
    });
  }, 20_000);

  it("returns an honest unsuccessful execution result when the MCP tool responds with isError", async () => {
    const server = makeGovernedTestStdioServer("call_error");
    if (!server) {
      return;
    }
    const adapter = new McpExecutionAdapter([server]);
    const action = makeMcpAction();
    const result = await adapter.execute({
      action,
      policy_outcome: makeMcpPolicyOutcome(action),
      workspace_root: process.cwd(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      code: "MCP_TOOL_ERROR",
    });
    expect(result.output).toMatchObject({
      is_error: true,
      summary: "upstream-error:launch blocker",
    });
  }, 20_000);

  it("rejects unsafe MCP auto-approval configuration for mutating tools", () => {
    expect(() =>
      validateMcpServerDefinitions([
        {
          server_id: "notes_server",
          transport: "stdio",
          command: process.execPath,
          tools: [
            {
              tool_name: "delete_remote",
              side_effect_level: "destructive",
              approval_mode: "allow",
            },
          ],
        },
      ]),
    ).toThrow("Only explicitly read-only MCP tools can be auto-approved in the governed runtime.");
  });

  it("rejects governed stdio MCP servers that omit an explicit OCI sandbox configuration", async () => {
    expect(
      () =>
        new McpExecutionAdapter([
          {
            server_id: "notes_server",
            transport: "stdio",
            command: process.execPath,
            args: [mcpTestServerScript],
            env: {
              AGENTGIT_TEST_MCP_SCENARIO: "stderr_noise",
            },
            tools: [
              {
                tool_name: "echo_note",
                side_effect_level: "read_only",
                approval_mode: "allow",
              },
            ],
          },
        ]),
    ).toThrow("requires an explicit oci_container sandbox configuration");
  });

  it("fails closed before execution when a streamable_http MCP bearer env var is missing", async () => {
    delete process.env.AGENTGIT_TEST_MCP_HTTP_TOKEN;
    const adapter = new McpExecutionAdapter([
      {
        server_id: "notes_http",
        transport: "streamable_http",
        url: "http://127.0.0.1:3010/mcp",
        auth: {
          type: "bearer_env",
          bearer_env_var: "AGENTGIT_TEST_MCP_HTTP_TOKEN",
        },
        tools: [
          {
            tool_name: "echo_note",
            side_effect_level: "read_only",
            approval_mode: "allow",
          },
        ],
      },
    ]);
    const action = makeMcpAction({
      facets: {
        mcp: {
          server_id: "notes_http",
          tool_name: "echo_note",
        },
      },
    });

    await expect(
      adapter.verifyPreconditions({
        action,
        policy_outcome: makeMcpPolicyOutcome(action),
        workspace_root: process.cwd(),
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it("accepts explicitly private-network streamable_http targets with concurrency settings", () => {
    expect(
      validateMcpServerDefinitions([
        {
          server_id: "notes_private_http",
          transport: "streamable_http",
          url: "http://10.24.3.11:3010/mcp",
          network_scope: "private",
          max_concurrent_calls: 3,
          tools: [
            {
              tool_name: "echo_note",
              side_effect_level: "read_only",
              approval_mode: "allow",
            },
          ],
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        server_id: "notes_private_http",
        transport: "streamable_http",
        url: "http://10.24.3.11:3010/mcp",
        network_scope: "private",
        max_concurrent_calls: 3,
      }),
    ]);
  });

  it("accepts explicitly public HTTPS streamable_http targets with bearer auth", () => {
    expect(
      validateMcpServerDefinitions([
        {
          server_id: "notes_public_http",
          transport: "streamable_http",
          url: "https://api.example.com/mcp",
          network_scope: "public_https",
          auth: {
            type: "bearer_env",
            bearer_env_var: "AGENTGIT_PUBLIC_MCP_TOKEN",
          },
          max_concurrent_calls: 2,
          tools: [
            {
              tool_name: "echo_note",
              side_effect_level: "read_only",
              approval_mode: "allow",
            },
          ],
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        server_id: "notes_public_http",
        transport: "streamable_http",
        url: "https://api.example.com/mcp",
        network_scope: "public_https",
        max_concurrent_calls: 2,
      }),
    ]);
  });

  it("rejects public HTTPS streamable_http targets without operator bearer auth", () => {
    expect(() =>
      validateMcpServerDefinitions([
        {
          server_id: "notes_public_http_no_auth",
          transport: "streamable_http",
          url: "https://api.example.com/mcp",
          network_scope: "public_https",
          tools: [
            {
              tool_name: "echo_note",
              side_effect_level: "read_only",
              approval_mode: "allow",
            },
          ],
        },
      ]),
    ).toThrow(
      "requires operator-managed bearer authentication backed by a secret reference or legacy env configuration",
    );
  });

  it("fails closed when a streamable_http redirect crosses into a disallowed network scope", async () => {
    const service = await startMcpHttpService({
      scenario: "redirect",
      redirectLocation: "http://192.168.0.10/mcp",
    });

    try {
      const adapter = new McpExecutionAdapter([
        {
          server_id: "notes_http_redirect",
          transport: "streamable_http",
          url: service.url,
          network_scope: "loopback",
          tools: [
            {
              tool_name: "echo_note",
              side_effect_level: "read_only",
              approval_mode: "allow",
            },
          ],
        },
      ]);
      const action = makeMcpAction({
        facets: {
          mcp: {
            server_id: "notes_http_redirect",
            tool_name: "echo_note",
          },
        },
      });

      await expect(
        adapter.execute({
          action,
          policy_outcome: makeMcpPolicyOutcome(action),
          workspace_root: process.cwd(),
        }),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });
    } finally {
      await service.close();
    }
  });

  it("fails closed when a public_https hostname resolves to loopback at execution time", async () => {
    process.env.AGENTGIT_TEST_PUBLIC_REBIND_TOKEN = "rebinding-token";
    const policyRoot = tempDirs.make();
    const policyRegistry = new McpPublicHostPolicyRegistry({
      dbPath: path.join(policyRoot, "mcp-host-policies.db"),
    });
    policyRegistry.upsertPolicy({
      host: "rebind.example.test",
      display_name: "Rebinding test host",
    });

    try {
      const adapter = new McpExecutionAdapter(
        [
          {
            server_id: "notes_public_rebind",
            transport: "streamable_http",
            url: "https://rebind.example.test/mcp",
            network_scope: "public_https",
            auth: {
              type: "bearer_env",
              bearer_env_var: "AGENTGIT_TEST_PUBLIC_REBIND_TOKEN",
            },
            tools: [
              {
                tool_name: "echo_note",
                side_effect_level: "read_only",
                approval_mode: "allow",
              },
            ],
          },
        ],
        {
          publicHostPolicyRegistry: policyRegistry,
          hostnameResolver: async () => [{ address: "127.0.0.1", family: 4 }],
        },
      );
      const action = makeMcpAction({
        facets: {
          mcp: {
            server_id: "notes_public_rebind",
            tool_name: "echo_note",
          },
        },
      });

      await expect(
        adapter.execute({
          action,
          policy_outcome: makeMcpPolicyOutcome(action),
          workspace_root: process.cwd(),
        }),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });
    } finally {
      delete process.env.AGENTGIT_TEST_PUBLIC_REBIND_TOKEN;
      policyRegistry.close();
    }
  });

  it("fails closed when streamable_http MCP concurrency would exceed the configured limit", async () => {
    const service = await startMcpHttpService({
      toolDelayMs: 200,
    });

    try {
      const adapter = new McpExecutionAdapter([
        {
          server_id: "notes_http",
          transport: "streamable_http",
          url: service.url,
          max_concurrent_calls: 1,
          tools: [
            {
              tool_name: "echo_note",
              side_effect_level: "read_only",
              approval_mode: "allow",
            },
          ],
        },
      ]);

      const firstAction = makeMcpAction({
        action_id: "act_mcp_concurrent_1",
        facets: {
          mcp: {
            server_id: "notes_http",
            tool_name: "echo_note",
          },
        },
        input: {
          raw: {
            server_id: "notes_http",
            tool_name: "echo_note",
            arguments: {
              note: "launch blocker",
            },
          },
          redacted: {
            server_id: "notes_http",
            tool_name: "echo_note",
            arguments: {
              note: "launch blocker",
            },
          },
          schema_ref: null,
          contains_sensitive_data: false,
        },
      });
      const secondAction = makeMcpAction({
        action_id: "act_mcp_concurrent_2",
        facets: {
          mcp: {
            server_id: "notes_http",
            tool_name: "echo_note",
          },
        },
        input: {
          raw: {
            server_id: "notes_http",
            tool_name: "echo_note",
            arguments: {
              note: "launch blocker",
            },
          },
          redacted: {
            server_id: "notes_http",
            tool_name: "echo_note",
            arguments: {
              note: "launch blocker",
            },
          },
          schema_ref: null,
          contains_sensitive_data: false,
        },
      });
      const firstExecution = adapter.execute({
        action: firstAction,
        policy_outcome: makeMcpPolicyOutcome(firstAction),
        workspace_root: process.cwd(),
      });

      await service.waitForCallCount(1);

      await expect(
        adapter.execute({
          action: secondAction,
          policy_outcome: makeMcpPolicyOutcome(secondAction),
          workspace_root: process.cwd(),
        }),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        retryable: true,
      });

      await expect(firstExecution).resolves.toMatchObject({
        success: true,
      });
    } finally {
      await service.close();
    }
  });

  it("enforces streamable_http MCP concurrency across adapter instances with a shared SQLite lease store", async () => {
    const service = await startMcpHttpService({
      toolDelayMs: 200,
    });
    const leaseRoot = tempDirs.make();
    const leaseDbPath = path.join(leaseRoot, "mcp-concurrency.db");

    try {
      const adapterOne = new McpExecutionAdapter(
        [
          {
            server_id: "notes_http_shared_limit",
            transport: "streamable_http",
            url: service.url,
            max_concurrent_calls: 1,
            tools: [
              {
                tool_name: "echo_note",
                side_effect_level: "read_only",
                approval_mode: "allow",
              },
            ],
          },
        ],
        {
          concurrencyLeaseDbPath: leaseDbPath,
        },
      );
      const adapterTwo = new McpExecutionAdapter(
        [
          {
            server_id: "notes_http_shared_limit",
            transport: "streamable_http",
            url: service.url,
            max_concurrent_calls: 1,
            tools: [
              {
                tool_name: "echo_note",
                side_effect_level: "read_only",
                approval_mode: "allow",
              },
            ],
          },
        ],
        {
          concurrencyLeaseDbPath: leaseDbPath,
        },
      );

      const firstAction = makeMcpAction({
        action_id: "act_mcp_concurrent_shared_1",
        facets: {
          mcp: {
            server_id: "notes_http_shared_limit",
            tool_name: "echo_note",
          },
        },
      });
      const secondAction = makeMcpAction({
        action_id: "act_mcp_concurrent_shared_2",
        facets: {
          mcp: {
            server_id: "notes_http_shared_limit",
            tool_name: "echo_note",
          },
        },
      });

      const firstExecution = adapterOne.execute({
        action: firstAction,
        policy_outcome: makeMcpPolicyOutcome(firstAction),
        workspace_root: process.cwd(),
      });
      await service.waitForCallCount(1);

      await expect(
        adapterTwo.execute({
          action: secondAction,
          policy_outcome: makeMcpPolicyOutcome(secondAction),
          workspace_root: process.cwd(),
        }),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        retryable: true,
      });

      await expect(firstExecution).resolves.toMatchObject({
        success: true,
      });
    } finally {
      await service.close();
    }
  });

  it("renews shared SQLite concurrency leases during long-running streamable_http calls", async () => {
    const service = await startMcpHttpService({
      toolDelayMs: 350,
    });
    const leaseRoot = tempDirs.make();
    const leaseDbPath = path.join(leaseRoot, "mcp-concurrency-heartbeat.db");

    try {
      const adapterOne = new McpExecutionAdapter(
        [
          {
            server_id: "notes_http_shared_heartbeat",
            transport: "streamable_http",
            url: service.url,
            timeout_ms: 2_000,
            max_concurrent_calls: 1,
            tools: [
              {
                tool_name: "echo_note",
                side_effect_level: "read_only",
                approval_mode: "allow",
              },
            ],
          },
        ],
        {
          concurrencyLeaseDbPath: leaseDbPath,
          concurrencyLeaseTtlMs: 150,
          concurrencyLeaseHeartbeatMs: 50,
        },
      );
      const adapterTwo = new McpExecutionAdapter(
        [
          {
            server_id: "notes_http_shared_heartbeat",
            transport: "streamable_http",
            url: service.url,
            timeout_ms: 2_000,
            max_concurrent_calls: 1,
            tools: [
              {
                tool_name: "echo_note",
                side_effect_level: "read_only",
                approval_mode: "allow",
              },
            ],
          },
        ],
        {
          concurrencyLeaseDbPath: leaseDbPath,
          concurrencyLeaseTtlMs: 150,
          concurrencyLeaseHeartbeatMs: 50,
        },
      );

      const firstAction = makeMcpAction({
        action_id: "act_mcp_concurrent_heartbeat_1",
        facets: {
          mcp: {
            server_id: "notes_http_shared_heartbeat",
            tool_name: "echo_note",
          },
        },
      });
      const secondAction = makeMcpAction({
        action_id: "act_mcp_concurrent_heartbeat_2",
        facets: {
          mcp: {
            server_id: "notes_http_shared_heartbeat",
            tool_name: "echo_note",
          },
        },
      });

      const firstExecution = adapterOne.execute({
        action: firstAction,
        policy_outcome: makeMcpPolicyOutcome(firstAction),
        workspace_root: process.cwd(),
      });
      await service.waitForCallCount(1);
      await new Promise((resolve) => setTimeout(resolve, 225));

      await expect(
        adapterTwo.execute({
          action: secondAction,
          policy_outcome: makeMcpPolicyOutcome(secondAction),
          workspace_root: process.cwd(),
        }),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        retryable: true,
      });

      await expect(firstExecution).resolves.toMatchObject({
        success: true,
      });
    } finally {
      await service.close();
    }
  });
});
