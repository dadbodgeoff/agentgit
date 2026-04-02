#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const daemonEntry = path.join(repoRoot, "packages", "authority-daemon", "dist", "main.js");
const cliEntry = path.join(repoRoot, "packages", "authority-cli", "dist", "main.js");
const defaultOutputDir = path.join(
  repoRoot,
  "engineering-docs",
  "release-signoff",
  "operator-tabletop",
  `${new Date().toISOString().slice(0, 10)}-tamper-and-triage`,
);

function parseArgs(argv) {
  const parsed = {
    outputDir: defaultOutputDir,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--output-dir") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--output-dir expects a path.");
      }
      parsed.outputDir = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${current}`);
  }
  return parsed;
}

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

    child.stdin.end();
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? -1,
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

async function runCli(args, options) {
  const result = await runCommand(
    process.execPath,
    [cliEntry, "--json", "--socket-path", options.socketPath, "--workspace-root", options.workspaceRoot, ...args],
    {
      cwd: repoRoot,
    },
  );
  return {
    raw: result,
    json: result.code === 0 || result.stdout.startsWith("{") ? parseJsonOutput(result, `cli ${args.join(" ")}`) : null,
  };
}

async function writeJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = args.outputDir;
  const tempBase = process.platform === "win32" ? os.tmpdir() : "/tmp";
  const tempRoot = await fsp.mkdtemp(path.join(tempBase, "agentgit-tabletop-"));
  const workspaceRoot = path.join(tempRoot, "workspace");
  const stateRoot = path.join(tempRoot, "state");
  const socketPath = path.join(tempRoot, "authority.sock");
  const journalPath = path.join(stateRoot, "authority.db");
  const snapshotRootPath = path.join(stateRoot, "snapshots");
  const mcpRegistryPath = path.join(stateRoot, "mcp-registry.db");
  const mcpSecretStorePath = path.join(stateRoot, "mcp-secrets.db");
  const mcpHostPolicyPath = path.join(stateRoot, "mcp-host-policies.db");
  const mcpConcurrencyLeasePath = path.join(stateRoot, "mcp-concurrency.db");
  const sourcePath = path.join(workspaceRoot, "tabletop-source.txt");
  const bundleDir = path.join(workspaceRoot, "tabletop-audit-bundle");

  await fsp.mkdir(workspaceRoot, { recursive: true });
  await fsp.mkdir(stateRoot, { recursive: true });
  await fsp.rm(outputDir, { recursive: true, force: true });
  await fsp.mkdir(outputDir, { recursive: true });
  await fsp.writeFile(sourcePath, "tabletop evidence content", "utf8");

  const daemon = spawn(process.execPath, [daemonEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AGENTGIT_ROOT: workspaceRoot,
      INIT_CWD: workspaceRoot,
      AGENTGIT_SOCKET_PATH: socketPath,
      AGENTGIT_JOURNAL_PATH: journalPath,
      AGENTGIT_SNAPSHOT_ROOT: snapshotRootPath,
      AGENTGIT_MCP_REGISTRY_PATH: mcpRegistryPath,
      AGENTGIT_MCP_SECRET_STORE_PATH: mcpSecretStorePath,
      AGENTGIT_MCP_HOST_POLICY_PATH: mcpHostPolicyPath,
      AGENTGIT_MCP_CONCURRENCY_LEASE_PATH: mcpConcurrencyLeasePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let daemonStdout = "";
  let daemonStderr = "";
  let daemonExitError = null;
  daemon.stdout.on("data", (chunk) => {
    daemonStdout += chunk.toString("utf8");
  });
  daemon.stderr.on("data", (chunk) => {
    daemonStderr += chunk.toString("utf8");
  });

  const startedAt = new Date();
  try {
    await waitForSocket(socketPath);

    const ping = await runCli(["ping"], { socketPath, workspaceRoot });
    const doctor = await runCli(["doctor"], { socketPath, workspaceRoot });
    const registerRun = await runCli(["register-run", "operator-tabletop"], { socketPath, workspaceRoot });
    if (registerRun.raw.code !== 0 || !registerRun.json?.run_id) {
      throw new Error(`register-run failed: ${registerRun.raw.stdout}\n${registerRun.raw.stderr}`);
    }
    const runId = registerRun.json.run_id;

    const submitShell = await runCli(["submit-shell", runId, "cat", sourcePath], {
      socketPath,
      workspaceRoot,
    });
    if (submitShell.raw.code !== 0) {
      throw new Error(`submit-shell failed: ${submitShell.raw.stdout}\n${submitShell.raw.stderr}`);
    }

    const exportBundle = await runCli(["run-audit-export", runId, bundleDir, "internal"], {
      socketPath,
      workspaceRoot,
    });
    if (exportBundle.raw.code !== 0) {
      throw new Error(`run-audit-export failed: ${exportBundle.raw.stdout}\n${exportBundle.raw.stderr}`);
    }

    const verifyBefore = await runCli(["run-audit-verify", bundleDir], {
      socketPath,
      workspaceRoot,
    });
    if (verifyBefore.raw.code !== 0 || verifyBefore.json?.verified !== true) {
      throw new Error(`run-audit-verify before tamper failed: ${verifyBefore.raw.stdout}\n${verifyBefore.raw.stderr}`);
    }

    const manifestPath = path.join(bundleDir, "manifest.json");
    const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
    const firstArtifactPath = manifest?.exported_artifacts?.[0]?.output_path;
    if (typeof firstArtifactPath !== "string" || firstArtifactPath.length === 0) {
      throw new Error(`Audit bundle manifest did not expose exported_artifacts output_path: ${manifestPath}`);
    }
    await fsp.writeFile(firstArtifactPath, "tampered tabletop artifact content", "utf8");

    const verifyAfter = await runCli(["run-audit-verify", bundleDir], {
      socketPath,
      workspaceRoot,
    });
    if (verifyAfter.raw.code === 0 || verifyAfter.json?.verified !== false) {
      throw new Error(
        `run-audit-verify after tamper did not fail as expected: ${verifyAfter.raw.stdout}\n${verifyAfter.raw.stderr}`,
      );
    }

    const issueCodes = Array.isArray(verifyAfter.json?.issues)
      ? verifyAfter.json.issues.map((issue) => issue.code)
      : [];
    const hasExpectedTamperSignal =
      issueCodes.includes("ARTIFACT_SHA256_MISMATCH") && issueCodes.includes("ARTIFACT_INTEGRITY_MISMATCH");
    if (!hasExpectedTamperSignal) {
      throw new Error(`Tamper verify response missing expected issue codes: ${JSON.stringify(issueCodes)}`);
    }

    const finishedAt = new Date();
    const summary = {
      ok: true,
      tabletop_started_at: startedAt.toISOString(),
      tabletop_finished_at: finishedAt.toISOString(),
      run_id: runId,
      bundle_dir: bundleDir,
      tampered_artifact_path: firstArtifactPath,
      verify_before: verifyBefore.json,
      verify_after: verifyAfter.json,
      output_dir: outputDir,
    };

    await Promise.all([
      writeJson(path.join(outputDir, "01-ping.json"), ping.json),
      writeJson(path.join(outputDir, "02-doctor.json"), doctor.json),
      writeJson(path.join(outputDir, "03-register-run.json"), registerRun.json),
      writeJson(path.join(outputDir, "04-submit-shell.json"), submitShell.json),
      writeJson(path.join(outputDir, "05-run-audit-export.json"), exportBundle.json),
      writeJson(path.join(outputDir, "06-run-audit-verify-before.json"), verifyBefore.json),
      writeJson(path.join(outputDir, "07-run-audit-verify-after.json"), verifyAfter.json),
      writeJson(path.join(outputDir, "summary.json"), summary),
    ]);

    const report = [
      "# Operator Tabletop Evidence",
      "",
      `- Status: PASS`,
      `- Tabletop Start: ${summary.tabletop_started_at}`,
      `- Tabletop Finish: ${summary.tabletop_finished_at}`,
      `- Run ID: ${summary.run_id}`,
      `- Bundle Directory: ${summary.bundle_dir}`,
      `- Tampered Artifact Path: ${summary.tampered_artifact_path}`,
      `- Verify Before Tamper: ${JSON.stringify(summary.verify_before)}`,
      `- Verify After Tamper: ${JSON.stringify(summary.verify_after)}`,
      "",
      "Artifacts:",
      "- 01-ping.json",
      "- 02-doctor.json",
      "- 03-register-run.json",
      "- 04-submit-shell.json",
      "- 05-run-audit-export.json",
      "- 06-run-audit-verify-before.json",
      "- 07-run-audit-verify-after.json",
      "- summary.json",
    ].join("\n");
    await fsp.writeFile(path.join(outputDir, "REPORT.md"), `${report}\n`, "utf8");

    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    if (daemon.exitCode === null && daemon.signalCode === null) {
      daemon.kill("SIGTERM");
      await new Promise((resolve) => daemon.once("close", resolve));
    }
    await fsp.rm(tempRoot, { recursive: true, force: true });
    if (daemon.exitCode !== 0 && daemon.exitCode !== null) {
      daemonExitError = new Error(`Daemon exited unexpectedly.\nstdout:\n${daemonStdout}\nstderr:\n${daemonStderr}`);
    }
  }

  if (daemonExitError) {
    throw daemonExitError;
  }
}

await main();
