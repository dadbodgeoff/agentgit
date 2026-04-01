import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AuthorityClient, AuthorityDaemonResponseError } from "@agentgit/authority-sdk";

import { startServer } from "../../authority-daemon/src/server.js";
import { runCli } from "./main.js";

interface CliHarness {
  root: string;
  workspaceRoot: string;
  socketPath: string;
  journalPath: string;
  snapshotRootPath: string;
  server: Awaited<ReturnType<typeof startServer>>;
}

const harnesses: CliHarness[] = [];
const CLI_PACKAGE_ROOT = path.resolve(decodeURIComponent(new URL("..", import.meta.url).pathname));
const CLI_DIST_ENTRY = path.resolve(CLI_PACKAGE_ROOT, "dist", "main.js");
const MCP_TEST_SERVER_SCRIPT = decodeURIComponent(
  new URL("../../execution-adapters/src/mcp-test-server.mjs", import.meta.url).pathname,
);
const ORIGINAL_AGENTGIT_ROOT = process.env.AGENTGIT_ROOT;
const ORIGINAL_INIT_CWD = process.env.INIT_CWD;

function pnpmCommand(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

async function createHarness(): Promise<CliHarness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cli-it-"));
  const workspaceRoot = path.join(root, "workspace");
  const socketPath = path.join(root, "authority.sock");
  const journalPath = path.join(root, "authority.db");
  const snapshotRootPath = path.join(root, "snapshots");

  fs.mkdirSync(workspaceRoot, { recursive: true });

  const server = await startServer({
    socketPath,
    journalPath,
    snapshotRootPath,
  });

  const harness = {
    root,
    workspaceRoot,
    socketPath,
    journalPath,
    snapshotRootPath,
    server,
  };
  harnesses.push(harness);
  return harness;
}

async function closeHarness(harness: CliHarness): Promise<void> {
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

  fs.rmSync(harness.root, { recursive: true, force: true });
}

async function withWorkspaceRoot<T>(workspaceRoot: string, operation: () => Promise<T>): Promise<T> {
  process.env.AGENTGIT_ROOT = workspaceRoot;
  process.env.INIT_CWD = workspaceRoot;

  try {
    return await operation();
  } finally {
    if (ORIGINAL_AGENTGIT_ROOT === undefined) {
      delete process.env.AGENTGIT_ROOT;
    } else {
      process.env.AGENTGIT_ROOT = ORIGINAL_AGENTGIT_ROOT;
    }

    if (ORIGINAL_INIT_CWD === undefined) {
      delete process.env.INIT_CWD;
    } else {
      process.env.INIT_CWD = ORIGINAL_INIT_CWD;
    }
  }
}

async function captureCliRun(
  argv: string[],
  client: AuthorityClient,
  workspaceRoot: string,
): Promise<{ stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
    stdout.push(typeof value === "string" ? value : JSON.stringify(value));
  });
  const stderrSpy = vi.spyOn(console, "error").mockImplementation((value?: unknown) => {
    stderr.push(typeof value === "string" ? value : JSON.stringify(value));
  });

  try {
    await withWorkspaceRoot(workspaceRoot, async () => {
      await runCli(argv, client);
    });
    return {
      stdout: stdout.join("\n"),
      stderr: stderr.join("\n"),
    };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    process.exitCode = 0;
  }
}

async function captureCliJson<T>(argv: string[], client: AuthorityClient, workspaceRoot: string): Promise<T> {
  const output = await captureCliRun(["--json", ...argv], client, workspaceRoot);
  expect(output.stderr).toBe("");
  return JSON.parse(output.stdout) as T;
}

async function runCliProcess(
  argv: string[],
  options: {
    workspaceRoot: string;
    socketPath: string;
  },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_DIST_ENTRY, ...argv], {
      cwd: options.workspaceRoot,
      env: {
        ...process.env,
        AGENTGIT_ROOT: options.workspaceRoot,
        INIT_CWD: options.workspaceRoot,
        AGENTGIT_SOCKET_PATH: options.socketPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

beforeAll(() => {
  execFileSync(pnpmCommand(), ["build"], {
    cwd: CLI_PACKAGE_ROOT,
    stdio: "pipe",
    env: process.env,
  });
});

afterEach(async () => {
  while (harnesses.length > 0) {
    await closeHarness(harnesses.pop()!);
  }

  process.exitCode = 0;
});

describe("authority cli MCP integration", () => {
  it("manages MCP secrets, host policies, and guarded public server registration against a live daemon", async () => {
    const harness = await createHarness();
    const client = new AuthorityClient({
      socketPath: harness.socketPath,
      connectTimeoutMs: 250,
      responseTimeoutMs: 10_000,
      maxConnectRetries: 0,
    });

    await captureCliRun(
      [
        "upsert-mcp-secret",
        JSON.stringify({
          secret_id: "notion_bearer",
          display_name: "Notion MCP bearer",
          bearer_token: "super-secret-token",
        }),
      ],
      client,
      harness.workspaceRoot,
    );

    await expect(
      withWorkspaceRoot(harness.workspaceRoot, async () => {
        await runCli(
          [
            "upsert-mcp-server",
            JSON.stringify({
              server_id: "notion_public",
              display_name: "Notion public MCP",
              transport: "streamable_http",
              url: "https://api.notion.com/mcp",
              network_scope: "public_https",
              auth: {
                type: "bearer_secret_ref",
                secret_id: "notion_bearer",
              },
              tools: [
                {
                  tool_name: "echo_note",
                  side_effect_level: "read_only",
                  approval_mode: "allow",
                },
              ],
            }),
          ],
          client,
        );
      }),
    ).rejects.toMatchObject({
      name: "AuthorityDaemonResponseError",
      code: "CAPABILITY_UNAVAILABLE",
    } satisfies Partial<AuthorityDaemonResponseError>);

    await captureCliRun(
      [
        "upsert-mcp-host-policy",
        JSON.stringify({
          host: "api.notion.com",
          display_name: "Notion API",
          allow_subdomains: false,
          allowed_ports: [443],
        }),
      ],
      client,
      harness.workspaceRoot,
    );

    await captureCliRun(
      [
        "upsert-mcp-server",
        JSON.stringify({
          server_id: "notion_public",
          display_name: "Notion public MCP",
          transport: "streamable_http",
          url: "https://api.notion.com/mcp",
          network_scope: "public_https",
          auth: {
            type: "bearer_secret_ref",
            secret_id: "notion_bearer",
          },
          tools: [
            {
              tool_name: "echo_note",
              side_effect_level: "read_only",
              approval_mode: "allow",
            },
          ],
        }),
      ],
      client,
      harness.workspaceRoot,
    );

    const secrets = await captureCliJson<{ secrets: Array<Record<string, unknown>> }>(
      ["list-mcp-secrets"],
      client,
      harness.workspaceRoot,
    );
    expect(secrets.secrets).toHaveLength(1);
    expect(secrets.secrets[0]).toMatchObject({
      secret_id: "notion_bearer",
      display_name: "Notion MCP bearer",
      auth_type: "bearer",
      status: "active",
      source: "operator_api",
    });
    expect(JSON.stringify(secrets)).not.toContain("super-secret-token");

    const policies = await captureCliJson<{ policies: Array<Record<string, unknown>> }>(
      ["list-mcp-host-policies"],
      client,
      harness.workspaceRoot,
    );
    expect(policies.policies).toHaveLength(1);
    expect(policies.policies[0]).toMatchObject({
      source: "operator_api",
      policy: {
        host: "api.notion.com",
        allowed_ports: [443],
      },
    });

    const servers = await captureCliJson<{ servers: Array<Record<string, unknown>> }>(
      ["list-mcp-servers"],
      client,
      harness.workspaceRoot,
    );
    expect(servers.servers).toHaveLength(1);
    expect(servers.servers[0]).toMatchObject({
      source: "operator_api",
      server: {
        server_id: "notion_public",
        transport: "streamable_http",
        network_scope: "public_https",
        auth: {
          type: "bearer_secret_ref",
          secret_id: "notion_bearer",
        },
      },
    });
  });

  it("submits a governed MCP tool call from the CLI against a live stdio server", async () => {
    const harness = await createHarness();
    const client = new AuthorityClient({
      socketPath: harness.socketPath,
      connectTimeoutMs: 250,
      responseTimeoutMs: 10_000,
      maxConnectRetries: 0,
    });

    const run = await captureCliJson<{ run_id: string }>(["register-run", "cli-mcp-e2e"], client, harness.workspaceRoot);

    await captureCliRun(
      [
        "upsert-mcp-server",
        JSON.stringify({
          server_id: "notes_stdio",
          display_name: "Notes stdio MCP",
          transport: "stdio",
          command: process.execPath,
          args: [MCP_TEST_SERVER_SCRIPT],
          tools: [
            {
              tool_name: "echo_note",
              side_effect_level: "read_only",
              approval_mode: "allow",
            },
          ],
        }),
      ],
      client,
      harness.workspaceRoot,
    );

    const submit = await captureCliJson<{
      action: {
        operation: {
          domain: string;
          display_name: string;
        };
      };
      execution_result: {
        mode: string;
        success: boolean;
        output: {
          server_id: string;
          tool_name: string;
          summary: string;
        };
      } | null;
    }>(
      ["submit-mcp-tool", run.run_id, "notes_stdio", "echo_note", '{"note":"launch blocker"}'],
      client,
      harness.workspaceRoot,
    );

    expect(submit.action.operation.domain).toBe("mcp");
    expect(submit.action.operation.display_name).toBe("Call MCP tool notes_stdio/echo_note");
    expect(submit.execution_result).toMatchObject({
      mode: "executed",
      success: true,
      output: {
        server_id: "notes_stdio",
        tool_name: "echo_note",
        summary: "echo:launch blocker",
      },
    });

    const runSummary = await captureCliJson<{
      run: {
        run_id: string;
        workflow_name: string;
        event_count: number;
      };
    }>(["run-summary", run.run_id], client, harness.workspaceRoot);

    expect(runSummary.run.run_id).toBe(run.run_id);
    expect(runSummary.run.workflow_name).toBe("cli-mcp-e2e");
    expect(runSummary.run.event_count).toBeGreaterThan(0);
  });

  it("executes the built CLI binary end to end for stdio MCP registration and invocation using JSON files", async () => {
    const harness = await createHarness();
    const serverDefinitionPath = path.join(harness.root, "notes_stdio.json");
    const toolArgumentsPath = path.join(harness.root, "echo_note_args.json");

    fs.writeFileSync(
      serverDefinitionPath,
      JSON.stringify({
        server_id: "notes_stdio_process",
        display_name: "Notes stdio MCP process test",
        transport: "stdio",
        command: process.execPath,
        args: [MCP_TEST_SERVER_SCRIPT],
        tools: [
          {
            tool_name: "echo_note",
            side_effect_level: "read_only",
            approval_mode: "allow",
          },
        ],
      }),
      "utf8",
    );
    fs.writeFileSync(
      toolArgumentsPath,
      JSON.stringify({
        note: "hello from process cli",
      }),
      "utf8",
    );

    const registerRun = await runCliProcess(["--json", "register-run", "cli-process-mcp"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(registerRun.code).toBe(0);
    expect(registerRun.stderr).toBe("");
    const run = JSON.parse(registerRun.stdout) as { run_id: string };

    const upsertServer = await runCliProcess(["upsert-mcp-server", serverDefinitionPath], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(upsertServer.code).toBe(0);
    expect(upsertServer.stderr).toBe("");
    expect(upsertServer.stdout).toContain("Registered MCP server notes_stdio_process");

    const submit = await runCliProcess(
      ["--json", "submit-mcp-tool", run.run_id, "notes_stdio_process", "echo_note", toolArgumentsPath],
      {
        workspaceRoot: harness.workspaceRoot,
        socketPath: harness.socketPath,
      },
    );
    expect(submit.code).toBe(0);
    expect(submit.stderr).toBe("");
    const submitResult = JSON.parse(submit.stdout) as {
      execution_result: {
        mode: string;
        success: boolean;
        output: {
          server_id: string;
          tool_name: string;
          summary: string;
        };
      };
    };
    expect(submitResult.execution_result).toMatchObject({
      mode: "executed",
      success: true,
      output: {
        server_id: "notes_stdio_process",
        tool_name: "echo_note",
        summary: "echo:hello from process cli",
      },
    });

    const listServers = await runCliProcess(["--json", "list-mcp-servers"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(listServers.code).toBe(0);
    const listed = JSON.parse(listServers.stdout) as {
      servers: Array<{ server: { server_id: string; transport: string } }>;
    };
    expect(
      listed.servers.some(
        (record) =>
          record.server.server_id === "notes_stdio_process" && record.server.transport === "stdio",
      ),
    ).toBe(true);
  });

  it("fails closed in the built CLI binary when public HTTPS MCP registration lacks an allowlisted host policy", async () => {
    const harness = await createHarness();
    const secretPath = path.join(harness.root, "public_secret.json");
    const serverPath = path.join(harness.root, "public_server.json");
    const hostPolicyPath = path.join(harness.root, "public_host_policy.json");

    fs.writeFileSync(
      secretPath,
      JSON.stringify({
        secret_id: "public_api_secret",
        display_name: "Public API bearer",
        bearer_token: "top-secret-process-token",
      }),
      "utf8",
    );
    fs.writeFileSync(
      serverPath,
      JSON.stringify({
        server_id: "notes_public_process",
        display_name: "Notes public HTTPS MCP",
        transport: "streamable_http",
        url: "https://api.notion.com/mcp",
        network_scope: "public_https",
        auth: {
          type: "bearer_secret_ref",
          secret_id: "public_api_secret",
        },
        tools: [
          {
            tool_name: "echo_note",
            side_effect_level: "read_only",
            approval_mode: "allow",
          },
        ],
      }),
      "utf8",
    );
    fs.writeFileSync(
      hostPolicyPath,
      JSON.stringify({
        host: "api.notion.com",
        display_name: "Notion API",
        allow_subdomains: false,
        allowed_ports: [443],
      }),
      "utf8",
    );

    const upsertSecret = await runCliProcess(["upsert-mcp-secret", secretPath], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(upsertSecret.code).toBe(0);
    expect(upsertSecret.stderr).toBe("");

    const rejected = await runCliProcess(["upsert-mcp-server", serverPath], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(rejected.code).toBe(1);
    expect(rejected.stdout).toBe("");
    expect(rejected.stderr).toContain(
      "Governed public HTTPS MCP execution requires an explicit operator-managed host allowlist policy",
    );

    const listAfterReject = await runCliProcess(["--json", "list-mcp-servers"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(listAfterReject.code).toBe(0);
    const emptyListing = JSON.parse(listAfterReject.stdout) as { servers: Array<unknown> };
    expect(emptyListing.servers).toHaveLength(0);

    const upsertPolicy = await runCliProcess(["upsert-mcp-host-policy", hostPolicyPath], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(upsertPolicy.code).toBe(0);
    expect(upsertPolicy.stderr).toBe("");

    const accepted = await runCliProcess(["upsert-mcp-server", serverPath], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(accepted.code).toBe(0);
    expect(accepted.stderr).toBe("");
    expect(accepted.stdout).toContain("Registered MCP server notes_public_process");

    const listSecrets = await runCliProcess(["--json", "list-mcp-secrets"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(listSecrets.code).toBe(0);
    expect(listSecrets.stdout).not.toContain("top-secret-process-token");
  });

  it("rotates and removes MCP secrets, host policies, and servers through the built CLI binary", async () => {
    const harness = await createHarness();
    const secretV1Path = path.join(harness.root, "rotation_secret_v1.json");
    const secretV2Path = path.join(harness.root, "rotation_secret_v2.json");
    const hostPolicyPath = path.join(harness.root, "rotation_host_policy.json");
    const serverPath = path.join(harness.root, "rotation_server.json");

    fs.writeFileSync(
      secretV1Path,
      JSON.stringify({
        secret_id: "rotation_secret",
        display_name: "Rotating MCP bearer",
        bearer_token: "rotation-token-v1",
      }),
      "utf8",
    );
    fs.writeFileSync(
      secretV2Path,
      JSON.stringify({
        secret_id: "rotation_secret",
        display_name: "Rotating MCP bearer",
        bearer_token: "rotation-token-v2",
      }),
      "utf8",
    );
    fs.writeFileSync(
      hostPolicyPath,
      JSON.stringify({
        host: "api.rotation.test",
        display_name: "Rotation API",
        allow_subdomains: false,
        allowed_ports: [443],
      }),
      "utf8",
    );
    fs.writeFileSync(
      serverPath,
      JSON.stringify({
        server_id: "rotation_public_server",
        display_name: "Rotation public HTTPS MCP",
        transport: "streamable_http",
        url: "https://api.rotation.test/mcp",
        network_scope: "public_https",
        auth: {
          type: "bearer_secret_ref",
          secret_id: "rotation_secret",
        },
        tools: [
          {
            tool_name: "echo_note",
            side_effect_level: "read_only",
            approval_mode: "allow",
          },
        ],
      }),
      "utf8",
    );

    const storeSecret = await runCliProcess(["upsert-mcp-secret", secretV1Path], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(storeSecret.code).toBe(0);
    expect(storeSecret.stdout).toContain("Stored MCP secret rotation_secret");

    const rotateSecret = await runCliProcess(["upsert-mcp-secret", secretV2Path], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(rotateSecret.code).toBe(0);
    expect(rotateSecret.stdout).toContain("Rotated MCP secret rotation_secret");
    expect(rotateSecret.stdout).toContain("Version: 2");

    const listSecretsAfterRotate = await runCliProcess(["--json", "list-mcp-secrets"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(listSecretsAfterRotate.code).toBe(0);
    const secrets = JSON.parse(listSecretsAfterRotate.stdout) as {
      secrets: Array<{
        secret_id: string;
        version: number;
        rotated_at: string | null;
      }>;
    };
    expect(secrets.secrets).toHaveLength(1);
    expect(secrets.secrets[0]).toMatchObject({
      secret_id: "rotation_secret",
      version: 2,
    });
    expect(secrets.secrets[0].rotated_at).not.toBeNull();
    expect(listSecretsAfterRotate.stdout).not.toContain("rotation-token-v2");

    const upsertPolicy = await runCliProcess(["upsert-mcp-host-policy", hostPolicyPath], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(upsertPolicy.code).toBe(0);

    const upsertServer = await runCliProcess(["upsert-mcp-server", serverPath], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(upsertServer.code).toBe(0);
    expect(upsertServer.stdout).toContain("Registered MCP server rotation_public_server");

    const removeServer = await runCliProcess(["remove-mcp-server", "rotation_public_server"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(removeServer.code).toBe(0);
    expect(removeServer.stdout).toContain("Removed MCP server rotation_public_server");

    const removePolicy = await runCliProcess(["remove-mcp-host-policy", "api.rotation.test"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(removePolicy.code).toBe(0);
    expect(removePolicy.stdout).toContain("Removed MCP host policy api.rotation.test");

    const removeSecret = await runCliProcess(["remove-mcp-secret", "rotation_secret"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(removeSecret.code).toBe(0);
    expect(removeSecret.stdout).toContain("Removed MCP secret rotation_secret");

    const listServersFinal = await runCliProcess(["--json", "list-mcp-servers"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    const listPoliciesFinal = await runCliProcess(["--json", "list-mcp-host-policies"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    const listSecretsFinal = await runCliProcess(["--json", "list-mcp-secrets"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect((JSON.parse(listServersFinal.stdout) as { servers: Array<unknown> }).servers).toHaveLength(0);
    expect((JSON.parse(listPoliciesFinal.stdout) as { policies: Array<unknown> }).policies).toHaveLength(0);
    expect((JSON.parse(listSecretsFinal.stdout) as { secrets: Array<unknown> }).secrets).toHaveLength(0);
  });

  it("fails closed in the built CLI binary for malformed MCP tool arguments before execution", async () => {
    const harness = await createHarness();
    const serverDefinitionPath = path.join(harness.root, "invalid_args_stdio.json");
    const invalidArgumentsPath = path.join(harness.root, "invalid_args.json");

    fs.writeFileSync(
      serverDefinitionPath,
      JSON.stringify({
        server_id: "notes_stdio_invalid_args",
        display_name: "Notes stdio invalid args test",
        transport: "stdio",
        command: process.execPath,
        args: [MCP_TEST_SERVER_SCRIPT],
        tools: [
          {
            tool_name: "echo_note",
            side_effect_level: "read_only",
            approval_mode: "allow",
          },
        ],
      }),
      "utf8",
    );
    fs.writeFileSync(invalidArgumentsPath, '{"note":"missing brace"', "utf8");

    const registerRun = await runCliProcess(["--json", "register-run", "cli-invalid-mcp-args"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(registerRun.code).toBe(0);
    const run = JSON.parse(registerRun.stdout) as { run_id: string };

    const upsertServer = await runCliProcess(["upsert-mcp-server", serverDefinitionPath], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(upsertServer.code).toBe(0);

    const summaryBeforeReject = await runCliProcess(["--json", "run-summary", run.run_id], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(summaryBeforeReject.code).toBe(0);
    const baselineSummary = JSON.parse(summaryBeforeReject.stdout) as {
      run: {
        event_count: number;
      };
    };

    const rejected = await runCliProcess(
      ["submit-mcp-tool", run.run_id, "notes_stdio_invalid_args", "echo_note", invalidArgumentsPath],
      {
        workspaceRoot: harness.workspaceRoot,
        socketPath: harness.socketPath,
      },
    );
    expect(rejected.code).toBe(1);
    expect(rejected.stdout).toBe("");
    expect(rejected.stderr).toContain("submit-mcp-tool expects JSON like");

    const summary = await runCliProcess(["--json", "run-summary", run.run_id], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(summary.code).toBe(0);
    const runSummary = JSON.parse(summary.stdout) as {
      run: {
        event_count: number;
      };
    };
    expect(runSummary.run.event_count).toBe(baselineSummary.run.event_count);
  });

  it("drives approval, timeline, and helper workflows through the built CLI binary", async () => {
    const harness = await createHarness();

    const registerRun = await runCliProcess(["--json", "register-run", "cli-approval-flow"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(registerRun.code).toBe(0);
    const run = JSON.parse(registerRun.stdout) as { run_id: string };

    const submit = await runCliProcess(
      ["--json", "submit-shell", run.run_id, process.execPath, "-e", "process.stdout.write('approved-shell-run')"],
      {
        workspaceRoot: harness.workspaceRoot,
        socketPath: harness.socketPath,
      },
    );
    expect(submit.code).toBe(0);
    const submitResult = JSON.parse(submit.stdout) as {
      approval_request: {
        approval_id: string;
        status: string;
        primary_reason?: {
          code: string;
        } | null;
      } | null;
    };
    expect(submitResult.approval_request?.status).toBe("pending");
    expect(submitResult.approval_request?.primary_reason?.code).toBe("UNKNOWN_SCOPE_REQUIRES_APPROVAL");
    const approvalId = submitResult.approval_request?.approval_id as string;

    const inbox = await runCliProcess(["--json", "approval-inbox", run.run_id, "pending"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(inbox.code).toBe(0);
    const inboxResult = JSON.parse(inbox.stdout) as {
      counts: { pending: number; approved: number; denied: number };
      items: Array<{ approval_id: string; status: string; reason_summary: string | null }>;
    };
    expect(inboxResult.counts.pending).toBe(1);
    expect(inboxResult.items[0]?.approval_id).toBe(approvalId);
    expect(inboxResult.items[0]?.status).toBe("pending");
    expect(inboxResult.items[0]?.reason_summary).toContain("requires approval");

    const approvals = await runCliProcess(["--json", "list-approvals", run.run_id, "pending"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(approvals.code).toBe(0);
    const approvalsResult = JSON.parse(approvals.stdout) as {
      approvals: Array<{ approval_id: string; status: string }>;
    };
    expect(approvalsResult.approvals[0]?.approval_id).toBe(approvalId);
    expect(approvalsResult.approvals[0]?.status).toBe("pending");

    const timelineBefore = await runCliProcess(["--json", "timeline", run.run_id], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(timelineBefore.code).toBe(0);
    const timelineBeforeResult = JSON.parse(timelineBefore.stdout) as {
      steps: Array<{ step_type: string; status: string; primary_reason?: { code: string } | null }>;
    };
    expect(
      timelineBeforeResult.steps.some(
        (step) =>
          step.step_type === "approval_step" &&
          step.status === "awaiting_approval" &&
          step.primary_reason?.code === "UNKNOWN_SCOPE_REQUIRES_APPROVAL",
      ),
    ).toBe(true);

    const helperBefore = await runCliProcess(["--json", "helper", run.run_id, "why_blocked"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(helperBefore.code).toBe(0);
    const helperBeforeResult = JSON.parse(helperBefore.stdout) as {
      answer: string;
      primary_reason?: { code: string } | null;
    };
    expect(helperBeforeResult.answer).toContain("waiting for approval");
    expect(helperBeforeResult.primary_reason?.code).toBe("UNKNOWN_SCOPE_REQUIRES_APPROVAL");

    const approve = await runCliProcess(["--json", "approve", approvalId, "cli integration approval"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(approve.code).toBe(0);
    const approveResult = JSON.parse(approve.stdout) as {
      approval_request: {
        status: string;
        resolution_note: string | null;
      };
      execution_result: {
        mode: string;
        output?: {
          stdout?: string;
        };
      } | null;
    };
    expect(approveResult.approval_request.status).toBe("approved");
    expect(approveResult.approval_request.resolution_note).toBe("cli integration approval");
    expect(approveResult.execution_result?.mode).toBe("executed");
    expect(approveResult.execution_result?.output?.stdout).toBe("approved-shell-run");

    const timelineAfter = await runCliProcess(["--json", "timeline", run.run_id], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(timelineAfter.code).toBe(0);
    const timelineAfterResult = JSON.parse(timelineAfter.stdout) as {
      steps: Array<{ step_type: string; summary: string }>;
    };
    expect(
      timelineAfterResult.steps.some(
        (step) =>
          step.step_type === "action_step" &&
          step.summary.includes("Executed") &&
          step.summary.includes("after approval."),
      ),
    ).toBe(true);
  });

  it("plans and executes snapshot recovery through the built CLI binary", async () => {
    const harness = await createHarness();
    const targetPath = path.join(harness.workspaceRoot, "restore-me-cli.txt");
    fs.writeFileSync(targetPath, "restore this content", "utf8");

    const registerRun = await runCliProcess(["--json", "register-run", "cli-recovery-flow"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(registerRun.code).toBe(0);
    const run = JSON.parse(registerRun.stdout) as { run_id: string };

    const submitDelete = await runCliProcess(["--json", "submit-filesystem-delete", run.run_id, targetPath], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(submitDelete.code).toBe(0);
    const deleteResult = JSON.parse(submitDelete.stdout) as {
      action: { action_id: string };
      snapshot_record: { snapshot_id: string } | null;
      execution_result: { mode: string } | null;
    };
    expect(deleteResult.snapshot_record?.snapshot_id).toBeTruthy();
    expect(deleteResult.execution_result?.mode).toBe("executed");
    expect(fs.existsSync(targetPath)).toBe(false);

    const snapshotId = deleteResult.snapshot_record?.snapshot_id as string;
    const actionId = deleteResult.action.action_id;

    const planBySnapshot = await runCliProcess(["--json", "plan-recovery", snapshotId], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(planBySnapshot.code).toBe(0);
    const snapshotPlan = JSON.parse(planBySnapshot.stdout) as {
      recovery_plan: {
        strategy: string;
      };
    };
    expect(snapshotPlan.recovery_plan.strategy).toBe("restore_snapshot");

    const planByAction = await runCliProcess(["--json", "plan-recovery", actionId], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(planByAction.code).toBe(0);
    const actionPlan = JSON.parse(planByAction.stdout) as {
      recovery_plan: {
        strategy: string;
        target: {
          type: string;
          action_id?: string;
        };
      };
    };
    expect(actionPlan.recovery_plan.strategy).toBe("restore_snapshot");
    expect(actionPlan.recovery_plan.target.type).toBe("action_boundary");
    expect(actionPlan.recovery_plan.target.action_id).toBe(actionId);

    const executeRecovery = await runCliProcess(["--json", "execute-recovery", snapshotId], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(executeRecovery.code).toBe(0);
    const executeResult = JSON.parse(executeRecovery.stdout) as {
      restored: boolean;
      recovery_plan: {
        strategy: string;
      };
    };
    expect(executeResult.restored).toBe(true);
    expect(executeResult.recovery_plan.strategy).toBe("restore_snapshot");
    expect(fs.readFileSync(targetPath, "utf8")).toBe("restore this content");

    const timeline = await runCliProcess(["--json", "timeline", run.run_id], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(timeline.code).toBe(0);
    const timelineResult = JSON.parse(timeline.stdout) as {
      steps: Array<{ step_type: string; related?: { snapshot_id?: string | null } }>;
    };
    expect(
      timelineResult.steps.some(
        (step) => step.step_type === "recovery_step" && step.related?.snapshot_id === snapshotId,
      ),
    ).toBe(true);
  });

  it("reports capabilities, maintenance, and diagnostics through the built CLI binary", async () => {
    const harness = await createHarness();

    const capabilities = await runCliProcess(["--json", "capabilities", harness.workspaceRoot], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(capabilities.code).toBe(0);
    const capabilitiesResult = JSON.parse(capabilities.stdout) as {
      capabilities: Array<{ capability_name: string; status: string; details?: Record<string, unknown> }>;
    };
    expect(
      capabilitiesResult.capabilities.some((capability) => capability.capability_name === "host.runtime_storage"),
    ).toBe(true);
    expect(
      capabilitiesResult.capabilities.some(
        (capability) =>
          capability.capability_name === "host.credential_broker_mode" &&
          capability.details?.mode === "local_encrypted_store",
      ),
    ).toBe(true);

    const maintenance = await runCliProcess(
      ["--json", "maintenance", "sqlite_wal_checkpoint", "capability_refresh"],
      {
        workspaceRoot: harness.workspaceRoot,
        socketPath: harness.socketPath,
      },
    );
    expect(maintenance.code).toBe(0);
    const maintenanceResult = JSON.parse(maintenance.stdout) as {
      accepted_priority: string;
      jobs: Array<{ job_type: string; status: string; performed_inline: boolean }>;
    };
    expect(maintenanceResult.accepted_priority).toBe("administrative");
    expect(
      maintenanceResult.jobs.some(
        (job) => job.job_type === "sqlite_wal_checkpoint" && job.status === "completed" && job.performed_inline,
      ),
    ).toBe(true);
    expect(
      maintenanceResult.jobs.some(
        (job) => job.job_type === "capability_refresh" && job.status === "completed" && job.performed_inline,
      ),
    ).toBe(true);

    const diagnostics = await runCliProcess(
      ["--json", "diagnostics", "daemon_health", "capability_summary", "storage_summary"],
      {
        workspaceRoot: harness.workspaceRoot,
        socketPath: harness.socketPath,
      },
    );
    expect(diagnostics.code).toBe(0);
    const diagnosticsResult = JSON.parse(diagnostics.stdout) as {
      daemon_health?: { status: string; active_runs: number };
      capability_summary?: { cached: boolean; capability_count: number };
      storage_summary?: { artifact_health: { total: number } };
    };
    expect(diagnosticsResult.daemon_health?.status).toBeTruthy();
    expect(typeof diagnosticsResult.daemon_health?.active_runs).toBe("number");
    expect(diagnosticsResult.capability_summary?.cached).toBe(true);
    expect((diagnosticsResult.capability_summary?.capability_count ?? 0) > 0).toBe(true);
    expect(typeof diagnosticsResult.storage_summary?.artifact_health.total).toBe("number");
  });

  it("enforces artifact visibility and redacts internal previews through the built CLI binary", async () => {
    const harness = await createHarness();
    const targetPath = path.join(harness.workspaceRoot, "visibility-proof.txt");
    fs.writeFileSync(targetPath, "Bearer secret-token", "utf8");

    const registerRun = await runCliProcess(["--json", "register-run", "cli-visibility-flow"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(registerRun.code).toBe(0);
    const run = JSON.parse(registerRun.stdout) as { run_id: string };

    const catFile = await runCliProcess(["--json", "submit-shell", run.run_id, "cat", targetPath], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(catFile.code).toBe(0);

    const userTimeline = await runCliProcess(["--json", "timeline", run.run_id], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(userTimeline.code).toBe(0);
    const userTimelineResult = JSON.parse(userTimeline.stdout) as {
      redactions_applied: number;
      steps: Array<{
        step_id: string;
        artifact_previews: Array<{ preview: string }>;
        primary_artifacts: Array<{ type: string; artifact_id?: string; artifact_status?: string }>;
      }>;
    };
    expect(userTimelineResult.redactions_applied).toBeGreaterThan(0);
    expect(userTimeline.stdout.includes("secret-token")).toBe(false);

    const internalTimeline = await runCliProcess(["--json", "timeline", run.run_id, "internal"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(internalTimeline.code).toBe(0);
    const internalTimelineResult = JSON.parse(internalTimeline.stdout) as {
      redactions_applied: number;
      steps: Array<{
        step_id: string;
        artifact_previews: Array<{ preview: string }>;
        primary_artifacts: Array<{ type: string; artifact_id?: string; artifact_status?: string }>;
      }>;
    };
    expect(internalTimelineResult.redactions_applied).toBeLessThan(userTimelineResult.redactions_applied);
    expect(internalTimeline.stdout.includes("secret-token")).toBe(true);

    const artifactStep = internalTimelineResult.steps.find((step) =>
      step.primary_artifacts.some((artifact) => artifact.type === "stdout" && typeof artifact.artifact_id === "string"),
    );
    expect(artifactStep).toBeDefined();
    const artifactId = artifactStep?.primary_artifacts.find(
      (artifact) => artifact.type === "stdout" && typeof artifact.artifact_id === "string",
    )?.artifact_id as string;

    const deniedArtifact = await runCliProcess(["artifact", artifactId], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(deniedArtifact.code).toBe(1);
    expect(deniedArtifact.stdout).toBe("");
    expect(deniedArtifact.stderr).toContain("No artifact found");

    const internalArtifact = await runCliProcess(["--json", "artifact", artifactId, "internal"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(internalArtifact.code).toBe(0);
    const artifactResult = JSON.parse(internalArtifact.stdout) as {
      artifact_status: string;
      visibility_scope: string;
      content_available: boolean;
      content: string;
    };
    expect(artifactResult.artifact_status).toBe("available");
    expect(artifactResult.visibility_scope).toBe("internal");
    expect(artifactResult.content_available).toBe(true);
    expect(artifactResult.content).toContain("Bearer secret-token");

    const helperUser = await runCliProcess(
      ["--json", "helper", run.run_id, "step_details", artifactStep?.step_id as string],
      {
        workspaceRoot: harness.workspaceRoot,
        socketPath: harness.socketPath,
      },
    );
    expect(helperUser.code).toBe(0);
    const helperUserResult = JSON.parse(helperUser.stdout) as {
      redactions_applied: number;
      answer: string;
      uncertainty: string[];
    };
    expect(helperUserResult.redactions_applied).toBeGreaterThan(0);
    expect(helperUserResult.answer.includes("secret-token")).toBe(false);
    expect(helperUserResult.uncertainty.some((entry) => entry.includes("redacted"))).toBe(true);
  });

  it("denies pending approvals through the built CLI binary without executing side effects", async () => {
    const harness = await createHarness();

    const registerRun = await runCliProcess(["--json", "register-run", "cli-deny-flow"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(registerRun.code).toBe(0);
    const run = JSON.parse(registerRun.stdout) as { run_id: string };

    const submit = await runCliProcess(
      ["--json", "submit-shell", run.run_id, process.execPath, "-e", "process.stdout.write('should-not-run')"],
      {
        workspaceRoot: harness.workspaceRoot,
        socketPath: harness.socketPath,
      },
    );
    expect(submit.code).toBe(0);
    const submitResult = JSON.parse(submit.stdout) as {
      approval_request: { approval_id: string; status: string } | null;
      execution_result: unknown;
    };
    expect(submitResult.approval_request?.status).toBe("pending");
    expect(submitResult.execution_result).toBeNull();
    const approvalId = submitResult.approval_request?.approval_id as string;

    const deny = await runCliProcess(["--json", "deny", approvalId, "cli denied"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(deny.code).toBe(0);
    const denyResult = JSON.parse(deny.stdout) as {
      approval_request: {
        status: string;
        resolution_note: string | null;
      };
      execution_result: unknown;
    };
    expect(denyResult.approval_request.status).toBe("denied");
    expect(denyResult.approval_request.resolution_note).toBe("cli denied");
    expect(denyResult.execution_result).toBeNull();

    const deniedApprovals = await runCliProcess(["--json", "list-approvals", run.run_id, "denied"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(deniedApprovals.code).toBe(0);
    const deniedApprovalsResult = JSON.parse(deniedApprovals.stdout) as {
      approvals: Array<{ approval_id: string; status: string; resolution_note: string | null }>;
    };
    expect(deniedApprovalsResult.approvals[0]?.approval_id).toBe(approvalId);
    expect(deniedApprovalsResult.approvals[0]?.status).toBe("denied");
    expect(deniedApprovalsResult.approvals[0]?.resolution_note).toBe("cli denied");
  });

  it("exports full artifact content without truncation through the built CLI binary", async () => {
    const harness = await createHarness();
    const sourcePath = path.join(harness.workspaceRoot, "artifact-export-source.txt");
    const exportPath = path.join(harness.workspaceRoot, "exports", "artifact-exported.txt");
    const longContent = `${"artifact-export-content-".repeat(500)}tail-marker`;
    fs.writeFileSync(sourcePath, longContent, "utf8");

    const registerRun = await runCliProcess(["--json", "register-run", "cli-artifact-export"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(registerRun.code).toBe(0);
    const run = JSON.parse(registerRun.stdout) as { run_id: string };

    const catFile = await runCliProcess(["--json", "submit-shell", run.run_id, "cat", sourcePath], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(catFile.code).toBe(0);

    const internalTimeline = await runCliProcess(["--json", "timeline", run.run_id, "internal"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(internalTimeline.code).toBe(0);
    const internalTimelineResult = JSON.parse(internalTimeline.stdout) as {
      steps: Array<{
        primary_artifacts: Array<{ type: string; artifact_id?: string }>;
      }>;
    };
    const artifactId = internalTimelineResult.steps
      .flatMap((step) => step.primary_artifacts)
      .find((artifact) => artifact.type === "stdout" && typeof artifact.artifact_id === "string")?.artifact_id as
      | string
      | undefined;
    expect(artifactId).toBeTruthy();

    const truncatedArtifact = await runCliProcess(["--json", "artifact", artifactId as string, "internal"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(truncatedArtifact.code).toBe(0);
    const truncatedArtifactResult = JSON.parse(truncatedArtifact.stdout) as {
      content: string;
      content_truncated: boolean;
    };
    expect(truncatedArtifactResult.content_truncated).toBe(true);
    expect(truncatedArtifactResult.content.length).toBeLessThan(longContent.length);

    const exported = await runCliProcess(["--json", "artifact-export", artifactId as string, exportPath, "internal"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    if (exported.code !== 0) {
      throw new Error(exported.stderr || exported.stdout || "artifact-export failed");
    }
    expect(exported.stderr).toBe("");
    const exportResult = JSON.parse(exported.stdout) as {
      artifact_id: string;
      output_path: string;
      bytes_written: number;
      visibility_scope: string;
      artifact_status: string;
    };
    expect(exportResult.artifact_id).toBe(artifactId);
    expect(exportResult.output_path).toBe(exportPath);
    expect(exportResult.bytes_written).toBe(Buffer.byteLength(longContent, "utf8"));
    expect(exportResult.visibility_scope).toBe("internal");
    expect(exportResult.artifact_status).toBe("available");
    expect(fs.readFileSync(exportPath, "utf8")).toBe(longContent);

    const overwriteRejected = await runCliProcess(["artifact-export", artifactId as string, exportPath, "internal"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(overwriteRejected.code).toBe(1);
    expect(overwriteRejected.stdout).toBe("");
    expect(overwriteRejected.stderr).toContain("refuses to overwrite existing file");
  });

  it("exports a full run audit bundle through the built CLI binary", async () => {
    const harness = await createHarness();
    const sourcePath = path.join(harness.workspaceRoot, "audit-bundle-source.txt");
    const outputDir = path.join(harness.workspaceRoot, "audit-bundle");
    fs.writeFileSync(sourcePath, "audit bundle content", "utf8");

    const registerRun = await runCliProcess(["--json", "register-run", "cli-audit-bundle"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(registerRun.code).toBe(0);
    const run = JSON.parse(registerRun.stdout) as { run_id: string };

    const submitShell = await runCliProcess(["--json", "submit-shell", run.run_id, "cat", sourcePath], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(submitShell.code).toBe(0);

    const auditExport = await runCliProcess(["--json", "run-audit-export", run.run_id, outputDir, "internal"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(auditExport.code).toBe(0);
    expect(auditExport.stderr).toBe("");
    const auditResult = JSON.parse(auditExport.stdout) as {
      run_id: string;
      output_dir: string;
      visibility_scope: string;
      files_written: string[];
      exported_artifacts: Array<{ artifact_id: string; output_path: string }>;
      skipped_artifacts: Array<unknown>;
    };
    expect(auditResult.run_id).toBe(run.run_id);
    expect(auditResult.output_dir).toBe(outputDir);
    expect(auditResult.visibility_scope).toBe("internal");
    expect(auditResult.files_written.some((file) => file.endsWith("manifest.json"))).toBe(true);
    expect(auditResult.files_written.some((file) => file.endsWith("timeline.txt"))).toBe(true);
    expect(auditResult.exported_artifacts.length).toBeGreaterThan(0);
    expect(auditResult.skipped_artifacts).toHaveLength(0);

    const manifestPath = path.join(outputDir, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      run_id: string;
      exported_artifacts: Array<{ artifact_id: string; output_path: string }>;
      skipped_artifacts: Array<unknown>;
    };
    expect(manifest.run_id).toBe(run.run_id);
    expect(manifest.exported_artifacts.length).toBeGreaterThan(0);
    expect(manifest.skipped_artifacts).toHaveLength(0);

    const exportedArtifactPath = manifest.exported_artifacts.find((artifact) =>
      artifact.output_path.includes(path.join("artifacts", "")),
    )?.output_path as string | undefined;
    expect(exportedArtifactPath).toBeTruthy();
    expect(fs.readFileSync(exportedArtifactPath as string, "utf8")).toBe("audit bundle content");

    const summaryText = fs.readFileSync(path.join(outputDir, "run-summary.txt"), "utf8");
    const timelineText = fs.readFileSync(path.join(outputDir, "timeline.txt"), "utf8");
    expect(summaryText).toContain(`Run: ${run.run_id}`);
    expect(timelineText).toContain(`Timeline for ${run.run_id}`);

    const overwriteRejected = await runCliProcess(["run-audit-export", run.run_id, outputDir, "internal"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(overwriteRejected.code).toBe(1);
    expect(overwriteRejected.stderr).toContain("refuses to overwrite existing path");
  });

  it("verifies and detects tampering in a built CLI run audit bundle", async () => {
    const harness = await createHarness();
    const sourcePath = path.join(harness.workspaceRoot, "audit-verify-source.txt");
    const outputDir = path.join(harness.workspaceRoot, "audit-verify-bundle");
    fs.writeFileSync(sourcePath, "audit verify content", "utf8");

    const registerRun = await runCliProcess(["--json", "register-run", "cli-audit-verify"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(registerRun.code).toBe(0);
    const run = JSON.parse(registerRun.stdout) as { run_id: string };

    const submitShell = await runCliProcess(["--json", "submit-shell", run.run_id, "cat", sourcePath], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(submitShell.code).toBe(0);

    const exportBundle = await runCliProcess(["--json", "run-audit-export", run.run_id, outputDir, "internal"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(exportBundle.code).toBe(0);

    const verified = await runCliProcess(["--json", "run-audit-verify", outputDir], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(verified.code).toBe(0);
    const verifiedResult = JSON.parse(verified.stdout) as {
      run_id: string;
      verified: boolean;
      issues: Array<{ code: string }>;
    };
    expect(verifiedResult.run_id).toBe(run.run_id);
    expect(verifiedResult.verified).toBe(true);
    expect(verifiedResult.issues).toHaveLength(0);

    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "manifest.json"), "utf8")) as {
      exported_artifacts: Array<{ output_path: string }>;
    };
    const exportedArtifactPath = manifest.exported_artifacts[0]?.output_path as string;
    expect(exportedArtifactPath).toBeTruthy();
    fs.writeFileSync(exportedArtifactPath, "tampered audit verify content", "utf8");

    const tampered = await runCliProcess(["--json", "run-audit-verify", outputDir], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(tampered.code).toBe(1);
    const tamperedResult = JSON.parse(tampered.stdout) as {
      verified: boolean;
      issues: Array<{ code: string; artifact_id?: string }>;
    };
    expect(tamperedResult.verified).toBe(false);
    expect(tamperedResult.issues.some((issue) => issue.code === "ARTIFACT_SHA256_MISMATCH")).toBe(true);
    expect(tamperedResult.issues.some((issue) => issue.code === "ARTIFACT_INTEGRITY_MISMATCH")).toBe(true);
  });
});
