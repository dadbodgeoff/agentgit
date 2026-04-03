#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productCli = path.join(repoRoot, "packages", "agent-runtime-integration", "dist", "main.js");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
        code: code ?? 0,
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

async function runAgentGit(workspaceRoot, args, options = {}) {
  return runCommand("node", [productCli, "--workspace-root", workspaceRoot, ...args], options);
}

async function runAgentGitRequired(workspaceRoot, args, options = {}) {
  const maxAttempts = options.maxAttempts ?? 1;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runAgentGit(workspaceRoot, args, options);
    if (result.code === 0) {
      return result;
    }
    if (
      attempt < maxAttempts &&
      `${result.stdout}\n${result.stderr}`.includes("EADDRINUSE")
    ) {
      lastError = new Error(
        `Transient socket collision while running agentgit ${args.join(" ")}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      await delay(250);
      continue;
    }
    throw new Error(
      `agentgit ${args.join(" ")} failed with exit code ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  throw lastError ?? new Error(`agentgit ${args.join(" ")} failed.`);
}

function printStep(label) {
  process.stdout.write(`\n== ${label} ==\n`);
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

function requireIncludes(output, needle, context) {
  if (!output.includes(needle)) {
    throw new Error(`${context} did not include expected text: ${needle}\nActual output:\n${output}`);
  }
}

async function main() {
  const tempBase = process.platform === "win32" ? os.tmpdir() : "/tmp";
  const tempRoot = await fsp.mkdtemp(path.join(tempBase, "agentgit-runtime-smoke-"));
  const demoRoot = path.join(tempRoot, "demo");
  const genericRoot = path.join(tempRoot, "generic");
  const containedRoot = path.join(tempRoot, "contained");
  const summary = {
    ok: true,
    temp_root: tempRoot,
    docker_available: false,
    demo: {},
    generic: {},
    contained: {
      skipped: false,
    },
  };

  await fsp.mkdir(demoRoot, { recursive: true });
  await fsp.mkdir(genericRoot, { recursive: true });
  await fsp.mkdir(containedRoot, { recursive: true });

  try {
    printStep("Build product CLI");
    await runRequired("pnpm", [
      "exec",
      "turbo",
      "run",
      "build",
      "--filter=@agentgit/agent-runtime-integration^...",
      "--filter=@agentgit/agent-runtime-integration",
    ]);

    if (!(await pathExists(productCli))) {
      throw new Error(`Built product CLI not found at ${productCli}`);
    }

    printStep("Demo flow");
    const demoResult = await runAgentGitRequired(demoRoot, ["demo"]);
    process.stdout.write(`${demoResult.stdout}\n`);
    requireIncludes(demoResult.stdout, "Demo ready", "agentgit demo");

    const demoInspect = await runAgentGitRequired(demoRoot, ["inspect"], { maxAttempts: 2 });
    process.stdout.write(`${demoInspect.stdout}\n`);
    requireIncludes(demoInspect.stdout, "Restore available: yes", "agentgit inspect after demo");

    const demoPreview = await runAgentGitRequired(demoRoot, ["restore", "--preview"]);
    process.stdout.write(`${demoPreview.stdout}\n`);
    requireIncludes(demoPreview.stdout, "Preview only: yes", "agentgit restore --preview");

    const demoRestore = await runAgentGitRequired(demoRoot, ["restore"]);
    process.stdout.write(`${demoRestore.stdout}\n`);
    requireIncludes(demoRestore.stdout, "Restore complete", "agentgit restore");

    const governedWorkspaceLine = demoRestore.stdout
      .split("\n")
      .find((line) => line.startsWith("Governed workspace: "));
    const restoredPathLine = demoRestore.stdout
      .split("\n")
      .find((line) => line.startsWith("Target: "));
    if (!governedWorkspaceLine || !restoredPathLine) {
      throw new Error(`Unable to determine restored demo path.\n${demoRestore.stdout}`);
    }
    const restoredPath = restoredPathLine.replace("Target: ", "").trim();
    if (!(await pathExists(restoredPath))) {
      throw new Error(`Demo restore reported success, but restored file is missing: ${restoredPath}`);
    }
    summary.demo = {
      workspace_root: demoRoot,
      governed_workspace_root: governedWorkspaceLine.replace("Governed workspace: ", "").trim(),
      restored_path: restoredPath,
    };

    printStep("Generic attached launch");
    const genericSetup = await runAgentGitRequired(genericRoot, [
      "setup",
      "--yes",
      "--command",
      'node -e "process.exit(7)"',
    ]);
    process.stdout.write(`${genericSetup.stdout}\n`);
    requireIncludes(genericSetup.stdout, "Assurance level: attached", "agentgit setup attached");

    const genericRun = await runAgentGit(genericRoot, ["run"]);
    if (genericRun.code !== 7) {
      throw new Error(
        `Generic run did not preserve child exit code 7.\nstdout:\n${genericRun.stdout}\nstderr:\n${genericRun.stderr}`,
      );
    }
    process.stdout.write("Generic run preserved exit code 7.\n");

    const genericInspect = await runAgentGitRequired(genericRoot, ["inspect"], { maxAttempts: 2 });
    process.stdout.write(`${genericInspect.stdout}\n`);
    requireIncludes(genericInspect.stdout, "Assurance level: attached", "agentgit inspect attached");
    summary.generic = {
      workspace_root: genericRoot,
      exit_code: genericRun.code,
    };

    printStep("Docker-contained launch");
    summary.docker_available = await detectDocker();
    if (!summary.docker_available) {
      process.stdout.write("Docker not available, skipping contained smoke.\n");
      summary.contained = {
        skipped: true,
      };
    } else {
      const oldFile = path.join(containedRoot, "old.txt");
      const noteFile = path.join(containedRoot, "note.txt");
      await fsp.writeFile(oldFile, "to-delete\n", "utf8");

      const containedSetup = await runAgentGitRequired(containedRoot, [
        "setup",
        "--yes",
        "--contained",
        "--command",
        "sh -lc 'rm -f old.txt && echo contained > note.txt'",
        "--network",
        "none",
        "--credentials",
        "none",
      ]);
      process.stdout.write(`${containedSetup.stdout}\n`);
      requireIncludes(containedSetup.stdout, "Assurance level: contained", "agentgit setup contained");

      const containedRun = await runAgentGitRequired(containedRoot, ["run"], { maxAttempts: 2 });
      if (containedRun.stdout) {
        process.stdout.write(`${containedRun.stdout}\n`);
      }

      const containedInspect = await runAgentGitRequired(containedRoot, ["inspect"], { maxAttempts: 2 });
      process.stdout.write(`${containedInspect.stdout}\n`);
      requireIncludes(containedInspect.stdout, "Assurance level: contained", "agentgit inspect contained");

      const oldExists = await pathExists(oldFile);
      const noteExists = await pathExists(noteFile);
      const noteContents = noteExists ? await fsp.readFile(noteFile, "utf8") : "";
      if (oldExists) {
        throw new Error(`Contained run did not publish the delete back to the real workspace: ${oldFile}`);
      }
      if (!noteExists) {
        throw new Error(`Contained run did not publish the created file back to the real workspace: ${noteFile}`);
      }
      if (noteContents.trim() !== "contained") {
        throw new Error(`Contained run wrote unexpected note.txt contents: ${noteContents}`);
      }
      summary.contained = {
        skipped: false,
        workspace_root: containedRoot,
        deleted_path: oldFile,
        created_path: noteFile,
      };
    }

    process.stdout.write(`\n${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
