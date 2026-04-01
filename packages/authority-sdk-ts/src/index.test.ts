import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { API_VERSION } from "@agentgit/schemas";

import { AuthorityClient, AuthorityClientTransportError, AuthorityDaemonResponseError } from "./index.js";

interface SocketHarness {
  root: string;
  socketPath: string;
  server?: net.Server;
}

const harnesses: SocketHarness[] = [];

function createHarness(): SocketHarness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-sdk-it-"));
  const socketPath = path.join(root, "authority.sock");
  const harness = { root, socketPath };
  harnesses.push(harness);
  return harness;
}

async function closeHarness(harness: SocketHarness): Promise<void> {
  if (harness.server) {
    await new Promise<void>((resolve, reject) => {
      harness.server!.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  if (fs.existsSync(harness.socketPath)) {
    fs.rmSync(harness.socketPath, { force: true });
  }
}

async function startJsonServer(
  harness: SocketHarness,
  onRequest: (request: Record<string, unknown>, socket: net.Socket) => void,
): Promise<void> {
  if (fs.existsSync(harness.socketPath)) {
    fs.rmSync(harness.socketPath, { force: true });
  }

  harness.server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");

    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      const request = JSON.parse(line) as Record<string, unknown>;
      onRequest(request, socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    harness.server!.once("error", reject);
    harness.server!.listen(harness.socketPath, resolve);
  });
}

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop()!;
    await closeHarness(harness);
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

describe("AuthorityClient transport", () => {
  it("raises a structured transport error when the socket is unavailable", async () => {
    const harness = createHarness();
    const client = new AuthorityClient({
      socketPath: harness.socketPath,
      connectTimeoutMs: 50,
      responseTimeoutMs: 50,
      maxConnectRetries: 0,
    });

    await expect(client.hello([harness.root])).rejects.toMatchObject({
      name: "AuthorityClientTransportError",
      code: "SOCKET_CONNECT_FAILED",
      retryable: true,
    });
  });

  it("times out cleanly when the daemon does not respond", async () => {
    const harness = createHarness();
    await startJsonServer(harness, () => {
      return;
    });

    const client = new AuthorityClient({
      socketPath: harness.socketPath,
      connectTimeoutMs: 50,
      responseTimeoutMs: 50,
      maxConnectRetries: 0,
    });

    await expect(client.hello([harness.root])).rejects.toMatchObject({
      name: "AuthorityClientTransportError",
      code: "SOCKET_RESPONSE_TIMEOUT",
      retryable: false,
    });
  });

  it("retries a connect failure once and succeeds when the daemon appears", async () => {
    const harness = createHarness();
    const client = new AuthorityClient({
      socketPath: harness.socketPath,
      connectTimeoutMs: 50,
      responseTimeoutMs: 200,
      maxConnectRetries: 1,
      connectRetryDelayMs: 75,
    });

    setTimeout(() => {
      void startJsonServer(harness, (request, socket) => {
        socket.write(
          `${JSON.stringify({
            api_version: API_VERSION,
            request_id: request.request_id,
            session_id: "sess_test",
            ok: true,
            result: {
              session_id: "sess_test",
              accepted_api_version: API_VERSION,
              runtime_version: "0.1.0",
              schema_pack_version: "schema-pack.v1",
              capabilities: {
                local_only: true,
                methods: ["hello"],
              },
            },
            error: null,
          })}\n`,
        );
        socket.end();
      });
    }, 20);

    const result = await client.hello([harness.root]);
    expect(result.session_id).toBe("sess_test");
  });

  it("surfaces daemon errors as structured response errors", async () => {
    const harness = createHarness();
    await startJsonServer(harness, (request, socket) => {
      socket.write(
        `${JSON.stringify({
          api_version: API_VERSION,
          request_id: request.request_id,
          session_id: request.session_id ?? null,
          ok: false,
          result: null,
          error: {
            code: "NOT_FOUND",
            error_class: "NotFoundError",
            message: "No run found.",
            details: {
              run_id: "run_missing",
            },
            retryable: false,
          },
        })}\n`,
      );
      socket.end();
    });

    const client = new AuthorityClient({
      socketPath: harness.socketPath,
      connectTimeoutMs: 50,
      responseTimeoutMs: 50,
      maxConnectRetries: 0,
    });

    await expect(client.getRunSummary("run_missing")).rejects.toMatchObject({
      name: "AuthorityDaemonResponseError",
      code: "NOT_FOUND",
      errorClass: "NotFoundError",
      retryable: false,
    });
  });

  it("forwards idempotency keys on mutating requests", async () => {
    const harness = createHarness();
    const seenRequests: Array<Record<string, unknown>> = [];

    await startJsonServer(harness, (request, socket) => {
      seenRequests.push(request);
      const method = request.method;
      const result =
        method === "hello"
          ? {
              session_id: "sess_test",
              accepted_api_version: API_VERSION,
              runtime_version: "0.1.0",
              schema_pack_version: "schema-pack.v1",
              capabilities: {
                local_only: true,
                methods: ["hello", "register_run", "run_maintenance", "execute_recovery"],
              },
            }
          : method === "register_run"
            ? {
                run_id: "run_test",
                run_handle: {
                  run_id: "run_test",
                  session_id: "sess_test",
                  workflow_name: "demo",
                },
                effective_policy_profile: "local-default",
              }
            : method === "run_maintenance"
              ? {
                  accepted_priority: "administrative",
                  scope: null,
                  jobs: [],
                  stream_id: null,
                }
              : {
                  restored: true,
                  outcome: "restored",
                  executed_at: "2026-03-31T12:00:00.000Z",
                  recovery_plan: {
                    schema_version: "recovery-plan.v1",
                    recovery_plan_id: "rec_test",
                    target: {
                      type: "snapshot_id",
                      snapshot_id: "snap_test",
                    },
                    recovery_class: "automated_restore",
                    strategy: "restore_snapshot",
                    confidence: 0.9,
                    steps: [],
                    impact_preview: {
                      later_actions_affected: 0,
                      overlapping_paths: [],
                      external_effects: [],
                      data_loss_risk: "low",
                    },
                    warnings: [],
                    created_at: "2026-03-31T12:00:00.000Z",
                  },
                };

      socket.write(
        `${JSON.stringify({
          api_version: API_VERSION,
          request_id: request.request_id,
          session_id: request.session_id ?? "sess_test",
          ok: true,
          result,
          error: null,
        })}\n`,
      );
      socket.end();
    });

    const client = new AuthorityClient({
      socketPath: harness.socketPath,
      connectTimeoutMs: 50,
      responseTimeoutMs: 100,
      maxConnectRetries: 0,
    });

    await client.registerRun(
      {
        workflow_name: "demo",
        agent_framework: "cli",
        agent_name: "agentgit-cli",
        workspace_roots: [harness.root],
        client_metadata: {},
      },
      { idempotencyKey: "idem_register" },
    );
    await client.runMaintenance(["capability_refresh"], {}, { idempotencyKey: "idem_maint" });
    await client.executeRecovery("snap_test", { idempotencyKey: "idem_recover" });

    expect(seenRequests.find((request) => request.method === "register_run")?.idempotency_key).toBe("idem_register");
    expect(seenRequests.find((request) => request.method === "run_maintenance")?.idempotency_key).toBe("idem_maint");
    expect(seenRequests.find((request) => request.method === "execute_recovery")?.idempotency_key).toBe("idem_recover");
  });

  it("sends MCP registry management requests with the expected methods and payloads", async () => {
    const harness = createHarness();
    const seenRequests: Array<Record<string, unknown>> = [];

    await startJsonServer(harness, (request, socket) => {
      seenRequests.push(request);
      const method = request.method;
      const result =
        method === "hello"
          ? {
              session_id: "sess_test",
              accepted_api_version: API_VERSION,
              runtime_version: "0.1.0",
              schema_pack_version: "schema-pack.v1",
              capabilities: {
                local_only: true,
                methods: ["hello", "list_mcp_servers", "upsert_mcp_server", "remove_mcp_server"],
              },
            }
          : method === "list_mcp_servers"
            ? {
                servers: [],
              }
            : method === "upsert_mcp_server"
              ? {
                  created: true,
                  server: {
                    source: "operator_api",
                    created_at: "2026-03-31T12:00:00.000Z",
                    updated_at: "2026-03-31T12:00:00.000Z",
                    server: (request.payload as { server: Record<string, unknown> }).server,
                  },
                }
              : {
                  removed: true,
                  removed_server: {
                    source: "operator_api",
                    created_at: "2026-03-31T12:00:00.000Z",
                    updated_at: "2026-03-31T12:00:00.000Z",
                    server: {
                      server_id: "notes_http",
                      transport: "streamable_http",
                      url: "http://127.0.0.1:3010/mcp",
                      tools: [],
                    },
                  },
                };

      socket.write(
        `${JSON.stringify({
          api_version: API_VERSION,
          request_id: request.request_id,
          session_id: request.session_id ?? "sess_test",
          ok: true,
          result,
          error: null,
        })}\n`,
      );
      socket.end();
    });

    const client = new AuthorityClient({
      socketPath: harness.socketPath,
      connectTimeoutMs: 50,
      responseTimeoutMs: 100,
      maxConnectRetries: 0,
    });

    await client.listMcpServers();
    await client.upsertMcpServer(
      {
        server_id: "notes_http",
        transport: "streamable_http",
        url: "http://127.0.0.1:3010/mcp",
        tools: [
          {
            tool_name: "echo_note",
            side_effect_level: "read_only",
            approval_mode: "allow",
          },
        ],
      },
      { idempotencyKey: "idem_mcp_upsert" },
    );
    await client.removeMcpServer("notes_http", { idempotencyKey: "idem_mcp_remove" });

    expect(seenRequests.find((request) => request.method === "list_mcp_servers")?.payload).toEqual({});
    expect(seenRequests.find((request) => request.method === "upsert_mcp_server")?.idempotency_key).toBe("idem_mcp_upsert");
    expect(seenRequests.find((request) => request.method === "remove_mcp_server")?.payload).toEqual({
      server_id: "notes_http",
    });
  });

  it("sends MCP secret and host-policy management requests with the expected methods and payloads", async () => {
    const harness = createHarness();
    const seenRequests: Array<Record<string, unknown>> = [];

    await startJsonServer(harness, (request, socket) => {
      seenRequests.push(request);
      const method = request.method;
      const result =
        method === "hello"
          ? {
              session_id: "sess_test",
              accepted_api_version: API_VERSION,
              runtime_version: "0.1.0",
              schema_pack_version: "schema-pack.v1",
              capabilities: {
                local_only: true,
                methods: [
                  "hello",
                  "list_mcp_secrets",
                  "upsert_mcp_secret",
                  "remove_mcp_secret",
                  "list_mcp_host_policies",
                  "upsert_mcp_host_policy",
                  "remove_mcp_host_policy",
                ],
              },
            }
          : method === "list_mcp_secrets"
            ? {
                secrets: [],
              }
            : method === "upsert_mcp_secret"
              ? {
                  created: true,
                  rotated: false,
                  secret: {
                    secret_id: "mcp_secret_notion",
                    display_name: "Notion MCP",
                    auth_type: "bearer",
                    status: "active",
                    version: 1,
                    created_at: "2026-03-31T12:00:00.000Z",
                    updated_at: "2026-03-31T12:00:00.000Z",
                    rotated_at: null,
                    last_used_at: null,
                    source: "operator_api",
                  },
                }
              : method === "remove_mcp_secret"
                ? {
                    removed: true,
                    removed_secret: {
                      secret_id: "mcp_secret_notion",
                      display_name: "Notion MCP",
                      auth_type: "bearer",
                      status: "active",
                      version: 1,
                      created_at: "2026-03-31T12:00:00.000Z",
                      updated_at: "2026-03-31T12:00:00.000Z",
                      rotated_at: null,
                      last_used_at: null,
                      source: "operator_api",
                    },
                  }
                : method === "list_mcp_host_policies"
                  ? {
                      policies: [],
                    }
                  : method === "upsert_mcp_host_policy"
                    ? {
                        created: true,
                        policy: {
                          policy: {
                            host: "api.notion.com",
                            display_name: "Notion API",
                            allow_subdomains: false,
                            allowed_ports: [443],
                          },
                          source: "operator_api",
                          created_at: "2026-03-31T12:00:00.000Z",
                          updated_at: "2026-03-31T12:00:00.000Z",
                        },
                      }
                    : {
                        removed: true,
                        removed_policy: {
                          policy: {
                            host: "api.notion.com",
                            display_name: "Notion API",
                            allow_subdomains: false,
                            allowed_ports: [443],
                          },
                          source: "operator_api",
                          created_at: "2026-03-31T12:00:00.000Z",
                          updated_at: "2026-03-31T12:00:00.000Z",
                        },
                      };

      socket.write(
        `${JSON.stringify({
          api_version: API_VERSION,
          request_id: request.request_id,
          session_id: request.session_id ?? "sess_test",
          ok: true,
          result,
          error: null,
        })}\n`,
      );
      socket.end();
    });

    const client = new AuthorityClient({
      socketPath: harness.socketPath,
      connectTimeoutMs: 50,
      responseTimeoutMs: 100,
      maxConnectRetries: 0,
    });

    await client.listMcpSecrets();
    await client.upsertMcpSecret(
      {
        secret_id: "mcp_secret_notion",
        display_name: "Notion MCP",
        bearer_token: "redacted-in-transport-test",
      },
      { idempotencyKey: "idem_mcp_secret_upsert" },
    );
    await client.removeMcpSecret("mcp_secret_notion", { idempotencyKey: "idem_mcp_secret_remove" });
    await client.listMcpHostPolicies();
    await client.upsertMcpHostPolicy(
      {
        host: "api.notion.com",
        display_name: "Notion API",
        allow_subdomains: false,
        allowed_ports: [443],
      },
      { idempotencyKey: "idem_mcp_host_upsert" },
    );
    await client.removeMcpHostPolicy("api.notion.com", { idempotencyKey: "idem_mcp_host_remove" });

    expect(seenRequests.find((request) => request.method === "list_mcp_secrets")?.payload).toEqual({});
    expect(seenRequests.find((request) => request.method === "upsert_mcp_secret")?.idempotency_key).toBe(
      "idem_mcp_secret_upsert",
    );
    expect(seenRequests.find((request) => request.method === "remove_mcp_secret")?.payload).toEqual({
      secret_id: "mcp_secret_notion",
    });
    expect(seenRequests.find((request) => request.method === "list_mcp_host_policies")?.payload).toEqual({});
    expect(seenRequests.find((request) => request.method === "upsert_mcp_host_policy")?.payload).toEqual({
      policy: {
        host: "api.notion.com",
        display_name: "Notion API",
        allow_subdomains: false,
        allowed_ports: [443],
      },
    });
    expect(seenRequests.find((request) => request.method === "remove_mcp_host_policy")?.idempotency_key).toBe(
      "idem_mcp_host_remove",
    );
  });

  it("normalizes action-boundary recovery targets for the daemon", async () => {
    const harness = createHarness();
    const seenRequests: Array<Record<string, unknown>> = [];

    await startJsonServer(harness, (request, socket) => {
      seenRequests.push(request);
      const method = request.method;
      const result =
        method === "hello"
          ? {
              session_id: "sess_test",
              accepted_api_version: API_VERSION,
              runtime_version: "0.1.0",
              schema_pack_version: "schema-pack.v1",
              capabilities: {
                local_only: true,
                methods: ["hello", "plan_recovery"],
              },
            }
          : {
              recovery_plan: {
                schema_version: "recovery-plan.v1",
                recovery_plan_id: "rec_test",
                target: {
                  type: "action_boundary",
                  action_id: "act_test",
                },
                recovery_class: "review_only",
                strategy: "manual_review_only",
                confidence: 0.44,
                steps: [],
                impact_preview: {
                  later_actions_affected: 0,
                  overlapping_paths: [],
                  external_effects: [],
                  data_loss_risk: "unknown",
                },
                warnings: [],
                created_at: "2026-03-30T12:00:00.000Z",
              },
            };

      socket.write(
        `${JSON.stringify({
          api_version: API_VERSION,
          request_id: request.request_id,
          session_id: request.session_id ?? "sess_test",
          ok: true,
          result,
          error: null,
        })}\n`,
      );
      socket.end();
    });

    const client = new AuthorityClient({
      socketPath: harness.socketPath,
      connectTimeoutMs: 50,
      responseTimeoutMs: 100,
      maxConnectRetries: 0,
    });

    await client.planRecovery("act_test");

    const recoveryRequest = seenRequests.find((request) => request.method === "plan_recovery");
    expect(recoveryRequest).toBeTruthy();
    expect(recoveryRequest?.payload).toEqual({
      target: {
        type: "action_boundary",
        action_id: "act_test",
      },
    });
  });

  it("passes through structured external-object recovery targets unchanged", async () => {
    const harness = createHarness();
    const seenRequests: Array<Record<string, unknown>> = [];

    await startJsonServer(harness, (request, socket) => {
      seenRequests.push(request);
      const method = request.method;
      const result =
        method === "hello"
          ? {
              session_id: "sess_test",
              accepted_api_version: API_VERSION,
              runtime_version: "0.1.0",
              schema_pack_version: "schema-pack.v1",
              capabilities: {
                local_only: true,
                methods: ["hello", "execute_recovery"],
              },
            }
          : {
              recovered: true,
            };

      socket.write(
        `${JSON.stringify({
          api_version: API_VERSION,
          request_id: request.request_id,
          session_id: request.session_id ?? "sess_test",
          ok: true,
          result,
          error: null,
        })}\n`,
      );
      socket.end();
    });

    const client = new AuthorityClient({
      socketPath: harness.socketPath,
      connectTimeoutMs: 50,
      responseTimeoutMs: 100,
      maxConnectRetries: 0,
    });

    await client.executeRecovery({
      type: "external_object",
      external_object_id: "draft_shared",
    });

    const recoveryRequest = seenRequests.find((request) => request.method === "execute_recovery");
    expect(recoveryRequest?.payload).toEqual({
      target: {
        type: "external_object",
        external_object_id: "draft_shared",
      },
    });
  });

  it("passes through structured run-checkpoint recovery targets unchanged", async () => {
    const harness = createHarness();
    const seenRequests: Array<Record<string, unknown>> = [];

    await startJsonServer(harness, (request, socket) => {
      seenRequests.push(request);
      const method = request.method;
      const result =
        method === "hello"
          ? {
              session_id: "sess_test",
              accepted_api_version: API_VERSION,
              runtime_version: "0.1.0",
              schema_pack_version: "schema-pack.v1",
              capabilities: {
                local_only: true,
                methods: ["hello", "plan_recovery"],
              },
            }
          : {
              planned: true,
            };

      socket.write(
        `${JSON.stringify({
          api_version: API_VERSION,
          request_id: request.request_id,
          session_id: request.session_id ?? "sess_test",
          ok: true,
          result,
          error: null,
        })}\n`,
      );
      socket.end();
    });

    const client = new AuthorityClient({
      socketPath: harness.socketPath,
      connectTimeoutMs: 50,
      responseTimeoutMs: 100,
      maxConnectRetries: 0,
    });

    await client.planRecovery({
      type: "run_checkpoint",
      run_checkpoint: "run_demo#7",
    });

    const recoveryRequest = seenRequests.find((request) => request.method === "plan_recovery");
    expect(recoveryRequest?.payload).toEqual({
      target: {
        type: "run_checkpoint",
        run_checkpoint: "run_demo#7",
      },
    });
  });

  it("passes through structured path-subset recovery targets unchanged", async () => {
    const harness = createHarness();
    const seenRequests: Array<Record<string, unknown>> = [];

    await startJsonServer(harness, (request, socket) => {
      seenRequests.push(request);
      const method = request.method;
      const result =
        method === "hello"
          ? {
              session_id: "sess_test",
              accepted_api_version: API_VERSION,
              runtime_version: "0.1.0",
              schema_pack_version: "schema-pack.v1",
              capabilities: {
                local_only: true,
                methods: ["hello", "execute_recovery"],
              },
            }
          : {
              executed: true,
            };

      socket.write(
        `${JSON.stringify({
          api_version: API_VERSION,
          request_id: request.request_id,
          session_id: request.session_id ?? "sess_test",
          ok: true,
          result,
          error: null,
        })}\n`,
      );
      socket.end();
    });

    const client = new AuthorityClient({
      socketPath: harness.socketPath,
      connectTimeoutMs: 50,
      responseTimeoutMs: 100,
      maxConnectRetries: 0,
    });

    await client.executeRecovery({
      type: "path_subset",
      snapshot_id: "snap_demo",
      paths: ["src/app.ts", "/workspace/README.md"],
    });

    const recoveryRequest = seenRequests.find((request) => request.method === "execute_recovery");
    expect(recoveryRequest?.payload).toEqual({
      target: {
        type: "path_subset",
        snapshot_id: "snap_demo",
        paths: ["src/app.ts", "/workspace/README.md"],
      },
    });
  });

  it("passes through structured branch-point recovery targets unchanged", async () => {
    const harness = createHarness();
    const seenRequests: Array<Record<string, unknown>> = [];

    await startJsonServer(harness, (request, socket) => {
      seenRequests.push(request);
      const method = request.method;
      const result =
        method === "hello"
          ? {
              session_id: "sess_test",
              accepted_api_version: API_VERSION,
              runtime_version: "0.1.0",
              schema_pack_version: "schema-pack.v1",
              capabilities: {
                local_only: true,
                methods: ["hello", "plan_recovery"],
              },
            }
          : {
              planned: true,
            };

      socket.write(
        `${JSON.stringify({
          api_version: API_VERSION,
          request_id: request.request_id,
          session_id: request.session_id ?? "sess_test",
          ok: true,
          result,
          error: null,
        })}\n`,
      );
      socket.end();
    });

    const client = new AuthorityClient({
      socketPath: harness.socketPath,
      connectTimeoutMs: 50,
      responseTimeoutMs: 100,
      maxConnectRetries: 0,
    });

    await client.planRecovery({
      type: "branch_point",
      run_id: "run_demo",
      sequence: 7,
    });

    const recoveryRequest = seenRequests.find((request) => request.method === "plan_recovery");
    expect(recoveryRequest?.payload).toEqual({
      target: {
        type: "branch_point",
        run_id: "run_demo",
        sequence: 7,
      },
    });
  });

  it("forwards optional visibility scopes on timeline and helper queries", async () => {
    const harness = createHarness();
    const seenRequests: Array<Record<string, unknown>> = [];

    await startJsonServer(harness, (request, socket) => {
      seenRequests.push(request);
      const method = request.method;
      const result =
        method === "hello"
          ? {
              session_id: "sess_visibility",
              accepted_api_version: API_VERSION,
              runtime_version: "0.1.0",
              schema_pack_version: "schema-pack.v1",
              capabilities: {
                local_only: true,
                methods: ["hello", "query_timeline", "query_helper", "query_artifact", "get_capabilities", "diagnostics", "run_maintenance"],
              },
            }
          : {
              answer: "ok",
              confidence: 0.5,
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
              steps: [],
              run_summary: {
                run_id: "run_vis",
                session_id: "sess_visibility",
                workflow_name: "visibility",
                agent_framework: "cli",
                agent_name: "agentgit-cli",
                workspace_roots: [],
                event_count: 0,
                latest_event: null,
                budget_config: {
                  max_mutating_actions: null,
                  max_destructive_actions: null,
                },
                budget_usage: {
                  mutating_actions: 0,
                  destructive_actions: 0,
                },
                maintenance_status: {
                  projection_status: "fresh",
                  projection_lag_events: 0,
                  degraded_artifact_capture_actions: 0,
                  low_disk_pressure_signals: 0,
                  artifact_health: {
                    total: 0,
                    available: 0,
                    missing: 0,
                    expired: 0,
                    corrupted: 0,
                    tampered: 0,
                  },
                },
                created_at: "2026-03-31T00:00:00.000Z",
                started_at: "2026-03-31T00:00:00.000Z",
              },
              projection_status: "fresh",
            };

      socket.write(
        `${JSON.stringify({
          api_version: API_VERSION,
          request_id: request.request_id,
          session_id: request.session_id ?? "sess_visibility",
          ok: true,
          result,
          error: null,
        })}\n`,
      );
      socket.end();
    });

    const client = new AuthorityClient({
      socketPath: harness.socketPath,
      connectTimeoutMs: 50,
      responseTimeoutMs: 100,
      maxConnectRetries: 0,
    });

    await client.queryTimeline("run_vis", "internal");
    await client.queryHelper("run_vis", "step_details", "step_1", undefined, "sensitive_internal");
    await client.queryArtifact("artifact_1", "internal", { fullContent: true });
    await client.getCapabilities("/tmp/workspace");
    await client.diagnostics(["storage_summary", "journal_health"]);
    await client.runMaintenance(["artifact_expiry", "sqlite_wal_checkpoint"], {
      priority_override: "administrative",
      scope: {
        workspace_root: "/tmp/workspace",
      },
    });

    const timelineRequest = seenRequests.find((request) => request.method === "query_timeline");
    const helperRequest = seenRequests.find((request) => request.method === "query_helper");
    const artifactRequest = seenRequests.find((request) => request.method === "query_artifact");
    const capabilitiesRequest = seenRequests.find((request) => request.method === "get_capabilities");
    const diagnosticsRequest = seenRequests.find((request) => request.method === "diagnostics");
    const maintenanceRequest = seenRequests.find((request) => request.method === "run_maintenance");
    expect(timelineRequest?.payload).toEqual({
      run_id: "run_vis",
      visibility_scope: "internal",
    });
    expect(helperRequest?.payload).toEqual({
      run_id: "run_vis",
      question_type: "step_details",
      focus_step_id: "step_1",
      visibility_scope: "sensitive_internal",
    });
    expect(artifactRequest?.payload).toEqual({
      artifact_id: "artifact_1",
      visibility_scope: "internal",
      full_content: true,
    });
    expect(capabilitiesRequest?.payload).toEqual({
      workspace_root: "/tmp/workspace",
    });
    expect(diagnosticsRequest?.payload).toEqual({
      sections: ["storage_summary", "journal_health"],
    });
    expect(maintenanceRequest?.payload).toEqual({
      job_types: ["artifact_expiry", "sqlite_wal_checkpoint"],
      priority_override: "administrative",
      scope: {
        workspace_root: "/tmp/workspace",
      },
    });
  });
});
