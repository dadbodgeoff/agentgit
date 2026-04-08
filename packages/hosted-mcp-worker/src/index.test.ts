import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import {
  HostedMcpWorkerExecuteRequestPayload,
  HostedMcpWorkerExecuteResponsePayloadSchema,
  HostedMcpWorkerHelloResponsePayloadSchema,
  HostedMcpWorkerResponseEnvelopeSchema,
  validate,
} from "@agentgit/schemas";

import { startHostedMcpWorkerServer } from "./index.js";

const TEMP_ROOT = path.join("/tmp", `agentgit-hosted-worker-${process.pid}`);
const closers: Array<() => Promise<void>> = [];

async function sendLine(socketPath: string, line: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${line}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      const raw = buffer.slice(0, newlineIndex);
      socket.end();
      resolve(JSON.parse(raw));
    });
    socket.on("error", reject);
  });
}

async function startMcpService(requireBearerToken: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    if (req.headers.authorization !== `Bearer ${requireBearerToken}` && body?.method === "tools/call") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }));
      return;
    }

    const mcpServer = new McpServer({
      name: "hosted-worker-test-server",
      version: "1.0.0",
    });
    mcpServer.registerTool(
      "echo_note",
      {
        description: "Echo a note.",
        inputSchema: {
          note: z.string(),
        },
        annotations: {
          readOnlyHint: true,
        },
      },
      async ({ note }) => ({
        content: [{ type: "text", text: `worker:${note}` }],
      }),
    );

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start hosted worker MCP test service.");
  }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: closers[closers.length - 1]!,
  };
}

afterEach(async () => {
  while (closers.length > 0) {
    await closers.pop()!();
  }
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
});

describe("hosted MCP worker", () => {
  it("serves hello and executes a lease-scoped hosted MCP call", async () => {
    fs.mkdirSync(TEMP_ROOT, { recursive: true });
    const socketPath = path.join(TEMP_ROOT, "worker.sock");
    const keyPath = path.join(TEMP_ROOT, "worker-key.json");
    const token = "worker-test-token";
    const service = await startMcpService("worker-secret");
    const server = await startHostedMcpWorkerServer({
      endpoint: `unix:${socketPath}`,
      attestationKeyPath: keyPath,
      controlToken: token,
    });
    closers.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
    );

    const helloEnvelope = validate(
      HostedMcpWorkerResponseEnvelopeSchema,
      await sendLine(
        socketPath,
        JSON.stringify({
          request_id: "req_hello",
          method: "hello",
          auth_token: token,
          payload: {},
        }),
      ),
    );
    expect(helloEnvelope.ok).toBe(true);
    const hello = validate(HostedMcpWorkerHelloResponsePayloadSchema, helloEnvelope.result);
    expect(hello.endpoint_kind).toBe("unix");
    expect(hello.control_plane_auth_required).toBe(true);

    const executePayload: HostedMcpWorkerExecuteRequestPayload = {
      job_id: "mcpjob_test",
      lease: {
        lease_id: "mcplease_test",
        run_id: "run_test",
        action_id: "action_test",
        server_profile_id: "mcpprof_test",
        tool_name: "echo_note",
        auth_context_ref: "oauth_session:mcpbind_test:secret_test",
        allowed_hosts: ["127.0.0.1"],
        issued_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 30_000).toISOString(),
        artifact_budget: {
          max_artifacts: 4,
          max_total_bytes: 4096,
        },
        single_use: true,
        status: "issued",
        consumed_at: null,
        revoked_at: null,
      },
      action_id: "action_test",
      server_id: "mcpprof_test",
      server_display_name: "Test profile",
      canonical_endpoint: service.url,
      network_scope: "loopback",
      max_concurrent_calls: 1,
      tool_name: "echo_note",
      arguments: {
        note: "hello",
      },
      auth: {
        type: "delegated_bearer",
        authorization_header: "Bearer worker-secret",
      },
    };

    const executeEnvelope = validate(
      HostedMcpWorkerResponseEnvelopeSchema,
      await sendLine(
        socketPath,
        JSON.stringify({
          request_id: "req_exec",
          method: "execute_hosted_mcp",
          auth_token: token,
          payload: executePayload,
        }),
      ),
    );
    expect(executeEnvelope.ok).toBe(true);
    const execution = validate(HostedMcpWorkerExecuteResponsePayloadSchema, executeEnvelope.result);
    expect(execution.execution_result.output.summary).toBe("worker:hello");
    expect(execution.attestation.payload.lease_id).toBe("mcplease_test");
    expect(execution.attestation.payload.worker_runtime_id).toBe(hello.worker_runtime_id);
  });

  it("rejects malformed attestation key material on startup", async () => {
    fs.mkdirSync(TEMP_ROOT, { recursive: true });
    const socketPath = path.join(TEMP_ROOT, "worker.sock");
    const keyPath = path.join(TEMP_ROOT, "worker-key.json");
    fs.writeFileSync(keyPath, "{not-json", "utf8");

    expect(() =>
      startHostedMcpWorkerServer({
        endpoint: `unix:${socketPath}`,
        attestationKeyPath: keyPath,
      }),
    ).toThrow(/attestation key material could not be loaded/i);
  });

  it(
    "caps oversized control-plane requests before buffering them indefinitely",
    async () => {
    fs.mkdirSync(TEMP_ROOT, { recursive: true });
    const socketPath = path.join(TEMP_ROOT, "worker.sock");
    const keyPath = path.join(TEMP_ROOT, "worker-key.json");
    const server = await startHostedMcpWorkerServer({
      endpoint: `unix:${socketPath}`,
      attestationKeyPath: keyPath,
    });
    closers.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
    );

    const response = validate(
      HostedMcpWorkerResponseEnvelopeSchema,
      await sendLine(socketPath, "x".repeat(16 * 1024 * 1024 + 1)),
    );

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("BAD_REQUEST");
    },
    20_000,
  );
});
