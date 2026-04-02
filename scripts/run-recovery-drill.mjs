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
  "recovery-drills",
  `${new Date().toISOString().slice(0, 10)}-mvp-recovery-drill`,
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

async function runCli(args, options) {
  const result = await runCommand(
    process.execPath,
    [cliEntry, "--json", "--socket-path", options.socketPath, "--workspace-root", options.workspaceRoot, ...args],
    {
      cwd: repoRoot,
    },
  );
  const json = parseJsonOutput(result, `cli ${args.join(" ")}`);
  return {
    raw: result,
    json,
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
  const tempRoot = await fsp.mkdtemp(path.join(tempBase, "agentgit-recovery-drill-"));
  const workspaceRoot = path.join(tempRoot, "workspace");
  const stateRoot = path.join(tempRoot, "state");
  const socketPath = path.join(tempRoot, "authority.sock");
  const journalPath = path.join(stateRoot, "authority.db");
  const snapshotRootPath = path.join(stateRoot, "snapshots");
  const mcpRegistryPath = path.join(stateRoot, "mcp-registry.db");
  const mcpSecretStorePath = path.join(stateRoot, "mcp-secrets.db");
  const mcpHostPolicyPath = path.join(stateRoot, "mcp-host-policies.db");
  const mcpConcurrencyLeasePath = path.join(stateRoot, "mcp-concurrency.db");
  const targetRelativePath = "recovery-drill.txt";
  const targetPath = path.join(workspaceRoot, targetRelativePath);

  await fsp.mkdir(workspaceRoot, { recursive: true });
  await fsp.mkdir(stateRoot, { recursive: true });
  await fsp.rm(outputDir, { recursive: true, force: true });
  await fsp.mkdir(outputDir, { recursive: true });

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

  const drillStartedAt = new Date();
  try {
    await waitForSocket(socketPath);

    const ping = await runCli(["ping"], { socketPath, workspaceRoot });
    const doctor = await runCli(["doctor"], { socketPath, workspaceRoot });
    const registerRun = await runCli(["register-run", "recovery-drill"], { socketPath, workspaceRoot });
    const runId = registerRun.json.run_id;
    if (typeof runId !== "string" || runId.length === 0) {
      throw new Error("register-run did not return a run_id.");
    }

    const writeResult = await runCli(["submit-filesystem-write", runId, targetRelativePath, "drill-v1"], {
      socketPath,
      workspaceRoot,
    });
    const deleteResult = await runCli(["submit-filesystem-delete", runId, targetRelativePath], {
      socketPath,
      workspaceRoot,
    });

    const actionId = deleteResult.json?.action?.action_id;
    if (typeof actionId !== "string" || actionId.length === 0) {
      throw new Error("submit-filesystem-delete did not return an action_id.");
    }

    const timelineBefore = await runCli(["timeline", runId, "internal"], {
      socketPath,
      workspaceRoot,
    });

    const recoveryStartMs = Date.now();
    const recoveryPlan = await runCli(["plan-recovery", actionId], {
      socketPath,
      workspaceRoot,
    });
    const recoveryExecute = await runCli(["execute-recovery", actionId], {
      socketPath,
      workspaceRoot,
    });
    const recoveryEndMs = Date.now();

    const runSummary = await runCli(["run-summary", runId], {
      socketPath,
      workspaceRoot,
    });
    const timelineAfter = await runCli(["timeline", runId, "internal"], {
      socketPath,
      workspaceRoot,
    });

    const fileExistsAfterRecovery = fs.existsSync(targetPath);
    const fileContents = fileExistsAfterRecovery ? await fsp.readFile(targetPath, "utf8") : null;

    await Promise.all([
      writeJson(path.join(outputDir, "01-ping.json"), ping.json),
      writeJson(path.join(outputDir, "02-doctor.json"), doctor.json),
      writeJson(path.join(outputDir, "03-register-run.json"), registerRun.json),
      writeJson(path.join(outputDir, "04-submit-filesystem-write.json"), writeResult.json),
      writeJson(path.join(outputDir, "05-submit-filesystem-delete.json"), deleteResult.json),
      writeJson(path.join(outputDir, "06-timeline-before.json"), timelineBefore.json),
      writeJson(path.join(outputDir, "07-plan-recovery.json"), recoveryPlan.json),
      writeJson(path.join(outputDir, "08-execute-recovery.json"), recoveryExecute.json),
      writeJson(path.join(outputDir, "09-run-summary.json"), runSummary.json),
      writeJson(path.join(outputDir, "10-timeline-after.json"), timelineAfter.json),
    ]);

    const drillFinishedAt = new Date();
    const summary = {
      ok: true,
      drill_started_at: drillStartedAt.toISOString(),
      drill_finished_at: drillFinishedAt.toISOString(),
      rto_ms: recoveryEndMs - recoveryStartMs,
      rpo_target: "latest valid action boundary",
      run_id: runId,
      recovery_target_action_id: actionId,
      recovery_strategy: recoveryPlan.json?.recovery_plan?.strategy ?? null,
      restored: recoveryExecute.json?.restored ?? null,
      file_exists_after_recovery: fileExistsAfterRecovery,
      file_contents_after_recovery: fileContents,
      output_dir: outputDir,
      temp_workspace: workspaceRoot,
    };

    await writeJson(path.join(outputDir, "summary.json"), summary);

    const report = [
      "# Recovery Drill Evidence",
      "",
      `- Status: PASS`,
      `- Drill Start: ${summary.drill_started_at}`,
      `- Drill Finish: ${summary.drill_finished_at}`,
      `- Measured RTO (ms): ${summary.rto_ms}`,
      `- RPO Target: ${summary.rpo_target}`,
      `- Run ID: ${summary.run_id}`,
      `- Recovery Target Action ID: ${summary.recovery_target_action_id}`,
      `- Recovery Strategy: ${summary.recovery_strategy}`,
      `- Restored: ${summary.restored}`,
      `- Target Exists After Recovery: ${summary.file_exists_after_recovery}`,
      `- Target Content After Recovery: ${JSON.stringify(summary.file_contents_after_recovery)}`,
      "",
      "Artifacts:",
      "- 01-ping.json",
      "- 02-doctor.json",
      "- 03-register-run.json",
      "- 04-submit-filesystem-write.json",
      "- 05-submit-filesystem-delete.json",
      "- 06-timeline-before.json",
      "- 07-plan-recovery.json",
      "- 08-execute-recovery.json",
      "- 09-run-summary.json",
      "- 10-timeline-after.json",
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
