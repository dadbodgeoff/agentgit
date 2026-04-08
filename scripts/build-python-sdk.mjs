#!/usr/bin/env node

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveCommandPath } from "./command-paths.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(repoRoot, "packages", "authority-sdk-py");
const PYTHON3 = resolveCommandPath("python3");

function venvBinDir(root) {
  return process.platform === "win32" ? path.join(root, "Scripts") : path.join(root, "bin");
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

async function main() {
  const tempBase = process.platform === "win32" ? os.tmpdir() : "/tmp";
  const tempRoot = await fsp.mkdtemp(path.join(tempBase, "agentgit-python-build-"));
  const buildVenv = path.join(tempRoot, "build-venv");
  const installVenv = path.join(tempRoot, "install-venv");
  const distDir = path.join(tempRoot, "dist");

  try {
    await runCommand(PYTHON3, ["-m", "venv", buildVenv]);
    await runCommand(path.join(venvBinDir(buildVenv), process.platform === "win32" ? "python.exe" : "python"), [
      "-m",
      "pip",
      "install",
      "--upgrade",
      "pip",
      "build",
      "wheel",
      "setuptools",
    ]);

    const buildPython = path.join(venvBinDir(buildVenv), process.platform === "win32" ? "python.exe" : "python");
    await runCommand(buildPython, ["-m", "build", packageRoot, "--outdir", distDir], {
      cwd: repoRoot,
    });

    const artifacts = (await fsp.readdir(distDir)).sort();
    const wheel = artifacts.find((entry) => entry.endsWith(".whl"));
    const sdist = artifacts.find((entry) => entry.endsWith(".tar.gz"));
    if (!wheel || !sdist) {
      throw new Error(`Expected both wheel and sdist artifacts, found: ${artifacts.join(", ")}`);
    }

    await runCommand(PYTHON3, ["-m", "venv", installVenv]);
    const installPython = path.join(venvBinDir(installVenv), process.platform === "win32" ? "python.exe" : "python");
    await runCommand(installPython, ["-m", "pip", "install", "--upgrade", "pip"]);
    await runCommand(installPython, ["-m", "pip", "install", path.join(distDir, wheel)]);
    const importSmoke = await runCommand(installPython, [
      "-c",
      [
        "import json",
        "import agentgit_authority",
        "from agentgit_authority import AuthorityClient",
        "print(json.dumps({",
        '  "module_path": agentgit_authority.__file__,',
        '  "client_name": AuthorityClient.__name__',
        "}))",
      ].join("\n"),
    ]);

    const importResult = JSON.parse(importSmoke.stdout);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          package_root: packageRoot,
          dist_dir: distDir,
          artifacts,
          import_smoke: importResult,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
