import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import { OwnedDraftStore, OwnedNoteStore, OwnedTicketStore } from "@agentgit/execution-adapters";
import { startHostedMcpWorkerServer } from "../../hosted-mcp-worker/src/index.ts";
import { IntegrationState } from "@agentgit/integration-state";
import { McpPublicHostPolicyRegistry, McpServerRegistry } from "@agentgit/mcp-registry";
import {
  AgentGitError,
  API_VERSION,
  isResponseEnvelope,
  type ActionRecord,
  type ResponseEnvelope,
} from "@agentgit/schemas";
import { RunJournal, createRunJournal } from "@agentgit/run-journal";
import { LocalSnapshotEngine } from "@agentgit/snapshot-engine";

import { startServer } from "./server.js";

interface TestHarness {
  tempRoot: string;
  workspaceRoot: string;
  socketPath: string;
  journalPath: string;
  snapshotRootPath: string;
  artifactRetentionMs: number | null;
  capabilityRefreshStaleMs: number | null;
  startServerOptions: Partial<Parameters<typeof startServer>[0]>;
  server: net.Server;
}

interface ClosableStore {
  close(): void;
}

let requestSequence = 0;
let harnessSequence = 0;
const harnesses: TestHarness[] = [];
const storeClosers: ClosableStore[] = [];
const TEST_TMP_ROOT = path.join("/tmp", `agd-${process.pid}`);
const ticketServers = new Set<http.Server>();
const ORIGINAL_TICKETS_BASE_URL = process.env.AGENTGIT_TICKETS_BASE_URL;
const ORIGINAL_TICKETS_BEARER_TOKEN = process.env.AGENTGIT_TICKETS_BEARER_TOKEN;
const ORIGINAL_SQLITE_JOURNAL_MODE = process.env.AGENTGIT_SQLITE_JOURNAL_MODE;
const ORIGINAL_MCP_SERVERS_JSON = process.env.AGENTGIT_MCP_SERVERS_JSON;
const MCP_TEST_SERVER_SCRIPT = decodeURIComponent(
  new URL("../../execution-adapters/src/mcp-test-server.mjs", import.meta.url).pathname,
);
const FALLBACK_TEST_PINNED_OCI_IMAGE =
  "docker.io/library/node@sha256:1111111111111111111111111111111111111111111111111111111111111111";

function detectOciSandbox(): { runtime: "docker" | "podman"; image: string } | null {
  for (const runtime of ["docker", "podman"] as const) {
    const infoResult = spawnSync(runtime, ["info"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (infoResult.status !== 0 || infoResult.error) {
      continue;
    }

    const inspectResult = spawnSync(runtime, ["image", "inspect", "node:22-bookworm-slim"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (inspectResult.status !== 0 || inspectResult.error) {
      continue;
    }

    try {
      const parsed = JSON.parse(inspectResult.stdout) as Array<{ RepoDigests?: string[] }>;
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

  return null;
}

const TEST_OCI_SANDBOX = detectOciSandbox();

function buildSandboxedStdioServer(serverId: string): Record<string, unknown> {
  return {
    server_id: serverId,
    transport: "stdio",
    command: "node",
    args: ["/agentgit-test/mcp-test-server.mjs"],
    sandbox: {
      type: "oci_container",
      ...(TEST_OCI_SANDBOX ? { runtime: TEST_OCI_SANDBOX.runtime } : {}),
      image: TEST_OCI_SANDBOX?.image ?? FALLBACK_TEST_PINNED_OCI_IMAGE,
      allowed_registries: ["docker.io"],
      signature_verification: {
        mode: "cosign_keyless",
        certificate_identity: "https://github.com/agentgit/agentgit/.github/workflows/release.yml@refs/heads/main",
        certificate_oidc_issuer: "https://token.actions.githubusercontent.com",
      },
      workspace_mount_path: "/workspace",
      workdir: "/workspace",
      additional_mounts: [
        {
          host_path: path.dirname(MCP_TEST_SERVER_SCRIPT),
          container_path: "/agentgit-test",
          read_only: true,
        },
      ],
    },
  };
}

process.env.AGENTGIT_SQLITE_JOURNAL_MODE = "DELETE";

function restoreTicketEnv(): void {
  if (ORIGINAL_TICKETS_BASE_URL === undefined) {
    delete process.env.AGENTGIT_TICKETS_BASE_URL;
  } else {
    process.env.AGENTGIT_TICKETS_BASE_URL = ORIGINAL_TICKETS_BASE_URL;
  }

  if (ORIGINAL_TICKETS_BEARER_TOKEN === undefined) {
    delete process.env.AGENTGIT_TICKETS_BEARER_TOKEN;
  } else {
    process.env.AGENTGIT_TICKETS_BEARER_TOKEN = ORIGINAL_TICKETS_BEARER_TOKEN;
  }
}

function restoreSqliteJournalMode(): void {
  if (ORIGINAL_SQLITE_JOURNAL_MODE === undefined) {
    process.env.AGENTGIT_SQLITE_JOURNAL_MODE = "DELETE";
    return;
  }

  process.env.AGENTGIT_SQLITE_JOURNAL_MODE = ORIGINAL_SQLITE_JOURNAL_MODE;
}

function restoreMcpEnv(): void {
  if (ORIGINAL_MCP_SERVERS_JSON === undefined) {
    delete process.env.AGENTGIT_MCP_SERVERS_JSON;
    return;
  }

  process.env.AGENTGIT_MCP_SERVERS_JSON = ORIGINAL_MCP_SERVERS_JSON;
}

function nextRequestId(): string {
  requestSequence += 1;
  return `req_test_${requestSequence}`;
}

async function createHarness(
  existingRoot?: string,
  artifactRetentionMs: number | null = null,
  capabilityRefreshStaleMs: number | null = null,
  startServerOptions: Partial<Parameters<typeof startServer>[0]> = {},
): Promise<TestHarness> {
  fs.mkdirSync(TEST_TMP_ROOT, { recursive: true });
  const tempRoot =
    existingRoot ??
    (() => {
      harnessSequence += 1;
      const root = path.join(TEST_TMP_ROOT, `it${harnessSequence}`);
      fs.rmSync(root, { recursive: true, force: true });
      fs.mkdirSync(root, { recursive: true });
      return root;
    })();
  const workspaceRoot = path.join(tempRoot, "workspace");
  const socketPath = path.join(tempRoot, "s.sock");
  const journalPath = path.join(tempRoot, "a.db");
  const snapshotRootPath = path.join(tempRoot, "snaps");

  fs.mkdirSync(workspaceRoot, { recursive: true });

  let server: net.Server;
  const effectiveStartServerOptions: Partial<Parameters<typeof startServer>[0]> = {
    workspaceRootPath: workspaceRoot,
    policyGlobalConfigPath: path.join(tempRoot, ".config", "agentgit", "authority-policy.toml"),
    policyWorkspaceConfigPath: path.join(workspaceRoot, ".agentgit", "policy.toml"),
    ...startServerOptions,
  };
  try {
    server = await startServer({
      socketPath,
      journalPath,
      snapshotRootPath,
      artifactRetentionMs,
      capabilityRefreshStaleMs,
      ...effectiveStartServerOptions,
    });
  } catch (error) {
    if (error instanceof AgentGitError) {
      throw new Error(
        [
          "createHarness failed",
          `message=${error.message}`,
          `code=${error.code}`,
          `details=${JSON.stringify(error.details ?? {})}`,
          `socketPath=${socketPath}`,
          `journalPath=${journalPath}`,
          `snapshotRootPath=${snapshotRootPath}`,
        ].join(" "),
      );
    }

    throw error;
  }

  const harness = {
    tempRoot,
    workspaceRoot,
    socketPath,
    journalPath,
    snapshotRootPath,
    artifactRetentionMs,
    capabilityRefreshStaleMs,
    startServerOptions: effectiveStartServerOptions,
    server,
  };
  harnesses.push(harness);
  return harness;
}

async function closeHarness(harness: TestHarness): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    harness.server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  if (fs.existsSync(harness.socketPath)) {
    fs.rmSync(harness.socketPath, { force: true });
  }
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

async function startMcpHttpService(
  options: {
    requireBearerToken?: string;
    requireBearerTokenForToolCallsOnly?: string;
    scenario?: "default" | "missing_tool" | "call_error" | "delayed_call";
    getScenario?: () => "default" | "missing_tool" | "call_error" | "delayed_call";
  } = {},
): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    if (req.method === "POST") {
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    }
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const parsedBody =
      bodyText.length > 0
        ? (JSON.parse(bodyText) as {
            method?: string;
          })
        : null;
    const requiresBearer =
      (options.requireBearerToken !== undefined &&
        req.headers.authorization !== `Bearer ${options.requireBearerToken}`) ||
      (options.requireBearerTokenForToolCallsOnly !== undefined &&
        parsedBody?.method === "tools/call" &&
        req.headers.authorization !== `Bearer ${options.requireBearerTokenForToolCallsOnly}`);
    if (requiresBearer) {
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
    const scenario = options.getScenario?.() ?? options.scenario ?? "default";

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
          if (scenario === "call_error") {
            return {
              isError: true,
              content: [{ type: "text", text: `http-upstream-error:${note}` }],
            };
          }

          if (scenario === "delayed_call") {
            await new Promise((resolve) => setTimeout(resolve, 2_000));
          }

          return {
            content: [{ type: "text", text: `http-echo:${note}` }],
            structuredContent: { echoed_note: note },
          };
        },
      );

      mcpServer.registerTool(
        "delete_remote",
        {
          description: "Pretend to delete a remote record.",
          inputSchema: {
            record_id: z.string(),
          },
          annotations: {
            destructiveHint: true,
          },
        },
        async ({ record_id }) => ({
          content: [{ type: "text", text: `deleted:${record_id}` }],
        }),
      );
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    try {
      await mcpServer.connect(transport);
      if (req.method === "POST") {
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
  };
}

async function restartHarness(harness: TestHarness): Promise<void> {
  await closeHarness(harness);
  harness.server = await startServer({
    socketPath: harness.socketPath,
    journalPath: harness.journalPath,
    snapshotRootPath: harness.snapshotRootPath,
    artifactRetentionMs: harness.artifactRetentionMs,
    capabilityRefreshStaleMs: harness.capabilityRefreshStaleMs,
    ...harness.startServerOptions,
  });
}

function writeShellApprovalPolicy(workspaceRoot: string): void {
  const policyDir = path.join(workspaceRoot, ".agentgit");
  const policyPath = path.join(policyDir, "policy.toml");
  fs.mkdirSync(policyDir, { recursive: true });
  fs.writeFileSync(
    policyPath,
    [
      'profile_name = "workspace-shell-review"',
      'policy_version = "2026.04.03"',
      "",
      "[thresholds]",
      'low_confidence = [{ action_family = "shell/*", ask_below = 0.3 }]',
      "",
      "[[rules]]",
      'rule_id = "workspace.shell.require-approval"',
      'description = "Require approval for shell execution in approval-path tests."',
      'rationale = "Approval-path integration tests should exercise the explicit exception lane, not default recoverable automation."',
      'binding_scope = "workspace"',
      'decision = "allow"',
      'enforcement_mode = "require_approval"',
      "priority = 950",
      'reason = { code = "WORKSPACE_SHELL_REQUIRES_APPROVAL", severity = "moderate", message = "Workspace policy requires approval before shell execution." }',
      'match = { type = "field", field = "operation.domain", operator = "eq", value = "shell" }',
    ].join("\n"),
    "utf8",
  );
}

function trackStore<T extends ClosableStore>(store: T): T {
  storeClosers.push(store);
  return store;
}

function openDraftStore(storePath: string): OwnedDraftStore {
  return trackStore(new OwnedDraftStore(storePath));
}

function openNoteStore(storePath: string): OwnedNoteStore {
  return trackStore(new OwnedNoteStore(storePath));
}

function openTicketStore(storePath: string): OwnedTicketStore {
  return trackStore(new OwnedTicketStore(storePath));
}

async function sendRawLine(socketPath: string, line: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";

    socket.setEncoding("utf8");

    socket.once("connect", () => {
      socket.write(line.endsWith("\n") ? line : `${line}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }

      const responseLine = buffer.slice(0, newlineIndex).trim();
      socket.end();

      try {
        resolve(JSON.parse(responseLine));
      } catch (error) {
        reject(error);
      }
    });

    socket.once("error", reject);
  });
}

async function sendRequest<TResult>(
  harness: TestHarness,
  method: string,
  payload: unknown,
  sessionId?: string,
  idempotencyKey?: string,
): Promise<ResponseEnvelope<TResult>> {
  const response = await sendRawLine(
    harness.socketPath,
    JSON.stringify({
      api_version: API_VERSION,
      request_id: nextRequestId(),
      session_id: sessionId,
      idempotency_key: idempotencyKey,
      method,
      payload,
    }),
  );

  expect(isResponseEnvelope(response)).toBe(true);
  return response as ResponseEnvelope<TResult>;
}

async function waitFor<T>(
  read: () => T,
  predicate: (value: T) => boolean,
  timeoutMs = 5_000,
  intervalMs = 50,
): Promise<T> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const value = read();
    if (predicate(value)) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const finalValue = read();
  throw new Error(`Timed out waiting for condition. Last value: ${JSON.stringify(finalValue)}`);
}

async function createSessionAndRun(
  harness: TestHarness,
  workflowName = "integration-test",
): Promise<{
  sessionId: string;
  runId: string;
}> {
  return createSessionAndRunForWorkspaceRoot(harness, harness.workspaceRoot, workflowName);
}

async function createSessionAndRunForWorkspaceRoot(
  harness: TestHarness,
  workspaceRoot: string,
  workflowName = "integration-test",
): Promise<{
  sessionId: string;
  runId: string;
}> {
  const helloResponse = await sendRequest<{ session_id: string }>(harness, "hello", {
    client_type: "cli",
    client_version: "0.1.0",
    requested_api_version: API_VERSION,
    workspace_roots: [workspaceRoot],
  });
  expect(helloResponse.ok).toBe(true);

  const sessionId = helloResponse.result?.session_id;
  expect(typeof sessionId).toBe("string");

  const registerResponse = await sendRequest<{
    run_id: string;
  }>(
    harness,
    "register_run",
    {
      workflow_name: workflowName,
      agent_framework: "cli",
      agent_name: "agentgit-cli",
      workspace_roots: [workspaceRoot],
      client_metadata: {
        source: "integration-test",
      },
    },
    sessionId,
  );
  expect(registerResponse.ok).toBe(true);

  const runId = registerResponse.result?.run_id;
  expect(typeof runId).toBe("string");

  return {
    sessionId: sessionId as string,
    runId: runId as string,
  };
}

function findRunCheckpointToken(journalPath: string, runId: string, snapshotId: string): string {
  const journal = createRunJournal({ dbPath: journalPath });
  try {
    const checkpointEvent = journal
      .listRunEvents(runId)
      .find(
        (event) =>
          event.event_type === "snapshot.created" &&
          (event.payload as Record<string, unknown> | undefined)?.snapshot_id === snapshotId,
      );
    expect(checkpointEvent).toBeTruthy();
    return `${runId}#${checkpointEvent!.sequence}`;
  } finally {
    journal.close();
  }
}

function findBranchPoint(journalPath: string, runId: string, snapshotId: string): { run_id: string; sequence: number } {
  const runCheckpoint = findRunCheckpointToken(journalPath, runId, snapshotId);
  const separatorIndex = runCheckpoint.lastIndexOf("#");
  return {
    run_id: runCheckpoint.slice(0, separatorIndex),
    sequence: Number.parseInt(runCheckpoint.slice(separatorIndex + 1), 10),
  };
}

function makeFilesystemWriteAttempt(runId: string, workspaceRoot: string, targetPath: string, content: string) {
  return {
    run_id: runId,
    tool_registration: {
      tool_name: "write_file",
      tool_kind: "filesystem",
    },
    raw_call: {
      operation: "write",
      path: targetPath,
      content,
    },
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: "none",
    },
    framework_context: {
      agent_name: "agentgit-cli",
      agent_framework: "cli",
    },
    received_at: new Date().toISOString(),
  };
}

function makeFilesystemDeleteAttempt(runId: string, workspaceRoot: string, targetPath: string) {
  return {
    run_id: runId,
    tool_registration: {
      tool_name: "delete_file",
      tool_kind: "filesystem",
    },
    raw_call: {
      operation: "delete",
      path: targetPath,
    },
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: "none",
    },
    framework_context: {
      agent_name: "agentgit-cli",
      agent_framework: "cli",
    },
    received_at: new Date().toISOString(),
  };
}

function makeFilesystemWriteAction(runId: string, targetPath: string): ActionRecord {
  const confidenceScore = 0.99;
  return {
    schema_version: "action.v1",
    action_id: `act_test_${path.basename(targetPath).replaceAll(/[^a-z0-9]/gi, "_")}`,
    run_id: runId,
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
      kind: "write",
      name: "filesystem.write",
      display_name: "Write file",
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
      raw: {},
      redacted: {},
      schema_ref: null,
      contains_sensitive_data: false,
    },
    risk_hints: {
      side_effect_level: "mutating",
      external_effects: "none",
      reversibility_hint: "reversible",
      sensitivity_hint: "low",
      batch: false,
    },
    facets: {
      filesystem: {
        operation: "write",
      },
    },
    normalization: {
      mapper: "test",
      inferred_fields: [],
      warnings: [],
      normalization_confidence: confidenceScore,
    },
    confidence_assessment: {
      engine_version: "test-confidence/v1",
      score: confidenceScore,
      band: "high",
      requires_human_review: false,
      factors: [
        {
          factor_id: "test_baseline",
          label: "Test baseline",
          kind: "baseline",
          delta: confidenceScore,
          rationale: "Test confidence baseline.",
        },
      ],
    },
  };
}

function makeShellAttempt(runId: string, workspaceRoot: string, argv: string[]) {
  return {
    run_id: runId,
    tool_registration: {
      tool_name: "exec_command",
      tool_kind: "shell",
    },
    raw_call: {
      command: argv.join(" "),
      argv,
    },
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: "none",
    },
    framework_context: {
      agent_name: "agentgit-cli",
      agent_framework: "cli",
    },
    received_at: new Date().toISOString(),
  };
}

function makeShellActionRecord(
  runId: string,
  workspaceRoot: string,
  argv: string[],
  overrides: Partial<ActionRecord> = {},
): ActionRecord {
  const command = argv.join(" ");
  return {
    schema_version: "action.v1",
    action_id: `act_shell_${crypto.createHash("sha1").update(command).digest("hex").slice(0, 10)}`,
    run_id: runId,
    session_id: "sess_test",
    status: "normalized",
    timestamps: {
      requested_at: "2026-03-29T12:00:00.000Z",
      normalized_at: "2026-03-29T12:00:01.000Z",
    },
    provenance: {
      mode: "governed",
      source: "test",
      confidence: 0.9,
    },
    actor: {
      type: "agent",
      tool_name: "exec_command",
      tool_kind: "shell",
    },
    operation: {
      domain: "shell",
      kind: "exec",
      name: "shell.exec",
      display_name: "Run shell command",
    },
    execution_path: {
      surface: "governed_shell",
      mode: "pre_execution",
      credential_mode: "none",
    },
    target: {
      primary: {
        type: "workspace",
        locator: workspaceRoot,
      },
      scope: {
        breadth: "workspace",
        estimated_count: 1,
        unknowns: [],
      },
    },
    input: {
      raw: { argv, command },
      redacted: { argv, command },
      schema_ref: null,
      contains_sensitive_data: false,
    },
    risk_hints: {
      side_effect_level: "mutating",
      external_effects: "none",
      reversibility_hint: "compensatable",
      sensitivity_hint: "moderate",
      batch: false,
    },
    facets: {
      shell: {
        argv,
        cwd: workspaceRoot,
        command_family: "unclassified",
      },
    },
    normalization: {
      mapper: "test",
      inferred_fields: [],
      warnings: [],
      normalization_confidence: 0.74,
    },
    confidence_assessment: {
      engine_version: "test-confidence/v1",
      score: 0.61,
      band: "low",
      requires_human_review: true,
      factors: [
        {
          factor_id: "opaque_shell_history",
          label: "Opaque shell mutation",
          kind: "baseline",
          delta: 0.61,
          rationale: "Synthetic test shell history should widen future boundaries.",
        },
      ],
    },
    ...overrides,
  };
}

function appendSyntheticActionHistory(
  journal: RunJournal,
  action: ActionRecord,
  decision: "allow" | "allow_with_snapshot" | "ask" | "deny" = "allow_with_snapshot",
): void {
  journal.appendRunEvent(action.run_id, {
    event_type: "action.normalized",
    occurred_at: action.timestamps.normalized_at,
    recorded_at: action.timestamps.normalized_at,
    payload: {
      action,
      action_id: action.action_id,
      operation: action.operation,
      target_locator: action.target.primary.locator,
      normalization: action.normalization,
      confidence_score: action.confidence_assessment.score,
      risk_hints: action.risk_hints,
    },
  });
  journal.appendRunEvent(action.run_id, {
    event_type: "policy.evaluated",
    occurred_at: action.timestamps.normalized_at,
    recorded_at: action.timestamps.normalized_at,
    payload: {
      action_id: action.action_id,
      evaluated_at: action.timestamps.normalized_at,
      decision,
      reasons: [],
      matched_rules: [],
      normalization_confidence: action.normalization.normalization_confidence,
      confidence_score: action.confidence_assessment.score,
      action_family: `${action.operation.domain}/${action.operation.kind}`,
      snapshot_required: decision === "allow_with_snapshot" || decision === "ask",
      snapshot_selection: null,
      low_confidence_threshold: null,
      confidence_triggered: action.confidence_assessment.requires_human_review,
    },
  });
}

function makeMcpAttempt(
  runId: string,
  workspaceRoot: string,
  options: {
    serverId?: string;
    toolName: string;
    arguments?: Record<string, unknown>;
    credentialMode?: "none" | "brokered" | "direct";
  },
) {
  return {
    run_id: runId,
    tool_registration: {
      tool_name: "mcp_call_tool",
      tool_kind: "mcp",
    },
    raw_call: {
      server_id: options.serverId ?? "notes_server",
      tool_name: options.toolName,
      arguments: options.arguments ?? {},
    },
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: options.credentialMode ?? "none",
    },
    framework_context: {
      agent_name: "agentgit-cli",
      agent_framework: "cli",
    },
    received_at: new Date().toISOString(),
  };
}

function makeDraftCreateAttempt(runId: string, workspaceRoot: string, subject: string, body: string) {
  return {
    run_id: runId,
    tool_registration: {
      tool_name: "drafts_create",
      tool_kind: "function",
    },
    raw_call: {
      integration: "drafts",
      operation: "create_draft",
      subject,
      body,
    },
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: "none",
    },
    framework_context: {
      agent_name: "agentgit-cli",
      agent_framework: "cli",
    },
    received_at: new Date().toISOString(),
  };
}

function makeDraftArchiveAttempt(runId: string, workspaceRoot: string, draftId: string) {
  return {
    run_id: runId,
    tool_registration: {
      tool_name: "drafts_archive",
      tool_kind: "function",
    },
    raw_call: {
      integration: "drafts",
      operation: "archive_draft",
      draft_id: draftId,
    },
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: "none",
    },
    framework_context: {
      agent_name: "agentgit-cli",
      agent_framework: "cli",
    },
    received_at: new Date().toISOString(),
  };
}

function makeDraftUpdateAttempt(
  runId: string,
  workspaceRoot: string,
  draftId: string,
  subject?: string,
  body?: string,
) {
  return {
    run_id: runId,
    tool_registration: {
      tool_name: "drafts_update",
      tool_kind: "function",
    },
    raw_call: {
      integration: "drafts",
      operation: "update_draft",
      draft_id: draftId,
      ...(subject === undefined ? {} : { subject }),
      ...(body === undefined ? {} : { body }),
    },
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: "none",
    },
    framework_context: {
      agent_name: "agentgit-cli",
      agent_framework: "cli",
    },
    received_at: new Date().toISOString(),
  };
}

function makeDraftAddLabelAttempt(runId: string, workspaceRoot: string, draftId: string, label: string) {
  return {
    run_id: runId,
    tool_registration: {
      tool_name: "drafts_add_label",
      tool_kind: "function",
    },
    raw_call: {
      integration: "drafts",
      operation: "add_label",
      draft_id: draftId,
      label,
    },
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: "none",
    },
    framework_context: {
      agent_name: "agentgit-cli",
      agent_framework: "cli",
    },
    received_at: new Date().toISOString(),
  };
}

function makeDraftRemoveLabelAttempt(runId: string, workspaceRoot: string, draftId: string, label: string) {
  return {
    run_id: runId,
    tool_registration: {
      tool_name: "drafts_remove_label",
      tool_kind: "function",
    },
    raw_call: {
      integration: "drafts",
      operation: "remove_label",
      draft_id: draftId,
      label,
    },
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: "none",
    },
    framework_context: {
      agent_name: "agentgit-cli",
      agent_framework: "cli",
    },
    received_at: new Date().toISOString(),
  };
}

function makeDraftUnarchiveAttempt(runId: string, workspaceRoot: string, draftId: string) {
  return {
    run_id: runId,
    tool_registration: {
      tool_name: "drafts_unarchive",
      tool_kind: "function",
    },
    raw_call: {
      integration: "drafts",
      operation: "unarchive_draft",
      draft_id: draftId,
    },
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: "none",
    },
    framework_context: {
      agent_name: "agentgit-cli",
      agent_framework: "cli",
    },
    received_at: new Date().toISOString(),
  };
}

function makeDraftDeleteAttempt(runId: string, workspaceRoot: string, draftId: string) {
  return {
    run_id: runId,
    tool_registration: {
      tool_name: "drafts_delete",
      tool_kind: "function",
    },
    raw_call: {
      integration: "drafts",
      operation: "delete_draft",
      draft_id: draftId,
    },
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: "none",
    },
    framework_context: {
      agent_name: "agentgit-cli",
      agent_framework: "cli",
    },
    received_at: new Date().toISOString(),
  };
}

function makeDraftRestoreAttempt(
  runId: string,
  workspaceRoot: string,
  draftId: string,
  options: {
    subject: string;
    body: string;
    status: "active" | "archived" | "deleted";
    labels: string[];
  },
) {
  return {
    run_id: runId,
    tool_registration: {
      tool_name: "drafts_restore",
      tool_kind: "function",
    },
    raw_call: {
      integration: "drafts",
      operation: "restore_draft",
      draft_id: draftId,
      subject: options.subject,
      body: options.body,
      status: options.status,
      labels: options.labels,
    },
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: "none",
    },
    framework_context: {
      agent_name: "agentgit-cli",
      agent_framework: "cli",
    },
    received_at: new Date().toISOString(),
  };
}

function makeNoteCreateAttempt(runId: string, workspaceRoot: string, title: string, body: string) {
  return {
    run_id: runId,
    tool_registration: {
      tool_name: "notes_create",
      tool_kind: "function",
    },
    raw_call: {
      integration: "notes",
      operation: "create_note",
      title,
      body,
    },
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: "none",
    },
    framework_context: {
      agent_name: "agentgit-cli",
      agent_framework: "cli",
    },
    received_at: new Date().toISOString(),
  };
}

function makeNoteArchiveAttempt(runId: string, workspaceRoot: string, noteId: string) {
  return {
    run_id: runId,
    tool_registration: {
      tool_name: "notes_archive",
      tool_kind: "function",
    },
    raw_call: {
      integration: "notes",
      operation: "archive_note",
      note_id: noteId,
    },
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: "none",
    },
    framework_context: {
      agent_name: "agentgit-cli",
      agent_framework: "cli",
    },
    received_at: new Date().toISOString(),
  };
}

function makeNoteUnarchiveAttempt(runId: string, workspaceRoot: string, noteId: string) {
  return {
    run_id: runId,
    tool_registration: {
      tool_name: "notes_unarchive",
      tool_kind: "function",
    },
    raw_call: {
      integration: "notes",
      operation: "unarchive_note",
      note_id: noteId,
    },
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: "none",
    },
    framework_context: {
      agent_name: "agentgit-cli",
      agent_framework: "cli",
    },
    received_at: new Date().toISOString(),
  };
}

function makeNoteDeleteAttempt(runId: string, workspaceRoot: string, noteId: string) {
  return {
    run_id: runId,
    tool_registration: {
      tool_name: "notes_delete",
      tool_kind: "function",
    },
    raw_call: {
      integration: "notes",
      operation: "delete_note",
      note_id: noteId,
    },
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: "none",
    },
    framework_context: {
      agent_name: "agentgit-cli",
      agent_framework: "cli",
    },
    received_at: new Date().toISOString(),
  };
}

function makeNoteUpdateAttempt(runId: string, workspaceRoot: string, noteId: string, title?: string, body?: string) {
  return {
    run_id: runId,
    tool_registration: {
      tool_name: "notes_update",
      tool_kind: "function",
    },
    raw_call: {
      integration: "notes",
      operation: "update_note",
      note_id: noteId,
      ...(title === undefined ? {} : { title }),
      ...(body === undefined ? {} : { body }),
    },
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: "none",
    },
    framework_context: {
      agent_name: "agentgit-cli",
      agent_framework: "cli",
    },
    received_at: new Date().toISOString(),
  };
}

function makeNoteRestoreAttempt(
  runId: string,
  workspaceRoot: string,
  noteId: string,
  options: {
    title: string;
    body: string;
    status: "active" | "archived" | "deleted";
  },
) {
  return {
    run_id: runId,
    tool_registration: {
      tool_name: "notes_restore",
      tool_kind: "function",
    },
    raw_call: {
      integration: "notes",
      operation: "restore_note",
      note_id: noteId,
      title: options.title,
      body: options.body,
      status: options.status,
    },
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: "none",
    },
    framework_context: {
      agent_name: "agentgit-cli",
      agent_framework: "cli",
    },
    received_at: new Date().toISOString(),
  };
}

function makeTicketCreateAttempt(runId: string, workspaceRoot: string, title: string, body: string) {
  return {
    run_id: runId,
    tool_registration: {
      tool_name: "tickets_create",
      tool_kind: "function",
    },
    raw_call: {
      integration: "tickets",
      operation: "create_ticket",
      title,
      body,
    },
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: "brokered",
    },
    framework_context: {
      agent_name: "agentgit-cli",
      agent_framework: "cli",
    },
    received_at: new Date().toISOString(),
  };
}

function makeTicketUpdateAttempt(
  runId: string,
  workspaceRoot: string,
  ticketId: string,
  options: {
    title?: string;
    body?: string;
  },
) {
  return {
    run_id: runId,
    tool_registration: {
      tool_name: "tickets_update",
      tool_kind: "function",
    },
    raw_call: {
      integration: "tickets",
      operation: "update_ticket",
      ticket_id: ticketId,
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(options.body === undefined ? {} : { body: options.body }),
    },
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: "brokered",
    },
    framework_context: {
      agent_name: "agentgit-cli",
      agent_framework: "cli",
    },
    received_at: new Date().toISOString(),
  };
}

function makeTicketDeleteAttempt(runId: string, workspaceRoot: string, ticketId: string) {
  return {
    run_id: runId,
    tool_registration: {
      tool_name: "tickets_delete",
      tool_kind: "function",
    },
    raw_call: {
      integration: "tickets",
      operation: "delete_ticket",
      ticket_id: ticketId,
    },
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: "brokered",
    },
    framework_context: {
      agent_name: "agentgit-cli",
      agent_framework: "cli",
    },
    received_at: new Date().toISOString(),
  };
}

function makeTicketRestoreAttempt(
  runId: string,
  workspaceRoot: string,
  ticketId: string,
  options: {
    title: string;
    body: string;
    status: "active" | "closed";
    labels: string[];
    assigned_users: string[];
  },
) {
  return {
    run_id: runId,
    tool_registration: {
      tool_name: "tickets_restore",
      tool_kind: "function",
    },
    raw_call: {
      integration: "tickets",
      operation: "restore_ticket",
      ticket_id: ticketId,
      title: options.title,
      body: options.body,
      status: options.status,
      labels: options.labels,
      assigned_users: options.assigned_users,
    },
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: "brokered",
    },
    framework_context: {
      agent_name: "agentgit-cli",
      agent_framework: "cli",
    },
    received_at: new Date().toISOString(),
  };
}

function makeTicketCloseAttempt(runId: string, workspaceRoot: string, ticketId: string) {
  return {
    run_id: runId,
    tool_registration: {
      tool_name: "tickets_close",
      tool_kind: "function",
    },
    raw_call: {
      integration: "tickets",
      operation: "close_ticket",
      ticket_id: ticketId,
    },
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: "brokered",
    },
    framework_context: {
      agent_name: "agentgit-cli",
      agent_framework: "cli",
    },
    received_at: new Date().toISOString(),
  };
}

function makeTicketReopenAttempt(runId: string, workspaceRoot: string, ticketId: string) {
  return {
    run_id: runId,
    tool_registration: {
      tool_name: "tickets_reopen",
      tool_kind: "function",
    },
    raw_call: {
      integration: "tickets",
      operation: "reopen_ticket",
      ticket_id: ticketId,
    },
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: "brokered",
    },
    framework_context: {
      agent_name: "agentgit-cli",
      agent_framework: "cli",
    },
    received_at: new Date().toISOString(),
  };
}

function makeTicketAddLabelAttempt(runId: string, workspaceRoot: string, ticketId: string, label: string) {
  return {
    run_id: runId,
    tool_registration: {
      tool_name: "tickets_add_label",
      tool_kind: "function",
    },
    raw_call: {
      integration: "tickets",
      operation: "add_label",
      ticket_id: ticketId,
      label,
    },
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: "brokered",
    },
    framework_context: {
      agent_name: "agentgit-cli",
      agent_framework: "cli",
    },
    received_at: new Date().toISOString(),
  };
}

function makeTicketRemoveLabelAttempt(runId: string, workspaceRoot: string, ticketId: string, label: string) {
  return {
    run_id: runId,
    tool_registration: {
      tool_name: "tickets_remove_label",
      tool_kind: "function",
    },
    raw_call: {
      integration: "tickets",
      operation: "remove_label",
      ticket_id: ticketId,
      label,
    },
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: "brokered",
    },
    framework_context: {
      agent_name: "agentgit-cli",
      agent_framework: "cli",
    },
    received_at: new Date().toISOString(),
  };
}

function makeTicketAssignUserAttempt(runId: string, workspaceRoot: string, ticketId: string, userId: string) {
  return {
    run_id: runId,
    tool_registration: {
      tool_name: "tickets_assign_user",
      tool_kind: "function",
    },
    raw_call: {
      integration: "tickets",
      operation: "assign_user",
      ticket_id: ticketId,
      user_id: userId,
    },
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: "brokered",
    },
    framework_context: {
      agent_name: "agentgit-cli",
      agent_framework: "cli",
    },
    received_at: new Date().toISOString(),
  };
}

function makeTicketUnassignUserAttempt(runId: string, workspaceRoot: string, ticketId: string, userId: string) {
  return {
    run_id: runId,
    tool_registration: {
      tool_name: "tickets_unassign_user",
      tool_kind: "function",
    },
    raw_call: {
      integration: "tickets",
      operation: "unassign_user",
      ticket_id: ticketId,
      user_id: userId,
    },
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: "brokered",
    },
    framework_context: {
      agent_name: "agentgit-cli",
      agent_framework: "cli",
    },
    received_at: new Date().toISOString(),
  };
}

function draftsStatePath(tempRoot: string): string {
  return path.join(tempRoot, "integrations", "state.db");
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

async function startTicketService(token = "test-ticket-token"): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  requests: Array<{ method: string; url: string; authorization: string | undefined }>;
}> {
  const requests: Array<{ method: string; url: string; authorization: string | undefined }> = [];
  const tickets = new Map<
    string,
    {
      title: string;
      body: string;
      labels: string[];
      assigned_users: string[];
      status: "active" | "closed" | "deleted";
    }
  >();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push({
      method: req.method ?? "UNKNOWN",
      url: url.pathname,
      authorization: req.headers.authorization,
    });

    if (req.headers.authorization !== `Bearer ${token}`) {
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
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        title: string;
        body: string;
      };
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

    if (req.method === "DELETE") {
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

afterEach(async () => {
  vi.restoreAllMocks();
  restoreTicketEnv();
  restoreMcpEnv();
  restoreSqliteJournalMode();
  for (const server of [...ticketServers]) {
    ticketServers.delete(server);
    await closeTicketServer(server);
  }
  while (storeClosers.length > 0) {
    storeClosers.pop()!.close();
  }
  while (harnesses.length > 0) {
    const harness = harnesses.pop()!;
    await closeHarness(harness);
    fs.rmSync(harness.tempRoot, { recursive: true, force: true });
  }
});

describe("authority daemon integration", { timeout: 30_000 }, () => {
  it("loads workspace policy config, surfaces effective policy, and strengthens matching actions", async () => {
    const harness = await createHarness();
    const policyDir = path.join(harness.workspaceRoot, ".agentgit");
    const policyPath = path.join(policyDir, "policy.toml");
    fs.mkdirSync(policyDir, { recursive: true });
    fs.writeFileSync(
      policyPath,
      [
        'profile_name = "workspace-hardening"',
        'policy_version = "2026.04.01"',
        "",
        "[thresholds]",
        'low_confidence = [{ action_family = "shell/*", ask_below = 0.45 }]',
        "",
        "[[rules]]",
        'rule_id = "workspace.readme-write-review"',
        'description = "Require approval before README mutations."',
        'rationale = "README is user-facing and should stay review-gated during policy hardening."',
        'binding_scope = "workspace"',
        'decision = "allow"',
        'enforcement_mode = "require_approval"',
        "priority = 900",
        'reason = { code = "README_REQUIRES_APPROVAL", severity = "moderate", message = "README writes require approval under the workspace policy pack." }',
        'match = { type = "field", field = "target.primary.locator", operator = "matches", value = "README\\\\.md$" }',
      ].join("\n"),
      "utf8",
    );
    await restartHarness(harness);

    const helloResponse = await sendRequest<{ session_id: string }>(harness, "hello", {
      client_type: "cli",
      client_version: "0.1.0",
      requested_api_version: API_VERSION,
      workspace_roots: [harness.workspaceRoot],
    });
    expect(helloResponse.ok).toBe(true);
    const sessionId = helloResponse.result!.session_id;

    const registerResponse = await sendRequest<{
      run_id: string;
      effective_policy_profile: string;
    }>(
      harness,
      "register_run",
      {
        workflow_name: "policy-hardening",
        agent_framework: "cli",
        agent_name: "agentgit-cli",
        workspace_roots: [harness.workspaceRoot],
        client_metadata: {
          source: "integration-test",
        },
      },
      sessionId,
    );
    expect(registerResponse.ok).toBe(true);
    expect(registerResponse.result?.effective_policy_profile).toBe("workspace-hardening");

    const effectivePolicyResponse = await sendRequest<{
      policy: {
        profile_name: string;
        thresholds?: {
          low_confidence: Array<{ action_family: string; ask_below: number }>;
        };
        rules: Array<{ rule_id: string }>;
      };
      summary: {
        profile_name: string;
        compiled_rule_count: number;
        loaded_sources: Array<{ scope: string; path: string | null }>;
      };
    }>(harness, "get_effective_policy", {}, sessionId);
    expect(effectivePolicyResponse.ok).toBe(true);
    expect(effectivePolicyResponse.result?.summary.profile_name).toBe("workspace-hardening");
    expect(effectivePolicyResponse.result?.summary.compiled_rule_count).toBeGreaterThanOrEqual(3);
    expect(effectivePolicyResponse.result?.summary.loaded_sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "workspace",
          path: policyPath,
        }),
        expect.objectContaining({
          scope: "builtin_default",
          path: null,
        }),
      ]),
    );
    expect(effectivePolicyResponse.result?.policy.rules.map((rule) => rule.rule_id)).toContain(
      "workspace.readme-write-review",
    );
    expect(effectivePolicyResponse.result?.policy.thresholds?.low_confidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_family: "shell/*",
          ask_below: 0.45,
        }),
        expect.objectContaining({
          action_family: "filesystem/*",
          ask_below: 0.3,
        }),
      ]),
    );

    const diagnosticsResponse = await sendRequest<{
      policy_summary: {
        profile_name: string;
        loaded_sources: Array<{ scope: string }>;
      } | null;
    }>(harness, "diagnostics", { sections: ["policy_summary"] }, sessionId);
    expect(diagnosticsResponse.ok).toBe(true);
    expect(diagnosticsResponse.result?.policy_summary?.profile_name).toBe("workspace-hardening");
    expect(
      diagnosticsResponse.result?.policy_summary?.loaded_sources.some((source) => source.scope === "workspace"),
    ).toBe(true);

    const targetPath = path.join(harness.workspaceRoot, "README.md");
    const submitResponse = await sendRequest<{
      policy_outcome: { decision: string; reasons: Array<{ code: string }> };
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeFilesystemWriteAttempt(registerResponse.result!.run_id, harness.workspaceRoot, targetPath, "# hi"),
      },
      sessionId,
    );
    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.policy_outcome.decision).toBe("ask");
    expect(submitResponse.result?.policy_outcome.reasons[0]?.code).toBe("README_REQUIRES_APPROVAL");
  });

  it("validates policy configs through the daemon api", async () => {
    const harness = await createHarness();
    const helloResponse = await sendRequest<{ session_id: string }>(harness, "hello", {
      client_type: "cli",
      client_version: "0.1.0",
      requested_api_version: API_VERSION,
      workspace_roots: [harness.workspaceRoot],
    });
    expect(helloResponse.ok).toBe(true);
    const sessionId = helloResponse.result!.session_id;

    const invalidResponse = await sendRequest<{
      valid: boolean;
      issues: string[];
      compiled_rule_count: number | null;
    }>(
      harness,
      "validate_policy_config",
      {
        config: {
          profile_name: "invalid-policy",
          policy_version: "2026.04.01",
        },
      },
      sessionId,
    );
    expect(invalidResponse.ok).toBe(true);
    expect(invalidResponse.result?.valid).toBe(false);
    expect(invalidResponse.result?.compiled_rule_count).toBeNull();
    expect(invalidResponse.result?.issues.some((issue) => issue.includes("rules"))).toBe(true);
  });

  it("explains a candidate action through the daemon api without executing it", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "policy-explain");

    const explainResponse = await sendRequest<{
      action_family: string;
      effective_policy_profile: string;
      low_confidence_threshold: number | null;
      confidence_triggered: boolean;
      snapshot_selection: { snapshot_class: string } | null;
      policy_outcome: { decision: string; reasons: Array<{ code: string }> };
      action: { action_id: string };
    }>(
      harness,
      "explain_policy_action",
      {
        attempt: makeFilesystemWriteAttempt(
          runId,
          harness.workspaceRoot,
          path.join(harness.workspaceRoot, "explained.txt"),
          "preview only",
        ),
      },
      sessionId,
    );

    expect(explainResponse.ok).toBe(true);
    expect(explainResponse.result?.action.action_id).toBeTruthy();
    expect(explainResponse.result?.action_family).toBe("filesystem/write");
    expect(explainResponse.result?.effective_policy_profile).toBeTruthy();
    expect(explainResponse.result?.low_confidence_threshold).toBe(0.3);
    expect(explainResponse.result?.confidence_triggered).toBe(false);
    expect(explainResponse.result?.policy_outcome.decision).toBe("allow");
    expect(explainResponse.result?.snapshot_selection).toBeNull();
  });

  it("keeps policy explanation decisions stable across daemon restart for identical attempts", async () => {
    const harness = await createHarness();
    const first = await createSessionAndRun(harness, "policy-determinism-before-restart");
    const targetPath = path.join(harness.workspaceRoot, "deterministic-explain.txt");

    const beforeRestart = await sendRequest<{
      action_family: string;
      effective_policy_profile: string;
      low_confidence_threshold: number | null;
      confidence_triggered: boolean;
      snapshot_selection: { snapshot_class: string } | null;
      policy_outcome: { decision: string; reasons: Array<{ code: string }> };
    }>(
      harness,
      "explain_policy_action",
      {
        attempt: makeFilesystemWriteAttempt(first.runId, harness.workspaceRoot, targetPath, "preview only"),
      },
      first.sessionId,
    );
    expect(beforeRestart.ok).toBe(true);

    await restartHarness(harness);

    const second = await createSessionAndRun(harness, "policy-determinism-after-restart");
    const afterRestart = await sendRequest<{
      action_family: string;
      effective_policy_profile: string;
      low_confidence_threshold: number | null;
      confidence_triggered: boolean;
      snapshot_selection: { snapshot_class: string } | null;
      policy_outcome: { decision: string; reasons: Array<{ code: string }> };
    }>(
      harness,
      "explain_policy_action",
      {
        attempt: makeFilesystemWriteAttempt(second.runId, harness.workspaceRoot, targetPath, "preview only"),
      },
      second.sessionId,
    );
    expect(afterRestart.ok).toBe(true);

    const normalize = (
      result:
        | {
            action_family: string;
            effective_policy_profile: string;
            low_confidence_threshold: number | null;
            confidence_triggered: boolean;
            snapshot_selection: { snapshot_class: string } | null;
            policy_outcome: { decision: string; reasons: Array<{ code: string }> };
          }
        | null
        | undefined,
    ) => ({
      action_family: result?.action_family ?? null,
      effective_policy_profile: result?.effective_policy_profile ?? null,
      low_confidence_threshold: result?.low_confidence_threshold ?? null,
      confidence_triggered: result?.confidence_triggered ?? null,
      snapshot_class: result?.snapshot_selection?.snapshot_class ?? null,
      decision: result?.policy_outcome.decision ?? null,
      reason_codes: result?.policy_outcome.reasons.map((reason) => reason.code) ?? [],
    });

    expect(normalize(afterRestart.result)).toEqual(normalize(beforeRestart.result));
    expect(fs.existsSync(targetPath)).toBe(false);
  });

  it("returns a policy calibration report for real run activity", async () => {
    const harness = await createHarness();
    writeShellApprovalPolicy(harness.workspaceRoot);
    await restartHarness(harness);
    const { sessionId, runId } = await createSessionAndRun(harness, "policy-calibration");
    const targetPath = path.join(harness.workspaceRoot, "calibration.txt");

    const writeResponse = await sendRequest<{
      execution_result: { mode: string } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeFilesystemWriteAttempt(runId, harness.workspaceRoot, targetPath, "calibration write"),
      },
      sessionId,
    );
    expect(writeResponse.ok).toBe(true);
    expect(writeResponse.result?.execution_result?.mode).toBe("executed");

    const shellSubmitResponse = await sendRequest<{
      approval_request: { approval_id: string; status: string } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeShellAttempt(runId, harness.workspaceRoot, [
          process.execPath,
          "-e",
          "process.stdout.write('calibration shell run')",
        ]),
      },
      sessionId,
    );
    expect(shellSubmitResponse.ok).toBe(true);
    expect(shellSubmitResponse.result?.approval_request?.status).toBe("pending");

    const resolveResponse = await sendRequest<{
      execution_result: { mode: string; output?: { stdout?: string } } | null;
    }>(
      harness,
      "resolve_approval",
      {
        approval_id: shellSubmitResponse.result!.approval_request!.approval_id,
        resolution: "approved",
        note: "approve calibration sample",
      },
      sessionId,
    );
    expect(resolveResponse.ok).toBe(true);
    expect(resolveResponse.result?.execution_result?.mode).toBe("executed");
    expect(resolveResponse.result?.execution_result?.output?.stdout).toBe("calibration shell run");

    const reportResponse = await sendRequest<{
      report: {
        filters: { run_id: string | null; include_samples: boolean; sample_limit: number | null };
        totals: {
          sample_count: number;
          unique_action_families: number;
          approvals: { requested: number; approved: number };
        };
        action_families: Array<{ action_family: string; sample_count: number }>;
        samples?: Array<{
          action_family: string;
          decision: string;
          approval_status: string | null;
          normalization_confidence: number;
          confidence_score: number;
        }>;
        samples_truncated: boolean;
      };
    }>(
      harness,
      "get_policy_calibration_report",
      {
        run_id: runId,
        include_samples: true,
        sample_limit: 10,
      },
      sessionId,
    );

    expect(reportResponse.ok).toBe(true);
    expect(reportResponse.result?.report.filters).toEqual({
      run_id: runId,
      include_samples: true,
      sample_limit: 10,
    });
    expect(reportResponse.result?.report.totals.sample_count).toBe(2);
    expect(reportResponse.result?.report.totals.unique_action_families).toBe(2);
    expect(reportResponse.result?.report.totals.approvals.requested).toBe(1);
    expect(reportResponse.result?.report.totals.approvals.approved).toBe(1);
    expect(reportResponse.result?.report.samples_truncated).toBe(false);
    expect(reportResponse.result?.report.action_families).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_family: "filesystem/write",
          sample_count: 1,
        }),
        expect.objectContaining({
          action_family: "shell/exec",
          sample_count: 1,
        }),
      ]),
    );
    expect(reportResponse.result?.report.samples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_family: "filesystem/write",
          normalization_confidence: expect.any(Number),
          confidence_score: expect.any(Number),
        }),
        expect.objectContaining({
          action_family: "shell/exec",
          decision: "ask",
          approval_status: "approved",
          normalization_confidence: expect.any(Number),
          confidence_score: expect.any(Number),
        }),
      ]),
    );
  });

  it("returns threshold recommendations from calibration history without mutating policy", async () => {
    const harness = await createHarness();
    writeShellApprovalPolicy(harness.workspaceRoot);
    await restartHarness(harness);
    const { sessionId, runId } = await createSessionAndRun(harness, "policy-threshold-recommendations");
    const targetPath = path.join(harness.workspaceRoot, "thresholds.txt");

    const writeResponse = await sendRequest<{
      execution_result: { mode: string } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeFilesystemWriteAttempt(runId, harness.workspaceRoot, targetPath, "threshold write"),
      },
      sessionId,
    );
    expect(writeResponse.ok).toBe(true);

    const shellSubmitResponse = await sendRequest<{
      approval_request: { approval_id: string; status: string } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeShellAttempt(runId, harness.workspaceRoot, [
          process.execPath,
          "-e",
          "process.stdout.write('threshold shell run')",
        ]),
      },
      sessionId,
    );
    expect(shellSubmitResponse.ok).toBe(true);
    expect(shellSubmitResponse.result?.approval_request?.status).toBe("pending");

    const resolveResponse = await sendRequest<{
      execution_result: { mode: string } | null;
    }>(
      harness,
      "resolve_approval",
      {
        approval_id: shellSubmitResponse.result!.approval_request!.approval_id,
        resolution: "approved",
        note: "threshold report approval",
      },
      sessionId,
    );
    expect(resolveResponse.ok).toBe(true);
    expect(resolveResponse.result?.execution_result?.mode).toBe("executed");

    const recommendationResponse = await sendRequest<{
      filters: { run_id: string | null; min_samples: number };
      effective_policy_profile: string;
      recommendations: Array<{
        action_family: string;
        current_ask_below: number | null;
        direction: string;
        automatic_live_application_allowed: boolean;
      }>;
    }>(
      harness,
      "get_policy_threshold_recommendations",
      {
        run_id: runId,
        min_samples: 1,
      },
      sessionId,
    );

    expect(recommendationResponse.ok).toBe(true);
    expect(recommendationResponse.result?.filters).toEqual({
      run_id: runId,
      min_samples: 1,
    });
    expect(recommendationResponse.result?.effective_policy_profile).toBeTruthy();
    expect(recommendationResponse.result?.recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_family: "filesystem/write",
          current_ask_below: 0.3,
          automatic_live_application_allowed: false,
        }),
        expect.objectContaining({
          action_family: "shell/exec",
          current_ask_below: 0.3,
          direction: "relax",
          automatic_live_application_allowed: false,
        }),
      ]),
    );
  });

  it("replays candidate thresholds against real journaled actions", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "policy-threshold-replay");
    const action = makeFilesystemWriteAction(runId, path.join(harness.workspaceRoot, "replay.txt"));
    action.normalization.normalization_confidence = 0.35;
    action.confidence_assessment = {
      ...action.confidence_assessment,
      score: 0.35,
      band: "low",
      requires_human_review: true,
      factors: [
        {
          factor_id: "test_baseline",
          label: "Test baseline",
          kind: "baseline",
          delta: 0.35,
          rationale: "Replay test confidence baseline.",
        },
      ],
    };

    const journal = createRunJournal({ dbPath: harness.journalPath });
    try {
      journal.appendRunEvent(runId, {
        event_type: "action.normalized",
        occurred_at: action.timestamps.normalized_at,
        recorded_at: action.timestamps.normalized_at,
        payload: {
          action_id: action.action_id,
          action_family: "filesystem/write",
          action,
        },
      });
      journal.appendRunEvent(runId, {
        event_type: "policy.evaluated",
        occurred_at: "2026-04-01T12:00:02.000Z",
        recorded_at: "2026-04-01T12:00:02.000Z",
        payload: {
          action_id: action.action_id,
          evaluated_at: "2026-04-01T12:00:02.000Z",
          decision: "allow",
          reasons: [],
          matched_rules: [],
          normalization_confidence: 0.35,
          confidence_score: 0.35,
          action_family: "filesystem/write",
          snapshot_required: false,
          snapshot_selection: null,
          low_confidence_threshold: 0.3,
          confidence_triggered: false,
        },
      });
    } finally {
      journal.close();
    }

    const replayResponse = await sendRequest<{
      filters: { run_id: string | null; include_changed_samples: boolean; sample_limit: number | null };
      summary: {
        replayable_samples: number;
        approvals_increased: number;
        historically_allowed_newly_gated: number;
      };
      changed_samples?: Array<{
        action_id: string;
        current_decision: string;
        candidate_decision: string;
        change_kind: string;
      }>;
    }>(
      harness,
      "replay_policy_thresholds",
      {
        run_id: runId,
        candidate_thresholds: [
          {
            action_family: "filesystem/write",
            ask_below: 0.4,
          },
        ],
        include_changed_samples: true,
        sample_limit: 10,
      },
      sessionId,
    );

    expect(replayResponse.ok).toBe(true);
    expect(replayResponse.result?.filters).toEqual({
      run_id: runId,
      include_changed_samples: true,
      sample_limit: 10,
    });
    expect(replayResponse.result?.summary.replayable_samples).toBe(1);
    expect(replayResponse.result?.summary.approvals_increased).toBe(0);
    expect(replayResponse.result?.summary.historically_allowed_newly_gated).toBe(0);
    expect(replayResponse.result?.changed_samples).toEqual([
      expect.objectContaining({
        action_id: action.action_id,
        current_decision: "allow",
        candidate_decision: "allow_with_snapshot",
        change_kind: "decision_changed",
      }),
    ]);
  });

  it("applies policy threshold calibration maintenance and reloads workspace-generated policy", async () => {
    fs.mkdirSync(TEST_TMP_ROOT, { recursive: true });
    const seededRoot = fs.mkdtempSync(path.join(TEST_TMP_ROOT, "policy-threshold-calibration-"));
    const seededWorkspacePolicyPath = path.join(seededRoot, "workspace", ".agentgit", "policy.toml");
    fs.mkdirSync(path.dirname(seededWorkspacePolicyPath), { recursive: true });
    fs.writeFileSync(
      seededWorkspacePolicyPath,
      [
        'profile_name = "workspace-seeded-calibration-policy"',
        'policy_version = "workspace-seeded-calibration-policy.v1"',
        "rules = []",
        "",
        "[thresholds]",
        'low_confidence = [{ action_family = "shell/exec", ask_below = 0.0 }]',
        "",
      ].join("\n"),
      "utf8",
    );

    const harness = await createHarness(seededRoot);
    writeShellApprovalPolicy(harness.workspaceRoot);
    await restartHarness(harness);
    const { sessionId, runId } = await createSessionAndRun(harness, "policy-threshold-calibration-maintenance");

    const baselinePolicyResponse = await sendRequest<{
      policy: {
        thresholds?: {
          low_confidence: Array<{
            action_family: string;
            ask_below: number;
          }>;
        };
      };
      summary: {
        loaded_sources: Array<{
          scope: string;
          path: string | null;
        }>;
      };
    }>(harness, "get_effective_policy", {}, sessionId);
    expect(baselinePolicyResponse.ok).toBe(true);

    const baselineShellThreshold =
      baselinePolicyResponse.result?.policy.thresholds?.low_confidence.find(
        (entry) => entry.action_family === "shell/exec",
      )?.ask_below ?? null;
    if (baselineShellThreshold !== null) {
      expect(typeof baselineShellThreshold).toBe("number");
    }
    expect(
      baselinePolicyResponse.result?.summary.loaded_sources.some((source) => source.scope === "workspace_generated"),
    ).toBe(false);

    const calibrationJournal = createRunJournal({ dbPath: harness.journalPath });
    try {
      for (let index = 0; index < 5; index += 1) {
        const evaluatedAt = new Date(Date.parse("2026-04-01T12:00:00.000Z") + index * 1_000).toISOString();
        const action = makeShellActionRecord(
          runId,
          harness.workspaceRoot,
          [process.execPath, "-e", `process.stdout.write('calibration denied ${index}')`],
          {
            normalization: {
              mapper: "test",
              inferred_fields: [],
              warnings: ["opaque_execution"],
              normalization_confidence: 0.42,
            },
            confidence_assessment: {
              engine_version: "test-confidence/v1",
              score: 0.42,
              band: "low",
              requires_human_review: true,
              factors: [
                {
                  factor_id: "shell_calibration_sample",
                  label: "Shell calibration sample",
                  kind: "baseline",
                  delta: 0.42,
                  rationale: "Synthetic low-confidence shell sample for calibration maintenance coverage.",
                },
              ],
            },
          },
        );

        calibrationJournal.appendRunEvent(runId, {
          event_type: "action.normalized",
          occurred_at: evaluatedAt,
          recorded_at: evaluatedAt,
          payload: {
            action_id: action.action_id,
            action_family: "shell/exec",
            action,
          },
        });

        const policyOutcome = {
          schema_version: "policy-outcome.v1" as const,
          policy_outcome_id: `pol_cal_${index}`,
          action_id: action.action_id,
          decision: "ask" as const,
          reasons: [
            {
              code: "LOW_NORMALIZATION_CONFIDENCE",
              severity: "high" as const,
              message: "Shell command confidence is below the configured automation threshold and requires approval.",
            },
          ],
          trust_requirements: {
            wrapped_path_required: true,
            brokered_credentials_required: false,
            direct_credentials_forbidden: false,
          },
          preconditions: {
            snapshot_required: false,
            approval_required: true,
            simulation_supported: false,
          },
          approval: null,
          budget_effects: {
            budget_check: "passed" as const,
            estimated_cost: 0,
            remaining_mutating_actions: null,
            remaining_destructive_actions: null,
          },
          policy_context: {
            matched_rules: ["normalization.low_confidence.ask"],
            sticky_decision_applied: false,
          },
          evaluated_at: evaluatedAt,
        };

        calibrationJournal.appendRunEvent(runId, {
          event_type: "policy.evaluated",
          occurred_at: evaluatedAt,
          recorded_at: evaluatedAt,
          payload: {
            action_id: action.action_id,
            policy_outcome_id: policyOutcome.policy_outcome_id,
            evaluated_at: evaluatedAt,
            decision: "ask",
            reasons: policyOutcome.reasons,
            matched_rules: policyOutcome.policy_context.matched_rules,
            normalization_confidence: 0.42,
            confidence_score: 0.42,
            action_family: "shell/exec",
            snapshot_required: false,
            snapshot_selection: null,
            low_confidence_threshold: 0.3,
            confidence_triggered: true,
          },
        });

        const approval = calibrationJournal.createApprovalRequest({
          run_id: runId,
          action,
          policy_outcome: policyOutcome,
        });
        const resolvedApproval = calibrationJournal.resolveApproval(
          approval.approval_id,
          "denied",
          "deny to tighten calibration threshold",
        );
        expect(resolvedApproval.status).toBe("denied");
      }
    } finally {
      calibrationJournal.close();
    }

    const maintenanceResponse = await sendRequest<{
      jobs: Array<{
        job_type: string;
        status: string;
        performed_inline: boolean;
        summary: string;
        stats?: {
          sample_count?: number;
          thresholds_applied?: number;
          generated_config_path?: string;
          updates?: Array<{
            action_family: string;
            current_ask_below: number | null;
            recommended_ask_below: number;
            direction: string;
          }>;
        };
      }>;
    }>(
      harness,
      "run_maintenance",
      {
        job_types: ["policy_threshold_calibration"],
        scope: {
          run_id: runId,
        },
      },
      sessionId,
    );
    expect(maintenanceResponse.ok).toBe(true);
    expect(maintenanceResponse.result?.jobs[0]).toEqual(
      expect.objectContaining({
        job_type: "policy_threshold_calibration",
        status: "completed",
        performed_inline: true,
      }),
    );
    expect(maintenanceResponse.result?.jobs[0]?.stats?.sample_count).toBeGreaterThanOrEqual(5);
    expect(maintenanceResponse.result?.jobs[0]?.stats?.thresholds_applied).toBeGreaterThanOrEqual(1);
    expect(
      maintenanceResponse.result?.jobs[0]?.stats?.updates?.some((update) => update.action_family === "shell/exec"),
    ).toBe(true);

    const generatedPolicyPath = path.join(harness.workspaceRoot, ".agentgit", "policy.calibration.generated.json");
    expect(fs.existsSync(generatedPolicyPath)).toBe(true);
    const generatedPolicyDocument = JSON.parse(fs.readFileSync(generatedPolicyPath, "utf8")) as {
      thresholds?: {
        low_confidence?: Array<{ action_family: string; ask_below: number }>;
      };
    };
    expect(generatedPolicyDocument.thresholds?.low_confidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_family: "shell/exec",
        }),
      ]),
    );

    const effectivePolicyResponse = await sendRequest<{
      policy: {
        thresholds?: {
          low_confidence: Array<{
            action_family: string;
            ask_below: number;
          }>;
        };
      };
      summary: {
        loaded_sources: Array<{
          scope: string;
          path: string | null;
        }>;
      };
    }>(harness, "get_effective_policy", {}, sessionId);
    expect(effectivePolicyResponse.ok).toBe(true);
    const updatedShellThreshold =
      effectivePolicyResponse.result?.policy.thresholds?.low_confidence.find(
        (entry) => entry.action_family === "shell/exec",
      )?.ask_below ?? null;
    expect(typeof updatedShellThreshold).toBe("number");
    expect(
      baselineShellThreshold === null
        ? (updatedShellThreshold as number) > 0
        : (updatedShellThreshold as number) > baselineShellThreshold,
    ).toBe(true);
    expect(effectivePolicyResponse.result?.summary.loaded_sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "workspace_generated",
          path: generatedPolicyPath,
        }),
      ]),
    );
  });

  it("executes a filesystem write through the full request pipeline", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "filesystem-write");
    const targetPath = path.join(harness.workspaceRoot, "notes.txt");

    const submitResponse = await sendRequest<{
      execution_result: { mode: string } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeFilesystemWriteAttempt(runId, harness.workspaceRoot, targetPath, "hello from integration"),
      },
      sessionId,
    );

    if (!submitResponse.ok) {
      throw new Error(JSON.stringify(submitResponse.error));
    }
    expect(submitResponse.result?.execution_result?.mode).toBe("executed");
    expect(fs.readFileSync(targetPath, "utf8")).toBe("hello from integration");

    const summaryResponse = await sendRequest<{
      run: { event_count: number };
    }>(harness, "get_run_summary", { run_id: runId }, sessionId);
    expect(summaryResponse.ok).toBe(true);
    expect(summaryResponse.result?.run.event_count).toBe(6);
  });

  it("fails closed for governed browser/computer requests without journaling simulated execution", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "browser-unsupported");

    const submitResponse = await sendRequest(
      harness,
      "submit_action_attempt",
      {
        attempt: {
          run_id: runId,
          tool_registration: {
            tool_name: "browser_click",
            tool_kind: "browser",
          },
          raw_call: {
            action: "click",
            url: "https://example.com",
            selector: "button[type=submit]",
          },
          environment_context: {
            workspace_roots: [harness.workspaceRoot],
            cwd: harness.workspaceRoot,
            credential_mode: "none",
          },
          framework_context: {
            agent_name: "integration-test-agent",
            agent_framework: "vitest",
          },
          received_at: "2026-03-31T12:00:00.000Z",
        },
      },
      sessionId,
    );

    expect(submitResponse.ok).toBe(false);
    expect(submitResponse.error?.code).toBe("PRECONDITION_FAILED");
    expect(submitResponse.error?.message).toContain(
      "Governed browser/computer execution is not part of the supported runtime surface.",
    );
    expect(submitResponse.error?.details?.requested_tool_kind).toBe("browser");
    expect(submitResponse.error?.details?.unsupported_surface).toBe("browser_computer");

    const journal = createRunJournal({ dbPath: harness.journalPath });
    try {
      const eventTypes = journal.listRunEvents(runId).map((event) => event.event_type);
      expect(eventTypes).not.toContain("action.normalized");
      expect(eventTypes).not.toContain("execution.started");
      expect(eventTypes).not.toContain("execution.completed");
      expect(eventTypes).not.toContain("execution.simulated");
    } finally {
      journal.close();
    }
  });

  it("executes an explicitly registered read-only MCP tool through the full request pipeline", async () => {
    const service = await startMcpHttpService();
    process.env.AGENTGIT_MCP_SERVERS_JSON = JSON.stringify([
      {
        server_id: "notes_server",
        display_name: "Notes server",
        transport: "streamable_http",
        url: service.url,
        tools: [
          {
            tool_name: "echo_note",
            side_effect_level: "read_only",
            approval_mode: "allow",
          },
        ],
      },
    ]);

    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "mcp-read-only");

    const submitResponse = await sendRequest<{
      execution_result: { mode: string; success: boolean; output: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeMcpAttempt(runId, harness.workspaceRoot, {
          toolName: "echo_note",
          arguments: {
            note: "launch blocker",
          },
        }),
      },
      sessionId,
    );

    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.execution_result?.mode).toBe("executed");
    expect(submitResponse.result?.execution_result?.success).toBe(true);
    expect(submitResponse.result?.execution_result?.output.server_id).toBe("notes_server");
    expect(submitResponse.result?.execution_result?.output.tool_name).toBe("echo_note");
    expect(submitResponse.result?.execution_result?.output.summary).toBe("http-echo:launch blocker");
    await service.close();
  });

  it("requires approval for a registered mutating MCP tool instead of auto-executing it", async () => {
    process.env.AGENTGIT_MCP_SERVERS_JSON = JSON.stringify([
      {
        ...buildSandboxedStdioServer("notes_server"),
        tools: [
          {
            tool_name: "delete_remote",
            side_effect_level: "destructive",
          },
        ],
      },
    ]);

    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "mcp-mutating");

    const submitResponse = await sendRequest<{
      execution_result: unknown;
      approval_request: { approval_id: string } | null;
      policy_outcome: { decision: string; reasons: Array<{ code: string }> };
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeMcpAttempt(runId, harness.workspaceRoot, {
          toolName: "delete_remote",
          arguments: {
            record_id: "rec_123",
          },
        }),
      },
      sessionId,
    );

    if (!submitResponse.ok) {
      throw new Error(JSON.stringify(submitResponse.error));
    }
    expect(submitResponse.result?.execution_result).toBeNull();
    expect(submitResponse.result?.approval_request?.approval_id).toBeTruthy();
    expect(submitResponse.result?.policy_outcome.decision).toBe("ask");
    expect(submitResponse.result?.policy_outcome.reasons[0]?.code).toBe("MCP_TOOL_APPROVAL_REQUIRED");
  });

  it("fails closed when governed MCP execution receives direct credentials", async () => {
    process.env.AGENTGIT_MCP_SERVERS_JSON = JSON.stringify([
      {
        ...buildSandboxedStdioServer("notes_server"),
        tools: [
          {
            tool_name: "echo_note",
            side_effect_level: "read_only",
            approval_mode: "allow",
          },
        ],
      },
    ]);

    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "mcp-direct-creds");

    const submitResponse = await sendRequest<{
      execution_result: unknown;
      approval_request: unknown;
      policy_outcome: { decision: string; reasons: Array<{ code: string }> };
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeMcpAttempt(runId, harness.workspaceRoot, {
          toolName: "echo_note",
          arguments: {
            note: "launch blocker",
          },
          credentialMode: "direct",
        }),
      },
      sessionId,
    );

    if (!submitResponse.ok) {
      throw new Error(JSON.stringify(submitResponse.error));
    }
    expect(submitResponse.result?.execution_result).toBeNull();
    expect(submitResponse.result?.approval_request).toBeNull();
    expect(submitResponse.result?.policy_outcome.decision).toBe("deny");
    expect(submitResponse.result?.policy_outcome.reasons[0]?.code).toBe("DIRECT_CREDENTIALS_FORBIDDEN");
  });

  it("registers, lists, and removes governed MCP servers through daemon APIs", async () => {
    const harness = await createHarness();
    const helloResponse = await sendRequest<{ session_id: string }>(harness, "hello", {
      client_type: "cli",
      client_version: "0.1.0",
      requested_api_version: API_VERSION,
      workspace_roots: [harness.workspaceRoot],
    });

    if (!helloResponse.ok) {
      throw new Error(JSON.stringify(helloResponse.error));
    }
    const sessionId = helloResponse.result!.session_id;

    const upsertResponse = await sendRequest<{
      created: boolean;
      server: {
        source: string;
        server: { server_id: string; transport: string };
      };
    }>(
      harness,
      "upsert_mcp_server",
      {
        server: {
          ...buildSandboxedStdioServer("notes_server"),
          tools: [
            {
              tool_name: "echo_note",
              side_effect_level: "read_only",
              approval_mode: "allow",
            },
          ],
        },
      },
      sessionId,
      "idem_mcp_upsert",
    );

    expect(upsertResponse.ok).toBe(true);
    expect(upsertResponse.result?.created).toBe(true);
    expect(upsertResponse.result?.server.source).toBe("operator_api");

    const listResponse = await sendRequest<{
      servers: Array<{ source: string; server: { server_id: string; transport: string } }>;
    }>(harness, "list_mcp_servers", {}, sessionId);
    expect(listResponse.ok).toBe(true);
    expect(listResponse.result?.servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "operator_api",
          server: expect.objectContaining({
            server_id: "notes_server",
            transport: "stdio",
          }),
        }),
      ]),
    );

    const removeResponse = await sendRequest<{
      removed: boolean;
      removed_server: { server: { server_id: string } } | null;
    }>(
      harness,
      "remove_mcp_server",
      {
        server_id: "notes_server",
      },
      sessionId,
      "idem_mcp_remove",
    );
    expect(removeResponse.ok).toBe(true);
    expect(removeResponse.result?.removed).toBe(true);
    expect(removeResponse.result?.removed_server?.server.server_id).toBe("notes_server");
  });

  it("submits and lists MCP server candidates and exposes profile listings", async () => {
    const harness = await createHarness();
    const helloResponse = await sendRequest<{ session_id: string }>(harness, "hello", {
      client_type: "cli",
      client_version: "0.1.0",
      requested_api_version: API_VERSION,
      workspace_roots: [harness.workspaceRoot],
    });

    if (!helloResponse.ok) {
      throw new Error(JSON.stringify(helloResponse.error));
    }
    const sessionId = helloResponse.result!.session_id;

    const submitResponse = await sendRequest<{
      candidate: {
        candidate_id: string;
        source_kind: string;
        raw_endpoint: string;
        submitted_by_session_id: string | null;
        resolution_state: string;
      };
    }>(
      harness,
      "submit_mcp_server_candidate",
      {
        candidate: {
          source_kind: "user_input",
          raw_endpoint: "https://api.example.com/mcp",
          transport_hint: "streamable_http",
          notes: "Candidate from integration test",
        },
      },
      sessionId,
      "idem_mcp_candidate_submit",
    );

    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.candidate.source_kind).toBe("user_input");
    expect(submitResponse.result?.candidate.raw_endpoint).toBe("https://api.example.com/mcp");
    expect(submitResponse.result?.candidate.submitted_by_session_id).toBe(sessionId);
    expect(submitResponse.result?.candidate.resolution_state).toBe("pending");

    const listCandidatesResponse = await sendRequest<{
      candidates: Array<{
        candidate_id: string;
        source_kind: string;
        raw_endpoint: string;
      }>;
    }>(harness, "list_mcp_server_candidates", {}, sessionId);

    expect(listCandidatesResponse.ok).toBe(true);
    expect(listCandidatesResponse.result?.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidate_id: submitResponse.result?.candidate.candidate_id,
          source_kind: "user_input",
          raw_endpoint: "https://api.example.com/mcp",
        }),
      ]),
    );

    const listProfilesResponse = await sendRequest<{
      profiles: Array<unknown>;
    }>(harness, "list_mcp_server_profiles", {}, sessionId);

    expect(listProfilesResponse.ok).toBe(true);
    expect(listProfilesResponse.result?.profiles).toEqual([]);
  });

  it("resolves MCP server candidates into trust-reviewed profiles and supports lifecycle actions end to end", async () => {
    const harness = await createHarness();
    const { sessionId } = await createSessionAndRun(harness, "mcp-candidate-lifecycle");
    const service = await startMcpHttpService();

    const submitResponse = await sendRequest<{
      candidate: {
        candidate_id: string;
        resolution_state: string;
      };
    }>(
      harness,
      "submit_mcp_server_candidate",
      {
        candidate: {
          source_kind: "user_input",
          raw_endpoint: service.url,
          transport_hint: "streamable_http",
          notes: "Lifecycle integration test",
        },
      },
      sessionId,
      "idem_mcp_candidate_lifecycle_submit",
    );
    expect(submitResponse.ok).toBe(true);

    const candidateId = submitResponse.result?.candidate.candidate_id;
    expect(candidateId).toBeTruthy();

    const resolveResponse = await sendRequest<{
      candidate: {
        candidate_id: string;
        resolution_state: string;
        resolution_error: string | null;
      };
      profile: {
        server_profile_id: string;
        status: string;
        drift_state: string;
        canonical_endpoint: string;
        network_scope: string;
        tool_inventory_version: string | null;
      };
      created_profile: boolean;
      drift_detected: boolean;
    }>(
      harness,
      "resolve_mcp_server_candidate",
      {
        candidate_id: candidateId,
        display_name: "Example Remote MCP",
      },
      sessionId,
      "idem_mcp_candidate_lifecycle_resolve",
    );
    expect(resolveResponse.ok).toBe(true);
    expect(resolveResponse.result?.candidate.resolution_state).toBe("resolved");
    expect(resolveResponse.result?.candidate.resolution_error).toBeNull();
    expect(resolveResponse.result?.profile.status).toBe("draft");
    expect(resolveResponse.result?.profile.drift_state).toBe("clean");
    expect(resolveResponse.result?.profile.canonical_endpoint).toBe(service.url);
    expect(resolveResponse.result?.profile.network_scope).toBe("loopback");
    expect(resolveResponse.result?.profile.tool_inventory_version).toBeTruthy();
    expect(resolveResponse.result?.created_profile).toBe(true);
    expect(resolveResponse.result?.drift_detected).toBe(false);

    const profileId = resolveResponse.result?.profile.server_profile_id;
    expect(profileId).toBeTruthy();

    const approveResponse = await sendRequest<{
      profile: {
        server_profile_id: string;
        status: string;
        active_trust_decision_id: string | null;
      };
      trust_decision: {
        trust_decision_id: string;
        decision: string;
        trust_tier: string;
      };
      created: boolean;
    }>(
      harness,
      "approve_mcp_server_profile",
      {
        server_profile_id: profileId,
        decision: "allow_policy_managed",
        trust_tier: "operator_approved_public",
        allowed_execution_modes: ["local_proxy"],
        reason_codes: ["INITIAL_REVIEW_COMPLETE"],
      },
      sessionId,
      "idem_mcp_candidate_lifecycle_approve",
    );
    expect(approveResponse.ok).toBe(true);
    expect(approveResponse.result?.profile.status).toBe("pending_approval");
    expect(approveResponse.result?.trust_decision.decision).toBe("allow_policy_managed");
    expect(approveResponse.result?.created).toBe(true);

    const listTrustDecisionsResponse = await sendRequest<{
      trust_decisions: Array<{
        trust_decision_id: string;
        server_profile_id: string;
        decision: string;
      }>;
    }>(harness, "list_mcp_server_trust_decisions", { server_profile_id: profileId }, sessionId);
    expect(listTrustDecisionsResponse.ok).toBe(true);
    expect(listTrustDecisionsResponse.result?.trust_decisions).toEqual([
      expect.objectContaining({
        trust_decision_id: approveResponse.result?.trust_decision.trust_decision_id,
        server_profile_id: profileId,
        decision: "allow_policy_managed",
      }),
    ]);

    const activateResponse = await sendRequest<{
      profile: {
        server_profile_id: string;
        status: string;
        drift_state: string;
      };
    }>(
      harness,
      "activate_mcp_server_profile",
      {
        server_profile_id: profileId,
      },
      sessionId,
      "idem_mcp_candidate_lifecycle_activate",
    );
    expect(activateResponse.ok).toBe(true);
    expect(activateResponse.result?.profile.status).toBe("active");
    expect(activateResponse.result?.profile.drift_state).toBe("clean");

    const quarantineResponse = await sendRequest<{
      profile: {
        server_profile_id: string;
        status: string;
        drift_state: string;
        quarantine_reason_codes: string[];
      };
    }>(
      harness,
      "quarantine_mcp_server_profile",
      {
        server_profile_id: profileId,
        reason_codes: ["MANUAL_REVIEW_HOLD"],
      },
      sessionId,
      "idem_mcp_candidate_lifecycle_quarantine",
    );
    expect(quarantineResponse.ok).toBe(true);
    expect(quarantineResponse.result?.profile.status).toBe("quarantined");
    expect(quarantineResponse.result?.profile.drift_state).toBe("drifted");
    expect(quarantineResponse.result?.profile.quarantine_reason_codes).toEqual(["MANUAL_REVIEW_HOLD"]);

    const revokeResponse = await sendRequest<{
      profile: {
        server_profile_id: string;
        status: string;
        quarantine_reason_codes: string[];
      };
    }>(
      harness,
      "revoke_mcp_server_profile",
      {
        server_profile_id: profileId,
        reason_codes: ["MANUAL_REVOKE"],
      },
      sessionId,
      "idem_mcp_candidate_lifecycle_revoke",
    );
    expect(revokeResponse.ok).toBe(true);
    expect(revokeResponse.result?.profile.status).toBe("revoked");
    expect(revokeResponse.result?.profile.quarantine_reason_codes).toEqual(["MANUAL_REVOKE"]);
  });

  it("detects remote MCP tool inventory drift and automatically quarantines active profiles", async () => {
    const harness = await createHarness();
    const { sessionId } = await createSessionAndRun(harness, "mcp-candidate-drift");
    let scenario: "default" | "missing_tool" | "call_error" = "default";
    const service = await startMcpHttpService({
      getScenario: () => scenario,
    });

    const submitResponse = await sendRequest<{
      candidate: {
        candidate_id: string;
      };
    }>(
      harness,
      "submit_mcp_server_candidate",
      {
        candidate: {
          source_kind: "user_input",
          raw_endpoint: service.url,
          transport_hint: "streamable_http",
        },
      },
      sessionId,
      "idem_mcp_candidate_drift_submit",
    );
    expect(submitResponse.ok).toBe(true);

    const candidateId = submitResponse.result?.candidate.candidate_id;
    expect(candidateId).toBeTruthy();

    const initialResolve = await sendRequest<{
      profile: {
        server_profile_id: string;
        status: string;
        drift_state: string;
        tool_inventory_version: string | null;
      };
      drift_detected: boolean;
    }>(
      harness,
      "resolve_mcp_server_candidate",
      {
        candidate_id: candidateId,
      },
      sessionId,
      "idem_mcp_candidate_drift_resolve_initial",
    );
    expect(initialResolve.ok).toBe(true);
    expect(initialResolve.result?.drift_detected).toBe(false);

    const profileId = initialResolve.result?.profile.server_profile_id;
    const initialToolInventoryVersion = initialResolve.result?.profile.tool_inventory_version;
    expect(profileId).toBeTruthy();
    expect(initialToolInventoryVersion).toBeTruthy();

    const approveResponse = await sendRequest<{
      profile: {
        server_profile_id: string;
      };
    }>(
      harness,
      "approve_mcp_server_profile",
      {
        server_profile_id: profileId,
        decision: "allow_policy_managed",
        trust_tier: "operator_approved_public",
        allowed_execution_modes: ["local_proxy"],
        reason_codes: ["INITIAL_REVIEW_COMPLETE"],
      },
      sessionId,
      "idem_mcp_candidate_drift_approve",
    );
    expect(approveResponse.ok).toBe(true);

    const activateResponse = await sendRequest<{
      profile: {
        server_profile_id: string;
        status: string;
      };
    }>(
      harness,
      "activate_mcp_server_profile",
      {
        server_profile_id: profileId,
      },
      sessionId,
      "idem_mcp_candidate_drift_activate",
    );
    expect(activateResponse.ok).toBe(true);
    expect(activateResponse.result?.profile.status).toBe("active");

    scenario = "missing_tool";

    const driftResolve = await sendRequest<{
      candidate: {
        candidate_id: string;
        resolution_state: string;
      };
      profile: {
        server_profile_id: string;
        status: string;
        drift_state: string;
        quarantine_reason_codes: string[];
        tool_inventory_version: string | null;
      };
      drift_detected: boolean;
    }>(
      harness,
      "resolve_mcp_server_candidate",
      {
        candidate_id: candidateId,
      },
      sessionId,
      "idem_mcp_candidate_drift_resolve_again",
    );
    expect(driftResolve.ok).toBe(true);
    expect(driftResolve.result?.candidate.resolution_state).toBe("resolved");
    expect(driftResolve.result?.drift_detected).toBe(true);
    expect(driftResolve.result?.profile.status).toBe("quarantined");
    expect(driftResolve.result?.profile.drift_state).toBe("drifted");
    expect(driftResolve.result?.profile.quarantine_reason_codes).toContain("MCP_TOOL_INVENTORY_CHANGED");
    expect(driftResolve.result?.profile.tool_inventory_version).toBeTruthy();
    expect(driftResolve.result?.profile.tool_inventory_version).not.toBe(initialToolInventoryVersion);
  });

  it("binds brokered credentials to an active remote profile and executes it locally through the governed MCP path", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "mcp-phase2-local-governed-public");
    const service = await startMcpHttpService({
      requireBearerTokenForToolCallsOnly: "phase2-secret-token",
    });

    const submitCandidateResponse = await sendRequest<{
      candidate: {
        candidate_id: string;
      };
    }>(
      harness,
      "submit_mcp_server_candidate",
      {
        candidate: {
          source_kind: "user_input",
          raw_endpoint: service.url,
          transport_hint: "streamable_http",
          notes: "Phase 2 auth-bound remote MCP",
        },
      },
      sessionId,
      "idem_mcp_phase2_candidate_submit",
    );
    expect(submitCandidateResponse.ok).toBe(true);
    const candidateId = submitCandidateResponse.result?.candidate.candidate_id;
    expect(candidateId).toBeTruthy();

    const resolveResponse = await sendRequest<{
      profile: {
        server_profile_id: string;
        imported_tools: Array<{
          tool_name: string;
          side_effect_level: string;
        }>;
      };
    }>(
      harness,
      "resolve_mcp_server_candidate",
      {
        candidate_id: candidateId,
        display_name: "Phase 2 Remote MCP",
      },
      sessionId,
      "idem_mcp_phase2_candidate_resolve",
    );
    expect(resolveResponse.ok).toBe(true);
    const profileId = resolveResponse.result?.profile.server_profile_id;
    expect(profileId).toBeTruthy();
    expect(resolveResponse.result?.profile.imported_tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool_name: "echo_note",
          side_effect_level: "read_only",
        }),
      ]),
    );

    const approveResponse = await sendRequest<{
      profile: {
        server_profile_id: string;
        status: string;
      };
    }>(
      harness,
      "approve_mcp_server_profile",
      {
        server_profile_id: profileId,
        decision: "allow_policy_managed",
        trust_tier: "operator_approved_public",
        allowed_execution_modes: ["local_proxy"],
        reason_codes: ["INITIAL_REVIEW_COMPLETE"],
      },
      sessionId,
      "idem_mcp_phase2_profile_approve",
    );
    expect(approveResponse.ok).toBe(true);
    expect(approveResponse.result?.profile.status).toBe("pending_approval");

    const upsertSecretResponse = await sendRequest<{
      secret: {
        secret_id: string;
      };
    }>(
      harness,
      "upsert_mcp_secret",
      {
        secret: {
          secret_id: "mcp_secret_phase2",
          display_name: "Phase 2 MCP secret",
          bearer_token: "phase2-secret-token",
        },
      },
      sessionId,
      "idem_mcp_phase2_secret_upsert",
    );
    expect(upsertSecretResponse.ok).toBe(true);

    const bindResponse = await sendRequest<{
      profile: {
        server_profile_id: string;
        active_credential_binding_id: string | null;
        auth_descriptor: {
          mode: string;
        };
      };
      credential_binding: {
        credential_binding_id: string;
        binding_mode: string;
        broker_profile_id: string;
        status: string;
      };
    }>(
      harness,
      "bind_mcp_server_credentials",
      {
        server_profile_id: profileId,
        binding_mode: "bearer_secret_ref",
        broker_profile_id: "mcp_secret_phase2",
        scope_labels: ["remote:mcp"],
      },
      sessionId,
      "idem_mcp_phase2_bind",
    );
    expect(bindResponse.ok).toBe(true);
    expect(bindResponse.result?.credential_binding.binding_mode).toBe("bearer_secret_ref");
    expect(bindResponse.result?.credential_binding.broker_profile_id).toBe("mcp_secret_phase2");
    expect(bindResponse.result?.profile.active_credential_binding_id).toBeTruthy();
    expect(bindResponse.result?.profile.auth_descriptor.mode).toBe("bearer_secret_ref");

    const activateResponse = await sendRequest<{
      profile: {
        server_profile_id: string;
        status: string;
      };
    }>(
      harness,
      "activate_mcp_server_profile",
      {
        server_profile_id: profileId,
      },
      sessionId,
      "idem_mcp_phase2_activate",
    );
    expect(activateResponse.ok).toBe(true);
    expect(activateResponse.result?.profile.status).toBe("active");

    const listBindingsResponse = await sendRequest<{
      credential_bindings: Array<{
        credential_binding_id: string;
        server_profile_id: string;
        status: string;
      }>;
    }>(harness, "list_mcp_server_credential_bindings", { server_profile_id: profileId }, sessionId);
    expect(listBindingsResponse.ok).toBe(true);
    expect(listBindingsResponse.result?.credential_bindings).toEqual([
      expect.objectContaining({
        credential_binding_id: bindResponse.result?.credential_binding.credential_binding_id,
        server_profile_id: profileId,
        status: "active",
      }),
    ]);

    const listServersResponse = await sendRequest<{
      servers: Array<{
        source: string;
        server: {
          server_id: string;
          transport: string;
          auth?: {
            type: string;
            secret_id?: string;
          };
        };
      }>;
    }>(harness, "list_mcp_servers", {}, sessionId);
    expect(listServersResponse.ok).toBe(true);
    expect(listServersResponse.result?.servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "remote_profile",
          server: expect.objectContaining({
            server_id: profileId,
            transport: "streamable_http",
            auth: {
              type: "bearer_secret_ref",
              secret_id: "mcp_secret_phase2",
            },
          }),
        }),
      ]),
    );

    const submitActionResponse = await sendRequest<{
      execution_result: {
        success: boolean;
        output: {
          server_id: string;
          tool_name: string;
          summary: string;
          auth_type: string;
        };
      } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: {
          run_id: runId,
          tool_registration: {
            tool_name: "mcp_call_tool",
            tool_kind: "mcp",
          },
          raw_call: {
            server_id: profileId,
            server_profile_id: profileId,
            tool_name: "echo_note",
            arguments: {
              note: "phase2 auth-bound call",
            },
          },
          environment_context: {
            workspace_roots: [harness.workspaceRoot],
            cwd: harness.workspaceRoot,
            credential_mode: "none",
          },
          framework_context: {
            agent_name: "agentgit-cli",
            agent_framework: "cli",
          },
          received_at: new Date().toISOString(),
        },
      },
      sessionId,
      "idem_mcp_phase2_submit_action",
    );
    expect(submitActionResponse.ok).toBe(true);
    expect(submitActionResponse.result?.execution_result).toMatchObject({
      success: true,
      output: {
        server_id: profileId,
        tool_name: "echo_note",
        summary: "http-echo:phase2 auth-bound call",
        auth_type: "bearer_secret_ref",
      },
    });

    const revokeBindingResponse = await sendRequest<{
      profile: {
        server_profile_id: string;
        status: string;
        active_credential_binding_id: string | null;
      } | null;
      credential_binding: {
        credential_binding_id: string;
        status: string;
      };
    }>(
      harness,
      "revoke_mcp_server_credentials",
      {
        credential_binding_id: bindResponse.result?.credential_binding.credential_binding_id,
      },
      sessionId,
      "idem_mcp_phase2_revoke_binding",
    );
    expect(revokeBindingResponse.ok).toBe(true);
    expect(revokeBindingResponse.result?.credential_binding.status).toBe("revoked");
    expect(revokeBindingResponse.result?.profile?.status).toBe("draft");
    expect(revokeBindingResponse.result?.profile?.active_credential_binding_id).toBeNull();

    const listServersAfterRevoke = await sendRequest<{
      servers: Array<{
        server: {
          server_id: string;
        };
      }>;
    }>(harness, "list_mcp_servers", {}, sessionId);
    expect(listServersAfterRevoke.ok).toBe(true);
    expect(listServersAfterRevoke.result?.servers.some((record) => record.server.server_id === profileId)).toBe(false);
  });

  it("supports governed local execution for oauth_session, derived_token, and degraded session_token bindings", async () => {
    const modes: Array<"oauth_session" | "derived_token" | "session_token"> = [
      "oauth_session",
      "derived_token",
      "session_token",
    ];

    for (const mode of modes) {
      const harness = await createHarness();
      const { sessionId, runId } = await createSessionAndRun(harness, `mcp-binding-${mode}`);
      const service = await startMcpHttpService({
        requireBearerTokenForToolCallsOnly: `${mode}-secret-token`,
      });

      const candidateResponse = await sendRequest<{
        candidate: {
          candidate_id: string;
        };
      }>(
        harness,
        "submit_mcp_server_candidate",
        {
          candidate: {
            source_kind: "user_input",
            raw_endpoint: service.url,
          },
        },
        sessionId,
      );
      expect(candidateResponse.ok).toBe(true);
      const candidateId = candidateResponse.result?.candidate.candidate_id;
      expect(candidateId).toBeTruthy();

      const resolveResponse = await sendRequest<{
        profile: {
          server_profile_id: string;
        };
      }>(
        harness,
        "resolve_mcp_server_candidate",
        {
          candidate_id: candidateId,
          display_name: `Binding ${mode}`,
        },
        sessionId,
      );
      expect(resolveResponse.ok).toBe(true);
      const profileId = resolveResponse.result?.profile.server_profile_id;
      expect(profileId).toBeTruthy();

      const approveResponse = await sendRequest(
        harness,
        "approve_mcp_server_profile",
        {
          server_profile_id: profileId,
          decision: "allow_policy_managed",
          trust_tier: "operator_approved_public",
          allowed_execution_modes: ["local_proxy"],
          reason_codes: ["BINDING_MODE_APPROVED"],
        },
        sessionId,
      );
      expect(approveResponse.ok).toBe(true);

      const secretId = `mcp_secret_${mode}`;
      const upsertSecretResponse = await sendRequest(
        harness,
        "upsert_mcp_secret",
        {
          secret: {
            secret_id: secretId,
            display_name: `Secret ${mode}`,
            bearer_token: `${mode}-secret-token`,
          },
        },
        sessionId,
      );
      expect(upsertSecretResponse.ok).toBe(true);

      const bindResponse = await sendRequest<{
        profile: {
          auth_descriptor: {
            mode: string;
          };
        };
        credential_binding: {
          credential_binding_id: string;
          binding_mode: string;
          status: string;
        };
      }>(
        harness,
        "bind_mcp_server_credentials",
        {
          server_profile_id: profileId,
          binding_mode: mode,
          broker_profile_id: secretId,
          scope_labels: ["remote:mcp"],
        },
        sessionId,
      );
      expect(bindResponse.ok).toBe(true);
      expect(bindResponse.result?.credential_binding.binding_mode).toBe(mode);
      expect(bindResponse.result?.credential_binding.status).toBe(mode === "session_token" ? "degraded" : "active");
      expect(bindResponse.result?.profile.auth_descriptor.mode).toBe(mode);

      const activateResponse = await sendRequest(
        harness,
        "activate_mcp_server_profile",
        {
          server_profile_id: profileId,
        },
        sessionId,
      );
      expect(activateResponse.ok).toBe(true);

      const submitActionResponse = await sendRequest<{
        action: {
          execution_path: {
            credential_mode: string;
          };
          facets: {
            mcp: {
              credential_binding_mode: string;
            };
          };
        };
        execution_result: {
          success: boolean;
          output: {
            server_id: string;
            summary: string;
            auth_type: string;
          };
        } | null;
      }>(
        harness,
        "submit_action_attempt",
        {
          attempt: {
            run_id: runId,
            tool_registration: {
              tool_name: "mcp_call_tool",
              tool_kind: "mcp",
            },
            raw_call: {
              server_id: profileId,
              server_profile_id: profileId,
              tool_name: "echo_note",
              arguments: {
                note: `binding-${mode}`,
              },
            },
            environment_context: {
              workspace_roots: [harness.workspaceRoot],
              cwd: harness.workspaceRoot,
              credential_mode: "none",
            },
            framework_context: {
              agent_name: "agentgit-cli",
              agent_framework: "cli",
            },
            received_at: new Date().toISOString(),
          },
        },
        sessionId,
      );
      expect(submitActionResponse.ok).toBe(true);
      expect(submitActionResponse.result?.action.execution_path.credential_mode).toBe("brokered");
      expect(submitActionResponse.result?.action.facets.mcp.credential_binding_mode).toBe(mode);
      expect(submitActionResponse.result?.execution_result).toMatchObject({
        success: true,
        output: {
          server_id: profileId,
          summary: `http-echo:binding-${mode}`,
          auth_type: "bearer_secret_ref",
        },
      });

      await service.close();
    }
  });

  it("executes hosted delegated MCP calls with a lease, attestation, and durable evidence", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "mcp-hosted-phase3");
    const service = await startMcpHttpService({
      requireBearerTokenForToolCallsOnly: "phase3-hosted-token",
    });

    const candidateResponse = await sendRequest<{
      candidate: {
        candidate_id: string;
      };
    }>(
      harness,
      "submit_mcp_server_candidate",
      {
        candidate: {
          source_kind: "agent_discovered",
          raw_endpoint: service.url,
        },
      },
      sessionId,
    );
    expect(candidateResponse.ok).toBe(true);
    const candidateId = candidateResponse.result?.candidate.candidate_id;
    expect(candidateId).toBeTruthy();

    const resolveResponse = await sendRequest<{
      profile: {
        server_profile_id: string;
      };
    }>(
      harness,
      "resolve_mcp_server_candidate",
      {
        candidate_id: candidateId,
        display_name: "Hosted MCP",
      },
      sessionId,
    );
    expect(resolveResponse.ok).toBe(true);
    const profileId = resolveResponse.result?.profile.server_profile_id;
    expect(profileId).toBeTruthy();

    const approveResponse = await sendRequest(
      harness,
      "approve_mcp_server_profile",
      {
        server_profile_id: profileId,
        decision: "allow_policy_managed",
        trust_tier: "operator_approved_public",
        allowed_execution_modes: ["hosted_delegated"],
        reason_codes: ["HOSTED_APPROVED"],
      },
      sessionId,
    );
    expect(approveResponse.ok).toBe(true);

    const upsertSecretResponse = await sendRequest(
      harness,
      "upsert_mcp_secret",
      {
        secret: {
          secret_id: "mcp_secret_hosted",
          display_name: "Hosted MCP secret",
          bearer_token: "phase3-hosted-token",
        },
      },
      sessionId,
    );
    expect(upsertSecretResponse.ok).toBe(true);

    const bindResponse = await sendRequest<{
      credential_binding: {
        credential_binding_id: string;
        status: string;
      };
    }>(
      harness,
      "bind_mcp_server_credentials",
      {
        server_profile_id: profileId,
        binding_mode: "hosted_token_exchange",
        broker_profile_id: "mcp_secret_hosted",
        scope_labels: ["remote:mcp", "hosted"],
      },
      sessionId,
    );
    expect(bindResponse.ok).toBe(true);
    expect(bindResponse.result?.credential_binding.status).toBe("active");

    const activateResponse = await sendRequest(
      harness,
      "activate_mcp_server_profile",
      {
        server_profile_id: profileId,
      },
      sessionId,
    );
    expect(activateResponse.ok).toBe(true);

    const submitActionResponse = await sendRequest<{
      action: {
        execution_path: {
          surface: string;
          credential_mode: string;
        };
        facets: {
          mcp: {
            execution_mode_requested: string;
            credential_binding_mode: string;
          };
        };
      };
      execution_result: {
        success: boolean;
        output: {
          execution_mode: string;
          credential_binding_mode: string;
          summary: string;
          lease_id: string;
          attestation_id: string;
          attestation_verified: boolean;
          worker_runtime_id: string;
          worker_image_digest: string;
        };
      } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: {
          run_id: runId,
          tool_registration: {
            tool_name: "mcp_call_tool",
            tool_kind: "mcp",
          },
          raw_call: {
            server_id: profileId,
            server_profile_id: profileId,
            execution_mode_requested: "hosted_delegated",
            tool_name: "echo_note",
            arguments: {
              note: "phase3-hosted-call",
            },
          },
          environment_context: {
            workspace_roots: [harness.workspaceRoot],
            cwd: harness.workspaceRoot,
            credential_mode: "none",
          },
          framework_context: {
            agent_name: "agentgit-cli",
            agent_framework: "cli",
          },
          received_at: new Date().toISOString(),
        },
      },
      sessionId,
    );
    expect(submitActionResponse.ok).toBe(true);
    expect(submitActionResponse.result?.action.execution_path).toMatchObject({
      surface: "provider_hosted",
      credential_mode: "delegated",
    });
    expect(submitActionResponse.result?.action.facets.mcp).toMatchObject({
      execution_mode_requested: "hosted_delegated",
      credential_binding_mode: "hosted_token_exchange",
    });
    expect(submitActionResponse.result?.execution_result).toMatchObject({
      success: true,
      output: {
        execution_mode: "hosted_delegated",
        credential_binding_mode: "hosted_token_exchange",
        summary: "http-echo:phase3-hosted-call",
        attestation_verified: true,
      },
    });

    const leaseId = submitActionResponse.result?.execution_result?.output.lease_id;
    const attestationId = submitActionResponse.result?.execution_result?.output.attestation_id;
    const actionId = submitActionResponse.result?.action.action_id;
    expect(leaseId).toBeTruthy();
    expect(attestationId).toBeTruthy();
    expect(actionId).toBeTruthy();

    const journal = createRunJournal({
      dbPath: harness.journalPath,
    });
    try {
      const events = journal.listRunEvents(runId);
      expect(events.some((event) => event.event_type === "mcp_hosted_lease_issued")).toBe(true);
      expect(events.some((event) => event.event_type === "mcp_hosted_result_ingested")).toBe(true);
    } finally {
      journal.close();
    }

    const hostPolicyRegistry = new McpPublicHostPolicyRegistry({
      dbPath: path.join(harness.tempRoot, "mcp", "host-policies.db"),
    });
    const registry = new McpServerRegistry({
      dbPath: path.join(harness.tempRoot, "mcp", "registry.db"),
      publicHostPolicyRegistry: hostPolicyRegistry,
    });
    try {
      const hostedLeases = registry.listHostedExecutionLeases(profileId);
      expect(hostedLeases).toEqual([
        expect.objectContaining({
          lease_id: leaseId,
          server_profile_id: profileId,
          status: "consumed",
        }),
      ]);
      expect(registry.listHostedExecutionAttestations(leaseId)).toEqual([
        expect.objectContaining({
          attestation_id: attestationId,
          lease_id: leaseId,
        }),
      ]);
      expect(registry.listHostedExecutionJobs(profileId)).toEqual([
        expect.objectContaining({
          run_id: runId,
          action_id: actionId,
          server_profile_id: profileId,
          tool_name: "echo_note",
          status: "succeeded",
          attempt_count: 1,
          current_lease_id: leaseId,
          execution_result: expect.objectContaining({
            success: true,
          }),
        }),
      ]);
    } finally {
      registry.close();
      hostPolicyRegistry.close();
    }

    await service.close();
  });

  it("executes hosted delegated MCP calls through an externally started worker when daemon autostart is disabled", async () => {
    harnessSequence += 1;
    const tempRoot = path.join(TEST_TMP_ROOT, `external-worker-${harnessSequence}`);
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.mkdirSync(tempRoot, { recursive: true });
    const workerSocketPath = path.join(tempRoot, "worker.sock");
    const workerToken = "external-worker-token";
    const worker = await startHostedMcpWorkerServer({
      endpoint: `unix:${workerSocketPath}`,
      attestationKeyPath: path.join(tempRoot, "worker-key.json"),
      controlToken: workerToken,
    });
    const harness = await createHarness(tempRoot, null, null, {
      mcpHostedWorkerEndpoint: `unix:${workerSocketPath}`,
      mcpHostedWorkerAutostart: false,
      mcpHostedWorkerControlToken: workerToken,
    });
    const { sessionId, runId } = await createSessionAndRun(harness, "mcp-hosted-external-worker");
    const service = await startMcpHttpService({
      requireBearerTokenForToolCallsOnly: "external-worker-mcp-token",
    });

    try {
      const capabilitiesResponse = await sendRequest<{
        capabilities: Array<{
          capability_name: string;
          status: string;
          details: Record<string, unknown>;
        }>;
      }>(harness, "get_capabilities", {
        workspace_root: harness.workspaceRoot,
      });
      expect(capabilitiesResponse.ok).toBe(true);
      const hostedCapability = capabilitiesResponse.result?.capabilities.find(
        (capability) => capability.capability_name === "adapter.mcp_hosted_delegated",
      );
      expect(hostedCapability).toMatchObject({
        status: "available",
        details: expect.objectContaining({
          hosted_delegated_execution_available: true,
          worker_managed_by_daemon: false,
          worker_endpoint: `unix:${workerSocketPath}`,
        }),
      });

      const candidateResponse = await sendRequest<{
        candidate: {
          candidate_id: string;
        };
      }>(
        harness,
        "submit_mcp_server_candidate",
        {
          candidate: {
            source_kind: "agent_discovered",
            raw_endpoint: service.url,
          },
        },
        sessionId,
      );
      expect(candidateResponse.ok).toBe(true);
      const candidateId = candidateResponse.result?.candidate.candidate_id;
      expect(candidateId).toBeTruthy();

      const resolveResponse = await sendRequest<{
        profile: {
          server_profile_id: string;
        };
      }>(
        harness,
        "resolve_mcp_server_candidate",
        {
          candidate_id: candidateId,
          display_name: "External Hosted MCP",
        },
        sessionId,
      );
      expect(resolveResponse.ok).toBe(true);
      const profileId = resolveResponse.result?.profile.server_profile_id;
      expect(profileId).toBeTruthy();

      const approveResponse = await sendRequest(
        harness,
        "approve_mcp_server_profile",
        {
          server_profile_id: profileId,
          decision: "allow_policy_managed",
          trust_tier: "operator_approved_public",
          allowed_execution_modes: ["hosted_delegated"],
          reason_codes: ["EXTERNAL_WORKER_APPROVED"],
        },
        sessionId,
      );
      expect(approveResponse.ok).toBe(true);

      const upsertSecretResponse = await sendRequest(
        harness,
        "upsert_mcp_secret",
        {
          secret: {
            secret_id: "mcp_secret_external_worker",
            display_name: "External worker secret",
            bearer_token: "external-worker-mcp-token",
          },
        },
        sessionId,
      );
      expect(upsertSecretResponse.ok).toBe(true);

      const bindResponse = await sendRequest(
        harness,
        "bind_mcp_server_credentials",
        {
          server_profile_id: profileId,
          binding_mode: "hosted_token_exchange",
          broker_profile_id: "mcp_secret_external_worker",
          scope_labels: ["remote:mcp", "hosted"],
        },
        sessionId,
      );
      expect(bindResponse.ok).toBe(true);

      const activateResponse = await sendRequest(
        harness,
        "activate_mcp_server_profile",
        {
          server_profile_id: profileId,
        },
        sessionId,
      );
      expect(activateResponse.ok).toBe(true);

      const submitActionResponse = await sendRequest<{
        execution_result: {
          success: boolean;
          output: {
            execution_mode: string;
            summary: string;
            attestation_verified: boolean;
          };
        } | null;
      }>(
        harness,
        "submit_action_attempt",
        {
          attempt: {
            run_id: runId,
            tool_registration: {
              tool_name: "mcp_call_tool",
              tool_kind: "mcp",
            },
            raw_call: {
              server_id: profileId,
              server_profile_id: profileId,
              execution_mode_requested: "hosted_delegated",
              tool_name: "echo_note",
              arguments: {
                note: "external-worker-call",
              },
            },
            environment_context: {
              workspace_roots: [harness.workspaceRoot],
              cwd: harness.workspaceRoot,
              credential_mode: "none",
            },
            framework_context: {
              agent_name: "agentgit-cli",
              agent_framework: "cli",
            },
            received_at: new Date().toISOString(),
          },
        },
        sessionId,
      );
      expect(submitActionResponse.ok).toBe(true);
      expect(submitActionResponse.result?.execution_result).toMatchObject({
        success: true,
        output: {
          execution_mode: "hosted_delegated",
          summary: "http-echo:external-worker-call",
          attestation_verified: true,
        },
      });
    } finally {
      await service.close();
      await new Promise<void>((resolve, reject) => {
        worker.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it("retries durable hosted delegated MCP jobs until an external worker becomes available", async () => {
    harnessSequence += 1;
    const tempRoot = path.join(TEST_TMP_ROOT, `external-worker-retry-${harnessSequence}`);
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.mkdirSync(tempRoot, { recursive: true });
    const workerSocketPath = path.join(tempRoot, "worker.sock");
    const workerToken = "external-worker-retry-token";
    const harness = await createHarness(tempRoot, null, null, {
      mcpHostedWorkerEndpoint: `unix:${workerSocketPath}`,
      mcpHostedWorkerAutostart: false,
      mcpHostedWorkerControlToken: workerToken,
      mcpHostedWorkerAttestationKeyPath: path.join(tempRoot, "worker-key.json"),
    });
    const { sessionId, runId } = await createSessionAndRun(harness, "mcp-hosted-external-worker-retry");
    const service = await startMcpHttpService({
      requireBearerTokenForToolCallsOnly: "external-worker-retry-mcp-token",
    });

    let worker: net.Server | null = null;

    try {
      const candidateResponse = await sendRequest<{
        candidate: {
          candidate_id: string;
        };
      }>(
        harness,
        "submit_mcp_server_candidate",
        {
          candidate: {
            source_kind: "agent_discovered",
            raw_endpoint: service.url,
          },
        },
        sessionId,
      );
      expect(candidateResponse.ok).toBe(true);
      const candidateId = candidateResponse.result?.candidate.candidate_id;
      expect(candidateId).toBeTruthy();

      const resolveResponse = await sendRequest<{
        profile: {
          server_profile_id: string;
        };
      }>(
        harness,
        "resolve_mcp_server_candidate",
        {
          candidate_id: candidateId,
          display_name: "Retry Hosted MCP",
        },
        sessionId,
      );
      expect(resolveResponse.ok).toBe(true);
      const profileId = resolveResponse.result?.profile.server_profile_id;
      expect(profileId).toBeTruthy();

      const approveResponse = await sendRequest(
        harness,
        "approve_mcp_server_profile",
        {
          server_profile_id: profileId,
          decision: "allow_policy_managed",
          trust_tier: "operator_approved_public",
          allowed_execution_modes: ["hosted_delegated"],
          reason_codes: ["EXTERNAL_WORKER_RETRY_APPROVED"],
        },
        sessionId,
      );
      expect(approveResponse.ok).toBe(true);

      const upsertSecretResponse = await sendRequest(
        harness,
        "upsert_mcp_secret",
        {
          secret: {
            secret_id: "mcp_secret_external_worker_retry",
            display_name: "External worker retry secret",
            bearer_token: "external-worker-retry-mcp-token",
          },
        },
        sessionId,
      );
      expect(upsertSecretResponse.ok).toBe(true);

      const bindResponse = await sendRequest(
        harness,
        "bind_mcp_server_credentials",
        {
          server_profile_id: profileId,
          binding_mode: "hosted_token_exchange",
          broker_profile_id: "mcp_secret_external_worker_retry",
          scope_labels: ["remote:mcp", "hosted"],
        },
        sessionId,
      );
      expect(bindResponse.ok).toBe(true);

      const activateResponse = await sendRequest(
        harness,
        "activate_mcp_server_profile",
        {
          server_profile_id: profileId,
        },
        sessionId,
      );
      expect(activateResponse.ok).toBe(true);

      const submitActionPromise = sendRequest<{
        action: {
          action_id: string;
        };
        execution_result: {
          success: boolean;
          output: {
            execution_mode: string;
            summary: string;
            attestation_verified: boolean;
          };
        } | null;
      }>(
        harness,
        "submit_action_attempt",
        {
          attempt: {
            run_id: runId,
            tool_registration: {
              tool_name: "mcp_call_tool",
              tool_kind: "mcp",
            },
            raw_call: {
              server_id: profileId,
              server_profile_id: profileId,
              execution_mode_requested: "hosted_delegated",
              tool_name: "echo_note",
              arguments: {
                note: "external-worker-retry-call",
              },
            },
            environment_context: {
              workspace_roots: [harness.workspaceRoot],
              cwd: harness.workspaceRoot,
              credential_mode: "none",
            },
            framework_context: {
              agent_name: "agentgit-cli",
              agent_framework: "cli",
            },
            received_at: new Date().toISOString(),
          },
        },
        sessionId,
      );

      await new Promise((resolve) => setTimeout(resolve, 450));
      worker = await startHostedMcpWorkerServer({
        endpoint: `unix:${workerSocketPath}`,
        attestationKeyPath: path.join(tempRoot, "worker-key.json"),
        controlToken: workerToken,
      });

      const submitActionResponse = await submitActionPromise;
      expect(submitActionResponse.ok).toBe(true);
      expect(submitActionResponse.result?.execution_result).toMatchObject({
        success: true,
        output: {
          execution_mode: "hosted_delegated",
          summary: "http-echo:external-worker-retry-call",
          attestation_verified: true,
        },
      });

      const hostPolicyRegistry = new McpPublicHostPolicyRegistry({
        dbPath: path.join(harness.tempRoot, "mcp", "host-policies.db"),
      });
      const registry = new McpServerRegistry({
        dbPath: path.join(harness.tempRoot, "mcp", "registry.db"),
        publicHostPolicyRegistry: hostPolicyRegistry,
      });
      try {
        const jobs = registry.listHostedExecutionJobs(profileId);
        expect(jobs).toHaveLength(1);
        expect(jobs[0]).toMatchObject({
          run_id: runId,
          action_id: submitActionResponse.result?.action.action_id,
          server_profile_id: profileId,
          status: "succeeded",
        });
        expect(jobs[0]?.attempt_count).toBeGreaterThan(1);
        expect(jobs[0]?.last_error).toBeNull();
        expect(jobs[0]?.execution_result).toMatchObject({
          success: true,
        });
      } finally {
        registry.close();
        hostPolicyRegistry.close();
      }
    } finally {
      await service.close();
      if (worker) {
        await new Promise<void>((resolve, reject) => {
          worker.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      }
    }
  }, 20_000);

  it("surfaces hosted queue diagnostics and safely requeues failed hosted delegated MCP jobs", async () => {
    harnessSequence += 1;
    const tempRoot = path.join(TEST_TMP_ROOT, `external-worker-operator-${harnessSequence}`);
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.mkdirSync(tempRoot, { recursive: true });
    const workerSocketPath = path.join(tempRoot, "worker.sock");
    const workerToken = "external-worker-operator-token";
    const harness = await createHarness(tempRoot, null, null, {
      mcpHostedWorkerEndpoint: `unix:${workerSocketPath}`,
      mcpHostedWorkerAutostart: false,
      mcpHostedWorkerControlToken: workerToken,
      mcpHostedWorkerAttestationKeyPath: path.join(tempRoot, "worker-key.json"),
    });
    const { sessionId, runId } = await createSessionAndRun(harness, "mcp-hosted-operator-controls");
    const service = await startMcpHttpService({
      requireBearerTokenForToolCallsOnly: "external-worker-operator-mcp-token",
    });

    let worker: net.Server | null = null;

    try {
      const candidateResponse = await sendRequest<{ candidate: { candidate_id: string } }>(
        harness,
        "submit_mcp_server_candidate",
        {
          candidate: {
            source_kind: "agent_discovered",
            raw_endpoint: service.url,
          },
        },
        sessionId,
      );
      expect(candidateResponse.ok).toBe(true);
      const candidateId = candidateResponse.result?.candidate.candidate_id;
      expect(candidateId).toBeTruthy();

      const resolveResponse = await sendRequest<{ profile: { server_profile_id: string } }>(
        harness,
        "resolve_mcp_server_candidate",
        {
          candidate_id: candidateId,
          display_name: "Operator Hosted MCP",
        },
        sessionId,
      );
      expect(resolveResponse.ok).toBe(true);
      const profileId = resolveResponse.result?.profile.server_profile_id;
      expect(profileId).toBeTruthy();

      const approveResponse = await sendRequest(
        harness,
        "approve_mcp_server_profile",
        {
          server_profile_id: profileId,
          decision: "allow_policy_managed",
          trust_tier: "operator_approved_public",
          allowed_execution_modes: ["hosted_delegated"],
          reason_codes: ["HOSTED_OPERATOR_APPROVED"],
        },
        sessionId,
      );
      expect(approveResponse.ok).toBe(true);

      const upsertSecretResponse = await sendRequest(
        harness,
        "upsert_mcp_secret",
        {
          secret: {
            secret_id: "mcp_secret_external_worker_operator",
            display_name: "External worker operator secret",
            bearer_token: "external-worker-operator-mcp-token",
          },
        },
        sessionId,
      );
      expect(upsertSecretResponse.ok).toBe(true);

      const bindResponse = await sendRequest(
        harness,
        "bind_mcp_server_credentials",
        {
          server_profile_id: profileId,
          binding_mode: "hosted_token_exchange",
          broker_profile_id: "mcp_secret_external_worker_operator",
          scope_labels: ["remote:mcp", "hosted"],
        },
        sessionId,
      );
      expect(bindResponse.ok).toBe(true);

      const activateResponse = await sendRequest(
        harness,
        "activate_mcp_server_profile",
        {
          server_profile_id: profileId,
        },
        sessionId,
      );
      expect(activateResponse.ok).toBe(true);

      const submitActionResponse = await sendRequest(
        harness,
        "submit_action_attempt",
        {
          attempt: {
            run_id: runId,
            tool_registration: {
              tool_name: "mcp_call_tool",
              tool_kind: "mcp",
            },
            raw_call: {
              server_id: profileId,
              server_profile_id: profileId,
              execution_mode_requested: "hosted_delegated",
              tool_name: "echo_note",
              arguments: {
                note: "external-worker-operator-call",
              },
            },
            environment_context: {
              workspace_roots: [harness.workspaceRoot],
              cwd: harness.workspaceRoot,
              credential_mode: "none",
            },
            framework_context: {
              agent_name: "agentgit-cli",
              agent_framework: "cli",
            },
            received_at: new Date().toISOString(),
          },
        },
        sessionId,
      );
      expect(submitActionResponse.ok).toBe(false);
      expect(submitActionResponse.error?.code).toBe("CAPABILITY_UNAVAILABLE");

      const diagnosticsResponse = await sendRequest<{
        hosted_worker: {
          status: string;
          reachable: boolean;
          primary_reason: { code: string; message: string } | null;
        } | null;
        hosted_queue: {
          status: string;
          failed_jobs: number;
          queued_jobs: number;
          warnings: string[];
        } | null;
      }>(harness, "diagnostics", {
        sections: ["hosted_worker", "hosted_queue"],
      });
      expect(diagnosticsResponse.ok).toBe(true);
      expect(diagnosticsResponse.result?.hosted_worker).toMatchObject({
        status: "degraded",
        reachable: false,
        primary_reason: {
          code: "HOSTED_WORKER_UNREACHABLE",
        },
      });
      expect(diagnosticsResponse.result?.hosted_queue).toMatchObject({
        status: "degraded",
        failed_jobs: 1,
      });

      const listFailedJobsResponse = await sendRequest<{
        jobs: Array<{
          job_id: string;
          status: string;
          server_profile_id: string;
          attempt_count: number;
        }>;
      }>(harness, "list_hosted_mcp_jobs", {
        server_profile_id: profileId,
        status: "failed",
      });
      expect(listFailedJobsResponse.ok).toBe(true);
      expect(listFailedJobsResponse.result?.jobs).toHaveLength(1);
      expect(listFailedJobsResponse.result?.jobs[0]).toMatchObject({
        status: "failed",
        server_profile_id: profileId,
      });
      const jobId = listFailedJobsResponse.result?.jobs[0]?.job_id;
      expect(jobId).toBeTruthy();

      const inspectFailedJobResponse = await sendRequest<{
        job: {
          job_id: string;
          current_lease_id: string | null;
        };
        lifecycle: {
          state: string;
          dead_lettered: boolean;
          eligible_for_requeue: boolean;
          retry_budget_remaining: number;
        };
        leases: Array<{ lease_id: string }>;
        attestations: Array<{ attestation_id: string }>;
        recent_events: Array<{ event_type: string }>;
      }>(harness, "get_hosted_mcp_job", {
        job_id: jobId,
      });
      expect(inspectFailedJobResponse.ok).toBe(true);
      expect(inspectFailedJobResponse.result?.lifecycle).toMatchObject({
        state: "dead_letter_retryable",
        dead_lettered: true,
        eligible_for_requeue: true,
        retry_budget_remaining: 0,
      });
      expect(inspectFailedJobResponse.result?.leases.length).toBeGreaterThan(0);
      expect(
        inspectFailedJobResponse.result?.recent_events.some(
          (event) => event.event_type === "mcp_hosted_job_dead_lettered",
        ),
      ).toBe(true);

      worker = await startHostedMcpWorkerServer({
        endpoint: `unix:${workerSocketPath}`,
        attestationKeyPath: path.join(tempRoot, "worker-key.json"),
        controlToken: workerToken,
      });

      const requeueResponse = await sendRequest<{
        job: {
          job_id: string;
          status: string;
          next_attempt_at: string;
        };
        requeued: boolean;
        previous_status: string;
      }>(
        harness,
        "requeue_hosted_mcp_job",
        {
          job_id: jobId,
          reset_attempt_count: true,
          max_attempts: 6,
          reason: "worker restored",
        },
        sessionId,
      );
      expect(requeueResponse.ok).toBe(true);
      expect(requeueResponse.result).toMatchObject({
        requeued: true,
        previous_status: "failed",
        attempt_count_reset: true,
        max_attempts_updated: true,
        job: {
          job_id: jobId,
          status: "queued",
          max_attempts: 6,
          attempt_count: 0,
        },
      });

      const hostPolicyRegistry = new McpPublicHostPolicyRegistry({
        dbPath: path.join(harness.tempRoot, "mcp", "host-policies.db"),
      });
      const registry = new McpServerRegistry({
        dbPath: path.join(harness.tempRoot, "mcp", "registry.db"),
        publicHostPolicyRegistry: hostPolicyRegistry,
      });
      try {
        const completedJob = await waitFor(
          () => registry.listHostedExecutionJobs(profileId)[0] ?? null,
          (job) => job !== null && job.status === "succeeded",
        );
        expect(completedJob).toMatchObject({
          job_id: jobId,
          status: "succeeded",
        });
        expect(completedJob?.attempt_count).toBe(1);
        expect(completedJob?.max_attempts).toBe(6);

        const listSucceededJobsResponse = await sendRequest<{
          jobs: Array<{
            job_id: string;
            status: string;
          }>;
        }>(harness, "list_hosted_mcp_jobs", {
          server_profile_id: profileId,
          status: "succeeded",
        });
        expect(listSucceededJobsResponse.ok).toBe(true);
        expect(listSucceededJobsResponse.result?.jobs).toEqual([
          expect.objectContaining({
            job_id: jobId,
            status: "succeeded",
          }),
        ]);

        const inspectSucceededJobResponse = await sendRequest<{
          lifecycle: {
            state: string;
            dead_lettered: boolean;
            eligible_for_requeue: boolean;
          };
          recent_events: Array<{ event_type: string; payload: Record<string, unknown> | null }>;
        }>(harness, "get_hosted_mcp_job", {
          job_id: jobId,
        });
        expect(inspectSucceededJobResponse.ok).toBe(true);
        expect(inspectSucceededJobResponse.result?.lifecycle).toMatchObject({
          state: "succeeded",
          dead_lettered: false,
          eligible_for_requeue: false,
        });
        expect(
          inspectSucceededJobResponse.result?.recent_events.some(
            (event) =>
              event.event_type === "mcp_hosted_job_requeued" &&
              event.payload?.attempt_count_reset === true &&
              event.payload?.new_max_attempts === 6,
          ),
        ).toBe(true);

        const recoveredDiagnosticsResponse = await sendRequest<{
          hosted_queue: {
            failed_jobs: number;
            queued_jobs: number;
            running_jobs: number;
          } | null;
        }>(harness, "diagnostics", {
          sections: ["hosted_queue"],
        });
        expect(recoveredDiagnosticsResponse.ok).toBe(true);
        expect(recoveredDiagnosticsResponse.result?.hosted_queue).toMatchObject({
          failed_jobs: 0,
          queued_jobs: 0,
        });
      } finally {
        registry.close();
        hostPolicyRegistry.close();
      }
    } finally {
      await service.close();
      if (worker) {
        await new Promise<void>((resolve, reject) => {
          worker.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      }
    }
  }, 25_000);

  it("reviews remote MCP onboarding explicitly through candidate and profile inspection", async () => {
    const harness = await createHarness();
    const { sessionId } = await createSessionAndRun(harness, "mcp-review-surface");
    const service = await startMcpHttpService({
      requireBearerTokenForToolCallsOnly: "review-mcp-token",
    });

    try {
      const submitResponse = await sendRequest<{ candidate: { candidate_id: string } }>(
        harness,
        "submit_mcp_server_candidate",
        {
          candidate: {
            source_kind: "agent_discovered",
            raw_endpoint: service.url,
          },
        },
        sessionId,
      );
      expect(submitResponse.ok).toBe(true);
      const candidateId = submitResponse.result?.candidate.candidate_id as string;

      const preResolveReview = await sendRequest<{
        review: {
          requires_resolution: boolean;
          requires_approval: boolean;
        };
        candidate: { candidate_id: string } | null;
        profile: null;
      }>(harness, "get_mcp_server_review", {
        candidate_id: candidateId,
      });
      expect(preResolveReview.ok).toBe(true);
      expect(preResolveReview.result?.review).toMatchObject({
        requires_resolution: true,
        requires_approval: false,
      });
      expect(preResolveReview.result?.candidate?.candidate_id).toBe(candidateId);
      expect(preResolveReview.result?.profile).toBeNull();

      const resolveResponse = await sendRequest<{ profile: { server_profile_id: string } }>(
        harness,
        "resolve_mcp_server_candidate",
        {
          candidate_id: candidateId,
          display_name: "Review Surface MCP",
        },
        sessionId,
      );
      expect(resolveResponse.ok).toBe(true);
      const profileId = resolveResponse.result?.profile.server_profile_id as string;

      const profileReview = await sendRequest<{
        review: {
          requires_resolution: boolean;
          requires_approval: boolean;
          requires_credentials: boolean;
          hosted_execution_supported: boolean;
        };
        candidate: { candidate_id: string } | null;
        profile: { server_profile_id: string; status: string } | null;
      }>(harness, "get_mcp_server_review", {
        server_profile_id: profileId,
      });
      expect(profileReview.ok).toBe(true);
      expect(profileReview.result?.candidate?.candidate_id).toBe(candidateId);
      expect(profileReview.result?.profile).toMatchObject({
        server_profile_id: profileId,
        status: "draft",
      });
      expect(profileReview.result?.review).toMatchObject({
        requires_resolution: false,
        requires_approval: true,
        requires_credentials: false,
        hosted_execution_supported: false,
      });
    } finally {
      await service.close();
    }
  });

  it("cancels running hosted delegated MCP jobs cooperatively and records terminal cancellation state", async () => {
    harnessSequence += 1;
    const tempRoot = path.join(TEST_TMP_ROOT, `external-worker-cancel-${harnessSequence}`);
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.mkdirSync(tempRoot, { recursive: true });
    const workerSocketPath = path.join(tempRoot, "worker.sock");
    const workerToken = "external-worker-cancel-token";
    const harness = await createHarness(tempRoot, null, null, {
      mcpHostedWorkerEndpoint: `unix:${workerSocketPath}`,
      mcpHostedWorkerAutostart: false,
      mcpHostedWorkerControlToken: workerToken,
      mcpHostedWorkerAttestationKeyPath: path.join(tempRoot, "worker-key.json"),
    });
    const { sessionId, runId } = await createSessionAndRun(harness, "mcp-hosted-cancel");
    const service = await startMcpHttpService({
      requireBearerTokenForToolCallsOnly: "external-worker-cancel-mcp-token",
      scenario: "delayed_call",
    });
    const worker = await startHostedMcpWorkerServer({
      endpoint: `unix:${workerSocketPath}`,
      attestationKeyPath: path.join(tempRoot, "worker-key.json"),
      controlToken: workerToken,
    });

    try {
      const candidateResponse = await sendRequest<{ candidate: { candidate_id: string } }>(
        harness,
        "submit_mcp_server_candidate",
        {
          candidate: {
            source_kind: "agent_discovered",
            raw_endpoint: service.url,
          },
        },
        sessionId,
      );
      const candidateId = candidateResponse.result?.candidate.candidate_id as string;

      const resolveResponse = await sendRequest<{ profile: { server_profile_id: string } }>(
        harness,
        "resolve_mcp_server_candidate",
        {
          candidate_id: candidateId,
          display_name: "Cancelable Hosted MCP",
        },
        sessionId,
      );
      const profileId = resolveResponse.result?.profile.server_profile_id as string;

      await sendRequest(
        harness,
        "approve_mcp_server_profile",
        {
          server_profile_id: profileId,
          decision: "allow_policy_managed",
          trust_tier: "operator_approved_public",
          allowed_execution_modes: ["hosted_delegated"],
          reason_codes: ["HOSTED_OPERATOR_APPROVED"],
        },
        sessionId,
      );
      await sendRequest(
        harness,
        "upsert_mcp_secret",
        {
          secret: {
            secret_id: "mcp_secret_external_worker_cancel",
            display_name: "External worker cancel secret",
            bearer_token: "external-worker-cancel-mcp-token",
          },
        },
        sessionId,
      );
      await sendRequest(
        harness,
        "bind_mcp_server_credentials",
        {
          server_profile_id: profileId,
          binding_mode: "hosted_token_exchange",
          broker_profile_id: "mcp_secret_external_worker_cancel",
          scope_labels: ["remote:mcp", "hosted"],
        },
        sessionId,
      );
      await sendRequest(
        harness,
        "activate_mcp_server_profile",
        {
          server_profile_id: profileId,
        },
        sessionId,
      );

      const submitActionPromise = sendRequest(
        harness,
        "submit_action_attempt",
        {
          attempt: {
            run_id: runId,
            tool_registration: {
              tool_name: "mcp_call_tool",
              tool_kind: "mcp",
            },
            raw_call: {
              server_id: profileId,
              server_profile_id: profileId,
              execution_mode_requested: "hosted_delegated",
              tool_name: "echo_note",
              arguments: {
                note: "external-worker-cancel-call",
              },
            },
            environment_context: {
              workspace_roots: [harness.workspaceRoot],
              cwd: harness.workspaceRoot,
              credential_mode: "none",
            },
            framework_context: {
              agent_name: "agentgit-cli",
              agent_framework: "cli",
            },
            received_at: new Date().toISOString(),
          },
        },
        sessionId,
      );

      const hostPolicyRegistry = new McpPublicHostPolicyRegistry({
        dbPath: path.join(harness.tempRoot, "mcp", "host-policies.db"),
      });
      const registry = new McpServerRegistry({
        dbPath: path.join(harness.tempRoot, "mcp", "registry.db"),
        publicHostPolicyRegistry: hostPolicyRegistry,
      });
      try {
        const runningJob = await waitFor(
          () => registry.listHostedExecutionJobs(profileId)[0] ?? null,
          (job) => job !== null && job.status === "running",
        );
        expect(runningJob?.job_id).toBeTruthy();
        const jobId = runningJob?.job_id as string;

        const cancelResponse = await sendRequest<{
          job: {
            job_id: string;
            status: string;
            cancel_reason: string | null;
          };
          previous_status: string;
          cancellation_requested: boolean;
          terminal: boolean;
        }>(
          harness,
          "cancel_hosted_mcp_job",
          {
            job_id: jobId,
            reason: "operator stop",
          },
          sessionId,
        );
        expect(cancelResponse.ok).toBe(true);
        expect(cancelResponse.result).toMatchObject({
          previous_status: "running",
          cancellation_requested: true,
          terminal: false,
          job: {
            job_id: jobId,
            status: "cancel_requested",
            cancel_reason: "operator stop",
          },
        });

        const submitActionResponse = await submitActionPromise;
        expect(submitActionResponse.ok).toBe(false);
        expect(submitActionResponse.error?.code).toBe("CONFLICT");

        const canceledJob = await waitFor(
          () => registry.getHostedExecutionJob(jobId),
          (job) => job !== null && job.status === "canceled",
        );
        expect(canceledJob).toMatchObject({
          job_id: jobId,
          status: "canceled",
          cancel_reason: "operator stop",
        });

        const inspectCanceledJobResponse = await sendRequest<{
          lifecycle: {
            state: string;
            dead_lettered: boolean;
          };
          recent_events: Array<{ event_type: string }>;
        }>(harness, "get_hosted_mcp_job", {
          job_id: jobId,
        });
        expect(inspectCanceledJobResponse.ok).toBe(true);
        expect(inspectCanceledJobResponse.result?.lifecycle).toMatchObject({
          state: "canceled",
          dead_lettered: false,
        });
        expect(
          inspectCanceledJobResponse.result?.recent_events.some(
            (event) => event.event_type === "mcp_hosted_job_cancel_requested",
          ),
        ).toBe(true);

        const listCanceledJobsResponse = await sendRequest<{
          jobs: Array<{ job_id: string; status: string }>;
          summary: {
            canceled: number;
            dead_letter_retryable: number;
          };
        }>(harness, "list_hosted_mcp_jobs", {
          server_profile_id: profileId,
          lifecycle_state: "canceled",
        });
        expect(listCanceledJobsResponse.ok).toBe(true);
        expect(listCanceledJobsResponse.result?.summary).toMatchObject({
          canceled: 1,
          dead_letter_retryable: 0,
        });
        expect(listCanceledJobsResponse.result?.jobs).toEqual([
          expect.objectContaining({
            job_id: jobId,
            status: "canceled",
          }),
        ]);
      } finally {
        registry.close();
        hostPolicyRegistry.close();
      }
    } finally {
      await service.close();
      await new Promise<void>((resolve, reject) => {
        worker.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  }, 25_000);

  it("manages MCP secrets and public host policies through the daemon API without leaking bearer values", async () => {
    const harness = await createHarness();
    const { sessionId } = await createSessionAndRun(harness, "mcp-admin-surfaces");

    const upsertSecretResponse = await sendRequest<{
      created: boolean;
      rotated: boolean;
      secret: {
        secret_id: string;
        version: number;
        rotated_at: string | null;
        last_used_at: string | null;
      };
    }>(
      harness,
      "upsert_mcp_secret",
      {
        secret: {
          secret_id: "mcp_secret_notion",
          display_name: "Notion MCP",
          bearer_token: "notion-secret-token",
        },
      },
      sessionId,
    );
    expect(upsertSecretResponse.ok).toBe(true);
    expect(upsertSecretResponse.result?.created).toBe(true);
    expect(upsertSecretResponse.result?.rotated).toBe(false);
    expect(upsertSecretResponse.result?.secret.secret_id).toBe("mcp_secret_notion");

    const listSecretsResponse = await sendRequest<{
      secrets: Array<Record<string, unknown>>;
    }>(harness, "list_mcp_secrets", {}, sessionId);
    expect(listSecretsResponse.ok).toBe(true);
    expect(listSecretsResponse.result?.secrets).toEqual([
      expect.objectContaining({
        secret_id: "mcp_secret_notion",
        version: 1,
        last_used_at: null,
      }),
    ]);
    expect(JSON.stringify(listSecretsResponse.result?.secrets)).not.toContain("notion-secret-token");

    const upsertHostPolicyResponse = await sendRequest<{
      created: boolean;
      policy: {
        policy: {
          host: string;
          allowed_ports: number[];
        };
      };
    }>(
      harness,
      "upsert_mcp_host_policy",
      {
        policy: {
          host: "api.notion.com",
          display_name: "Notion API",
          allow_subdomains: false,
          allowed_ports: [443],
        },
      },
      sessionId,
    );
    expect(upsertHostPolicyResponse.ok).toBe(true);
    expect(upsertHostPolicyResponse.result?.created).toBe(true);
    expect(upsertHostPolicyResponse.result?.policy.policy.host).toBe("api.notion.com");

    const listHostPoliciesResponse = await sendRequest<{
      policies: Array<Record<string, unknown>>;
    }>(harness, "list_mcp_host_policies", {}, sessionId);
    expect(listHostPoliciesResponse.ok).toBe(true);
    expect(listHostPoliciesResponse.result?.policies).toEqual([
      expect.objectContaining({
        policy: expect.objectContaining({
          host: "api.notion.com",
          allowed_ports: [443],
        }),
      }),
    ]);

    const removeHostPolicyResponse = await sendRequest<{
      removed: boolean;
      removed_policy: { policy: { host: string } } | null;
    }>(
      harness,
      "remove_mcp_host_policy",
      {
        host: "api.notion.com",
      },
      sessionId,
    );
    expect(removeHostPolicyResponse.ok).toBe(true);
    expect(removeHostPolicyResponse.result?.removed).toBe(true);
    expect(removeHostPolicyResponse.result?.removed_policy?.policy.host).toBe("api.notion.com");

    const removeSecretResponse = await sendRequest<{
      removed: boolean;
      removed_secret: { secret_id: string } | null;
    }>(
      harness,
      "remove_mcp_secret",
      {
        secret_id: "mcp_secret_notion",
      },
      sessionId,
    );
    expect(removeSecretResponse.ok).toBe(true);
    expect(removeSecretResponse.result?.removed).toBe(true);
    expect(removeSecretResponse.result?.removed_secret?.secret_id).toBe("mcp_secret_notion");
  }, 20_000);

  it("executes an operator-registered streamable_http MCP tool through the full request pipeline", async () => {
    const service = await startMcpHttpService({
      requireBearerToken: "daemon-http-secret",
    });
    process.env.AGENTGIT_TEST_MCP_HTTP_TOKEN = "daemon-http-secret";

    try {
      const harness = await createHarness();
      const { sessionId, runId } = await createSessionAndRun(harness, "mcp-http-read-only");

      const upsertResponse = await sendRequest<{
        created: boolean;
      }>(
        harness,
        "upsert_mcp_server",
        {
          server: {
            server_id: "notes_http",
            display_name: "Notes HTTP server",
            transport: "streamable_http",
            url: service.url,
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
        },
        sessionId,
      );
      expect(upsertResponse.ok).toBe(true);

      const submitResponse = await sendRequest<{
        execution_result: { mode: string; success: boolean; output: Record<string, unknown> } | null;
      }>(
        harness,
        "submit_action_attempt",
        {
          attempt: makeMcpAttempt(runId, harness.workspaceRoot, {
            serverId: "notes_http",
            toolName: "echo_note",
            arguments: {
              note: "launch blocker",
            },
          }),
        },
        sessionId,
      );

      expect(submitResponse.ok).toBe(true);
      expect(submitResponse.result?.execution_result?.mode).toBe("executed");
      expect(submitResponse.result?.execution_result?.success).toBe(true);
      expect(submitResponse.result?.execution_result?.output.server_id).toBe("notes_http");
      expect(submitResponse.result?.execution_result?.output.transport).toBe("streamable_http");
      expect(submitResponse.result?.execution_result?.output.summary).toBe("http-echo:launch blocker");
    } finally {
      delete process.env.AGENTGIT_TEST_MCP_HTTP_TOKEN;
      await service.close();
    }
  });

  it("executes an operator-registered streamable_http MCP tool with a durable secret reference", async () => {
    const service = await startMcpHttpService({
      requireBearerToken: "daemon-secret-ref-token",
    });

    try {
      const harness = await createHarness();
      const { sessionId, runId } = await createSessionAndRun(harness, "mcp-http-secret-ref");

      const upsertSecretResponse = await sendRequest<{
        created: boolean;
      }>(
        harness,
        "upsert_mcp_secret",
        {
          secret: {
            secret_id: "mcp_secret_notes_http",
            display_name: "Notes HTTP MCP",
            bearer_token: "daemon-secret-ref-token",
          },
        },
        sessionId,
      );
      expect(upsertSecretResponse.ok).toBe(true);

      const upsertServerResponse = await sendRequest<{
        created: boolean;
      }>(
        harness,
        "upsert_mcp_server",
        {
          server: {
            server_id: "notes_http_secret_ref",
            display_name: "Notes HTTP secret ref",
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
        },
        sessionId,
      );
      expect(upsertServerResponse.ok).toBe(true);

      const submitResponse = await sendRequest<{
        execution_result: { mode: string; success: boolean; output: Record<string, unknown> } | null;
      }>(
        harness,
        "submit_action_attempt",
        {
          attempt: makeMcpAttempt(runId, harness.workspaceRoot, {
            serverId: "notes_http_secret_ref",
            toolName: "echo_note",
            arguments: {
              note: "launch blocker",
            },
          }),
        },
        sessionId,
      );

      expect(submitResponse.ok).toBe(true);
      expect(submitResponse.result?.execution_result?.mode).toBe("executed");
      expect(submitResponse.result?.execution_result?.success).toBe(true);
      expect(submitResponse.result?.execution_result?.output.server_id).toBe("notes_http_secret_ref");
      expect(submitResponse.result?.execution_result?.output.transport).toBe("streamable_http");
      expect(submitResponse.result?.execution_result?.output.summary).toBe("http-echo:launch blocker");
      expect(submitResponse.result?.execution_result?.output.auth_type).toBe("bearer_secret_ref");

      const listSecretsResponse = await sendRequest<{
        secrets: Array<{
          secret_id: string;
          last_used_at: string | null;
        }>;
      }>(harness, "list_mcp_secrets", {}, sessionId);
      expect(listSecretsResponse.ok).toBe(true);
      expect(listSecretsResponse.result?.secrets).toEqual([
        expect.objectContaining({
          secret_id: "mcp_secret_notes_http",
          last_used_at: expect.any(String),
        }),
      ]);
    } finally {
      await service.close();
    }
  });

  it("fails closed when an operator attempts to register a non-local streamable_http MCP server", async () => {
    const harness = await createHarness();
    const { sessionId } = await createSessionAndRun(harness, "mcp-http-non-local");

    const upsertResponse = await sendRequest(
      harness,
      "upsert_mcp_server",
      {
        server: {
          server_id: "notes_remote",
          transport: "streamable_http",
          url: "https://example.com/mcp",
          tools: [
            {
              tool_name: "echo_note",
              side_effect_level: "read_only",
              approval_mode: "allow",
            },
          ],
        },
      },
      sessionId,
    );

    expect(upsertResponse.ok).toBe(false);
    expect(upsertResponse.error?.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(upsertResponse.error?.message).toContain("local loopback URLs");
    expect(upsertResponse.error?.details).toMatchObject({
      server_id: "notes_remote",
      transport: "streamable_http",
      hostname: "example.com",
    });
  });

  it("allows explicit private-network streamable_http MCP registration through daemon APIs", async () => {
    const harness = await createHarness();
    const { sessionId } = await createSessionAndRun(harness, "mcp-http-private-network");

    const upsertResponse = await sendRequest<{
      created: boolean;
      server: {
        server: {
          server_id: string;
          transport: string;
          url: string;
          network_scope: string;
          max_concurrent_calls: number;
        };
      };
    }>(
      harness,
      "upsert_mcp_server",
      {
        server: {
          server_id: "notes_private",
          transport: "streamable_http",
          url: "http://10.24.3.11:3010/mcp",
          network_scope: "private",
          max_concurrent_calls: 2,
          tools: [
            {
              tool_name: "echo_note",
              side_effect_level: "read_only",
              approval_mode: "allow",
            },
          ],
        },
      },
      sessionId,
    );

    expect(upsertResponse.ok).toBe(true);
    expect(upsertResponse.result?.created).toBe(true);
    expect(upsertResponse.result?.server.server).toMatchObject({
      server_id: "notes_private",
      transport: "streamable_http",
      url: "http://10.24.3.11:3010/mcp",
      network_scope: "private",
      max_concurrent_calls: 2,
    });
  });

  it("allows explicit public HTTPS streamable_http MCP registration with bearer auth", async () => {
    const harness = await createHarness();
    const { sessionId } = await createSessionAndRun(harness, "mcp-http-public-https");

    const hostPolicyResponse = await sendRequest<{
      created: boolean;
    }>(
      harness,
      "upsert_mcp_host_policy",
      {
        policy: {
          host: "api.example.com",
          display_name: "Example API",
          allow_subdomains: false,
          allowed_ports: [443],
        },
      },
      sessionId,
    );
    expect(hostPolicyResponse.ok).toBe(true);

    const upsertResponse = await sendRequest<{
      created: boolean;
      server: {
        server: {
          server_id: string;
          transport: string;
          url: string;
          network_scope: string;
          max_concurrent_calls: number;
          auth: {
            type: string;
            bearer_env_var: string;
          };
        };
      };
    }>(
      harness,
      "upsert_mcp_server",
      {
        server: {
          server_id: "notes_public",
          transport: "streamable_http",
          url: "https://api.example.com/mcp",
          network_scope: "public_https",
          max_concurrent_calls: 2,
          auth: {
            type: "bearer_env",
            bearer_env_var: "AGENTGIT_PUBLIC_MCP_TOKEN",
          },
          tools: [
            {
              tool_name: "echo_note",
              side_effect_level: "read_only",
              approval_mode: "allow",
            },
          ],
        },
      },
      sessionId,
    );

    expect(upsertResponse.ok).toBe(true);
    expect(upsertResponse.result?.created).toBe(true);
    expect(upsertResponse.result?.server.server).toMatchObject({
      server_id: "notes_public",
      transport: "streamable_http",
      url: "https://api.example.com/mcp",
      network_scope: "public_https",
      max_concurrent_calls: 2,
      auth: {
        type: "bearer_env",
        bearer_env_var: "AGENTGIT_PUBLIC_MCP_TOKEN",
      },
    });
  });

  it("fails closed for public HTTPS streamable_http MCP registration without bearer auth", async () => {
    const harness = await createHarness();
    const { sessionId } = await createSessionAndRun(harness, "mcp-http-public-https-no-auth");

    const upsertResponse = await sendRequest(
      harness,
      "upsert_mcp_server",
      {
        server: {
          server_id: "notes_public_no_auth",
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
      },
      sessionId,
    );

    expect(upsertResponse.ok).toBe(false);
    expect(upsertResponse.error?.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(upsertResponse.error?.message).toContain(
      "requires operator-managed bearer authentication backed by a secret reference or legacy env configuration",
    );
  });

  it("persists operator-registered MCP servers across daemon restart", async () => {
    const harness = await createHarness();
    const { sessionId } = await createSessionAndRun(harness, "mcp-registry-persist");
    const service = await startMcpHttpService();

    const upsertResponse = await sendRequest<{
      created: boolean;
    }>(
      harness,
      "upsert_mcp_server",
      {
        server: {
          server_id: "notes_server",
          transport: "streamable_http",
          url: service.url,
          tools: [
            {
              tool_name: "echo_note",
              side_effect_level: "read_only",
              approval_mode: "allow",
            },
          ],
        },
      },
      sessionId,
    );
    expect(upsertResponse.ok).toBe(true);

    await restartHarness(harness);
    const { sessionId: restartedSessionId, runId } = await createSessionAndRun(
      harness,
      "mcp-registry-persist-restarted",
    );

    const listResponse = await sendRequest<{
      servers: Array<{ server: { server_id: string } }>;
    }>(harness, "list_mcp_servers", {}, restartedSessionId);
    expect(listResponse.ok).toBe(true);
    expect(listResponse.result?.servers.map((record) => record.server.server_id)).toContain("notes_server");

    const submitResponse = await sendRequest<{
      execution_result: { success: boolean; output: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeMcpAttempt(runId, harness.workspaceRoot, {
          toolName: "echo_note",
          arguments: {
            note: "after restart",
          },
        }),
      },
      restartedSessionId,
    );

    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.execution_result?.success).toBe(true);
    expect(submitResponse.result?.execution_result?.output.summary).toBe("http-echo:after restart");
    await service.close();
  });

  it("imports bootstrap MCP env config into the durable registry and keeps it after restart", async () => {
    process.env.AGENTGIT_MCP_SERVERS_JSON = JSON.stringify([
      {
        ...buildSandboxedStdioServer("notes_server"),
        tools: [
          {
            tool_name: "echo_note",
            side_effect_level: "read_only",
            approval_mode: "allow",
          },
        ],
      },
    ]);

    const harness = await createHarness();
    const helloResponse = await sendRequest<{ session_id: string }>(harness, "hello", {
      client_type: "cli",
      client_version: "0.1.0",
      requested_api_version: API_VERSION,
      workspace_roots: [harness.workspaceRoot],
    });
    if (!helloResponse.ok) {
      throw new Error(JSON.stringify(helloResponse.error));
    }

    const sessionId = helloResponse.result!.session_id;
    const initialList = await sendRequest<{
      servers: Array<{ source: string; server: { server_id: string } }>;
    }>(harness, "list_mcp_servers", {}, sessionId);
    expect(initialList.ok).toBe(true);
    expect(initialList.result?.servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "bootstrap_env",
          server: expect.objectContaining({
            server_id: "notes_server",
          }),
        }),
      ]),
    );

    delete process.env.AGENTGIT_MCP_SERVERS_JSON;
    await restartHarness(harness);

    const restartedHello = await sendRequest<{ session_id: string }>(harness, "hello", {
      client_type: "cli",
      client_version: "0.1.0",
      requested_api_version: API_VERSION,
      workspace_roots: [harness.workspaceRoot],
    });
    if (!restartedHello.ok) {
      throw new Error(JSON.stringify(restartedHello.error));
    }

    const restartedList = await sendRequest<{
      servers: Array<{ source: string; server: { server_id: string } }>;
    }>(harness, "list_mcp_servers", {}, restartedHello.result!.session_id);
    expect(restartedList.ok).toBe(true);
    expect(restartedList.result?.servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "bootstrap_env",
          server: expect.objectContaining({
            server_id: "notes_server",
          }),
        }),
      ]),
    );
  });

  it("returns a retryable storage failure when destructive snapshot capture hits low disk pressure", async () => {
    vi.spyOn(LocalSnapshotEngine.prototype, "createSnapshot").mockRejectedValueOnce(
      new AgentGitError(
        "Failed to create workspace snapshot.",
        "STORAGE_UNAVAILABLE",
        {
          low_disk_pressure: true,
          storage_error_code: "ENOSPC",
          retry_hint: "Free disk space, then retry.",
        },
        true,
      ),
    );

    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "filesystem-delete-low-disk");
    const targetPath = path.join(harness.workspaceRoot, "notes.txt");
    fs.writeFileSync(targetPath, "before", "utf8");

    const submitResponse = await sendRequest(
      harness,
      "submit_action_attempt",
      {
        attempt: makeFilesystemDeleteAttempt(runId, harness.workspaceRoot, targetPath),
      },
      sessionId,
    );

    expect(submitResponse.ok).toBe(false);
    expect(submitResponse.error?.code).toBe("STORAGE_UNAVAILABLE");
    expect(submitResponse.error?.retryable).toBe(true);
    expect(submitResponse.error?.details?.low_disk_pressure).toBe(true);
    expect(submitResponse.error?.details?.storage_error_code).toBe("ENOSPC");
    expect(fs.readFileSync(targetPath, "utf8")).toBe("before");
  });

  it("creates an approval request and executes an approved shell command for real", async () => {
    const harness = await createHarness();
    writeShellApprovalPolicy(harness.workspaceRoot);
    await restartHarness(harness);
    const { sessionId, runId } = await createSessionAndRun(harness, "approval-flow");

    const submitResponse = await sendRequest<{
      approval_request: {
        approval_id: string;
        status: string;
        primary_reason?: { code: string; message: string } | null;
      } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeShellAttempt(runId, harness.workspaceRoot, [
          process.execPath,
          "-e",
          "process.stdout.write('approved-shell-run')",
        ]),
      },
      sessionId,
    );

    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.approval_request?.status).toBe("pending");
    expect(submitResponse.result?.approval_request?.primary_reason?.code).toBe("WORKSPACE_SHELL_REQUIRES_APPROVAL");

    const inboxBeforeResolution = await sendRequest<{
      items: Array<{
        approval_id: string;
        action_summary: string;
        workflow_name: string;
        reason_summary: string | null;
        primary_reason?: { code: string; message: string } | null;
        status: string;
      }>;
      counts: { pending: number; approved: number; denied: number };
    }>(harness, "query_approval_inbox", { run_id: runId }, sessionId);
    expect(inboxBeforeResolution.ok).toBe(true);
    expect(inboxBeforeResolution.result?.counts.pending).toBe(1);
    expect(inboxBeforeResolution.result?.items[0]?.approval_id).toBe(
      submitResponse.result?.approval_request?.approval_id,
    );
    expect(inboxBeforeResolution.result?.items[0]?.workflow_name).toBe("approval-flow");
    expect(inboxBeforeResolution.result?.items[0]?.status).toBe("pending");
    expect(inboxBeforeResolution.result?.items[0]?.reason_summary).toContain("requires approval");
    expect(inboxBeforeResolution.result?.items[0]?.primary_reason?.code).toBe("WORKSPACE_SHELL_REQUIRES_APPROVAL");

    const timelineBeforeResolution = await sendRequest<{
      steps: Array<{
        step_id: string;
        step_type: string;
        status: string;
        action_id: string | null;
        primary_reason?: { code: string; message: string } | null;
      }>;
    }>(harness, "query_timeline", { run_id: runId }, sessionId);
    expect(timelineBeforeResolution.ok).toBe(true);
    const approvalStep = timelineBeforeResolution.result?.steps.find((step) => step.step_type === "approval_step");
    expect(approvalStep?.status).toBe("awaiting_approval");
    expect(approvalStep?.primary_reason?.code).toBe("WORKSPACE_SHELL_REQUIRES_APPROVAL");
    const blockedActionStep = timelineBeforeResolution.result?.steps.find(
      (step) => step.step_type === "action_step" && step.status === "awaiting_approval",
    );
    expect(blockedActionStep?.primary_reason?.code).toBe("WORKSPACE_SHELL_REQUIRES_APPROVAL");

    const helperBeforeResolution = await sendRequest<{
      answer: string;
      primary_reason?: { code: string; message: string } | null;
    }>(harness, "query_helper", { run_id: runId, question_type: "why_blocked" }, sessionId);
    expect(helperBeforeResolution.ok).toBe(true);
    expect(helperBeforeResolution.result?.answer).toContain("waiting for approval");
    expect(helperBeforeResolution.result?.primary_reason?.code).toBe("WORKSPACE_SHELL_REQUIRES_APPROVAL");

    const approvalId = submitResponse.result?.approval_request?.approval_id as string;
    const resolveResponse = await sendRequest<{
      execution_result: {
        mode: string;
        output?: Record<string, unknown>;
      } | null;
    }>(
      harness,
      "resolve_approval",
      {
        approval_id: approvalId,
        resolution: "approved",
        note: "integration approval",
      },
      sessionId,
    );

    expect(resolveResponse.ok).toBe(true);
    expect(resolveResponse.result?.execution_result?.mode).toBe("executed");
    expect(resolveResponse.result?.execution_result?.output?.stdout).toBe("approved-shell-run");

    const timelineResponse = await sendRequest<{
      steps: Array<{ step_type: string; summary: string }>;
    }>(harness, "query_timeline", { run_id: runId }, sessionId);
    expect(timelineResponse.ok).toBe(true);
    expect(
      timelineResponse.result?.steps.some(
        (step) =>
          step.step_type === "action_step" &&
          step.summary.includes("Executed") &&
          step.summary.includes("after approval."),
      ),
    ).toBe(true);
    expect(timelineResponse.result?.steps.some((step) => step.step_type === "approval_step")).toBe(true);

    const inboxAfterResolution = await sendRequest<{
      items: Array<{ status: string; resolution_note: string | null }>;
      counts: { pending: number; approved: number; denied: number };
    }>(harness, "query_approval_inbox", { run_id: runId }, sessionId);
    expect(inboxAfterResolution.ok).toBe(true);
    expect(inboxAfterResolution.result?.counts.pending).toBe(0);
    expect(inboxAfterResolution.result?.counts.approved).toBe(1);
    expect(inboxAfterResolution.result?.items[0]?.status).toBe("approved");
    expect(inboxAfterResolution.result?.items[0]?.resolution_note).toBe("integration approval");

    const summaryResponse = await sendRequest<{
      run: { budget_usage: { mutating_actions: number; destructive_actions: number } };
    }>(harness, "get_run_summary", { run_id: runId }, sessionId);
    expect(summaryResponse.result?.run.budget_usage.mutating_actions).toBe(1);
    expect(summaryResponse.result?.run.budget_usage.destructive_actions).toBe(0);
  });

  it("scopes approvals and action submission to the owning session", async () => {
    const harness = await createHarness();
    writeShellApprovalPolicy(harness.workspaceRoot);
    await restartHarness(harness);
    const owner = await createSessionAndRun(harness, "approval-owner");
    const intruderWorkspaceRoot = `${harness.workspaceRoot}-intruder`;
    fs.mkdirSync(intruderWorkspaceRoot, { recursive: true });
    const intruder = await createSessionAndRunForWorkspaceRoot(harness, intruderWorkspaceRoot, "approval-intruder");
    const targetPath = path.join(harness.workspaceRoot, "cross-session-blocked.txt");

    const submitResponse = await sendRequest<{
      approval_request: { approval_id: string; status: string } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeShellAttempt(owner.runId, harness.workspaceRoot, [
          process.execPath,
          "-e",
          "process.stdout.write('pending')",
        ]),
      },
      owner.sessionId,
    );
    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.approval_request?.status).toBe("pending");

    const hiddenList = await sendRequest<{ approvals: unknown[] }>(harness, "list_approvals", {}, intruder.sessionId);
    expect(hiddenList.ok).toBe(true);
    expect(hiddenList.result?.approvals).toHaveLength(0);

    const hiddenInbox = await sendRequest<{
      items: unknown[];
      counts: { pending: number; approved: number; denied: number };
    }>(harness, "query_approval_inbox", {}, intruder.sessionId);
    expect(hiddenInbox.ok).toBe(true);
    expect(hiddenInbox.result?.items).toHaveLength(0);
    expect(hiddenInbox.result?.counts.pending).toBe(0);

    const foreignList = await sendRequest<unknown>(
      harness,
      "list_approvals",
      { run_id: owner.runId },
      intruder.sessionId,
    );
    expect(foreignList.ok).toBe(false);
    expect(foreignList.error?.code).toBe("NOT_FOUND");

    const foreignResolve = await sendRequest<unknown>(
      harness,
      "resolve_approval",
      {
        approval_id: submitResponse.result?.approval_request?.approval_id as string,
        resolution: "approved",
      },
      intruder.sessionId,
    );
    expect(foreignResolve.ok).toBe(false);
    expect(foreignResolve.error?.code).toBe("NOT_FOUND");

    const foreignSubmit = await sendRequest<unknown>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeFilesystemWriteAttempt(owner.runId, harness.workspaceRoot, targetPath, "blocked"),
      },
      intruder.sessionId,
    );
    expect(foreignSubmit.ok).toBe(false);
    expect(foreignSubmit.error?.code).toBe("NOT_FOUND");
    expect(fs.existsSync(targetPath)).toBe(false);
  });

  it("scopes policy analytics and MCP candidate attribution to accessible workspace roots", async () => {
    const harness = await createHarness();
    const owner = await createSessionAndRun(harness, "analytics-owner");
    const intruderWorkspaceRoot = `${harness.workspaceRoot}-intruder`;
    fs.mkdirSync(intruderWorkspaceRoot, { recursive: true });
    const intruder = await createSessionAndRunForWorkspaceRoot(harness, intruderWorkspaceRoot, "analytics-intruder");
    const targetPath = path.join(harness.workspaceRoot, "analytics.txt");

    const submitResponse = await sendRequest<{
      execution_result: { mode: string } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeFilesystemWriteAttempt(owner.runId, harness.workspaceRoot, targetPath, "analytics seed"),
      },
      owner.sessionId,
    );
    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.execution_result?.mode).toBe("executed");

    const reportResponse = await sendRequest<unknown>(
      harness,
      "get_policy_calibration_report",
      { run_id: owner.runId, include_samples: true },
      intruder.sessionId,
    );
    expect(reportResponse.ok).toBe(false);
    expect(reportResponse.error?.code).toBe("NOT_FOUND");

    const recommendationsResponse = await sendRequest<unknown>(
      harness,
      "get_policy_threshold_recommendations",
      { run_id: owner.runId },
      intruder.sessionId,
    );
    expect(recommendationsResponse.ok).toBe(false);
    expect(recommendationsResponse.error?.code).toBe("NOT_FOUND");

    const replayResponse = await sendRequest<unknown>(
      harness,
      "replay_policy_thresholds",
      { run_id: owner.runId, candidate_thresholds: [] },
      intruder.sessionId,
    );
    expect(replayResponse.ok).toBe(false);
    expect(replayResponse.error?.code).toBe("NOT_FOUND");

    const candidateResponse = await sendRequest<unknown>(
      harness,
      "submit_mcp_server_candidate",
      {
        candidate: {
          source_kind: "user_input",
          raw_endpoint: "https://api.example.com/mcp",
          transport_hint: "streamable_http",
          submitted_by_run_id: owner.runId,
        },
      },
      intruder.sessionId,
    );
    expect(candidateResponse.ok).toBe(false);
    expect(candidateResponse.error?.code).toBe("NOT_FOUND");
  });

  it("creates a snapshot for delete and restores it through recovery", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "snapshot-recovery");
    const targetPath = path.join(harness.workspaceRoot, "restore-me.txt");
    fs.writeFileSync(targetPath, "restore this content", "utf8");

    const submitResponse = await sendRequest<{
      action: { action_id: string };
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { mode: string } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeFilesystemDeleteAttempt(runId, harness.workspaceRoot, targetPath),
      },
      sessionId,
    );

    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.snapshot_record?.snapshot_id).toBeTruthy();
    expect(submitResponse.result?.execution_result?.mode).toBe("executed");
    expect(fs.existsSync(targetPath)).toBe(false);

    const actionId = submitResponse.result?.action.action_id as string;
    const snapshotId = submitResponse.result?.snapshot_record?.snapshot_id as string;

    const planResponse = await sendRequest<{
      recovery_plan: { strategy: string; target: { type: string; action_id?: string } };
    }>(harness, "plan_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.strategy).toBe("restore_snapshot");

    const actionPlanResponse = await sendRequest<{
      recovery_plan: { strategy: string; target: { type: string; action_id?: string } };
    }>(harness, "plan_recovery", { target: { type: "action_boundary", action_id: actionId } }, sessionId);
    expect(actionPlanResponse.ok).toBe(true);
    expect(actionPlanResponse.result?.recovery_plan.strategy).toBe("restore_snapshot");
    expect(actionPlanResponse.result?.recovery_plan.target.type).toBe("action_boundary");
    expect(actionPlanResponse.result?.recovery_plan.target.action_id).toBe(actionId);

    const executeResponse = await sendRequest<{
      restored: boolean;
    }>(harness, "execute_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(executeResponse.ok).toBe(true);
    expect(executeResponse.result?.restored).toBe(true);
    expect(fs.readFileSync(targetPath, "utf8")).toBe("restore this content");
  });

  it("scopes run inspection, artifacts, checkpoints, and recovery to the owning session", async () => {
    const harness = await createHarness();
    const owner = await createSessionAndRun(harness, "inspection-owner");
    const intruderWorkspaceRoot = `${harness.workspaceRoot}-intruder`;
    fs.mkdirSync(intruderWorkspaceRoot, { recursive: true });
    const intruder = await createSessionAndRunForWorkspaceRoot(harness, intruderWorkspaceRoot, "inspection-intruder");
    const targetPath = path.join(harness.workspaceRoot, "owned-file.txt");

    const submitResponse = await sendRequest<{
      execution_result: { mode: string } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeFilesystemWriteAttempt(owner.runId, harness.workspaceRoot, targetPath, "owner content"),
      },
      owner.sessionId,
    );
    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.execution_result?.mode).toBe("executed");

    const ownerTimeline = await sendRequest<{
      steps: Array<{ primary_artifacts: Array<{ type: string; artifact_id?: string }> }>;
    }>(harness, "query_timeline", { run_id: owner.runId }, owner.sessionId);
    expect(ownerTimeline.ok).toBe(true);
    const artifactId = ownerTimeline.result?.steps
      .flatMap((step) => step.primary_artifacts)
      .find((artifact) => artifact.type === "file_content" && typeof artifact.artifact_id === "string")?.artifact_id;
    expect(typeof artifactId).toBe("string");

    const checkpointResponse = await sendRequest<{
      run_checkpoint: string;
    }>(
      harness,
      "create_run_checkpoint",
      {
        run_id: owner.runId,
        checkpoint_kind: "branch_point",
        workspace_root: harness.workspaceRoot,
        reason: "ownership regression checkpoint",
      },
      owner.sessionId,
    );
    expect(checkpointResponse.ok).toBe(true);

    const summaryResponse = await sendRequest<unknown>(
      harness,
      "get_run_summary",
      { run_id: owner.runId },
      intruder.sessionId,
    );
    expect(summaryResponse.ok).toBe(false);
    expect(summaryResponse.error?.code).toBe("NOT_FOUND");

    const timelineResponse = await sendRequest<unknown>(
      harness,
      "query_timeline",
      { run_id: owner.runId },
      intruder.sessionId,
    );
    expect(timelineResponse.ok).toBe(false);
    expect(timelineResponse.error?.code).toBe("NOT_FOUND");

    const helperResponse = await sendRequest<unknown>(
      harness,
      "query_helper",
      { run_id: owner.runId, question_type: "what_happened" },
      intruder.sessionId,
    );
    expect(helperResponse.ok).toBe(false);
    expect(helperResponse.error?.code).toBe("NOT_FOUND");

    const artifactResponse = await sendRequest<unknown>(
      harness,
      "query_artifact",
      { artifact_id: artifactId },
      intruder.sessionId,
    );
    expect(artifactResponse.ok).toBe(false);
    expect(artifactResponse.error?.code).toBe("NOT_FOUND");

    const checkpointAttempt = await sendRequest<unknown>(
      harness,
      "create_run_checkpoint",
      {
        run_id: owner.runId,
        checkpoint_kind: "branch_point",
        workspace_root: harness.workspaceRoot,
      },
      intruder.sessionId,
    );
    expect(checkpointAttempt.ok).toBe(false);
    expect(checkpointAttempt.error?.code).toBe("NOT_FOUND");

    const recoveryPlan = await sendRequest<unknown>(
      harness,
      "plan_recovery",
      {
        target: {
          type: "run_checkpoint",
          run_checkpoint: checkpointResponse.result?.run_checkpoint as string,
        },
      },
      intruder.sessionId,
    );
    expect(recoveryPlan.ok).toBe(false);
    expect(recoveryPlan.error?.code).toBe("NOT_FOUND");

    const recoveryExecution = await sendRequest<unknown>(
      harness,
      "execute_recovery",
      {
        target: {
          type: "run_checkpoint",
          run_checkpoint: checkpointResponse.result?.run_checkpoint as string,
        },
      },
      intruder.sessionId,
    );
    expect(recoveryExecution.ok).toBe(false);
    expect(recoveryExecution.error?.code).toBe("NOT_FOUND");
  });

  it("selects the correct workspace root when multiple roots share a prefix", async () => {
    const harness = await createHarness();
    const alternateWorkspaceRoot = `${harness.workspaceRoot}-alt`;
    fs.mkdirSync(alternateWorkspaceRoot, { recursive: true });

    const helloResponse = await sendRequest<{ session_id: string }>(harness, "hello", {
      client_type: "cli",
      client_version: "0.1.0",
      requested_api_version: API_VERSION,
      workspace_roots: [harness.workspaceRoot, alternateWorkspaceRoot],
    });
    expect(helloResponse.ok).toBe(true);
    const sessionId = helloResponse.result?.session_id as string;

    const registerResponse = await sendRequest<{ run_id: string }>(
      harness,
      "register_run",
      {
        workflow_name: "workspace-root-prefix-selection",
        agent_framework: "cli",
        agent_name: "agentgit-cli",
        workspace_roots: [harness.workspaceRoot, alternateWorkspaceRoot],
        client_metadata: {
          source: "integration-test",
        },
      },
      sessionId,
    );
    expect(registerResponse.ok).toBe(true);
    const runId = registerResponse.result?.run_id as string;

    const targetPath = path.join(alternateWorkspaceRoot, "prefix-root-target.txt");
    fs.writeFileSync(targetPath, "content before delete", "utf8");

    const submitResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { mode: string } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeFilesystemDeleteAttempt(runId, alternateWorkspaceRoot, targetPath),
      },
      sessionId,
    );
    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.execution_result?.mode).toBe("executed");
    expect(submitResponse.result?.snapshot_record?.snapshot_id).toBeTruthy();

    const snapshotId = submitResponse.result?.snapshot_record?.snapshot_id as string;
    const snapshotEngine = new LocalSnapshotEngine({
      rootDir: harness.snapshotRootPath,
    });
    const snapshotManifest = await snapshotEngine.getSnapshotManifest(snapshotId);
    expect(snapshotManifest?.workspace_root).toBe(alternateWorkspaceRoot);
    expect(snapshotManifest?.target_path).toBe(targetPath);
  });

  it("degrades snapshot recovery to manual review when cached capability state is stale", async () => {
    const harness = await createHarness(undefined, null, 0);
    const { sessionId, runId } = await createSessionAndRun(harness, "snapshot-recovery-capability-stale");
    const targetPath = path.join(harness.workspaceRoot, "restore-me-stale.txt");
    fs.writeFileSync(targetPath, "restore this content", "utf8");

    const submitResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { mode: string } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeFilesystemDeleteAttempt(runId, harness.workspaceRoot, targetPath),
      },
      sessionId,
    );

    expect(submitResponse.ok).toBe(true);
    const snapshotId = submitResponse.result?.snapshot_record?.snapshot_id as string;
    expect(snapshotId).toBeTruthy();
    expect(fs.existsSync(targetPath)).toBe(false);

    const maintenanceResponse = await sendRequest<{
      jobs: Array<{ job_type: string; status: string }>;
    }>(
      harness,
      "run_maintenance",
      {
        job_types: ["capability_refresh"],
        scope: {
          workspace_root: harness.workspaceRoot,
        },
      },
      sessionId,
    );
    expect(maintenanceResponse.ok).toBe(true);
    expect(maintenanceResponse.result?.jobs[0]?.job_type).toBe("capability_refresh");
    expect(maintenanceResponse.result?.jobs[0]?.status).toBe("completed");

    await new Promise((resolve) => setTimeout(resolve, 5));

    const planResponse = await sendRequest<{
      recovery_plan: {
        recovery_class: string;
        strategy: string;
        downgrade_reason?: { code: string; message: string } | null;
        warnings: Array<{ code: string }>;
      };
    }>(harness, "plan_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("review_only");
    expect(planResponse.result?.recovery_plan.strategy).toBe("manual_review_only");
    expect(planResponse.result?.recovery_plan.downgrade_reason?.code).toBe("CAPABILITY_STATE_STALE");
    expect(planResponse.result?.recovery_plan.warnings.map((warning) => warning.code)).toContain(
      "CAPABILITY_STATE_STALE",
    );

    const timelineResponse = await sendRequest<{
      steps: Array<{
        step_type: string;
        related: {
          recovery_downgrade_reason?: { code: string; message: string } | null;
        };
      }>;
    }>(harness, "query_timeline", { run_id: runId }, sessionId);
    expect(timelineResponse.ok).toBe(true);
    const recoveryStep = timelineResponse.result?.steps.find((step) => step.step_type === "recovery_step");
    expect(recoveryStep?.related.recovery_downgrade_reason?.code).toBe("CAPABILITY_STATE_STALE");

    const executeResponse = await sendRequest(harness, "execute_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(executeResponse.ok).toBe(false);
    expect(executeResponse.error?.code).toBe("PRECONDITION_FAILED");
    expect(fs.existsSync(targetPath)).toBe(false);
  });

  it("plans snapshotless filesystem writes as action-boundary manual review", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "action-boundary-review");
    const targetPath = path.join(harness.workspaceRoot, "small-write.txt");

    const submitResponse = await sendRequest<{
      action: { action_id: string };
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { mode: string } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeFilesystemWriteAttempt(runId, harness.workspaceRoot, targetPath, "tiny change"),
      },
      sessionId,
    );

    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.snapshot_record).toBeNull();
    const actionId = submitResponse.result?.action.action_id as string;

    const planResponse = await sendRequest<{
      recovery_plan: {
        recovery_class: string;
        strategy: string;
        target: { type: string; action_id?: string };
        review_guidance?: { objects_touched: string[] };
      };
    }>(harness, "plan_recovery", { target: { type: "action_boundary", action_id: actionId } }, sessionId);

    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("review_only");
    expect(planResponse.result?.recovery_plan.strategy).toBe("manual_review_only");
    expect(planResponse.result?.recovery_plan.target.type).toBe("action_boundary");
    expect(planResponse.result?.recovery_plan.target.action_id).toBe(actionId);
    expect(planResponse.result?.recovery_plan.review_guidance?.objects_touched).toContain(targetPath);

    const executeResponse = await sendRequest<unknown>(
      harness,
      "execute_recovery",
      { target: { type: "action_boundary", action_id: actionId } },
      sessionId,
    );
    expect(executeResponse.ok).toBe(false);
    expect(executeResponse.error?.code).toBe("PRECONDITION_FAILED");
  });

  it("plans and executes recovery against the latest matching external-object boundary", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "external-object-recovery");

    const createResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeDraftCreateAttempt(runId, harness.workspaceRoot, "Original plan", "Original body."),
      },
      sessionId,
    );

    expect(createResponse.ok).toBe(true);
    const draftId = createResponse.result?.execution_result?.output?.external_object_id as string;

    const updateResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeDraftUpdateAttempt(runId, harness.workspaceRoot, draftId, "Updated plan", "Updated body."),
      },
      sessionId,
    );

    expect(updateResponse.ok).toBe(true);
    expect(updateResponse.result?.snapshot_record?.snapshot_id).toBeTruthy();
    expect(updateResponse.result?.execution_result?.output?.subject).toBe("Updated plan");

    const draftStore = openDraftStore(draftsStatePath(harness.tempRoot));
    expect(await draftStore.getDraft(draftId)).toMatchObject({
      subject: "Updated plan",
      body: "Updated body.",
      status: "active",
    });

    const planResponse = await sendRequest<{
      recovery_plan: {
        recovery_class: string;
        strategy: string;
        target: { type: string; external_object_id?: string };
      };
    }>(harness, "plan_recovery", { target: { type: "external_object", external_object_id: draftId } }, sessionId);

    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("compensatable");
    expect(planResponse.result?.recovery_plan.strategy).toBe("restore_owned_draft_preimage");
    expect(planResponse.result?.recovery_plan.target.type).toBe("external_object");
    expect(planResponse.result?.recovery_plan.target.external_object_id).toBe(draftId);

    const executeResponse = await sendRequest<{
      restored: boolean;
      outcome: string;
      recovery_plan: {
        target: { type: string; external_object_id?: string };
      };
    }>(harness, "execute_recovery", { target: { type: "external_object", external_object_id: draftId } }, sessionId);

    expect(executeResponse.ok).toBe(true);
    expect(executeResponse.result?.restored).toBe(false);
    expect(executeResponse.result?.outcome).toBe("compensated");
    expect(executeResponse.result?.recovery_plan.target.type).toBe("external_object");
    expect(executeResponse.result?.recovery_plan.target.external_object_id).toBe(draftId);
    expect(await draftStore.getDraft(draftId)).toMatchObject({
      subject: "Original plan",
      body: "Original body.",
      status: "active",
    });
  });

  it("plans and executes recovery against a persisted run checkpoint target", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "run-checkpoint-recovery");
    const targetPath = path.join(harness.workspaceRoot, "checkpoint-target.txt");
    fs.writeFileSync(targetPath, "checkpoint me", "utf8");

    const submitResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { mode: string } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeFilesystemDeleteAttempt(runId, harness.workspaceRoot, targetPath),
      },
      sessionId,
    );

    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.snapshot_record?.snapshot_id).toBeTruthy();
    expect(submitResponse.result?.execution_result?.mode).toBe("executed");
    expect(fs.existsSync(targetPath)).toBe(false);

    const snapshotId = submitResponse.result?.snapshot_record?.snapshot_id as string;
    const runCheckpoint = findRunCheckpointToken(harness.journalPath, runId, snapshotId);

    const planResponse = await sendRequest<{
      recovery_plan: {
        recovery_class: string;
        strategy: string;
        target: { type: string; run_checkpoint?: string };
      };
    }>(harness, "plan_recovery", { target: { type: "run_checkpoint", run_checkpoint: runCheckpoint } }, sessionId);

    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("reversible");
    expect(planResponse.result?.recovery_plan.strategy).toBe("restore_snapshot");
    expect(planResponse.result?.recovery_plan.target.type).toBe("run_checkpoint");
    expect(planResponse.result?.recovery_plan.target.run_checkpoint).toBe(runCheckpoint);

    const executeResponse = await sendRequest<{
      restored: boolean;
      recovery_plan: { target: { type: string; run_checkpoint?: string } };
    }>(harness, "execute_recovery", { target: { type: "run_checkpoint", run_checkpoint: runCheckpoint } }, sessionId);
    expect(executeResponse.ok).toBe(true);
    expect(executeResponse.result?.restored).toBe(true);
    expect(executeResponse.result?.recovery_plan.target.type).toBe("run_checkpoint");
    expect(executeResponse.result?.recovery_plan.target.run_checkpoint).toBe(runCheckpoint);
    expect(fs.readFileSync(targetPath, "utf8")).toBe("checkpoint me");
  });

  it("creates an explicit run checkpoint and restores back to it", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "explicit-run-checkpoint");
    const targetPath = path.join(harness.workspaceRoot, "checkpoint-direct.txt");
    fs.writeFileSync(targetPath, "before checkpoint", "utf8");

    const checkpointResponse = await sendRequest<{
      run_checkpoint: string;
      branch_point: { run_id: string; sequence: number };
      checkpoint_kind: string;
      snapshot_record: { snapshot_id: string; snapshot_class: string };
      snapshot_selection: { snapshot_class: string; reason_codes: string[] };
    }>(
      harness,
      "create_run_checkpoint",
      {
        run_id: runId,
        checkpoint_kind: "branch_point",
        workspace_root: harness.workspaceRoot,
        reason: "Checkpoint before opaque local mutations.",
      },
      sessionId,
    );

    expect(checkpointResponse.ok).toBe(true);
    expect(checkpointResponse.result?.checkpoint_kind).toBe("branch_point");
    expect(checkpointResponse.result?.snapshot_record.snapshot_class).toBe("exact_anchor");
    expect(checkpointResponse.result?.snapshot_selection.reason_codes).toContain("snapshot.explicit_branch_point");

    const runCheckpoint = checkpointResponse.result?.run_checkpoint as string;
    fs.writeFileSync(targetPath, "after checkpoint", "utf8");

    const executeResponse = await sendRequest<{
      restored: boolean;
      recovery_plan: { target: { type: string; run_checkpoint?: string } };
    }>(harness, "execute_recovery", { target: { type: "run_checkpoint", run_checkpoint: runCheckpoint } }, sessionId);

    expect(executeResponse.ok).toBe(true);
    expect(executeResponse.result?.restored).toBe(true);
    expect(executeResponse.result?.recovery_plan.target.type).toBe("run_checkpoint");
    expect(executeResponse.result?.recovery_plan.target.run_checkpoint).toBe(runCheckpoint);
    expect(fs.readFileSync(targetPath, "utf8")).toBe("before checkpoint");
  });

  it("plans and executes recovery against a structured branch-point target", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "branch-point-recovery");
    const targetPath = path.join(harness.workspaceRoot, "branch-target.txt");
    fs.writeFileSync(targetPath, "branch me", "utf8");

    const submitResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { mode: string } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeFilesystemDeleteAttempt(runId, harness.workspaceRoot, targetPath),
      },
      sessionId,
    );

    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.snapshot_record?.snapshot_id).toBeTruthy();
    expect(submitResponse.result?.execution_result?.mode).toBe("executed");
    expect(fs.existsSync(targetPath)).toBe(false);

    const snapshotId = submitResponse.result?.snapshot_record?.snapshot_id as string;
    const branchPoint = findBranchPoint(harness.journalPath, runId, snapshotId);

    const planResponse = await sendRequest<{
      recovery_plan: {
        recovery_class: string;
        strategy: string;
        target: { type: string; run_id?: string; sequence?: number };
      };
    }>(
      harness,
      "plan_recovery",
      { target: { type: "branch_point", run_id: branchPoint.run_id, sequence: branchPoint.sequence } },
      sessionId,
    );

    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("reversible");
    expect(planResponse.result?.recovery_plan.strategy).toBe("restore_snapshot");
    expect(planResponse.result?.recovery_plan.target.type).toBe("branch_point");
    expect(planResponse.result?.recovery_plan.target.run_id).toBe(runId);
    expect(planResponse.result?.recovery_plan.target.sequence).toBe(branchPoint.sequence);

    const executeResponse = await sendRequest<{
      restored: boolean;
      recovery_plan: { target: { type: string; run_id?: string; sequence?: number } };
    }>(
      harness,
      "execute_recovery",
      { target: { type: "branch_point", run_id: branchPoint.run_id, sequence: branchPoint.sequence } },
      sessionId,
    );
    expect(executeResponse.ok).toBe(true);
    expect(executeResponse.result?.restored).toBe(true);
    expect(executeResponse.result?.recovery_plan.target.type).toBe("branch_point");
    expect(executeResponse.result?.recovery_plan.target.run_id).toBe(runId);
    expect(executeResponse.result?.recovery_plan.target.sequence).toBe(branchPoint.sequence);
    expect(fs.readFileSync(targetPath, "utf8")).toBe("branch me");

    const timelineResponse = await sendRequest<{
      steps: Array<{
        step_type: string;
        summary: string;
        related: {
          recovery_target_type?: string | null;
          recovery_target_label?: string | null;
        };
      }>;
    }>(harness, "query_timeline", { run_id: runId }, sessionId);
    expect(timelineResponse.ok).toBe(true);
    const recoveryStep = timelineResponse.result?.steps.find((step) => step.step_type === "recovery_step");
    expect(recoveryStep?.summary).toContain(`branch point ${runId}#${branchPoint.sequence}`);
    expect(recoveryStep?.related.recovery_target_type).toBe("branch_point");
    expect(recoveryStep?.related.recovery_target_label).toBe(`branch point ${runId}#${branchPoint.sequence}`);
  });

  it("plans and executes a surgical path-subset recovery against a snapshot boundary", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "path-subset-recovery");
    const configPath = path.join(harness.workspaceRoot, "config.json");
    const notesPath = path.join(harness.workspaceRoot, "notes.txt");
    fs.writeFileSync(configPath, '{"version":1}', "utf8");
    fs.writeFileSync(notesPath, "v1", "utf8");

    const submitResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { mode: string } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeFilesystemDeleteAttempt(runId, harness.workspaceRoot, configPath),
      },
      sessionId,
    );

    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.snapshot_record?.snapshot_id).toBeTruthy();
    expect(fs.existsSync(configPath)).toBe(false);

    fs.writeFileSync(notesPath, "v2", "utf8");
    const snapshotId = submitResponse.result?.snapshot_record?.snapshot_id as string;

    const planResponse = await sendRequest<{
      recovery_plan: {
        recovery_class: string;
        strategy: string;
        target: { type: string; snapshot_id?: string; paths?: string[] };
      };
    }>(
      harness,
      "plan_recovery",
      { target: { type: "path_subset", snapshot_id: snapshotId, paths: [configPath] } },
      sessionId,
    );

    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("reversible");
    expect(planResponse.result?.recovery_plan.strategy).toBe("restore_path_subset");
    expect(planResponse.result?.recovery_plan.target.type).toBe("path_subset");
    expect(planResponse.result?.recovery_plan.target.paths).toEqual([configPath]);

    const executeResponse = await sendRequest<{
      restored: boolean;
    }>(
      harness,
      "execute_recovery",
      { target: { type: "path_subset", snapshot_id: snapshotId, paths: [configPath] } },
      sessionId,
    );
    expect(executeResponse.ok).toBe(true);
    expect(executeResponse.result?.restored).toBe(true);
    expect(fs.readFileSync(configPath, "utf8")).toBe('{"version":1}');
    expect(fs.readFileSync(notesPath, "utf8")).toBe("v2");

    const timelineResponse = await sendRequest<{
      steps: Array<{
        step_id: string;
        step_type: string;
        related: {
          recovery_target_type?: string | null;
          recovery_scope_paths?: string[];
        };
      }>;
    }>(harness, "query_timeline", { run_id: runId }, sessionId);
    expect(timelineResponse.ok).toBe(true);
    const recoveryStep = timelineResponse.result?.steps.find((step) => step.step_type === "recovery_step");
    expect(recoveryStep?.related.recovery_target_type).toBe("path_subset");
    expect(recoveryStep?.related.recovery_scope_paths).toEqual([configPath]);

    const helperResponse = await sendRequest<{
      answer: string;
    }>(
      harness,
      "query_helper",
      { run_id: runId, question_type: "step_details", focus_step_id: recoveryStep?.step_id },
      sessionId,
    );
    expect(helperResponse.ok).toBe(true);
    expect(helperResponse.result?.answer).toContain(`Recovery scope: ${configPath}.`);
  });

  it("degrades path-subset recovery to manual review when cached workspace access is unavailable", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "path-subset-capability-review");
    const configPath = path.join(harness.workspaceRoot, "config.json");
    const notesPath = path.join(harness.workspaceRoot, "notes.txt");
    fs.writeFileSync(configPath, '{"version":1}', "utf8");
    fs.writeFileSync(notesPath, "v1", "utf8");

    const submitResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { mode: string } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeFilesystemDeleteAttempt(runId, harness.workspaceRoot, configPath),
      },
      sessionId,
    );

    expect(submitResponse.ok).toBe(true);
    const snapshotId = submitResponse.result?.snapshot_record?.snapshot_id as string;
    expect(snapshotId).toBeTruthy();

    fs.rmSync(harness.workspaceRoot, { recursive: true, force: true });

    const maintenanceResponse = await sendRequest<{
      jobs: Array<{ job_type: string; status: string }>;
    }>(
      harness,
      "run_maintenance",
      {
        job_types: ["capability_refresh"],
        scope: {
          workspace_root: harness.workspaceRoot,
        },
      },
      sessionId,
    );
    expect(maintenanceResponse.ok).toBe(true);
    expect(maintenanceResponse.result?.jobs[0]?.job_type).toBe("capability_refresh");
    expect(maintenanceResponse.result?.jobs[0]?.status).toBe("completed");

    const target = { type: "path_subset" as const, snapshot_id: snapshotId, paths: [configPath] };

    const planResponse = await sendRequest<{
      recovery_plan: {
        recovery_class: string;
        strategy: string;
        downgrade_reason?: { code: string; message: string } | null;
        warnings: Array<{ code: string }>;
      };
    }>(harness, "plan_recovery", { target }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("review_only");
    expect(planResponse.result?.recovery_plan.strategy).toBe("manual_review_only");
    expect(planResponse.result?.recovery_plan.downgrade_reason?.code).toBe("WORKSPACE_CAPABILITY_UNAVAILABLE");
    expect(planResponse.result?.recovery_plan.warnings.map((warning) => warning.code)).toContain(
      "WORKSPACE_CAPABILITY_UNAVAILABLE",
    );

    const timelineResponse = await sendRequest<{
      steps: Array<{
        step_id: string;
        step_type: string;
        related: {
          recovery_downgrade_reason?: { code: string; message: string } | null;
        };
      }>;
    }>(harness, "query_timeline", { run_id: runId }, sessionId);
    expect(timelineResponse.ok).toBe(true);
    const recoveryStep = timelineResponse.result?.steps.find((step) => step.step_type === "recovery_step");
    expect(recoveryStep?.related.recovery_downgrade_reason?.code).toBe("WORKSPACE_CAPABILITY_UNAVAILABLE");

    const helperResponse = await sendRequest<{
      answer: string;
    }>(
      harness,
      "query_helper",
      { run_id: runId, question_type: "step_details", focus_step_id: recoveryStep?.step_id },
      sessionId,
    );
    expect(helperResponse.ok).toBe(true);
    expect(helperResponse.result?.answer).toContain("Recovery downgrade reason: WORKSPACE_CAPABILITY_UNAVAILABLE");

    const executeResponse = await sendRequest(harness, "execute_recovery", { target }, sessionId);
    expect(executeResponse.ok).toBe(false);
    expect(executeResponse.error?.code).toBe("PRECONDITION_FAILED");
  });

  it("rejects ambiguous external-object recovery targets across object families", async () => {
    fs.mkdirSync(TEST_TMP_ROOT, { recursive: true });
    harnessSequence += 1;
    const tempRoot = path.join(TEST_TMP_ROOT, `it${harnessSequence}`);
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.mkdirSync(tempRoot, { recursive: true });
    const workspaceRoot = path.join(tempRoot, "workspace");
    const journalPath = path.join(tempRoot, "a.db");
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const journal = createRunJournal({ dbPath: journalPath });
    journal.registerRunLifecycle({
      run_id: "run_ambiguous",
      session_id: "sess_ambiguous",
      workflow_name: "ambiguous-external-object",
      agent_framework: "cli",
      agent_name: "agentgit-cli",
      workspace_roots: [workspaceRoot],
      client_metadata: {},
      budget_config: {
        max_mutating_actions: null,
        max_destructive_actions: null,
      },
      created_at: "2026-03-31T10:00:00.000Z",
    });
    journal.appendRunEvent("run_ambiguous", {
      event_type: "action.normalized",
      occurred_at: "2026-03-31T10:00:01.000Z",
      recorded_at: "2026-03-31T10:00:01.000Z",
      payload: {
        action_id: "act_draft_shared",
        target_locator: "drafts://message_draft/shared_1",
      },
    });
    journal.appendRunEvent("run_ambiguous", {
      event_type: "action.normalized",
      occurred_at: "2026-03-31T10:00:02.000Z",
      recorded_at: "2026-03-31T10:00:02.000Z",
      payload: {
        action_id: "act_note_shared",
        target_locator: "notes://workspace_note/shared_1",
      },
    });
    journal.close();

    const harness = await createHarness(tempRoot);

    const response = await sendRequest<unknown>(harness, "plan_recovery", {
      target: { type: "external_object", external_object_id: "shared_1" },
    });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("PRECONDITION_FAILED");
  });

  it("rejects malformed run-checkpoint recovery targets", async () => {
    const harness = await createHarness();
    const { sessionId } = await createSessionAndRun(harness, "malformed-run-checkpoint");

    const response = await sendRequest<unknown>(
      harness,
      "plan_recovery",
      { target: { type: "run_checkpoint", run_checkpoint: "not-a-checkpoint" } },
      sessionId,
    );
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("PRECONDITION_FAILED");
  });

  it("rejects branch-point targets that do not reference a persisted snapshot boundary", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "branch-point-invalid");
    const targetPath = path.join(harness.workspaceRoot, "branch-invalid.txt");
    fs.writeFileSync(targetPath, "branch invalid", "utf8");

    const submitResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeFilesystemDeleteAttempt(runId, harness.workspaceRoot, targetPath),
      },
      sessionId,
    );
    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.snapshot_record?.snapshot_id).toBeTruthy();

    const response = await sendRequest<unknown>(
      harness,
      "plan_recovery",
      { target: { type: "branch_point", run_id: runId, sequence: 3 } },
      sessionId,
    );
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("NOT_FOUND");
  });

  it("rejects path-subset recovery targets that escape the workspace root", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "path-subset-invalid");
    const configPath = path.join(harness.workspaceRoot, "config.json");
    fs.writeFileSync(configPath, '{"version":1}', "utf8");

    const submitResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeFilesystemDeleteAttempt(runId, harness.workspaceRoot, configPath),
      },
      sessionId,
    );
    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.snapshot_record?.snapshot_id).toBeTruthy();

    const response = await sendRequest<unknown>(
      harness,
      "plan_recovery",
      {
        target: {
          type: "path_subset",
          snapshot_id: submitResponse.result?.snapshot_record?.snapshot_id as string,
          paths: ["/tmp/definitely-outside-workspace.txt"],
        },
      },
      sessionId,
    );
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("PRECONDITION_FAILED");
  });

  it("returns not found for unknown recovery boundaries", async () => {
    const harness = await createHarness();
    const { sessionId } = await createSessionAndRun(harness, "unknown-recovery-boundary");

    const missingActionPlan = await sendRequest<unknown>(
      harness,
      "plan_recovery",
      { target: { type: "action_boundary", action_id: "act_missing" } },
      sessionId,
    );
    expect(missingActionPlan.ok).toBe(false);
    expect(missingActionPlan.error?.code).toBe("NOT_FOUND");

    const missingSnapshotExecute = await sendRequest<unknown>(
      harness,
      "execute_recovery",
      { snapshot_id: "snap_missing" },
      sessionId,
    );
    expect(missingSnapshotExecute.ok).toBe(false);
    expect(missingSnapshotExecute.error?.code).toBe("NOT_FOUND");

    const missingExternalObjectPlan = await sendRequest<unknown>(
      harness,
      "plan_recovery",
      { target: { type: "external_object", external_object_id: "obj_missing" } },
      sessionId,
    );
    expect(missingExternalObjectPlan.ok).toBe(false);
    expect(missingExternalObjectPlan.error?.code).toBe("NOT_FOUND");

    const missingRunCheckpointPlan = await sendRequest<unknown>(
      harness,
      "plan_recovery",
      { target: { type: "run_checkpoint", run_checkpoint: "run_missing#7" } },
      sessionId,
    );
    expect(missingRunCheckpointPlan.ok).toBe(false);
    expect(missingRunCheckpointPlan.error?.code).toBe("NOT_FOUND");

    const missingBranchPointPlan = await sendRequest<unknown>(
      harness,
      "plan_recovery",
      { target: { type: "branch_point", run_id: "run_missing", sequence: 7 } },
      sessionId,
    );
    expect(missingBranchPointPlan.ok).toBe(false);
    expect(missingBranchPointPlan.error?.code).toBe("NOT_FOUND");

    const missingPathSubsetPlan = await sendRequest<unknown>(
      harness,
      "plan_recovery",
      { target: { type: "path_subset", snapshot_id: "snap_missing", paths: ["src/app.ts"] } },
      sessionId,
    );
    expect(missingPathSubsetPlan.ok).toBe(false);
    expect(missingPathSubsetPlan.error?.code).toBe("NOT_FOUND");
  });

  it("journals shell failure details for non-zero exit commands", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "shell-failure");

    const submitResponse = await sendRequest<unknown>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeShellAttempt(runId, harness.workspaceRoot, [
          process.execPath,
          "-e",
          "process.stderr.write('boom'); process.exit(3)",
        ]),
      },
      sessionId,
    );

    expect(submitResponse.ok).toBe(false);
    expect(submitResponse.error?.code).toBe("PRECONDITION_FAILED");

    const timelineResponse = await sendRequest<{
      steps: Array<{ status: string; summary: string; primary_artifacts: Array<{ type: string }> }>;
    }>(harness, "query_timeline", { run_id: runId, visibility_scope: "internal" }, sessionId);
    expect(timelineResponse.ok).toBe(true);
    const failedStep = timelineResponse.result?.steps.find((step) => step.status === "failed");
    expect(failedStep).toBeTruthy();
    expect(failedStep?.summary).toContain("code 3");
    expect(failedStep?.summary).toContain("stderr: boom");
    expect(failedStep?.primary_artifacts.some((artifact) => artifact.type === "stderr")).toBe(true);
  });

  it("returns a structured validation error for malformed JSON", async () => {
    const harness = await createHarness();

    const response = await sendRawLine(harness.socketPath, "{not valid json");
    expect(isResponseEnvelope(response)).toBe(true);

    const envelope = response as ResponseEnvelope<unknown>;
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("VALIDATION_FAILED");
    expect(envelope.error?.message).toContain("valid JSON");
  });

  it("rehydrates persisted runs after a daemon restart", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "rehydration-check");

    const initialSummary = await sendRequest<{
      run: { event_count: number };
    }>(harness, "get_run_summary", { run_id: runId }, sessionId);
    expect(initialSummary.ok).toBe(true);
    expect(initialSummary.result?.run.event_count).toBe(2);

    const tempRoot = harness.tempRoot;
    await closeHarness(harness);
    harnesses.pop();

    const restartedHarness = await createHarness(tempRoot);
    const summaryAfterRestart = await sendRequest<{
      run: { run_id: string; event_count: number };
    }>(restartedHarness, "get_run_summary", { run_id: runId }, sessionId);

    expect(summaryAfterRestart.ok).toBe(true);
    expect(summaryAfterRestart.result?.run.run_id).toBe(runId);
    expect(summaryAfterRestart.result?.run.event_count).toBe(2);
  });

  it("replays register_run idempotently across restart and does not create a second run", async () => {
    const harness = await createHarness();
    const helloResponse = await sendRequest<{ session_id: string }>(harness, "hello", {
      client_type: "cli",
      client_version: "0.1.0",
      requested_api_version: API_VERSION,
      workspace_roots: [harness.workspaceRoot],
    });
    expect(helloResponse.ok).toBe(true);
    const sessionId = helloResponse.result?.session_id as string;

    const payload = {
      workflow_name: "idempotent-register",
      agent_framework: "cli",
      agent_name: "agentgit-cli",
      workspace_roots: [harness.workspaceRoot],
      client_metadata: {
        source: "integration-test",
      },
    };

    const first = await sendRequest<{ run_id: string }>(harness, "register_run", payload, sessionId, "idem_register");
    expect(first.ok).toBe(true);
    const firstRunId = first.result?.run_id;

    await restartHarness(harness);

    const replay = await sendRequest<{ run_id: string }>(harness, "register_run", payload, sessionId, "idem_register");
    expect(replay.ok).toBe(true);
    expect(replay.result?.run_id).toBe(firstRunId);

    const journal = createRunJournal({ dbPath: harness.journalPath });
    try {
      expect(journal.listAllRuns().filter((run) => run.workflow_name === "idempotent-register")).toHaveLength(1);
    } finally {
      journal.close();
    }
  });

  it("fails closed when an idempotency key is reused for a different payload", async () => {
    const harness = await createHarness();
    const helloResponse = await sendRequest<{ session_id: string }>(harness, "hello", {
      client_type: "cli",
      client_version: "0.1.0",
      requested_api_version: API_VERSION,
      workspace_roots: [harness.workspaceRoot],
    });
    const sessionId = helloResponse.result?.session_id as string;

    const first = await sendRequest<{ run_id: string }>(
      harness,
      "register_run",
      {
        workflow_name: "idem-one",
        agent_framework: "cli",
        agent_name: "agentgit-cli",
        workspace_roots: [harness.workspaceRoot],
        client_metadata: {},
      },
      sessionId,
      "idem_conflict",
    );
    expect(first.ok).toBe(true);

    const conflict = await sendRequest<never>(
      harness,
      "register_run",
      {
        workflow_name: "idem-two",
        agent_framework: "cli",
        agent_name: "agentgit-cli",
        workspace_roots: [harness.workspaceRoot],
        client_metadata: {},
      },
      sessionId,
      "idem_conflict",
    );
    expect(conflict.ok).toBe(false);
    expect(conflict.error?.code).toBe("PRECONDITION_FAILED");
    expect(conflict.error?.message).toContain("Idempotency key");
  });

  it("replays submit_action_attempt idempotently across restart without re-executing side effects", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "idempotent-submit");
    const targetPath = path.join(harness.workspaceRoot, "idempotent.txt");

    const payload = {
      attempt: makeFilesystemWriteAttempt(runId, harness.workspaceRoot, targetPath, "first write"),
    };

    const first = await sendRequest<{
      action: { action_id: string };
      execution_result: { execution_id: string } | null;
    }>(harness, "submit_action_attempt", payload, sessionId, "idem_submit");
    expect(first.ok).toBe(true);
    expect(fs.readFileSync(targetPath, "utf8")).toBe("first write");

    const journalBeforeRestart = createRunJournal({ dbPath: harness.journalPath });
    const eventCountBeforeRestart = journalBeforeRestart.getRunSummary(runId)?.event_count;
    journalBeforeRestart.close();

    await restartHarness(harness);

    const replay = await sendRequest<{
      action: { action_id: string };
      execution_result: { execution_id: string } | null;
    }>(harness, "submit_action_attempt", payload, sessionId, "idem_submit");
    expect(replay.ok).toBe(true);
    expect(replay.result?.action.action_id).toBe(first.result?.action.action_id);
    expect(replay.result?.execution_result?.execution_id).toBe(first.result?.execution_result?.execution_id);
    expect(fs.readFileSync(targetPath, "utf8")).toBe("first write");

    const journalAfterRestart = createRunJournal({ dbPath: harness.journalPath });
    try {
      expect(journalAfterRestart.getRunSummary(runId)?.event_count).toBe(eventCountBeforeRestart);
    } finally {
      journalAfterRestart.close();
    }
  });

  it("reconciles interrupted actions as outcome unknown on daemon restart", async () => {
    fs.mkdirSync(TEST_TMP_ROOT, { recursive: true });
    harnessSequence += 1;
    const tempRoot = path.join(TEST_TMP_ROOT, `it${harnessSequence}`);
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.mkdirSync(tempRoot, { recursive: true });
    const workspaceRoot = path.join(tempRoot, "workspace");
    const journalPath = path.join(tempRoot, "a.db");
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const journal = createRunJournal({ dbPath: journalPath });
    journal.registerRunLifecycle({
      run_id: "run_seeded",
      session_id: "sess_seeded",
      workflow_name: "crash-recovery",
      agent_framework: "cli",
      agent_name: "agentgit-cli",
      workspace_roots: [workspaceRoot],
      client_metadata: {},
      budget_config: {
        max_mutating_actions: null,
        max_destructive_actions: null,
      },
      created_at: "2026-03-29T12:00:00.000Z",
    });
    journal.appendRunEvent("run_seeded", {
      event_type: "action.normalized",
      occurred_at: "2026-03-29T12:00:01.000Z",
      recorded_at: "2026-03-29T12:00:01.000Z",
      payload: {
        action_id: "act_seeded",
        operation: {
          display_name: "Delete file",
        },
      },
    });
    journal.appendRunEvent("run_seeded", {
      event_type: "policy.evaluated",
      occurred_at: "2026-03-29T12:00:01.100Z",
      recorded_at: "2026-03-29T12:00:01.100Z",
      payload: {
        action_id: "act_seeded",
        decision: "allow_with_snapshot",
      },
    });
    journal.appendRunEvent("run_seeded", {
      event_type: "snapshot.created",
      occurred_at: "2026-03-29T12:00:01.200Z",
      recorded_at: "2026-03-29T12:00:01.200Z",
      payload: {
        action_id: "act_seeded",
        snapshot_id: "snap_seeded",
      },
    });
    journal.close();

    const harness = await createHarness(tempRoot);

    const timelineResponse = await sendRequest<{
      steps: Array<{ status: string; summary: string }>;
    }>(harness, "query_timeline", { run_id: "run_seeded" }, "sess_seeded");
    expect(timelineResponse.ok).toBe(true);
    const partialActionStep = timelineResponse.result?.steps.find((step) => step.status === "partial");
    expect(partialActionStep?.status).toBe("partial");
    expect(partialActionStep?.summary).toContain("unknown");

    const helperResponse = await sendRequest<{
      answer: string;
      uncertainty: string[];
    }>(harness, "query_helper", { run_id: "run_seeded", question_type: "likely_cause" }, "sess_seeded");
    expect(helperResponse.ok).toBe(true);
    expect(helperResponse.result?.answer).toContain("unknown execution outcome");
    expect(helperResponse.result?.uncertainty[0]).toContain("unknown execution outcome");
  });

  it("surfaces imported actions as non-governed analysis steps after daemon restart", async () => {
    fs.mkdirSync(TEST_TMP_ROOT, { recursive: true });
    harnessSequence += 1;
    const tempRoot = path.join(TEST_TMP_ROOT, `it${harnessSequence}`);
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.mkdirSync(tempRoot, { recursive: true });
    const workspaceRoot = path.join(tempRoot, "workspace");
    const journalPath = path.join(tempRoot, "a.db");
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const journal = createRunJournal({ dbPath: journalPath });
    journal.registerRunLifecycle({
      run_id: "run_imported",
      session_id: "sess_imported",
      workflow_name: "imported-observed",
      agent_framework: "cli",
      agent_name: "agentgit-cli",
      workspace_roots: [workspaceRoot],
      client_metadata: {},
      budget_config: {
        max_mutating_actions: null,
        max_destructive_actions: null,
      },
      created_at: "2026-03-29T15:30:00.000Z",
    });
    journal.appendRunEvent("run_imported", {
      event_type: "action.imported",
      occurred_at: "2026-03-29T15:29:20.000Z",
      recorded_at: "2026-03-29T15:30:01.000Z",
      payload: {
        action_id: "act_imported",
        operation: {
          display_name: "Imported provider-side action",
        },
        provenance_mode: "imported",
        provenance_confidence: 0.61,
        governed: false,
        risk_hints: {
          external_effects: "network",
        },
      },
    });
    journal.close();

    const harness = await createHarness(tempRoot);

    const timelineResponse = await sendRequest<{
      steps: Array<{ step_type: string; provenance: string; summary: string }>;
    }>(harness, "query_timeline", { run_id: "run_imported" }, "sess_imported");
    expect(timelineResponse.ok).toBe(true);
    const importedStep = timelineResponse.result?.steps.find((step) => step.provenance === "imported");
    expect(importedStep?.step_type).toBe("analysis_step");
    expect(importedStep?.summary).toContain("imported from external history");

    const helperResponse = await sendRequest<{
      answer: string;
      uncertainty: string[];
    }>(harness, "query_helper", { run_id: "run_imported", question_type: "suggest_likely_cause" }, "sess_imported");
    expect(helperResponse.ok).toBe(true);
    expect(helperResponse.result?.answer).toContain("imported rather than governed");
    expect(helperResponse.result?.uncertainty[0]).toContain("weak trust provenance");

    const summaryResponse = await sendRequest<{
      answer: string;
      uncertainty: string[];
    }>(harness, "query_helper", { run_id: "run_imported", question_type: "run_summary" }, "sess_imported");
    expect(summaryResponse.ok).toBe(true);
    expect(summaryResponse.result?.answer).toContain("analysis step(s)");
    expect(summaryResponse.result?.answer).toContain(
      "Trust summary: 1 non-governed step(s) were recorded (1 imported).",
    );
    expect(summaryResponse.result?.uncertainty[0]).toContain("not governed pre-execution");
  });

  it("redacts visibility-tagged timeline and helper fields unless a wider scope is requested", async () => {
    const tempRoot = path.join(TEST_TMP_ROOT, "visibility-redaction");
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.mkdirSync(tempRoot, { recursive: true });
    const workspaceRoot = path.join(tempRoot, "workspace");
    const journalPath = path.join(tempRoot, "a.db");
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const journal = createRunJournal({ dbPath: journalPath });
    journal.registerRunLifecycle({
      run_id: "run_visibility",
      session_id: "sess_visibility",
      workflow_name: "visibility-scope",
      agent_framework: "cli",
      agent_name: "agentgit-cli",
      workspace_roots: [workspaceRoot],
      client_metadata: {},
      budget_config: {
        max_mutating_actions: null,
        max_destructive_actions: null,
      },
      created_at: "2026-03-29T19:00:00.000Z",
    });
    journal.appendRunEvent("run_visibility", {
      event_type: "action.normalized",
      occurred_at: "2026-03-29T19:00:01.000Z",
      recorded_at: "2026-03-29T19:00:01.000Z",
      payload: {
        action_id: "act_visibility",
        operation: {
          display_name: "Write secret file",
        },
        target_locator: "file:///workspace/secret.txt",
        input_preview: "token=super-secret",
        input_preview_visibility: "sensitive_internal",
      },
    });
    journal.appendRunEvent("run_visibility", {
      event_type: "execution.completed",
      occurred_at: "2026-03-29T19:00:02.000Z",
      recorded_at: "2026-03-29T19:00:02.000Z",
      payload: {
        action_id: "act_visibility",
        execution_id: "exec_visibility",
        artifact_types: ["file_content", "stdout"],
        stdout_excerpt: "Bearer secret-token",
        stdout_excerpt_visibility: "internal",
      },
    });
    journal.close();

    const harness = await createHarness(tempRoot);

    const userTimeline = await sendRequest<{
      visibility_scope: string;
      redactions_applied: number;
      steps: Array<{ artifact_previews: Array<{ preview: string }> }>;
    }>(harness, "query_timeline", { run_id: "run_visibility" }, "sess_visibility");
    expect(userTimeline.ok).toBe(true);
    expect(userTimeline.result?.visibility_scope).toBe("user");
    expect(userTimeline.result?.redactions_applied).toBe(2);
    expect(userTimeline.result?.steps[2]?.artifact_previews).toHaveLength(0);

    const internalTimeline = await sendRequest<{
      visibility_scope: string;
      redactions_applied: number;
      steps: Array<{ artifact_previews: Array<{ preview: string }> }>;
    }>(harness, "query_timeline", { run_id: "run_visibility", visibility_scope: "internal" }, "sess_visibility");
    expect(internalTimeline.ok).toBe(true);
    expect(internalTimeline.result?.redactions_applied).toBe(1);
    expect(
      internalTimeline.result?.steps[2]?.artifact_previews.some((preview) =>
        preview.preview.includes("Bearer secret-token"),
      ),
    ).toBe(true);
    expect(
      internalTimeline.result?.steps[2]?.artifact_previews.some((preview) =>
        preview.preview.includes("token=super-secret"),
      ),
    ).toBe(false);

    const sensitiveTimeline = await sendRequest<{
      visibility_scope: string;
      redactions_applied: number;
      steps: Array<{ artifact_previews: Array<{ preview: string }> }>;
    }>(
      harness,
      "query_timeline",
      { run_id: "run_visibility", visibility_scope: "sensitive_internal" },
      "sess_visibility",
    );
    expect(sensitiveTimeline.ok).toBe(true);
    expect(sensitiveTimeline.result?.redactions_applied).toBe(0);
    expect(
      sensitiveTimeline.result?.steps[2]?.artifact_previews.some((preview) =>
        preview.preview.includes("token=super-secret"),
      ),
    ).toBe(true);

    const helperResponse = await sendRequest<{
      answer: string;
      uncertainty: string[];
      visibility_scope: string;
      redactions_applied: number;
    }>(
      harness,
      "query_helper",
      {
        run_id: "run_visibility",
        question_type: "step_details",
        focus_step_id: "step_run_visibility_action_act_visibility",
      },
      "sess_visibility",
    );
    expect(helperResponse.ok).toBe(true);
    expect(helperResponse.result?.visibility_scope).toBe("user");
    expect(helperResponse.result?.redactions_applied).toBe(2);
    expect(helperResponse.result?.answer).not.toContain("secret-token");
    expect(helperResponse.result?.uncertainty.some((entry) => entry.includes("redacted for user visibility"))).toBe(
      true,
    );
  });

  it("reports preview-budget truncation and omission when inline artifact previews would flood timeline responses", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "preview-budget");
    const oversized = "x".repeat(320);
    for (let index = 0; index < 4; index += 1) {
      const submitResponse = await sendRequest<{
        execution_result: { mode: string } | null;
      }>(
        harness,
        "submit_action_attempt",
        {
          attempt: makeFilesystemWriteAttempt(
            runId,
            harness.workspaceRoot,
            path.join(harness.workspaceRoot, `preview-budget-${index}.txt`),
            oversized,
          ),
        },
        sessionId,
      );
      expect(submitResponse.ok).toBe(true);
      expect(submitResponse.result?.execution_result?.mode).toBe("executed");
    }

    const timelineResponse = await sendRequest<{
      preview_budget: {
        preview_chars_used: number;
        truncated_previews: number;
        omitted_previews: number;
      };
      steps: Array<{
        step_id: string;
        artifact_previews: Array<{ preview: string }>;
        primary_artifacts: Array<{ type: string; artifact_id?: string }>;
      }>;
    }>(harness, "query_timeline", { run_id: runId }, sessionId);
    expect(timelineResponse.ok).toBe(true);
    expect(timelineResponse.result?.preview_budget.preview_chars_used).toBe(1200);
    expect(timelineResponse.result?.preview_budget.truncated_previews).toBeGreaterThan(0);
    expect(timelineResponse.result?.preview_budget.omitted_previews).toBeGreaterThan(0);
    expect(timelineResponse.result?.steps[timelineResponse.result.steps.length - 1]?.artifact_previews).toHaveLength(0);
    const retrievableArtifactId = timelineResponse.result?.steps[
      timelineResponse.result.steps.length - 1
    ]?.primary_artifacts.find(
      (artifact) => artifact.type === "file_content" && typeof artifact.artifact_id === "string",
    )?.artifact_id;
    expect(typeof retrievableArtifactId).toBe("string");

    const artifactResponse = await sendRequest<{
      artifact: { artifact_id: string };
      content: string;
      content_truncated: boolean;
    }>(harness, "query_artifact", { artifact_id: retrievableArtifactId }, sessionId);
    expect(artifactResponse.ok).toBe(true);
    expect(artifactResponse.result?.artifact.artifact_id).toBe(retrievableArtifactId);
    expect(artifactResponse.result?.content).toBe(oversized);
    expect(artifactResponse.result?.content_truncated).toBe(false);

    const helperResponse = await sendRequest<{
      answer: string;
      uncertainty: string[];
      preview_budget: {
        preview_chars_used: number;
        truncated_previews: number;
        omitted_previews: number;
      };
    }>(
      harness,
      "query_helper",
      {
        run_id: runId,
        question_type: "step_details",
        focus_step_id: timelineResponse.result?.steps.find((step) =>
          step.primary_artifacts.some((artifact) => artifact.type === "file_content"),
        )?.step_id,
      },
      sessionId,
    );
    expect(helperResponse.ok).toBe(true);
    expect(helperResponse.result?.preview_budget.preview_chars_used).toBe(1200);
    expect(helperResponse.result?.uncertainty.some((entry) => entry.includes("response preview budget"))).toBe(true);
  });

  it("fails closed on artifact visibility and truncates oversized artifact fetches", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "artifact-visibility");
    const oversized = "secret-token-".repeat(700);
    const submitResponse = await sendRequest<{
      execution_result: { mode: string } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeShellAttempt(runId, harness.workspaceRoot, [
          "python3",
          "-c",
          `import sys; sys.stdout.write(${JSON.stringify(oversized)})`,
        ]),
      },
      sessionId,
    );
    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.execution_result?.mode).toBe("executed");

    const timelineResponse = await sendRequest<{
      steps: Array<{ primary_artifacts: Array<{ type: string; artifact_id?: string }> }>;
    }>(harness, "query_timeline", { run_id: runId, visibility_scope: "internal" }, sessionId);
    expect(timelineResponse.ok).toBe(true);
    const stdoutArtifactId = timelineResponse.result?.steps
      .flatMap((step) => step.primary_artifacts)
      .find((artifact) => artifact.type === "stdout" && typeof artifact.artifact_id === "string")?.artifact_id;
    expect(typeof stdoutArtifactId).toBe("string");

    const deniedResponse = await sendRequest(
      harness,
      "query_artifact",
      {
        artifact_id: stdoutArtifactId,
      },
      sessionId,
    );
    expect(deniedResponse.ok).toBe(false);
    expect(deniedResponse.error?.code).toBe("NOT_FOUND");

    const allowedResponse = await sendRequest<{
      visibility_scope: string;
      artifact: {
        integrity: {
          schema_version: string;
          digest_algorithm: string;
          digest: string | null;
        };
      };
      content: string;
      content_truncated: boolean;
      returned_chars: number;
      max_inline_chars: number;
    }>(
      harness,
      "query_artifact",
      {
        artifact_id: stdoutArtifactId,
        visibility_scope: "internal",
      },
      sessionId,
    );
    expect(allowedResponse.ok).toBe(true);
    expect(allowedResponse.result?.visibility_scope).toBe("internal");
    expect(allowedResponse.result?.artifact.integrity.schema_version).toBe("artifact-integrity.v1");
    expect(allowedResponse.result?.artifact.integrity.digest_algorithm).toBe("sha256");
    expect(typeof allowedResponse.result?.artifact.integrity.digest).toBe("string");
    expect(allowedResponse.result?.content_truncated).toBe(true);
    expect(allowedResponse.result?.returned_chars).toBe(8192);
    expect(allowedResponse.result?.max_inline_chars).toBe(8192);
    expect(allowedResponse.result?.content.startsWith("secret-token-")).toBe(true);
  });

  it("surfaces degraded artifact capture when durable evidence storage fails after execution", async () => {
    vi.spyOn(RunJournal.prototype, "storeArtifact").mockImplementationOnce(() => {
      throw new AgentGitError(
        "Failed to store execution artifact.",
        "STORAGE_UNAVAILABLE",
        {
          low_disk_pressure: true,
          storage_error_code: "ENOSPC",
        },
        true,
      );
    });

    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "artifact-capture-degraded");
    const targetPath = path.join(harness.workspaceRoot, "degraded-artifact-proof.txt");

    const submitResponse = await sendRequest<{
      execution_result: {
        mode: string;
        artifact_capture?: {
          requested_count: number;
          stored_count: number;
          degraded: boolean;
          failures: Array<{ code: string; retryable: boolean; low_disk_pressure: boolean }>;
        };
      } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeFilesystemWriteAttempt(runId, harness.workspaceRoot, targetPath, "degraded-artifact-content"),
      },
      sessionId,
    );
    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.execution_result?.mode).toBe("executed");
    expect(submitResponse.result?.execution_result?.artifact_capture?.degraded).toBe(true);
    expect(submitResponse.result?.execution_result?.artifact_capture?.requested_count).toBeGreaterThan(0);
    expect(submitResponse.result?.execution_result?.artifact_capture?.stored_count).toBeLessThan(
      submitResponse.result?.execution_result?.artifact_capture?.requested_count ?? 0,
    );
    expect(submitResponse.result?.execution_result?.artifact_capture?.failures[0]?.code).toBe("STORAGE_UNAVAILABLE");
    expect(submitResponse.result?.execution_result?.artifact_capture?.failures[0]?.retryable).toBe(true);
    expect(submitResponse.result?.execution_result?.artifact_capture?.failures[0]?.low_disk_pressure).toBe(true);

    const timelineResponse = await sendRequest<{
      steps: Array<{
        step_type: string;
        summary: string;
        warnings?: string[];
      }>;
    }>(harness, "query_timeline", { run_id: runId }, sessionId);
    expect(timelineResponse.ok).toBe(true);
    const executionStep = timelineResponse.result?.steps.find((step) => step.step_type === "action_step");
    expect(executionStep?.summary).toContain("Supporting evidence capture was degraded");
    expect(
      executionStep?.warnings?.some((warning) =>
        warning.includes("could not be stored because local storage was unavailable"),
      ),
    ).toBe(true);

    const summaryResponse = await sendRequest<{
      run: {
        maintenance_status: {
          projection_status: string;
          degraded_artifact_capture_actions: number;
          low_disk_pressure_signals: number;
          artifact_health: {
            total: number;
          };
        };
      };
    }>(harness, "get_run_summary", { run_id: runId }, sessionId);
    expect(summaryResponse.ok).toBe(true);
    expect(summaryResponse.result?.run.maintenance_status.projection_status).toBe("fresh");
    expect(summaryResponse.result?.run.maintenance_status.degraded_artifact_capture_actions).toBe(1);
    expect(summaryResponse.result?.run.maintenance_status.low_disk_pressure_signals).toBe(1);
    expect(summaryResponse.result?.run.maintenance_status.artifact_health.total).toBeGreaterThan(0);

    const diagnosticsResponse = await sendRequest<{
      daemon_health: {
        status: string;
        warnings: string[];
        primary_reason?: { code: string; message: string } | null;
      } | null;
      journal_health: {
        status: string;
        warnings: string[];
        primary_reason?: { code: string; message: string } | null;
      } | null;
      maintenance_backlog: {
        pending_critical_jobs: number;
        pending_maintenance_jobs: number;
        warnings: string[];
        primary_reason?: { code: string; message: string } | null;
      } | null;
      storage_summary: {
        degraded_artifact_capture_actions: number;
        low_disk_pressure_signals: number;
        warnings: string[];
        primary_reason?: { code: string; message: string } | null;
      } | null;
      projection_lag: {
        projection_status: string;
        lag_events: number;
      } | null;
    }>(
      harness,
      "diagnostics",
      { sections: ["daemon_health", "journal_health", "maintenance_backlog", "storage_summary", "projection_lag"] },
      sessionId,
    );
    expect(diagnosticsResponse.ok).toBe(true);
    expect(diagnosticsResponse.result?.daemon_health?.status).toBe("degraded");
    expect(diagnosticsResponse.result?.journal_health?.status).toBe("degraded");
    expect(diagnosticsResponse.result?.maintenance_backlog?.pending_critical_jobs).toBe(0);
    expect(diagnosticsResponse.result?.maintenance_backlog?.pending_maintenance_jobs).toBe(0);
    expect(diagnosticsResponse.result?.maintenance_backlog?.warnings[0]).toContain(
      "Storage pressure has been observed",
    );
    expect(diagnosticsResponse.result?.daemon_health?.primary_reason?.code).toBe("DEGRADED_ARTIFACT_CAPTURE");
    expect(diagnosticsResponse.result?.journal_health?.primary_reason?.code).toBe("DEGRADED_ARTIFACT_CAPTURE");
    expect(diagnosticsResponse.result?.maintenance_backlog?.primary_reason?.code).toBe("LOW_DISK_PRESSURE_OBSERVED");
    expect(diagnosticsResponse.result?.storage_summary?.degraded_artifact_capture_actions).toBe(1);
    expect(diagnosticsResponse.result?.storage_summary?.low_disk_pressure_signals).toBe(1);
    expect(diagnosticsResponse.result?.storage_summary?.primary_reason?.code).toBe("DEGRADED_ARTIFACT_CAPTURE");
    expect(
      diagnosticsResponse.result?.storage_summary?.warnings.some((warning) =>
        warning.includes("degraded durable evidence capture"),
      ),
    ).toBe(true);
    expect(diagnosticsResponse.result?.projection_lag?.projection_status).toBe("fresh");
    expect(diagnosticsResponse.result?.projection_lag?.lag_events).toBe(0);
  });

  it("runs supported maintenance jobs inline and reports non-wal checkpoint state truthfully", async () => {
    const harness = await createHarness();
    const { sessionId } = await createSessionAndRun(harness, "maintenance-supported");

    const maintenanceResponse = await sendRequest<{
      jobs: Array<{
        job_type: string;
        status: string;
        performed_inline: boolean;
        summary: string;
        stats?: Record<string, unknown>;
      }>;
      stream_id: string | null;
    }>(
      harness,
      "run_maintenance",
      {
        job_types: ["sqlite_wal_checkpoint", "projection_rebuild"],
        priority_override: "administrative",
      },
      sessionId,
    );
    expect(maintenanceResponse.ok).toBe(true);
    expect(maintenanceResponse.result?.stream_id).toBeNull();
    expect(maintenanceResponse.result?.jobs[0]?.job_type).toBe("sqlite_wal_checkpoint");
    expect(maintenanceResponse.result?.jobs[0]?.status).toBe("completed");
    expect(maintenanceResponse.result?.jobs[0]?.performed_inline).toBe(true);
    expect(maintenanceResponse.result?.jobs[0]?.summary).toContain("non-WAL");
    expect(maintenanceResponse.result?.jobs[1]).toEqual(
      expect.objectContaining({
        job_type: "projection_rebuild",
        status: "completed",
        performed_inline: true,
      }),
    );
  });

  it("reconciles persisted runs inline without fabricating duplicate in-memory state", async () => {
    const harness = await createHarness();
    const { sessionId } = await createSessionAndRun(harness, "maintenance-startup-reconcile-runs");

    const maintenanceResponse = await sendRequest<{
      jobs: Array<{
        job_type: string;
        status: string;
        performed_inline: boolean;
        summary: string;
        stats?: Record<string, unknown>;
      }>;
    }>(
      harness,
      "run_maintenance",
      {
        job_types: ["startup_reconcile_runs"],
        priority_override: "administrative",
      },
      sessionId,
    );
    expect(maintenanceResponse.ok).toBe(true);
    expect(maintenanceResponse.result?.jobs[0]).toEqual(
      expect.objectContaining({
        job_type: "startup_reconcile_runs",
        status: "completed",
        performed_inline: true,
      }),
    );

    const stats = maintenanceResponse.result?.jobs[0]?.stats as
      | {
          runs_considered?: number;
          sessions_rehydrated?: number;
          runs_rehydrated?: number;
          total_sessions?: number;
          total_runs?: number;
        }
      | undefined;
    expect(stats?.runs_considered).toBe(1);
    expect(stats?.sessions_rehydrated).toBe(0);
    expect(stats?.runs_rehydrated).toBe(0);
    expect(stats?.total_sessions).toBeGreaterThanOrEqual(1);
    expect(stats?.total_runs).toBe(1);
  });

  it("reconciles interrupted actions inline exactly once", async () => {
    fs.mkdirSync(TEST_TMP_ROOT, { recursive: true });
    harnessSequence += 1;
    const tempRoot = path.join(TEST_TMP_ROOT, `it${harnessSequence}`);
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.mkdirSync(tempRoot, { recursive: true });
    const workspaceRoot = path.join(tempRoot, "workspace");
    const journalPath = path.join(tempRoot, "a.db");
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const journal = createRunJournal({ dbPath: journalPath });
    journal.registerRunLifecycle({
      run_id: "run_seeded_reconcile",
      session_id: "sess_seeded_reconcile",
      workflow_name: "maintenance-reconcile",
      agent_framework: "cli",
      agent_name: "agentgit-cli",
      workspace_roots: [workspaceRoot],
      client_metadata: {},
      budget_config: {
        max_mutating_actions: null,
        max_destructive_actions: null,
      },
      created_at: "2026-03-31T12:00:00.000Z",
    });
    journal.appendRunEvent("run_seeded_reconcile", {
      event_type: "action.normalized",
      occurred_at: "2026-03-31T12:00:01.000Z",
      recorded_at: "2026-03-31T12:00:01.000Z",
      payload: {
        action_id: "act_seeded_reconcile",
        target_locator: path.join(workspaceRoot, "lost.txt"),
      },
    });
    journal.appendRunEvent("run_seeded_reconcile", {
      event_type: "snapshot.created",
      occurred_at: "2026-03-31T12:00:02.000Z",
      recorded_at: "2026-03-31T12:00:02.000Z",
      payload: {
        action_id: "act_seeded_reconcile",
        snapshot_id: "snap_seeded_reconcile",
      },
    });
    journal.close();

    const harness = await createHarness(tempRoot);
    const helloResponse = await sendRequest<{ session_id: string }>(harness, "hello", {
      client_type: "cli",
      client_version: "0.1.0",
      requested_api_version: API_VERSION,
      workspace_roots: [workspaceRoot],
    });
    const sessionId = helloResponse.result?.session_id as string;

    const firstMaintenance = await sendRequest<{
      jobs: Array<{
        job_type: string;
        status: string;
        stats?: Record<string, unknown>;
      }>;
    }>(
      harness,
      "run_maintenance",
      {
        job_types: ["startup_reconcile_recoveries"],
        priority_override: "administrative",
      },
      sessionId,
    );
    expect(firstMaintenance.ok).toBe(true);
    expect(firstMaintenance.result?.jobs[0]?.job_type).toBe("startup_reconcile_recoveries");
    expect(firstMaintenance.result?.jobs[0]?.status).toBe("completed");
    expect(
      (firstMaintenance.result?.jobs[0]?.stats as { reconciled_actions?: number } | undefined)?.reconciled_actions,
    ).toBe(0);

    await restartHarness(harness);

    const restartHello = await sendRequest<{ session_id: string }>(harness, "hello", {
      client_type: "cli",
      client_version: "0.1.0",
      requested_api_version: API_VERSION,
      workspace_roots: [workspaceRoot],
    });
    const restartSessionId = restartHello.result?.session_id as string;

    const replayMaintenance = await sendRequest<{
      jobs: Array<{
        job_type: string;
        status: string;
        stats?: Record<string, unknown>;
      }>;
    }>(
      harness,
      "run_maintenance",
      {
        job_types: ["startup_reconcile_recoveries"],
        priority_override: "administrative",
      },
      restartSessionId,
    );
    expect(replayMaintenance.ok).toBe(true);
    expect(
      (replayMaintenance.result?.jobs[0]?.stats as { reconciled_actions?: number } | undefined)?.reconciled_actions,
    ).toBe(0);

    const reopenedJournal = createRunJournal({ dbPath: journalPath });
    try {
      const unknownEvents = reopenedJournal
        .listRunEvents("run_seeded_reconcile")
        .filter(
          (event) =>
            event.event_type === "execution.outcome_unknown" && event.payload?.action_id === "act_seeded_reconcile",
        );
      expect(unknownEvents).toHaveLength(1);
    } finally {
      reopenedJournal.close();
    }
  });

  it("removes orphaned artifact blobs inline without sweeping referenced degraded evidence", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "maintenance-artifact-orphan-cleanup");
    const targetPath = path.join(harness.workspaceRoot, "artifact-orphan-cleanup.txt");

    const submitResponse = await sendRequest<{
      execution_result: { mode: string } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeFilesystemWriteAttempt(runId, harness.workspaceRoot, targetPath, "cleanup proof"),
      },
      sessionId,
    );
    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.execution_result?.mode).toBe("executed");

    const timelineResponse = await sendRequest<{
      steps: Array<{
        primary_artifacts: Array<{
          type: string;
          artifact_id?: string;
        }>;
      }>;
    }>(harness, "query_timeline", { run_id: runId }, sessionId);
    expect(timelineResponse.ok).toBe(true);

    const artifactId = timelineResponse.result?.steps
      .flatMap((step) => step.primary_artifacts)
      .find((artifact) => artifact.type === "file_content" && typeof artifact.artifact_id === "string")?.artifact_id;
    expect(typeof artifactId).toBe("string");

    const referencedDigest = crypto
      .createHash("sha256")
      .update(artifactId as string)
      .digest("hex");
    const referencedPath = path.join(
      harness.tempRoot,
      "artifacts",
      referencedDigest.slice(0, 2),
      referencedDigest.slice(2, 4),
      `${artifactId}.txt`,
    );
    fs.writeFileSync(referencedPath, "tampered cleanup proof", "utf8");

    const orphanPath = path.join(harness.tempRoot, "artifacts", "zz", "99", "artifact_orphan_cleanup.txt");
    fs.mkdirSync(path.dirname(orphanPath), { recursive: true });
    fs.writeFileSync(orphanPath, "orphaned evidence", "utf8");

    const maintenanceResponse = await sendRequest<{
      jobs: Array<{
        job_type: string;
        status: string;
        performed_inline: boolean;
        summary: string;
        stats?: Record<string, unknown>;
      }>;
    }>(
      harness,
      "run_maintenance",
      {
        job_types: ["artifact_orphan_cleanup"],
        priority_override: "administrative",
      },
      sessionId,
    );
    expect(maintenanceResponse.ok).toBe(true);
    expect(maintenanceResponse.result?.jobs[0]).toEqual(
      expect.objectContaining({
        job_type: "artifact_orphan_cleanup",
        status: "completed",
        performed_inline: true,
      }),
    );
    expect(maintenanceResponse.result?.jobs[0]?.summary).toContain("Removed 1 orphaned artifact blob");
    const cleanupStats = maintenanceResponse.result?.jobs[0]?.stats as
      | {
          files_scanned?: number;
          referenced_files?: number;
          orphaned_files_removed?: number;
        }
      | undefined;
    expect(cleanupStats?.orphaned_files_removed).toBe(1);
    expect(cleanupStats?.referenced_files).toBeGreaterThan(0);
    expect(cleanupStats?.files_scanned).toBeGreaterThan(cleanupStats?.referenced_files ?? 0);

    expect(fs.existsSync(orphanPath)).toBe(false);
    expect(fs.existsSync(referencedPath)).toBe(true);

    const artifactResponse = await sendRequest<{
      artifact_status: string;
      content_available: boolean;
    }>(harness, "query_artifact", { artifact_id: artifactId }, sessionId);
    expect(artifactResponse.ok).toBe(true);
    expect(artifactResponse.result?.artifact_status).toBe("tampered");
    expect(artifactResponse.result?.content_available).toBe(false);
  });

  it("garbage collects orphaned snapshot storage inline without removing referenced snapshot state", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "maintenance-snapshot-gc");
    const targetPath = path.join(harness.workspaceRoot, "snapshot-gc.txt");
    fs.writeFileSync(targetPath, "gc proof", "utf8");

    const submitResponse = await sendRequest<{
      snapshot_record?: { snapshot_id: string } | null;
      execution_result?: { mode: string } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeFilesystemDeleteAttempt(runId, harness.workspaceRoot, targetPath),
      },
      sessionId,
    );
    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.execution_result?.mode).toBe("executed");

    const snapshotId = submitResponse.result?.snapshot_record?.snapshot_id;
    expect(typeof snapshotId).toBe("string");

    const referencedLayeredDir = path.join(harness.snapshotRootPath, "snaps", snapshotId as string);
    expect(fs.existsSync(path.join(referencedLayeredDir, "manifest.json"))).toBe(true);

    const orphanedLayeredDir = path.join(harness.snapshotRootPath, "snaps", "snap_orphaned_gc");
    fs.mkdirSync(orphanedLayeredDir, { recursive: true });
    fs.writeFileSync(path.join(orphanedLayeredDir, "manifest.json"), "{}", "utf8");
    fs.writeFileSync(path.join(orphanedLayeredDir, "payload.txt"), "orphaned snapshot", "utf8");

    const straySnapshotEntry = path.join(harness.snapshotRootPath, "snaps", "orphaned.tmp");
    fs.writeFileSync(straySnapshotEntry, "temp", "utf8");

    const orphanedLegacyDir = path.join(harness.snapshotRootPath, "snap_legacy_gc");
    fs.mkdirSync(orphanedLegacyDir, { recursive: true });
    fs.writeFileSync(path.join(orphanedLegacyDir, "payload.txt"), "legacy orphan", "utf8");

    const maintenanceResponse = await sendRequest<{
      jobs: Array<{
        job_type: string;
        status: string;
        performed_inline: boolean;
        summary: string;
        stats?: Record<string, unknown>;
      }>;
    }>(
      harness,
      "run_maintenance",
      {
        job_types: ["snapshot_gc"],
        priority_override: "administrative",
      },
      sessionId,
    );
    expect(maintenanceResponse.ok).toBe(true);
    expect(maintenanceResponse.result?.jobs[0]).toEqual(
      expect.objectContaining({
        job_type: "snapshot_gc",
        status: "completed",
        performed_inline: true,
      }),
    );
    expect(maintenanceResponse.result?.jobs[0]?.summary).toContain("Removed 2 orphaned snapshot container");

    const gcStats = maintenanceResponse.result?.jobs[0]?.stats as
      | {
          workspaces_considered?: number;
          layered_snapshots_removed?: number;
          legacy_snapshots_removed?: number;
          stray_entries_removed?: number;
          referenced_layered_snapshots?: number;
        }
      | undefined;
    expect(gcStats?.workspaces_considered).toBe(1);
    expect(gcStats?.referenced_layered_snapshots).toBeGreaterThan(0);
    expect(gcStats?.layered_snapshots_removed).toBe(1);
    expect(gcStats?.legacy_snapshots_removed).toBe(1);
    expect(gcStats?.stray_entries_removed).toBe(1);

    expect(fs.existsSync(referencedLayeredDir)).toBe(true);
    expect(fs.existsSync(orphanedLayeredDir)).toBe(false);
    expect(fs.existsSync(straySnapshotEntry)).toBe(false);
    expect(fs.existsSync(orphanedLegacyDir)).toBe(false);
  });

  it("rebases duplicate synthetic anchors inline without changing older snapshot restore semantics", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "maintenance-snapshot-rebase-anchor");
    const targetPath = path.join(harness.workspaceRoot, "snapshot-rebase-anchor.txt");
    fs.writeFileSync(targetPath, "v1", "utf8");
    const engine = new LocalSnapshotEngine({
      rootDir: harness.snapshotRootPath,
    });
    const firstSnapshot = await engine.createSnapshot({
      action: makeFilesystemWriteAction(runId, targetPath),
      requested_class: "journal_plus_anchor",
      workspace_root: harness.workspaceRoot,
    });
    const secondSnapshot = await engine.createSnapshot({
      action: makeFilesystemWriteAction(runId, targetPath),
      requested_class: "journal_plus_anchor",
      workspace_root: harness.workspaceRoot,
    });

    fs.writeFileSync(targetPath, "v2", "utf8");
    await engine.createSnapshot({
      action: makeFilesystemWriteAction(runId, targetPath),
      requested_class: "journal_plus_anchor",
      workspace_root: harness.workspaceRoot,
    });

    const duplicateAnchorPath = path.join(
      harness.snapshotRootPath,
      "snaps",
      secondSnapshot.snapshot_id,
      "files",
      "snapshot-rebase-anchor.txt",
    );
    expect(fs.readFileSync(duplicateAnchorPath, "utf8")).toBe("v1");

    const maintenanceResponse = await sendRequest<{
      jobs: Array<{
        job_type: string;
        status: string;
        performed_inline: boolean;
        summary: string;
        stats?: Record<string, unknown>;
      }>;
    }>(
      harness,
      "run_maintenance",
      {
        job_types: ["snapshot_rebase_anchor"],
        priority_override: "administrative",
        scope: {
          workspace_root: harness.workspaceRoot,
        },
      },
      sessionId,
    );
    expect(maintenanceResponse.ok).toBe(true);
    expect(maintenanceResponse.result?.jobs[0]).toEqual(
      expect.objectContaining({
        job_type: "snapshot_rebase_anchor",
        status: "completed",
        performed_inline: true,
      }),
    );
    expect(maintenanceResponse.result?.jobs[0]?.summary).toContain("Rebased 1 synthetic anchor reference");

    const rebaseStats = maintenanceResponse.result?.jobs[0]?.stats as
      | {
          workspaces_considered?: number;
          snapshots_scanned?: number;
          anchors_rebased?: number;
          bytes_freed?: number;
        }
      | undefined;
    expect(rebaseStats?.workspaces_considered).toBe(1);
    expect(rebaseStats?.snapshots_scanned).toBe(3);
    expect(rebaseStats?.anchors_rebased).toBe(1);
    expect(rebaseStats?.bytes_freed).toBe(Buffer.byteLength("v1", "utf8"));
    expect(fs.existsSync(duplicateAnchorPath)).toBe(false);

    fs.rmSync(targetPath, { force: true });
    await expect(engine.restore(secondSnapshot.snapshot_id)).resolves.toBe(true);
    expect(fs.readFileSync(targetPath, "utf8")).toBe("v1");
    await expect(engine.verifyTargetUnchanged(secondSnapshot.snapshot_id, targetPath)).resolves.toBe(true);
    await expect(engine.verifyTargetUnchanged(firstSnapshot.snapshot_id, targetPath)).resolves.toBe(true);
  });

  it("refreshes capability state inline and surfaces cached degradation through diagnostics", async () => {
    const harness = await createHarness();
    const { sessionId } = await createSessionAndRun(harness, "maintenance-capability-refresh");

    const maintenanceResponse = await sendRequest<{
      jobs: Array<{
        job_type: string;
        status: string;
        performed_inline: boolean;
        summary: string;
        stats?: Record<string, unknown>;
      }>;
    }>(
      harness,
      "run_maintenance",
      {
        job_types: ["capability_refresh"],
        priority_override: "administrative",
        scope: {
          workspace_root: harness.workspaceRoot,
        },
      },
      sessionId,
    );
    expect(maintenanceResponse.ok).toBe(true);
    expect(maintenanceResponse.result?.jobs).toEqual([
      expect.objectContaining({
        job_type: "capability_refresh",
        status: "completed",
        performed_inline: true,
      }),
    ]);
    expect(maintenanceResponse.result?.jobs[0]?.summary).toContain("Refreshed 8 capability record");
    expect(maintenanceResponse.result?.jobs[0]?.stats).toEqual(
      expect.objectContaining({
        capability_count: 8,
        degraded_capabilities: 0,
        unavailable_capabilities: 1,
        workspace_root: harness.workspaceRoot,
      }),
    );

    const diagnosticsResponse = await sendRequest<{
      daemon_health: {
        status: string;
        warnings: string[];
        primary_reason?: { code: string; message: string } | null;
      } | null;
      maintenance_backlog: {
        warnings: string[];
        primary_reason?: { code: string; message: string } | null;
      } | null;
      capability_summary: {
        cached: boolean;
        refreshed_at: string | null;
        capability_count: number;
        degraded_capabilities: number;
        unavailable_capabilities: number;
        stale_after_ms: number;
        is_stale: boolean;
        warnings: string[];
        workspace_root: string | null;
        primary_reason?: { code: string; message: string } | null;
      } | null;
      security_posture: {
        status: string;
        secret_storage: {
          mode: string;
          durable: boolean;
          secret_expiry_enforced: boolean;
        };
        stdio_sandbox: {
          protected_server_count: number;
          registered_server_count: number;
        };
        streamable_http: {
          shared_sqlite_leases: boolean;
          lease_heartbeat_renewal: boolean;
        };
      } | null;
    }>(
      harness,
      "diagnostics",
      { sections: ["daemon_health", "maintenance_backlog", "capability_summary", "security_posture"] },
      sessionId,
    );
    expect(diagnosticsResponse.ok).toBe(true);
    expect(diagnosticsResponse.result?.daemon_health?.status).toBe("degraded");
    expect(diagnosticsResponse.result?.daemon_health?.primary_reason?.code).toBe("BROKERED_CAPABILITY_UNAVAILABLE");
    expect(
      diagnosticsResponse.result?.daemon_health?.warnings.some((warning) =>
        warning.includes("Latest capability refresh reported 0 degraded and 1 unavailable"),
      ),
    ).toBe(true);
    expect(
      diagnosticsResponse.result?.maintenance_backlog?.warnings.some((warning) =>
        warning.includes("session environment profiles"),
      ),
    ).toBe(false);
    expect(
      diagnosticsResponse.result?.maintenance_backlog?.warnings.some((warning) =>
        warning.includes("has not been refreshed durably yet"),
      ),
    ).toBe(false);
    expect(diagnosticsResponse.result?.maintenance_backlog?.primary_reason?.code).toBe(
      "BROKERED_CAPABILITY_UNAVAILABLE",
    );
    expect(diagnosticsResponse.result?.capability_summary).toEqual(
      expect.objectContaining({
        cached: true,
        capability_count: 8,
        degraded_capabilities: 0,
        unavailable_capabilities: 1,
        stale_after_ms: 300000,
        is_stale: false,
        workspace_root: harness.workspaceRoot,
        primary_reason: expect.objectContaining({
          code: "BROKERED_CAPABILITY_UNAVAILABLE",
        }),
      }),
    );
    expect(diagnosticsResponse.result?.security_posture).toEqual(
      expect.objectContaining({
        status: "healthy",
        secret_storage: expect.objectContaining({
          mode: "local_encrypted_store",
          durable: true,
          secret_expiry_enforced: true,
        }),
        stdio_sandbox: expect.objectContaining({
          protected_server_count: 0,
          registered_server_count: 0,
        }),
        streamable_http: expect.objectContaining({
          shared_sqlite_leases: true,
          lease_heartbeat_renewal: true,
        }),
      }),
    );
  });

  it("reports launch capability degradation honestly when brokered ticket credentials are absent", async () => {
    const harness = await createHarness();
    const { sessionId } = await createSessionAndRun(harness, "capabilities-default");

    const capabilitiesResponse = await sendRequest<{
      capabilities: Array<{
        capability_name: string;
        status: string;
        scope: string;
        details: Record<string, unknown>;
      }>;
      degraded_mode_warnings: string[];
      detection_timestamps: {
        started_at: string;
        completed_at: string;
      };
    }>(
      harness,
      "get_capabilities",
      {
        workspace_root: harness.workspaceRoot,
      },
      sessionId,
    );
    expect(capabilitiesResponse.ok).toBe(true);
    expect(capabilitiesResponse.result?.detection_timestamps.started_at).toBeTruthy();
    expect(capabilitiesResponse.result?.detection_timestamps.completed_at).toBeTruthy();
    expect(capabilitiesResponse.result?.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability_name: "host.runtime_storage",
          status: "available",
          scope: "host",
        }),
        expect.objectContaining({
          capability_name: "host.credential_broker_mode",
          status: "available",
          scope: "host",
          details: expect.objectContaining({
            mode: "local_encrypted_store",
            secure_store: true,
          }),
        }),
        expect.objectContaining({
          capability_name: "adapter.tickets_brokered_credentials",
          status: "unavailable",
          scope: "adapter",
          details: expect.objectContaining({
            integration: "tickets",
            brokered_profile_configured: false,
          }),
        }),
        expect.objectContaining({
          capability_name: "workspace.root_access",
          status: "available",
          scope: "workspace",
          details: expect.objectContaining({
            workspace_root: harness.workspaceRoot,
            exists: true,
            is_directory: true,
            readable: true,
            writable: true,
          }),
        }),
        expect.objectContaining({
          capability_name: "adapter.mcp_stdio_sandbox",
          status: "available",
          scope: "adapter",
          details: expect.objectContaining({
            protected_execution_required: true,
          }),
        }),
        expect.objectContaining({
          capability_name: "adapter.mcp_streamable_http",
          status: "available",
          scope: "adapter",
          details: expect.objectContaining({
            connect_time_dns_scope_validation: true,
            redirect_chain_revalidation: true,
            shared_sqlite_leases: true,
            lease_heartbeat_renewal: true,
          }),
        }),
      ]),
    );
    expect(
      capabilitiesResponse.result?.degraded_mode_warnings.some((warning) =>
        warning.includes("session environment profiles"),
      ),
    ).toBe(false);
    expect(
      capabilitiesResponse.result?.degraded_mode_warnings.some((warning) =>
        warning.includes("Owned ticket mutations are unavailable"),
      ),
    ).toBe(true);
  });

  it("surfaces configured ticket brokering separately from missing workspace access", async () => {
    process.env.AGENTGIT_TICKETS_BASE_URL = "http://127.0.0.1:9";
    process.env.AGENTGIT_TICKETS_BEARER_TOKEN = "test-token";

    const harness = await createHarness();
    const { sessionId } = await createSessionAndRun(harness, "capabilities-configured");
    const missingWorkspaceRoot = path.join(harness.tempRoot, "missing-workspace");

    const capabilitiesResponse = await sendRequest<{
      capabilities: Array<{
        capability_name: string;
        status: string;
        details: Record<string, unknown>;
      }>;
      degraded_mode_warnings: string[];
    }>(
      harness,
      "get_capabilities",
      {
        workspace_root: missingWorkspaceRoot,
      },
      sessionId,
    );
    expect(capabilitiesResponse.ok).toBe(true);
    expect(capabilitiesResponse.result?.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability_name: "adapter.tickets_brokered_credentials",
          status: "available",
          details: expect.objectContaining({
            brokered_profile_configured: true,
          }),
        }),
        expect.objectContaining({
          capability_name: "workspace.root_access",
          status: "unavailable",
          details: expect.objectContaining({
            workspace_root: missingWorkspaceRoot,
            exists: false,
            is_directory: false,
            readable: false,
            writable: false,
          }),
        }),
      ]),
    );
    expect(
      capabilitiesResponse.result?.degraded_mode_warnings.some((warning) =>
        warning.includes(`Workspace root ${missingWorkspaceRoot} is not available`),
      ),
    ).toBe(true);
  });

  it("refreshes capability state with configured ticket credentials while failing closed on missing workspace access", async () => {
    process.env.AGENTGIT_TICKETS_BASE_URL = "http://127.0.0.1:9";
    process.env.AGENTGIT_TICKETS_BEARER_TOKEN = "test-token";

    const harness = await createHarness();
    const { sessionId } = await createSessionAndRun(harness, "maintenance-capability-refresh-missing-workspace");
    const missingWorkspaceRoot = path.join(harness.tempRoot, "missing-refresh-workspace");

    const maintenanceResponse = await sendRequest<{
      jobs: Array<{
        job_type: string;
        status: string;
        stats?: Record<string, unknown>;
      }>;
    }>(
      harness,
      "run_maintenance",
      {
        job_types: ["capability_refresh"],
        scope: {
          workspace_root: missingWorkspaceRoot,
        },
      },
      sessionId,
    );
    expect(maintenanceResponse.ok).toBe(true);
    expect(maintenanceResponse.result?.jobs[0]?.job_type).toBe("capability_refresh");
    expect(maintenanceResponse.result?.jobs[0]?.status).toBe("completed");
    expect(maintenanceResponse.result?.jobs[0]?.stats).toEqual(
      expect.objectContaining({
        capability_count: 8,
        degraded_capabilities: 0,
        unavailable_capabilities: 1,
        workspace_root: missingWorkspaceRoot,
      }),
    );
  });

  it("surfaces cached capability refreshes as stale when the configured threshold is exceeded", async () => {
    const harness = await createHarness(undefined, null, 0);
    const { sessionId } = await createSessionAndRun(harness, "maintenance-capability-refresh-stale");

    const maintenanceResponse = await sendRequest<{
      jobs: Array<{
        job_type: string;
        status: string;
      }>;
    }>(
      harness,
      "run_maintenance",
      {
        job_types: ["capability_refresh"],
        scope: {
          workspace_root: harness.workspaceRoot,
        },
      },
      sessionId,
    );
    expect(maintenanceResponse.ok).toBe(true);
    expect(maintenanceResponse.result?.jobs[0]?.job_type).toBe("capability_refresh");
    await new Promise((resolve) => setTimeout(resolve, 5));

    const diagnosticsResponse = await sendRequest<{
      daemon_health: {
        status: string;
        warnings: string[];
        primary_reason?: { code: string; message: string } | null;
      } | null;
      capability_summary: {
        stale_after_ms: number;
        is_stale: boolean;
        warnings: string[];
        primary_reason?: { code: string; message: string } | null;
      } | null;
    }>(harness, "diagnostics", { sections: ["daemon_health", "capability_summary"] }, sessionId);
    expect(diagnosticsResponse.ok).toBe(true);
    expect(diagnosticsResponse.result?.daemon_health?.status).toBe("degraded");
    expect(diagnosticsResponse.result?.daemon_health?.primary_reason?.code).toBe("CAPABILITY_STATE_STALE");
    expect(
      diagnosticsResponse.result?.daemon_health?.warnings.some((warning) =>
        warning.includes("Latest capability refresh is stale"),
      ),
    ).toBe(true);
    expect(diagnosticsResponse.result?.capability_summary).toEqual(
      expect.objectContaining({
        stale_after_ms: 0,
        is_stale: true,
        primary_reason: expect.objectContaining({
          code: "CAPABILITY_STATE_STALE",
        }),
      }),
    );
  });

  it("requires approval for owned ticket mutations when cached broker capability is unavailable", async () => {
    delete process.env.AGENTGIT_TICKETS_BASE_URL;
    delete process.env.AGENTGIT_TICKETS_BEARER_TOKEN;

    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "ticket-capability-unavailable");

    const maintenanceResponse = await sendRequest<{
      jobs: Array<{
        job_type: string;
        status: string;
      }>;
    }>(
      harness,
      "run_maintenance",
      {
        job_types: ["capability_refresh"],
        scope: {
          workspace_root: harness.workspaceRoot,
        },
      },
      sessionId,
    );
    expect(maintenanceResponse.ok).toBe(true);
    expect(maintenanceResponse.result?.jobs[0]?.job_type).toBe("capability_refresh");

    const submitResponse = await sendRequest<{
      policy_outcome?: { decision: string; reasons: Array<{ code: string }> };
      approval_request?: { status: string; primary_reason?: { code: string; message: string } | null } | null;
      execution_result?: unknown;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeTicketCreateAttempt(
          runId,
          harness.workspaceRoot,
          "Capability gate",
          "Cached unavailable broker state must stop auto execution.",
        ),
      },
      sessionId,
    );

    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.policy_outcome?.decision).toBe("ask");
    expect(submitResponse.result?.policy_outcome?.reasons[0]?.code).toBe("BROKERED_CAPABILITY_UNAVAILABLE");
    expect(submitResponse.result?.approval_request?.status).toBe("pending");
    expect(submitResponse.result?.approval_request?.primary_reason?.code).toBe("BROKERED_CAPABILITY_UNAVAILABLE");
    expect(submitResponse.result?.execution_result).toBeNull();
  });

  it("requires approval for owned ticket mutations when cached capability state is stale", async () => {
    const service = await startTicketService();
    process.env.AGENTGIT_TICKETS_BASE_URL = service.baseUrl;
    process.env.AGENTGIT_TICKETS_BEARER_TOKEN = "test-ticket-token";

    const harness = await createHarness(undefined, null, 0);
    const { sessionId, runId } = await createSessionAndRun(harness, "ticket-capability-stale");

    const maintenanceResponse = await sendRequest<{
      jobs: Array<{
        job_type: string;
        status: string;
      }>;
    }>(
      harness,
      "run_maintenance",
      {
        job_types: ["capability_refresh"],
        scope: {
          workspace_root: harness.workspaceRoot,
        },
      },
      sessionId,
    );
    expect(maintenanceResponse.ok).toBe(true);
    expect(maintenanceResponse.result?.jobs[0]?.job_type).toBe("capability_refresh");
    await new Promise((resolve) => setTimeout(resolve, 5));

    const submitResponse = await sendRequest<{
      policy_outcome?: { decision: string; reasons: Array<{ code: string }> };
      approval_request?: { status: string; primary_reason?: { code: string; message: string } | null } | null;
      execution_result?: unknown;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeTicketCreateAttempt(
          runId,
          harness.workspaceRoot,
          "Capability drift",
          "Stale capability cache must stop auto execution.",
        ),
      },
      sessionId,
    );

    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.policy_outcome?.decision).toBe("ask");
    expect(submitResponse.result?.policy_outcome?.reasons[0]?.code).toBe("CAPABILITY_STATE_STALE");
    expect(submitResponse.result?.approval_request?.status).toBe("pending");
    expect(submitResponse.result?.approval_request?.primary_reason?.code).toBe("CAPABILITY_STATE_STALE");
    expect(submitResponse.result?.execution_result).toBeNull();
    expect(service.requests).toHaveLength(0);

    await service.close();
  });

  it("requires approval for governed filesystem writes when cached workspace capability state is stale", async () => {
    const harness = await createHarness(undefined, null, 0);
    const { sessionId, runId } = await createSessionAndRun(harness, "filesystem-capability-stale");
    const targetPath = path.join(harness.workspaceRoot, "stale-capability.txt");

    const maintenanceResponse = await sendRequest<{
      jobs: Array<{
        job_type: string;
        status: string;
      }>;
    }>(
      harness,
      "run_maintenance",
      {
        job_types: ["capability_refresh"],
        scope: {
          workspace_root: harness.workspaceRoot,
        },
      },
      sessionId,
    );
    expect(maintenanceResponse.ok).toBe(true);
    expect(maintenanceResponse.result?.jobs[0]?.job_type).toBe("capability_refresh");
    await new Promise((resolve) => setTimeout(resolve, 5));

    const submitResponse = await sendRequest<{
      policy_outcome?: { decision: string; reasons: Array<{ code: string }> };
      approval_request?: { status: string; primary_reason?: { code: string; message: string } | null } | null;
      execution_result?: unknown;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeFilesystemWriteAttempt(runId, harness.workspaceRoot, targetPath, "should not write"),
      },
      sessionId,
    );

    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.policy_outcome?.decision).toBe("ask");
    expect(submitResponse.result?.policy_outcome?.reasons[0]?.code).toBe("CAPABILITY_STATE_STALE");
    expect(submitResponse.result?.approval_request?.status).toBe("pending");
    expect(submitResponse.result?.approval_request?.primary_reason?.code).toBe("CAPABILITY_STATE_STALE");
    expect(submitResponse.result?.execution_result).toBeNull();
    expect(fs.existsSync(targetPath)).toBe(false);
  });

  it("resolves an approval-gated filesystem write after capability drift", async () => {
    const harness = await createHarness(undefined, null, 0);
    const { sessionId, runId } = await createSessionAndRun(harness, "filesystem-capability-stale-resolution");
    const targetPath = path.join(harness.workspaceRoot, "stale-capability-resolved.txt");

    const maintenanceResponse = await sendRequest<{
      jobs: Array<{
        job_type: string;
        status: string;
      }>;
    }>(
      harness,
      "run_maintenance",
      {
        job_types: ["capability_refresh"],
        scope: {
          workspace_root: harness.workspaceRoot,
        },
      },
      sessionId,
    );
    expect(maintenanceResponse.ok).toBe(true);
    expect(maintenanceResponse.result?.jobs[0]?.job_type).toBe("capability_refresh");
    await new Promise((resolve) => setTimeout(resolve, 5));

    const submitResponse = await sendRequest<{
      approval_request?: { approval_id: string; status: string } | null;
      execution_result?: unknown;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeFilesystemWriteAttempt(runId, harness.workspaceRoot, targetPath, "write after stale approval"),
      },
      sessionId,
    );
    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.approval_request?.status).toBe("pending");
    expect(submitResponse.result?.execution_result).toBeNull();

    const resolveResponse = await sendRequest<{
      execution_result: { mode: string } | null;
      snapshot_record: { snapshot_id: string; snapshot_class: string } | null;
    }>(
      harness,
      "resolve_approval",
      {
        approval_id: submitResponse.result?.approval_request?.approval_id as string,
        resolution: "approved",
        note: "stale capability resolution",
      },
      sessionId,
    );
    expect(resolveResponse.ok).toBe(true);
    expect(resolveResponse.result?.execution_result?.mode).toBe("executed");
    expect(resolveResponse.result?.snapshot_record).toBeNull();
    expect(fs.readFileSync(targetPath, "utf8")).toBe("write after stale approval");
  });

  it("captures a snapshot before executing an approval-gated delete after capability drift", async () => {
    const harness = await createHarness(undefined, null, 0);
    const { sessionId, runId } = await createSessionAndRun(harness, "filesystem-delete-capability-stale");
    const targetPath = path.join(harness.workspaceRoot, "delete-after-approval.txt");
    fs.writeFileSync(targetPath, "delete me", "utf8");

    const maintenanceResponse = await sendRequest<{
      jobs: Array<{
        job_type: string;
        status: string;
      }>;
    }>(
      harness,
      "run_maintenance",
      {
        job_types: ["capability_refresh"],
        scope: {
          workspace_root: harness.workspaceRoot,
        },
      },
      sessionId,
    );
    expect(maintenanceResponse.ok).toBe(true);
    expect(maintenanceResponse.result?.jobs[0]?.job_type).toBe("capability_refresh");
    await new Promise((resolve) => setTimeout(resolve, 5));

    const submitResponse = await sendRequest<{
      policy_outcome?: {
        decision: string;
        reasons: Array<{ code: string }>;
        preconditions: { snapshot_required: boolean; approval_required: boolean };
      };
      approval_request?: { approval_id: string; status: string } | null;
      snapshot_record?: unknown;
      execution_result?: unknown;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeFilesystemDeleteAttempt(runId, harness.workspaceRoot, targetPath),
      },
      sessionId,
    );

    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.policy_outcome?.decision).toBe("ask");
    expect(submitResponse.result?.policy_outcome?.reasons[0]?.code).toBe("CAPABILITY_STATE_STALE");
    expect(submitResponse.result?.policy_outcome?.preconditions.approval_required).toBe(true);
    expect(submitResponse.result?.policy_outcome?.preconditions.snapshot_required).toBe(true);
    expect(submitResponse.result?.approval_request?.status).toBe("pending");
    expect(submitResponse.result?.execution_result).toBeNull();
    expect(submitResponse.result?.snapshot_record).toBeNull();
    expect(fs.existsSync(targetPath)).toBe(true);

    const resolveResponse = await sendRequest<{
      execution_result: { mode: string } | null;
      snapshot_record: { snapshot_id: string } | null;
    }>(
      harness,
      "resolve_approval",
      {
        approval_id: submitResponse.result?.approval_request?.approval_id as string,
        resolution: "approved",
        note: "stale capability override",
      },
      sessionId,
    );
    expect(resolveResponse.ok).toBe(true);
    expect(resolveResponse.result?.execution_result?.mode).toBe("executed");
    expect(resolveResponse.result?.snapshot_record?.snapshot_id).toBeTruthy();
    expect(fs.existsSync(targetPath)).toBe(false);
  });

  it("requires approval for governed filesystem writes when cached workspace access is unavailable", async () => {
    const harness = await createHarness();
    const missingWorkspaceRoot = path.join(harness.tempRoot, "missing-governed-workspace");
    const { sessionId, runId } = await createSessionAndRunForWorkspaceRoot(
      harness,
      missingWorkspaceRoot,
      "filesystem-capability-unavailable",
    );
    const targetPath = path.join(missingWorkspaceRoot, "blocked-write.txt");

    const maintenanceResponse = await sendRequest<{
      jobs: Array<{
        job_type: string;
        status: string;
      }>;
    }>(
      harness,
      "run_maintenance",
      {
        job_types: ["capability_refresh"],
        scope: {
          workspace_root: missingWorkspaceRoot,
        },
      },
      sessionId,
    );
    expect(maintenanceResponse.ok).toBe(true);
    expect(maintenanceResponse.result?.jobs[0]?.job_type).toBe("capability_refresh");

    const submitResponse = await sendRequest<{
      policy_outcome?: { decision: string; reasons: Array<{ code: string }> };
      approval_request?: { status: string; primary_reason?: { code: string; message: string } | null } | null;
      execution_result?: unknown;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeFilesystemWriteAttempt(runId, missingWorkspaceRoot, targetPath, "blocked"),
      },
      sessionId,
    );

    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.policy_outcome?.decision).toBe("ask");
    expect(submitResponse.result?.policy_outcome?.reasons[0]?.code).toBe("WORKSPACE_CAPABILITY_UNAVAILABLE");
    expect(submitResponse.result?.approval_request?.status).toBe("pending");
    expect(submitResponse.result?.approval_request?.primary_reason?.code).toBe("WORKSPACE_CAPABILITY_UNAVAILABLE");
    expect(submitResponse.result?.execution_result).toBeNull();
    expect(fs.existsSync(targetPath)).toBe(false);
  });

  it("requires approval for snapshot-backed shell mutations when cached capability state is stale", async () => {
    const harness = await createHarness(undefined, null, 0);
    const { sessionId, runId } = await createSessionAndRun(harness, "shell-capability-stale");
    const sourcePath = path.join(harness.workspaceRoot, "shell-source.txt");
    const destinationPath = path.join(harness.workspaceRoot, "shell-destination.txt");
    fs.writeFileSync(sourcePath, "hello", "utf8");

    const maintenanceResponse = await sendRequest<{
      jobs: Array<{
        job_type: string;
        status: string;
      }>;
    }>(
      harness,
      "run_maintenance",
      {
        job_types: ["capability_refresh"],
        scope: {
          workspace_root: harness.workspaceRoot,
        },
      },
      sessionId,
    );
    expect(maintenanceResponse.ok).toBe(true);
    expect(maintenanceResponse.result?.jobs[0]?.job_type).toBe("capability_refresh");
    await new Promise((resolve) => setTimeout(resolve, 5));

    const submitResponse = await sendRequest<{
      policy_outcome?: { decision: string; reasons: Array<{ code: string }> };
      approval_request?: { status: string } | null;
      execution_result?: unknown;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeShellAttempt(runId, harness.workspaceRoot, ["mv", sourcePath, destinationPath]),
      },
      sessionId,
    );

    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.policy_outcome?.decision).toBe("ask");
    expect(submitResponse.result?.policy_outcome?.reasons[0]?.code).toBe("CAPABILITY_STATE_STALE");
    expect(submitResponse.result?.approval_request?.status).toBe("pending");
    expect(submitResponse.result?.execution_result).toBeNull();
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(destinationPath)).toBe(false);
  });

  it("warms helper facts inline and invalidates cached answers when durable artifact evidence drifts", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "helper-fact-warm");
    const targetPath = path.join(harness.workspaceRoot, "helper-fact-warm.txt");

    const submitResponse = await sendRequest<{
      execution_result: { mode: string } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeFilesystemWriteAttempt(runId, harness.workspaceRoot, targetPath, "helper fact warm artifact"),
      },
      sessionId,
    );
    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.execution_result?.mode).toBe("executed");

    const initialTimeline = await sendRequest<{
      steps: Array<{
        primary_artifacts: Array<{
          type: string;
          artifact_id?: string;
        }>;
      }>;
    }>(harness, "query_timeline", { run_id: runId }, sessionId);
    expect(initialTimeline.ok).toBe(true);

    const artifactId = initialTimeline.result?.steps
      .flatMap((step) => step.primary_artifacts)
      .find((artifact) => artifact.type === "file_content" && typeof artifact.artifact_id === "string")?.artifact_id;
    expect(typeof artifactId).toBe("string");

    const maintenanceResponse = await sendRequest<{
      accepted_priority: string;
      jobs: Array<{
        job_type: string;
        status: string;
        performed_inline: boolean;
        summary: string;
        stats?: {
          helper_answers_cached?: number;
          runs_considered?: number;
        };
      }>;
    }>(
      harness,
      "run_maintenance",
      {
        job_types: ["helper_fact_warm"],
        priority_override: "administrative",
        scope: {
          run_id: runId,
        },
      },
      sessionId,
    );
    expect(maintenanceResponse.ok).toBe(true);
    expect(maintenanceResponse.result?.accepted_priority).toBe("administrative");
    expect(maintenanceResponse.result?.jobs).toEqual([
      expect.objectContaining({
        job_type: "helper_fact_warm",
        status: "completed",
        performed_inline: true,
      }),
    ]);
    expect(maintenanceResponse.result?.jobs[0]?.stats?.runs_considered).toBe(1);
    expect(maintenanceResponse.result?.jobs[0]?.stats?.helper_answers_cached ?? 0).toBeGreaterThan(0);

    const journal = trackStore(createRunJournal({ dbPath: harness.journalPath }));
    const runSummary = journal.getRunSummary(runId);
    expect(runSummary).not.toBeNull();
    const artifactStateDigest = journal.getRunArtifactStateDigest(runId);
    journal.storeHelperFactCache({
      run_id: runId,
      question_type: "run_summary",
      focus_step_id: null,
      compare_step_id: null,
      visibility_scope: "user",
      event_count: runSummary!.event_count,
      latest_sequence: runSummary!.latest_event?.sequence ?? 0,
      artifact_state_digest: artifactStateDigest,
      response: {
        answer: "cache-hit proof",
        confidence: 1,
        visibility_scope: "user",
        redactions_applied: 0,
        preview_budget: {
          max_inline_preview_chars: 160,
          max_total_inline_preview_chars: 1200,
          preview_chars_used: 0,
          truncated_previews: 0,
          omitted_previews: 0,
        },
        evidence: [],
        uncertainty: [],
      },
      warmed_at: "2026-03-31T12:00:02.000Z",
    });

    const cachedHelper = await sendRequest<{
      answer: string;
      uncertainty: string[];
    }>(harness, "query_helper", { run_id: runId, question_type: "run_summary" }, sessionId);
    expect(cachedHelper.ok).toBe(true);
    expect(cachedHelper.result?.answer).toBe("cache-hit proof");

    const digest = crypto
      .createHash("sha256")
      .update(artifactId as string)
      .digest("hex");
    const artifactPath = path.join(
      harness.tempRoot,
      "artifacts",
      digest.slice(0, 2),
      digest.slice(2, 4),
      `${artifactId}.txt`,
    );
    fs.rmSync(artifactPath, { force: true });

    const recomputedHelper = await sendRequest<{
      answer: string;
      uncertainty: string[];
    }>(harness, "query_helper", { run_id: runId, question_type: "run_summary" }, sessionId);
    expect(recomputedHelper.ok).toBe(true);
    expect(recomputedHelper.result?.answer).not.toBe("cache-hit proof");
    expect(recomputedHelper.result?.uncertainty).toContain(
      "Some referenced artifacts are no longer available in durable storage because they expired, failed integrity verification, became corrupted, or went missing, so parts of the supporting evidence may be unavailable.",
    );

    expect(
      journal.getHelperFactCache({
        run_id: runId,
        question_type: "run_summary",
        visibility_scope: "user",
      })?.response.answer,
    ).not.toBe("cache-hit proof");
  });

  it("surfaces missing durable artifact blobs honestly across timeline helper and direct fetch", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "artifact-missing-blob");
    const targetPath = path.join(harness.workspaceRoot, "missing-artifact-proof.txt");

    const submitResponse = await sendRequest<{
      execution_result: { mode: string } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeFilesystemWriteAttempt(runId, harness.workspaceRoot, targetPath, "artifact-backed content"),
      },
      sessionId,
    );
    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.execution_result?.mode).toBe("executed");

    const initialTimeline = await sendRequest<{
      steps: Array<{
        step_id: string;
        primary_artifacts: Array<{
          type: string;
          artifact_id?: string;
          artifact_status?: string;
          integrity?: {
            schema_version: string;
            digest_algorithm: string;
            digest: string | null;
          };
        }>;
      }>;
    }>(harness, "query_timeline", { run_id: runId }, sessionId);
    expect(initialTimeline.ok).toBe(true);

    const artifactStep = initialTimeline.result?.steps.find((step) =>
      step.primary_artifacts.some(
        (artifact) => artifact.type === "file_content" && typeof artifact.artifact_id === "string",
      ),
    );
    expect(artifactStep).toBeDefined();

    const artifactId = artifactStep?.primary_artifacts.find(
      (artifact) => artifact.type === "file_content" && typeof artifact.artifact_id === "string",
    )?.artifact_id;
    expect(typeof artifactId).toBe("string");

    const digest = crypto
      .createHash("sha256")
      .update(artifactId as string)
      .digest("hex");
    const artifactPath = path.join(
      harness.tempRoot,
      "artifacts",
      digest.slice(0, 2),
      digest.slice(2, 4),
      `${artifactId}.txt`,
    );
    fs.rmSync(artifactPath, { force: true });

    const artifactResponse = await sendRequest<{
      artifact_status: string;
      content_available: boolean;
      content: string;
      returned_chars: number;
    }>(harness, "query_artifact", { artifact_id: artifactId }, sessionId);
    expect(artifactResponse.ok).toBe(true);
    expect(artifactResponse.result?.artifact_status).toBe("missing");
    expect(artifactResponse.result?.content_available).toBe(false);
    expect(artifactResponse.result?.content).toBe("");
    expect(artifactResponse.result?.returned_chars).toBe(0);

    const degradedTimeline = await sendRequest<{
      steps: Array<{
        step_id: string;
        warnings?: string[];
        primary_artifacts: Array<{ type: string; artifact_id?: string; artifact_status?: string }>;
      }>;
    }>(harness, "query_timeline", { run_id: runId }, sessionId);
    expect(degradedTimeline.ok).toBe(true);

    const degradedStep = degradedTimeline.result?.steps.find((step) => step.step_id === artifactStep?.step_id);
    expect(
      degradedStep?.primary_artifacts.find((artifact) => artifact.artifact_id === artifactId)?.artifact_status,
    ).toBe("missing");
    expect(degradedStep?.warnings?.some((warning) => warning.includes("missing from durable storage"))).toBe(true);

    const helperResponse = await sendRequest<{
      uncertainty: string[];
    }>(
      harness,
      "query_helper",
      {
        run_id: runId,
        question_type: "step_details",
        focus_step_id: artifactStep?.step_id,
      },
      sessionId,
    );
    expect(helperResponse.ok).toBe(true);
    expect(
      helperResponse.result?.uncertainty.some((entry) => entry.includes("no longer available in durable storage")),
    ).toBe(true);
  });

  it("surfaces retained artifacts as expired after restart instead of pretending they are still available", async () => {
    const harness = await createHarness(undefined, 0);
    const { sessionId, runId } = await createSessionAndRun(harness, "artifact-expiry-retention");
    const targetPath = path.join(harness.workspaceRoot, "expired-artifact-proof.txt");

    const submitResponse = await sendRequest<{
      execution_result: { mode: string } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeFilesystemWriteAttempt(runId, harness.workspaceRoot, targetPath, "retained-then-expired"),
      },
      sessionId,
    );
    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.execution_result?.mode).toBe("executed");

    await restartHarness(harness);

    const timelineResponse = await sendRequest<{
      steps: Array<{
        step_id: string;
        warnings?: string[];
        primary_artifacts: Array<{ type: string; artifact_id?: string; artifact_status?: string }>;
      }>;
    }>(harness, "query_timeline", { run_id: runId }, sessionId);
    expect(timelineResponse.ok).toBe(true);

    const artifactStep = timelineResponse.result?.steps.find((step) =>
      step.primary_artifacts.some(
        (artifact) => artifact.type === "file_content" && artifact.artifact_status === "expired",
      ),
    );
    expect(artifactStep).toBeDefined();
    expect(
      artifactStep?.warnings?.some(
        (warning) => warning.includes("retention policy") && warning.includes("no longer available"),
      ),
    ).toBe(true);

    const artifactId = artifactStep?.primary_artifacts.find(
      (artifact) => artifact.type === "file_content" && artifact.artifact_status === "expired",
    )?.artifact_id;
    expect(typeof artifactId).toBe("string");

    const artifactResponse = await sendRequest<{
      artifact: { expires_at: string | null; expired_at: string | null };
      artifact_status: string;
      content_available: boolean;
      content: string;
    }>(harness, "query_artifact", { artifact_id: artifactId }, sessionId);
    expect(artifactResponse.ok).toBe(true);
    expect(artifactResponse.result?.artifact_status).toBe("expired");
    expect(artifactResponse.result?.content_available).toBe(false);
    expect(artifactResponse.result?.content).toBe("");
    expect(typeof artifactResponse.result?.artifact.expires_at).toBe("string");
    expect(typeof artifactResponse.result?.artifact.expired_at).toBe("string");

    const helperResponse = await sendRequest<{
      uncertainty: string[];
    }>(
      harness,
      "query_helper",
      {
        run_id: runId,
        question_type: "step_details",
        focus_step_id: artifactStep?.step_id,
      },
      sessionId,
    );
    expect(helperResponse.ok).toBe(true);
    expect(
      helperResponse.result?.uncertainty.some((entry) =>
        entry.includes("expired, failed integrity verification, became corrupted, or went missing"),
      ),
    ).toBe(true);
  });

  it("surfaces corrupted artifact blobs honestly across timeline helper and direct fetch", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "artifact-corrupted-blob");
    const targetPath = path.join(harness.workspaceRoot, "corrupted-artifact-proof.txt");

    const submitResponse = await sendRequest<{
      execution_result: { mode: string } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeFilesystemWriteAttempt(runId, harness.workspaceRoot, targetPath, "artifact-backed content"),
      },
      sessionId,
    );
    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.execution_result?.mode).toBe("executed");

    const initialTimeline = await sendRequest<{
      steps: Array<{
        step_id: string;
        primary_artifacts: Array<{ type: string; artifact_id?: string; artifact_status?: string }>;
      }>;
    }>(harness, "query_timeline", { run_id: runId }, sessionId);
    expect(initialTimeline.ok).toBe(true);

    const artifactStep = initialTimeline.result?.steps.find((step) =>
      step.primary_artifacts.some(
        (artifact) => artifact.type === "file_content" && typeof artifact.artifact_id === "string",
      ),
    );
    expect(artifactStep).toBeDefined();

    const artifactId = artifactStep?.primary_artifacts.find(
      (artifact) => artifact.type === "file_content" && typeof artifact.artifact_id === "string",
    )?.artifact_id;
    expect(typeof artifactId).toBe("string");

    const digest = crypto
      .createHash("sha256")
      .update(artifactId as string)
      .digest("hex");
    const artifactPath = path.join(
      harness.tempRoot,
      "artifacts",
      digest.slice(0, 2),
      digest.slice(2, 4),
      `${artifactId}.txt`,
    );
    fs.rmSync(artifactPath, { force: true });
    fs.mkdirSync(artifactPath, { recursive: true });

    const artifactResponse = await sendRequest<{
      artifact_status: string;
      content_available: boolean;
      content: string;
      returned_chars: number;
    }>(harness, "query_artifact", { artifact_id: artifactId }, sessionId);
    expect(artifactResponse.ok).toBe(true);
    expect(artifactResponse.result?.artifact_status).toBe("corrupted");
    expect(artifactResponse.result?.content_available).toBe(false);
    expect(artifactResponse.result?.content).toBe("");
    expect(artifactResponse.result?.returned_chars).toBe(0);

    const degradedTimeline = await sendRequest<{
      steps: Array<{
        step_id: string;
        warnings?: string[];
        primary_artifacts: Array<{ type: string; artifact_id?: string; artifact_status?: string }>;
      }>;
    }>(harness, "query_timeline", { run_id: runId }, sessionId);
    expect(degradedTimeline.ok).toBe(true);

    const degradedStep = degradedTimeline.result?.steps.find((step) => step.step_id === artifactStep?.step_id);
    expect(
      degradedStep?.primary_artifacts.find((artifact) => artifact.artifact_id === artifactId)?.artifact_status,
    ).toBe("corrupted");
    expect(degradedStep?.warnings?.some((warning) => warning.includes("corrupted in durable storage"))).toBe(true);

    const helperResponse = await sendRequest<{
      uncertainty: string[];
    }>(
      harness,
      "query_helper",
      {
        run_id: runId,
        question_type: "step_details",
        focus_step_id: artifactStep?.step_id,
      },
      sessionId,
    );
    expect(helperResponse.ok).toBe(true);
    expect(helperResponse.result?.uncertainty.some((entry) => entry.includes("became corrupted"))).toBe(true);
  });

  it("surfaces readable digest-mismatched artifacts as tampered instead of available", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "artifact-tampered-blob");
    const targetPath = path.join(harness.workspaceRoot, "tampered-artifact-proof.txt");

    const submitResponse = await sendRequest<{
      execution_result: { mode: string } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeFilesystemWriteAttempt(runId, harness.workspaceRoot, targetPath, "original!"),
      },
      sessionId,
    );
    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.execution_result?.mode).toBe("executed");

    const initialTimeline = await sendRequest<{
      steps: Array<{
        step_id: string;
        primary_artifacts: Array<{ type: string; artifact_id?: string; artifact_status?: string }>;
      }>;
    }>(harness, "query_timeline", { run_id: runId }, sessionId);
    expect(initialTimeline.ok).toBe(true);

    const artifactStep = initialTimeline.result?.steps.find((step) =>
      step.primary_artifacts.some(
        (artifact) => artifact.type === "file_content" && typeof artifact.artifact_id === "string",
      ),
    );
    expect(artifactStep).toBeDefined();

    const artifactId = artifactStep?.primary_artifacts.find(
      (artifact) => artifact.type === "file_content" && typeof artifact.artifact_id === "string",
    )?.artifact_id;
    expect(typeof artifactId).toBe("string");

    const digest = crypto
      .createHash("sha256")
      .update(artifactId as string)
      .digest("hex");
    const artifactPath = path.join(
      harness.tempRoot,
      "artifacts",
      digest.slice(0, 2),
      digest.slice(2, 4),
      `${artifactId}.txt`,
    );
    fs.writeFileSync(artifactPath, "tampered!", "utf8");

    const artifactResponse = await sendRequest<{
      artifact: {
        integrity: {
          schema_version: string;
          digest_algorithm: string;
          digest: string | null;
        };
      };
      artifact_status: string;
      content_available: boolean;
      content: string;
      returned_chars: number;
    }>(harness, "query_artifact", { artifact_id: artifactId }, sessionId);
    expect(artifactResponse.ok).toBe(true);
    expect(artifactResponse.result?.artifact_status).toBe("tampered");
    expect(artifactResponse.result?.artifact.integrity).toEqual({
      schema_version: "artifact-integrity.v1",
      digest_algorithm: "sha256",
      digest: crypto.createHash("sha256").update("original!", "utf8").digest("hex"),
    });
    expect(artifactResponse.result?.content_available).toBe(false);
    expect(artifactResponse.result?.content).toBe("");
    expect(artifactResponse.result?.returned_chars).toBe(0);

    const degradedTimeline = await sendRequest<{
      steps: Array<{
        step_id: string;
        warnings?: string[];
        primary_artifacts: Array<{
          type: string;
          artifact_id?: string;
          artifact_status?: string;
          integrity?: {
            schema_version: string;
            digest_algorithm: string;
            digest: string | null;
          };
        }>;
      }>;
    }>(harness, "query_timeline", { run_id: runId }, sessionId);
    expect(degradedTimeline.ok).toBe(true);

    const degradedStep = degradedTimeline.result?.steps.find((step) => step.step_id === artifactStep?.step_id);
    expect(
      degradedStep?.primary_artifacts.find((artifact) => artifact.artifact_id === artifactId)?.artifact_status,
    ).toBe("tampered");
    expect(degradedStep?.primary_artifacts.find((artifact) => artifact.artifact_id === artifactId)?.integrity).toEqual({
      schema_version: "artifact-integrity.v1",
      digest_algorithm: "sha256",
      digest: crypto.createHash("sha256").update("original!", "utf8").digest("hex"),
    });
    expect(degradedStep?.warnings?.some((warning) => warning.includes("failed content integrity verification"))).toBe(
      true,
    );

    const helperResponse = await sendRequest<{
      uncertainty: string[];
    }>(
      harness,
      "query_helper",
      {
        run_id: runId,
        question_type: "step_details",
        focus_step_id: artifactStep?.step_id,
      },
      sessionId,
    );
    expect(helperResponse.ok).toBe(true);
    expect(helperResponse.result?.uncertainty.some((entry) => entry.includes("failed integrity verification"))).toBe(
      true,
    );
  });

  it("plans approved shell snapshots as manual review boundaries", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "shell-recovery-review");
    const sourcePath = path.join(harness.workspaceRoot, "move-me.txt");
    const destinationPath = path.join(harness.workspaceRoot, "moved.txt");
    fs.writeFileSync(sourcePath, "hello", "utf8");

    const submitResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string; snapshot_class: string } | null;
      execution_result: { mode: string } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeShellAttempt(runId, harness.workspaceRoot, ["mv", sourcePath, destinationPath]),
      },
      sessionId,
    );

    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.execution_result?.mode).toBe("executed");
    expect(submitResponse.result?.snapshot_record?.snapshot_class).toBe("journal_plus_anchor");
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(destinationPath)).toBe(true);
    const snapshotId = submitResponse.result?.snapshot_record?.snapshot_id as string;

    const journal = createRunJournal({ dbPath: harness.journalPath });
    try {
      const events = journal.listRunEvents(runId);
      const policyEvent = events.find(
        (event) =>
          event.event_type === "policy.evaluated" && (event.payload as Record<string, unknown> | undefined)?.action_id,
      );
      const snapshotEvent = events.find(
        (event) =>
          event.event_type === "snapshot.created" &&
          (event.payload as Record<string, unknown> | undefined)?.snapshot_id === snapshotId,
      );
      expect((policyEvent?.payload as Record<string, unknown> | undefined)?.snapshot_selection).toEqual(
        expect.objectContaining({
          snapshot_class: "journal_plus_anchor",
          reason_codes: expect.arrayContaining(["snapshot.shell_mutation_boundary"]),
        }),
      );
      expect(snapshotEvent?.payload).toEqual(
        expect.objectContaining({
          snapshot_class: "journal_plus_anchor",
          selection_reason_codes: expect.arrayContaining(["snapshot.shell_mutation_boundary"]),
          selection_basis: expect.objectContaining({
            operation_family: "shell/filesystem_primitive",
          }),
        }),
      );
    } finally {
      journal.close();
    }

    const planResponse = await sendRequest<{
      recovery_plan: { recovery_class: string; strategy: string };
    }>(harness, "plan_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("review_only");
    expect(planResponse.result?.recovery_plan.strategy).toBe("manual_review_only");

    const executeResponse = await sendRequest<unknown>(
      harness,
      "execute_recovery",
      { snapshot_id: snapshotId },
      sessionId,
    );
    expect(executeResponse.ok).toBe(false);
    expect(executeResponse.error?.code).toBe("PRECONDITION_FAILED");
  });

  it("widens a later narrow filesystem snapshot after repeated ambiguous shell history in the same run", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "history-widened-snapshot");
    const journal = createRunJournal({ dbPath: harness.journalPath });

    try {
      for (const suffix of ["one", "two"]) {
        const action = makeShellActionRecord(
          runId,
          harness.workspaceRoot,
          ["sh", "-lc", `echo ${suffix} >> history.log`],
          {
            action_id: `act_seed_${suffix}`,
          },
        );
        appendSyntheticActionHistory(journal, action, "allow_with_snapshot");
      }
    } finally {
      journal.close();
    }

    const targetPath = path.join(harness.workspaceRoot, "narrow.txt");
    fs.writeFileSync(targetPath, "delete me", "utf8");
    const explainResponse = await sendRequest<{
      snapshot_selection: {
        snapshot_class: string;
        reason_codes: string[];
        basis: {
          recent_ambiguous_shell_mutations: number;
        };
      } | null;
      policy_outcome: { decision: string };
    }>(
      harness,
      "explain_policy_action",
      {
        attempt: makeFilesystemDeleteAttempt(runId, harness.workspaceRoot, targetPath),
      },
      sessionId,
    );

    expect(explainResponse.ok).toBe(true);
    expect(explainResponse.result?.policy_outcome.decision).toBe("allow_with_snapshot");
    expect(explainResponse.result?.snapshot_selection).toEqual(
      expect.objectContaining({
        snapshot_class: "exact_anchor",
        reason_codes: expect.arrayContaining(["snapshot.repeated_ambiguous_shell_history"]),
        basis: expect.objectContaining({
          recent_ambiguous_shell_mutations: 2,
        }),
      }),
    );
  });

  it("compensates owned draft creation through execute_recovery", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "draft-compensation");

    const submitResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string; snapshot_class: string } | null;
      execution_result: { mode: string; output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeDraftCreateAttempt(
          runId,
          harness.workspaceRoot,
          "Launch plan",
          "Build the first owned compensator.",
        ),
      },
      sessionId,
    );

    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.snapshot_record?.snapshot_id).toBeTruthy();
    expect(submitResponse.result?.snapshot_record?.snapshot_class).toBe("metadata_only");
    expect(submitResponse.result?.execution_result?.mode).toBe("executed");

    const snapshotId = submitResponse.result?.snapshot_record?.snapshot_id as string;
    const draftId = submitResponse.result?.execution_result?.output?.external_object_id as string;
    const draftStore = openDraftStore(draftsStatePath(harness.tempRoot));
    expect((await draftStore.getDraft(draftId))?.status).toBe("active");

    const journal = createRunJournal({ dbPath: harness.journalPath });
    try {
      const snapshotEvent = journal
        .listRunEvents(runId)
        .find(
          (event) =>
            event.event_type === "snapshot.created" &&
            (event.payload as Record<string, unknown> | undefined)?.snapshot_id === snapshotId,
        );
      expect(snapshotEvent?.payload).toEqual(
        expect.objectContaining({
          snapshot_class: "metadata_only",
          selection_reason_codes: expect.arrayContaining(["snapshot.non_filesystem_metadata_only"]),
          selection_basis: expect.objectContaining({
            operation_family: "function/create_draft",
          }),
        }),
      );
    } finally {
      journal.close();
    }

    const planResponse = await sendRequest<{
      recovery_plan: { recovery_class: string; strategy: string };
    }>(harness, "plan_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("compensatable");
    expect(planResponse.result?.recovery_plan.strategy).toBe("archive_owned_draft");

    const executeResponse = await sendRequest<{
      restored: boolean;
      outcome: string;
    }>(harness, "execute_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(executeResponse.ok).toBe(true);
    expect(executeResponse.result?.restored).toBe(false);
    expect(executeResponse.result?.outcome).toBe("compensated");

    expect((await draftStore.getDraft(draftId))?.status).toBe("archived");
  });

  it("compensates owned note creation through execute_recovery", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "note-compensation");

    const submitResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { mode: string; output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeNoteCreateAttempt(runId, harness.workspaceRoot, "Launch notes", "Track the second integration."),
      },
      sessionId,
    );

    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.snapshot_record?.snapshot_id).toBeTruthy();
    expect(submitResponse.result?.execution_result?.mode).toBe("executed");

    const snapshotId = submitResponse.result?.snapshot_record?.snapshot_id as string;
    const noteId = submitResponse.result?.execution_result?.output?.external_object_id as string;
    const noteStore = openNoteStore(draftsStatePath(harness.tempRoot));
    expect((await noteStore.getNote(noteId))?.status).toBe("active");

    const planResponse = await sendRequest<{
      recovery_plan: { recovery_class: string; strategy: string };
    }>(harness, "plan_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("compensatable");
    expect(planResponse.result?.recovery_plan.strategy).toBe("archive_owned_note");

    const executeResponse = await sendRequest<{
      restored: boolean;
      outcome: string;
    }>(harness, "execute_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(executeResponse.ok).toBe(true);
    expect(executeResponse.result?.restored).toBe(false);
    expect(executeResponse.result?.outcome).toBe("compensated");
    expect((await noteStore.getNote(noteId))?.status).toBe("archived");
  });

  it("compensates direct owned note archive back to active through execute_recovery", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "note-archive-compensation");

    const createResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeNoteCreateAttempt(runId, harness.workspaceRoot, "Archive notes", "Create then archive."),
      },
      sessionId,
    );

    expect(createResponse.ok).toBe(true);
    const noteId = createResponse.result?.execution_result?.output?.external_object_id as string;

    const archiveResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeNoteArchiveAttempt(runId, harness.workspaceRoot, noteId),
      },
      sessionId,
    );

    expect(archiveResponse.ok).toBe(true);
    expect(archiveResponse.result?.snapshot_record?.snapshot_id).toBeTruthy();
    expect(archiveResponse.result?.execution_result?.output?.external_object_status).toBe("archived");

    const snapshotId = archiveResponse.result?.snapshot_record?.snapshot_id as string;
    const noteStore = openNoteStore(draftsStatePath(harness.tempRoot));
    expect((await noteStore.getNote(noteId))?.status).toBe("archived");

    const planResponse = await sendRequest<{
      recovery_plan: { recovery_class: string; strategy: string };
    }>(harness, "plan_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("compensatable");
    expect(planResponse.result?.recovery_plan.strategy).toBe("unarchive_owned_note");

    const executeResponse = await sendRequest<{
      restored: boolean;
      outcome: string;
    }>(harness, "execute_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(executeResponse.ok).toBe(true);
    expect(executeResponse.result?.restored).toBe(false);
    expect(executeResponse.result?.outcome).toBe("compensated");
    expect((await noteStore.getNote(noteId))?.status).toBe("active");
  });

  it("compensates direct owned note unarchive back to archived through execute_recovery", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "note-unarchive-compensation");

    const createResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeNoteCreateAttempt(runId, harness.workspaceRoot, "Unarchive notes", "Create then flip twice."),
      },
      sessionId,
    );

    expect(createResponse.ok).toBe(true);
    const noteId = createResponse.result?.execution_result?.output?.external_object_id as string;
    const noteStore = openNoteStore(draftsStatePath(harness.tempRoot));
    await noteStore.archiveNote(noteId);
    expect((await noteStore.getNote(noteId))?.status).toBe("archived");

    const unarchiveResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeNoteUnarchiveAttempt(runId, harness.workspaceRoot, noteId),
      },
      sessionId,
    );

    expect(unarchiveResponse.ok).toBe(true);
    expect(unarchiveResponse.result?.snapshot_record?.snapshot_id).toBeTruthy();
    expect(unarchiveResponse.result?.execution_result?.output?.external_object_status).toBe("active");

    const snapshotId = unarchiveResponse.result?.snapshot_record?.snapshot_id as string;
    expect((await noteStore.getNote(noteId))?.status).toBe("active");

    const planResponse = await sendRequest<{
      recovery_plan: { recovery_class: string; strategy: string };
    }>(harness, "plan_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("compensatable");
    expect(planResponse.result?.recovery_plan.strategy).toBe("archive_owned_note");

    const executeResponse = await sendRequest<{
      restored: boolean;
      outcome: string;
    }>(harness, "execute_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(executeResponse.ok).toBe(true);
    expect(executeResponse.result?.restored).toBe(false);
    expect(executeResponse.result?.outcome).toBe("compensated");
    expect((await noteStore.getNote(noteId))?.status).toBe("archived");
  });

  it("compensates owned note update through execute_recovery using captured preimage", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "note-update-compensation");

    const createResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeNoteCreateAttempt(runId, harness.workspaceRoot, "Original notes", "Original note body."),
      },
      sessionId,
    );

    expect(createResponse.ok).toBe(true);
    const noteId = createResponse.result?.execution_result?.output?.external_object_id as string;

    const updateResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { mode: string; output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeNoteUpdateAttempt(runId, harness.workspaceRoot, noteId, "Updated notes", "Updated note body."),
      },
      sessionId,
    );

    expect(updateResponse.ok).toBe(true);
    expect(updateResponse.result?.snapshot_record?.snapshot_id).toBeTruthy();
    expect(updateResponse.result?.execution_result?.mode).toBe("executed");
    expect(updateResponse.result?.execution_result?.output?.subject).toBe("Updated notes");

    const snapshotId = updateResponse.result?.snapshot_record?.snapshot_id as string;
    const noteStore = openNoteStore(draftsStatePath(harness.tempRoot));
    expect(await noteStore.getNote(noteId)).toMatchObject({
      title: "Updated notes",
      body: "Updated note body.",
      status: "active",
    });

    const planResponse = await sendRequest<{
      recovery_plan: { recovery_class: string; strategy: string };
    }>(harness, "plan_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("compensatable");
    expect(planResponse.result?.recovery_plan.strategy).toBe("restore_owned_note_preimage");

    const executeResponse = await sendRequest<{
      restored: boolean;
      outcome: string;
    }>(harness, "execute_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(executeResponse.ok).toBe(true);
    expect(executeResponse.result?.restored).toBe(false);
    expect(executeResponse.result?.outcome).toBe("compensated");

    expect(await noteStore.getNote(noteId)).toMatchObject({
      title: "Original notes",
      body: "Original note body.",
      status: "active",
    });
  });

  it("compensates direct owned note restore using the captured preimage", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "note-restore-compensation");

    const createResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeNoteCreateAttempt(runId, harness.workspaceRoot, "Original restore notes", "Preserve this note."),
      },
      sessionId,
    );

    expect(createResponse.ok).toBe(true);
    const noteId = createResponse.result?.execution_result?.output?.external_object_id as string;

    const restoreResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { mode: string; output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeNoteRestoreAttempt(runId, harness.workspaceRoot, noteId, {
          title: "Restored notes",
          body: "Recovered into archived status.",
          status: "archived",
        }),
      },
      sessionId,
    );

    expect(restoreResponse.ok).toBe(true);
    expect(restoreResponse.result?.snapshot_record?.snapshot_id).toBeTruthy();
    expect(restoreResponse.result?.execution_result?.mode).toBe("executed");
    expect(restoreResponse.result?.execution_result?.output?.external_object_status).toBe("archived");

    const snapshotId = restoreResponse.result?.snapshot_record?.snapshot_id as string;
    const noteStore = openNoteStore(draftsStatePath(harness.tempRoot));
    expect(await noteStore.getNote(noteId)).toMatchObject({
      title: "Restored notes",
      body: "Recovered into archived status.",
      status: "archived",
    });

    const planResponse = await sendRequest<{
      recovery_plan: { recovery_class: string; strategy: string };
    }>(harness, "plan_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("compensatable");
    expect(planResponse.result?.recovery_plan.strategy).toBe("restore_owned_note_preimage");

    const executeResponse = await sendRequest<{
      restored: boolean;
      outcome: string;
    }>(harness, "execute_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(executeResponse.ok).toBe(true);
    expect(executeResponse.result?.restored).toBe(false);
    expect(executeResponse.result?.outcome).toBe("compensated");

    expect(await noteStore.getNote(noteId)).toMatchObject({
      title: "Original restore notes",
      body: "Preserve this note.",
      status: "active",
    });
  });

  it("degrades owned note restore recovery to manual review when captured preimage is missing", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "note-restore-missing-preimage");

    const createResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeNoteCreateAttempt(runId, harness.workspaceRoot, "Original note", "Preserve me."),
      },
      sessionId,
    );

    expect(createResponse.ok).toBe(true);
    const noteId = createResponse.result?.execution_result?.output?.external_object_id as string;

    const restoreResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeNoteRestoreAttempt(runId, harness.workspaceRoot, noteId, {
          title: "Changed note",
          body: "Changed body.",
          status: "archived",
        }),
      },
      sessionId,
    );

    expect(restoreResponse.ok).toBe(true);
    const snapshotId = restoreResponse.result?.snapshot_record?.snapshot_id as string;
    const manifestPath = path.join(harness.snapshotRootPath, "metadata", `${snapshotId}.json`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.captured_preimage = null;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    const planResponse = await sendRequest<{
      recovery_plan: { recovery_class: string; strategy: string };
    }>(harness, "plan_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("review_only");
    expect(planResponse.result?.recovery_plan.strategy).toBe("manual_review_only");

    const executeResponse = await sendRequest<unknown>(
      harness,
      "execute_recovery",
      { snapshot_id: snapshotId },
      sessionId,
    );
    expect(executeResponse.ok).toBe(false);
    expect(executeResponse.error?.code).toBe("PRECONDITION_FAILED");
  });

  it("compensates direct owned note delete using the captured preimage", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "note-delete-compensation");

    const createResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeNoteCreateAttempt(runId, harness.workspaceRoot, "Delete note", "Delete then recover."),
      },
      sessionId,
    );

    expect(createResponse.ok).toBe(true);
    const noteId = createResponse.result?.execution_result?.output?.external_object_id as string;

    const deleteResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { mode: string; output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeNoteDeleteAttempt(runId, harness.workspaceRoot, noteId),
      },
      sessionId,
    );

    expect(deleteResponse.ok).toBe(true);
    expect(deleteResponse.result?.snapshot_record?.snapshot_id).toBeTruthy();
    expect(deleteResponse.result?.execution_result?.output?.external_object_status).toBe("deleted");

    const snapshotId = deleteResponse.result?.snapshot_record?.snapshot_id as string;
    const noteStore = openNoteStore(draftsStatePath(harness.tempRoot));
    expect(await noteStore.getNote(noteId)).toMatchObject({
      status: "deleted",
    });

    const planResponse = await sendRequest<{
      recovery_plan: { recovery_class: string; strategy: string };
    }>(harness, "plan_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("compensatable");
    expect(planResponse.result?.recovery_plan.strategy).toBe("restore_owned_note_preimage");

    const executeResponse = await sendRequest<{
      restored: boolean;
      outcome: string;
    }>(harness, "execute_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(executeResponse.ok).toBe(true);
    expect(executeResponse.result?.restored).toBe(false);
    expect(executeResponse.result?.outcome).toBe("compensated");

    expect(await noteStore.getNote(noteId)).toMatchObject({
      title: "Delete note",
      body: "Delete then recover.",
      status: "active",
    });
  });

  it("creates and compensates an owned ticket through brokered credentials", async () => {
    const service = await startTicketService();
    process.env.AGENTGIT_TICKETS_BASE_URL = service.baseUrl;
    process.env.AGENTGIT_TICKETS_BEARER_TOKEN = "test-ticket-token";

    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "ticket-compensation");

    const submitResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { mode: string; output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeTicketCreateAttempt(
          runId,
          harness.workspaceRoot,
          "Launch blocker",
          "Credentialed adapters must use brokered auth.",
        ),
      },
      sessionId,
    );

    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.snapshot_record?.snapshot_id).toBeTruthy();
    expect(submitResponse.result?.execution_result?.mode).toBe("executed");
    expect(submitResponse.result?.execution_result?.output?.broker_profile_id).toBe("credprof_tickets");

    const snapshotId = submitResponse.result?.snapshot_record?.snapshot_id as string;
    const ticketId = submitResponse.result?.execution_result?.output?.external_object_id as string;
    const ticketStore = openTicketStore(draftsStatePath(harness.tempRoot));
    expect(await ticketStore.getTicket(ticketId)).toMatchObject({
      status: "active",
      title: "Launch blocker",
    });
    expect(service.requests[0]).toEqual({
      method: "PUT",
      url: `/api/tickets/${ticketId}`,
      authorization: "Bearer test-ticket-token",
    });

    const planResponse = await sendRequest<{
      recovery_plan: { recovery_class: string; strategy: string };
    }>(harness, "plan_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("compensatable");
    expect(planResponse.result?.recovery_plan.strategy).toBe("delete_owned_ticket");

    const executeResponse = await sendRequest<{
      restored: boolean;
      outcome: string;
    }>(harness, "execute_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(executeResponse.ok).toBe(true);
    expect(executeResponse.result?.restored).toBe(false);
    expect(executeResponse.result?.outcome).toBe("compensated");
    expect(await ticketStore.getTicket(ticketId)).toMatchObject({
      status: "deleted",
    });
    expect(service.requests[1]).toEqual({
      method: "DELETE",
      url: `/api/tickets/${ticketId}`,
      authorization: "Bearer test-ticket-token",
    });

    await service.close();
  });

  it("deletes and restores an owned ticket through captured preimage recovery", async () => {
    const service = await startTicketService();
    process.env.AGENTGIT_TICKETS_BASE_URL = service.baseUrl;
    process.env.AGENTGIT_TICKETS_BEARER_TOKEN = "test-ticket-token";

    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "ticket-delete-compensation");

    const createResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeTicketCreateAttempt(
          runId,
          harness.workspaceRoot,
          "Launch blocker",
          "Credentialed adapters must use brokered auth.",
        ),
      },
      sessionId,
    );
    expect(createResponse.ok).toBe(true);
    const ticketId = createResponse.result?.execution_result?.output?.external_object_id as string;

    const addLabelResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      { attempt: makeTicketAddLabelAttempt(runId, harness.workspaceRoot, ticketId, "priority/high") },
      sessionId,
    );
    expect(addLabelResponse.ok).toBe(true);

    const assignUserResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      { attempt: makeTicketAssignUserAttempt(runId, harness.workspaceRoot, ticketId, "user_123") },
      sessionId,
    );
    expect(assignUserResponse.ok).toBe(true);

    const closeResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      { attempt: makeTicketCloseAttempt(runId, harness.workspaceRoot, ticketId) },
      sessionId,
    );
    expect(closeResponse.ok).toBe(true);

    const deleteResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      { attempt: makeTicketDeleteAttempt(runId, harness.workspaceRoot, ticketId) },
      sessionId,
    );
    expect(deleteResponse.ok).toBe(true);
    expect(deleteResponse.result?.execution_result?.output?.external_object_status).toBe("deleted");

    const snapshotId = deleteResponse.result?.snapshot_record?.snapshot_id as string;
    const ticketStore = openTicketStore(draftsStatePath(harness.tempRoot));
    expect(await ticketStore.getTicket(ticketId)).toMatchObject({
      status: "deleted",
      labels: ["priority/high"],
      assigned_users: ["user_123"],
    });

    const planResponse = await sendRequest<{
      recovery_plan: { strategy: string; recovery_class: string };
    }>(harness, "plan_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.strategy).toBe("restore_owned_ticket_preimage");
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("compensatable");

    const executeResponse = await sendRequest<{
      restored: boolean;
      outcome: string;
    }>(harness, "execute_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(executeResponse.ok).toBe(true);
    expect(executeResponse.result?.restored).toBe(false);
    expect(executeResponse.result?.outcome).toBe("compensated");
    expect(await ticketStore.getTicket(ticketId)).toMatchObject({
      status: "closed",
      labels: ["priority/high"],
      assigned_users: ["user_123"],
      deleted_at: null,
    });

    await service.close();
  });

  it("restores and then re-deletes an owned ticket through captured preimage recovery", async () => {
    const service = await startTicketService();
    process.env.AGENTGIT_TICKETS_BASE_URL = service.baseUrl;
    process.env.AGENTGIT_TICKETS_BEARER_TOKEN = "test-ticket-token";

    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "ticket-restore-compensation");

    const createResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeTicketCreateAttempt(
          runId,
          harness.workspaceRoot,
          "Launch blocker",
          "Credentialed adapters must use brokered auth.",
        ),
      },
      sessionId,
    );
    expect(createResponse.ok).toBe(true);
    const ticketId = createResponse.result?.execution_result?.output?.external_object_id as string;

    const deleteResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      { attempt: makeTicketDeleteAttempt(runId, harness.workspaceRoot, ticketId) },
      sessionId,
    );
    expect(deleteResponse.ok).toBe(true);

    const restoreResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeTicketRestoreAttempt(runId, harness.workspaceRoot, ticketId, {
          title: "Restored blocker",
          body: "Restore deleted tickets honestly.",
          status: "active",
          labels: ["priority/high"],
          assigned_users: ["user_123"],
        }),
      },
      sessionId,
    );
    expect(restoreResponse.ok).toBe(true);
    expect(restoreResponse.result?.execution_result?.output?.external_object_status).toBe("active");
    expect(restoreResponse.result?.execution_result?.output?.labels).toEqual(["priority/high"]);
    expect(restoreResponse.result?.execution_result?.output?.assigned_users).toEqual(["user_123"]);

    const snapshotId = restoreResponse.result?.snapshot_record?.snapshot_id as string;
    const ticketStore = openTicketStore(draftsStatePath(harness.tempRoot));
    expect(await ticketStore.getTicket(ticketId)).toMatchObject({
      status: "active",
      labels: ["priority/high"],
      assigned_users: ["user_123"],
      deleted_at: null,
    });

    const planResponse = await sendRequest<{
      recovery_plan: { strategy: string; recovery_class: string };
    }>(harness, "plan_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.strategy).toBe("restore_owned_ticket_preimage");
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("compensatable");

    const executeResponse = await sendRequest<{
      restored: boolean;
      outcome: string;
    }>(harness, "execute_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(executeResponse.ok).toBe(true);
    expect(executeResponse.result?.outcome).toBe("compensated");
    expect(await ticketStore.getTicket(ticketId)).toMatchObject({
      status: "deleted",
      title: "Launch blocker",
    });

    await service.close();
  });

  it("closes and reopens an owned ticket through brokered recovery", async () => {
    const service = await startTicketService();
    process.env.AGENTGIT_TICKETS_BASE_URL = service.baseUrl;
    process.env.AGENTGIT_TICKETS_BEARER_TOKEN = "test-ticket-token";

    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "ticket-close-compensation");

    const createResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeTicketCreateAttempt(
          runId,
          harness.workspaceRoot,
          "Launch blocker",
          "Credentialed adapters must use brokered auth.",
        ),
      },
      sessionId,
    );

    expect(createResponse.ok).toBe(true);
    const ticketId = createResponse.result?.execution_result?.output?.external_object_id as string;

    const closeResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { mode: string; output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeTicketCloseAttempt(runId, harness.workspaceRoot, ticketId),
      },
      sessionId,
    );

    expect(closeResponse.ok).toBe(true);
    expect(closeResponse.result?.snapshot_record?.snapshot_id).toBeTruthy();
    expect(closeResponse.result?.execution_result?.mode).toBe("executed");
    expect(closeResponse.result?.execution_result?.output?.external_object_status).toBe("closed");

    const snapshotId = closeResponse.result?.snapshot_record?.snapshot_id as string;
    const ticketStore = openTicketStore(draftsStatePath(harness.tempRoot));
    expect(await ticketStore.getTicket(ticketId)).toMatchObject({
      status: "closed",
      title: "Launch blocker",
    });
    expect(service.requests.slice(0, 2)).toEqual([
      {
        method: "PUT",
        url: `/api/tickets/${ticketId}`,
        authorization: "Bearer test-ticket-token",
      },
      {
        method: "PATCH",
        url: `/api/tickets/${ticketId}`,
        authorization: "Bearer test-ticket-token",
      },
    ]);

    const planResponse = await sendRequest<{
      recovery_plan: { recovery_class: string; strategy: string };
    }>(harness, "plan_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("compensatable");
    expect(planResponse.result?.recovery_plan.strategy).toBe("reopen_owned_ticket");

    const executeResponse = await sendRequest<{
      restored: boolean;
      outcome: string;
    }>(harness, "execute_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(executeResponse.ok).toBe(true);
    expect(executeResponse.result?.restored).toBe(false);
    expect(executeResponse.result?.outcome).toBe("compensated");
    expect(await ticketStore.getTicket(ticketId)).toMatchObject({
      status: "active",
      closed_at: null,
    });
    expect(service.requests[2]).toEqual({
      method: "PATCH",
      url: `/api/tickets/${ticketId}`,
      authorization: "Bearer test-ticket-token",
    });

    await service.close();
  });

  it("reopens and recloses an owned ticket through brokered recovery", async () => {
    const service = await startTicketService();
    process.env.AGENTGIT_TICKETS_BASE_URL = service.baseUrl;
    process.env.AGENTGIT_TICKETS_BEARER_TOKEN = "test-ticket-token";

    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "ticket-reopen-compensation");

    const createResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeTicketCreateAttempt(
          runId,
          harness.workspaceRoot,
          "Launch blocker",
          "Credentialed adapters must use brokered auth.",
        ),
      },
      sessionId,
    );

    expect(createResponse.ok).toBe(true);
    const ticketId = createResponse.result?.execution_result?.output?.external_object_id as string;

    const closeResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeTicketCloseAttempt(runId, harness.workspaceRoot, ticketId),
      },
      sessionId,
    );
    expect(closeResponse.ok).toBe(true);

    const reopenResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { mode: string; output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeTicketReopenAttempt(runId, harness.workspaceRoot, ticketId),
      },
      sessionId,
    );

    expect(reopenResponse.ok).toBe(true);
    expect(reopenResponse.result?.snapshot_record?.snapshot_id).toBeTruthy();
    expect(reopenResponse.result?.execution_result?.output?.external_object_status).toBe("active");

    const snapshotId = reopenResponse.result?.snapshot_record?.snapshot_id as string;
    const ticketStore = openTicketStore(draftsStatePath(harness.tempRoot));
    expect(await ticketStore.getTicket(ticketId)).toMatchObject({
      status: "active",
      closed_at: null,
    });

    const planResponse = await sendRequest<{
      recovery_plan: { recovery_class: string; strategy: string };
    }>(harness, "plan_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("compensatable");
    expect(planResponse.result?.recovery_plan.strategy).toBe("close_owned_ticket");

    const executeResponse = await sendRequest<{
      restored: boolean;
      outcome: string;
    }>(harness, "execute_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(executeResponse.ok).toBe(true);
    expect(executeResponse.result?.restored).toBe(false);
    expect(executeResponse.result?.outcome).toBe("compensated");
    expect((await ticketStore.getTicket(ticketId))?.status).toBe("closed");

    await service.close();
  });

  it("restores an owned ticket update from captured preimage during recovery", async () => {
    const service = await startTicketService();
    process.env.AGENTGIT_TICKETS_BASE_URL = service.baseUrl;
    process.env.AGENTGIT_TICKETS_BEARER_TOKEN = "test-ticket-token";

    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "ticket-update-compensation");

    const createResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeTicketCreateAttempt(
          runId,
          harness.workspaceRoot,
          "Launch blocker",
          "Credentialed adapters must use brokered auth.",
        ),
      },
      sessionId,
    );

    expect(createResponse.ok).toBe(true);
    const ticketId = createResponse.result?.execution_result?.output?.external_object_id as string;

    const updateResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { mode: string; output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeTicketUpdateAttempt(runId, harness.workspaceRoot, ticketId, {
          title: "Updated blocker",
          body: "Recovered ticket flow needs preimage restore.",
        }),
      },
      sessionId,
    );

    expect(updateResponse.ok).toBe(true);
    expect(updateResponse.result?.snapshot_record?.snapshot_id).toBeTruthy();
    expect(updateResponse.result?.execution_result?.output?.external_object_status).toBe("active");
    expect(updateResponse.result?.execution_result?.output?.subject).toBe("Updated blocker");

    const snapshotId = updateResponse.result?.snapshot_record?.snapshot_id as string;
    const ticketStore = openTicketStore(draftsStatePath(harness.tempRoot));
    expect(await ticketStore.getTicket(ticketId)).toMatchObject({
      title: "Updated blocker",
      body: "Recovered ticket flow needs preimage restore.",
      status: "active",
    });
    expect(service.requests.slice(0, 2)).toEqual([
      {
        method: "PUT",
        url: `/api/tickets/${ticketId}`,
        authorization: "Bearer test-ticket-token",
      },
      {
        method: "PATCH",
        url: `/api/tickets/${ticketId}`,
        authorization: "Bearer test-ticket-token",
      },
    ]);

    const planResponse = await sendRequest<{
      recovery_plan: { recovery_class: string; strategy: string };
    }>(harness, "plan_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("compensatable");
    expect(planResponse.result?.recovery_plan.strategy).toBe("restore_owned_ticket_preimage");

    const executeResponse = await sendRequest<{
      restored: boolean;
      outcome: string;
    }>(harness, "execute_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(executeResponse.ok).toBe(true);
    expect(executeResponse.result?.restored).toBe(false);
    expect(executeResponse.result?.outcome).toBe("compensated");
    expect(await ticketStore.getTicket(ticketId)).toMatchObject({
      title: "Launch blocker",
      body: "Credentialed adapters must use brokered auth.",
      status: "active",
    });
    expect(service.requests[2]).toEqual({
      method: "PATCH",
      url: `/api/tickets/${ticketId}`,
      authorization: "Bearer test-ticket-token",
    });

    await service.close();
  });

  it("adds and removes an owned ticket label through brokered recovery", async () => {
    const service = await startTicketService();
    process.env.AGENTGIT_TICKETS_BASE_URL = service.baseUrl;
    process.env.AGENTGIT_TICKETS_BEARER_TOKEN = "test-ticket-token";

    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "ticket-label-compensation");

    const createResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeTicketCreateAttempt(
          runId,
          harness.workspaceRoot,
          "Launch blocker",
          "Credentialed adapters must use brokered auth.",
        ),
      },
      sessionId,
    );

    expect(createResponse.ok).toBe(true);
    const ticketId = createResponse.result?.execution_result?.output?.external_object_id as string;

    const addLabelResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { mode: string; output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeTicketAddLabelAttempt(runId, harness.workspaceRoot, ticketId, "priority/high"),
      },
      sessionId,
    );

    expect(addLabelResponse.ok).toBe(true);
    expect(addLabelResponse.result?.snapshot_record?.snapshot_id).toBeTruthy();
    expect(addLabelResponse.result?.execution_result?.output?.labels).toEqual(["priority/high"]);

    const snapshotId = addLabelResponse.result?.snapshot_record?.snapshot_id as string;
    const ticketStore = openTicketStore(draftsStatePath(harness.tempRoot));
    expect(await ticketStore.getTicket(ticketId)).toMatchObject({
      labels: ["priority/high"],
      status: "active",
    });

    const planResponse = await sendRequest<{
      recovery_plan: { recovery_class: string; strategy: string };
    }>(harness, "plan_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("compensatable");
    expect(planResponse.result?.recovery_plan.strategy).toBe("remove_owned_ticket_label");

    const executeResponse = await sendRequest<{
      restored: boolean;
      outcome: string;
    }>(harness, "execute_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(executeResponse.ok).toBe(true);
    expect(executeResponse.result?.restored).toBe(false);
    expect(executeResponse.result?.outcome).toBe("compensated");
    expect((await ticketStore.getTicket(ticketId))?.labels).toEqual([]);

    await service.close();
  });

  it("removes and re-adds an owned ticket label through brokered recovery", async () => {
    const service = await startTicketService();
    process.env.AGENTGIT_TICKETS_BASE_URL = service.baseUrl;
    process.env.AGENTGIT_TICKETS_BEARER_TOKEN = "test-ticket-token";

    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "ticket-remove-label-compensation");

    const createResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeTicketCreateAttempt(
          runId,
          harness.workspaceRoot,
          "Launch blocker",
          "Credentialed adapters must use brokered auth.",
        ),
      },
      sessionId,
    );

    expect(createResponse.ok).toBe(true);
    const ticketId = createResponse.result?.execution_result?.output?.external_object_id as string;

    const addLabelResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeTicketAddLabelAttempt(runId, harness.workspaceRoot, ticketId, "priority/high"),
      },
      sessionId,
    );
    expect(addLabelResponse.ok).toBe(true);

    const removeLabelResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { mode: string; output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeTicketRemoveLabelAttempt(runId, harness.workspaceRoot, ticketId, "priority/high"),
      },
      sessionId,
    );

    expect(removeLabelResponse.ok).toBe(true);
    expect(removeLabelResponse.result?.snapshot_record?.snapshot_id).toBeTruthy();
    expect(removeLabelResponse.result?.execution_result?.output?.labels).toEqual([]);

    const snapshotId = removeLabelResponse.result?.snapshot_record?.snapshot_id as string;
    const ticketStore = openTicketStore(draftsStatePath(harness.tempRoot));
    expect(await ticketStore.getTicket(ticketId)).toMatchObject({
      labels: [],
      status: "active",
    });

    const planResponse = await sendRequest<{
      recovery_plan: { recovery_class: string; strategy: string };
    }>(harness, "plan_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("compensatable");
    expect(planResponse.result?.recovery_plan.strategy).toBe("add_owned_ticket_label");

    const executeResponse = await sendRequest<{
      restored: boolean;
      outcome: string;
    }>(harness, "execute_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(executeResponse.ok).toBe(true);
    expect(executeResponse.result?.restored).toBe(false);
    expect(executeResponse.result?.outcome).toBe("compensated");
    expect((await ticketStore.getTicket(ticketId))?.labels).toEqual(["priority/high"]);

    await service.close();
  });

  it("assigns and unassigns an owned ticket user through brokered recovery", async () => {
    const service = await startTicketService();
    process.env.AGENTGIT_TICKETS_BASE_URL = service.baseUrl;
    process.env.AGENTGIT_TICKETS_BEARER_TOKEN = "test-ticket-token";

    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "ticket-assignee-compensation");

    const createResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeTicketCreateAttempt(
          runId,
          harness.workspaceRoot,
          "Launch blocker",
          "Credentialed adapters must use brokered auth.",
        ),
      },
      sessionId,
    );

    expect(createResponse.ok).toBe(true);
    const ticketId = createResponse.result?.execution_result?.output?.external_object_id as string;

    const assignResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { mode: string; output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeTicketAssignUserAttempt(runId, harness.workspaceRoot, ticketId, "user_123"),
      },
      sessionId,
    );

    expect(assignResponse.ok).toBe(true);
    expect(assignResponse.result?.snapshot_record?.snapshot_id).toBeTruthy();
    expect(assignResponse.result?.execution_result?.output?.assigned_users).toEqual(["user_123"]);

    const snapshotId = assignResponse.result?.snapshot_record?.snapshot_id as string;
    const ticketStore = openTicketStore(draftsStatePath(harness.tempRoot));
    expect(await ticketStore.getTicket(ticketId)).toMatchObject({
      assigned_users: ["user_123"],
      status: "active",
    });

    const planResponse = await sendRequest<{
      recovery_plan: { recovery_class: string; strategy: string };
    }>(harness, "plan_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("compensatable");
    expect(planResponse.result?.recovery_plan.strategy).toBe("unassign_owned_ticket_user");

    const executeResponse = await sendRequest<{
      restored: boolean;
      outcome: string;
    }>(harness, "execute_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(executeResponse.ok).toBe(true);
    expect(executeResponse.result?.restored).toBe(false);
    expect(executeResponse.result?.outcome).toBe("compensated");
    expect((await ticketStore.getTicket(ticketId))?.assigned_users).toEqual([]);

    await service.close();
  });

  it("unassigns and reassigns an owned ticket user through brokered recovery", async () => {
    const service = await startTicketService();
    process.env.AGENTGIT_TICKETS_BASE_URL = service.baseUrl;
    process.env.AGENTGIT_TICKETS_BEARER_TOKEN = "test-ticket-token";

    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "ticket-user-reassign-compensation");

    const createResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeTicketCreateAttempt(
          runId,
          harness.workspaceRoot,
          "Launch blocker",
          "Credentialed adapters must use brokered auth.",
        ),
      },
      sessionId,
    );

    expect(createResponse.ok).toBe(true);
    const ticketId = createResponse.result?.execution_result?.output?.external_object_id as string;

    const assignResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeTicketAssignUserAttempt(runId, harness.workspaceRoot, ticketId, "user_123"),
      },
      sessionId,
    );
    expect(assignResponse.ok).toBe(true);

    const unassignResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { mode: string; output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeTicketUnassignUserAttempt(runId, harness.workspaceRoot, ticketId, "user_123"),
      },
      sessionId,
    );

    expect(unassignResponse.ok).toBe(true);
    expect(unassignResponse.result?.snapshot_record?.snapshot_id).toBeTruthy();
    expect(unassignResponse.result?.execution_result?.output?.assigned_users).toEqual([]);

    const snapshotId = unassignResponse.result?.snapshot_record?.snapshot_id as string;
    const ticketStore = openTicketStore(draftsStatePath(harness.tempRoot));
    expect(await ticketStore.getTicket(ticketId)).toMatchObject({
      assigned_users: [],
      status: "active",
    });

    const planResponse = await sendRequest<{
      recovery_plan: { recovery_class: string; strategy: string };
    }>(harness, "plan_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("compensatable");
    expect(planResponse.result?.recovery_plan.strategy).toBe("assign_owned_ticket_user");

    const executeResponse = await sendRequest<{
      restored: boolean;
      outcome: string;
    }>(harness, "execute_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(executeResponse.ok).toBe(true);
    expect(executeResponse.result?.restored).toBe(false);
    expect(executeResponse.result?.outcome).toBe("compensated");
    expect((await ticketStore.getTicket(ticketId))?.assigned_users).toEqual(["user_123"]);

    await service.close();
  });

  it("degrades ticket update recovery to manual review when captured preimage is missing", async () => {
    const service = await startTicketService();
    process.env.AGENTGIT_TICKETS_BASE_URL = service.baseUrl;
    process.env.AGENTGIT_TICKETS_BEARER_TOKEN = "test-ticket-token";

    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "ticket-update-no-preimage");

    const createResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeTicketCreateAttempt(runId, harness.workspaceRoot, "Launch blocker", "Original body."),
      },
      sessionId,
    );
    expect(createResponse.ok).toBe(true);
    const ticketId = createResponse.result?.execution_result?.output?.external_object_id as string;

    const updateResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeTicketUpdateAttempt(runId, harness.workspaceRoot, ticketId, {
          title: "Updated blocker",
        }),
      },
      sessionId,
    );
    expect(updateResponse.ok).toBe(true);

    const snapshotId = updateResponse.result?.snapshot_record?.snapshot_id as string;
    const manifestPath = path.join(harness.snapshotRootPath, "metadata", `${snapshotId}.json`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.captured_preimage = null;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const planResponse = await sendRequest<{
      recovery_plan: { recovery_class: string; strategy: string; review_guidance?: Record<string, unknown> };
    }>(harness, "plan_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("review_only");
    expect(planResponse.result?.recovery_plan.strategy).toBe("manual_review_only");
    expect(planResponse.result?.recovery_plan.review_guidance).toBeTruthy();

    await service.close();
  });

  it("fails closed when brokered ticket credentials are not configured", async () => {
    delete process.env.AGENTGIT_TICKETS_BASE_URL;
    delete process.env.AGENTGIT_TICKETS_BEARER_TOKEN;

    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "ticket-broker-missing");

    const submitResponse = await sendRequest<unknown>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeTicketCreateAttempt(
          runId,
          harness.workspaceRoot,
          "Launch blocker",
          "Credentialed adapters must use brokered auth.",
        ),
      },
      sessionId,
    );

    expect(submitResponse.ok).toBe(false);
    expect(submitResponse.error?.code).toBe("BROKER_UNAVAILABLE");
  });

  it("denies direct credentials for owned ticket creation before execution", async () => {
    const service = await startTicketService();
    process.env.AGENTGIT_TICKETS_BASE_URL = service.baseUrl;
    process.env.AGENTGIT_TICKETS_BEARER_TOKEN = "test-ticket-token";

    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "ticket-direct-denied");

    const submitResponse = await sendRequest<{
      policy_outcome?: { decision: string; reasons: Array<{ code: string }> };
      execution_result?: unknown;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: {
          ...makeTicketCreateAttempt(
            runId,
            harness.workspaceRoot,
            "Launch blocker",
            "Credentialed adapters must use brokered auth.",
          ),
          environment_context: {
            workspace_roots: [harness.workspaceRoot],
            cwd: harness.workspaceRoot,
            credential_mode: "direct",
          },
        },
      },
      sessionId,
    );

    expect(submitResponse.ok).toBe(true);
    expect(submitResponse.result?.policy_outcome?.decision).toBe("deny");
    expect(submitResponse.result?.policy_outcome?.reasons[0]?.code).toBe("DIRECT_CREDENTIALS_FORBIDDEN");
    expect(submitResponse.result?.execution_result).toBeNull();
    expect(service.requests).toHaveLength(0);

    await service.close();
  });

  it("returns not found when the owned note disappears before compensation", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "note-compensation-missing");

    const submitResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeNoteCreateAttempt(runId, harness.workspaceRoot, "Missing note", "Delete before recovery."),
      },
      sessionId,
    );

    expect(submitResponse.ok).toBe(true);
    const snapshotId = submitResponse.result?.snapshot_record?.snapshot_id as string;
    const noteId = submitResponse.result?.execution_result?.output?.external_object_id as string;
    await restartHarness(harness);
    const looseState = createLooseNoteState(draftsStatePath(harness.tempRoot));
    looseState.delete("notes", noteId);
    looseState.close();
    await restartHarness(harness);
    const noteStore = openNoteStore(draftsStatePath(harness.tempRoot));
    expect(await noteStore.getNote(noteId)).toBeNull();

    const executeResponse = await sendRequest<unknown>(
      harness,
      "execute_recovery",
      { snapshot_id: snapshotId },
      sessionId,
    );
    expect(executeResponse.ok).toBe(false);
    expect(executeResponse.error?.code).toBe("NOT_FOUND");
  });

  it("compensates owned draft archive through execute_recovery", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "draft-archive-compensation");

    const createResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeDraftCreateAttempt(runId, harness.workspaceRoot, "Archive plan", "Create then archive."),
      },
      sessionId,
    );

    expect(createResponse.ok).toBe(true);
    const draftId = createResponse.result?.execution_result?.output?.external_object_id as string;

    const archiveResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { mode: string; output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeDraftArchiveAttempt(runId, harness.workspaceRoot, draftId),
      },
      sessionId,
    );

    expect(archiveResponse.ok).toBe(true);
    expect(archiveResponse.result?.snapshot_record?.snapshot_id).toBeTruthy();
    expect(archiveResponse.result?.execution_result?.output?.external_object_status).toBe("archived");

    const snapshotId = archiveResponse.result?.snapshot_record?.snapshot_id as string;
    const draftStore = openDraftStore(draftsStatePath(harness.tempRoot));
    expect((await draftStore.getDraft(draftId))?.status).toBe("archived");

    const planResponse = await sendRequest<{
      recovery_plan: { recovery_class: string; strategy: string };
    }>(harness, "plan_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("compensatable");
    expect(planResponse.result?.recovery_plan.strategy).toBe("unarchive_owned_draft");

    const executeResponse = await sendRequest<{
      restored: boolean;
      outcome: string;
    }>(harness, "execute_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(executeResponse.ok).toBe(true);
    expect(executeResponse.result?.restored).toBe(false);
    expect(executeResponse.result?.outcome).toBe("compensated");

    expect((await draftStore.getDraft(draftId))?.status).toBe("active");
  });

  it("compensates direct owned draft unarchive back to archived through execute_recovery", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "draft-unarchive-compensation");

    const createResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeDraftCreateAttempt(runId, harness.workspaceRoot, "Unarchive plan", "Create then flip twice."),
      },
      sessionId,
    );

    expect(createResponse.ok).toBe(true);
    const draftId = createResponse.result?.execution_result?.output?.external_object_id as string;
    const draftStore = openDraftStore(draftsStatePath(harness.tempRoot));
    await draftStore.archiveDraft(draftId);
    expect((await draftStore.getDraft(draftId))?.status).toBe("archived");

    const unarchiveResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeDraftUnarchiveAttempt(runId, harness.workspaceRoot, draftId),
      },
      sessionId,
    );

    expect(unarchiveResponse.ok).toBe(true);
    expect(unarchiveResponse.result?.snapshot_record?.snapshot_id).toBeTruthy();
    expect(unarchiveResponse.result?.execution_result?.output?.external_object_status).toBe("active");

    const snapshotId = unarchiveResponse.result?.snapshot_record?.snapshot_id as string;
    expect((await draftStore.getDraft(draftId))?.status).toBe("active");

    const planResponse = await sendRequest<{
      recovery_plan: { recovery_class: string; strategy: string };
    }>(harness, "plan_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("compensatable");
    expect(planResponse.result?.recovery_plan.strategy).toBe("archive_owned_draft");

    const executeResponse = await sendRequest<{
      restored: boolean;
      outcome: string;
    }>(harness, "execute_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(executeResponse.ok).toBe(true);
    expect(executeResponse.result?.restored).toBe(false);
    expect(executeResponse.result?.outcome).toBe("compensated");

    expect((await draftStore.getDraft(draftId))?.status).toBe("archived");
  });

  it("compensates direct owned draft delete using the captured preimage", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "draft-delete-compensation");

    const createResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeDraftCreateAttempt(runId, harness.workspaceRoot, "Delete plan", "Delete then recover."),
      },
      sessionId,
    );

    expect(createResponse.ok).toBe(true);
    const draftId = createResponse.result?.execution_result?.output?.external_object_id as string;

    const deleteResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { mode: string; output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeDraftDeleteAttempt(runId, harness.workspaceRoot, draftId),
      },
      sessionId,
    );

    expect(deleteResponse.ok).toBe(true);
    expect(deleteResponse.result?.snapshot_record?.snapshot_id).toBeTruthy();
    expect(deleteResponse.result?.execution_result?.output?.external_object_status).toBe("deleted");

    const snapshotId = deleteResponse.result?.snapshot_record?.snapshot_id as string;
    const draftStore = openDraftStore(draftsStatePath(harness.tempRoot));
    expect(await draftStore.getDraft(draftId)).toMatchObject({
      status: "deleted",
    });

    const planResponse = await sendRequest<{
      recovery_plan: { recovery_class: string; strategy: string };
    }>(harness, "plan_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("compensatable");
    expect(planResponse.result?.recovery_plan.strategy).toBe("restore_owned_draft_preimage");

    const executeResponse = await sendRequest<{
      restored: boolean;
      outcome: string;
    }>(harness, "execute_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(executeResponse.ok).toBe(true);
    expect(executeResponse.result?.restored).toBe(false);
    expect(executeResponse.result?.outcome).toBe("compensated");

    expect(await draftStore.getDraft(draftId)).toMatchObject({
      subject: "Delete plan",
      body: "Delete then recover.",
      status: "active",
      labels: [],
    });
  });

  it("compensates owned draft update through execute_recovery using captured preimage", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "draft-update-compensation");

    const createResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeDraftCreateAttempt(runId, harness.workspaceRoot, "Original plan", "Original draft body."),
      },
      sessionId,
    );

    expect(createResponse.ok).toBe(true);
    const draftId = createResponse.result?.execution_result?.output?.external_object_id as string;

    const updateResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { mode: string; output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeDraftUpdateAttempt(runId, harness.workspaceRoot, draftId, "Updated plan", "Updated draft body."),
      },
      sessionId,
    );

    expect(updateResponse.ok).toBe(true);
    expect(updateResponse.result?.snapshot_record?.snapshot_id).toBeTruthy();
    expect(updateResponse.result?.execution_result?.mode).toBe("executed");
    expect(updateResponse.result?.execution_result?.output?.subject).toBe("Updated plan");

    const snapshotId = updateResponse.result?.snapshot_record?.snapshot_id as string;
    const draftStore = openDraftStore(draftsStatePath(harness.tempRoot));
    expect(await draftStore.getDraft(draftId)).toMatchObject({
      subject: "Updated plan",
      body: "Updated draft body.",
      status: "active",
    });

    const planResponse = await sendRequest<{
      recovery_plan: { recovery_class: string; strategy: string };
    }>(harness, "plan_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("compensatable");
    expect(planResponse.result?.recovery_plan.strategy).toBe("restore_owned_draft_preimage");

    const executeResponse = await sendRequest<{
      restored: boolean;
      outcome: string;
    }>(harness, "execute_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(executeResponse.ok).toBe(true);
    expect(executeResponse.result?.restored).toBe(false);
    expect(executeResponse.result?.outcome).toBe("compensated");

    expect(await draftStore.getDraft(draftId)).toMatchObject({
      subject: "Original plan",
      body: "Original draft body.",
      status: "active",
    });
  });

  it("compensates owned draft label addition through execute_recovery", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "draft-label-compensation");

    const createResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeDraftCreateAttempt(runId, harness.workspaceRoot, "Labeled plan", "Add a label then recover."),
      },
      sessionId,
    );

    expect(createResponse.ok).toBe(true);
    const draftId = createResponse.result?.execution_result?.output?.external_object_id as string;

    const addLabelResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { mode: string; output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeDraftAddLabelAttempt(runId, harness.workspaceRoot, draftId, "priority/high"),
      },
      sessionId,
    );

    expect(addLabelResponse.ok).toBe(true);
    expect(addLabelResponse.result?.snapshot_record?.snapshot_id).toBeTruthy();
    expect(addLabelResponse.result?.execution_result?.mode).toBe("executed");
    expect(addLabelResponse.result?.execution_result?.output?.labels).toEqual(["priority/high"]);

    const snapshotId = addLabelResponse.result?.snapshot_record?.snapshot_id as string;
    const draftStore = openDraftStore(draftsStatePath(harness.tempRoot));
    expect((await draftStore.getDraft(draftId))?.labels).toEqual(["priority/high"]);

    const planResponse = await sendRequest<{
      recovery_plan: { recovery_class: string; strategy: string };
    }>(harness, "plan_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("compensatable");
    expect(planResponse.result?.recovery_plan.strategy).toBe("remove_owned_draft_label");

    const executeResponse = await sendRequest<{
      restored: boolean;
      outcome: string;
    }>(harness, "execute_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(executeResponse.ok).toBe(true);
    expect(executeResponse.result?.restored).toBe(false);
    expect(executeResponse.result?.outcome).toBe("compensated");
    expect((await draftStore.getDraft(draftId))?.labels).toEqual([]);
  });

  it("compensates direct owned draft label removal by restoring the missing label", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "draft-label-remove-compensation");

    const createResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeDraftCreateAttempt(runId, harness.workspaceRoot, "Remove label plan", "Remove then recover."),
      },
      sessionId,
    );

    expect(createResponse.ok).toBe(true);
    const draftId = createResponse.result?.execution_result?.output?.external_object_id as string;
    const draftStore = openDraftStore(draftsStatePath(harness.tempRoot));
    await draftStore.addLabel(draftId, "priority/high");

    const removeResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeDraftRemoveLabelAttempt(runId, harness.workspaceRoot, draftId, "priority/high"),
      },
      sessionId,
    );

    expect(removeResponse.ok).toBe(true);
    expect(removeResponse.result?.snapshot_record?.snapshot_id).toBeTruthy();
    expect(removeResponse.result?.execution_result?.output?.labels).toEqual([]);

    const snapshotId = removeResponse.result?.snapshot_record?.snapshot_id as string;
    expect((await draftStore.getDraft(draftId))?.labels).toEqual([]);

    const planResponse = await sendRequest<{
      recovery_plan: { recovery_class: string; strategy: string };
    }>(harness, "plan_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("compensatable");
    expect(planResponse.result?.recovery_plan.strategy).toBe("add_owned_draft_label");

    const executeResponse = await sendRequest<{
      restored: boolean;
      outcome: string;
    }>(harness, "execute_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(executeResponse.ok).toBe(true);
    expect(executeResponse.result?.restored).toBe(false);
    expect(executeResponse.result?.outcome).toBe("compensated");
    expect((await draftStore.getDraft(draftId))?.labels).toEqual(["priority/high"]);
  });

  it("compensates direct owned draft restore using the captured preimage", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "draft-restore-compensation");

    const createResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeDraftCreateAttempt(
          runId,
          harness.workspaceRoot,
          "Original restore plan",
          "Original restore body.",
        ),
      },
      sessionId,
    );

    expect(createResponse.ok).toBe(true);
    const draftId = createResponse.result?.execution_result?.output?.external_object_id as string;

    const restoreResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { mode: string; output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeDraftRestoreAttempt(runId, harness.workspaceRoot, draftId, {
          subject: "Restored draft plan",
          body: "Recovered into an archived state.",
          status: "archived",
          labels: ["priority/high", "ops"],
        }),
      },
      sessionId,
    );

    expect(restoreResponse.ok).toBe(true);
    expect(restoreResponse.result?.snapshot_record?.snapshot_id).toBeTruthy();
    expect(restoreResponse.result?.execution_result?.mode).toBe("executed");
    expect(restoreResponse.result?.execution_result?.output?.external_object_status).toBe("archived");

    const snapshotId = restoreResponse.result?.snapshot_record?.snapshot_id as string;
    const draftStore = openDraftStore(draftsStatePath(harness.tempRoot));
    expect(await draftStore.getDraft(draftId)).toMatchObject({
      subject: "Restored draft plan",
      body: "Recovered into an archived state.",
      status: "archived",
      labels: ["priority/high", "ops"],
    });

    const planResponse = await sendRequest<{
      recovery_plan: { recovery_class: string; strategy: string };
    }>(harness, "plan_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("compensatable");
    expect(planResponse.result?.recovery_plan.strategy).toBe("restore_owned_draft_preimage");

    const executeResponse = await sendRequest<{
      restored: boolean;
      outcome: string;
    }>(harness, "execute_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(executeResponse.ok).toBe(true);
    expect(executeResponse.result?.restored).toBe(false);
    expect(executeResponse.result?.outcome).toBe("compensated");

    expect(await draftStore.getDraft(draftId)).toMatchObject({
      subject: "Original restore plan",
      body: "Original restore body.",
      status: "active",
      labels: [],
    });
  });

  it("compensates direct owned draft restore from deleted state using the captured preimage", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "draft-restore-deleted-compensation");

    const createResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeDraftCreateAttempt(runId, harness.workspaceRoot, "Original deleted plan", "Preserve this draft."),
      },
      sessionId,
    );

    expect(createResponse.ok).toBe(true);
    const draftId = createResponse.result?.execution_result?.output?.external_object_id as string;

    const restoreResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { mode: string; output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeDraftRestoreAttempt(runId, harness.workspaceRoot, draftId, {
          subject: "Deleted restore plan",
          body: "Move the draft into deleted state.",
          status: "deleted",
          labels: ["priority/high"],
        }),
      },
      sessionId,
    );

    expect(restoreResponse.ok).toBe(true);
    expect(restoreResponse.result?.snapshot_record?.snapshot_id).toBeTruthy();
    expect(restoreResponse.result?.execution_result?.output?.external_object_status).toBe("deleted");

    const snapshotId = restoreResponse.result?.snapshot_record?.snapshot_id as string;
    const draftStore = openDraftStore(draftsStatePath(harness.tempRoot));
    expect(await draftStore.getDraft(draftId)).toMatchObject({
      subject: "Deleted restore plan",
      body: "Move the draft into deleted state.",
      status: "deleted",
      labels: ["priority/high"],
    });

    const planResponse = await sendRequest<{
      recovery_plan: { recovery_class: string; strategy: string };
    }>(harness, "plan_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("compensatable");
    expect(planResponse.result?.recovery_plan.strategy).toBe("restore_owned_draft_preimage");

    const executeResponse = await sendRequest<{
      restored: boolean;
      outcome: string;
    }>(harness, "execute_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(executeResponse.ok).toBe(true);
    expect(executeResponse.result?.restored).toBe(false);
    expect(executeResponse.result?.outcome).toBe("compensated");

    expect(await draftStore.getDraft(draftId)).toMatchObject({
      subject: "Original deleted plan",
      body: "Preserve this draft.",
      status: "active",
      labels: [],
    });
  });

  it("degrades owned draft restore recovery to manual review when captured preimage is missing", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "draft-restore-missing-preimage");

    const createResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeDraftCreateAttempt(runId, harness.workspaceRoot, "Original restore plan", "Preserve me."),
      },
      sessionId,
    );

    expect(createResponse.ok).toBe(true);
    const draftId = createResponse.result?.execution_result?.output?.external_object_id as string;

    const restoreResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeDraftRestoreAttempt(runId, harness.workspaceRoot, draftId, {
          subject: "Changed restore plan",
          body: "Changed restore body.",
          status: "archived",
          labels: ["priority/high"],
        }),
      },
      sessionId,
    );

    expect(restoreResponse.ok).toBe(true);
    const snapshotId = restoreResponse.result?.snapshot_record?.snapshot_id as string;
    const manifestPath = path.join(harness.snapshotRootPath, "metadata", `${snapshotId}.json`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.captured_preimage = null;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    const planResponse = await sendRequest<{
      recovery_plan: { recovery_class: string; strategy: string };
    }>(harness, "plan_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("review_only");
    expect(planResponse.result?.recovery_plan.strategy).toBe("manual_review_only");

    const executeResponse = await sendRequest<unknown>(
      harness,
      "execute_recovery",
      { snapshot_id: snapshotId },
      sessionId,
    );
    expect(executeResponse.ok).toBe(false);
    expect(executeResponse.error?.code).toBe("PRECONDITION_FAILED");
  });

  it("treats repeated owned draft compensation as idempotent", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "draft-compensation-repeat");

    const submitResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeDraftCreateAttempt(runId, harness.workspaceRoot, "Repeat plan", "Run compensation twice."),
      },
      sessionId,
    );

    expect(submitResponse.ok).toBe(true);
    const snapshotId = submitResponse.result?.snapshot_record?.snapshot_id as string;
    const draftId = submitResponse.result?.execution_result?.output?.external_object_id as string;
    const draftStore = openDraftStore(draftsStatePath(harness.tempRoot));

    const firstExecute = await sendRequest<{
      restored: boolean;
      outcome: string;
    }>(harness, "execute_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(firstExecute.ok).toBe(true);
    expect(firstExecute.result?.restored).toBe(false);
    expect(firstExecute.result?.outcome).toBe("compensated");

    const secondExecute = await sendRequest<{
      restored: boolean;
      outcome: string;
    }>(harness, "execute_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(secondExecute.ok).toBe(true);
    expect(secondExecute.result?.restored).toBe(false);
    expect(secondExecute.result?.outcome).toBe("compensated");

    expect((await draftStore.getDraft(draftId))?.status).toBe("archived");
  });

  it("returns not found when the owned draft disappears before compensation", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "draft-compensation-missing");

    const submitResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeDraftCreateAttempt(runId, harness.workspaceRoot, "Missing plan", "Delete before recovery."),
      },
      sessionId,
    );

    expect(submitResponse.ok).toBe(true);
    const snapshotId = submitResponse.result?.snapshot_record?.snapshot_id as string;
    const draftId = submitResponse.result?.execution_result?.output?.external_object_id as string;
    await restartHarness(harness);
    const looseState = createLooseDraftState(draftsStatePath(harness.tempRoot));
    looseState.delete("drafts", draftId);
    looseState.close();
    await restartHarness(harness);
    const submitDraftStore = openDraftStore(draftsStatePath(harness.tempRoot));
    expect(await submitDraftStore.getDraft(draftId)).toBeNull();

    const executeResponse = await sendRequest<unknown>(
      harness,
      "execute_recovery",
      { snapshot_id: snapshotId },
      sessionId,
    );
    expect(executeResponse.ok).toBe(false);
    expect(executeResponse.error?.code).toBe("NOT_FOUND");
  });

  it("degrades owned draft update recovery to manual review when captured preimage is missing", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "draft-update-missing-preimage");

    const createResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeDraftCreateAttempt(runId, harness.workspaceRoot, "Preimage plan", "Preserve me."),
      },
      sessionId,
    );

    expect(createResponse.ok).toBe(true);
    const draftId = createResponse.result?.execution_result?.output?.external_object_id as string;

    const updateResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeDraftUpdateAttempt(runId, harness.workspaceRoot, draftId, "Changed plan", "Changed body."),
      },
      sessionId,
    );

    expect(updateResponse.ok).toBe(true);
    const snapshotId = updateResponse.result?.snapshot_record?.snapshot_id as string;
    const manifestPath = path.join(harness.snapshotRootPath, "metadata", `${snapshotId}.json`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.captured_preimage = null;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    const planResponse = await sendRequest<{
      recovery_plan: { recovery_class: string; strategy: string };
    }>(harness, "plan_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(planResponse.ok).toBe(true);
    expect(planResponse.result?.recovery_plan.recovery_class).toBe("review_only");
    expect(planResponse.result?.recovery_plan.strategy).toBe("manual_review_only");

    const executeResponse = await sendRequest<unknown>(
      harness,
      "execute_recovery",
      { snapshot_id: snapshotId },
      sessionId,
    );
    expect(executeResponse.ok).toBe(false);
    expect(executeResponse.error?.code).toBe("PRECONDITION_FAILED");
  });

  it("treats missing labels as idempotent during owned draft label compensation", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "draft-label-compensation-repeat");

    const createResponse = await sendRequest<{
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeDraftCreateAttempt(runId, harness.workspaceRoot, "Idempotent label plan", "Remove label twice."),
      },
      sessionId,
    );

    expect(createResponse.ok).toBe(true);
    const draftId = createResponse.result?.execution_result?.output?.external_object_id as string;

    const addLabelResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeDraftAddLabelAttempt(runId, harness.workspaceRoot, draftId, "priority/high"),
      },
      sessionId,
    );

    expect(addLabelResponse.ok).toBe(true);
    const snapshotId = addLabelResponse.result?.snapshot_record?.snapshot_id as string;
    const draftStore = openDraftStore(draftsStatePath(harness.tempRoot));
    await draftStore.removeLabel(draftId, "priority/high");
    expect((await draftStore.getDraft(draftId))?.labels).toEqual([]);

    const executeResponse = await sendRequest<{
      restored: boolean;
      outcome: string;
    }>(harness, "execute_recovery", { snapshot_id: snapshotId }, sessionId);
    expect(executeResponse.ok).toBe(true);
    expect(executeResponse.result?.outcome).toBe("compensated");
    expect((await draftStore.getDraft(draftId))?.labels).toEqual([]);
  });

  it("returns storage unavailable when the owned draft store is corrupted", async () => {
    const harness = await createHarness();
    const { sessionId, runId } = await createSessionAndRun(harness, "draft-compensation-corrupt-store");

    const submitResponse = await sendRequest<{
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { output?: Record<string, unknown> } | null;
    }>(
      harness,
      "submit_action_attempt",
      {
        attempt: makeDraftCreateAttempt(
          runId,
          harness.workspaceRoot,
          "Corrupt plan",
          "Break the store before recovery.",
        ),
      },
      sessionId,
    );

    expect(submitResponse.ok).toBe(true);
    const snapshotId = submitResponse.result?.snapshot_record?.snapshot_id as string;
    const draftId = submitResponse.result?.execution_result?.output?.external_object_id as string;
    await restartHarness(harness);
    const looseState = createLooseDraftState(draftsStatePath(harness.tempRoot));
    looseState.put("drafts", draftId, {
      invalid: true,
      reason: "corrupt for adversarial recovery test",
    });
    looseState.close();
    await restartHarness(harness);

    const executeResponse = await sendRequest<unknown>(
      harness,
      "execute_recovery",
      { snapshot_id: snapshotId },
      sessionId,
    );
    expect(executeResponse.ok).toBe(false);
    expect(executeResponse.error?.code).toBe("STORAGE_UNAVAILABLE");
  });
});
