import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { RunJournal } from "@agentgit/run-journal";

const authorityHello = vi.fn(async () => ({
  api_version: "0.1.0",
}));
const authorityResolveApproval = vi.fn();

vi.mock("@agentgit/authority-sdk", () => ({
  AuthorityClient: class {
    hello = authorityHello;
    resolveApproval = authorityResolveApproval;
  },
}));

import {
  CloudConnectorRuntime,
  CloudConnectorService,
  CloudConnectorStateStore,
  CloudSyncClient,
} from "./index.js";

function initGitRepo(repoRoot: string) {
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "connector-test@agentgit.dev"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Connector Test"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/platform-ui.git"], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "# Connector Test\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "chore: initial commit"], { cwd: repoRoot, stdio: "ignore" });
}

function seedJournal(repoRoot: string) {
  const journalPath = path.join(repoRoot, ".agentgit", "state", "authority.db");
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  const journal = new RunJournal({ dbPath: journalPath });

  try {
    journal.registerRunLifecycle({
      run_id: "run_connector_01",
      session_id: "sess_connector_01",
      workflow_name: "connector-sync",
      agent_framework: "cloud",
      agent_name: "Codex",
      workspace_roots: [repoRoot],
      client_metadata: {},
      budget_config: {
        max_mutating_actions: null,
        max_destructive_actions: null,
      },
      created_at: "2026-04-07T19:00:00Z",
    });
    journal.appendRunEvent("run_connector_01", {
      event_type: "action.normalized",
      occurred_at: "2026-04-07T19:00:01Z",
      recorded_at: "2026-04-07T19:00:01Z",
      payload: {
        action_id: "act_connector_01",
        target_locator: path.join(repoRoot, "README.md"),
      },
    });
  } finally {
    journal.close();
  }
}

async function withServer(
  handler: (params: {
    baseUrl: string;
    events: Array<Record<string, unknown>>;
    acknowledgements: Array<Record<string, unknown>>;
  }) => Promise<void>,
  options: {
    commandBatches?: Array<Array<Record<string, unknown>>>;
  } = {},
) {
  const events: Array<Record<string, unknown>> = [];
  const acknowledgements: Array<Record<string, unknown>> = [];
  let pullCount = 0;

  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};

    response.setHeader("content-type", "application/json");

    if (request.url === "/api/v1/sync/register" && request.method === "POST") {
      response.end(
        JSON.stringify({
          schemaVersion: "cloud-sync.v1",
          connector: {
            id: "conn_test_01",
            workspaceId: body.workspaceId,
            workspaceSlug: "acme",
            connectorName: body.connectorName,
            machineName: body.machineName,
            connectorVersion: body.connectorVersion,
            platform: body.platform,
            capabilities: body.capabilities,
            repository: body.repository,
            status: "active",
            registeredAt: "2026-04-07T19:00:00Z",
            lastSeenAt: "2026-04-07T19:00:00Z",
          },
          accessToken: "agcs_test",
          issuedAt: "2026-04-07T19:00:00Z",
          expiresAt: "2026-05-07T19:00:00Z",
        }),
      );
      return;
    }

    if (request.url === "/api/v1/sync/heartbeat" && request.method === "POST") {
      response.end(
        JSON.stringify({
          schemaVersion: "cloud-sync.v1",
          connectorId: "conn_test_01",
          acceptedAt: "2026-04-07T19:00:10Z",
          status: "active",
          pendingCommandCount: 1,
        }),
      );
      return;
    }

    if (request.url === "/api/v1/sync/events" && request.method === "POST") {
      events.push(...((body.events as Array<Record<string, unknown>>) ?? []));
      const highestAcceptedSequence = events.reduce((highest, event) => {
        const sequence = typeof event.sequence === "number" ? event.sequence : 0;
        return Math.max(highest, sequence);
      }, 0);
      response.end(
        JSON.stringify({
          schemaVersion: "cloud-sync.v1",
          connectorId: "conn_test_01",
          acceptedAt: "2026-04-07T19:00:11Z",
          acceptedCount: (body.events as unknown[] | undefined)?.length ?? 0,
          highestAcceptedSequence,
        }),
      );
      return;
    }

    if (request.url === "/api/v1/sync/commands/pull" && request.method === "POST") {
      pullCount += 1;
      const commands =
        options.commandBatches?.[pullCount - 1] ??
        (pullCount === 1
          ? [
              {
                schemaVersion: "cloud-sync.v1",
                commandId: "cmd_test_01",
                connectorId: "conn_test_01",
                workspaceId: "ws_acme_01",
                repository: {
                  owner: "acme",
                  name: "platform-ui",
                },
                issuedAt: "2026-04-07T19:00:12Z",
                expiresAt: "2026-04-08T19:00:12Z",
                type: "create_commit",
                payload: {
                  message: "chore: connector sync commit",
                  stageAll: true,
                },
              },
            ]
          : []);
      response.end(
        JSON.stringify({
          schemaVersion: "cloud-sync.v1",
          connectorId: "conn_test_01",
          acceptedAt: "2026-04-07T19:00:12Z",
          commands,
        }),
      );
      return;
    }

    if (request.url?.startsWith("/api/v1/sync/commands/") && request.url.endsWith("/ack") && request.method === "POST") {
      const commandId = request.url.split("/")[5] ?? "unknown";
      acknowledgements.push(body);
      response.end(
        JSON.stringify({
          schemaVersion: "cloud-sync.v1",
          connectorId: "conn_test_01",
          commandId,
          acceptedAt: "2026-04-07T19:00:13Z",
          status: body.status,
        }),
      );
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ message: "Not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not determine test server address.");
  }

  try {
    await handler({
      baseUrl: `http://127.0.0.1:${address.port}`,
      events,
      acknowledgements,
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

describe("cloud connector runtime", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("registers, publishes local repo and journal state, and executes a cloud-driven create-commit command", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-connector-"));
    tempDirs.push(tempDir);
    const repoRoot = path.join(tempDir, "repo");
    fs.mkdirSync(repoRoot, { recursive: true });
    initGitRepo(repoRoot);
    seedJournal(repoRoot);
    fs.writeFileSync(path.join(repoRoot, "README.md"), "# Connector Test\n\nUpdated by connector.\n", "utf8");

    await withServer(async ({ baseUrl, events, acknowledgements }) => {
      const stateDbPath = path.join(tempDir, "connector.db");
      const store = new CloudConnectorStateStore(stateDbPath);
      const service = new CloudConnectorService(store, new CloudSyncClient(baseUrl));
      const runtime = new CloudConnectorRuntime({
        stateStore: store,
        service,
        workspaceRoot: repoRoot,
        connectorVersion: "0.1.0",
        now: () => "2026-04-07T19:00:10Z",
      });

      try {
        await runtime.bootstrapRegister({
          cloudBaseUrl: baseUrl,
          workspaceId: "ws_acme_01",
          bootstrapToken: "agcbt_test",
          connectorName: "MacBook connector",
          machineName: "geoffrey-mbp",
        });

        const result = await runtime.syncOnce();

        expect(result.commands).toHaveLength(1);
        expect(result.commands[0]?.status).toBe("completed");
        expect(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim()).toBe("2");
        expect(events.some((event) => event.type === "repo_state.snapshot")).toBe(true);
        expect(events.some((event) => event.type === "run.lifecycle")).toBe(true);
        expect(events.some((event) => event.type === "run.event")).toBe(true);
        expect(acknowledgements.map((entry) => entry.status)).toEqual(["acked", "completed"]);
      } finally {
        store.close();
      }
    });
  });

  it("opens a provider-backed GitHub pull request through the connector command path", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-connector-"));
    tempDirs.push(tempDir);
    const repoRoot = path.join(tempDir, "repo");
    fs.mkdirSync(repoRoot, { recursive: true });
    initGitRepo(repoRoot);
    seedJournal(repoRoot);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input);
      if (target.startsWith("https://api.github.com/")) {
        expect(init?.method).toBe("POST");
        return new Response(
          JSON.stringify({
            html_url: "https://github.com/acme/platform-ui/pull/42",
            number: 42,
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }

      return originalFetch(input, init);
    }) as typeof fetch;

    process.env.AGENTGIT_GITHUB_TOKEN = "ghp_test";

    try {
      await withServer(
        async ({ baseUrl, acknowledgements }) => {
          const stateDbPath = path.join(tempDir, "connector.db");
          const store = new CloudConnectorStateStore(stateDbPath);
          const service = new CloudConnectorService(store, new CloudSyncClient(baseUrl));
          const runtime = new CloudConnectorRuntime({
            stateStore: store,
            service,
            workspaceRoot: repoRoot,
            connectorVersion: "0.1.0",
            now: () => "2026-04-07T19:00:10Z",
          });

          try {
            await runtime.bootstrapRegister({
              cloudBaseUrl: baseUrl,
              workspaceId: "ws_acme_01",
              bootstrapToken: "agcbt_test",
            });

            const processed = await runtime.processCommands();
            expect(processed[0]?.status).toBe("completed");
            expect(processed[0]?.message).toContain("https://github.com/acme/platform-ui/pull/42");
            expect(acknowledgements.map((entry) => entry.status)).toEqual(["acked", "completed"]);
            expect(acknowledgements[1]?.result).toMatchObject({
              type: "open_pull_request",
              pullRequestUrl: "https://github.com/acme/platform-ui/pull/42",
              pullRequestNumber: 42,
              baseBranch: "main",
              headBranch: "feature/live",
              draft: true,
            });
          } finally {
            store.close();
          }
        },
        {
          commandBatches: [
            [
              {
                schemaVersion: "cloud-sync.v1",
                commandId: "cmd_pr_01",
                connectorId: "conn_test_01",
                workspaceId: "ws_acme_01",
                repository: {
                  owner: "acme",
                  name: "platform-ui",
                },
                issuedAt: "2026-04-07T19:00:12Z",
                expiresAt: "2026-04-08T19:00:12Z",
                type: "open_pull_request",
                payload: {
                  title: "AgentGit governed update",
                  headBranch: "feature/live",
                  draft: true,
                },
              },
            ],
          ],
        },
      );
    } finally {
      delete process.env.AGENTGIT_GITHUB_TOKEN;
      globalThis.fetch = originalFetch;
    }
  });

  it("resolves approvals through the local daemon command path and reports the execution result", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-connector-"));
    tempDirs.push(tempDir);
    const repoRoot = path.join(tempDir, "repo");
    fs.mkdirSync(repoRoot, { recursive: true });
    initGitRepo(repoRoot);
    seedJournal(repoRoot);

    authorityResolveApproval.mockResolvedValue({
      approval_request: {
        approval_id: "appr_connector_01",
        run_id: "run_connector_01",
        action_id: "act_connector_01",
        status: "approved",
        resolved_at: "2026-04-07T19:00:16Z",
      },
    });

    await withServer(
      async ({ baseUrl, acknowledgements }) => {
        const stateDbPath = path.join(tempDir, "connector.db");
        const store = new CloudConnectorStateStore(stateDbPath);
        const service = new CloudConnectorService(store, new CloudSyncClient(baseUrl));
        const runtime = new CloudConnectorRuntime({
          stateStore: store,
          service,
          workspaceRoot: repoRoot,
          connectorVersion: "0.1.0",
          now: () => "2026-04-07T19:00:10Z",
        });

        try {
          await runtime.bootstrapRegister({
            cloudBaseUrl: baseUrl,
            workspaceId: "ws_acme_01",
            bootstrapToken: "agcbt_test",
          });

          const processed = await runtime.processCommands();
          expect(processed[0]).toMatchObject({
            commandId: "cmd_resolve_01",
            status: "completed",
          });
          expect(authorityHello).toHaveBeenCalledWith([fs.realpathSync.native(repoRoot)]);
          expect(authorityResolveApproval).toHaveBeenCalledWith("appr_connector_01", "approved", "Ship it");
          expect(acknowledgements.map((entry) => entry.status)).toEqual(["acked", "completed"]);
          expect(acknowledgements[1]?.result).toMatchObject({
            type: "resolve_approval",
            approvalId: "appr_connector_01",
            runId: "run_connector_01",
            actionId: "act_connector_01",
            resolution: "approved",
            resolvedAt: "2026-04-07T19:00:16Z",
          });
        } finally {
          store.close();
        }
      },
      {
        commandBatches: [
          [
            {
              schemaVersion: "cloud-sync.v1",
              commandId: "cmd_resolve_01",
              connectorId: "conn_test_01",
              workspaceId: "ws_acme_01",
              repository: {
                owner: "acme",
                name: "platform-ui",
              },
              issuedAt: "2026-04-07T19:00:12Z",
              expiresAt: "2026-04-08T19:00:12Z",
              type: "resolve_approval",
              payload: {
                approvalId: "appr_connector_01",
                resolution: "approved",
                note: "Ship it",
              },
            },
          ],
        ],
      },
    );
  });
});
