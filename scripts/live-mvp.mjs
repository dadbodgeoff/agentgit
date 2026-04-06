#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productCli = path.join(repoRoot, "packages", "agent-runtime-integration", "dist", "main.js");
const authorityCli = path.join(repoRoot, "packages", "authority-cli", "dist", "main.js");
const authorityDaemon = path.join(repoRoot, "packages", "authority-daemon", "dist", "main.js");
const inspectorServer = path.join(repoRoot, "apps", "inspector-ui", "dist", "server.js");

const controlRoot = path.join(os.tmpdir(), "agentgit-live-mvp-control");
const latestSessionPath = path.join(controlRoot, "latest.json");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4317;

function usage() {
  return [
    "Usage: node scripts/live-mvp.mjs [options]",
    "",
    "Options:",
    "  --workspace-root <path>   Reuse or create a specific workspace root",
    "  --mode <attached|contained>",
    "  --inspector-port <port>",
    "  --inspector-host <host>",
    "  --open                    Open the inspector URL in the default browser",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    workspaceRoot: undefined,
    mode: "attached",
    inspectorPort: DEFAULT_PORT,
    inspectorHost: DEFAULT_HOST,
    openBrowser: false,
  };

  const rest = [...argv];
  while (rest.length > 0) {
    const current = rest.shift();
    switch (current) {
      case "--workspace-root":
        options.workspaceRoot = path.resolve(shiftValue(rest, "--workspace-root"));
        break;
      case "--mode": {
        const value = shiftValue(rest, "--mode");
        if (value !== "attached" && value !== "contained") {
          throw new Error(`Unsupported --mode value: ${value}`);
        }
        options.mode = value;
        break;
      }
      case "--inspector-port": {
        const value = Number(shiftValue(rest, "--inspector-port"));
        if (!Number.isInteger(value) || value <= 0) {
          throw new Error(`Invalid --inspector-port value: ${value}`);
        }
        options.inspectorPort = value;
        break;
      }
      case "--inspector-host":
        options.inspectorHost = shiftValue(rest, "--inspector-host");
        break;
      case "--open":
        options.openBrowser = true;
        break;
      case "--help":
      case "-h":
        process.stdout.write(`${usage()}\n`);
        process.exit(0);
        return options;
      default:
        throw new Error(`Unknown argument: ${current}`);
    }
  }

  return options;
}

function shiftValue(args, flag) {
  const value = args.shift();
  if (!value) {
    throw new Error(`${flag} expects a value.`);
  }
  return value;
}

function printStep(label) {
  process.stdout.write(`\n== ${label} ==\n`);
}

function runtimeHash(workspaceRoot) {
  return createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 12);
}

function productStateRoot(env = process.env) {
  const configured = env.AGENTGIT_CLI_CONFIG_ROOT?.trim();
  if (configured) {
    return path.resolve(configured, "runtime-integration");
  }

  const xdgRoot = env.XDG_CONFIG_HOME?.trim();
  if (xdgRoot) {
    return path.resolve(xdgRoot, "agentgit", "runtime-integration");
  }

  return path.resolve(os.homedir(), ".config", "agentgit", "runtime-integration");
}

function runtimeRootForWorkspace(workspaceRoot, env = process.env) {
  if (process.platform !== "win32") {
    return path.join("/tmp", "agentgit-runtime", runtimeHash(workspaceRoot));
  }

  return path.join(productStateRoot(env), "authority-runtime", runtimeHash(workspaceRoot));
}

function buildAuthorityEnvironment(workspaceRoot, runtimeRoot, env = process.env) {
  const mcpRoot = path.join(runtimeRoot, "mcp");
  return {
    ...env,
    AGENTGIT_ROOT: workspaceRoot,
    AGENTGIT_SOCKET_PATH: path.join(runtimeRoot, "authority.sock"),
    AGENTGIT_JOURNAL_PATH: path.join(runtimeRoot, "authority.db"),
    AGENTGIT_SNAPSHOT_ROOT: path.join(runtimeRoot, "snapshots"),
    AGENTGIT_MCP_REGISTRY_PATH: path.join(mcpRoot, "registry.db"),
    AGENTGIT_MCP_SECRET_STORE_PATH: env.AGENTGIT_MCP_SECRET_STORE_PATH ?? path.join(mcpRoot, "secret-store.db"),
    AGENTGIT_MCP_SECRET_KEY_PATH: env.AGENTGIT_MCP_SECRET_KEY_PATH ?? path.join(mcpRoot, "secret-store.key"),
    AGENTGIT_MCP_HOST_POLICY_PATH: path.join(mcpRoot, "host-policies.db"),
    AGENTGIT_MCP_CONCURRENCY_LEASE_PATH: path.join(mcpRoot, "concurrency.db"),
    AGENTGIT_MCP_HOSTED_WORKER_ENDPOINT: `unix:${path.join(mcpRoot, "hosted-worker.sock")}`,
    AGENTGIT_MCP_HOSTED_WORKER_ATTESTATION_KEY_PATH: path.join(mcpRoot, "hosted-worker-attestation-key.json"),
    AGENTGIT_POLICY_WORKSPACE_CONFIG_PATH: path.join(runtimeRoot, "policy.toml"),
    AGENTGIT_POLICY_CALIBRATION_CONFIG_PATH: path.join(runtimeRoot, "policy.calibration.generated.json"),
  };
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
  const accepted = options.acceptExitCodes ?? [0];
  if (!accepted.includes(result.code)) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result;
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function detectDocker() {
  const result = await runCommand("docker", ["info"]);
  return result.code === 0;
}

async function buildArtifacts() {
  await runRequired("pnpm", [
    "exec",
    "turbo",
    "run",
    "build",
    "--filter=@agentgit/authority-cli^...",
    "--filter=@agentgit/authority-cli",
    "--filter=@agentgit/agent-runtime-integration^...",
    "--filter=@agentgit/agent-runtime-integration",
    "--filter=@agentgit/inspector-ui^...",
    "--filter=@agentgit/inspector-ui",
  ]);

  const required = [productCli, authorityCli, authorityDaemon, inspectorServer];
  for (const target of required) {
    if (!(await pathExists(target))) {
      throw new Error(`Expected built artifact is missing: ${target}`);
    }
  }
}

async function seedWorkspace(workspaceRoot) {
  await fsp.mkdir(path.join(workspaceRoot, "inputs"), { recursive: true });
  await fsp.writeFile(
    path.join(workspaceRoot, "inputs", "spec.md"),
    "# MVP Spec\n\n- show governed file operations\n- leave evidence behind\n- keep recovery available\n",
    "utf8",
  );
  await fsp.writeFile(
    path.join(workspaceRoot, "inputs", "todo.txt"),
    "Validate the operator story before external MVP testing.\n",
    "utf8",
  );
  await fsp.writeFile(
    path.join(workspaceRoot, "README.live-mvp.txt"),
    [
      "This workspace was generated by scripts/live-mvp.mjs.",
      "Use the inspector and audit bundle to review the governed run.",
      "",
      "Inputs are in ./inputs.",
      "Outputs are written into ./outputs and ./archive during the run.",
    ].join("\n"),
    "utf8",
  );
}

function launchCommandForWorkspace() {
  return [
    "sh -lc",
    "'mkdir -p outputs archive",
    "&& cp inputs/spec.md outputs/plan.md",
    "&& cp inputs/todo.txt archive/todo.snapshot.md",
    "&& rm inputs/todo.txt",
    "&& ls -la outputs archive'",
  ].join(" ");
}

async function runProductCli(workspaceRoot, args) {
  return runRequired("node", [productCli, "--workspace-root", workspaceRoot, ...args]);
}

function combinedOutput(result) {
  return [result.stdout, result.stderr].filter((value) => value && value.trim().length > 0).join("\n");
}

function extractLineValue(output, prefix) {
  const line = output
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : null;
}

function spawnDetached(command, args, options = {}) {
  const stdoutFd = fs.openSync(options.stdoutPath, "a");
  const stderrFd = fs.openSync(options.stderrPath, "a");
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: {
      ...process.env,
      ...(options.env ?? {}),
    },
    detached: true,
    stdio: ["ignore", stdoutFd, stderrFd],
  });
  child.unref();
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);
  return child;
}

async function waitFor(checkFn, failureLabel, timeoutMs = 15_000, intervalMs = 250) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await checkFn()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out while waiting for ${failureLabel}.`);
}

async function startDaemon(workspaceRoot, runtimeRoot, logDir) {
  const env = buildAuthorityEnvironment(workspaceRoot, runtimeRoot);
  const child = spawnDetached("node", [authorityDaemon], {
    env,
    stdoutPath: path.join(logDir, "daemon.stdout.log"),
    stderrPath: path.join(logDir, "daemon.stderr.log"),
  });
  await waitFor(async () => pathExists(env.AGENTGIT_SOCKET_PATH), "authority daemon socket");
  await runRequired(
    "node",
    [authorityCli, "--json", "--socket-path", env.AGENTGIT_SOCKET_PATH, "--workspace-root", workspaceRoot, "ping"],
    { env },
  );
  return {
    pid: child.pid,
    socketPath: env.AGENTGIT_SOCKET_PATH,
    journalPath: env.AGENTGIT_JOURNAL_PATH,
    env,
  };
}

async function startInspector(socketPath, host, port, logDir) {
  const env = {
    ...process.env,
    AGENTGIT_SOCKET_PATH: socketPath,
    AGENTGIT_INSPECTOR_HOST: host,
    AGENTGIT_INSPECTOR_PORT: String(port),
  };
  const child = spawnDetached("node", [inspectorServer], {
    env,
    stdoutPath: path.join(logDir, "inspector.stdout.log"),
    stderrPath: path.join(logDir, "inspector.stderr.log"),
  });
  const url = `http://${host}:${port}`;
  await waitFor(async () => {
    try {
      const response = await fetch(url);
      return response.ok;
    } catch {
      return false;
    }
  }, "inspector ui");
  return {
    pid: child.pid,
    url,
  };
}

async function writeJson(targetPath, value) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await fsp.writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function captureOperatorEvidence(workspaceRoot, socketPath, runId, evidenceDir) {
  const baseArgs = ["--json", "--socket-path", socketPath, "--workspace-root", workspaceRoot];

  const runSummary = await runRequired("node", [authorityCli, ...baseArgs, "run-summary", runId]);
  await fsp.writeFile(path.join(evidenceDir, "run-summary.json"), `${runSummary.stdout}\n`, "utf8");

  const timeline = await runRequired("node", [authorityCli, ...baseArgs, "timeline", runId, "internal"]);
  await fsp.writeFile(path.join(evidenceDir, "timeline.internal.json"), `${timeline.stdout}\n`, "utf8");

  const helper = await runRequired("node", [authorityCli, ...baseArgs, "helper", runId, "what_happened"]);
  await fsp.writeFile(path.join(evidenceDir, "helper.what-happened.json"), `${helper.stdout}\n`, "utf8");

  const diagnostics = await runRequired("node", [
    authorityCli,
    ...baseArgs,
    "diagnostics",
    "daemon_health",
    "storage_summary",
  ]);
  await fsp.writeFile(path.join(evidenceDir, "diagnostics.json"), `${diagnostics.stdout}\n`, "utf8");

  const auditBundleDir = path.join(evidenceDir, "audit-bundle");
  const auditExport = await runRequired("node", [
    authorityCli,
    ...baseArgs,
    "run-audit-export",
    runId,
    auditBundleDir,
    "internal",
  ]);
  await fsp.writeFile(path.join(evidenceDir, "run-audit-export.json"), `${auditExport.stdout}\n`, "utf8");

  const auditVerify = await runRequired("node", [authorityCli, ...baseArgs, "run-audit-verify", auditBundleDir]);
  await fsp.writeFile(path.join(evidenceDir, "run-audit-verify.json"), `${auditVerify.stdout}\n`, "utf8");

  return {
    run_summary_path: path.join(evidenceDir, "run-summary.json"),
    timeline_path: path.join(evidenceDir, "timeline.internal.json"),
    helper_path: path.join(evidenceDir, "helper.what-happened.json"),
    diagnostics_path: path.join(evidenceDir, "diagnostics.json"),
    audit_bundle_dir: auditBundleDir,
    audit_verify_path: path.join(evidenceDir, "run-audit-verify.json"),
  };
}

async function maybeOpenBrowser(url) {
  if (process.platform === "darwin") {
    await runRequired("open", [url]);
    return;
  }
  if (process.platform === "linux") {
    await runRequired("xdg-open", [url]);
    return;
  }
  if (process.platform === "win32") {
    await runRequired("cmd", ["/c", "start", "", url]);
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tempBase = process.platform === "win32" ? os.tmpdir() : "/tmp";
  const sessionRoot = await fsp.mkdtemp(path.join(tempBase, "agentgit-live-mvp-"));
  const workspaceRoot = options.workspaceRoot ?? path.join(sessionRoot, "workspace");
  const logDir = path.join(sessionRoot, "logs");
  const evidenceDir = path.join(sessionRoot, "evidence");
  const runtimeRoot = runtimeRootForWorkspace(workspaceRoot);

  await fsp.mkdir(logDir, { recursive: true });
  await fsp.mkdir(evidenceDir, { recursive: true });
  await fsp.mkdir(workspaceRoot, { recursive: true });

  printStep("Build required packages");
  await buildArtifacts();

  if (options.mode === "contained") {
    const dockerAvailable = await detectDocker();
    if (!dockerAvailable) {
      throw new Error("Docker is required for --mode contained, but docker info failed.");
    }
  }

  printStep("Seed workspace");
  await seedWorkspace(workspaceRoot);

  const command = launchCommandForWorkspace();

  printStep("Run agentgit setup");
  const setupArgs = ["setup", "--yes", "--command", command];
  if (options.mode === "contained") {
    setupArgs.push("--contained", "--network", "none", "--credentials", "none");
  }
  const setupResult = await runProductCli(workspaceRoot, setupArgs);
  process.stdout.write(`${setupResult.stdout}\n`);

  printStep("Run governed task");
  const runResult = await runProductCli(workspaceRoot, ["run", "--checkpoint"]);
  process.stdout.write(`${combinedOutput(runResult)}\n`);

  printStep("Inspect latest governed run");
  const inspectResult = await runProductCli(workspaceRoot, ["inspect"]);
  process.stdout.write(`${combinedOutput(inspectResult)}\n`);
  const runId = extractLineValue(runResult.stdout, "Run: ") ?? extractLineValue(inspectResult.stdout, "Run: ");
  if (!runId) {
    throw new Error(
      `Could not determine run id from agentgit run/inspect output.\nrun:\n${combinedOutput(runResult)}\ninspect:\n${combinedOutput(inspectResult)}`,
    );
  }
  await fsp.writeFile(path.join(evidenceDir, "agentgit-setup.txt"), `${combinedOutput(setupResult)}\n`, "utf8");
  await fsp.writeFile(path.join(evidenceDir, "agentgit-run.txt"), `${combinedOutput(runResult)}\n`, "utf8");
  await fsp.writeFile(path.join(evidenceDir, "agentgit-inspect.txt"), `${combinedOutput(inspectResult)}\n`, "utf8");

  printStep("Start persistent daemon");
  const daemon = await startDaemon(workspaceRoot, runtimeRoot, logDir);

  printStep("Start inspector UI");
  const inspector = await startInspector(daemon.socketPath, options.inspectorHost, options.inspectorPort, logDir);

  printStep("Capture operator evidence");
  const evidence = await captureOperatorEvidence(workspaceRoot, daemon.socketPath, runId, evidenceDir);

  const summary = {
    ok: true,
    mode: options.mode,
    session_root: sessionRoot,
    workspace_root: workspaceRoot,
    runtime_root: runtimeRoot,
    socket_path: daemon.socketPath,
    journal_path: daemon.journalPath,
    run_id: runId,
    inspector_url: inspector.url,
    daemon_pid: daemon.pid,
    inspector_pid: inspector.pid,
    logs: {
      daemon_stdout: path.join(logDir, "daemon.stdout.log"),
      daemon_stderr: path.join(logDir, "daemon.stderr.log"),
      inspector_stdout: path.join(logDir, "inspector.stdout.log"),
      inspector_stderr: path.join(logDir, "inspector.stderr.log"),
    },
    evidence,
    child_processes_alive: {
      daemon: daemon.pid ? processAlive(daemon.pid) : false,
      inspector: inspector.pid ? processAlive(inspector.pid) : false,
    },
  };

  await fsp.mkdir(controlRoot, { recursive: true });
  await writeJson(path.join(sessionRoot, "session.json"), summary);
  await writeJson(latestSessionPath, summary);

  if (options.openBrowser) {
    printStep("Open inspector");
    await maybeOpenBrowser(inspector.url);
  }

  process.stdout.write(
    [
      "",
      "Live MVP harness is ready.",
      `Workspace: ${workspaceRoot}`,
      `Run: ${runId}`,
      `Inspector: ${inspector.url}`,
      `Evidence bundle: ${evidence.audit_bundle_dir}`,
      `Session file: ${path.join(sessionRoot, "session.json")}`,
      "Stop it with: pnpm live:mvp:stop",
      "",
      JSON.stringify(summary, null, 2),
      "",
    ].join("\n"),
  );
}

await main();
