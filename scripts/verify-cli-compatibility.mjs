#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveCommandPath } from "./command-paths.mjs";
import {
  authorityCliCompatibilityPackageNames as publishablePackageNames,
  authorityCliCompatibilityPackages,
} from "./release-package-config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NPM = resolveCommandPath("npm");
const PNPM = resolveCommandPath("pnpm");
const TAR = resolveCommandPath("tar");

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    if (options.stdin) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();

    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        code: code ?? -1,
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

function parseJsonOutput(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `${label} did not emit valid JSON.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\ncause:\n${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function waitForSocket(socketPath, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for daemon socket at ${socketPath}.`);
}

function installedCliPath(installRoot) {
  return path.join(
    installRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "agentgit-authority.cmd" : "agentgit-authority",
  );
}

function installedCliModuleEntry(installRoot) {
  return path.join(installRoot, "node_modules", "@agentgit", "authority-cli", "dist", "main.js");
}

function installedDaemonModuleEntry(installRoot) {
  return path.join(installRoot, "node_modules", "@agentgit", "authority-daemon", "dist", "main.js");
}

function canonicalPathForComparison(value) {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

async function initInstallRoot(installRoot) {
  await fsp.mkdir(installRoot, { recursive: true });
  await runCommand(NPM, ["init", "-y"], { cwd: installRoot });
}

async function installTarballs(installRoot, tarballs) {
  await runCommand(NPM, ["install", "--no-package-lock", "--force", ...tarballs], {
    cwd: installRoot,
  });
}

async function buildCompatibilityTargets(targetRepoRoot) {
  await runCommand(
    PNPM,
    [
      "--filter",
      "@agentgit/schemas...",
      "--filter",
      "@agentgit/authority-sdk...",
      "--filter",
      "@agentgit/authority-cli...",
      "--filter",
      "@agentgit/authority-daemon...",
      "build",
    ],
    { cwd: targetRepoRoot },
  );
}

async function packRepoArtifacts(targetRepoRoot, outDir) {
  await buildCompatibilityTargets(targetRepoRoot);
  await fsp.rm(outDir, { recursive: true, force: true });
  await fsp.mkdir(outDir, { recursive: true });

  const packages = [];
  for (const pkg of authorityCliCompatibilityPackages) {
    const packageDir = path.join(targetRepoRoot, pkg.relativeDir);
    const before = new Set(await fsp.readdir(outDir));
    await runCommand(PNPM, ["pack", "--pack-destination", outDir], {
      cwd: packageDir,
      env: {
        npm_config_ignore_scripts: "true",
      },
    });
    const after = await fsp.readdir(outDir);
    const created = after.filter((entry) => !before.has(entry) && entry.endsWith(".tgz"));
    if (created.length !== 1) {
      throw new Error(`Expected exactly one tarball for ${pkg.name}, received ${created.length}.`);
    }

    const tarballPath = path.join(outDir, created[0]);
    const stats = await fsp.stat(tarballPath);
    packages.push({
      name: pkg.name,
      tarball_path: tarballPath,
      filename: created[0],
      bytes: stats.size,
    });
  }

  const manifest = {
    generated_at: new Date().toISOString(),
    output_dir: outDir,
    packages,
  };
  await fsp.writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

async function packPublishedArtifacts(outDir) {
  await fsp.rm(outDir, { recursive: true, force: true });
  await fsp.mkdir(outDir, { recursive: true });

  const packages = [];
  for (const pkg of authorityCliCompatibilityPackages) {
    const before = new Set(await fsp.readdir(outDir));
    try {
      await runCommand(NPM, ["pack", `${pkg.name}@latest`, "--pack-destination", outDir], {
        cwd: outDir,
      });
    } catch {
      return null;
    }

    const after = await fsp.readdir(outDir);
    const created = after.filter((entry) => !before.has(entry) && entry.endsWith(".tgz"));
    if (created.length !== 1) {
      throw new Error(`Expected exactly one published tarball for ${pkg.name}, received ${created.length}.`);
    }

    const tarballPath = path.join(outDir, created[0]);
    const stats = await fsp.stat(tarballPath);
    packages.push({
      name: pkg.name,
      tarball_path: tarballPath,
      filename: created[0],
      bytes: stats.size,
    });
  }

  const manifest = {
    generated_at: new Date().toISOString(),
    output_dir: outDir,
    source: "published_latest",
    packages,
  };
  await fsp.writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

function resolveTarballsFromManifest(manifest) {
  return manifest.packages.map((pkg) => pkg.tarball_path);
}

function packageTarballFilename(name, version) {
  return `${name.replace(/^@/, "").replace(/\//g, "-")}-${version}.tgz`;
}

function bumpPatchVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) {
    throw new Error(`Cannot synthesize compatibility version from ${version}.`);
  }

  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10) + 1;
  return `${major}.${minor}.${patch}-compat.0`;
}

async function createSyntheticUpgradeTarballs(currentManifest, outDir) {
  await fsp.rm(outDir, { recursive: true, force: true });
  await fsp.mkdir(outDir, { recursive: true });

  const versionMap = new Map();
  const extractedRoots = [];

  for (const pkg of currentManifest.packages) {
    const extractRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "agcli-compat-unpack-"));
    extractedRoots.push(extractRoot);
    await runCommand(TAR, ["-xzf", pkg.tarball_path, "-C", extractRoot]);
    const packageJsonPath = path.join(extractRoot, "package", "package.json");
    const packageJson = JSON.parse(await fsp.readFile(packageJsonPath, "utf8"));
    versionMap.set(packageJson.name, bumpPatchVersion(packageJson.version));
  }

  const packages = [];
  for (let index = 0; index < currentManifest.packages.length; index += 1) {
    const extractRoot = extractedRoots[index];
    const packageDir = path.join(extractRoot, "package");
    const packageJsonPath = path.join(packageDir, "package.json");
    const packageJson = JSON.parse(await fsp.readFile(packageJsonPath, "utf8"));
    packageJson.version = versionMap.get(packageJson.name);

    for (const dependencyField of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      const dependencies = packageJson[dependencyField];
      if (!dependencies || typeof dependencies !== "object") {
        continue;
      }

      for (const dependencyName of Object.keys(dependencies)) {
        if (publishablePackageNames.has(dependencyName)) {
          dependencies[dependencyName] = versionMap.get(dependencyName);
        }
      }
    }

    await fsp.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2), "utf8");
    const tarballFilename = packageTarballFilename(packageJson.name, packageJson.version);
    const tarballPath = path.join(outDir, tarballFilename);
    await runCommand(TAR, ["-czf", tarballPath, "-C", extractRoot, "package"]);
    const stats = await fsp.stat(tarballPath);
    packages.push({
      name: packageJson.name,
      tarball_path: tarballPath,
      filename: tarballFilename,
      bytes: stats.size,
      version: packageJson.version,
    });
  }

  const manifest = {
    generated_at: new Date().toISOString(),
    output_dir: outDir,
    packages,
  };
  const manifestPath = path.join(outDir, "manifest.json");
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

function startDaemon(daemonEntry, env, cwd) {
  const child = spawn(process.execPath, [daemonEntry], {
    cwd,
    env: {
      ...process.env,
      ...env,
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

  return {
    child,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("close", resolve));
      }
      if (child.exitCode !== null && child.exitCode !== 0) {
        throw new Error(`Daemon exited unexpectedly.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
      }
    },
  };
}

function daemonEnvironment(stateRoot, workspaceRoot) {
  return {
    AGENTGIT_ROOT: workspaceRoot,
    INIT_CWD: workspaceRoot,
    AGENTGIT_SOCKET_PATH: path.join(stateRoot, "authority.sock"),
  };
}

async function runInstalledCli(cli, args, options = {}) {
  if (typeof cli === "string") {
    return runCommand(cli, args, options);
  }

  if (cli.legacyModuleEntry) {
    const entry = cli.legacyModuleEntry;
    const evalScript = [
      'import { realpathSync } from "node:fs";',
      'import { pathToFileURL } from "node:url";',
      `const entry = realpathSync(${JSON.stringify(entry)});`,
      "process.argv = [process.execPath, entry, ...process.argv.slice(1)];",
      "await import(pathToFileURL(entry).href);",
    ].join(" ");
    return runCommand(process.execPath, ["--input-type=module", "--eval", evalScript, "--", ...args], options);
  }

  return runCommand(cli.command, [...(cli.prefixArgs ?? []), ...args], options);
}

async function main() {
  const tempBase = process.platform === "win32" ? os.tmpdir() : "/tmp";
  const tempRoot = await fsp.mkdtemp(path.join(tempBase, "agcli-compat-"));
  const baselineTarballDir = path.join(tempRoot, "baseline-tarballs");
  const currentTarballDir = path.join(tempRoot, "current-tarballs");
  const upgradeTarballDir = path.join(tempRoot, "upgrade-tarballs");
  const baselineInstallRoot = path.join(tempRoot, "baseline-install");
  const upgradeInstallRoot = path.join(tempRoot, "upgrade-install");
  const currentConfigRoot = path.join(tempRoot, "config-root");
  const baselineStateRoot = path.join(tempRoot, "baseline-state");
  const currentStateRoot = path.join(tempRoot, "current-state");
  const baselineWorkspaceRoot = path.join(tempRoot, "baseline-workspace");
  const currentWorkspaceRoot = path.join(tempRoot, "current-workspace");
  const legacyBundleDir = path.join(tempRoot, "legacy-audit-bundle");
  const sharedLegacyBundleDir = path.join(tempRoot, "shared-legacy-audit-bundle");
  const currentBundleDir = path.join(tempRoot, "current-audit-bundle");

  await fsp.mkdir(baselineWorkspaceRoot, { recursive: true });
  await fsp.mkdir(currentWorkspaceRoot, { recursive: true });

  try {
    const currentManifest = await packRepoArtifacts(repoRoot, currentTarballDir);
    const baselineManifest = (await packPublishedArtifacts(baselineTarballDir)) ?? {
      ...currentManifest,
      source: "current_workspace_fallback",
    };
    const syntheticUpgradeManifest = await createSyntheticUpgradeTarballs(currentManifest, upgradeTarballDir);

    await initInstallRoot(baselineInstallRoot);
    await installTarballs(baselineInstallRoot, resolveTarballsFromManifest(baselineManifest));
    const baselineCli = fs.existsSync(installedCliPath(baselineInstallRoot))
      ? installedCliPath(baselineInstallRoot)
      : {
          legacyModuleEntry: installedCliModuleEntry(baselineInstallRoot),
        };
    const baselineDaemonEnv = daemonEnvironment(baselineStateRoot, baselineWorkspaceRoot);
    const baselineDaemonEntry = installedDaemonModuleEntry(baselineInstallRoot);

    const baselineDaemon = startDaemon(baselineDaemonEntry, baselineDaemonEnv, baselineInstallRoot);
    try {
      await waitForSocket(baselineDaemonEnv.AGENTGIT_SOCKET_PATH);

      const pingBaseline = await runInstalledCli(baselineCli, ["--json", "ping"], {
        cwd: baselineInstallRoot,
        env: baselineDaemonEnv,
      });
      const pingBaselineResult = parseJsonOutput(pingBaseline, "baseline CLI ping");
      if (pingBaselineResult.accepted_api_version !== "authority.v1") {
        throw new Error(
          `Baseline CLI ping returned unexpected API version: ${pingBaselineResult.accepted_api_version}`,
        );
      }

      const baselineRun = parseJsonOutput(
        await runInstalledCli(baselineCli, ["--json", "register-run", "compat-baseline", "2", "1"], {
          cwd: baselineInstallRoot,
          env: baselineDaemonEnv,
        }),
        "baseline CLI register-run",
      );
      await runInstalledCli(
        baselineCli,
        ["--json", "submit-shell", baselineRun.run_id, "printf", "legacy-audit-body"],
        {
          cwd: baselineInstallRoot,
          env: baselineDaemonEnv,
        },
      );
      await runInstalledCli(
        baselineCli,
        ["--json", "run-audit-export", baselineRun.run_id, legacyBundleDir, "internal"],
        {
          cwd: baselineInstallRoot,
          env: baselineDaemonEnv,
        },
      );
    } finally {
      await baselineDaemon.stop();
    }

    const currentDaemonEnv = daemonEnvironment(currentStateRoot, currentWorkspaceRoot);
    await initInstallRoot(upgradeInstallRoot);
    await installTarballs(upgradeInstallRoot, resolveTarballsFromManifest(currentManifest));
    const upgradedCli = installedCliPath(upgradeInstallRoot);
    const currentDaemonEntry = installedDaemonModuleEntry(upgradeInstallRoot);
    const currentDaemonForLegacyCli = startDaemon(currentDaemonEntry, currentDaemonEnv, upgradeInstallRoot);
    try {
      await waitForSocket(currentDaemonEnv.AGENTGIT_SOCKET_PATH);

      const legacyPingCurrent = parseJsonOutput(
        await runInstalledCli(baselineCli, ["--json", "ping"], {
          cwd: baselineInstallRoot,
          env: currentDaemonEnv,
        }),
        "baseline CLI against current daemon",
      );
      if (legacyPingCurrent.accepted_api_version !== "authority.v1") {
        throw new Error("Baseline CLI could not negotiate with the current daemon.");
      }

      const legacyRunCurrent = parseJsonOutput(
        await runInstalledCli(baselineCli, ["--json", "register-run", "legacy-cli-current-daemon", "2", "1"], {
          cwd: baselineInstallRoot,
          env: currentDaemonEnv,
        }),
        "baseline CLI register-run against current daemon",
      );
      await runInstalledCli(
        baselineCli,
        [
          "--json",
          "submit-filesystem-write",
          legacyRunCurrent.run_id,
          "legacy-current-daemon.txt",
          "legacy cli current daemon",
        ],
        {
          cwd: baselineInstallRoot,
          env: currentDaemonEnv,
        },
      );
    } finally {
      await currentDaemonForLegacyCli.stop();
    }

    const neutralCliEnv = {
      AGENTGIT_ROOT: "",
      INIT_CWD: "",
      AGENTGIT_SOCKET_PATH: "",
    };

    const currentVersion = parseJsonOutput(
      await runInstalledCli(upgradedCli, ["--json", "version"], {
        cwd: upgradeInstallRoot,
        env: neutralCliEnv,
      }),
      "current installed CLI version",
    );

    const currentConfigArgs = [
      "--json",
      "--config-root",
      currentConfigRoot,
      "profile",
      "upsert",
      "compat",
      "--workspace-root",
      currentWorkspaceRoot,
      "--socket-path",
      currentDaemonEnv.AGENTGIT_SOCKET_PATH,
      "--connect-timeout-ms",
      "1200",
      "--response-timeout-ms",
      "6500",
      "--max-connect-retries",
      "2",
      "--connect-retry-delay-ms",
      "75",
    ];
    await runInstalledCli(upgradedCli, currentConfigArgs, { cwd: upgradeInstallRoot, env: neutralCliEnv });
    await runInstalledCli(upgradedCli, ["--json", "--config-root", currentConfigRoot, "profile", "use", "compat"], {
      cwd: upgradeInstallRoot,
      env: neutralCliEnv,
    });

    const currentDaemonForNewCliOldDaemon = startDaemon(baselineDaemonEntry, baselineDaemonEnv, baselineInstallRoot);
    try {
      await waitForSocket(baselineDaemonEnv.AGENTGIT_SOCKET_PATH);

      const newCliOldDaemonPing = parseJsonOutput(
        await runInstalledCli(
          upgradedCli,
          [
            "--json",
            "--config-root",
            currentConfigRoot,
            "--workspace-root",
            baselineWorkspaceRoot,
            "--socket-path",
            baselineDaemonEnv.AGENTGIT_SOCKET_PATH,
            "ping",
          ],
          {
            cwd: upgradeInstallRoot,
            env: neutralCliEnv,
          },
        ),
        "current CLI against baseline daemon",
      );
      if (newCliOldDaemonPing.accepted_api_version !== "authority.v1") {
        throw new Error("Current CLI could not negotiate with the baseline daemon.");
      }
    } finally {
      await currentDaemonForNewCliOldDaemon.stop();
    }

    await installTarballs(upgradeInstallRoot, resolveTarballsFromManifest(syntheticUpgradeManifest));
    const syntheticVersion = parseJsonOutput(
      await runInstalledCli(upgradedCli, ["--json", "version"], {
        cwd: upgradeInstallRoot,
        env: neutralCliEnv,
      }),
      "synthetic upgraded CLI version",
    );
    if (syntheticVersion.cli_version === currentVersion.cli_version) {
      throw new Error("Synthetic upgrade did not change the installed CLI version.");
    }

    const configAfterUpgrade = parseJsonOutput(
      await runInstalledCli(upgradedCli, ["--json", "--config-root", currentConfigRoot, "config", "show"], {
        cwd: upgradeInstallRoot,
        env: neutralCliEnv,
      }),
      "config show after upgrade",
    );
    if (configAfterUpgrade.resolved.active_profile !== "compat") {
      throw new Error("Upgraded CLI did not preserve the active profile.");
    }
    if (
      canonicalPathForComparison(configAfterUpgrade.resolved.workspace_root.value) !==
      canonicalPathForComparison(currentWorkspaceRoot)
    ) {
      throw new Error(
        `Upgraded CLI did not preserve the configured workspace root (${configAfterUpgrade.resolved.workspace_root.value} vs ${currentWorkspaceRoot}).`,
      );
    }
    if (
      canonicalPathForComparison(configAfterUpgrade.resolved.socket_path.value) !==
      canonicalPathForComparison(currentDaemonEnv.AGENTGIT_SOCKET_PATH)
    ) {
      throw new Error(
        `Upgraded CLI did not preserve the configured socket path (${configAfterUpgrade.resolved.socket_path.value} vs ${currentDaemonEnv.AGENTGIT_SOCKET_PATH}).`,
      );
    }

    const currentDaemon = startDaemon(currentDaemonEntry, currentDaemonEnv, upgradeInstallRoot);
    try {
      await waitForSocket(currentDaemonEnv.AGENTGIT_SOCKET_PATH);

      const doctorAfterUpgrade = parseJsonOutput(
        await runInstalledCli(upgradedCli, ["--json", "--config-root", currentConfigRoot, "doctor"], {
          cwd: upgradeInstallRoot,
          env: neutralCliEnv,
        }),
        "doctor after upgrade",
      );
      if (doctorAfterUpgrade.daemon.reachable !== true) {
        throw new Error("Upgraded CLI doctor did not report a reachable daemon.");
      }

      const verifyLegacyBundle = parseJsonOutput(
        await runInstalledCli(upgradedCli, ["--json", "run-audit-verify", legacyBundleDir], {
          cwd: upgradeInstallRoot,
        }),
        "verify legacy bundle",
      );
      if (verifyLegacyBundle.verified !== true) {
        throw new Error("Upgraded CLI could not verify a legacy audit bundle.");
      }

      const reportLegacyBundle = parseJsonOutput(
        await runInstalledCli(upgradedCli, ["--json", "run-audit-report", legacyBundleDir], {
          cwd: upgradeInstallRoot,
        }),
        "report legacy bundle",
      );
      if (reportLegacyBundle.run_id !== verifyLegacyBundle.run_id) {
        throw new Error("Legacy audit report returned a mismatched run id.");
      }

      const shareLegacyBundle = parseJsonOutput(
        await runInstalledCli(upgradedCli, ["--json", "run-audit-share", legacyBundleDir, sharedLegacyBundleDir], {
          cwd: upgradeInstallRoot,
        }),
        "share legacy bundle",
      );
      if (shareLegacyBundle.include_artifact_content !== false) {
        throw new Error("Legacy bundle share unexpectedly included artifact content.");
      }
      if (!fs.existsSync(path.join(sharedLegacyBundleDir, "share-manifest.json"))) {
        throw new Error("Legacy bundle share package did not write share-manifest.json.");
      }

      const upgradedRun = parseJsonOutput(
        await runInstalledCli(
          upgradedCli,
          ["--json", "--config-root", currentConfigRoot, "register-run", "compat-upgraded"],
          {
            cwd: upgradeInstallRoot,
            env: neutralCliEnv,
          },
        ),
        "upgraded CLI register-run",
      );
      await runInstalledCli(
        upgradedCli,
        [
          "--json",
          "--config-root",
          currentConfigRoot,
          "submit-filesystem-write",
          upgradedRun.run_id,
          "compat-upgraded.txt",
          "compat upgraded write",
        ],
        {
          cwd: upgradeInstallRoot,
          env: neutralCliEnv,
        },
      );
      await runInstalledCli(
        upgradedCli,
        [
          "--json",
          "--config-root",
          currentConfigRoot,
          "run-audit-export",
          upgradedRun.run_id,
          currentBundleDir,
          "internal",
        ],
        {
          cwd: upgradeInstallRoot,
          env: neutralCliEnv,
        },
      );

      const compareBundles = await runInstalledCli(
        upgradedCli,
        ["--json", "run-audit-compare", legacyBundleDir, currentBundleDir],
        {
          cwd: upgradeInstallRoot,
          acceptExitCodes: [0, 65],
        },
      );
      const compareBundlesResult = parseJsonOutput(compareBundles, "compare legacy and current bundles");
      if (!Array.isArray(compareBundlesResult.differences) || compareBundlesResult.differences.length === 0) {
        throw new Error("Bundle comparison did not surface any differences between legacy and current runs.");
      }
    } finally {
      await currentDaemon.stop();
    }

    await installTarballs(upgradeInstallRoot, resolveTarballsFromManifest(currentManifest));
    const rollbackVersion = parseJsonOutput(
      await runInstalledCli(upgradedCli, ["--json", "version"], {
        cwd: upgradeInstallRoot,
        env: neutralCliEnv,
      }),
      "rollback CLI version",
    );
    if (rollbackVersion.cli_version !== currentVersion.cli_version) {
      throw new Error("Rollback did not restore the original installed CLI version.");
    }

    const configAfterRollback = parseJsonOutput(
      await runInstalledCli(upgradedCli, ["--json", "--config-root", currentConfigRoot, "config", "show"], {
        cwd: upgradeInstallRoot,
        env: neutralCliEnv,
      }),
      "config show after rollback",
    );
    if (configAfterRollback.resolved.active_profile !== "compat") {
      throw new Error("Rollback did not preserve the active profile.");
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          baseline_manifest: baselineManifest,
          current_manifest: currentManifest,
          synthetic_upgrade_manifest: syntheticUpgradeManifest,
          current_version: currentVersion,
          synthetic_version: syntheticVersion,
          rollback_version: rollbackVersion,
          legacy_bundle_dir: legacyBundleDir,
          shared_legacy_bundle_dir: sharedLegacyBundleDir,
          current_bundle_dir: currentBundleDir,
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
