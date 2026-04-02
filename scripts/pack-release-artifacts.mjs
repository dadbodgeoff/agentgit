#!/usr/bin/env node

import { createHash, createPrivateKey, createSign } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutDir = path.join(repoRoot, ".release-artifacts", "packed");
const signingModes = new Set(["if-key", "required", "none"]);

const publishablePackages = [
  {
    name: "@agentgit/authority-daemon",
    dir: path.join(repoRoot, "packages", "authority-daemon"),
  },
  {
    name: "@agentgit/schemas",
    dir: path.join(repoRoot, "packages", "schemas"),
  },
  {
    name: "@agentgit/authority-sdk",
    dir: path.join(repoRoot, "packages", "authority-sdk-ts"),
  },
  {
    name: "@agentgit/authority-cli",
    dir: path.join(repoRoot, "packages", "authority-cli"),
  },
];

function parseArgs(argv) {
  const parsed = {
    outDir: defaultOutDir,
    signingMode: "if-key",
    privateKeyPath: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--out-dir") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--out-dir expects a path.");
      }
      parsed.outDir = path.resolve(value);
      index += 1;
      continue;
    }

    if (current === "--signing-mode") {
      const value = argv[index + 1];
      if (!value || !signingModes.has(value)) {
        throw new Error("--signing-mode expects one of: if-key, required, none.");
      }
      parsed.signingMode = value;
      index += 1;
      continue;
    }

    if (current === "--private-key-path") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--private-key-path expects a path.");
      }
      parsed.privateKeyPath = path.resolve(value);
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
        stdout,
        stderr,
      });
    });
  });
}

async function fileDigest(filePath) {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(filePath);
  await new Promise((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

function sha256DigestString(content) {
  const hash = createHash("sha256");
  hash.update(content, "utf8");
  return hash.digest("hex");
}

async function readPrivateKeyPem(privateKeyPath) {
  if (privateKeyPath) {
    return fsp.readFile(privateKeyPath, "utf8");
  }

  if (process.env.AGENTGIT_RELEASE_SIGNING_PRIVATE_KEY_PEM_B64) {
    return Buffer.from(process.env.AGENTGIT_RELEASE_SIGNING_PRIVATE_KEY_PEM_B64, "base64").toString("utf8");
  }

  if (process.env.AGENTGIT_RELEASE_SIGNING_PRIVATE_KEY_PEM) {
    return process.env.AGENTGIT_RELEASE_SIGNING_PRIVATE_KEY_PEM;
  }

  return null;
}

function signManifest(manifestJson, privateKeyPem) {
  const signer = createSign("sha256");
  signer.update(manifestJson);
  signer.end();
  const key = createPrivateKey(privateKeyPem);
  return signer.sign(key).toString("base64");
}

async function packPackage(pkg, outDir) {
  const before = new Set(await fsp.readdir(outDir));
  await runCommand("pnpm", ["pack", "--pack-destination", outDir], {
    cwd: pkg.dir,
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
  return {
    name: pkg.name,
    tarball_path: tarballPath,
    filename: created[0],
    bytes: stats.size,
    sha256: await fileDigest(tarballPath),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = args.outDir;
  await runCommand("pnpm", ["build"], {
    cwd: repoRoot,
  });
  await fsp.rm(outDir, { recursive: true, force: true });
  await fsp.mkdir(outDir, { recursive: true });

  const packages = [];
  for (const pkg of publishablePackages) {
    packages.push(await packPackage(pkg, outDir));
  }

  const manifest = {
    generated_at: new Date().toISOString(),
    output_dir: outDir,
    packages,
  };
  const manifestPath = path.join(outDir, "manifest.json");
  const manifestJson = JSON.stringify(manifest, null, 2);
  await fsp.writeFile(manifestPath, manifestJson, "utf8");

  const manifestSha256 = sha256DigestString(manifestJson);
  const manifestDigestPath = path.join(outDir, "manifest.sha256");
  await fsp.writeFile(manifestDigestPath, `${manifestSha256}  manifest.json\n`, "utf8");

  const privateKeyPem = args.signingMode === "none" ? null : await readPrivateKeyPem(args.privateKeyPath);
  if (args.signingMode === "required" && !privateKeyPem) {
    throw new Error(
      "Signing is required but no signing key was provided. Set AGENTGIT_RELEASE_SIGNING_PRIVATE_KEY_PEM(_B64) or pass --private-key-path.",
    );
  }

  let signaturePath = null;
  if (privateKeyPem) {
    const signature = signManifest(manifestJson, privateKeyPem);
    signaturePath = path.join(outDir, "manifest.sig");
    await fsp.writeFile(signaturePath, `${signature}\n`, "utf8");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        manifest_path: manifestPath,
        manifest_sha256_path: manifestDigestPath,
        manifest_signature_path: signaturePath,
        signed: signaturePath !== null,
        packages,
      },
      null,
      2,
    )}\n`,
  );
}

await main();
