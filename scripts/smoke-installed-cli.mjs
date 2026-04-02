#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const daemonEntry = path.join(repoRoot, "packages", "authority-daemon", "dist", "main.js");

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
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

    if (options.stdin) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed with exit code ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
        return;
      }

      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

function parseJsonOutput(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `${label} did not emit valid JSON.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\ncause:\n${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function waitForSocket(socketPath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for daemon socket at ${socketPath}.`);
}

async function main() {
  const tempBase = process.platform === "win32" ? os.tmpdir() : "/tmp";
  const tempRoot = await fsp.mkdtemp(path.join(tempBase, "agcli-"));
  const tarballDir = path.join(tempRoot, "tarballs");
  const installRoot = path.join(tempRoot, "install-root");
  const workspaceRoot = path.join(tempRoot, "workspace");
  const daemonStateRoot = path.join(tempRoot, "d");
  const socketPath = path.join(tempRoot, "a.sock");
  const journalPath = path.join(daemonStateRoot, "a.db");
  const snapshotRootPath = path.join(daemonStateRoot, "snaps");
  const mcpRegistryPath = path.join(daemonStateRoot, "mcp-reg.db");
  const mcpSecretStorePath = path.join(daemonStateRoot, "mcp-secrets.db");
  const mcpHostPolicyPath = path.join(daemonStateRoot, "mcp-hosts.db");
  const mcpConcurrencyLeasePath = path.join(daemonStateRoot, "mcp-leases.db");

  await fsp.mkdir(workspaceRoot, { recursive: true });
  await fsp.mkdir(installRoot, { recursive: true });
  await fsp.mkdir(daemonStateRoot, { recursive: true });

  try {
    const packed = await runCommand(
      "node",
      [path.join(repoRoot, "scripts", "pack-release-artifacts.mjs"), "--out-dir", tarballDir],
      {
        cwd: repoRoot,
      },
    );
    const packManifest = JSON.parse(packed.stdout);
    const tarballs = packManifest.packages.map((pkg) => pkg.tarball_path);

    await runCommand("npm", ["init", "-y"], { cwd: installRoot });
    await runCommand("npm", ["install", "--no-package-lock", ...tarballs], { cwd: installRoot });

    const installedCli = path.join(
      installRoot,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "agentgit-authority.cmd" : "agentgit-authority",
    );
    const daemonEnv = {
      AGENTGIT_ROOT: workspaceRoot,
      INIT_CWD: workspaceRoot,
      AGENTGIT_SOCKET_PATH: socketPath,
      AGENTGIT_JOURNAL_PATH: journalPath,
      AGENTGIT_SNAPSHOT_ROOT: snapshotRootPath,
      AGENTGIT_MCP_REGISTRY_PATH: mcpRegistryPath,
      AGENTGIT_MCP_SECRET_STORE_PATH: mcpSecretStorePath,
      AGENTGIT_MCP_HOST_POLICY_PATH: mcpHostPolicyPath,
      AGENTGIT_MCP_CONCURRENCY_LEASE_PATH: mcpConcurrencyLeasePath,
    };

    const daemon = spawn(process.execPath, [daemonEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...daemonEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let daemonExitError = null;

    let daemonStdout = "";
    let daemonStderr = "";
    daemon.stdout.on("data", (chunk) => {
      daemonStdout += chunk.toString("utf8");
    });
    daemon.stderr.on("data", (chunk) => {
      daemonStderr += chunk.toString("utf8");
    });

    try {
      await waitForSocket(socketPath);

      const baseArgs = ["--json", "--socket-path", socketPath, "--workspace-root", workspaceRoot];
      const version = await runCommand(installedCli, ["--json", "version"], { cwd: installRoot });
      const versionResult = parseJsonOutput(version, "agentgit-authority version");
      if (versionResult.supported_api_version !== "authority.v1") {
        throw new Error(`Unexpected supported API version: ${versionResult.supported_api_version}`);
      }

      const ping = await runCommand(installedCli, [...baseArgs, "ping"], { cwd: installRoot });
      const pingResult = parseJsonOutput(ping, "agentgit-authority ping");
      if (pingResult.accepted_api_version !== "authority.v1") {
        throw new Error(`Unexpected accepted API version: ${pingResult.accepted_api_version}`);
      }

      const doctor = await runCommand(installedCli, [...baseArgs, "doctor"], { cwd: installRoot });
      const doctorResult = parseJsonOutput(doctor, "agentgit-authority doctor");
      if (doctorResult.daemon.reachable !== true) {
        throw new Error("Installed CLI doctor did not report a reachable daemon.");
      }

      const registerRun = await runCommand(
        installedCli,
        [...baseArgs, "register-run", "installed-cli-smoke", "2", "1"],
        {
          cwd: installRoot,
        },
      );
      const registerRunResult = parseJsonOutput(registerRun, "agentgit-authority register-run");
      const runId = registerRunResult.run_id;
      if (typeof runId !== "string" || runId.length === 0) {
        throw new Error("Installed CLI register-run did not return a run_id.");
      }

      await runCommand(
        installedCli,
        [...baseArgs, "submit-filesystem-write", runId, "installed-cli-smoke.txt", "hello from installed cli"],
        {
          cwd: installRoot,
        },
      );
      const written = await fsp.readFile(path.join(workspaceRoot, "installed-cli-smoke.txt"), "utf8");
      if (written !== "hello from installed cli") {
        throw new Error(`Installed CLI wrote unexpected file content: ${written}`);
      }

      const summary = await runCommand(installedCli, [...baseArgs, "run-summary", runId], {
        cwd: installRoot,
      });
      const summaryResult = parseJsonOutput(summary, "agentgit-authority run-summary");
      if (summaryResult.run.action_count < 1) {
        throw new Error("Installed CLI run summary did not capture the governed filesystem action.");
      }

      process.stdout.write(
        `${JSON.stringify(
          {
            ok: true,
            install_root: installRoot,
            workspace_root: workspaceRoot,
            daemon_socket_path: socketPath,
            packed_artifacts: packManifest.packages,
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      if (daemon.exitCode === null && daemon.signalCode === null) {
        daemon.kill("SIGTERM");
        await new Promise((resolve) => daemon.once("close", resolve));
      }
      if (daemon.exitCode !== 0 && daemon.exitCode !== null) {
        daemonExitError = new Error(`Daemon exited unexpectedly.\nstdout:\n${daemonStdout}\nstderr:\n${daemonStderr}`);
      }
    }
    if (daemonExitError) {
      throw daemonExitError;
    }
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
