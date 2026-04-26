#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PASSING_STATUSES = new Set(["passed", "skipped"]);

function usage() {
  return [
    "Usage: node scripts/production-beta-qualification.mjs [options]",
    "",
    "Options:",
    "  --suite <id>             Run one suite; can be repeated",
    "  --artifact-root <path>   Write reports and suite artifacts to this directory",
    "  --base-url <url>         Base URL for hosted/browser smoke suites",
    "  --timestamp <value>      Stable timestamp label for artifacts",
    "  --include-release-hardening",
    "                           Include SRE, security, portability, DX, and legal release-readiness suites",
    "  --dry-run                Do not execute suite commands; write planned report",
    "  --stop-on-failure        Stop after the first failed or blocked suite",
    "  --help                   Show this help",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = {
    suiteIds: [],
    artifactRoot: null,
    baseUrl: null,
    dryRun: false,
    continueOnFailure: true,
    includeReleaseHardening: false,
    timestamp: null,
  };

  const rest = [...argv];
  while (rest.length > 0) {
    const flag = rest.shift();
    switch (flag) {
      case "--":
        break;
      case "--suite":
        options.suiteIds.push(shiftValue(rest, "--suite"));
        break;
      case "--artifact-root":
        options.artifactRoot = path.resolve(shiftValue(rest, "--artifact-root"));
        break;
      case "--base-url":
        options.baseUrl = shiftValue(rest, "--base-url");
        break;
      case "--timestamp":
        options.timestamp = shiftValue(rest, "--timestamp");
        break;
      case "--include-release-hardening":
        options.includeReleaseHardening = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--stop-on-failure":
        options.continueOnFailure = false;
        break;
      case "--help":
      case "-h":
        process.stdout.write(`${usage()}\n`);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
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

function makeTimestamp() {
  return new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
}

function defaultArtifactRoot(timestamp) {
  return path.join(repoRoot, "engineering-docs", "release-signoff", "overnight", `production-beta-${timestamp}`);
}

function suiteCommand(command, args, options = {}) {
  return {
    command,
    args,
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? {},
  };
}

export function createSuiteRegistry(options = {}) {
  const suites = [
    {
      id: "snapshot-regression",
      name: "Snapshot Regression",
      required: true,
      productionImplication: "Snapshot and workspace-index restore semantics must stay exact before user data is trusted.",
      commands: [
        suiteCommand("pnpm", ["--filter", "@agentgit/workspace-index", "test", "--", "src/index.test.ts"]),
        suiteCommand("pnpm", ["--filter", "@agentgit/snapshot-engine", "test", "--", "src/index.test.ts"]),
      ],
    },
    {
      id: "openclaw-stress",
      name: "OpenClaw Stress",
      required: true,
      productionImplication: "Governed local agent actions, denials, snapshots, recoveries, and explicit checkpoints must pass together.",
      run: runOpenclawStressSuite,
    },
    {
      id: "cloud-build",
      name: "Cloud Build",
      required: true,
      productionImplication: "The production cloud bundle must compile with the workspace package graph used by the local product.",
      commands: [suiteCommand("pnpm", ["--filter", "@agentgit/cloud-ui", "build"])],
    },
    {
      id: "browser-surface",
      name: "Browser Surface",
      required: true,
      productionImplication:
        "The cloud UI smoke path must prove repo, run, action, snapshot, activity, and audit surfaces render correctly.",
      evidenceCeiling:
        "Without --base-url this is local hosted browser evidence, not a real deployed-origin smoke.",
      run: runBrowserSurfaceSuite,
    },
    {
      id: "crash-restart",
      name: "Crash Restart",
      required: true,
      productionImplication:
        "Daemon, journal, checkpoint, restore, and connector outbox state must survive restart boundaries without false success.",
      commands: [
        suiteCommand("pnpm", [
          "--filter",
          "@agentgit/authority-daemon",
          "test",
          "--",
          "src/server.integration.test.ts",
          "-t",
          "rehydrates persisted runs after a daemon restart|replays register_run idempotently across restart|creates an explicit run checkpoint and restores back to it",
        ]),
        suiteCommand("pnpm", [
          "--filter",
          "@agentgit/cloud-connector",
          "test",
          "--",
          "src/index.test.ts",
          "-t",
          "keeps pending events in the durable outbox across a restart",
        ]),
      ],
    },
    {
      id: "concurrent-agents",
      name: "Concurrent Agents",
      required: true,
      productionImplication:
        "Five overlapping autonomous stress sessions must keep session ownership, checkpoints, and restore evidence isolated.",
      evidenceCeiling:
        "This is an isolated-workspace concurrency floor; it does not prove 5-10 agents mutating the same workspace.",
      run: runConcurrentAgentsSuite,
    },
    {
      id: "connector-loop",
      name: "Connector Loop",
      required: true,
      productionImplication:
        "Restore, replay, approval, heartbeat, command pull, and ack paths must round-trip through the local connector contract.",
      commands: [
        suiteCommand("pnpm", ["--filter", "@agentgit/cloud-sync-protocol", "test"]),
        suiteCommand("pnpm", ["--filter", "@agentgit/control-plane-state", "test"]),
        suiteCommand("pnpm", ["--filter", "@agentgit/cloud-connector", "test", "--", "src/index.test.ts"]),
        suiteCommand("pnpm", [
          "--filter",
          "@agentgit/cloud-ui",
          "test",
          "--",
          "src/lib/backend/control-plane/connectors.test.ts",
          "src/app/api/v1/sync/register/route.test.ts",
          "src/app/api/v1/sync/heartbeat/route.test.ts",
          "src/app/api/v1/sync/events/route.test.ts",
          "src/app/api/v1/sync/commands/pull/route.test.ts",
          "src/app/api/v1/sync/commands/[commandId]/ack/route.test.ts",
        ]),
      ],
    },
    {
      id: "sensitive-redaction",
      name: "Sensitive Redaction",
      required: true,
      productionImplication:
        "Known synthetic secrets and common token shapes must not leak into qualification artifacts, session reports, or browser test output.",
      evidenceCeiling:
        "This is a heuristic artifact scanner, not a full DLP engine or guarantee against every novel secret format.",
      run: runSensitiveRedactionSuite,
    },
    {
      id: "scale-soak",
      name: "Scale Soak",
      required: true,
      productionImplication:
        "A 96-iteration beta-scale OpenClaw burst must keep snapshots and recoveries exact across a heavier local run.",
      evidenceCeiling:
        "This is not an hours-long soak; GA still needs a long-running leak, WAL growth, and snapshot bloat variant.",
      run: runScaleSoakSuite,
    },
    {
      id: "snapshot-maintenance",
      name: "Snapshot Maintenance",
      required: true,
      productionImplication:
        "Snapshot GC, synthetic anchor rebase, compaction, WAL checkpointing, and restore previews must preserve recovery honesty.",
      commands: [
        suiteCommand("pnpm", [
          "--filter",
          "@agentgit/workspace-index",
          "test",
          "--",
          "src/index.test.ts",
          "-t",
          "compacts snapshots|previewRestore reports overlapping later actions|restores only the requested subset",
        ]),
        suiteCommand("pnpm", [
          "--filter",
          "@agentgit/authority-daemon",
          "test",
          "--",
          "src/server.integration.test.ts",
          "-t",
          "runs supported maintenance jobs inline|garbage collects orphaned snapshot containers|rebases synthetic snapshot anchors",
        ]),
      ],
    },
    {
      id: "migration-compat",
      name: "Migration Compatibility",
      required: true,
      productionImplication:
        "Synthetic audit-bundle compatibility, CLI compatibility manifests, and sync-schema incompatibilities must be handled deliberately.",
      evidenceCeiling:
        "This does not include a corpus of real deployed historical bundles unless those fixtures are added.",
      commands: [
        suiteCommand("node", [
          "--test",
          "scripts/verify-cli-compatibility.test.mjs",
          "scripts/release-package-config.test.mjs",
        ]),
        suiteCommand("pnpm", [
          "--filter",
          "@agentgit/cloud-ui",
          "test",
          "--",
          "src/app/api/v1/sync/register/route.test.ts",
          "src/app/api/v1/sync/heartbeat/route.test.ts",
          "src/app/api/v1/sync/events/route.test.ts",
          "src/app/api/v1/sync/commands/pull/route.test.ts",
          "src/app/api/v1/sync/commands/[commandId]/ack/route.test.ts",
        ]),
      ],
    },
    {
      id: "audit-export",
      name: "Audit Export",
      required: true,
      productionImplication: "CSV/JSON audit exports must preserve ordering, links, authorization, and redaction-safe payloads.",
      commands: [
        suiteCommand("pnpm", [
          "--filter",
          "@agentgit/cloud-ui",
          "test",
          "--",
          "src/lib/backend/workspace/audit-log.test.ts",
          "src/app/api/v1/audit/export/route.test.ts",
          "src/app/api/v1/auth-guards.test.ts",
        ]),
      ],
    },
    {
      id: "package-install",
      name: "Package Install",
      required: true,
      productionImplication:
        "Packed npm artifacts must install into a clean project and the installed CLIs/runtime smoke paths must work outside the monorepo.",
      run: runPackageInstallSuite,
    },
    {
      id: "diff-check",
      name: "Diff Check",
      required: true,
      productionImplication: "Whitespace and patch hygiene must be clean before publishing release evidence.",
      evidenceCeiling: "This only proves patch hygiene; it does not mean the worktree is clean or fully reviewed.",
      commands: [suiteCommand("git", ["diff", "--check"])],
    },
  ];

  if (options.includeReleaseHardening) {
    suites.push(...createReleaseHardeningSuites());
  }

  return suites;
}

function createReleaseHardeningSuites() {
  return [
    {
      id: "perf-capacity-benchmarks",
      name: "Performance And Capacity Benchmarks",
      required: true,
      productionImplication:
        "Measured latency percentiles, throughput, cold-start time, and resource samples must be available for SRE review.",
      evidenceCeiling:
        "Local single-machine benchmark evidence is a beta floor; CI/staging should add controlled hardware and baseline-regression comparison.",
      run: runPerformanceBenchmarkSuite,
    },
    externalBlockedSuite(
      "reliability-chaos",
      "Reliability Chaos",
      "Fault injection for kill -9 mid-snapshot, disk-full WAL append, network partition, clock skew, and partial filesystem corruption must produce measured RTO/RPO.",
      "Requires a destructive chaos harness or disposable VM/container environment with disk/network/clock controls.",
    ),
    {
      id: "security-dependency-audit",
      name: "Security Dependency Audit",
      required: true,
      productionImplication: "Node and Python dependency audits must pass the configured severity threshold.",
      commands: [suiteCommand("pnpm", ["security:audit"])],
    },
    {
      id: "security-sbom",
      name: "Security SBOM",
      required: true,
      productionImplication: "A machine-readable SBOM must exist for workspace and packed release artifacts.",
      evidenceCeiling:
        "This local SBOM is generated from workspace manifests; enterprise release should attach CycloneDX/SPDX output from CI.",
      run: runSbomSuite,
    },
    externalBlockedSuite(
      "security-static-analysis",
      "Security Static Analysis",
      "Semgrep or CodeQL must scan injection, path traversal, SSRF, hardcoded secrets, and unsafe deserialization classes.",
      "No Semgrep/CodeQL scanner is configured in the repo-local qualification environment yet.",
    ),
    externalBlockedSuite(
      "security-secret-scan",
      "Security Secret Scan",
      "gitleaks or trufflehog must scan git history, working tree, and packed artifacts.",
      "The current local heuristic redaction scanner is not a replacement for gitleaks/trufflehog with history-aware scanning.",
    ),
    {
      id: "security-authz-matrix",
      name: "Security Authz Matrix",
      required: true,
      productionImplication:
        "Authentication and authorization route tests must cover guards, token/session paths, cross-resource access, and privileged actions.",
      commands: [
        suiteCommand("pnpm", [
          "--filter",
          "@agentgit/cloud-ui",
          "test",
          "--",
          "src/app/api/v1/auth-guards.test.ts",
          "src/lib/auth/workspace-access.test.ts",
          "src/app/api/v1/repositories/[owner]/[name]/route.test.ts",
          "src/app/api/v1/repositories/[owner]/[name]/snapshots/[snapshotId]/restore/route.test.ts",
          "src/app/api/v1/settings/team/route.test.ts",
        ]),
      ],
    },
    {
      id: "security-agent-adversarial",
      name: "Security Agent Adversarial",
      required: true,
      productionImplication:
        "Agent-specific governance bypass, shell boundary, and secret-redaction adversarial campaign must pass.",
      run: runAgentAdversarialSuite,
    },
    {
      id: "data-integrity-property",
      name: "Data Integrity Property",
      required: true,
      productionImplication:
        "Multiple seeded action sequences must preserve exact restore-to-checkpoint properties with zero mismatches.",
      evidenceCeiling:
        "This is seeded property-style stress evidence; a true property-based generator and shrinker is still needed.",
      run: runDataIntegrityPropertySuite,
    },
    externalBlockedSuite(
      "data-fuzzing",
      "Data Fuzzing",
      "Audit bundle parser, sync protocol decoder, and CLI argument surfaces must run fuzz corpora.",
      "No fuzzing harness or corpus is configured yet.",
    ),
    {
      id: "backup-restore-drill",
      name: "Backup Restore Drill",
      required: true,
      productionImplication:
        "A measured recovery drill must prove restore behavior, RTO, and recovery evidence on a fresh temporary workspace.",
      run: runBackupRestoreDrillSuite,
    },
    externalBlockedSuite(
      "observability-coverage",
      "Observability Coverage",
      "Prometheus or OpenTelemetry metrics must cover core operations with non-zero samples under qualification load.",
      "Runtime metrics export is not wired into the qualification harness yet.",
    ),
    {
      id: "log-quality",
      name: "Log Quality",
      required: true,
      productionImplication: "Qualification logs must not contain secret-shaped values or obvious PII.",
      evidenceCeiling:
        "This is a local artifact/log scanner; correlation-ID completeness still needs structured production log validation.",
      run: runLogQualitySuite,
    },
    externalBlockedSuite(
      "alert-runbook-smoke",
      "Alert And Runbook Smoke",
      "Synthetic staging failures must trigger alerts, and the top documented incident runbooks must execute successfully.",
      "Requires deployed staging monitoring and alert delivery integrations.",
    ),
    externalBlockedSuite(
      "os-node-matrix",
      "OS And Node Matrix",
      "Package install must pass on Linux x64, Linux arm64, macOS arm64, macOS x64, and Windows for claimed Node versions.",
      "Requires CI matrix runners; this local Mac can only produce one environment result.",
    ),
    externalBlockedSuite(
      "network-conditions",
      "Network Conditions",
      "High-latency, lossy, captive-portal, and IPv6-only network conditions must be tested.",
      "Requires a network-emulation test harness or staging environment.",
    ),
    externalBlockedSuite(
      "browser-matrix",
      "Browser Matrix",
      "Cloud UI must pass on Chrome, Firefox, Safari, and mobile browser targets for supported versions.",
      "Requires Playwright/browser device matrix beyond the local hosted smoke default.",
    ),
    {
      id: "accessibility",
      name: "Accessibility",
      required: true,
      productionImplication: "Cloud UI accessibility scan must pass with the configured violations budget.",
      commands: [
        suiteCommand("pnpm", ["--filter", "@agentgit/cloud-ui", "build"]),
        suiteCommand("pnpm", [
          "--filter",
          "@agentgit/cloud-ui",
          "exec",
          "--",
          "playwright",
          "test",
          "--config=playwright.config.ts",
          "accessibility.spec.ts",
        ]),
      ],
    },
    externalBlockedSuite(
      "visual-regression",
      "Visual Regression",
      "Cloud UI screenshot diffs must pass against an approved baseline for core surfaces.",
      "No screenshot baseline or visual diff approval workflow is configured yet.",
    ),
    {
      id: "docs-dx-quickstart",
      name: "Docs DX Quickstart",
      required: true,
      productionImplication:
        "Published quickstart/install instructions must work from clean install through a governed agent run.",
      evidenceCeiling:
        "This uses local packed artifacts and smoke scripts; clean VM execution should be added in CI before GA.",
      run: runDocsDxQuickstartSuite,
    },
    {
      id: "public-api-contract",
      name: "Public API Contract",
      required: true,
      productionImplication:
        "Public schema and sync protocol tests must pass before claiming API contract stability.",
      commands: [
        suiteCommand("pnpm", ["--filter", "@agentgit/schemas", "test"]),
        suiteCommand("pnpm", ["--filter", "@agentgit/cloud-sync-protocol", "test"]),
      ],
    },
    {
      id: "error-message-audit",
      name: "Error Message Audit",
      required: true,
      productionImplication:
        "Representative user-facing error paths must be exercised for controlled, actionable responses.",
      commands: [
        suiteCommand("pnpm", [
          "--filter",
          "@agentgit/cloud-ui",
          "test",
          "--",
          "src/app/api/v1/approvals/approval-decision-routes.test.ts",
          "src/app/api/v1/repos/connect/route.test.ts",
          "src/app/api/v1/repositories/[owner]/[name]/snapshots/[snapshotId]/restore/route.test.ts",
          "src/app/api/v1/settings/workspace/route.test.ts",
          "src/app/api/v1/sync/events/route.test.ts",
          "src/app/api/v1/sync/commands/[commandId]/ack/route.test.ts",
          "src/lib/auth/api-session.test.ts",
          "src/lib/http/request-body.test.ts",
        ]),
      ],
    },
    {
      id: "license-audit",
      name: "License Audit",
      required: true,
      productionImplication:
        "Workspace package manifests must declare acceptable licenses and no GPL/AGPL workspace package may enter release scope.",
      evidenceCeiling:
        "This checks workspace manifests only; transitive dependency license export should be added from CI.",
      run: runLicenseAuditSuite,
    },
    externalBlockedSuite(
      "telemetry-privacy-review",
      "Telemetry Privacy Review",
      "Telemetry sent home, privacy documentation, and opt-out behavior must be reviewed and tested.",
      "Requires product/privacy decision artifacts and deployed telemetry configuration.",
    ),
    externalBlockedSuite(
      "data-residency-review",
      "Data Residency Review",
      "Snapshot and cloud-mirrored data residency claims must match actual storage locations.",
      "Requires deployed cloud storage topology and customer-region policy decisions.",
    ),
  ];
}

function externalBlockedSuite(id, name, productionImplication, blockedReason) {
  return {
    id,
    name,
    required: true,
    productionImplication,
    blockedReason,
    evidenceCeiling: "External release-readiness evidence is required before this suite can pass.",
  };
}

export function deriveGateStatus(results) {
  const required = results.filter((result) => result.required);
  if (required.some((result) => result.status === "failed")) {
    return "failed";
  }
  if (required.some((result) => result.status === "blocked")) {
    return "blocked";
  }
  if (required.some((result) => !PASSING_STATUSES.has(result.status))) {
    return "incomplete";
  }
  return "passed";
}

export function buildFinalReport(input) {
  const lines = [
    "# Production Beta Qualification Report",
    "",
    `Generated: ${input.generatedAt}`,
    `Gate status: ${input.gateStatus}`,
    `Artifact root: ${input.artifactRoot}`,
    "",
    "## Suite Results",
    "",
    "| Suite | Required | Status | Duration | Production implication |",
    "| --- | --- | --- | --- | --- |",
  ];

  for (const result of input.results) {
    lines.push(
      `| ${result.id} | ${result.required ? "yes" : "no"} | ${result.status} | ${formatDuration(
        result.durationMs,
      )} | ${result.productionImplication} |`,
    );
  }

  for (const result of input.results) {
    lines.push("", `## ${result.name}`, "", `- Suite id: \`${result.id}\``);
    lines.push(`- Status: \`${result.status}\``);
    lines.push(`- Required: ${result.required ? "yes" : "no"}`);
    lines.push(`- Duration: ${formatDuration(result.durationMs)}`);
    if (result.command) {
      lines.push(`- Command: \`${result.command}\``);
    }
    lines.push(`- Summary: ${result.summary}`);
    lines.push(`- Production implication: ${result.productionImplication}`);
    if (result.evidenceCeiling) {
      lines.push(`- Evidence ceiling: ${result.evidenceCeiling}`);
    }
    if (result.artifacts.length > 0) {
      lines.push("- Artifacts:");
      for (const artifact of result.artifacts) {
        lines.push(`  - \`${artifact}\``);
      }
    }
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs)) {
    return "n/a";
  }
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  return `${(durationMs / 1000).toFixed(1)}s`;
}

async function runCommand(commandSpec, artifactPath) {
  await fsp.mkdir(path.dirname(artifactPath), { recursive: true });
  const child = spawn(commandSpec.command, commandSpec.args, {
    cwd: commandSpec.cwd,
    env: {
      ...process.env,
      ...commandSpec.env,
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

  const exit = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code: code ?? -1, signal: signal ?? null }));
  });

  await writeJson(artifactPath, {
    command: stringifyCommand(commandSpec),
    cwd: commandSpec.cwd,
    exit,
    stdout,
    stderr,
  });

  return {
    ok: exit.code === 0,
    exit,
    stdout,
    stderr,
  };
}

function stringifyCommand(commandSpec) {
  return [commandSpec.command, ...commandSpec.args].map(shellQuote).join(" ");
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@=+-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

async function writeJson(targetPath, value) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await fsp.writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function runCommandSuite(suite, context) {
  const artifacts = [];
  const failures = [];
  for (let index = 0; index < suite.commands.length; index += 1) {
    const commandSpec = suite.commands[index];
    const artifactPath = path.join(context.suiteArtifactRoot, `command-${index + 1}.json`);
    artifacts.push(artifactPath);
    const result = await runCommand(commandSpec, artifactPath);
    if (!result.ok) {
      failures.push(`${stringifyCommand(commandSpec)} exited ${result.exit.code}`);
    }
  }

  return {
    status: failures.length === 0 ? "passed" : "failed",
    command: suite.commands.map(stringifyCommand).join(" && "),
    summary: failures.length === 0 ? "All commands completed successfully." : failures.join("; "),
    artifacts,
  };
}

async function runOpenclawStressSuite(_suite, context) {
  const sessionRoot = makeOpenclawSessionRoot(context.suiteArtifactRoot);
  const commandSpec = suiteCommand("node", [
    "scripts/stress-autonomous-governance.mjs",
    "--profile",
    "openclaw",
    "--iterations",
    "36",
    "--recover-every",
    "1",
    "--shell-share",
    "0.75",
    "--initialize-git",
    "--git-remote",
    "https://github.com/openclaw/production-readiness-pipeline.git",
    "--workflow-name",
    "openclaw-production-readiness",
    "--session-root",
    sessionRoot,
    "--seed",
    "20260425",
    "--delay-ms",
    "25",
  ]);
  const commandArtifact = path.join(context.suiteArtifactRoot, "command.json");
  const commandResult = await runCommand(commandSpec, commandArtifact);
  const summaryPath = path.join(sessionRoot, "report", "summary.json");
  const sessionPointerPath = path.join(context.suiteArtifactRoot, "session-root.txt");
  await fsp.writeFile(sessionPointerPath, `${sessionRoot}\n`, "utf8");
  const artifacts = [commandArtifact, sessionPointerPath, summaryPath];
  if (!commandResult.ok) {
    return {
      status: "failed",
      command: stringifyCommand(commandSpec),
      summary: `OpenClaw stress command exited ${commandResult.exit.code}.`,
      artifacts,
    };
  }

  const summary = JSON.parse(await fsp.readFile(summaryPath, "utf8"));
  return {
    status: summary.ok ? "passed" : "failed",
    command: stringifyCommand(commandSpec),
    summary: `attempted=${summary.totals.attempted}, denied=${summary.totals.denied}, snapshots=${summary.totals.snapshot_backed}, exact_restore_mismatches=${summary.totals.exact_restore_mismatches}, checkpoint_mismatches=${summary.totals.checkpoint_exact_restore_mismatches}`,
    artifacts,
  };
}

export function makeOpenclawSessionRoot(suiteArtifactRoot) {
  return makeShortSessionRoot("agq", suiteArtifactRoot);
}

function makeShortSessionRoot(prefix, suiteArtifactRoot) {
  const digest = createHash("sha256").update(`${suiteArtifactRoot}:${Date.now()}:${process.pid}`, "utf8").digest("hex");
  return path.join("/tmp", `${prefix}-${digest.slice(0, 10)}`);
}

async function runConcurrentAgentsSuite(_suite, context) {
  const runs = [1, 2, 3, 4, 5].map((index) => {
    const sessionRoot = makeShortSessionRoot(`agc${index}`, context.suiteArtifactRoot);
    return {
      index,
      sessionRoot,
      commandSpec: suiteCommand("node", [
        "scripts/stress-autonomous-governance.mjs",
        "--profile",
        "openclaw",
        "--iterations",
        "12",
        "--recover-every",
        "2",
        "--shell-share",
        "0.65",
        "--initialize-git",
        "--git-remote",
        `https://github.com/openclaw/concurrent-agent-${index}.git`,
        "--workflow-name",
        `openclaw-concurrent-agent-${index}`,
        "--session-root",
        sessionRoot,
        "--seed",
        String(2026042600 + index),
        "--delay-ms",
        "10",
      ]),
    };
  });

  const commandResults = await Promise.all(
    runs.map((run) => runCommand(run.commandSpec, path.join(context.suiteArtifactRoot, `command-${run.index}.json`))),
  );

  const summaries = [];
  const artifacts = [];
  const failures = [];
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    const commandResult = commandResults[index];
    const sessionPointerPath = path.join(context.suiteArtifactRoot, `session-root-${run.index}.txt`);
    const summaryPath = path.join(run.sessionRoot, "report", "summary.json");
    await fsp.writeFile(sessionPointerPath, `${run.sessionRoot}\n`, "utf8");
    artifacts.push(path.join(context.suiteArtifactRoot, `command-${run.index}.json`), sessionPointerPath, summaryPath);
    if (!commandResult.ok) {
      failures.push(`agent ${run.index} exited ${commandResult.exit.code}`);
      continue;
    }

    const summary = JSON.parse(await fsp.readFile(summaryPath, "utf8"));
    summaries.push(summary);
    if (!summary.ok) {
      failures.push(`agent ${run.index} reported ok=false`);
    }
    if (summary.totals.exact_restore_mismatches !== 0 || summary.totals.checkpoint_exact_restore_mismatches !== 0) {
      failures.push(`agent ${run.index} reported restore mismatches`);
    }
  }

  const summaryArtifact = path.join(context.suiteArtifactRoot, "concurrent-summary.json");
  await writeJson(summaryArtifact, {
    agents: summaries.map((summary) => ({
      run_id: summary.run_id,
      workspace_root: summary.workspace_root,
      attempted: summary.totals.attempted,
      denied: summary.totals.denied,
      snapshots: summary.totals.snapshot_backed,
      exact_restore_mismatches: summary.totals.exact_restore_mismatches,
      checkpoint_mismatches: summary.totals.checkpoint_exact_restore_mismatches,
    })),
  });
  artifacts.push(summaryArtifact);

  return {
    status: failures.length === 0 ? "passed" : "failed",
    command: runs.map((run) => stringifyCommand(run.commandSpec)).join(" & "),
    summary:
      failures.length === 0
        ? `agents=${summaries.length}, attempted=${summaries.reduce(
            (total, summary) => total + summary.totals.attempted,
            0,
          )}, restore_mismatches=0`
        : failures.join("; "),
    artifacts,
  };
}

async function runScaleSoakSuite(_suite, context) {
  const sessionRoot = makeShortSessionRoot("ags", context.suiteArtifactRoot);
  const commandSpec = suiteCommand("node", [
    "scripts/stress-autonomous-governance.mjs",
    "--profile",
    "openclaw",
    "--iterations",
    "96",
    "--recover-every",
    "2",
    "--shell-share",
    "0.85",
    "--initialize-git",
    "--git-remote",
    "https://github.com/openclaw/scale-soak-readiness.git",
    "--workflow-name",
    "openclaw-scale-soak-readiness",
    "--session-root",
    sessionRoot,
    "--seed",
    "2026042696",
    "--delay-ms",
    "0",
  ]);
  const commandArtifact = path.join(context.suiteArtifactRoot, "command.json");
  const commandResult = await runCommand(commandSpec, commandArtifact);
  const summaryPath = path.join(sessionRoot, "report", "summary.json");
  const sessionPointerPath = path.join(context.suiteArtifactRoot, "session-root.txt");
  await fsp.writeFile(sessionPointerPath, `${sessionRoot}\n`, "utf8");
  const artifacts = [commandArtifact, sessionPointerPath, summaryPath];
  if (!commandResult.ok) {
    return {
      status: "failed",
      command: stringifyCommand(commandSpec),
      summary: `Scale soak command exited ${commandResult.exit.code}.`,
      artifacts,
    };
  }

  const summary = JSON.parse(await fsp.readFile(summaryPath, "utf8"));
  const restoreMismatches =
    summary.totals.exact_restore_mismatches + summary.totals.checkpoint_exact_restore_mismatches;
  const passed = summary.ok && summary.totals.attempted === 96 && restoreMismatches === 0;
  return {
    status: passed ? "passed" : "failed",
    command: stringifyCommand(commandSpec),
    summary: `attempted=${summary.totals.attempted}, denied=${summary.totals.denied}, snapshots=${summary.totals.snapshot_backed}, restore_mismatches=${restoreMismatches}`,
    artifacts,
  };
}

async function runPackageInstallSuite(_suite, context) {
  const packedDir = path.join(context.suiteArtifactRoot, "packed");
  const commands = [
    suiteCommand("node", ["scripts/pack-release-artifacts.mjs", "--out-dir", packedDir, "--signing-mode", "none"]),
    suiteCommand("node", ["scripts/smoke-public-packages.mjs", "--artifacts-dir", packedDir]),
    suiteCommand("node", ["scripts/smoke-installed-cli.mjs", "--artifacts-dir", packedDir]),
    suiteCommand("node", ["scripts/smoke-installed-agent-runtime.mjs", "--artifacts-dir", packedDir]),
  ];
  return runCommandSuite(
    {
      commands,
    },
    context,
  );
}

async function runPerformanceBenchmarkSuite(_suite, context) {
  const outputDir = path.join(context.suiteArtifactRoot, "evidence");
  const commandSpec = suiteCommand("node", [
    "scripts/production-readiness-benchmarks.mjs",
    "--output-dir",
    outputDir,
    "--iterations",
    "8",
    ...(context.baseUrl ? ["--base-url", context.baseUrl] : []),
  ]);
  const commandArtifact = path.join(context.suiteArtifactRoot, "command.json");
  const commandResult = await runCommand(commandSpec, commandArtifact);
  const summaryPath = path.join(outputDir, "summary.json");
  const reportPath = path.join(outputDir, "REPORT.md");
  const artifacts = [commandArtifact, summaryPath, reportPath];

  if (!commandResult.ok) {
    return {
      status: "failed",
      command: stringifyCommand(commandSpec),
      summary: `Performance benchmark command exited ${commandResult.exit.code}.`,
      artifacts,
    };
  }

  const summary = JSON.parse(await fsp.readFile(summaryPath, "utf8"));
  const failedBudgets = (summary.budget_results ?? []).filter((result) => !result.ok);
  return {
    status: summary.ok && failedBudgets.length === 0 ? "passed" : "failed",
    command: stringifyCommand(commandSpec),
    summary: [
      `action_p99_ms=${formatNumber(summary.latency?.action_submission_decision_ms?.p99_ms)}`,
      `snapshot_p99_ms=${formatNumber(summary.latency?.snapshot_creation_ms?.p99_ms)}`,
      `restore_p99_ms=${formatNumber(summary.latency?.snapshot_restore_ms?.p99_ms)}`,
      `audit_p99_ms=${formatNumber(summary.latency?.audit_query_ms?.p99_ms)}`,
      `actions_per_second=${formatNumber(summary.throughput?.actions_per_second)}`,
      `snapshots_per_minute=${formatNumber(summary.throughput?.snapshots_per_minute)}`,
      `budget_failures=${failedBudgets.length}`,
    ].join(", "),
    artifacts,
  };
}

async function runSbomSuite(_suite, context) {
  const packedDir = path.join(context.suiteArtifactRoot, "packed");
  const sbomPath = path.join(context.suiteArtifactRoot, "release-sbom.cdx.json");
  const commands = [
    suiteCommand("node", ["scripts/pack-release-artifacts.mjs", "--out-dir", packedDir, "--signing-mode", "none"]),
    suiteCommand("node", ["scripts/generate-release-sbom.mjs", "--output", sbomPath, "--artifacts-dir", packedDir]),
  ];
  const commandResult = await runCommandSuite({ commands }, context);
  if (commandResult.status !== "passed") {
    return commandResult;
  }

  const sbom = JSON.parse(await fsp.readFile(sbomPath, "utf8"));
  const artifactComponents = (sbom.components ?? []).filter((component) => component.type === "file");
  return {
    status: artifactComponents.length > 0 ? "passed" : "failed",
    command: commandResult.command,
    summary: `components=${sbom.components?.length ?? 0}, artifact_components=${artifactComponents.length}, format=${sbom.bomFormat ?? "unknown"}`,
    artifacts: [...commandResult.artifacts, sbomPath],
  };
}

async function runAgentAdversarialSuite(_suite, context) {
  const outputDir = path.join(context.suiteArtifactRoot, "campaign-0");
  const commandSpec = suiteCommand("node", ["scripts/run-adversarial-campaign-0.mjs", "--output-dir", outputDir]);
  const commandArtifact = path.join(context.suiteArtifactRoot, "command.json");
  const commandResult = await runCommand(commandSpec, commandArtifact);
  const summaryPath = path.join(outputDir, "summary.json");
  const reportPath = path.join(outputDir, "REPORT.md");
  const artifacts = [commandArtifact, summaryPath, reportPath];

  if (!commandResult.ok) {
    return {
      status: "failed",
      command: stringifyCommand(commandSpec),
      summary: `Adversarial campaign command exited ${commandResult.exit.code}.`,
      artifacts,
    };
  }

  const summary = JSON.parse(await fsp.readFile(summaryPath, "utf8"));
  return {
    status: summary.ok ? "passed" : "failed",
    command: stringifyCommand(commandSpec),
    summary: `probes=${summary.totals.probes}, passed=${summary.totals.passed}, failed=${summary.totals.failed}, content_leaks=${summary.totals.content_leaks}, filesystem_changes=${summary.totals.filesystem_changes}`,
    artifacts,
  };
}

async function runDataIntegrityPropertySuite(_suite, context) {
  const seeds = [2026042701, 2026042702, 2026042703];
  const artifacts = [];
  const summaries = [];
  const failures = [];

  for (let index = 0; index < seeds.length; index += 1) {
    const seed = seeds[index];
    const sessionRoot = makeShortSessionRoot(`agp${index + 1}`, context.suiteArtifactRoot);
    const commandSpec = suiteCommand("node", [
      "scripts/stress-autonomous-governance.mjs",
      "--profile",
      "openclaw",
      "--iterations",
      "18",
      "--recover-every",
      "2",
      "--shell-share",
      "0.7",
      "--initialize-git",
      "--git-remote",
      `https://github.com/openclaw/property-integrity-${index + 1}.git`,
      "--workflow-name",
      `openclaw-property-integrity-${index + 1}`,
      "--session-root",
      sessionRoot,
      "--seed",
      String(seed),
      "--delay-ms",
      "0",
    ]);
    const commandArtifact = path.join(context.suiteArtifactRoot, `command-${index + 1}.json`);
    const sessionPointerPath = path.join(context.suiteArtifactRoot, `session-root-${index + 1}.txt`);
    const summaryPath = path.join(sessionRoot, "report", "summary.json");
    artifacts.push(commandArtifact, sessionPointerPath, summaryPath);
    await fsp.writeFile(sessionPointerPath, `${sessionRoot}\n`, "utf8");

    const commandResult = await runCommand(commandSpec, commandArtifact);
    if (!commandResult.ok) {
      failures.push(`seed ${seed} exited ${commandResult.exit.code}`);
      continue;
    }

    const summary = JSON.parse(await fsp.readFile(summaryPath, "utf8"));
    summaries.push(summary);
    const restoreMismatches =
      summary.totals.exact_restore_mismatches + summary.totals.checkpoint_exact_restore_mismatches;
    if (!summary.ok || restoreMismatches !== 0) {
      failures.push(`seed ${seed} restore_mismatches=${restoreMismatches}`);
    }
  }

  const matrixPath = path.join(context.suiteArtifactRoot, "property-seed-summary.json");
  await writeJson(matrixPath, {
    seeds,
    summaries: summaries.map((summary) => ({
      seed: summary.seed,
      run_id: summary.run_id,
      attempted: summary.totals.attempted,
      snapshot_backed: summary.totals.snapshot_backed,
      exact_restore_mismatches: summary.totals.exact_restore_mismatches,
      checkpoint_exact_restore_mismatches: summary.totals.checkpoint_exact_restore_mismatches,
    })),
    failures,
  });
  artifacts.push(matrixPath);

  return {
    status: failures.length === 0 ? "passed" : "failed",
    command: "node scripts/stress-autonomous-governance.mjs --profile openclaw --iterations 18 --seed <matrix>",
    summary:
      failures.length === 0
        ? `seeds=${seeds.length}, attempted=${summaries.reduce(
            (total, summary) => total + summary.totals.attempted,
            0,
          )}, restore_mismatches=0`
        : failures.join("; "),
    artifacts,
  };
}

async function runBackupRestoreDrillSuite(_suite, context) {
  const outputDir = path.join(context.suiteArtifactRoot, "recovery-drill");
  const commandSpec = suiteCommand("node", ["scripts/run-recovery-drill.mjs", "--output-dir", outputDir]);
  const commandArtifact = path.join(context.suiteArtifactRoot, "command.json");
  const commandResult = await runCommand(commandSpec, commandArtifact);
  const summaryPath = path.join(outputDir, "summary.json");
  const reportPath = path.join(outputDir, "REPORT.md");
  const artifacts = [commandArtifact, summaryPath, reportPath];

  if (!commandResult.ok) {
    return {
      status: "failed",
      command: stringifyCommand(commandSpec),
      summary: `Recovery drill command exited ${commandResult.exit.code}.`,
      artifacts,
    };
  }

  const summary = JSON.parse(await fsp.readFile(summaryPath, "utf8"));
  return {
    status: summary.ok && summary.restored ? "passed" : "failed",
    command: stringifyCommand(commandSpec),
    summary: `rto_ms=${summary.rto_ms}, rpo_target=${summary.rpo_target}, restored=${summary.restored}`,
    artifacts,
  };
}

async function runLogQualitySuite(_suite, context) {
  const findings = [];
  let scannedFiles = 0;
  if (await pathExistsAsync(context.artifactRoot)) {
    await scanTextFiles(context.artifactRoot, (filePath, content) => {
      if (!/(\.log|command-\d+\.json|command\.json)$/u.test(path.basename(filePath))) {
        return;
      }
      scannedFiles += 1;
      findings.push(...detectLogQualityFindings(filePath, content));
    });
  }

  const artifactPath = path.join(context.suiteArtifactRoot, "log-quality-scan.json");
  await writeJson(artifactPath, {
    scannedFiles,
    findings,
  });

  return {
    status: findings.length === 0 ? "passed" : "failed",
    command: `scan log artifacts under ${shellQuote(context.artifactRoot)}`,
    summary:
      findings.length === 0
        ? `No secret-shaped values or obvious SSN-shaped PII were found in ${scannedFiles} log artifact file(s).`
        : `Found ${findings.length} log-quality finding(s) in ${scannedFiles} log artifact file(s).`,
    artifacts: [artifactPath],
  };
}

function detectLogQualityFindings(filePath, content) {
  const findings = [...detectSensitiveFindings(filePath, content)];
  const ssnPattern = /\b\d{3}-\d{2}-\d{4}\b/gu;
  for (const match of content.matchAll(ssnPattern)) {
    findings.push({
      filePath,
      pattern: "ssn-shaped-pii",
      ...lineColumnForIndex(content, match.index ?? 0),
    });
  }
  return findings;
}

async function runDocsDxQuickstartSuite(_suite, context) {
  const packedDir = path.join(context.suiteArtifactRoot, "packed");
  return runCommandSuite(
    {
      commands: [
        suiteCommand("node", ["scripts/pack-release-artifacts.mjs", "--out-dir", packedDir, "--signing-mode", "none"]),
        suiteCommand("node", ["scripts/smoke-public-packages.mjs", "--artifacts-dir", packedDir]),
        suiteCommand("node", ["scripts/smoke-installed-cli.mjs", "--artifacts-dir", packedDir]),
        suiteCommand("node", ["scripts/smoke-installed-agent-runtime.mjs", "--artifacts-dir", packedDir]),
      ],
    },
    context,
  );
}

async function runLicenseAuditSuite(_suite, context) {
  const manifestPaths = await listWorkspacePackageManifests();
  const packages = [];
  const failures = [];
  const warnings = [];

  for (const manifestPath of manifestPaths) {
    const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
    const license = typeof manifest.license === "string" ? manifest.license : null;
    const isPrivate = manifest.private === true;
    const record = {
      path: manifestPath,
      name: manifest.name ?? path.basename(path.dirname(manifestPath)),
      private: isPrivate,
      license,
    };
    packages.push(record);

    if (!license && !isPrivate) {
      failures.push(`${record.name} is publishable and missing a license`);
    } else if (!license) {
      warnings.push(`${record.name} is private and missing a license`);
    }

    if (license && /\b(?:AGPL|GPL|LGPL)\b/iu.test(license)) {
      failures.push(`${record.name} declares disallowed license ${license}`);
    }
  }

  const artifactPath = path.join(context.suiteArtifactRoot, "license-audit.json");
  await writeJson(artifactPath, {
    packages,
    failures,
    warnings,
  });

  return {
    status: failures.length === 0 ? "passed" : "failed",
    command: "scan workspace package manifests",
    summary: `packages=${packages.length}, failures=${failures.length}, private_missing_license_warnings=${warnings.length}`,
    artifacts: [artifactPath],
  };
}

async function listWorkspacePackageManifests() {
  const manifestPaths = [path.join(repoRoot, "package.json")];
  for (const rootName of ["apps", "packages"]) {
    const root = path.join(repoRoot, rootName);
    if (!(await pathExistsAsync(root))) {
      continue;
    }
    const entries = await fsp.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const manifestPath = path.join(root, entry.name, "package.json");
      if (await pathExistsAsync(manifestPath)) {
        manifestPaths.push(manifestPath);
      }
    }
  }
  return manifestPaths.sort();
}

function formatNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(2)) : "n/a";
}

async function runBrowserSurfaceSuite(suite, context) {
  const env = context.baseUrl ? { AGENTGIT_CLOUD_E2E_BASE_URL: context.baseUrl } : {};
  return runCommandSuite(
    {
      ...suite,
      commands: [suiteCommand("pnpm", ["smoke:cloud-hosted"], { env })],
    },
    context,
  );
}

async function runSensitiveRedactionSuite(_suite, context) {
  const scanRoots = await collectRedactionScanRoots(context.artifactRoot);
  if (scanRoots.length === 0) {
    return {
      status: "blocked",
      command: "scan qualification artifacts",
      summary: "No qualification artifact roots were available to scan.",
      artifacts: [],
    };
  }

  const leaks = [];
  let scannedFiles = 0;
  for (const scanRoot of scanRoots) {
    await scanTextFiles(scanRoot, (filePath, content) => {
      scannedFiles += 1;
      leaks.push(...detectSensitiveFindings(filePath, content));
    });
  }

  const artifactPath = path.join(context.suiteArtifactRoot, "redaction-scan.json");
  await writeJson(artifactPath, {
    scannedRoots: scanRoots,
    scannedFiles,
    leaks,
  });

  return {
    status: leaks.length === 0 ? "passed" : "failed",
    command: `scan ${scanRoots.map(shellQuote).join(" ")}`,
    summary:
      leaks.length === 0
        ? `No secret tripwires or common token shapes were found across ${scannedFiles} scanned artifact file(s).`
        : `Found ${leaks.length} secret-shaped finding(s) across ${scannedFiles} scanned artifact file(s).`,
    artifacts: [artifactPath],
  };
}

export async function collectRedactionScanRoots(artifactRoot, options = {}) {
  const roots = new Set();
  if (await pathExistsAsync(artifactRoot)) {
    roots.add(path.resolve(artifactRoot));
  }

  const sessionRootPointers = await findFilesByNamePattern(artifactRoot, /^session-root.*\.txt$/u);
  for (const pointerPath of sessionRootPointers) {
    const pointedRoot = (await fsp.readFile(pointerPath, "utf8")).trim();
    if (pointedRoot && (await pathExistsAsync(pointedRoot))) {
      roots.add(path.resolve(pointedRoot));
    }
  }

  const browserOutputRoots = options.browserOutputRoots ?? [
    path.join(repoRoot, "apps", "agentgit-cloud", "test-results"),
    path.join(repoRoot, "apps", "agentgit-cloud", "playwright-report"),
  ];
  for (const browserOutputRoot of browserOutputRoots) {
    if (await pathExistsAsync(browserOutputRoot)) {
      roots.add(path.resolve(browserOutputRoot));
    }
  }

  return [...roots];
}

async function findFilesByNamePattern(rootDir, pattern) {
  if (!(await pathExistsAsync(rootDir))) {
    return [];
  }

  const matches = [];
  const entries = await fsp.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      matches.push(...(await findFilesByNamePattern(fullPath, pattern)));
      continue;
    }
    if (entry.isFile() && pattern.test(entry.name)) {
      matches.push(fullPath);
    }
  }
  return matches;
}

async function pathExistsAsync(targetPath) {
  try {
    await fsp.access(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const SECRET_PATTERNS = [
  {
    name: "synthetic-openai-key",
    pattern: /\bOPENAI_API_KEY=not-a-real-secret\b/gu,
  },
  {
    name: "synthetic-auth-token",
    pattern: /\b_authToken=not-a-real-token\b/gu,
  },
  {
    name: "openai-api-key",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/gu,
  },
  {
    name: "github-token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{24,}\b/gu,
  },
  {
    name: "npm-token",
    pattern: /\bnpm_[A-Za-z0-9]{24,}\b/gu,
  },
  {
    name: "named-secret-assignment",
    pattern:
      /\b(?:ANTHROPIC_API_KEY|AUTH_TOKEN|DATABASE_URL|GH_TOKEN|GITHUB_TOKEN|NPM_TOKEN|OPENAI_API_KEY|STRIPE_SECRET_KEY|ACCESS_TOKEN|_authToken)\s*[:=]\s*["']?(?!not-a-real-secret\b|not-a-real-token\b|redacted\b|\*\*\*|<redacted>)([^"'\s,}]{8,})/giu,
  },
];

export function detectSensitiveFindings(filePath, content) {
  const findings = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      findings.push({
        filePath,
        pattern: name,
        ...lineColumnForIndex(content, match.index ?? 0),
      });
    }
  }
  return findings;
}

function lineColumnForIndex(content, index) {
  const prefix = content.slice(0, index);
  const lines = prefix.split("\n");
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
}

export function resolveOpenclawSummaryPath(artifactRoot) {
  const candidate = path.join(artifactRoot, "openclaw-stress", "session", "report", "summary.json");
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  const sessionPointerPath = path.join(artifactRoot, "openclaw-stress", "session-root.txt");
  if (fs.existsSync(sessionPointerPath)) {
    const sessionRoot = fs.readFileSync(sessionPointerPath, "utf8").trim();
    const pointedSummary = path.join(sessionRoot, "report", "summary.json");
    if (fs.existsSync(pointedSummary)) {
      return pointedSummary;
    }
  }
  return null;
}

async function scanTextFiles(rootDir, onFile) {
  const entries = await fsp.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      await scanTextFiles(fullPath, onFile);
      continue;
    }
    if (!entry.isFile() || !/\.(json|md|txt|log|csv)$/i.test(entry.name)) {
      continue;
    }
    const stat = await fsp.stat(fullPath);
    if (stat.size > 2 * 1024 * 1024) {
      continue;
    }
    onFile(fullPath, await fsp.readFile(fullPath, "utf8"));
  }
}

async function runSuite(suite, context) {
  const started = Date.now();
  if (context.dryRun) {
    return {
      id: suite.id,
      name: suite.name,
      required: suite.required,
      status: suite.blockedReason ? "blocked" : "pending",
      command: suite.commands?.map(stringifyCommand).join(" && ") ?? suite.id,
      durationMs: 0,
      summary: suite.blockedReason ?? "Dry run only; suite was not executed.",
      productionImplication: suite.productionImplication,
      evidenceCeiling: suite.evidenceCeiling ?? null,
      artifacts: [],
    };
  }

  let payload;
  if (suite.blockedReason) {
    payload = {
      status: "blocked",
      command: suite.id,
      summary: suite.blockedReason,
      artifacts: [],
    };
  } else if (suite.run) {
    payload = await suite.run(suite, context);
  } else {
    payload = await runCommandSuite(suite, context);
  }

  return {
    id: suite.id,
    name: suite.name,
    required: suite.required,
    status: payload.status,
    command: payload.command,
    durationMs: Date.now() - started,
    summary: payload.summary,
    productionImplication: suite.productionImplication,
    evidenceCeiling: suite.evidenceCeiling ?? null,
    artifacts: payload.artifacts,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const timestamp = options.timestamp ?? makeTimestamp();
  const artifactRoot = options.artifactRoot ?? defaultArtifactRoot(timestamp);
  const registry = createSuiteRegistry({ includeReleaseHardening: options.includeReleaseHardening });
  const selected = options.suiteIds.length
    ? options.suiteIds.map((suiteId) => {
        const suite = registry.find((candidate) => candidate.id === suiteId);
        if (!suite) {
          throw new Error(`Unknown suite: ${suiteId}`);
        }
        return suite;
      })
    : registry;

  await fsp.mkdir(artifactRoot, { recursive: true });

  const results = [];
  for (const suite of selected) {
    process.stdout.write(`\n== ${suite.id} ==\n`);
    const suiteArtifactRoot = path.join(artifactRoot, suite.id);
    await fsp.mkdir(suiteArtifactRoot, { recursive: true });
    const result = await runSuite(suite, {
      artifactRoot,
      suiteArtifactRoot,
      baseUrl: options.baseUrl,
      dryRun: options.dryRun,
    });
    results.push(result);
    process.stdout.write(`${result.status}: ${result.summary}\n`);
    if (!options.continueOnFailure && result.required && !PASSING_STATUSES.has(result.status)) {
      break;
    }
  }

  const gateStatus = deriveGateStatus(results);
  const summary = {
    generatedAt: new Date().toISOString(),
    gateStatus,
    artifactRoot,
    results,
  };
  const report = buildFinalReport(summary);
  const summaryPath = path.join(artifactRoot, "summary.json");
  const reportPath = path.join(artifactRoot, "REPORT.md");
  await writeJson(summaryPath, summary);
  await fsp.writeFile(reportPath, report, "utf8");

  process.stdout.write(`\nProduction beta qualification gate: ${gateStatus}\n`);
  process.stdout.write(`Summary: ${summaryPath}\n`);
  process.stdout.write(`Report: ${reportPath}\n`);

  if (gateStatus !== "passed") {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
