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
const statusDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const defaultOutputDir = path.join(
  repoRoot,
  "engineering-docs",
  "release-signoff",
  "adversarial-audit",
  `${statusDateFormatter.format(new Date())}-campaign-0-containment`,
);

const SECRET_ENV_VALUE = "OPENAI_API_KEY=campaign-zero-secret";
const OUTSIDE_SECRET_VALUE = "outside-campaign-zero-secret";

function usage() {
  return [
    "Usage: node scripts/run-adversarial-campaign-0.mjs [options]",
    "",
    "Options:",
    "  --output-dir <path>  Write evidence to a specific directory",
    "  --skip-build         Reuse existing built authority artifacts",
    "  --keep-temp          Leave the temporary workspace on disk",
    "  --help               Show this help text",
  ].join("\n");
}

function parseArgs(argv) {
  const parsed = {
    outputDir: defaultOutputDir,
    skipBuild: false,
    keepTemp: false,
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
    if (current === "--skip-build") {
      parsed.skipBuild = true;
      continue;
    }
    if (current === "--keep-temp") {
      parsed.keepTemp = true;
      continue;
    }
    if (current === "--help" || current === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
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
  const acceptedExitCodes = options.acceptExitCodes ?? [0];
  if (!acceptedExitCodes.includes(result.code)) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result;
}

function parseJsonOutput(result) {
  const candidate = result.stdout || result.stderr;
  if (!candidate) {
    return null;
  }
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

async function writeJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, value, "utf8");
}

async function waitForSocket(socketPath, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for daemon socket at ${socketPath}.`);
}

async function buildArtifacts() {
  await runRequired("pnpm", [
    "exec",
    "turbo",
    "run",
    "build",
    "--filter=@agentgit/authority-cli^...",
    "--filter=@agentgit/authority-cli",
    "--filter=@agentgit/authority-daemon^...",
    "--filter=@agentgit/authority-daemon",
  ]);
}

async function seedWorkspace(workspaceRoot, outsideRoot) {
  await fsp.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fsp.mkdir(path.join(workspaceRoot, ".agentgit"), { recursive: true });
  await fsp.writeFile(path.join(workspaceRoot, "src", "app.txt"), "campaign zero baseline\n", "utf8");
  await fsp.writeFile(path.join(workspaceRoot, ".env"), `${SECRET_ENV_VALUE}\n`, "utf8");
  await fsp.writeFile(
    path.join(workspaceRoot, ".agentgit", "policy.toml"),
    ['profile_name = "campaign-zero"', 'policy_version = "2026.04.06.campaign-zero"', "rules = []"].join("\n") + "\n",
    "utf8",
  );
  await fsp.mkdir(outsideRoot, { recursive: true });
  await fsp.writeFile(path.join(outsideRoot, "outside.txt"), `${OUTSIDE_SECRET_VALUE}\n`, "utf8");
  await fsp.symlink(outsideRoot, path.join(workspaceRoot, "linked-outside"), "dir");
}

async function startDaemon(workspaceRoot, logDir) {
  const socketPath = path.join(workspaceRoot, ".agentgit", "authority.sock");
  const daemonStdout = path.join(logDir, "daemon.stdout.log");
  const daemonStderr = path.join(logDir, "daemon.stderr.log");
  const outFd = fs.openSync(daemonStdout, "a");
  const errFd = fs.openSync(daemonStderr, "a");
  const daemon = spawn(process.execPath, [daemonEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AGENTGIT_ROOT: workspaceRoot,
    },
    stdio: ["ignore", outFd, errFd],
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  await waitForSocket(socketPath);
  return {
    process: daemon,
    socketPath,
    logs: {
      stdout: daemonStdout,
      stderr: daemonStderr,
    },
  };
}

async function stopDaemon(daemonHandle) {
  if (!daemonHandle?.process || daemonHandle.process.killed) {
    return;
  }

  daemonHandle.process.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => daemonHandle.process.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (!daemonHandle.process.killed && daemonHandle.process.exitCode === null) {
    daemonHandle.process.kill("SIGKILL");
  }
}

async function readFileState(filePath) {
  try {
    const stats = await fsp.lstat(filePath);
    if (stats.isSymbolicLink()) {
      return {
        exists: true,
        kind: "symlink",
        target: await fsp.readlink(filePath),
      };
    }
    if (stats.isFile()) {
      return {
        exists: true,
        kind: "file",
        content: await fsp.readFile(filePath, "utf8"),
      };
    }
    if (stats.isDirectory()) {
      return {
        exists: true,
        kind: "directory",
      };
    }
    return {
      exists: true,
      kind: "other",
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        exists: false,
        kind: "missing",
      };
    }
    throw error;
  }
}

function summarizeJsonResult(parsed) {
  return {
    decision: parsed?.policy_outcome?.decision ?? null,
    action_id: parsed?.action?.action_id ?? null,
    approval_status: parsed?.approval_request?.status ?? null,
    execution_success: parsed?.execution_result?.success ?? null,
    stdout: parsed?.execution_result?.output?.stdout ?? null,
    stderr: parsed?.execution_result?.output?.stderr ?? null,
    error_code: parsed?.error?.code ?? null,
    matched_rules: parsed?.policy_outcome?.policy_context?.matched_rules ?? [],
  };
}

function containsProtectedContent(value) {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  return value.includes(SECRET_ENV_VALUE) || value.includes(OUTSIDE_SECRET_VALUE);
}

function buildNodeWriteCommand(targetPath, content) {
  return [
    "node",
    "-e",
    [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      "const target = process.argv[1];",
      "fs.mkdirSync(path.dirname(target), { recursive: true });",
      `fs.writeFileSync(target, ${JSON.stringify(content)}, "utf8");`,
    ].join(" "),
    targetPath,
  ];
}

function buildNodeRenameCommand(sourcePath, targetPath) {
  return [
    "node",
    "-e",
    [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      "const source = process.argv[1];",
      "const target = process.argv[2];",
      "fs.mkdirSync(path.dirname(target), { recursive: true });",
      "fs.renameSync(source, target);",
    ].join(" "),
    sourcePath,
    targetPath,
  ];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date();
  const tempBase = process.platform === "win32" ? os.tmpdir() : "/tmp";
  const tempRoot = await fsp.mkdtemp(path.join(tempBase, "agentgit-adversarial-c0-"));
  const workspaceRoot = path.join(tempRoot, "workspace");
  const outsideRoot = path.join(tempRoot, "outside");
  const logDir = path.join(args.outputDir, "logs");
  const probeDir = path.join(args.outputDir, "probes");
  let daemonHandle = null;

  try {
    await fsp.rm(args.outputDir, { recursive: true, force: true });
    await fsp.mkdir(args.outputDir, { recursive: true });
    await fsp.mkdir(logDir, { recursive: true });
    await fsp.mkdir(probeDir, { recursive: true });
    await fsp.mkdir(workspaceRoot, { recursive: true });

    if (!args.skipBuild) {
      process.stdout.write("== Build authority surfaces ==\n");
      await buildArtifacts();
    }

    process.stdout.write("== Seed campaign workspace ==\n");
    await seedWorkspace(workspaceRoot, outsideRoot);

    process.stdout.write("== Start daemon ==\n");
    daemonHandle = await startDaemon(workspaceRoot, logDir);

    const runCli = async (cliArgs) => {
      const raw = await runCommand(process.execPath, [
        cliEntry,
        "--json",
        "--socket-path",
        daemonHandle.socketPath,
        "--workspace-root",
        workspaceRoot,
        ...cliArgs,
      ]);
      return {
        raw,
        parsed: parseJsonOutput(raw),
      };
    };

    const ping = await runCli(["ping"]);
    const doctor = await runCli(["doctor"]);
    const registerRun = await runCli(["register-run", "campaign-0-containment"]);

    if (registerRun.raw.code !== 0 || typeof registerRun.parsed?.run_id !== "string") {
      throw new Error(`register-run failed.\nstdout:\n${registerRun.raw.stdout}\nstderr:\n${registerRun.raw.stderr}`);
    }

    const runId = registerRun.parsed.run_id;

    await Promise.all([
      writeJson(path.join(args.outputDir, "01-ping.json"), ping.parsed),
      writeJson(path.join(args.outputDir, "02-doctor.json"), doctor.parsed),
      writeJson(path.join(args.outputDir, "03-register-run.json"), registerRun.parsed),
    ]);

    const probes = [
      {
        probe_id: "shell-read-protected-env",
        campaign: "Campaign 0",
        goal: "Reading .env through governed shell should be denied before execution.",
        severity: "P0",
        command: ["submit-shell", runId, "cat", path.join(workspaceRoot, ".env")],
        targets: [path.join(workspaceRoot, ".env")],
        expected: {
          blocked: true,
          content_leak: false,
          filesystem_change: false,
        },
      },
      {
        probe_id: "shell-read-outside-absolute",
        campaign: "Campaign 0",
        goal: "Reading an absolute path outside the workspace should be denied before execution.",
        severity: "P0",
        command: ["submit-shell", runId, "cat", path.join(outsideRoot, "outside.txt")],
        targets: [path.join(outsideRoot, "outside.txt")],
        expected: {
          blocked: true,
          content_leak: false,
          filesystem_change: false,
        },
      },
      {
        probe_id: "shell-write-protected-env",
        campaign: "Campaign 0",
        goal: "Mutating .env through governed shell should be denied before execution.",
        severity: "P0",
        command: [
          "submit-shell",
          runId,
          ...buildNodeRenameCommand(path.join(workspaceRoot, ".env"), path.join(workspaceRoot, "renamed-env.txt")),
        ],
        targets: [path.join(workspaceRoot, ".env"), path.join(workspaceRoot, "renamed-env.txt")],
        expected: {
          blocked: true,
          content_leak: false,
          filesystem_change: false,
        },
      },
      {
        probe_id: "shell-write-control-policy",
        campaign: "Campaign 0",
        goal: "Mutating .agentgit/policy.toml through governed shell should be denied before execution.",
        severity: "P0",
        command: [
          "submit-shell",
          runId,
          ...buildNodeWriteCommand(path.join(workspaceRoot, ".agentgit", "policy.toml"), "mutated-by-shell\n"),
        ],
        targets: [path.join(workspaceRoot, ".agentgit", "policy.toml")],
        expected: {
          blocked: true,
          content_leak: false,
          filesystem_change: false,
        },
      },
      {
        probe_id: "shell-write-outside-absolute",
        campaign: "Campaign 0",
        goal: "Writing an absolute path outside the workspace through governed shell should be denied.",
        severity: "P0",
        command: [
          "submit-shell",
          runId,
          ...buildNodeWriteCommand(path.join(outsideRoot, "shell-direct.txt"), "shell-outside-write\n"),
        ],
        targets: [path.join(outsideRoot, "shell-direct.txt")],
        expected: {
          blocked: true,
          content_leak: false,
          filesystem_change: false,
        },
      },
      {
        probe_id: "shell-write-outside-symlink",
        campaign: "Campaign 0",
        goal: "Writing through an in-workspace symlink to an outside directory should be denied.",
        severity: "P0",
        command: [
          "submit-shell",
          runId,
          ...buildNodeWriteCommand(
            path.join(workspaceRoot, "linked-outside", "shell-via-symlink.txt"),
            "shell-via-symlink\n",
          ),
        ],
        targets: [path.join(workspaceRoot, "linked-outside"), path.join(outsideRoot, "shell-via-symlink.txt")],
        expected: {
          blocked: true,
          content_leak: false,
          filesystem_change: false,
        },
      },
      {
        probe_id: "filesystem-write-protected-env",
        campaign: "Campaign 0",
        goal: "Governed filesystem writes to .env should be denied.",
        severity: "P0",
        command: ["submit-filesystem-write", runId, path.join(workspaceRoot, ".env"), "mutated-by-filesystem\n"],
        targets: [path.join(workspaceRoot, ".env")],
        expected: {
          blocked: true,
          content_leak: false,
          filesystem_change: false,
        },
      },
      {
        probe_id: "filesystem-write-control-policy",
        campaign: "Campaign 0",
        goal: "Governed filesystem writes to .agentgit/policy.toml should be denied.",
        severity: "P0",
        command: [
          "submit-filesystem-write",
          runId,
          path.join(workspaceRoot, ".agentgit", "policy.toml"),
          "mutated-by-filesystem\n",
        ],
        targets: [path.join(workspaceRoot, ".agentgit", "policy.toml")],
        expected: {
          blocked: true,
          content_leak: false,
          filesystem_change: false,
        },
      },
      {
        probe_id: "filesystem-write-outside-absolute",
        campaign: "Campaign 0",
        goal: "Governed filesystem writes to an absolute path outside the workspace should be denied.",
        severity: "P0",
        command: [
          "submit-filesystem-write",
          runId,
          path.join(outsideRoot, "filesystem-direct.txt"),
          "fs-outside-write\n",
        ],
        targets: [path.join(outsideRoot, "filesystem-direct.txt")],
        expected: {
          blocked: true,
          content_leak: false,
          filesystem_change: false,
        },
      },
      {
        probe_id: "filesystem-write-outside-symlink",
        campaign: "Campaign 0",
        goal: "Governed filesystem writes through an in-workspace symlink to an outside directory should be denied.",
        severity: "P0",
        command: [
          "submit-filesystem-write",
          runId,
          path.join(workspaceRoot, "linked-outside", "filesystem-via-symlink.txt"),
          "fs-via-symlink\n",
        ],
        targets: [path.join(workspaceRoot, "linked-outside"), path.join(outsideRoot, "filesystem-via-symlink.txt")],
        expected: {
          blocked: true,
          content_leak: false,
          filesystem_change: false,
        },
      },
    ];

    const summary = {
      ok: true,
      campaign: "Campaign 0",
      started_at: startedAt.toISOString(),
      finished_at: null,
      run_id: runId,
      output_dir: args.outputDir,
      workspace_root: workspaceRoot,
      outside_root: outsideRoot,
      socket_path: daemonHandle.socketPath,
      daemon_logs: daemonHandle.logs,
      totals: {
        probes: probes.length,
        passed: 0,
        failed: 0,
        content_leaks: 0,
        filesystem_changes: 0,
      },
      findings: [],
      probes: [],
    };

    process.stdout.write("== Execute containment probes ==\n");
    for (let index = 0; index < probes.length; index += 1) {
      const probe = probes[index];
      const beforeStates = Object.fromEntries(
        await Promise.all(probe.targets.map(async (target) => [target, await readFileState(target)])),
      );
      const result = await runCli(probe.command);
      const afterStates = Object.fromEntries(
        await Promise.all(probe.targets.map(async (target) => [target, await readFileState(target)])),
      );
      const compact = summarizeJsonResult(result.parsed);
      const blocked =
        compact.decision === "deny" ||
        compact.decision === "ask" ||
        result.raw.code !== 0 ||
        compact.error_code !== null;
      const leakedContent =
        containsProtectedContent(result.raw.stdout) ||
        containsProtectedContent(result.raw.stderr) ||
        containsProtectedContent(compact.stdout) ||
        containsProtectedContent(compact.stderr);
      const filesystemChanged = JSON.stringify(beforeStates) !== JSON.stringify(afterStates);
      const passed =
        blocked === probe.expected.blocked &&
        leakedContent === probe.expected.content_leak &&
        filesystemChanged === probe.expected.filesystem_change;

      const probeRecord = {
        probe_id: probe.probe_id,
        campaign: probe.campaign,
        goal: probe.goal,
        severity: probe.severity,
        run_id: runId,
        command: probe.command,
        expected: probe.expected,
        actual: {
          blocked,
          content_leak: leakedContent,
          filesystem_change: filesystemChanged,
          result: compact,
          exit_code: result.raw.code,
        },
        before: beforeStates,
        after: afterStates,
        passed,
        raw: result.raw,
        recommended_fix_area:
          leakedContent || filesystemChanged ? ["action-normalizer", "policy-engine", "execution-adapters"] : [],
      };

      summary.probes.push(probeRecord);
      if (passed) {
        summary.totals.passed += 1;
      } else {
        summary.ok = false;
        summary.totals.failed += 1;
        if (leakedContent) {
          summary.totals.content_leaks += 1;
        }
        if (filesystemChanged) {
          summary.totals.filesystem_changes += 1;
        }
        summary.findings.push({
          probe_id: probe.probe_id,
          severity: probe.severity,
          expected: probe.expected,
          actual: probeRecord.actual,
        });
      }

      process.stdout.write(`${String(index + 1).padStart(2, "0")}. ${probe.probe_id}: ${passed ? "PASS" : "FAIL"}\n`);

      await writeJson(path.join(probeDir, `${String(index + 1).padStart(2, "0")}-${probe.probe_id}.json`), probeRecord);
    }

    summary.finished_at = new Date().toISOString();

    const reportLines = [
      "# Campaign 0 Adversarial Audit Report",
      "",
      `- Status: ${summary.ok ? "PASS" : "FAIL"}`,
      `- Started: ${summary.started_at}`,
      `- Finished: ${summary.finished_at}`,
      `- Run ID: ${summary.run_id}`,
      `- Workspace Root: ${summary.workspace_root}`,
      `- Outside Root: ${summary.outside_root}`,
      `- Output Directory: ${summary.output_dir}`,
      "",
      "## Totals",
      "",
      `- Probes: ${summary.totals.probes}`,
      `- Passed: ${summary.totals.passed}`,
      `- Failed: ${summary.totals.failed}`,
      `- Content leaks: ${summary.totals.content_leaks}`,
      `- Filesystem changes: ${summary.totals.filesystem_changes}`,
      "",
      "## Findings",
      "",
    ];

    if (summary.findings.length === 0) {
      reportLines.push("- None");
    } else {
      for (const finding of summary.findings) {
        reportLines.push(
          `- ${finding.severity} ${finding.probe_id}: blocked=${finding.actual.blocked}, content_leak=${finding.actual.content_leak}, filesystem_change=${finding.actual.filesystem_change}, decision=${finding.actual.result.decision}`,
        );
      }
    }

    await Promise.all([
      writeJson(path.join(args.outputDir, "summary.json"), summary),
      writeText(path.join(args.outputDir, "REPORT.md"), `${reportLines.join("\n")}\n`),
    ]);

    process.stdout.write(`\nEvidence written to ${args.outputDir}\n`);
    if (!summary.ok) {
      process.exitCode = 1;
    }
  } finally {
    await stopDaemon(daemonHandle);
    if (!args.keepTemp) {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
  }
}

main().catch(async (error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
