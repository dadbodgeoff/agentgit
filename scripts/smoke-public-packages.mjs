#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { releaseNpmPackageNames } from "./release-package-config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const parsedArgs = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const parsed = {
    artifactsDir: path.join(repoRoot, ".release-artifacts", "packed"),
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

function installedPackageDir(installRoot, packageName) {
  if (!packageName.startsWith("@")) {
    return path.join(installRoot, "node_modules", packageName);
  }

  const [, scope, name] = packageName.match(/^@([^/]+)\/(.+)$/u) ?? [];
  return path.join(installRoot, "node_modules", `@${scope}`, name);
}

function installedBinPath(installRoot, binName) {
  return path.join(installRoot, "node_modules", ".bin", process.platform === "win32" ? `${binName}.cmd` : binName);
}

function shouldImportPackage(packageJson) {
  return packageJson.name !== "@agentgit/authority-cli";
}

async function verifyEntryFile(packageDir, relativePath, label) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    return null;
  }
  const entryPath = path.join(packageDir, relativePath);
  await fsp.access(entryPath, fs.constants.F_OK);
  return {
    label,
    path: entryPath,
  };
}

async function verifyExports(packageDir, exportsField) {
  if (!exportsField || typeof exportsField !== "object" || Array.isArray(exportsField)) {
    return [];
  }

  const rootExport = exportsField["."];
  if (!rootExport || typeof rootExport !== "object" || Array.isArray(rootExport)) {
    return [];
  }

  const results = [];
  for (const [key, value] of Object.entries(rootExport)) {
    if (typeof value !== "string") {
      continue;
    }
    results.push(await verifyEntryFile(packageDir, value, `exports.${key}`));
  }

  return results.filter(Boolean);
}

async function main() {
  const manifestPath = path.join(parsedArgs.artifactsDir, "manifest.json");
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  const manifestPackageNames = new Set(manifest.packages.map((pkg) => pkg.name));

  if (manifestPackageNames.size !== releaseNpmPackageNames.size) {
    throw new Error(
      `Release manifest package count ${manifestPackageNames.size} did not match the public package count ${releaseNpmPackageNames.size}.`,
    );
  }

  for (const packageName of releaseNpmPackageNames) {
    if (!manifestPackageNames.has(packageName)) {
      throw new Error(`Release artifacts are missing the public package ${packageName}.`);
    }
  }

  const tempBase = process.platform === "win32" ? os.tmpdir() : "/tmp";
  const tempRoot = await fsp.mkdtemp(path.join(tempBase, "agentgit-public-packages-"));
  const installRoot = path.join(tempRoot, "install-root");

  try {
    await fsp.mkdir(installRoot, { recursive: true });
    await runCommand("npm", ["init", "-y"], { cwd: installRoot });
    await runCommand(
      "npm",
      ["install", "--no-package-lock", ...manifest.packages.map((pkg) => pkg.tarball_path)],
      { cwd: installRoot },
    );

    const packageChecks = [];
    for (const pkg of manifest.packages) {
      const packageDir = installedPackageDir(installRoot, pkg.name);
      const packageJsonPath = path.join(packageDir, "package.json");
      const packageJson = JSON.parse(await fsp.readFile(packageJsonPath, "utf8"));
      const entrypoints = [];

      if (typeof packageJson.main === "string") {
        entrypoints.push(await verifyEntryFile(packageDir, packageJson.main, "main"));
      }
      if (typeof packageJson.types === "string") {
        entrypoints.push(await verifyEntryFile(packageDir, packageJson.types, "types"));
      }
      entrypoints.push(...(await verifyExports(packageDir, packageJson.exports)));

      const bins = [];
      if (packageJson.bin && typeof packageJson.bin === "object" && !Array.isArray(packageJson.bin)) {
        for (const [binName, relativePath] of Object.entries(packageJson.bin)) {
          bins.push({
            name: binName,
            path: installedBinPath(installRoot, binName),
            entry: await verifyEntryFile(packageDir, relativePath, `bin.${binName}`),
          });
          await fsp.access(installedBinPath(installRoot, binName), fs.constants.F_OK);
        }
      }

      if (shouldImportPackage(packageJson)) {
        await runCommand(process.execPath, ["--input-type=module", "--eval", `await import(${JSON.stringify(pkg.name)});`], {
          cwd: installRoot,
        });
      }

      packageChecks.push({
        name: pkg.name,
        package_dir: packageDir,
        entrypoints: entrypoints.filter(Boolean),
        bins,
        imported: shouldImportPackage(packageJson),
      });
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          artifacts_dir: parsedArgs.artifactsDir,
          manifest_path: manifestPath,
          packages: packageChecks,
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
