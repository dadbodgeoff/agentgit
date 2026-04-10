#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveCommandPath } from "./command-paths.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCKER = resolveCommandPath("docker");
const NPM = resolveCommandPath("npm");
const parsedArgs = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const parsed = {
    artifactsDir: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--artifacts-dir") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--artifacts-dir expects a path.");
      }
      parsed.artifactsDir = path.resolve(value);
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
      const result = {
        code: code ?? -1,
        signal: signal ?? null,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      };

      if (options.acceptExitCodes?.includes(result.code) || (result.code === 0 && !options.acceptExitCodes)) {
        resolve(result);
        return;
      }

      reject(
        new Error(
          `${command} ${args.join(" ")} failed with exit code ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        ),
      );
    });
  });
}

function installedAgentGitPath(installRoot) {
  return path.join(installRoot, "node_modules", ".bin", process.platform === "win32" ? "agentgit.cmd" : "agentgit");
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
  const result = await runCommand(DOCKER, ["info"], {
    acceptExitCodes: [0, 1, 127],
  });
  return result.code === 0;
}

function requireIncludes(output, needle, context) {
  if (!output.includes(needle)) {
    throw new Error(`${context} did not include expected text: ${needle}\nActual output:\n${output}`);
  }
}

async function loadPackedArtifacts(tarballDir) {
  if (parsedArgs.artifactsDir) {
    const manifestPath = path.join(parsedArgs.artifactsDir, "manifest.json");
    return JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  }

  const packed = await runCommand(
    process.execPath,
    [path.join(repoRoot, "scripts", "pack-release-artifacts.mjs"), "--out-dir", tarballDir],
    { cwd: repoRoot },
  );
  return JSON.parse(packed.stdout);
}

async function main() {
  const tempBase = process.platform === "win32" ? os.tmpdir() : "/tmp";
  const tempRoot = await fsp.mkdtemp(path.join(tempBase, "agentgit-install-smoke-"));
  const tarballDir = path.join(tempRoot, "tarballs");
  const installRoot = path.join(tempRoot, "install-root");
  const demoRoot = path.join(tempRoot, "demo");
  const genericRoot = path.join(tempRoot, "generic");
  const containedRoot = path.join(tempRoot, "contained");
  const configRoot = path.join(tempRoot, "config-root");

  const sharedEnv = {
    XDG_CONFIG_HOME: configRoot,
    NPM_CONFIG_CACHE: path.join(tempRoot, "npm-cache"),
  };

  await fsp.mkdir(installRoot, { recursive: true });
  await fsp.mkdir(demoRoot, { recursive: true });
  await fsp.mkdir(genericRoot, { recursive: true });
  await fsp.mkdir(containedRoot, { recursive: true });

  try {
    const packManifest = await loadPackedArtifacts(tarballDir);
    const tarballs = packManifest.packages.map((pkg) => pkg.tarball_path);

    await runCommand(NPM, ["init", "-y"], { cwd: installRoot, env: sharedEnv });
    await runCommand(NPM, ["install", "--no-package-lock", ...tarballs], {
      cwd: installRoot,
      env: sharedEnv,
    });

    const installedAgentGit = installedAgentGitPath(installRoot);
    if (!(await pathExists(installedAgentGit))) {
      throw new Error(`Installed agentgit binary not found at ${installedAgentGit}`);
    }

    const runAgentGit = (workspaceRoot, args, options = {}) =>
      runCommand(installedAgentGit, ["--workspace-root", workspaceRoot, ...args], {
        cwd: installRoot,
        env: {
          ...sharedEnv,
          ...(options.env ?? {}),
        },
        acceptExitCodes: options.acceptExitCodes,
      });

    const demoResult = await runAgentGit(demoRoot, ["demo"]);
    requireIncludes(demoResult.stdout, "Demo ready", "installed agentgit demo");

    const demoInspect = await runAgentGit(demoRoot, ["inspect"]);
    requireIncludes(demoInspect.stdout, "Restore available: yes", "installed agentgit inspect after demo");

    const demoPreview = await runAgentGit(demoRoot, ["restore", "--preview"]);
    requireIncludes(demoPreview.stdout, "Preview only: yes", "installed agentgit restore --preview");

    const demoRestore = await runAgentGit(demoRoot, ["restore"]);
    requireIncludes(demoRestore.stdout, "Restore complete", "installed agentgit restore");

    const restoredPathLine = demoRestore.stdout.split("\n").find((line) => line.startsWith("Target: "));
    if (!restoredPathLine) {
      throw new Error(`Unable to determine installed demo restore target.\n${demoRestore.stdout}`);
    }
    const restoredPath = restoredPathLine.replace("Target: ", "").trim();
    if (!(await pathExists(restoredPath))) {
      throw new Error(`Installed demo restore reported success, but restored file is missing: ${restoredPath}`);
    }

    const genericSetup = await runAgentGit(genericRoot, ["setup", "--yes", "--command", 'node -e "process.exit(7)"']);
    requireIncludes(genericSetup.stdout, "Assurance level: attached", "installed agentgit setup attached");

    const genericRun = await runAgentGit(genericRoot, ["run"], { acceptExitCodes: [7] });
    if (genericRun.code !== 7) {
      throw new Error(
        `Installed generic run did not preserve child exit code 7.\nstdout:\n${genericRun.stdout}\nstderr:\n${genericRun.stderr}`,
      );
    }

    const genericInspect = await runAgentGit(genericRoot, ["inspect"]);
    requireIncludes(genericInspect.stdout, "Assurance level: attached", "installed agentgit inspect attached");

    const summary = {
      ok: true,
      install_root: installRoot,
      config_root: configRoot,
      docker_available: false,
      demo: {
        workspace_root: demoRoot,
        restored_path: restoredPath,
      },
      generic: {
        workspace_root: genericRoot,
        exit_code: genericRun.code,
      },
      contained: {
        skipped: false,
      },
      packed_artifacts: packManifest.packages,
    };

    summary.docker_available = await detectDocker();
    if (!summary.docker_available) {
      summary.contained = {
        skipped: true,
      };
    } else {
      const oldFile = path.join(containedRoot, "old.txt");
      const noteFile = path.join(containedRoot, "note.txt");
      await fsp.writeFile(oldFile, "to-delete\n", "utf8");

      const containedSetup = await runAgentGit(containedRoot, [
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
      requireIncludes(containedSetup.stdout, "Assurance level: contained", "installed agentgit setup contained");

      await runAgentGit(containedRoot, ["run"]);

      const containedInspect = await runAgentGit(containedRoot, ["inspect"]);
      requireIncludes(containedInspect.stdout, "Assurance level: contained", "installed agentgit inspect contained");

      const oldExists = await pathExists(oldFile);
      const noteExists = await pathExists(noteFile);
      const noteContents = noteExists ? await fsp.readFile(noteFile, "utf8") : "";
      if (oldExists) {
        throw new Error(`Installed contained run did not publish the delete back to the real workspace: ${oldFile}`);
      }
      if (!noteExists) {
        throw new Error(
          `Installed contained run did not publish the created file back to the real workspace: ${noteFile}`,
        );
      }
      if (noteContents.trim() !== "contained") {
        throw new Error(`Installed contained run wrote unexpected note.txt contents: ${noteContents}`);
      }

      summary.contained = {
        skipped: false,
        workspace_root: containedRoot,
        deleted_path: oldFile,
        created_path: noteFile,
      };
    }

    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
