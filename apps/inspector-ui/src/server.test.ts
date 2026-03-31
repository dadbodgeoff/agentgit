import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createInspectorServer } from "./server.js";

interface RunningServer {
  close(): Promise<void>;
}

class RunningHttpServer implements RunningServer {
  constructor(readonly server: http.Server) {}

  get origin(): string {
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("HTTP server did not expose a TCP address.");
    }

    return `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

class RunningSocketServer implements RunningServer {
  constructor(
    readonly server: net.Server,
    readonly socketPath: string,
  ) {}

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    fs.rmSync(this.socketPath, { force: true });
  }
}

const activeServers: RunningServer[] = [];

afterEach(async () => {
  while (activeServers.length > 0) {
    await activeServers.pop()!.close();
  }
});

async function listenHttp(server: http.Server): Promise<RunningHttpServer> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const running = new RunningHttpServer(server);
  activeServers.push(running);
  return running;
}

async function createFakeDaemon(
  handler: (request: Record<string, unknown>) => Record<string, unknown>,
): Promise<RunningSocketServer> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-inspector-ui-"));
  const socketPath = path.join(tempRoot, "authority.sock");
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        const request = JSON.parse(line) as Record<string, unknown>;
        const response = handler(request);
        socket.write(`${JSON.stringify(response)}\n`);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const running = new RunningSocketServer(server, socketPath);
  activeServers.push(running);
  return running;
}

function successEnvelope(request: Record<string, unknown>, result: unknown): Record<string, unknown> {
  return {
    api_version: "authority.v1",
    request_id: request.request_id,
    ok: true,
    result,
    error: null,
  };
}

describe("inspector ui", () => {
  it("renders the local inspector shell without leaking the daemon socket path", async () => {
    const app = await listenHttp(createInspectorServer({
      title: "AgentGit Inspector",
      socketPath: "/tmp/private-authority.sock",
    }));

    const response = await fetch(`${app.origin}/`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Trust, evidence, and recovery in one room.");
    expect(html).toContain("AgentGit Local Inspector");
    expect(html).not.toContain("/tmp/private-authority.sock");
  });

  it("proxies a full run-view request to the daemon and preserves visibility scope", async () => {
    const requests: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const daemon = await createFakeDaemon((request) => {
      const method = request.method as string;
      const payload = (request.payload ?? {}) as Record<string, unknown>;
      requests.push({ method, payload });

      switch (method) {
        case "hello":
          return successEnvelope(request, { session_id: "sess_ui" });
        case "get_run_summary":
          return successEnvelope(request, {
            run_id: payload.run_id,
            session_id: "sess_ui",
            workflow_name: "inspector-flow",
            agent_framework: "cli",
            agent_name: "agentgit-cli",
            workspace_roots: ["/workspace/project"],
            event_count: 4,
            latest_event: {
              sequence: 4,
              event_type: "execution.completed",
              occurred_at: "2026-03-31T12:00:04.000Z",
              recorded_at: "2026-03-31T12:00:04.000Z",
            },
            budget_config: {
              max_mutating_actions: null,
              max_destructive_actions: null,
            },
            budget_usage: {
              mutating_actions: 1,
              destructive_actions: 0,
            },
            maintenance_status: {
              projection_status: "fresh",
              artifact_health: {
                status: "healthy",
                total: 1,
                available: 1,
                expired: 0,
                missing: 0,
                corrupted: 0,
                tampered: 0,
              },
            },
            created_at: "2026-03-31T12:00:00.000Z",
            started_at: "2026-03-31T12:00:00.000Z",
          });
        case "query_timeline":
          return successEnvelope(request, {
            run_summary: {
              run_id: payload.run_id,
              session_id: "sess_ui",
              workflow_name: "inspector-flow",
              agent_framework: "cli",
              agent_name: "agentgit-cli",
              workspace_roots: ["/workspace/project"],
              event_count: 4,
              latest_event: {
                sequence: 4,
                event_type: "execution.completed",
                occurred_at: "2026-03-31T12:00:04.000Z",
                recorded_at: "2026-03-31T12:00:04.000Z",
              },
              budget_config: {
                max_mutating_actions: null,
                max_destructive_actions: null,
              },
              budget_usage: {
                mutating_actions: 1,
                destructive_actions: 0,
              },
              maintenance_status: {
                projection_status: "fresh",
                artifact_health: {
                  status: "healthy",
                  total: 1,
                  available: 1,
                  expired: 0,
                  missing: 0,
                  corrupted: 0,
                  tampered: 0,
                },
              },
              created_at: "2026-03-31T12:00:00.000Z",
              started_at: "2026-03-31T12:00:00.000Z",
            },
            steps: [
              {
                schema_version: "timeline-step.v1",
                step_id: "step_1",
                run_id: payload.run_id,
                sequence: 3,
                step_type: "action_step",
                title: "Write launch note",
                status: "completed",
                provenance: "governed",
                action_id: "act_1",
                decision: "allow_with_snapshot",
                primary_reason: {
                  code: "SAFE_WITH_SNAPSHOT",
                  message: "Snapshot-backed write is allowed.",
                },
                reversibility_class: "reversible",
                confidence: 0.96,
                summary: "Wrote the launch note file.",
                warnings: [],
                primary_artifacts: [
                  {
                    artifact_id: "artifact_file_1",
                    artifact_status: "available",
                    integrity: {
                      schema_version: "artifact-integrity.v1",
                      digest_algorithm: "sha256",
                      digest: "abc123",
                    },
                    type: "file_content",
                    label: "launch-note",
                  },
                ],
                artifact_previews: [
                  {
                    type: "file_content",
                    label: "launch-note",
                    preview: "Updated launch notes.",
                  },
                ],
                external_effects: [],
                related: {
                  target_locator: "file:///workspace/project/launch-notes.md",
                },
                occurred_at: "2026-03-31T12:00:03.000Z",
              },
            ],
            projection_status: "fresh",
            visibility_scope: payload.visibility_scope,
            redactions_applied: 0,
            preview_budget: {
              max_inline_preview_chars: 160,
              max_total_inline_preview_chars: 1200,
              preview_chars_used: 20,
              truncated_previews: 0,
              omitted_previews: 0,
            },
          });
        case "query_helper":
          return successEnvelope(request, {
            answer: `helper:${payload.question_type as string}`,
            confidence: 0.91,
            primary_reason: null,
            visibility_scope: payload.visibility_scope ?? "user",
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
          });
        case "query_approval_inbox":
          return successEnvelope(request, { items: [] });
        case "list_approvals":
          return successEnvelope(request, { approvals: [] });
        default:
          throw new Error(`Unexpected method ${method}`);
      }
    });

    const app = await listenHttp(createInspectorServer({ socketPath: daemon.socketPath }));
    const response = await fetch(`${app.origin}/api/run-view?run_id=run_ui&visibility_scope=internal`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.run_summary.run_id).toBe("run_ui");
    expect(body.timeline.visibility_scope).toBe("internal");
    expect(body.timeline.steps).toHaveLength(1);
    expect(body.helper_cards).toHaveLength(4);
    const methods = requests.map((request) => request.method);
    expect(methods.filter((method) => method === "hello").length).toBeGreaterThanOrEqual(1);
    expect(methods.filter((method) => method === "get_run_summary")).toHaveLength(1);
    expect(methods.filter((method) => method === "query_timeline")).toHaveLength(1);
    expect(methods.filter((method) => method === "query_helper")).toHaveLength(4);
    expect(methods.filter((method) => method === "query_approval_inbox")).toHaveLength(1);
    expect(methods.filter((method) => method === "list_approvals")).toHaveLength(1);
    expect(
      requests
        .filter((request) => request.method === "query_timeline" || request.method === "query_helper")
        .every((request) => request.payload.visibility_scope === "internal"),
    ).toBe(true);
  });

  it("rejects malformed maintenance requests before they reach the daemon", async () => {
    const daemon = await createFakeDaemon((request) => {
      if (request.method === "hello") {
        return successEnvelope(request, { session_id: "sess_ui" });
      }

      throw new Error("The inspector should not proxy malformed maintenance payloads.");
    });

    const app = await listenHttp(createInspectorServer({ socketPath: daemon.socketPath }));
    const response = await fetch(`${app.origin}/api/maintenance`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        job_types: ["definitely_not_real"],
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.message).toContain("At least one supported maintenance job is required");
  });

  it("surfaces daemon transport failure honestly instead of returning an empty inspector view", async () => {
    const missingSocketPath = path.join(os.tmpdir(), `agentgit-missing-${Date.now()}.sock`);
    const app = await listenHttp(createInspectorServer({ socketPath: missingSocketPath }));
    const response = await fetch(`${app.origin}/api/overview`);
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(typeof body.code).toBe("string");
    expect(body.code.startsWith("SOCKET_CONNECT")).toBe(true);
  });
});
