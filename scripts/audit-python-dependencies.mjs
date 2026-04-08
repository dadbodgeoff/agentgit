#!/usr/bin/env node

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveCommandPath } from "./command-paths.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pythonPackageDir = path.join(repoRoot, "packages", "authority-sdk-py");
const pyprojectPath = path.join(pythonPackageDir, "pyproject.toml");
const PYTHON3 = resolveCommandPath("python3");

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

function pythonBin(venvRoot, name) {
  if (process.platform === "win32") {
    return path.join(venvRoot, "Scripts", `${name}.exe`);
  }
  return path.join(venvRoot, "bin", name);
}

async function extractAuditRequirements(tempRoot) {
  const requirementsPath = path.join(tempRoot, "python-audit-requirements.txt");
  const pythonScript = `
import tomllib
from pathlib import Path

pyproject_path = Path(${JSON.stringify(pyprojectPath)})
data = tomllib.loads(pyproject_path.read_text(encoding="utf-8"))

requirements = []
requirements.extend(data.get("project", {}).get("dependencies", []))
requirements.extend(data.get("build-system", {}).get("requires", []))

deduped = []
seen = set()
for requirement in requirements:
    if requirement in seen:
        continue
    deduped.append(requirement)
    seen.add(requirement)

output_path = Path(${JSON.stringify(requirementsPath)})
output_path.write_text("\\n".join(deduped), encoding="utf-8")
print(output_path)
`;

  await runCommand(PYTHON3, ["-c", pythonScript], {
    cwd: repoRoot,
  });
  return requirementsPath;
}

async function main() {
  const tempBase = process.platform === "win32" ? os.tmpdir() : "/tmp";
  const tempRoot = await fsp.mkdtemp(path.join(tempBase, "agentgit-py-audit-"));
  const venvRoot = path.join(tempRoot, "venv");

  try {
    const requirementsPath = await extractAuditRequirements(tempRoot);
    const requirements = (await fsp.readFile(requirementsPath, "utf8"))
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (requirements.length === 0) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: true,
            audited: false,
            reason: "No Python dependencies declared in pyproject.toml for audit scope.",
            pyproject_path: pyprojectPath,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    await runCommand(PYTHON3, ["-m", "venv", venvRoot], {
      cwd: repoRoot,
    });

    const venvPython = pythonBin(venvRoot, "python");
    const venvPipAudit = pythonBin(venvRoot, "pip-audit");

    await runCommand(venvPython, ["-m", "pip", "install", "--upgrade", "pip"], {
      cwd: repoRoot,
    });
    await runCommand(venvPython, ["-m", "pip", "install", "pip-audit"], {
      cwd: repoRoot,
    });

    const audit = await runCommand(venvPipAudit, ["-r", requirementsPath], {
      cwd: repoRoot,
      env: {
        PIPAPI_PYTHON_LOCATION: venvPython,
      },
    });

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          audited: true,
          pyproject_path: pyprojectPath,
          requirements_path: requirementsPath,
          requirement_count: requirements.length,
          audit_stdout: audit.stdout,
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
