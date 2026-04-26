#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveCommandPath } from "./command-paths.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const daemonEntry = path.join(repoRoot, "packages", "authority-daemon", "dist", "main.js");
const cliEntry = path.join(repoRoot, "packages", "authority-cli", "dist", "main.js");
const PNPM = resolveCommandPath("pnpm");

const DEFAULT_BUDGETS = {
  action_submission_decision_ms: { p99_ms: 2500 },
  snapshot_creation_ms: { p99_ms: 2500 },
  snapshot_restore_ms: { p99_ms: 3000 },
  audit_query_ms: { p99_ms: 2000 },
  daemon_boot_ms: { max_ms: 10000 },
  cold_first_action_after_restart_ms: { max_ms: 3000 },
};

function usage() {
  return [
    "Usage: node scripts/production-readiness-benchmarks.mjs [options]",
    "",
    "Options:",
    "  --output-dir <path>  Write benchmark evidence to this directory",
    "  --iterations <n>     Sample count for each measured operation (default: 8)",
    "  --base-url <url>     Optional cloud UI URL for page response timing",
    "  --help               Show this help text",
  ].join("\n");
}

function parseArgs(argv) {
  const parsed = {
    outputDir: path.join(
      repoRoot,
      "engineering-docs",
      "release-signoff",
      "benchmarks",
      new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z"),
    ),
    iterations: 8,
    baseUrl: null,
  };

  const rest = [...argv];
  while (rest.length > 0) {
    const current = rest.shift();
    switch (current) {
      case "--output-dir":
        parsed.outputDir = path.resolve(shiftValue(rest, "--output-dir"));
        break;
      case "--iterations":
        parsed.iterations = parseInteger(shiftValue(rest, "--iterations"), "--iterations");
        break;
      case "--base-url":
        parsed.baseUrl = shiftValue(rest, "--base-url");
        break;
      case "--help":
      case "-h":
        process.stdout.write(`${usage()}\n`);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${current}`);
    }
  }

  if (parsed.iterations < 2) {
    throw new Error("--iterations must be at least 2.");
  }

  return parsed;
}

function shiftValue(args, flag) {
  const value = args.shift();
  if (!value) {
    throw new Error(`${flag} expects a value.`);
  }
  return value;
}

function parseInteger(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer.`);
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
  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result;
}

async function buildArtifacts() {
  await runRequired(PNPM, [
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

async function waitForSocket(socketPath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath)) {
      return;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for daemon socket at ${socketPath}.`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startDaemon(paths) {
  const daemon = spawn(process.execPath, [daemonEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AGENTGIT_ROOT: paths.workspaceRoot,
      INIT_CWD: paths.workspaceRoot,
      AGENTGIT_SOCKET_PATH: paths.socketPath,
      AGENTGIT_JOURNAL_PATH: path.join(paths.stateRoot, "authority.db"),
      AGENTGIT_SNAPSHOT_ROOT: path.join(paths.stateRoot, "snapshots"),
      AGENTGIT_MCP_REGISTRY_PATH: path.join(paths.stateRoot, "mcp-registry.db"),
      AGENTGIT_MCP_SECRET_STORE_PATH: path.join(paths.stateRoot, "mcp-secrets.db"),
      AGENTGIT_MCP_HOST_POLICY_PATH: path.join(paths.stateRoot, "mcp-host-policies.db"),
      AGENTGIT_MCP_CONCURRENCY_LEASE_PATH: path.join(paths.stateRoot, "mcp-concurrency.db"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  daemon.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  daemon.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  return {
    process: daemon,
    readLogs: () => ({ stdout, stderr }),
  };
}

async function stopDaemon(handle) {
  if (!handle || handle.process.exitCode !== null || handle.process.signalCode !== null) {
    return;
  }
  handle.process.kill("SIGTERM");
  await new Promise((resolve) => handle.process.once("close", resolve));
}

async function runCli(args, paths) {
  const result = await runRequired(process.execPath, [
    cliEntry,
    "--json",
    "--socket-path",
    paths.socketPath,
    "--workspace-root",
    paths.workspaceRoot,
    ...args,
  ]);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `CLI command did not emit JSON: ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\ncause: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function measure(fn) {
  const started = performance.now();
  const value = await fn();
  return {
    duration_ms: performance.now() - started,
    value,
  };
}

export function percentile(values, percent) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil((percent / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

export function summarizeSamples(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  if (clean.length === 0) {
    return {
      count: 0,
      min_ms: null,
      p50_ms: null,
      p95_ms: null,
      p99_ms: null,
      max_ms: null,
    };
  }

  return {
    count: clean.length,
    min_ms: roundNumber(Math.min(...clean)),
    p50_ms: roundNumber(percentile(clean, 50)),
    p95_ms: roundNumber(percentile(clean, 95)),
    p99_ms: roundNumber(percentile(clean, 99)),
    max_ms: roundNumber(Math.max(...clean)),
  };
}

export function evaluateBenchmarkBudgets(summary, budgets = DEFAULT_BUDGETS) {
  const results = [];
  for (const [metric, budget] of Object.entries(budgets)) {
    if ("p99_ms" in budget) {
      const actual = summary.latency?.[metric]?.p99_ms;
      results.push({
        metric,
        budget: "p99_ms",
        threshold_ms: budget.p99_ms,
        actual_ms: actual ?? null,
        ok: typeof actual === "number" && actual <= budget.p99_ms,
      });
      continue;
    }

    const actual = summary.cold_start?.[metric] ?? summary.latency?.[metric]?.max_ms;
    results.push({
      metric,
      budget: "max_ms",
      threshold_ms: budget.max_ms,
      actual_ms: actual ?? null,
      ok: typeof actual === "number" && actual <= budget.max_ms,
    });
  }
  return results;
}

function roundNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(2)) : value;
}

async function sampleProcess(pid, label) {
  if (!pid) {
    return { label, pid: null, rss_mb: null, cpu_percent: null };
  }

  const result = await runCommand("ps", ["-o", "rss=", "-o", "%cpu=", "-p", String(pid)]);
  const [rssRaw, cpuRaw] = result.stdout.split(/\s+/u).filter(Boolean);
  const rssKb = Number.parseFloat(rssRaw);
  const cpuPercent = Number.parseFloat(cpuRaw);
  return {
    label,
    pid,
    rss_mb: Number.isFinite(rssKb) ? roundNumber(rssKb / 1024) : null,
    cpu_percent: Number.isFinite(cpuPercent) ? roundNumber(cpuPercent) : null,
  };
}

async function measurePageResponse(baseUrl) {
  if (!baseUrl) {
    return {
      status: "skipped",
      reason: "No --base-url was supplied; browser/page render latency needs a hosted local or deployed cloud URL.",
    };
  }

  const url = new URL("/app/audit", baseUrl).toString();
  const started = performance.now();
  const response = await fetch(url, { redirect: "manual" });
  const responseMs = performance.now() - started;
  return {
    status: response.ok || response.status < 400 ? "measured" : "failed",
    url,
    status_code: response.status,
    page_response_ms: roundNumber(responseMs),
    note: "This is HTTP page response timing, not visual render completion. Browser-render p95/p99 belongs in the deployed browser matrix.",
  };
}

export async function runBenchmarks(options) {
  await fsp.rm(options.outputDir, { recursive: true, force: true });
  await fsp.mkdir(options.outputDir, { recursive: true });
  await buildArtifacts();

  const tempBase = process.platform === "win32" ? os.tmpdir() : "/tmp";
  const tempRoot = await fsp.mkdtemp(path.join(tempBase, "agentgit-bench-"));
  const paths = {
    tempRoot,
    workspaceRoot: path.join(tempRoot, "workspace"),
    stateRoot: path.join(tempRoot, "state"),
    socketPath: path.join(tempRoot, "authority.sock"),
  };
  await fsp.mkdir(paths.workspaceRoot, { recursive: true });
  await fsp.mkdir(paths.stateRoot, { recursive: true });

  const samples = {
    action_submission_decision_ms: [],
    snapshot_creation_ms: [],
    snapshot_restore_ms: [],
    audit_query_ms: [],
  };
  const resourceSamples = [];
  let daemon = null;

  try {
    daemon = startDaemon(paths);
    const bootMeasurement = await measure(() => waitForSocket(paths.socketPath));
    resourceSamples.push(await sampleProcess(daemon.process.pid, "after_boot"));

    const register = await measure(() => runCli(["register-run", "production-readiness-benchmark"], paths));
    const runId = register.value.run_id;
    if (typeof runId !== "string" || runId.length === 0) {
      throw new Error("register-run did not return a run_id.");
    }

    const firstAction = await measure(() =>
      runCli(["submit-filesystem-write", runId, "bench-first.txt", "benchmark-first\n"], paths),
    );

    const actionStart = performance.now();
    for (let index = 0; index < options.iterations; index += 1) {
      const action = await measure(() =>
        runCli(["submit-filesystem-write", runId, `bench-action-${index}.txt`, `benchmark-action-${index}\n`], paths),
      );
      samples.action_submission_decision_ms.push(action.duration_ms);
    }
    const actionElapsedSec = (performance.now() - actionStart) / 1000;
    resourceSamples.push(await sampleProcess(daemon.process.pid, "after_actions"));

    const snapshotStart = performance.now();
    for (let index = 0; index < options.iterations; index += 1) {
      const checkpoint = await measure(() =>
        runCli(["create-run-checkpoint", runId, "hard_checkpoint", `benchmark checkpoint ${index}`], paths),
      );
      samples.snapshot_creation_ms.push(checkpoint.duration_ms);
      const runCheckpoint = checkpoint.value.run_checkpoint;
      if (typeof runCheckpoint !== "string" || runCheckpoint.length === 0) {
        throw new Error("create-run-checkpoint did not return run_checkpoint.");
      }
      await runCli(["submit-filesystem-write", runId, `bench-after-checkpoint-${index}.txt`, `post-${index}\n`], paths);
      const restore = await measure(() => runCli(["execute-recovery", runCheckpoint], paths));
      samples.snapshot_restore_ms.push(restore.duration_ms);
    }
    const snapshotElapsedSec = (performance.now() - snapshotStart) / 1000;
    resourceSamples.push(await sampleProcess(daemon.process.pid, "after_snapshots_and_restores"));

    for (let index = 0; index < options.iterations; index += 1) {
      const audit = await measure(() =>
        index % 2 === 0 ? runCli(["run-summary", runId], paths) : runCli(["timeline", runId, "internal"], paths),
      );
      samples.audit_query_ms.push(audit.duration_ms);
    }
    resourceSamples.push(await sampleProcess(daemon.process.pid, "after_audit_queries"));

    await stopDaemon(daemon);
    daemon = null;
    await fsp.rm(paths.socketPath, { force: true });

    const restartedDaemon = startDaemon(paths);
    daemon = restartedDaemon;
    await waitForSocket(paths.socketPath);
    const coldFirstAction = await measure(() =>
      runCli(["submit-filesystem-write", runId, "bench-after-restart.txt", "after-restart\n"], paths),
    );
    resourceSamples.push(await sampleProcess(daemon.process.pid, "after_restart_first_action"));

    const pageResponse = await measurePageResponse(options.baseUrl);
    const summary = {
      ok: true,
      generated_at: new Date().toISOString(),
      iterations: options.iterations,
      latency: {
        action_submission_decision_ms: summarizeSamples(samples.action_submission_decision_ms),
        snapshot_creation_ms: summarizeSamples(samples.snapshot_creation_ms),
        snapshot_restore_ms: summarizeSamples(samples.snapshot_restore_ms),
        audit_query_ms: summarizeSamples(samples.audit_query_ms),
      },
      throughput: {
        actions_per_second: roundNumber(options.iterations / actionElapsedSec),
        snapshots_per_minute: roundNumber((options.iterations / snapshotElapsedSec) * 60),
      },
      cold_start: {
        daemon_boot_ms: roundNumber(bootMeasurement.duration_ms),
        cold_first_action_after_restart_ms: roundNumber(coldFirstAction.duration_ms),
        first_action_after_boot_ms: roundNumber(firstAction.duration_ms),
      },
      page_response: pageResponse,
      resource_samples: resourceSamples,
      budgets: DEFAULT_BUDGETS,
      budget_results: [],
      output_dir: options.outputDir,
      temp_workspace: paths.workspaceRoot,
    };
    summary.budget_results = evaluateBenchmarkBudgets(summary);
    summary.ok = summary.budget_results.every((result) => result.ok);

    await writeJson(path.join(options.outputDir, "summary.json"), summary);
    await fsp.writeFile(path.join(options.outputDir, "REPORT.md"), buildReport(summary), "utf8");
    return summary;
  } finally {
    await stopDaemon(daemon);
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

function buildReport(summary) {
  const lines = [
    "# Production Readiness Benchmarks",
    "",
    `- Status: ${summary.ok ? "PASS" : "FAIL"}`,
    `- Generated: ${summary.generated_at}`,
    `- Iterations: ${summary.iterations}`,
    "",
    "## Latency Percentiles",
    "",
    "| Operation | Count | p50 ms | p95 ms | p99 ms | Max ms |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
  ];

  for (const [metric, values] of Object.entries(summary.latency)) {
    lines.push(
      `| ${metric} | ${values.count} | ${values.p50_ms ?? "n/a"} | ${values.p95_ms ?? "n/a"} | ${
        values.p99_ms ?? "n/a"
      } | ${values.max_ms ?? "n/a"} |`,
    );
  }

  lines.push(
    "",
    "## Throughput",
    "",
    `- Actions per second: ${summary.throughput.actions_per_second}`,
    `- Snapshots per minute: ${summary.throughput.snapshots_per_minute}`,
    "",
    "## Cold Start",
    "",
    `- Daemon boot ms: ${summary.cold_start.daemon_boot_ms}`,
    `- First action after boot ms: ${summary.cold_start.first_action_after_boot_ms}`,
    `- First action after restart ms: ${summary.cold_start.cold_first_action_after_restart_ms}`,
    "",
    "## Page Response",
    "",
    `- Status: ${summary.page_response.status}`,
    `- Page response ms: ${summary.page_response.page_response_ms ?? "n/a"}`,
    `- Note: ${summary.page_response.note ?? summary.page_response.reason ?? "n/a"}`,
    "",
    "## Budget Results",
    "",
    "| Metric | Budget | Threshold ms | Actual ms | Status |",
    "| --- | --- | ---: | ---: | --- |",
  );

  for (const result of summary.budget_results) {
    lines.push(
      `| ${result.metric} | ${result.budget} | ${result.threshold_ms} | ${result.actual_ms ?? "n/a"} | ${
        result.ok ? "PASS" : "FAIL"
      } |`,
    );
  }

  lines.push(
    "",
    "## Resource Samples",
    "",
    "| Label | RSS MB | CPU % |",
    "| --- | ---: | ---: |",
  );
  for (const sample of summary.resource_samples) {
    lines.push(`| ${sample.label} | ${sample.rss_mb ?? "n/a"} | ${sample.cpu_percent ?? "n/a"} |`);
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function writeJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const summary = await runBenchmarks(args);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (!summary.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
