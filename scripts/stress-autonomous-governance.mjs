#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authorityCli = path.join(repoRoot, "packages", "authority-cli", "dist", "main.js");
const authorityDaemon = path.join(repoRoot, "packages", "authority-daemon", "dist", "main.js");

function usage() {
  return [
    "Usage: node scripts/stress-autonomous-governance.mjs [options]",
    "",
    "Options:",
    "  --workspace-root <path>   Use a specific workspace root",
    "  --profile <baseline|adversarial>  Action mix profile (default: baseline)",
    "  --iterations <count>      Number of randomized actions to attempt (default: 24)",
    "  --delay-ms <ms>           Delay between actions (default: 150)",
    "  --recover-every <count>   Plan/execute recovery every N actions when possible (default: 3)",
    "  --shell-share <0-1>       Share of shell-driven actions (default: 0.25)",
    "  --seed <number>           Deterministic random seed",
    "  --keep-daemon             Leave the daemon running after the script exits",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    workspaceRoot: undefined,
    profile: "baseline",
    iterations: 24,
    delayMs: 150,
    recoverEvery: 3,
    shellShare: 0.25,
    seed: Date.now(),
    keepDaemon: false,
  };

  const rest = [...argv];
  while (rest.length > 0) {
    const current = rest.shift();
    if (current === "--") {
      continue;
    }
    switch (current) {
      case "--workspace-root":
        options.workspaceRoot = path.resolve(shiftValue(rest, "--workspace-root"));
        break;
      case "--profile": {
        const value = shiftValue(rest, "--profile");
        if (value !== "baseline" && value !== "adversarial") {
          throw new Error(`Unsupported --profile value: ${value}`);
        }
        options.profile = value;
        break;
      }
      case "--iterations":
        options.iterations = parseInteger(shiftValue(rest, "--iterations"), "--iterations");
        break;
      case "--delay-ms":
        options.delayMs = parseInteger(shiftValue(rest, "--delay-ms"), "--delay-ms");
        break;
      case "--recover-every":
        options.recoverEvery = parseInteger(shiftValue(rest, "--recover-every"), "--recover-every");
        break;
      case "--shell-share":
        options.shellShare = parseFloatRange(shiftValue(rest, "--shell-share"), "--shell-share");
        break;
      case "--seed":
        options.seed = parseInteger(shiftValue(rest, "--seed"), "--seed");
        break;
      case "--keep-daemon":
        options.keepDaemon = true;
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

function parseInteger(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }
  return parsed;
}

function parseFloatRange(value, flag) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${flag} must be between 0 and 1.`);
  }
  return parsed;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printStep(label) {
  process.stdout.write(`\n== ${label} ==\n`);
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

function choose(rng, values) {
  return values[Math.floor(rng() * values.length)];
}

function randomToken(rng, prefix) {
  return `${prefix}-${Math.floor(rng() * 1_000_000)
    .toString(36)
    .padStart(4, "0")}`;
}

function toPosixRelative(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
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

  for (const target of [authorityCli, authorityDaemon]) {
    if (!(await pathExists(target))) {
      throw new Error(`Expected built artifact is missing: ${target}`);
    }
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
  const accepted = options.acceptExitCodes ?? [0];
  if (!accepted.includes(result.code)) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result;
}

function parseJsonOutput(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `${label} did not return valid JSON.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\nerror: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function writeJson(targetPath, value) {
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await fsp.writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function seedWorkspace(workspaceRoot) {
  await fsp.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fsp.mkdir(path.join(workspaceRoot, "docs"), { recursive: true });
  await fsp.mkdir(path.join(workspaceRoot, "notes"), { recursive: true });
  await fsp.mkdir(path.join(workspaceRoot, "data"), { recursive: true });

  await fsp.writeFile(path.join(workspaceRoot, "src", "app.txt"), "core app state\nversion: 1\n", "utf8");
  await fsp.writeFile(
    path.join(workspaceRoot, "docs", "guide.md"),
    "# Guide\n\nThis workspace is used for autonomous governance stress testing.\n",
    "utf8",
  );
  await fsp.writeFile(path.join(workspaceRoot, "notes", "todo.txt"), "ship alpha\nmeasure recovery\n", "utf8");
  await fsp.writeFile(path.join(workspaceRoot, "data", "items.csv"), "id,name\n1,alpha\n2,beta\n", "utf8");
  await fsp.writeFile(path.join(workspaceRoot, ".env"), "OPENAI_API_KEY=not-a-real-secret\n", "utf8");
}

async function seedAdversarialFixtures(workspaceRoot, sessionRoot) {
  const outsideRoot = path.join(sessionRoot, "outside-root");
  const linkRoot = path.join(workspaceRoot, "linked-outside");
  await fsp.mkdir(outsideRoot, { recursive: true });
  await fsp.writeFile(path.join(outsideRoot, "outside.txt"), "outside-control-surface\n", "utf8");
  try {
    await fsp.rm(linkRoot, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup before re-creating the symlink fixture.
  }
  await fsp.symlink(outsideRoot, linkRoot, "dir");
  return {
    outsideRoot,
    linkedOutsideRoot: linkRoot,
    outsideFile: path.join(outsideRoot, "outside.txt"),
  };
}

async function writeWorkspacePolicy(workspaceRoot) {
  const policyDir = path.join(workspaceRoot, ".agentgit");
  const policyPath = path.join(policyDir, "policy.toml");
  await fsp.mkdir(policyDir, { recursive: true });
  await fsp.writeFile(
    policyPath,
    [
      'profile_name = "autonomy-stress"',
      'policy_version = "2026.04.06.autonomy-stress.v1"',
      "",
      "[thresholds]",
      'low_confidence = [{ action_family = "filesystem/*", ask_below = 0.0 }, { action_family = "shell/*", ask_below = 0.0 }]',
      "",
      "[[rules]]",
      'rule_id = "workspace.filesystem.snapshot-first"',
      'description = "Bias mutating filesystem work toward automatic snapshots."',
      'rationale = "Autonomous workspace mutations should proceed with rollback boundaries when recoverable."',
      'binding_scope = "workspace"',
      'decision = "allow_with_snapshot"',
      'enforcement_mode = "enforce"',
      "priority = 850",
      'reason = { code = "AUTONOMY_FILESYSTEM_SNAPSHOT", severity = "moderate", message = "Mutating filesystem actions should auto-proceed with a snapshot boundary during autonomy stress tests." }',
      'match = { type = "all", conditions = [{ type = "field", field = "operation.domain", operator = "eq", value = "filesystem" }, { type = "field", field = "risk_hints.side_effect_level", operator = "in", value = ["mutating", "destructive"] }] }',
      "",
      "[[rules]]",
      'rule_id = "workspace.shell.snapshot-first"',
      'description = "Bias mutating shell work toward automatic snapshots."',
      'rationale = "Autonomous shell mutations should proceed when a boundary can be captured, even if later restore still requires review."',
      'binding_scope = "workspace"',
      'decision = "allow_with_snapshot"',
      'enforcement_mode = "enforce"',
      "priority = 840",
      'reason = { code = "AUTONOMY_SHELL_SNAPSHOT", severity = "moderate", message = "Mutating shell actions should auto-proceed with a snapshot boundary during autonomy stress tests." }',
      'match = { type = "all", conditions = [{ type = "field", field = "operation.domain", operator = "eq", value = "shell" }, { type = "field", field = "risk_hints.side_effect_level", operator = "in", value = ["mutating", "destructive"] }] }',
    ].join("\n"),
    "utf8",
  );
  return policyPath;
}

async function snapshotWorkspaceFiles(workspaceRoot) {
  const files = new Map();

  async function visit(currentDir) {
    const entries = await fsp.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".agentgit") {
        continue;
      }
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const relativePath = toPosixRelative(workspaceRoot, absolutePath);
      files.set(relativePath, await fsp.readFile(absolutePath, "utf8"));
    }
  }

  await visit(workspaceRoot);
  return files;
}

function diffSnapshots(before, after) {
  const added = [];
  const changed = [];
  const deleted = [];

  for (const [filePath, content] of before.entries()) {
    if (!after.has(filePath)) {
      deleted.push(filePath);
      continue;
    }
    if (after.get(filePath) !== content) {
      changed.push(filePath);
    }
  }

  for (const filePath of after.keys()) {
    if (!before.has(filePath)) {
      added.push(filePath);
    }
  }

  return {
    added: added.sort(),
    changed: changed.sort(),
    deleted: deleted.sort(),
  };
}

function snapshotsEqual(before, after) {
  const diff = diffSnapshots(before, after);
  return diff.added.length === 0 && diff.changed.length === 0 && diff.deleted.length === 0;
}

function listTrackedFiles(snapshot) {
  return [...snapshot.keys()].sort();
}

function chooseExistingFile(rng, snapshot, minimumCount = 1) {
  const files = listTrackedFiles(snapshot);
  if (files.length < minimumCount) {
    return null;
  }
  return choose(rng, files);
}

function chooseTargetPath(rng, snapshot, prefix, extension = ".txt") {
  const existingFiles = listTrackedFiles(snapshot);
  if (existingFiles.length > 0 && rng() < 0.45) {
    return choose(rng, existingFiles);
  }

  const directories = ["src", "docs", "notes", "data", "scratch", "sandbox"];
  const directory = choose(rng, directories);
  return `${directory}/${randomToken(rng, prefix)}${extension}`;
}

function makeFileContent(iteration, actionType, seed, rng) {
  return [
    `iteration: ${iteration}`,
    `action_type: ${actionType}`,
    `seed: ${seed}`,
    `marker: ${randomToken(rng, "mark")}`,
    `timestamp_hint: step-${iteration}`,
  ].join("\n");
}

function buildNodeWriteCode(absolutePath, content) {
  return [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    `const target = ${JSON.stringify(absolutePath)};`,
    "fs.mkdirSync(path.dirname(target), { recursive: true });",
    `fs.writeFileSync(target, ${JSON.stringify(content)}, "utf8");`,
  ].join(" ");
}

function buildNodeDeleteCode(absolutePath) {
  return [
    'const fs = require("node:fs");',
    `const target = ${JSON.stringify(absolutePath)};`,
    "if (fs.existsSync(target)) { fs.rmSync(target); }",
  ].join(" ");
}

function buildNodeRenameCode(sourcePath, targetPath) {
  return [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    `const source = ${JSON.stringify(sourcePath)};`,
    `const target = ${JSON.stringify(targetPath)};`,
    "fs.mkdirSync(path.dirname(target), { recursive: true });",
    "if (fs.existsSync(source)) { fs.renameSync(source, target); }",
  ].join(" ");
}

function buildNodeBurstWriteCode(workspaceRoot, files, marker) {
  return [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    `const root = ${JSON.stringify(workspaceRoot)};`,
    `const files = ${JSON.stringify(files)};`,
    `const marker = ${JSON.stringify(marker)};`,
    "for (const relative of files) {",
    "  const target = path.join(root, relative);",
    "  fs.mkdirSync(path.dirname(target), { recursive: true });",
    '  fs.writeFileSync(target, `marker=${marker}\\npath=${relative}\\n`, "utf8");',
    "}",
    "const deleteTarget = path.join(root, files[0]);",
    "if (fs.existsSync(deleteTarget)) { fs.rmSync(deleteTarget); }",
    'const replaceTarget = path.join(root, "scratch", `burst-${marker}.txt`);',
    "fs.mkdirSync(path.dirname(replaceTarget), { recursive: true });",
    'fs.writeFileSync(replaceTarget, `burst replacement ${marker}\\n`, "utf8");',
  ].join(" ");
}

function buildNodeTreeRenameCode(workspaceRoot, sourceDir, targetDir) {
  return [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    `const source = ${JSON.stringify(path.join(workspaceRoot, sourceDir))};`,
    `const target = ${JSON.stringify(path.join(workspaceRoot, targetDir))};`,
    "fs.mkdirSync(path.dirname(target), { recursive: true });",
    "if (fs.existsSync(source)) { fs.renameSync(source, target); }",
  ].join(" ");
}

function buildNodeChurnCode(workspaceRoot, relativePath, marker) {
  return [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    `const target = ${JSON.stringify(path.join(workspaceRoot, relativePath))};`,
    `const marker = ${JSON.stringify(marker)};`,
    "fs.mkdirSync(path.dirname(target), { recursive: true });",
    'fs.writeFileSync(target, `phase=1\\nmarker=${marker}\\n`, "utf8");',
    'fs.writeFileSync(target, `phase=2\\nmarker=${marker}\\n`, "utf8");',
    "fs.rmSync(target, { force: true });",
    'fs.writeFileSync(target, `phase=3\\nmarker=${marker}\\n`, "utf8");',
  ].join(" ");
}

function buildActionPlan(rng, workspaceRoot, snapshot, iteration, seed, shellShare) {
  const existingFile = chooseExistingFile(rng, snapshot);
  const shouldUseShell = rng() < shellShare;

  if (!shouldUseShell) {
    if (!existingFile || rng() < 0.62) {
      const relativePath = chooseTargetPath(rng, snapshot, "fs-write");
      const absolutePath = path.join(workspaceRoot, relativePath);
      const content = makeFileContent(iteration, "filesystem_write", seed, rng);
      return {
        kind: "filesystem_write",
        label: `filesystem write ${relativePath}`,
        target_paths: [relativePath],
        submit_args: ["submit-filesystem-write", absolutePath, content],
      };
    }

    return {
      kind: "filesystem_delete",
      label: `filesystem delete ${existingFile}`,
      target_paths: [existingFile],
      submit_args: ["submit-filesystem-delete", path.join(workspaceRoot, existingFile)],
    };
  }

  if (!existingFile || rng() < 0.5) {
    const relativePath = chooseTargetPath(rng, snapshot, "shell-write");
    const absolutePath = path.join(workspaceRoot, relativePath);
    const content = makeFileContent(iteration, "shell_write", seed, rng);
    return {
      kind: "shell_write",
      label: `shell write ${relativePath}`,
      target_paths: [relativePath],
      submit_args: ["submit-shell", "node", "-e", buildNodeWriteCode(absolutePath, content)],
    };
  }

  if (rng() < 0.5) {
    return {
      kind: "shell_delete",
      label: `shell delete ${existingFile}`,
      target_paths: [existingFile],
      submit_args: ["submit-shell", "node", "-e", buildNodeDeleteCode(path.join(workspaceRoot, existingFile))],
    };
  }

  const nextRelativePath = chooseTargetPath(rng, snapshot, "shell-rename");
  return {
    kind: "shell_rename",
    label: `shell rename ${existingFile} -> ${nextRelativePath}`,
    target_paths: [existingFile, nextRelativePath],
    submit_args: [
      "submit-shell",
      "node",
      "-e",
      buildNodeRenameCode(path.join(workspaceRoot, existingFile), path.join(workspaceRoot, nextRelativePath)),
    ],
  };
}

function buildAdversarialActionPlan(rng, workspaceRoot, snapshot, iteration, seed, fixtures) {
  const existingFile = chooseExistingFile(rng, snapshot);
  const trackedFiles = listTrackedFiles(snapshot);
  const safeExistingFile = existingFile ?? "src/app.txt";
  const burstMarker = randomToken(rng, `burst-${iteration}`);
  const treeRenameSource = trackedFiles.some((entry) => entry.startsWith("docs/")) ? "docs" : "notes";
  const treeRenameTarget = `renamed/${randomToken(rng, "tree")}`;
  const churnTarget = chooseTargetPath(rng, snapshot, "churn");
  const symlinkEscapeRelative = "linked-outside/escape.txt";
  const protectedRelative = ".env";
  const controlRelative = ".agentgit/policy.toml";

  const candidates = [
    {
      kind: "filesystem_protected_write",
      label: `protected write ${protectedRelative}`,
      target_paths: [protectedRelative],
      submit_args: [
        "submit-filesystem-write",
        path.join(workspaceRoot, protectedRelative),
        makeFileContent(iteration, "protected_write", seed, rng),
      ],
      expected_blocked: true,
    },
    {
      kind: "filesystem_control_write",
      label: `control-surface write ${controlRelative}`,
      target_paths: [controlRelative],
      submit_args: [
        "submit-filesystem-write",
        path.join(workspaceRoot, controlRelative),
        makeFileContent(iteration, "control_write", seed, rng),
      ],
      expected_blocked: true,
    },
    {
      kind: "filesystem_symlink_escape_write",
      label: `symlink escape write ${symlinkEscapeRelative}`,
      target_paths: [symlinkEscapeRelative],
      submit_args: [
        "submit-filesystem-write",
        path.join(workspaceRoot, symlinkEscapeRelative),
        makeFileContent(iteration, "symlink_escape_write", seed, rng),
      ],
      expected_blocked: true,
    },
    {
      kind: "filesystem_symlink_escape_delete",
      label: `symlink escape delete linked-outside/outside.txt`,
      target_paths: ["linked-outside/outside.txt"],
      submit_args: ["submit-filesystem-delete", path.join(workspaceRoot, "linked-outside", "outside.txt")],
      expected_blocked: true,
    },
    {
      kind: "shell_burst_tree",
      label: `shell burst tree churn ${burstMarker}`,
      target_paths: ["src", "docs", "scratch"],
      submit_args: [
        "submit-shell",
        "node",
        "-e",
        buildNodeBurstWriteCode(
          workspaceRoot,
          ["src/burst-a.txt", "docs/burst-b.md", "notes/burst-c.txt"],
          burstMarker,
        ),
      ],
      expected_review_only: true,
    },
    {
      kind: "shell_tree_rename",
      label: `shell tree rename ${treeRenameSource} -> ${treeRenameTarget}`,
      target_paths: [treeRenameSource, treeRenameTarget],
      submit_args: [
        "submit-shell",
        "node",
        "-e",
        buildNodeTreeRenameCode(workspaceRoot, treeRenameSource, treeRenameTarget),
      ],
      expected_review_only: true,
    },
    {
      kind: "shell_churn_file",
      label: `shell churn ${churnTarget}`,
      target_paths: [churnTarget],
      submit_args: ["submit-shell", "node", "-e", buildNodeChurnCode(workspaceRoot, churnTarget, burstMarker)],
      expected_review_only: true,
    },
    {
      kind: "filesystem_overwrite_existing",
      label: `filesystem overwrite ${safeExistingFile}`,
      target_paths: [safeExistingFile],
      submit_args: [
        "submit-filesystem-write",
        path.join(workspaceRoot, safeExistingFile),
        makeFileContent(iteration, "overwrite_existing", seed, rng),
      ],
    },
    {
      kind: "filesystem_delete_existing",
      label: `filesystem delete ${safeExistingFile}`,
      target_paths: [safeExistingFile],
      submit_args: ["submit-filesystem-delete", path.join(workspaceRoot, safeExistingFile)],
    },
  ];

  const chosen = candidates[(iteration - 1) % candidates.length];
  return {
    ...chosen,
    fixtures,
  };
}

async function waitFor(checkFn, label, timeoutMs = 15_000, intervalMs = 200) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await checkFn()) {
      return;
    }
    await delay(intervalMs);
  }
  throw new Error(`Timed out while waiting for ${label}.`);
}

async function startDaemon(workspaceRoot, logDir) {
  const socketPath = path.join(workspaceRoot, ".agentgit", "authority.sock");
  const daemonStdout = path.join(logDir, "daemon.stdout.log");
  const daemonStderr = path.join(logDir, "daemon.stderr.log");
  const outFd = fs.openSync(daemonStdout, "a");
  const errFd = fs.openSync(daemonStderr, "a");
  const daemon = spawn("node", [authorityDaemon], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AGENTGIT_ROOT: workspaceRoot,
    },
    stdio: ["ignore", outFd, errFd],
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);

  await waitFor(async () => pathExists(socketPath), "authority daemon socket");

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
  await Promise.race([new Promise((resolve) => daemonHandle.process.once("exit", resolve)), delay(3_000)]);
  if (!daemonHandle.process.killed && daemonHandle.process.exitCode === null) {
    daemonHandle.process.kill("SIGKILL");
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rng = createRng(options.seed);
  const tempBase = process.platform === "win32" ? os.tmpdir() : "/tmp";
  const sessionRoot = await fsp.mkdtemp(path.join(tempBase, "agentgit-autonomy-stress-"));
  const workspaceRoot = options.workspaceRoot ?? path.join(sessionRoot, "workspace");
  const reportRoot = path.join(sessionRoot, "report");
  const logDir = path.join(sessionRoot, "logs");
  const evidenceDir = path.join(reportRoot, "evidence");

  await fsp.mkdir(workspaceRoot, { recursive: true });
  await fsp.mkdir(logDir, { recursive: true });
  await fsp.mkdir(evidenceDir, { recursive: true });

  let daemonHandle = null;

  try {
    printStep("Build authority surfaces");
    await buildArtifacts();

    printStep("Seed workspace and policy");
    await seedWorkspace(workspaceRoot);
    const policyPath = await writeWorkspacePolicy(workspaceRoot);
    const adversarialFixtures =
      options.profile === "adversarial" ? await seedAdversarialFixtures(workspaceRoot, sessionRoot) : null;

    printStep("Start daemon");
    daemonHandle = await startDaemon(workspaceRoot, logDir);

    const runCliJson = async (args, label, commandOptions = {}) => {
      const result = await runRequired(
        "node",
        [authorityCli, "--json", "--socket-path", daemonHandle.socketPath, "--workspace-root", workspaceRoot, ...args],
        commandOptions,
      );
      return parseJsonOutput(result, label);
    };

    const safeParseJsonOutput = (result) => {
      try {
        return result.stdout ? JSON.parse(result.stdout) : result.stderr ? JSON.parse(result.stderr) : null;
      } catch {
        return null;
      }
    };

    await runCliJson(["ping"], "ping");

    const registerRun = await runCliJson(["register-run", "autonomy-stress"], "register-run");
    const runId = registerRun.run_id;
    if (!runId) {
      throw new Error(`register-run did not return a run_id.\n${JSON.stringify(registerRun, null, 2)}`);
    }

    const summary = {
      ok: true,
      seed: options.seed,
      profile: options.profile,
      iterations_requested: options.iterations,
      delay_ms: options.delayMs,
      recover_every: options.recoverEvery,
      shell_share: options.shellShare,
      workspace_root: workspaceRoot,
      session_root: sessionRoot,
      policy_path: policyPath,
      run_id: runId,
      socket_path: daemonHandle.socketPath,
      daemon_logs: daemonHandle.logs,
      totals: {
        attempted: 0,
        completed: 0,
        blocked: 0,
        denied: 0,
        ask: 0,
        allow: 0,
        allow_with_snapshot: 0,
        snapshot_backed: 0,
        command_failures: 0,
        expected_blocked: 0,
        expected_blocked_matches: 0,
        expected_blocked_mismatches: 0,
        expected_review_only: 0,
        expected_review_only_matches: 0,
        expected_review_only_mismatches: 0,
        recovery_planned: 0,
        recovery_reversible: 0,
        recovery_review_only: 0,
        recovery_compensatable: 0,
        recovery_irreversible: 0,
        recovery_executed: 0,
        exact_restore_matches: 0,
        exact_restore_mismatches: 0,
      },
      iterations: [],
    };

    let currentSnapshot = await snapshotWorkspaceFiles(workspaceRoot);

    printStep("Run autonomous randomized actions");
    for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
      const beforeSnapshot = currentSnapshot;
      const actionPlan = buildActionPlan(
        rng,
        workspaceRoot,
        beforeSnapshot,
        iteration,
        options.seed,
        options.shellShare,
      );
      const effectiveActionPlan =
        options.profile === "adversarial"
          ? buildAdversarialActionPlan(rng, workspaceRoot, beforeSnapshot, iteration, options.seed, adversarialFixtures)
          : actionPlan;

      const iterationRecord = {
        iteration,
        kind: effectiveActionPlan.kind,
        label: effectiveActionPlan.label,
        target_paths: effectiveActionPlan.target_paths,
        expected_blocked: Boolean(effectiveActionPlan.expected_blocked),
        expected_review_only: Boolean(effectiveActionPlan.expected_review_only),
        policy_decision: null,
        action_id: null,
        snapshot_id: null,
        cli_exit_code: null,
        command_failed: false,
        cli_error_code: null,
        recovery_class: null,
        recovery_strategy: null,
        recovered: false,
        exact_restore_match: null,
        drift: null,
      };

      const submitRawResult = await runCommand("node", [
        authorityCli,
        "--json",
        "--socket-path",
        daemonHandle.socketPath,
        "--workspace-root",
        workspaceRoot,
        ...effectiveActionPlan.submit_args.slice(0, 1),
        runId,
        ...effectiveActionPlan.submit_args.slice(1),
      ]);
      iterationRecord.cli_exit_code = submitRawResult.code;

      const parsedSubmit = safeParseJsonOutput(submitRawResult);
      const decision = parsedSubmit?.policy_outcome?.decision ?? (parsedSubmit?.error_code ? "blocked_by_error" : null);
      const actionId = parsedSubmit?.action?.action_id ?? null;
      const snapshotId = parsedSubmit?.snapshot_record?.snapshot_id ?? null;
      if (submitRawResult.code !== 0 && !parsedSubmit?.policy_outcome) {
        iterationRecord.command_failed = true;
        iterationRecord.cli_error_code = parsedSubmit?.error_code ?? null;
        summary.totals.command_failures += 1;
      }

      iterationRecord.policy_decision = decision;
      iterationRecord.action_id = actionId;
      iterationRecord.snapshot_id = snapshotId;

      summary.totals.attempted += 1;
      if (decision === "deny" || decision === "blocked_by_error") {
        summary.totals.denied += 1;
        summary.totals.blocked += 1;
      } else if (decision === "ask") {
        summary.totals.ask += 1;
        summary.totals.blocked += 1;
      } else if (decision === "allow") {
        summary.totals.allow += 1;
        summary.totals.completed += 1;
      } else if (decision === "allow_with_snapshot") {
        summary.totals.allow_with_snapshot += 1;
        summary.totals.completed += 1;
      }

      if (snapshotId) {
        summary.totals.snapshot_backed += 1;
      }

      currentSnapshot = await snapshotWorkspaceFiles(workspaceRoot);

      if (iterationRecord.expected_blocked) {
        summary.totals.expected_blocked += 1;
        const blocked = decision === "deny" || decision === "ask" || decision === "blocked_by_error";
        if (blocked) {
          summary.totals.expected_blocked_matches += 1;
        } else {
          summary.totals.expected_blocked_mismatches += 1;
        }
      }

      const shouldRecover =
        options.recoverEvery > 0 &&
        iteration % options.recoverEvery === 0 &&
        typeof actionId === "string" &&
        typeof snapshotId === "string";

      if (shouldRecover) {
        const planResult = await runCliJson(["plan-recovery", actionId], "plan-recovery");
        const recoveryPlan = planResult.recovery_plan;
        iterationRecord.recovery_class = recoveryPlan?.recovery_class ?? null;
        iterationRecord.recovery_strategy = recoveryPlan?.strategy ?? null;
        summary.totals.recovery_planned += 1;

        if (recoveryPlan?.recovery_class === "reversible") {
          summary.totals.recovery_reversible += 1;
          const executeResult = await runCliJson(["execute-recovery", actionId], "execute-recovery");
          iterationRecord.recovered = Boolean(executeResult.restored);
          if (executeResult.restored) {
            summary.totals.recovery_executed += 1;
          }
          const afterRecoverySnapshot = await snapshotWorkspaceFiles(workspaceRoot);
          const exactMatch = snapshotsEqual(beforeSnapshot, afterRecoverySnapshot);
          const drift = diffSnapshots(beforeSnapshot, afterRecoverySnapshot);
          iterationRecord.exact_restore_match = exactMatch;
          iterationRecord.drift = drift;
          if (exactMatch) {
            summary.totals.exact_restore_matches += 1;
          } else {
            summary.totals.exact_restore_mismatches += 1;
          }
          currentSnapshot = afterRecoverySnapshot;
        } else if (recoveryPlan?.recovery_class === "review_only") {
          summary.totals.recovery_review_only += 1;
        } else if (recoveryPlan?.recovery_class === "compensatable") {
          summary.totals.recovery_compensatable += 1;
        } else if (recoveryPlan?.recovery_class === "irreversible") {
          summary.totals.recovery_irreversible += 1;
        }
      }

      if (iterationRecord.expected_review_only) {
        summary.totals.expected_review_only += 1;
        if (iterationRecord.recovery_class === "review_only") {
          summary.totals.expected_review_only_matches += 1;
        } else if (shouldRecover) {
          summary.totals.expected_review_only_mismatches += 1;
        }
      }

      summary.iterations.push(iterationRecord);
      process.stdout.write(
        `step ${String(iteration).padStart(2, "0")}: ${effectiveActionPlan.label} -> ${decision ?? "unknown"}${
          iterationRecord.recovery_class ? `, recovery=${iterationRecord.recovery_class}` : ""
        }${iterationRecord.exact_restore_match === true ? ", exact-restore=yes" : iterationRecord.exact_restore_match === false ? ", exact-restore=no" : ""}\n`,
      );

      if (options.delayMs > 0 && iteration < options.iterations) {
        await delay(options.delayMs);
      }
    }

    printStep("Capture evidence");
    const runSummary = await runCliJson(["run-summary", runId], "run-summary");
    const timeline = await runCliJson(["timeline", runId, "internal"], "timeline");
    const helper = await runCliJson(["helper", runId, "what_happened"], "helper");
    const calibration = await runCliJson(
      ["policy", "calibration-report", "--run-id", runId, "--include-samples"],
      "policy calibration-report",
    );
    const diagnostics = await runCliJson(["diagnostics", "storage_summary", "policy_summary"], "diagnostics");

    await writeJson(path.join(evidenceDir, "run-summary.json"), runSummary);
    await writeJson(path.join(evidenceDir, "timeline.internal.json"), timeline);
    await writeJson(path.join(evidenceDir, "helper.what-happened.json"), helper);
    await writeJson(path.join(evidenceDir, "policy-calibration-report.json"), calibration);
    await writeJson(path.join(evidenceDir, "diagnostics.json"), diagnostics);

    summary.evidence = {
      run_summary_path: path.join(evidenceDir, "run-summary.json"),
      timeline_path: path.join(evidenceDir, "timeline.internal.json"),
      helper_path: path.join(evidenceDir, "helper.what-happened.json"),
      calibration_path: path.join(evidenceDir, "policy-calibration-report.json"),
      diagnostics_path: path.join(evidenceDir, "diagnostics.json"),
    };

    summary.ok =
      summary.totals.exact_restore_mismatches === 0 &&
      summary.totals.expected_blocked_mismatches === 0 &&
      summary.totals.expected_review_only_mismatches === 0;

    await writeJson(path.join(reportRoot, "summary.json"), summary);

    process.stdout.write(
      [
        "",
        "Autonomous governance stress summary",
        `Workspace: ${workspaceRoot}`,
        `Run: ${runId}`,
        `Attempted: ${summary.totals.attempted}`,
        `Completed: ${summary.totals.completed}`,
        `Blocked: ${summary.totals.blocked}`,
        `Snapshot-backed: ${summary.totals.snapshot_backed}`,
        `Reversible recoveries: ${summary.totals.recovery_reversible}`,
        `Review-only recoveries: ${summary.totals.recovery_review_only}`,
        `Exact restore matches: ${summary.totals.exact_restore_matches}`,
        `Exact restore mismatches: ${summary.totals.exact_restore_mismatches}`,
        `Summary report: ${path.join(reportRoot, "summary.json")}`,
        "",
        JSON.stringify(summary, null, 2),
        "",
      ].join("\n"),
    );
  } finally {
    if (!options.keepDaemon) {
      await stopDaemon(daemonHandle);
    }
  }
}

await main();
