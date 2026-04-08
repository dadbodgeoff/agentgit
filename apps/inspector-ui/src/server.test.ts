import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createInspectorServer } from "./server.js";

const TEST_AUTH_TOKEN = "inspector-test-token";

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

interface InspectorWebSocketTestMessage extends Record<string, unknown> {
  type?: string;
  sequence?: number;
  replayed?: boolean;
}

interface RawInspectorWebSocket {
  socket: net.Socket;
  messages: InspectorWebSocketTestMessage[];
  waitFor(
    predicate: (message: InspectorWebSocketTestMessage) => boolean,
    timeoutMs?: number,
  ): Promise<InspectorWebSocketTestMessage>;
  close(): Promise<void>;
}

async function connectInspectorWebSocket(app: RunningHttpServer, requestPath: string): Promise<RawInspectorWebSocket> {
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP server did not expose a TCP address.");
  }

  const socket = net.createConnection({
    host: "127.0.0.1",
    port: address.port,
  });
  const requestUrl = new URL(requestPath, app.origin);
  requestUrl.searchParams.set("token", TEST_AUTH_TOKEN);
  requestUrl.searchParams.set("client_id", "test-client");
  const secWebSocketKey = Buffer.from(`agentgit-inspector-ws-test:${requestPath}`, "utf8").toString("base64");
  const requestLines = [
    `GET ${requestUrl.pathname}${requestUrl.search} HTTP/1.1`,
    `Host: 127.0.0.1:${address.port}`,
    `Origin: ${app.origin}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${secWebSocketKey}`,
    "Sec-WebSocket-Version: 13",
    "\r\n",
  ];

  let buffer = Buffer.alloc(0);
  let upgraded = false;
  const messages: InspectorWebSocketTestMessage[] = [];
  const waiters: Array<{
    predicate: (message: InspectorWebSocketTestMessage) => boolean;
    resolve: (message: InspectorWebSocketTestMessage) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = [];

  const tryReadFrame = (): { opcode: number; payload: Buffer; bytes: number } | null => {
    if (buffer.length < 2) {
      return null;
    }

    const first = buffer[0];
    const second = buffer[1];
    const opcode = first & 0x0f;
    let payloadLength = second & 0x7f;
    let offset = 2;

    if (payloadLength === 126) {
      if (buffer.length < offset + 2) {
        return null;
      }
      payloadLength = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLength === 127) {
      if (buffer.length < offset + 8) {
        return null;
      }
      payloadLength = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }

    if (buffer.length < offset + payloadLength) {
      return null;
    }

    return {
      opcode,
      payload: buffer.slice(offset, offset + payloadLength),
      bytes: offset + payloadLength,
    };
  };

  const resolveWaiters = (message: InspectorWebSocketTestMessage): void => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index]!;
      if (!waiter.predicate(message)) {
        continue;
      }
      clearTimeout(waiter.timeout);
      waiters.splice(index, 1);
      waiter.resolve(message);
    }
  };

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for websocket upgrade."));
    }, 5_000);

    socket.once("connect", () => {
      socket.write(requestLines.join("\r\n"), "utf8");
    });

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (!upgraded) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) {
          return;
        }

        const headerText = buffer.slice(0, headerEnd).toString("utf8");
        if (!headerText.startsWith("HTTP/1.1 101")) {
          clearTimeout(timeout);
          socket.destroy();
          reject(new Error(`Websocket upgrade failed: ${headerText.split("\r\n")[0] ?? headerText}`));
          return;
        }

        upgraded = true;
        buffer = buffer.slice(headerEnd + 4);
        clearTimeout(timeout);
        resolve();
      }

      while (upgraded) {
        const frame = tryReadFrame();
        if (!frame) {
          return;
        }

        buffer = buffer.slice(frame.bytes);
        if (frame.opcode !== 0x1) {
          continue;
        }

        const message = JSON.parse(frame.payload.toString("utf8")) as InspectorWebSocketTestMessage;
        messages.push(message);
        resolveWaiters(message);
      }
    });

    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  return {
    socket,
    messages,
    waitFor(predicate, timeoutMs = 5_000) {
      const existing = messages.find(predicate);
      if (existing) {
        return Promise.resolve(existing);
      }

      return new Promise<InspectorWebSocketTestMessage>((resolve, reject) => {
        const timeout = setTimeout(() => {
          const error = new Error("Timed out waiting for websocket message.");
          for (let index = waiters.length - 1; index >= 0; index -= 1) {
            if (waiters[index]?.timeout === timeout) {
              waiters.splice(index, 1);
              break;
            }
          }
          reject(error);
        }, timeoutMs);

        waiters.push({ predicate, resolve, reject, timeout });
      });
    },
    async close() {
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error("Websocket closed before the expected message arrived."));
      }

      if (socket.destroyed) {
        return;
      }

      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.end();
      });
    },
  };
}

function authedInspectorUrl(app: RunningHttpServer, pathName = "/"): string {
  const url = new URL(pathName, app.origin);
  url.searchParams.set("token", TEST_AUTH_TOKEN);
  return url.toString();
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
    const app = await listenHttp(
      createInspectorServer({
        authToken: TEST_AUTH_TOKEN,
        title: "AgentGit Inspector",
        socketPath: "/tmp/private-authority.sock",
      }),
    );

    const response = await fetch(authedInspectorUrl(app));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Trust, evidence, and recovery in one room.");
    expect(html).toContain("AgentGit Local Inspector");
    expect(html).not.toContain("/tmp/private-authority.sock");
  });

  it("escapes custom page titles before rendering HTML", async () => {
    const app = await listenHttp(
      createInspectorServer({
        authToken: TEST_AUTH_TOKEN,
        title: "<img src=x onerror=alert('xss')>",
      }),
    );

    const response = await fetch(authedInspectorUrl(app));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("&lt;img src=x onerror=alert(&#39;xss&#39;)&gt;");
    expect(html).not.toContain("<img src=x onerror=alert('xss')>");
  });

  it("ships client-side escaping for daemon-provided content before any innerHTML render", async () => {
    const app = await listenHttp(createInspectorServer({ authToken: TEST_AUTH_TOKEN }));
    const response = await fetch(authedInspectorUrl(app));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("function escapeClientHtml(value)");
    expect(html).toContain("escapeClientHtml(item)");
    expect(html).toContain("escapeClientHtml(step.title)");
    expect(html).toContain("escapeClientHtml(card.answer)");
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

    const app = await listenHttp(createInspectorServer({ authToken: TEST_AUTH_TOKEN, socketPath: daemon.socketPath }));
    const response = await fetch(
      authedInspectorUrl(app, "/api/run-view?run_id=run_ui&visibility_scope=internal"),
    );
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

  it("streams overview and run-view payloads over websocket", async () => {
    const requests: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const daemon = await createFakeDaemon((request) => {
      const method = request.method as string;
      const payload = (request.payload ?? {}) as Record<string, unknown>;
      requests.push({ method, payload });

      switch (method) {
        case "hello":
          return successEnvelope(request, { session_id: "sess_ws" });
        case "diagnostics":
          return successEnvelope(request, {
            daemon_health: {
              status: "healthy",
              active_sessions: 1,
              active_runs: 1,
              primary_reason: null,
              warnings: [],
            },
            journal_health: {
              status: "healthy",
              total_runs: 1,
              total_events: 2,
              pending_approvals: 0,
              primary_reason: null,
              warnings: [],
            },
            maintenance_backlog: {
              pending_critical_jobs: 0,
              pending_maintenance_jobs: 0,
              oldest_pending_critical_job: null,
              current_heavy_job: null,
              snapshot_compaction_debt: null,
              primary_reason: null,
              warnings: [],
            },
            projection_lag: {
              projection_status: "fresh",
              lag_events: 0,
            },
            storage_summary: {
              artifact_health: {
                status: "healthy",
                total: 0,
                available: 0,
                expired: 0,
                missing: 0,
                corrupted: 0,
                tampered: 0,
              },
              degraded_artifact_capture_actions: 0,
              low_disk_pressure_signals: 0,
              primary_reason: null,
              warnings: [],
            },
            capability_summary: {
              cached: true,
              refreshed_at: "2026-03-31T12:00:00.000Z",
              workspace_root: "/workspace/project",
              capability_count: 1,
              degraded_capabilities: 0,
              unavailable_capabilities: 0,
              stale_after_ms: 300000,
              is_stale: false,
              primary_reason: null,
              warnings: [],
            },
            policy_summary: null,
            security_posture: null,
            hosted_worker: null,
            hosted_queue: null,
          });
        case "get_capabilities":
          return successEnvelope(request, {
            capabilities: [],
            degraded_mode_warnings: [],
            detection_timestamps: {
              started_at: "2026-03-31T12:00:00.000Z",
              completed_at: "2026-03-31T12:00:00.100Z",
            },
          });
        case "get_run_summary":
          return successEnvelope(request, {
            run_id: payload.run_id,
            session_id: "sess_ws",
            workflow_name: "inspector-flow",
            agent_framework: "cli",
            agent_name: "agentgit-cli",
            workspace_roots: ["/workspace/project"],
            event_count: 2,
            latest_event: {
              sequence: 2,
              event_type: "execution.completed",
              occurred_at: "2026-03-31T12:00:02.000Z",
              recorded_at: "2026-03-31T12:00:02.000Z",
            },
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
              artifact_health: {
                status: "healthy",
                total: 0,
                available: 0,
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
              session_id: "sess_ws",
              workflow_name: "inspector-flow",
              agent_framework: "cli",
              agent_name: "agentgit-cli",
              workspace_roots: ["/workspace/project"],
              event_count: 2,
              latest_event: {
                sequence: 2,
                event_type: "execution.completed",
                occurred_at: "2026-03-31T12:00:02.000Z",
                recorded_at: "2026-03-31T12:00:02.000Z",
              },
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
                artifact_health: {
                  status: "healthy",
                  total: 0,
                  available: 0,
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
                step_id: "step_ws_1",
                run_id: payload.run_id,
                sequence: 1,
                step_type: "action_step",
                title: "WS step",
                status: "completed",
                provenance: "governed",
                action_id: "act_ws_1",
                decision: "allow",
                primary_reason: {
                  code: "SAFE",
                  message: "Safe action.",
                },
                reversibility_class: "reversible",
                confidence: 0.98,
                summary: "Websocket timeline step.",
                warnings: [],
                primary_artifacts: [],
                artifact_previews: [],
                external_effects: [],
                related: {
                  target_locator: null,
                },
                occurred_at: "2026-03-31T12:00:01.000Z",
              },
            ],
            projection_status: "fresh",
            visibility_scope: payload.visibility_scope,
            redactions_applied: 0,
            preview_budget: {
              max_inline_preview_chars: 160,
              max_total_inline_preview_chars: 1200,
              preview_chars_used: 0,
              truncated_previews: 0,
              omitted_previews: 0,
            },
          });
        case "query_helper":
          return successEnvelope(request, {
            answer: `helper:${payload.question_type as string}`,
            confidence: 0.9,
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

    const app = await listenHttp(createInspectorServer({ authToken: TEST_AUTH_TOKEN, socketPath: daemon.socketPath }));
    const first = await connectInspectorWebSocket(app, "/ws?run_id=run_ws&visibility_scope=internal");
    const hello = await first.waitFor((message) => message.type === "hello");
    const overview = await first.waitFor((message) => message.type === "overview");
    const runView = await first.waitFor((message) => message.type === "run_view");
    const heartbeat = await first.waitFor((message) => message.type === "heartbeat");

    expect(hello.heartbeat_interval_ms).toBe(2000);
    expect(hello.replayed_messages).toBe(0);
    expect(typeof overview.sequence).toBe("number");
    expect(typeof runView.sequence).toBe("number");
    expect(Number(runView.sequence)).toBeGreaterThan(Number(overview.sequence));
    expect(typeof heartbeat.sequence).toBe("number");

    const resumed = await connectInspectorWebSocket(
      app,
      `/ws?run_id=run_ws&visibility_scope=internal&last_sequence=${String(overview.sequence)}`,
    );
    const replayedRunView = await resumed.waitFor(
      (message) => message.type === "run_view" && message.replayed === true,
    );
    const resumedHello = await resumed.waitFor((message) => message.type === "hello");

    expect(replayedRunView.sequence).toBe(runView.sequence);
    expect(resumedHello.replayed_messages).toBeGreaterThanOrEqual(1);

    await first.close();
    await resumed.close();

    expect(requests.some((entry) => entry.method === "diagnostics")).toBe(true);
    expect(requests.some((entry) => entry.method === "get_capabilities")).toBe(true);
    expect(requests.some((entry) => entry.method === "query_timeline")).toBe(true);
    expect(
      requests
        .filter((entry) => entry.method === "query_timeline" || entry.method === "query_helper")
        .every((entry) => entry.payload.visibility_scope === "internal"),
    ).toBe(true);
  });

  it("rejects malformed maintenance requests before they reach the daemon", async () => {
    const daemon = await createFakeDaemon((request) => {
      if (request.method === "hello") {
        return successEnvelope(request, { session_id: "sess_ui" });
      }

      throw new Error("The inspector should not proxy malformed maintenance payloads.");
    });

    const app = await listenHttp(createInspectorServer({ authToken: TEST_AUTH_TOKEN, socketPath: daemon.socketPath }));
    const response = await fetch(authedInspectorUrl(app, "/api/maintenance"), {
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
    const app = await listenHttp(createInspectorServer({ authToken: TEST_AUTH_TOKEN, socketPath: missingSocketPath }));
    const response = await fetch(authedInspectorUrl(app, "/api/overview"));
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(typeof body.code).toBe("string");
    expect(body.code.startsWith("SOCKET_CONNECT")).toBe(true);
  });
});
