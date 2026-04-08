import { execFileSync, spawn } from "node:child_process";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { McpServer } from "../../../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js";
import { StreamableHTTPServerTransport } from "../../../node_modules/.pnpm/node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js";
import { z } from "../../../node_modules/.pnpm/node_modules/zod/index.js";

import { AuthorityClient, AuthorityDaemonResponseError } from "@agentgit/authority-sdk";

import { startServer } from "../../authority-daemon/src/server.ts";
import { CLI_EXIT_CODES, CLI_JSON_CONTRACT_VERSION } from "./cli-contract.js";
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
const OCI_TEST_IMAGE_ROOT = decodeURIComponent(
  new URL("../../execution-adapters/src/oci-test-image", import.meta.url).pathname,
);
const ORIGINAL_AGENTGIT_ROOT = process.env.AGENTGIT_ROOT;
const ORIGINAL_INIT_CWD = process.env.INIT_CWD;
const FALLBACK_TEST_PINNED_OCI_IMAGE =
  "docker.io/library/node@sha256:1111111111111111111111111111111111111111111111111111111111111111";
const SAFE_CHILD_PROCESS_ENV_KEYS = [
  "CI",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "SHELL",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
] as const;

function createSanitizedChildProcessEnv(
  runtimeEnv: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const key of SAFE_CHILD_PROCESS_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === "string") {
      sanitized[key] = value;
    }
  }

  for (const [key, value] of Object.entries(process.env)) {
    if ((key.startsWith("AGENTGIT_") || key === "INIT_CWD") && typeof value === "string") {
      sanitized[key] = value;
    }
  }

  return {
    ...sanitized,
    ...runtimeEnv,
    ...overrides,
  };
}
const TEST_OCI_BUILD_IMAGE = `agentgit/authority-cli-stdio:${process.pid}`;

function pnpmCommand(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function detectOciSandbox(): { runtime: "docker" | "podman"; image: string } | null {
  for (const runtime of ["docker", "podman"] as const) {
    try {
      execFileSync(runtime, ["info"], {
        stdio: "ignore",
      });
      const inspectOutput = execFileSync(runtime, ["image", "inspect", "node:22-bookworm-slim"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const parsed = JSON.parse(inspectOutput) as Array<{ RepoDigests?: string[] }>;
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

function buildSandboxedStdioServerDefinition(serverId: string): Record<string, unknown> {
  return {
    server_id: serverId,
    transport: "stdio",
    command: "node",
    args: ["/agentgit-test/mcp-test-server.mjs"],
    sandbox: {
      type: "oci_container",
      ...(TEST_OCI_SANDBOX ? { runtime: TEST_OCI_SANDBOX.runtime } : { runtime: "docker" }),
      image: TEST_OCI_SANDBOX ? TEST_OCI_BUILD_IMAGE : FALLBACK_TEST_PINNED_OCI_IMAGE,
      ...(TEST_OCI_SANDBOX
        ? {
            build: {
              context_path: OCI_TEST_IMAGE_ROOT,
              dockerfile_path: path.join(OCI_TEST_IMAGE_ROOT, "Dockerfile"),
              rebuild_policy: "if_missing",
            },
          }
        : {
            allowed_registries: ["docker.io"],
            signature_verification: {
              mode: "cosign_keyless",
              certificate_identity:
                "https://github.com/agentgit/agentgit/.github/workflows/release.yml@refs/heads/main",
              certificate_oidc_issuer: "https://token.actions.githubusercontent.com",
            },
          }),
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
    workspaceRootPath: workspaceRoot,
    policyGlobalConfigPath: path.join(root, ".config", "agentgit", "authority-policy.toml"),
    policyWorkspaceConfigPath: path.join(workspaceRoot, ".agentgit", "policy.toml"),
    policyCalibrationConfigPath: path.join(workspaceRoot, ".agentgit", "policy.calibration.generated.json"),
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
      'description = "Require approval for shell execution in CLI approval-path tests."',
      'rationale = "CLI approval-path tests should exercise the explicit exception lane, not default recoverable automation."',
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

async function restartHarness(harness: CliHarness): Promise<void> {
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

  harness.server = await startServer({
    socketPath: harness.socketPath,
    journalPath: harness.journalPath,
    snapshotRootPath: harness.snapshotRootPath,
    workspaceRootPath: harness.workspaceRoot,
    policyGlobalConfigPath: path.join(harness.root, ".config", "agentgit", "authority-policy.toml"),
    policyWorkspaceConfigPath: path.join(harness.workspaceRoot, ".agentgit", "policy.toml"),
    policyCalibrationConfigPath: path.join(harness.workspaceRoot, ".agentgit", "policy.calibration.generated.json"),
  });
}

async function startMcpHttpService(
  options: {
    requireBearerTokenForToolCallsOnly?: string;
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
    if (
      options.requireBearerTokenForToolCallsOnly !== undefined &&
      parsedBody?.method === "tools/call" &&
      req.headers.authorization !== `Bearer ${options.requireBearerTokenForToolCallsOnly}`
    ) {
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
      name: "agentgit-cli-test-http-mcp-server",
      version: "1.0.0",
    });
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
      async ({ note }) => ({
        content: [{ type: "text", text: `http-echo:${note}` }],
        structuredContent: { echoed_note: note },
      }),
    );

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

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("MCP HTTP service did not start with a TCP address.");
  }

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
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
    },
  };
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
    env?: NodeJS.ProcessEnv;
    useDefaultRuntimeEnv?: boolean;
    stdinText?: string;
  },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const runtimeEnv =
      options.useDefaultRuntimeEnv === false
        ? {}
        : {
            AGENTGIT_ROOT: options.workspaceRoot,
            INIT_CWD: options.workspaceRoot,
            AGENTGIT_SOCKET_PATH: options.socketPath,
          };
    const child = spawn(process.execPath, [CLI_DIST_ENTRY, ...argv], {
      cwd: options.workspaceRoot,
      env: createSanitizedChildProcessEnv(runtimeEnv, options.env ?? {}),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    if (typeof options.stdinText === "string") {
      child.stdin.write(options.stdinText);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
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

async function waitForSocketPath(socketPath: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for socket ${socketPath}`);
}

beforeAll(() => {
  for (const filter of [
    "@agentgit/schemas",
    "@agentgit/authority-sdk",
    "@agentgit/authority-daemon",
    "@agentgit/credential-broker",
    "@agentgit/execution-adapters",
    "@agentgit/authority-cli",
  ]) {
    execFileSync(pnpmCommand(), ["--filter", filter, "build"], {
      cwd: CLI_PACKAGE_ROOT,
      stdio: "pipe",
      env: process.env,
    });
  }
}, 120_000);

afterEach(async () => {
  while (harnesses.length > 0) {
    await closeHarness(harnesses.pop()!);
  }

  process.exitCode = 0;
});

describe("authority cli MCP integration", () => {
  it("reports CLI version and contract info through the built CLI binary", async () => {
    const harness = await createHarness();

    const version = await runCliProcess(["--json", "version"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });

    expect(version.code).toBe(0);
    expect(version.stderr).toBe("");
    const result = JSON.parse(version.stdout) as {
      cli_version: string;
      supported_api_version: string;
      json_contract_version: string;
      exit_code_registry_version: string;
      config_schema_version: string;
    };
    expect(result.cli_version).toBeTruthy();
    expect(result.supported_api_version).toBe("authority.v1");
    expect(result.json_contract_version).toBe(CLI_JSON_CONTRACT_VERSION);
    expect(result.exit_code_registry_version).toBe("agentgit.cli.exit-codes.v1");
    expect(result.config_schema_version).toBe("agentgit.cli.config.v1");
  });

  it("manages CLI profiles and resolves effective config through the built CLI binary", async () => {
    const harness = await createHarness();
    const configRoot = path.join(harness.root, "cli-config-root");

    const profileUpsert = await runCliProcess(
      [
        "--config-root",
        configRoot,
        "profile",
        "upsert",
        "ops",
        "--socket-path",
        harness.socketPath,
        "--workspace-root",
        harness.workspaceRoot,
        "--connect-timeout-ms",
        "2500",
        "--response-timeout-ms",
        "12000",
        "--max-connect-retries",
        "0",
        "--connect-retry-delay-ms",
        "5",
      ],
      {
        workspaceRoot: harness.workspaceRoot,
        socketPath: harness.socketPath,
        useDefaultRuntimeEnv: false,
        env: {
          AGENTGIT_ROOT: "",
          INIT_CWD: "",
          AGENTGIT_SOCKET_PATH: "",
        },
      },
    );
    expect(profileUpsert.code).toBe(0);

    const profileUse = await runCliProcess(["--config-root", configRoot, "profile", "use", "ops"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
      useDefaultRuntimeEnv: false,
      env: {
        AGENTGIT_ROOT: "",
        INIT_CWD: "",
        AGENTGIT_SOCKET_PATH: "",
      },
    });
    expect(profileUse.code).toBe(0);

    const profileList = await runCliProcess(["--json", "--config-root", configRoot, "profile", "list"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
      useDefaultRuntimeEnv: false,
      env: {
        AGENTGIT_ROOT: "",
        INIT_CWD: "",
        AGENTGIT_SOCKET_PATH: "",
      },
    });
    expect(profileList.code).toBe(0);
    const profileListResult = JSON.parse(profileList.stdout) as {
      active_profile: string | null;
      profiles: Array<{ name: string; active: boolean; source: string }>;
    };
    expect(profileListResult.active_profile).toBe("ops");
    expect(profileListResult.profiles).toContainEqual(
      expect.objectContaining({
        name: "ops",
        active: true,
        source: "user",
      }),
    );

    const configShow = await runCliProcess(["--json", "--config-root", configRoot, "config", "show"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
      useDefaultRuntimeEnv: false,
      env: {
        AGENTGIT_ROOT: "",
        INIT_CWD: "",
        AGENTGIT_SOCKET_PATH: "",
      },
    });
    expect(configShow.code).toBe(0);
    const configShowResult = JSON.parse(configShow.stdout) as {
      resolved: {
        active_profile: string | null;
        socket_path: { value: string; source: string };
        workspace_root: { value: string; source: string };
        connect_timeout_ms: { value: number; source: string };
        response_timeout_ms: { value: number; source: string };
        max_connect_retries: { value: number; source: string };
        connect_retry_delay_ms: { value: number; source: string };
      };
    };
    expect(configShowResult.resolved.active_profile).toBe("ops");
    expect(configShowResult.resolved.socket_path).toEqual({
      value: harness.socketPath,
      source: "user_profile:ops",
    });
    expect(configShowResult.resolved.workspace_root).toEqual({
      value: harness.workspaceRoot,
      source: "user_profile:ops",
    });
    expect(configShowResult.resolved.connect_timeout_ms.value).toBe(2500);
    expect(configShowResult.resolved.response_timeout_ms.value).toBe(12000);
    expect(configShowResult.resolved.max_connect_retries.value).toBe(0);
    expect(configShowResult.resolved.connect_retry_delay_ms.value).toBe(5);

    const ping = await runCliProcess(["--json", "--config-root", configRoot, "ping"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
      useDefaultRuntimeEnv: false,
      env: {
        AGENTGIT_ROOT: "",
        INIT_CWD: "",
        AGENTGIT_SOCKET_PATH: "",
      },
    });
    expect(ping.code).toBe(0);
    const pingResult = JSON.parse(ping.stdout) as {
      accepted_api_version: string;
      runtime_version: string;
    };
    expect(pingResult.accepted_api_version).toBe("authority.v1");
    expect(pingResult.runtime_version).toBeTruthy();
  });

  it("initializes a production profile through the built CLI binary", async () => {
    const harness = await createHarness();
    const configRoot = path.join(harness.root, "init-config-root");

    const initResult = await runCliProcess(
      [
        "--json",
        "--config-root",
        configRoot,
        "--workspace-root",
        harness.workspaceRoot,
        "--socket-path",
        harness.socketPath,
        "init",
        "--production",
        "--profile-name",
        "prod",
      ],
      {
        workspaceRoot: harness.workspaceRoot,
        socketPath: harness.socketPath,
      },
    );
    expect(initResult.code).toBe(0);
    expect(initResult.stderr).toBe("");
    const parsedInit = JSON.parse(initResult.stdout) as {
      mode: string;
      profile_name: string;
      readiness_passed: boolean;
      doctor: {
        daemon: {
          reachable: boolean;
        };
      };
    };
    expect(parsedInit.mode).toBe("production");
    expect(parsedInit.profile_name).toBe("prod");
    expect(parsedInit.readiness_passed).toBe(true);
    expect(parsedInit.doctor.daemon.reachable).toBe(true);

    const configPath = path.join(configRoot, "authority-cli.toml");
    expect(fs.existsSync(configPath)).toBe(true);
    const configText = fs.readFileSync(configPath, "utf8");
    expect(configText).toContain('active_profile = "prod"');
    expect(configText).toContain("[profiles.prod]");

    const configShow = await runCliProcess(["--json", "--config-root", configRoot, "config", "show"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
      useDefaultRuntimeEnv: false,
      env: {
        AGENTGIT_ROOT: "",
        INIT_CWD: "",
        AGENTGIT_SOCKET_PATH: "",
      },
    });
    expect(configShow.code).toBe(0);
    const configShowResult = JSON.parse(configShow.stdout) as {
      resolved: {
        active_profile: string | null;
        socket_path: { value: string };
      };
    };
    expect(configShowResult.resolved.active_profile).toBe("prod");
    expect(configShowResult.resolved.socket_path.value).toBe(harness.socketPath);
  });

  it("runs setup and starts the packaged daemon through the built CLI binary", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cli-setup-it-"));
    const workspaceRoot = path.join(root, "workspace");
    const configRoot = path.join(root, "config-root");
    const stateRoot = path.join(root, "state");
    const socketPath = path.join(stateRoot, "authority.sock");
    const journalPath = path.join(stateRoot, "authority.db");
    const snapshotRootPath = path.join(stateRoot, "snapshots");
    const mcpRegistryPath = path.join(stateRoot, "mcp-registry.db");
    const mcpSecretStorePath = path.join(stateRoot, "mcp-secrets.db");
    const mcpHostPolicyPath = path.join(stateRoot, "mcp-hosts.db");
    const mcpConcurrencyLeasePath = path.join(stateRoot, "mcp-leases.db");

    fs.mkdirSync(workspaceRoot, { recursive: true });

    try {
      const setup = await runCliProcess(
        [
          "--json",
          "--config-root",
          configRoot,
          "--workspace-root",
          workspaceRoot,
          "--socket-path",
          socketPath,
          "setup",
          "--profile-name",
          "local-it",
        ],
        {
          workspaceRoot,
          socketPath,
          useDefaultRuntimeEnv: false,
          env: {
            AGENTGIT_ROOT: "",
            INIT_CWD: "",
            AGENTGIT_SOCKET_PATH: "",
          },
        },
      );
      expect(setup.code).toBe(0);
      expect(JSON.parse(setup.stdout)).toEqual(
        expect.objectContaining({
          profile_name: "local-it",
          workspace_root: workspaceRoot,
          socket_path: socketPath,
        }),
      );

      const daemon = spawn(
        process.execPath,
        [CLI_DIST_ENTRY, "--json", "--config-root", configRoot, "daemon", "start"],
        {
          cwd: workspaceRoot,
          env: {
            ...process.env,
            AGENTGIT_ROOT: "",
            INIT_CWD: "",
            AGENTGIT_SOCKET_PATH: "",
            AGENTGIT_JOURNAL_PATH: journalPath,
            AGENTGIT_SNAPSHOT_ROOT: snapshotRootPath,
            AGENTGIT_MCP_REGISTRY_PATH: mcpRegistryPath,
            AGENTGIT_MCP_SECRET_STORE_PATH: mcpSecretStorePath,
            AGENTGIT_MCP_HOST_POLICY_PATH: mcpHostPolicyPath,
            AGENTGIT_MCP_CONCURRENCY_LEASE_PATH: mcpConcurrencyLeasePath,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let daemonStdout = "";
      let daemonStderr = "";
      daemon.stdout.on("data", (chunk) => {
        daemonStdout += chunk.toString("utf8");
      });
      daemon.stderr.on("data", (chunk) => {
        daemonStderr += chunk.toString("utf8");
      });

      try {
        await waitForSocketPath(socketPath);

        const doctor = await runCliProcess(["--json", "--config-root", configRoot, "doctor"], {
          workspaceRoot,
          socketPath,
          useDefaultRuntimeEnv: false,
          env: {
            AGENTGIT_ROOT: "",
            INIT_CWD: "",
            AGENTGIT_SOCKET_PATH: "",
          },
        });

        expect(doctor.code).toBe(0);
        expect(JSON.parse(doctor.stdout)).toEqual(
          expect.objectContaining({
            daemon: expect.objectContaining({
              reachable: true,
              accepted_api_version: "authority.v1",
            }),
          }),
        );
      } finally {
        if (daemon.exitCode === null && daemon.signalCode === null) {
          daemon.kill("SIGTERM");
          await new Promise((resolve) => daemon.once("close", resolve));
        }
      }

      expect(daemonStderr).toBe("");
      expect(daemonStdout).toContain('"status":"listening"');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("builds a trust report through the built CLI binary", async () => {
    const harness = await createHarness();

    const registerRun = await runCliProcess(["--json", "register-run", "cli-trust-report"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(registerRun.code).toBe(0);
    const run = JSON.parse(registerRun.stdout) as { run_id: string };

    const trustReport = await runCliProcess(["--json", "trust-report", "--run-id", run.run_id], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(trustReport.code).toBe(0);
    expect(trustReport.stderr).toBe("");
    const parsedReport = JSON.parse(trustReport.stdout) as {
      workspace_root: string;
      daemon: { reachable: boolean };
      security_posture_status: "healthy" | "degraded" | "unknown";
      mcp: {
        profile_count: number;
      };
      timeline_trust: null | { run_id: string };
    };
    expect(parsedReport.workspace_root).toBe(harness.workspaceRoot);
    expect(parsedReport.daemon.reachable).toBe(true);
    expect(parsedReport.security_posture_status).toMatch(/^(healthy|degraded|unknown)$/);
    expect(parsedReport.mcp.profile_count).toBeGreaterThanOrEqual(0);
    expect(parsedReport.timeline_trust?.run_id).toBe(run.run_id);
  });

  it("runs MCP onboarding workflow through the built CLI binary against a live daemon", async () => {
    const harness = await createHarness();
    const onboardingPlanPath = path.join(harness.workspaceRoot, "onboard-plan.json");
    fs.writeFileSync(
      onboardingPlanPath,
      JSON.stringify(
        {
          secrets: [
            {
              secret_id: "onboard_secret",
              display_name: "Onboard Secret",
              bearer_token: "onboard-secret-token",
            },
          ],
          host_policies: [
            {
              host: "api.onboard.test",
              display_name: "Onboard API",
              allow_subdomains: false,
              allowed_ports: [443],
            },
          ],
          server: {
            server_id: "onboard_public",
            display_name: "Onboard Public MCP",
            transport: "streamable_http",
            url: "https://api.onboard.test/mcp",
            network_scope: "public_https",
            auth: {
              type: "bearer_secret_ref",
              secret_id: "onboard_secret",
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
        null,
        2,
      ),
      "utf8",
    );

    const onboard = await runCliProcess(["--json", "onboard-mcp", onboardingPlanPath], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(onboard.code).toBe(0);
    expect(onboard.stderr).toBe("");
    const onboardResult = JSON.parse(onboard.stdout) as {
      server: { server_id: string; created: boolean };
      secrets: Array<{ secret_id: string }>;
      host_policies: Array<{ host: string }>;
    };
    expect(onboardResult.server.server_id).toBe("onboard_public");
    expect(onboardResult.server.created).toBe(true);
    expect(onboardResult.secrets).toContainEqual(
      expect.objectContaining({
        secret_id: "onboard_secret",
      }),
    );
    expect(onboardResult.host_policies).toContainEqual(
      expect.objectContaining({
        host: "api.onboard.test",
      }),
    );

    const listServers = await runCliProcess(["--json", "list-mcp-servers"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(listServers.code).toBe(0);
    const serversResult = JSON.parse(listServers.stdout) as {
      servers: Array<{ server: { server_id: string } }>;
    };
    expect(serversResult.servers).toContainEqual(
      expect.objectContaining({
        server: expect.objectContaining({
          server_id: "onboard_public",
        }),
      }),
    );
  });

  it("runs MCP trust review workflow through the built CLI binary against a live daemon", async () => {
    const harness = await createHarness();
    const remoteService = await startMcpHttpService({
      requireBearerTokenForToolCallsOnly: "phase3-secret-token",
    });
    const trustReviewPlanPath = path.join(harness.workspaceRoot, "trust-review-plan.json");

    try {
      fs.writeFileSync(
        trustReviewPlanPath,
        JSON.stringify(
          {
            secrets: [
              {
                secret_id: "phase3_remote_secret",
                display_name: "Phase 3 remote secret",
                bearer_token: "phase3-secret-token",
              },
            ],
            candidate: {
              source_kind: "user_input",
              raw_endpoint: remoteService.url,
              transport_hint: "streamable_http",
              notes: "Phase 3 trust review workflow",
            },
            resolve: {
              display_name: "Phase 3 Remote MCP",
            },
            approval: {
              decision: "allow_policy_managed",
              trust_tier: "operator_approved_public",
              allowed_execution_modes: ["local_proxy"],
              reason_codes: ["INITIAL_REVIEW_COMPLETE"],
            },
            credential_binding: {
              binding_mode: "bearer_secret_ref",
              broker_profile_id: "phase3_remote_secret",
              scope_labels: ["remote:mcp"],
            },
            smoke_test: {
              tool_name: "echo_note",
              arguments: {
                note: "phase3 launch check",
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      const trustReview = await runCliProcess(["--json", "trust-review-mcp", trustReviewPlanPath], {
        workspaceRoot: harness.workspaceRoot,
        socketPath: harness.socketPath,
      });
      expect(trustReview.code).toBe(0);
      expect(trustReview.stderr).toBe("");
      const trustReviewResult = JSON.parse(trustReview.stdout) as {
        candidate_submission: { candidate_id: string } | null;
        resolution: { profile_id: string; canonical_endpoint: string; network_scope: string };
        trust_decision: { trust_decision_id: string; decision: string; profile_status: string };
        credential_binding: { credential_binding_id: string; status: string } | null;
        activation: { attempted: true; profile_status: string } | null;
        smoke_test: { success: boolean; mode: string | null; summary: string | null } | null;
        review: {
          profile: { status: string } | null;
          active_trust_decision: { trust_decision_id: string } | null;
          active_credential_binding: { credential_binding_id: string } | null;
          review: { executable: boolean; requires_credentials: boolean; requires_approval: boolean };
        };
      };
      expect(trustReviewResult.candidate_submission?.candidate_id).toMatch(/^mcpcand_/u);
      expect(trustReviewResult.resolution.canonical_endpoint).toBe(remoteService.url);
      expect(trustReviewResult.resolution.network_scope).toBe("loopback");
      expect(trustReviewResult.trust_decision.decision).toBe("allow_policy_managed");
      expect(trustReviewResult.trust_decision.profile_status).toBe("pending_approval");
      expect(trustReviewResult.credential_binding?.status).toBe("active");
      expect(trustReviewResult.activation?.attempted).toBe(true);
      expect(trustReviewResult.activation?.profile_status).toBe("active");
      expect(trustReviewResult.smoke_test?.success).toBe(true);
      expect(trustReviewResult.smoke_test?.mode).toBe("executed");
      expect(trustReviewResult.smoke_test?.summary).toContain("echoed_note");
      expect(trustReviewResult.review.profile?.status).toBe("active");
      expect(trustReviewResult.review.active_trust_decision?.trust_decision_id).toBe(
        trustReviewResult.trust_decision.trust_decision_id,
      );
      expect(trustReviewResult.review.active_credential_binding?.credential_binding_id).toBe(
        trustReviewResult.credential_binding?.credential_binding_id,
      );
      expect(trustReviewResult.review.review.executable).toBe(true);
      expect(trustReviewResult.review.review.requires_credentials).toBe(false);
      expect(trustReviewResult.review.review.requires_approval).toBe(false);

      const profiles = await runCliProcess(["--json", "list-mcp-server-profiles"], {
        workspaceRoot: harness.workspaceRoot,
        socketPath: harness.socketPath,
      });
      expect(profiles.code).toBe(0);
      const profilesResult = JSON.parse(profiles.stdout) as {
        profiles: Array<{ server_profile_id: string; status: string }>;
      };
      expect(profilesResult.profiles).toContainEqual(
        expect.objectContaining({
          server_profile_id: trustReviewResult.resolution.profile_id,
          status: "active",
        }),
      );
    } finally {
      await remoteService.close();
    }
  }, 20_000);

  it("verifies signed release artifacts through the built CLI binary", async () => {
    const harness = await createHarness();
    const artifactsDir = path.join(harness.workspaceRoot, "release-artifacts");
    fs.mkdirSync(artifactsDir, { recursive: true });

    const tarballPath = path.join(artifactsDir, "pkg.tgz");
    fs.writeFileSync(tarballPath, "release package payload", "utf8");
    const tarballSha = createHash("sha256").update(fs.readFileSync(tarballPath)).digest("hex");

    const manifestPath = path.join(artifactsDir, "manifest.json");
    const manifest = {
      packages: [
        {
          name: "@agentgit/example",
          tarball_path: tarballPath,
          sha256: tarballSha,
        },
      ],
    };
    const manifestJson = JSON.stringify(manifest, null, 2);
    fs.writeFileSync(manifestPath, manifestJson, "utf8");
    const manifestSha = createHash("sha256").update(manifestJson, "utf8").digest("hex");
    fs.writeFileSync(path.join(artifactsDir, "manifest.sha256"), `${manifestSha}  manifest.json\n`, "utf8");

    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const signature = createSign("sha256").update(manifestJson).end().sign(privateKey).toString("base64");
    fs.writeFileSync(path.join(artifactsDir, "manifest.sig"), `${signature}\n`, "utf8");
    const publicKeyPath = path.join(artifactsDir, "release-public.pem");
    fs.writeFileSync(publicKeyPath, publicKey.export({ format: "pem", type: "spki" }), "utf8");

    const verified = await runCliProcess(
      [
        "--json",
        "release-verify-artifacts",
        artifactsDir,
        "--signature-mode",
        "required",
        "--public-key-path",
        publicKeyPath,
      ],
      {
        workspaceRoot: harness.workspaceRoot,
        socketPath: harness.socketPath,
      },
    );
    expect(verified.code).toBe(0);
    expect(verified.stderr).toBe("");
    const verifiedResult = JSON.parse(verified.stdout) as {
      ok: boolean;
      signature_verified: boolean;
      packages: Array<{ name: string }>;
    };
    expect(verifiedResult.ok).toBe(true);
    expect(verifiedResult.signature_verified).toBe(true);
    expect(verifiedResult.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "@agentgit/example",
        }),
      ]),
    );
  });

  it("prints deferred cloud roadmap through the built CLI binary", async () => {
    const harness = await createHarness();

    const roadmap = await runCliProcess(["--json", "cloud-roadmap"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(roadmap.code).toBe(0);
    expect(roadmap.stderr).toBe("");
    const roadmapResult = JSON.parse(roadmap.stdout) as {
      launch_contract: string;
      phases: Array<{ phase_id: string; status: string }>;
    };
    expect(roadmapResult.launch_contract).toBe("local-first-mvp");
    expect(roadmapResult.phases.length).toBeGreaterThanOrEqual(3);
    expect(roadmapResult.phases.every((phase) => phase.status === "deferred")).toBe(true);
  });

  it("validates config files and reports doctor checks through the built CLI binary", async () => {
    const harness = await createHarness();
    const configRoot = path.join(harness.root, "doctor-config-root");

    const invalidConfigPath = path.join(configRoot, "authority-cli.toml");
    fs.mkdirSync(configRoot, { recursive: true });
    fs.writeFileSync(invalidConfigPath, 'schema_version = "agentgit.cli.config.v1"\nactive_profile = [', "utf8");

    const invalidValidation = await runCliProcess(["--json", "--config-root", configRoot, "config", "validate"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
      useDefaultRuntimeEnv: false,
      env: {
        AGENTGIT_ROOT: "",
        INIT_CWD: "",
        AGENTGIT_SOCKET_PATH: "",
      },
    });
    expect(invalidValidation.code).toBe(CLI_EXIT_CODES.CONFIG_ERROR);
    const invalidValidationResult = JSON.parse(invalidValidation.stdout) as {
      valid: boolean;
      issues: string[];
    };
    expect(invalidValidationResult.valid).toBe(false);
    expect(invalidValidationResult.issues.length).toBeGreaterThan(0);

    fs.writeFileSync(
      invalidConfigPath,
      [
        'schema_version = "agentgit.cli.config.v1"',
        'active_profile = "ops"',
        "",
        "[profiles.ops]",
        `socket_path = "${harness.socketPath}"`,
        `workspace_root = "${harness.workspaceRoot}"`,
        "connect_timeout_ms = 1000",
        "response_timeout_ms = 5000",
        "max_connect_retries = 0",
        "connect_retry_delay_ms = 25",
      ].join("\n"),
      "utf8",
    );

    const validValidation = await runCliProcess(["--json", "--config-root", configRoot, "config", "validate"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
      useDefaultRuntimeEnv: false,
      env: {
        AGENTGIT_ROOT: "",
        INIT_CWD: "",
        AGENTGIT_SOCKET_PATH: "",
      },
    });
    expect(validValidation.code).toBe(0);
    const validValidationResult = JSON.parse(validValidation.stdout) as { valid: boolean; issues: string[] };
    expect(validValidationResult.valid).toBe(true);
    expect(validValidationResult.issues).toHaveLength(0);

    const doctor = await runCliProcess(["--json", "--config-root", configRoot, "doctor"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
      useDefaultRuntimeEnv: false,
      env: {
        AGENTGIT_ROOT: "",
        INIT_CWD: "",
        AGENTGIT_SOCKET_PATH: "",
      },
    });
    expect(doctor.code).toBe(0);
    const doctorResult = JSON.parse(doctor.stdout) as {
      daemon: {
        reachable: boolean;
        accepted_api_version: string | null;
      };
      security_posture_status: "healthy" | "degraded" | "unknown";
      checks: Array<{ code: string; status: string; summary: string; details?: Record<string, unknown> }>;
      recommendations: string[];
    };
    expect(doctorResult.daemon.reachable).toBe(true);
    expect(doctorResult.daemon.accepted_api_version).toBe("authority.v1");
    expect(doctorResult.security_posture_status).toMatch(/^(healthy|degraded)$/);
    expect(doctorResult.checks.some((check) => check.code === "DAEMON_REACHABLE" && check.status === "pass")).toBe(
      true,
    );
    expect(
      doctorResult.checks.some(
        (check) =>
          check.code === "SECRET_STORAGE_MODE" &&
          check.status === "pass" &&
          check.summary.includes("local_encrypted_store"),
      ),
    ).toBe(true);
    if (process.platform === "darwin") {
      expect(
        doctorResult.checks.some(
          (check) => check.code === "SECRET_STORAGE_MODE" && check.details?.key_provider === "macos_keychain",
        ),
      ).toBe(true);
    }
    expect(doctorResult.recommendations.length).toBeGreaterThan(0);
  });

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
    if (!TEST_OCI_SANDBOX) {
      return;
    }

    const harness = await createHarness();
    const client = new AuthorityClient({
      socketPath: harness.socketPath,
      connectTimeoutMs: 250,
      responseTimeoutMs: 10_000,
      maxConnectRetries: 0,
    });

    const run = await captureCliJson<{ run_id: string }>(
      ["register-run", "cli-mcp-e2e"],
      client,
      harness.workspaceRoot,
    );

    await captureCliRun(
      [
        "upsert-mcp-server",
        JSON.stringify({
          ...buildSandboxedStdioServerDefinition("notes_stdio"),
          display_name: "Notes stdio MCP",
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
    if (!TEST_OCI_SANDBOX) {
      return;
    }

    const harness = await createHarness();
    const serverDefinitionPath = path.join(harness.root, "notes_stdio.json");
    const toolArgumentsPath = path.join(harness.root, "echo_note_args.json");

    fs.writeFileSync(
      serverDefinitionPath,
      JSON.stringify({
        ...buildSandboxedStdioServerDefinition("notes_stdio_process"),
        display_name: "Notes stdio MCP process test",
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
        (record) => record.server.server_id === "notes_stdio_process" && record.server.transport === "stdio",
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
    expect(rejected.code).toBe(CLI_EXIT_CODES.UNAVAILABLE);
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

  it("stores MCP secrets safely from file and stdin through the built CLI binary", async () => {
    const harness = await createHarness();
    const tokenPath = path.join(harness.root, "safe-token.txt");
    fs.writeFileSync(tokenPath, "safe-token-file", "utf8");

    const storedFromFile = await runCliProcess(
      [
        "--json",
        "upsert-mcp-secret",
        "--secret-id",
        "safe_secret",
        "--display-name",
        "Safe secret",
        "--expires-at",
        "2030-01-01T00:00:00.000Z",
        "--bearer-token-file",
        tokenPath,
      ],
      {
        workspaceRoot: harness.workspaceRoot,
        socketPath: harness.socketPath,
      },
    );
    expect(storedFromFile.code).toBe(0);
    expect(storedFromFile.stderr).toBe("");
    expect(storedFromFile.stdout).not.toContain("safe-token-file");
    const storedFileResult = JSON.parse(storedFromFile.stdout) as {
      secret: {
        secret_id: string;
        version: number;
        expires_at: string | null;
      };
      created: boolean;
    };
    expect(storedFileResult.secret.secret_id).toBe("safe_secret");
    expect(storedFileResult.secret.version).toBe(1);
    expect(storedFileResult.secret.expires_at).toBe("2030-01-01T00:00:00.000Z");
    expect(storedFileResult.created).toBe(true);

    const rotatedFromStdin = await runCliProcess(
      [
        "--json",
        "upsert-mcp-secret",
        "--secret-id",
        "safe_secret",
        "--display-name",
        "Safe secret",
        "--bearer-token-stdin",
      ],
      {
        workspaceRoot: harness.workspaceRoot,
        socketPath: harness.socketPath,
        stdinText: "safe-token-stdin\n",
      },
    );
    expect(rotatedFromStdin.code).toBe(0);
    expect(rotatedFromStdin.stderr).toBe("");
    expect(rotatedFromStdin.stdout).not.toContain("safe-token-stdin");
    const rotatedResult = JSON.parse(rotatedFromStdin.stdout) as {
      secret: {
        secret_id: string;
        version: number;
        expires_at: string | null;
      };
      created: boolean;
      rotated: boolean;
    };
    expect(rotatedResult.secret.secret_id).toBe("safe_secret");
    expect(rotatedResult.secret.version).toBe(2);
    expect(rotatedResult.secret.expires_at).toBeNull();
    expect(rotatedResult.created).toBe(false);
    expect(rotatedResult.rotated).toBe(true);

    const listedSecrets = await runCliProcess(["--json", "list-mcp-secrets"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(listedSecrets.code).toBe(0);
    expect(listedSecrets.stdout).not.toContain("safe-token-file");
    expect(listedSecrets.stdout).not.toContain("safe-token-stdin");
    const listed = JSON.parse(listedSecrets.stdout) as {
      secrets: Array<{
        secret_id: string;
        version: number;
        expires_at: string | null;
      }>;
    };
    expect(listed.secrets).toContainEqual(
      expect.objectContaining({
        secret_id: "safe_secret",
        version: 2,
        expires_at: null,
      }),
    );
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
        ...buildSandboxedStdioServerDefinition("notes_stdio_invalid_args"),
        display_name: "Notes stdio invalid args test",
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
    expect(rejected.code).toBe(CLI_EXIT_CODES.INPUT_INVALID);
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

  it("emits structured JSON error envelopes for built CLI failures", async () => {
    const harness = await createHarness();

    const rejected = await runCliProcess(["--json", "submit-mcp-tool"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });

    expect(rejected.code).toBe(CLI_EXIT_CODES.USAGE);
    expect(rejected.stdout).toBe("");
    const envelope = JSON.parse(rejected.stderr) as {
      ok: boolean;
      error: {
        code: string;
        error_class: string;
        exit_code: number;
        retryable: boolean;
        message: string;
      };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("CLI_USAGE");
    expect(envelope.error.error_class).toBe("cli_usage");
    expect(envelope.error.exit_code).toBe(CLI_EXIT_CODES.USAGE);
    expect(envelope.error.retryable).toBe(false);
    expect(envelope.error.message).toContain("submit-mcp-tool");
  });

  it("drives approval, timeline, and helper workflows through the built CLI binary", async () => {
    const harness = await createHarness();
    writeShellApprovalPolicy(harness.workspaceRoot);
    await restartHarness(harness);

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
    expect(submitResult.approval_request?.primary_reason?.code).toBe("OPAQUE_SHELL_SCOPE_REQUIRES_APPROVAL");
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
    expect(inboxResult.items[0]?.reason_summary ?? "").toMatch(/approval is required|automation threshold/i);

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
          step.primary_reason?.code === "OPAQUE_SHELL_SCOPE_REQUIRES_APPROVAL",
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
    expect(helperBeforeResult.primary_reason?.code).toBe("OPAQUE_SHELL_SCOPE_REQUIRES_APPROVAL");

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

    const maintenance = await runCliProcess(["--json", "maintenance", "sqlite_wal_checkpoint", "capability_refresh"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
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
      [
        "--json",
        "diagnostics",
        "daemon_health",
        "capability_summary",
        "storage_summary",
        "hosted_worker",
        "hosted_queue",
      ],
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
      hosted_worker?: { reachable: boolean; endpoint: string };
      hosted_queue?: { queued_jobs: number; failed_jobs: number };
    };
    expect(diagnosticsResult.daemon_health?.status).toBeTruthy();
    expect(typeof diagnosticsResult.daemon_health?.active_runs).toBe("number");
    expect(diagnosticsResult.capability_summary?.cached).toBe(true);
    expect((diagnosticsResult.capability_summary?.capability_count ?? 0) > 0).toBe(true);
    expect(typeof diagnosticsResult.storage_summary?.artifact_health.total).toBe("number");
    expect(typeof diagnosticsResult.hosted_worker?.reachable).toBe("boolean");
    expect(typeof diagnosticsResult.hosted_worker?.endpoint).toBe("string");
    expect(typeof diagnosticsResult.hosted_queue?.queued_jobs).toBe("number");
    expect(typeof diagnosticsResult.hosted_queue?.failed_jobs).toBe("number");
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
    expect(deniedArtifact.code).toBe(CLI_EXIT_CODES.NOT_FOUND);
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
    writeShellApprovalPolicy(harness.workspaceRoot);
    await restartHarness(harness);

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
    expect(overwriteRejected.code).toBe(CLI_EXIT_CODES.IO_ERROR);
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
    expect(overwriteRejected.code).toBe(CLI_EXIT_CODES.INTERNAL);
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
    expect(tampered.code).toBe(CLI_EXIT_CODES.INPUT_INVALID);
    const tamperedResult = JSON.parse(tampered.stdout) as {
      verified: boolean;
      issues: Array<{ code: string; artifact_id?: string }>;
    };
    expect(tamperedResult.verified).toBe(false);
    expect(tamperedResult.issues.some((issue) => issue.code === "ARTIFACT_SHA256_MISMATCH")).toBe(true);
    expect(tamperedResult.issues.some((issue) => issue.code === "ARTIFACT_INTEGRITY_MISMATCH")).toBe(true);
  });

  it("reports and shares a verified run audit bundle through the built CLI binary", async () => {
    const harness = await createHarness();
    const sourcePath = path.join(harness.workspaceRoot, "audit-report-source.txt");
    const outputDir = path.join(harness.workspaceRoot, "audit-report-bundle");
    const shareDir = path.join(harness.workspaceRoot, "audit-report-share");
    fs.writeFileSync(sourcePath, "audit report content", "utf8");

    const registerRun = await runCliProcess(["--json", "register-run", "cli-audit-report"], {
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

    const report = await runCliProcess(["--json", "run-audit-report", outputDir], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(report.code).toBe(0);
    const reportResult = JSON.parse(report.stdout) as {
      run_id: string;
      verified: boolean;
      artifacts: { exported_count: number; skipped_count: number };
      timeline: { step_count: number };
    };
    expect(reportResult.run_id).toBe(run.run_id);
    expect(reportResult.verified).toBe(true);
    expect(reportResult.artifacts.exported_count).toBeGreaterThan(0);
    expect(reportResult.timeline.step_count).toBeGreaterThan(0);

    const share = await runCliProcess(["--json", "run-audit-share", outputDir, shareDir], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(share.code).toBe(0);
    const shareResult = JSON.parse(share.stdout) as {
      run_id: string;
      include_artifact_content: boolean;
      copied_artifacts: Array<unknown>;
      withheld_artifacts: Array<{ artifact_id: string; reason: string }>;
    };
    expect(shareResult.run_id).toBe(run.run_id);
    expect(shareResult.include_artifact_content).toBe(false);
    expect(shareResult.copied_artifacts).toHaveLength(0);
    expect(shareResult.withheld_artifacts.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(shareDir, "share-manifest.json"))).toBe(true);
    const shareManifest = JSON.parse(fs.readFileSync(path.join(shareDir, "share-manifest.json"), "utf8")) as {
      include_artifact_content: boolean;
      copied_artifacts: Array<unknown>;
      withheld_artifacts: Array<unknown>;
    };
    expect(shareManifest.include_artifact_content).toBe(false);
    expect(shareManifest.copied_artifacts).toHaveLength(0);
    expect(shareManifest.withheld_artifacts.length).toBeGreaterThan(0);
  });

  it("compares two run audit bundles and returns structured differences through the built CLI binary", async () => {
    const harness = await createHarness();
    const leftSourcePath = path.join(harness.workspaceRoot, "audit-compare-left.txt");
    const rightSourcePath = path.join(harness.workspaceRoot, "audit-compare-right.txt");
    const leftOutputDir = path.join(harness.workspaceRoot, "audit-compare-left-bundle");
    const rightOutputDir = path.join(harness.workspaceRoot, "audit-compare-right-bundle");
    fs.writeFileSync(leftSourcePath, "left compare content", "utf8");
    fs.writeFileSync(rightSourcePath, "right compare content", "utf8");

    const leftRunResponse = await runCliProcess(["--json", "register-run", "cli-audit-compare-left"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(leftRunResponse.code).toBe(0);
    const leftRun = JSON.parse(leftRunResponse.stdout) as { run_id: string };
    expect(
      await runCliProcess(["--json", "submit-shell", leftRun.run_id, "cat", leftSourcePath], {
        workspaceRoot: harness.workspaceRoot,
        socketPath: harness.socketPath,
      }),
    ).toEqual(expect.objectContaining({ code: 0 }));
    expect(
      await runCliProcess(["--json", "run-audit-export", leftRun.run_id, leftOutputDir, "internal"], {
        workspaceRoot: harness.workspaceRoot,
        socketPath: harness.socketPath,
      }),
    ).toEqual(expect.objectContaining({ code: 0 }));

    const rightRunResponse = await runCliProcess(["--json", "register-run", "cli-audit-compare-right"], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(rightRunResponse.code).toBe(0);
    const rightRun = JSON.parse(rightRunResponse.stdout) as { run_id: string };
    expect(
      await runCliProcess(["--json", "submit-shell", rightRun.run_id, "cat", rightSourcePath], {
        workspaceRoot: harness.workspaceRoot,
        socketPath: harness.socketPath,
      }),
    ).toEqual(expect.objectContaining({ code: 0 }));
    expect(
      await runCliProcess(["--json", "submit-shell", rightRun.run_id, "printf", "extra-audit-step"], {
        workspaceRoot: harness.workspaceRoot,
        socketPath: harness.socketPath,
      }),
    ).toEqual(expect.objectContaining({ code: 0 }));
    expect(
      await runCliProcess(["--json", "run-audit-export", rightRun.run_id, rightOutputDir, "internal"], {
        workspaceRoot: harness.workspaceRoot,
        socketPath: harness.socketPath,
      }),
    ).toEqual(expect.objectContaining({ code: 0 }));

    const compared = await runCliProcess(["--json", "run-audit-compare", leftOutputDir, rightOutputDir], {
      workspaceRoot: harness.workspaceRoot,
      socketPath: harness.socketPath,
    });
    expect(compared.code).toBe(CLI_EXIT_CODES.INPUT_INVALID);
    const comparedResult = JSON.parse(compared.stdout) as {
      left_run_id: string;
      right_run_id: string;
      differences: Array<{ code: string }>;
    };
    expect(comparedResult.left_run_id).toBe(leftRun.run_id);
    expect(comparedResult.right_run_id).toBe(rightRun.run_id);
    expect(comparedResult.differences.some((difference) => difference.code === "RUN_ID_CHANGED")).toBe(true);
    expect(comparedResult.differences.some((difference) => difference.code === "ACTION_COUNT_CHANGED")).toBe(true);
  });
});
