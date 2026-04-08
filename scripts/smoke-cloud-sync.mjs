#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  ActivityFeedResponseSchema,
  ApprovalDecisionResponseSchema,
  ApprovalListResponseSchema,
  ConnectorBootstrapResponseSchema,
  OnboardingBootstrapSchema,
  OnboardingFormValuesSchema,
  OnboardingLaunchResponseSchema,
  WorkspaceConnectorInventorySchema,
} from "../apps/agentgit-cloud/src/schemas/cloud.ts";
import { ConnectorRegistrationResponseSchema } from "../packages/cloud-sync-protocol/src/index.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authorityCli = path.join(repoRoot, "packages", "authority-cli", "dist", "main.js");
const authorityDaemon = path.join(repoRoot, "packages", "authority-daemon", "dist", "main.js");
const connectorCli = path.join(repoRoot, "packages", "cloud-connector", "dist", "cli.js");
const DEFAULT_TIMEOUT_MS = 90_000;

const parsedArgs = parseArgs(process.argv.slice(2));
if (parsedArgs.help) {
  printUsage();
  process.exit(0);
}

await main();

async function main() {
  const tempBase = process.platform === "win32" ? os.tmpdir() : "/tmp";
  const tempRoot = await fsp.mkdtemp(path.join(tempBase, "agentgit-cloud-sync-"));
  const workspaceRoot = path.join(tempRoot, "workspace");
  const logDir = path.join(tempRoot, "logs");
  const cloudPort = await findOpenPort();
  const postgresPort = await findOpenPort();
  const cloudUrl = `http://127.0.0.1:${cloudPort}`;
  const workspaceId = "ws_smoke_sync_01";
  const workspaceName = "Smoke Sync Workspace";
  const workspaceSlug = "smoke-sync-workspace";
  const ownerEmail = "owner@agentgit-smoke.dev";
  const nextProcesses = [];
  let postgresContainer = null;

  try {
    await fsp.mkdir(workspaceRoot, { recursive: true });
    await fsp.mkdir(logDir, { recursive: true });

    logStep("Building required cloud, connector, and authority artifacts");
    await runRequired("pnpm", [
      "exec",
      "turbo",
      "run",
      "build",
      "--filter=@agentgit/cloud-ui^...",
      "--filter=@agentgit/cloud-ui",
      "--filter=@agentgit/authority-cli^...",
      "--filter=@agentgit/authority-cli",
      "--filter=@agentgit/authority-daemon^...",
      "--filter=@agentgit/authority-daemon",
      "--filter=@agentgit/cloud-connector^...",
      "--filter=@agentgit/cloud-connector",
    ]);

    await ensureFileExists(authorityCli, "authority CLI build output");
    await ensureFileExists(authorityDaemon, "authority daemon build output");
    await ensureFileExists(connectorCli, "cloud connector build output");

    logStep("Preparing a temporary git workspace with approval-gated policy");
    await createWorkspaceRepository(workspaceRoot);
    await writeShellApprovalPolicy(workspaceRoot);

    const databaseUrl = parsedArgs.databaseUrl
      ? parsedArgs.databaseUrl
      : await (async () => {
          postgresContainer = await startPostgresContainer(postgresPort, logDir);
          return `postgres://agentgit:agentgit@127.0.0.1:${postgresPort}/agentgit_cloud`;
        })();

    const appEnv = buildAppEnvironment({
      cloudUrl,
      databaseUrl,
      workspaceRoot,
      workspaceId,
      workspaceName,
      workspaceSlug,
    });

    logStep("Running cloud database migrations");
    await runRequired("pnpm", ["--filter", "@agentgit/cloud-ui", "db:migrate"], { env: appEnv });

    logStep("Starting the cloud app in dev mode");
    const cloudApp = startManagedProcess(
      "pnpm",
      ["--filter", "@agentgit/cloud-ui", "dev", "--", "--hostname", "127.0.0.1", "--port", String(cloudPort)],
      {
        cwd: repoRoot,
        env: appEnv,
        label: "cloud-app",
      },
    );
    nextProcesses.push(cloudApp);

    logStep("Waiting for the public health probe to report ok");
    await waitFor(async () => {
      const response = await fetch(`${cloudUrl}/api/v1/healthz`).catch(() => null);
      if (!response?.ok) {
        return false;
      }
      const payload = await response.json().catch(() => null);
      return payload?.status === "ok";
    }, "public health probe");

    logStep("Signing in through the development auth provider");
    const client = new SessionClient(cloudUrl);
    await signInWithDevelopmentCredentials(client, {
      callbackUrl: "/app",
      email: ownerEmail,
      name: "Smoke Owner",
      role: "owner",
    });

    logStep("Connecting the temporary repository through onboarding");
    const onboarding = await client.request("/api/v1/onboarding", {
      schema: OnboardingBootstrapSchema,
    });
    const repoId = findOnboardingRepositoryId(onboarding, "acme", "smoke-sync-demo");
    const launchPayload = OnboardingFormValuesSchema.parse({
      workspaceName,
      workspaceSlug,
      repositoryIds: [repoId],
      invites: [],
      defaultNotificationChannel: "in_app",
      policyPack: "guarded",
      confirmLaunch: true,
    });
    await client.request("/api/v1/onboarding", {
      method: "POST",
      json: launchPayload,
      schema: OnboardingLaunchResponseSchema,
    });

    logStep("Starting the local authority daemon for the temp workspace");
    const daemon = startManagedProcess("node", [authorityDaemon], {
      cwd: repoRoot,
      env: {
        ...process.env,
        AGENTGIT_ROOT: workspaceRoot,
      },
      label: "authority-daemon",
    });
    nextProcesses.push(daemon);
    await waitFor(
      async () => fs.existsSync(path.join(workspaceRoot, ".agentgit", "authority.sock")),
      "authority socket",
    );

    logStep("Waiting for the admin readiness endpoint to report ok");
    await waitFor(async () => {
      const payload = await client.request("/api/v1/health", {
        expectedStatuses: [200],
        transform(value) {
          return value;
        },
      });
      return payload?.status === "ok";
    }, "admin readiness endpoint");

    logStep("Creating a bootstrap token through the sync API");
    const bootstrap = await client.request("/api/v1/sync/bootstrap-token", {
      method: "POST",
      schema: ConnectorBootstrapResponseSchema,
    });
    if (bootstrap.workspaceId !== workspaceId) {
      throw new Error(`Bootstrap token targeted ${bootstrap.workspaceId}, expected ${workspaceId}.`);
    }

    logStep("Registering the cloud connector against the running app");
    const bootstrapResult = await runRequired("node", [
      connectorCli,
      "bootstrap",
      "--cloud-url",
      cloudUrl,
      "--workspace-id",
      bootstrap.workspaceId,
      "--workspace-root",
      workspaceRoot,
      "--bootstrap-token",
      bootstrap.bootstrapToken,
    ]);
    const bootstrapJson = parseJsonOutput(bootstrapResult.stdout, "cloud connector bootstrap");
    ConnectorRegistrationResponseSchema.parse(bootstrapJson.registration);

    logStep("Submitting a governed run that must pause for approval");
    const registerRun = parseJsonOutput(
      (
        await runRequired("node", [
          authorityCli,
          "--json",
          "--workspace-root",
          workspaceRoot,
          "--socket-path",
          path.join(workspaceRoot, ".agentgit", "authority.sock"),
          "register-run",
          "smoke-cloud-sync",
        ])
      ).stdout,
      "authority register-run",
    );
    const runId = requireString(registerRun.run_id, "authority register-run run_id");
    const submit = parseJsonOutput(
      (
        await runRequired("node", [
          authorityCli,
          "--json",
          "--workspace-root",
          workspaceRoot,
          "--socket-path",
          path.join(workspaceRoot, ".agentgit", "authority.sock"),
          "submit-shell",
          runId,
          process.execPath,
          "-e",
          "process.stdout.write('approval smoke')",
        ])
      ).stdout,
      "authority submit-shell",
    );
    const approvalId = requireString(submit?.approval_request?.approval_id, "pending approval id");
    if (submit?.approval_request?.status !== "pending") {
      throw new Error(`Expected a pending approval, received ${JSON.stringify(submit?.approval_request)}`);
    }

    logStep("Running sync-once to push run and approval events to cloud");
    const firstSync = parseJsonOutput(
      (
        await runRequired("node", [connectorCli, "sync-once", "--workspace-root", workspaceRoot], {
          env: {
            ...process.env,
            AGENTGIT_AUTHORITY_SOCKET_PATH: path.join(workspaceRoot, ".agentgit", "authority.sock"),
          },
        })
      ).stdout,
      "connector sync-once (push)",
    );
    if (!Array.isArray(firstSync?.published?.events) || firstSync.published.events.length === 0) {
      throw new Error("First sync did not publish any connector events.");
    }

    logStep("Verifying the run appears in activity");
    await waitFor(async () => {
      const activity = await client.request("/api/v1/activity?limit=25", {
        schema: ActivityFeedResponseSchema,
      });
      return activity.items.some((item) => item.runId === runId);
    }, "activity feed to include the governed run");

    logStep("Verifying the pending approval appears in approvals");
    await waitFor(async () => {
      const approvals = await client.request("/api/v1/approvals?limit=25", {
        schema: ApprovalListResponseSchema,
      });
      return approvals.items.some((item) => item.id === approvalId && item.status === "pending");
    }, "approval queue to include the pending approval");

    logStep("Approving the pending approval through the hosted API");
    const approveResponse = await client.request(`/api/v1/approvals/${approvalId}/approve`, {
      method: "POST",
      json: {
        comment: "Smoke approval from hosted cloud sync test",
      },
      expectedStatuses: [202],
      schema: ApprovalDecisionResponseSchema,
    });
    if (approveResponse.id !== approvalId) {
      throw new Error(`Approve route returned ${approveResponse.id}, expected ${approvalId}.`);
    }

    logStep("Running sync-once again to pull and acknowledge the approval command");
    const secondSync = parseJsonOutput(
      (
        await runRequired("node", [connectorCli, "sync-once", "--workspace-root", workspaceRoot], {
          env: {
            ...process.env,
            AGENTGIT_AUTHORITY_SOCKET_PATH: path.join(workspaceRoot, ".agentgit", "authority.sock"),
          },
        })
      ).stdout,
      "connector sync-once (pull approval command)",
    );
    if (!Array.isArray(secondSync.commands) || secondSync.commands.length === 0) {
      throw new Error("Second sync did not process any connector commands.");
    }
    const resolvedCommand = secondSync.commands.find((command) => command.status === "completed");
    if (!resolvedCommand) {
      throw new Error(`Second sync did not complete the approval command: ${JSON.stringify(secondSync.commands)}`);
    }

    logStep("Verifying the command acknowledgement through the sync inventory API");
    await waitFor(async () => {
      const connectors = await client.request("/api/v1/sync/connectors?limit=10", {
        schema: WorkspaceConnectorInventorySchema,
      });
      const connector = connectors.items.find(
        (item) => item.repositoryOwner === "acme" && item.repositoryName === "smoke-sync-demo",
      );
      if (!connector) {
        return false;
      }
      return connector.recentCommands.some(
        (command) =>
          command.type === "resolve_approval" &&
          command.commandId === resolvedCommand.commandId &&
          (command.status === "completed" || command.status === "acked"),
      );
    }, "connector command acknowledgement");

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          cloudUrl,
          workspaceId,
          runId,
          approvalId,
          connectorId: bootstrapJson.registration.connector.id,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    const details = [
      error instanceof Error ? error.message : String(error),
      ...nextProcesses.map((entry) => formatManagedProcess(entry)),
    ]
      .filter(Boolean)
      .join("\n\n");
    process.stderr.write(`${details}\n`);
    process.exitCode = 1;
  } finally {
    await Promise.allSettled(nextProcesses.map((entry) => stopManagedProcess(entry)));
    if (postgresContainer) {
      await runCommand("docker", ["rm", "-f", postgresContainer], { cwd: repoRoot }).catch(() => null);
    }
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const result = {
    help: false,
    databaseUrl: process.env.DATABASE_URL?.trim() || null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      result.help = true;
      continue;
    }

    const [flag, inline] = token.split("=", 2);
    const value = inline ?? argv[index + 1];
    if (inline === undefined) {
      index += 1;
    }
    if (!value) {
      throw new Error(`Missing value for ${flag}`);
    }
    if (flag === "--database-url") {
      result.databaseUrl = value;
      continue;
    }
    throw new Error(`Unsupported flag: ${flag}`);
  }

  return result;
}

function printUsage() {
  process.stdout.write(
    [
      "Usage: node scripts/smoke-cloud-sync.mjs [--database-url postgres://...]",
      "",
      "Runs a full connector-to-cloud smoke test against a temporary local dev deployment.",
      "If --database-url is omitted, the script starts a temporary Docker Postgres container.",
    ].join("\n"),
  );
}

function logStep(message) {
  process.stdout.write(`\n== ${message} ==\n`);
}

function buildAppEnvironment({ cloudUrl, databaseUrl, workspaceRoot, workspaceId, workspaceName, workspaceSlug }) {
  return {
    ...process.env,
    AUTH_ENABLE_DEV_CREDENTIALS: "true",
    AUTH_GITHUB_ID: "smoke-github-id",
    AUTH_GITHUB_SECRET: "smoke-github-secret",
    AUTH_SECRET: "smoke-auth-secret-0123456789",
    AUTH_URL: cloudUrl,
    NEXTAUTH_URL: cloudUrl,
    DATABASE_URL: databaseUrl,
    AGENTGIT_ROOT: workspaceRoot,
    AGENTGIT_CLOUD_WORKSPACE_ROOTS: workspaceRoot,
    AUTH_WORKSPACE_ID: workspaceId,
    AUTH_WORKSPACE_NAME: workspaceName,
    AUTH_WORKSPACE_SLUG: workspaceSlug,
    SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
    SENTRY_AUTH_TOKEN: "smoke-sentry-auth-token",
    SENTRY_ORG: "agentgit",
    SENTRY_PROJECT: "cloud",
    VERCEL: "1",
    AGENTGIT_UPTIME_MONITOR_URL: `${cloudUrl}/api/v1/healthz`,
    AGENTGIT_REQUEST_METRICS_PROVIDER: "datadog",
    DD_API_KEY: "smoke-datadog-key",
    AGENTGIT_SENTRY_ALERTS_CONFIGURED: "true",
  };
}

async function createWorkspaceRepository(workspaceRoot) {
  await fsp.mkdir(workspaceRoot, { recursive: true });
  await fsp.writeFile(path.join(workspaceRoot, "README.md"), "# Smoke Sync Demo\n", "utf8");
  await runRequired("git", ["init", "-b", "main"], { cwd: workspaceRoot });
  await runRequired("git", ["config", "user.name", "Smoke Bot"], { cwd: workspaceRoot });
  await runRequired("git", ["config", "user.email", "smoke@agentgit.dev"], { cwd: workspaceRoot });
  await runRequired("git", ["remote", "add", "origin", "https://github.com/acme/smoke-sync-demo.git"], {
    cwd: workspaceRoot,
  });
  await runRequired("git", ["add", "README.md"], { cwd: workspaceRoot });
  await runRequired("git", ["commit", "-m", "Initialize smoke sync demo"], { cwd: workspaceRoot });
}

async function writeShellApprovalPolicy(workspaceRoot) {
  const policyDir = path.join(workspaceRoot, ".agentgit");
  await fsp.mkdir(policyDir, { recursive: true });
  await fsp.writeFile(
    path.join(policyDir, "policy.toml"),
    [
      'profile_name = "workspace-shell-review"',
      'policy_version = "2026.04.08"',
      "",
      "[thresholds]",
      'low_confidence = [{ action_family = "shell/*", ask_below = 0.3 }]',
      "",
      "[[rules]]",
      'rule_id = "workspace.shell.require-approval"',
      'description = "Require approval for shell execution in smoke sync tests."',
      'rationale = "The smoke sync script must exercise the hosted approval round-trip."',
      'binding_scope = "workspace"',
      'decision = "allow"',
      'enforcement_mode = "require_approval"',
      "priority = 950",
      'reason = { code = "WORKSPACE_SHELL_REQUIRES_APPROVAL", severity = "moderate", message = "Workspace policy requires approval before shell execution." }',
      'match = { type = "field", field = "operation.domain", operator = "eq", value = "shell" }',
      "",
    ].join("\n"),
    "utf8",
  );
}

async function startPostgresContainer(port, logDir) {
  const dockerCheck = await runCommand("docker", ["info"], { cwd: repoRoot });
  if (dockerCheck.code !== 0) {
    throw new Error(
      "Docker is required to start a temporary Postgres instance when --database-url is not provided. Pass --database-url or start Docker.",
    );
  }

  const containerName = `agentgit-smoke-pg-${Date.now().toString(36)}`;
  const started = await runRequired("docker", [
    "run",
    "--detach",
    "--name",
    containerName,
    "-e",
    "POSTGRES_USER=agentgit",
    "-e",
    "POSTGRES_PASSWORD=agentgit",
    "-e",
    "POSTGRES_DB=agentgit_cloud",
    "-p",
    `${port}:5432`,
    "postgres:16-alpine",
  ]);
  await waitFor(
    async () => {
      const ready = await runCommand(
        "docker",
        ["exec", containerName, "pg_isready", "-U", "agentgit", "-d", "agentgit_cloud"],
        {
          cwd: repoRoot,
        },
      );
      if (ready.code === 0) {
        return true;
      }
      const logs = await runCommand("docker", ["logs", containerName], { cwd: repoRoot });
      await fsp.writeFile(path.join(logDir, "postgres.log"), `${logs.stdout}\n${logs.stderr}`.trim(), "utf8");
      return false;
    },
    "temporary postgres readiness",
    120_000,
    500,
  );
  return started.stdout.trim() || containerName;
}

function startManagedProcess(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const state = {
    label: options.label,
    child,
    stdout: "",
    stderr: "",
  };
  child.stdout.on("data", (chunk) => {
    state.stdout = trimTail(state.stdout + chunk.toString("utf8"));
  });
  child.stderr.on("data", (chunk) => {
    state.stderr = trimTail(state.stderr + chunk.toString("utf8"));
  });
  return state;
}

function trimTail(value, maxLength = 8_000) {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(value.length - maxLength);
}

async function stopManagedProcess(entry) {
  if (entry.child.exitCode !== null || entry.child.signalCode !== null) {
    return;
  }
  entry.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => entry.child.once("close", resolve)),
    new Promise((resolve) =>
      setTimeout(() => {
        if (entry.child.exitCode === null && entry.child.signalCode === null) {
          entry.child.kill("SIGKILL");
        }
        resolve();
      }, 10_000),
    ),
  ]);
}

function formatManagedProcess(entry) {
  const parts = [`[${entry.label}]`];
  if (entry.stdout.trim()) {
    parts.push(`stdout:\n${entry.stdout.trim()}`);
  }
  if (entry.stderr.trim()) {
    parts.push(`stderr:\n${entry.stderr.trim()}`);
  }
  return parts.join("\n");
}

async function waitFor(check, label, timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function ensureFileExists(targetPath, label) {
  try {
    await fsp.access(targetPath, fs.constants.F_OK);
  } catch {
    throw new Error(`Missing ${label}: ${targetPath}`);
  }
}

function findOnboardingRepositoryId(onboarding, owner, name) {
  const repository = onboarding.availableRepositories.find((item) => item.owner === owner && item.name === name);
  if (!repository) {
    throw new Error(`Onboarding did not expose ${owner}/${name}. Check AGENTGIT_CLOUD_WORKSPACE_ROOTS.`);
  }
  return repository.id;
}

async function signInWithDevelopmentCredentials(client, { callbackUrl, email, name, role }) {
  const csrf = await client.request("/api/auth/csrf", {
    transform(payload) {
      if (!payload || typeof payload !== "object" || typeof payload.csrfToken !== "string") {
        throw new Error("Development auth did not return a csrfToken.");
      }
      return payload;
    },
  });

  await client.request("/api/auth/callback/development", {
    method: "POST",
    form: {
      callbackUrl,
      csrfToken: csrf.csrfToken,
      email,
      json: "true",
      name,
      role,
    },
    expectedStatuses: [200, 302],
  });
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing ${label}.`);
  }
  return value;
}

function parseJsonOutput(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${label} did not emit valid JSON.\n${raw}\nCause: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: {
        ...process.env,
        ...(options.env ?? {}),
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
    child.on("close", (code, signal) => {
      resolve({
        code: code ?? -1,
        signal: signal ?? null,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

async function runRequired(command, args, options = {}) {
  const result = await runCommand(command, args, options);
  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result;
}

async function findOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not determine an open TCP port."));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

class SessionClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookies = new Map();
  }

  async request(targetPath, options = {}) {
    const headers = new Headers(options.headers ?? {});
    const cookieHeader = this.cookieHeader();
    if (cookieHeader) {
      headers.set("cookie", cookieHeader);
    }

    let body = undefined;
    if (options.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(options.json);
    } else if (options.form) {
      headers.set("content-type", "application/x-www-form-urlencoded");
      body = new URLSearchParams(options.form).toString();
    }

    const response = await fetch(new URL(targetPath, this.baseUrl), {
      method: options.method ?? "GET",
      headers,
      body,
      redirect: "manual",
    });

    this.captureCookies(response);

    const expectedStatuses = options.expectedStatuses ?? [200];
    if (!expectedStatuses.includes(response.status)) {
      const raw = await response.text();
      throw new Error(
        `Request ${options.method ?? "GET"} ${targetPath} failed with ${response.status}: ${raw.slice(0, 500)}`,
      );
    }

    if (response.status === 204) {
      return null;
    }

    const text = await response.text();
    if (text.length === 0) {
      return null;
    }

    const payload = JSON.parse(text);
    if (options.transform) {
      return options.transform(payload);
    }

    return options.schema ? options.schema.parse(payload) : payload;
  }

  captureCookies(response) {
    const getSetCookie = response.headers.getSetCookie?.bind(response.headers);
    const values = typeof getSetCookie === "function" ? getSetCookie() : [];
    for (const headerValue of values) {
      const pair = headerValue.split(";", 1)[0];
      const index = pair.indexOf("=");
      if (index <= 0) {
        continue;
      }
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      this.cookies.set(name, value);
    }
  }

  cookieHeader() {
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}
