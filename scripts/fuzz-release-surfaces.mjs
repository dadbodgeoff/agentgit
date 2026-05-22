#!/usr/bin/env node

import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  CLOUD_SYNC_SCHEMA_VERSION,
  ConnectorCommandAckRequestSchema,
  ConnectorCommandPullRequestSchema,
  ConnectorEventBatchRequestSchema,
  ConnectorRegistrationRequestSchema,
} from "../packages/cloud-sync-protocol/dist/index.js";
import { verifyRunAuditBundle } from "../packages/authority-cli/dist/audit/verify.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(repoRoot, "packages", "authority-cli", "dist", "main.js");

function usage() {
  return [
    "Usage: node scripts/fuzz-release-surfaces.mjs [options]",
    "",
    "Options:",
    "  --output-dir <path>  Write fuzz evidence to this directory",
    "  --iterations <n>     Mutation count per corpus entry (default: 32)",
    "  --seed <n>           Deterministic mutation seed (default: 2026042601)",
    "  --help               Show this help text",
  ].join("\n");
}

function parseArgs(argv) {
  const parsed = {
    outputDir: path.join(repoRoot, "engineering-docs", "release-signoff", "fuzzing", new Date().toISOString()),
    iterations: 32,
    seed: 2026042601,
  };

  const rest = [...argv];
  while (rest.length > 0) {
    const current = rest.shift();
    switch (current) {
      case "--output-dir":
        parsed.outputDir = path.resolve(shiftValue(rest, "--output-dir"));
        break;
      case "--iterations":
        parsed.iterations = parsePositiveInteger(shiftValue(rest, "--iterations"), "--iterations");
        break;
      case "--seed":
        parsed.seed = parsePositiveInteger(shiftValue(rest, "--seed"), "--seed");
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

  return parsed;
}

function shiftValue(args, flag) {
  const value = args.shift();
  if (!value) {
    throw new Error(`${flag} expects a value.`);
  }
  return value;
}

function parsePositiveInteger(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function createRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function choose(rng, values) {
  return values[Math.floor(rng() * values.length)];
}

function mutateValue(value, rng, depth = 0) {
  if (depth > 4) {
    return choose(rng, [null, "", 0, true, []]);
  }
  if (Array.isArray(value)) {
    const mutated = value.map((entry) => mutateValue(entry, rng, depth + 1));
    if (rng() < 0.35) {
      mutated.push(choose(rng, [null, "extra", 999999, { unexpected: true }]));
    }
    if (mutated.length > 0 && rng() < 0.35) {
      mutated.splice(Math.floor(rng() * mutated.length), 1);
    }
    return mutated;
  }
  if (value && typeof value === "object") {
    const mutated = { ...value };
    const keys = Object.keys(mutated);
    if (keys.length > 0) {
      const targetKey = choose(rng, keys);
      if (rng() < 0.5) {
        delete mutated[targetKey];
      } else {
        mutated[targetKey] = mutateValue(mutated[targetKey], rng, depth + 1);
      }
    }
    if (rng() < 0.35) {
      mutated[choose(rng, ["__proto__", "constructor", "extra", "payload"])] = choose(rng, [
        "x".repeat(Math.floor(rng() * 512)),
        Number.MAX_SAFE_INTEGER,
        { nested: "value" },
        ["array"],
      ]);
    }
    return mutated;
  }
  if (typeof value === "string") {
    return choose(rng, ["", "x".repeat(Math.floor(rng() * 1024)), "../outside", "\u0000", "2026-not-a-date"]);
  }
  if (typeof value === "number") {
    return choose(rng, [Number.NaN, -1, 0, Number.MAX_SAFE_INTEGER]);
  }
  if (typeof value === "boolean") {
    return !value;
  }
  return choose(rng, [null, "mutated", 1, false, []]);
}

function syncCorpus() {
  const timestamp = "2026-04-26T12:00:00.000Z";
  const repository = {
    provider: "github",
    repo: {
      owner: "agentgit",
      name: "agentgit",
    },
    remoteUrl: "https://github.com/dadbodgeoff/agentgit.git",
    defaultBranch: "main",
    currentBranch: "main",
    headSha: "1234567",
    isDirty: false,
    aheadBy: 0,
    behindBy: 0,
    workspaceRoot: "/tmp/agentgit",
    lastFetchedAt: timestamp,
  };

  return [
    {
      name: "connector-registration",
      schema: ConnectorRegistrationRequestSchema,
      value: {
        schemaVersion: CLOUD_SYNC_SCHEMA_VERSION,
        workspaceId: "ws_01",
        connectorName: "local connector",
        machineName: "build-host",
        connectorVersion: "0.1.0",
        platform: {
          os: "darwin",
          arch: "arm64",
          hostname: "build-host",
        },
        capabilities: ["repo_state_sync", "run_event_sync"],
        repository,
      },
    },
    {
      name: "event-batch",
      schema: ConnectorEventBatchRequestSchema,
      value: {
        schemaVersion: CLOUD_SYNC_SCHEMA_VERSION,
        requestId: "req_01",
        connectorId: "conn_01",
        sentAt: timestamp,
        events: [
          {
            schemaVersion: CLOUD_SYNC_SCHEMA_VERSION,
            eventId: "evt_01",
            connectorId: "conn_01",
            workspaceId: "ws_01",
            repository: { owner: "agentgit", name: "agentgit" },
            sequence: 1,
            occurredAt: timestamp,
            type: "repo_state.snapshot",
            payload: { branch: "main" },
          },
        ],
      },
    },
    {
      name: "command-pull",
      schema: ConnectorCommandPullRequestSchema,
      value: {
        schemaVersion: CLOUD_SYNC_SCHEMA_VERSION,
        requestId: "req_pull_01",
        connectorId: "conn_01",
        sentAt: timestamp,
      },
    },
    {
      name: "command-ack",
      schema: ConnectorCommandAckRequestSchema,
      value: {
        schemaVersion: CLOUD_SYNC_SCHEMA_VERSION,
        requestId: "req_ack_01",
        connectorId: "conn_01",
        commandId: "cmd_01",
        acknowledgedAt: timestamp,
        status: "acked",
      },
    },
  ];
}

async function fuzzSyncSchemas(options, rng) {
  const results = [];
  for (const entry of syncCorpus()) {
    let accepted = 0;
    let rejected = 0;
    const failures = [];
    for (let index = 0; index < options.iterations; index += 1) {
      const mutated = mutateValue(clone(entry.value), rng);
      try {
        const parsed = entry.schema.safeParse(mutated);
        if (parsed.success) {
          accepted += 1;
        } else {
          rejected += 1;
        }
      } catch (error) {
        failures.push({
          index,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    results.push({
      surface: entry.name,
      accepted,
      rejected,
      failures,
    });
  }
  return results;
}

async function fuzzAuditBundleVerifier(options, rng) {
  const bundleRoot = path.join(options.outputDir, "audit-bundle-corpus");
  await fsp.mkdir(bundleRoot, { recursive: true });
  let verified = 0;
  let rejected = 0;
  const failures = [];

  for (let index = 0; index < options.iterations; index += 1) {
    const bundleDir = path.join(bundleRoot, `bundle-${String(index).padStart(3, "0")}`);
    await fsp.mkdir(bundleDir, { recursive: true });
    const manifest = mutateValue(
      {
        manifest_version: "agentgit.run-audit-bundle.v2",
        run_id: `run_${index}`,
        exported_artifacts: [],
      },
      rng,
    );
    const manifestContent = rng() < 0.2 ? "{ malformed json" : JSON.stringify(manifest);
    await fsp.writeFile(path.join(bundleDir, "manifest.json"), manifestContent, "utf8");

    try {
      const result = verifyRunAuditBundle(bundleDir);
      if (result.verified) {
        verified += 1;
      } else {
        rejected += 1;
      }
    } catch (error) {
      failures.push({
        index,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    surface: "audit-bundle-verifier",
    verified,
    rejected,
    failures,
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
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 5000);
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
      clearTimeout(timeout);
      resolve({
        code: code ?? -1,
        signal: signal ?? null,
        stdout,
        stderr,
      });
    });
  });
}

async function fuzzCliArguments(options, rng) {
  const argsCorpus = [
    ["--json"],
    ["--json", "--connect-timeout-ms", "1", "--max-connect-retries", "0", "run-summary", "../outside"],
    ["--json", "policy", "explain", "{bad json"],
    ["--json", "run-audit-verify", path.join(options.outputDir, "missing-bundle")],
    ["--json", "--unknown-flag"],
  ];
  const results = [];
  const failures = [];

  for (let index = 0; index < options.iterations; index += 1) {
    const baseArgs = clone(choose(rng, argsCorpus));
    if (rng() < 0.5) {
      baseArgs.push(choose(rng, ["", "../outside", "{", "x".repeat(512)]));
    }
    const result = await runCommand(process.execPath, [cliEntry, ...baseArgs], { timeoutMs: 5000 });
    const combined = `${result.stdout}\n${result.stderr}`;
    const crashed =
      result.signal === "SIGKILL" ||
      /(?:TypeError|ReferenceError|SyntaxError):/u.test(combined) ||
      combined.includes("UnhandledPromiseRejection");
    if (crashed) {
      failures.push({
        index,
        args: baseArgs,
        code: result.code,
        signal: result.signal,
        stdout: result.stdout.slice(0, 1000),
        stderr: result.stderr.slice(0, 1000),
      });
    }
    results.push({
      args: baseArgs,
      code: result.code,
      signal: result.signal,
    });
  }

  return {
    surface: "authority-cli-arguments",
    attempted: results.length,
    failures,
  };
}

async function writeJson(targetPath, value) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await fsp.writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function runFuzzing(options) {
  await fsp.rm(options.outputDir, { recursive: true, force: true });
  await fsp.mkdir(options.outputDir, { recursive: true });
  if (!fs.existsSync(cliEntry)) {
    throw new Error(`Missing built authority CLI at ${cliEntry}; run package builds before fuzzing.`);
  }

  const rng = createRng(options.seed);
  const syncResults = await fuzzSyncSchemas(options, rng);
  const auditBundle = await fuzzAuditBundleVerifier(options, rng);
  const cliArguments = await fuzzCliArguments(options, rng);
  const results = [...syncResults, auditBundle, cliArguments];
  const failures = results.flatMap((result) => result.failures ?? []);
  const summary = {
    ok: failures.length === 0,
    generated_at: new Date().toISOString(),
    seed: options.seed,
    iterations: options.iterations,
    results,
    failure_count: failures.length,
  };

  await writeJson(path.join(options.outputDir, "summary.json"), summary);
  await fsp.writeFile(
    path.join(options.outputDir, "REPORT.md"),
    [
      "# Release Surface Fuzzing",
      "",
      `- Status: ${summary.ok ? "PASS" : "FAIL"}`,
      `- Seed: ${summary.seed}`,
      `- Iterations per corpus entry: ${summary.iterations}`,
      `- Failure count: ${summary.failure_count}`,
      "",
      "## Surfaces",
      "",
      ...results.map((result) => `- ${result.surface}: failures=${result.failures?.length ?? 0}`),
      "",
    ].join("\n"),
    "utf8",
  );
  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const summary = await runFuzzing(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (!summary.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
