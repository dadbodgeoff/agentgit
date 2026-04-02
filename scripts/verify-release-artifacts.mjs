#!/usr/bin/env node

import { createHash, createPublicKey, createVerify } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultArtifactsDir = path.join(repoRoot, ".release-artifacts", "packed");
const signatureModes = new Set(["required", "allow-unsigned"]);

function parseArgs(argv) {
  const parsed = {
    artifactsDir: defaultArtifactsDir,
    signatureMode: "required",
    publicKeyPath: null,
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

    if (current === "--signature-mode") {
      const value = argv[index + 1];
      if (!value || !signatureModes.has(value)) {
        throw new Error("--signature-mode expects one of: required, allow-unsigned.");
      }
      parsed.signatureMode = value;
      index += 1;
      continue;
    }

    if (current === "--public-key-path") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--public-key-path expects a path.");
      }
      parsed.publicKeyPath = path.resolve(value);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${current}`);
  }

  return parsed;
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

async function readPublicKeyPem(publicKeyPath) {
  if (publicKeyPath) {
    return fsp.readFile(publicKeyPath, "utf8");
  }
  if (process.env.AGENTGIT_RELEASE_SIGNING_PUBLIC_KEY_PEM_B64) {
    return Buffer.from(process.env.AGENTGIT_RELEASE_SIGNING_PUBLIC_KEY_PEM_B64, "base64").toString("utf8");
  }
  if (process.env.AGENTGIT_RELEASE_SIGNING_PUBLIC_KEY_PEM) {
    return process.env.AGENTGIT_RELEASE_SIGNING_PUBLIC_KEY_PEM;
  }
  return null;
}

function verifyManifestSignature(manifestJson, signature, publicKeyPem) {
  const verifier = createVerify("sha256");
  verifier.update(manifestJson);
  verifier.end();
  return verifier.verify(createPublicKey(publicKeyPem), Buffer.from(signature, "base64"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = path.join(args.artifactsDir, "manifest.json");
  const manifestShaPath = path.join(args.artifactsDir, "manifest.sha256");
  const manifestSigPath = path.join(args.artifactsDir, "manifest.sig");

  const manifestJson = await fsp.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestJson);

  if (!Array.isArray(manifest.packages)) {
    throw new Error("manifest.json is missing a packages array.");
  }

  const digestLine = await fsp.readFile(manifestShaPath, "utf8");
  const expectedManifestSha = digestLine.trim().split(/\s+/u)[0];
  const observedManifestSha = sha256DigestString(manifestJson);
  if (observedManifestSha !== expectedManifestSha) {
    throw new Error(
      `Manifest checksum mismatch. expected=${expectedManifestSha} observed=${observedManifestSha} path=${manifestPath}`,
    );
  }

  const packageChecks = [];
  for (const pkg of manifest.packages) {
    if (
      !pkg ||
      typeof pkg !== "object" ||
      typeof pkg.name !== "string" ||
      typeof pkg.tarball_path !== "string" ||
      typeof pkg.sha256 !== "string"
    ) {
      throw new Error(`Manifest package entry is invalid: ${JSON.stringify(pkg)}`);
    }

    const tarballPath = pkg.tarball_path;
    const observedSha = await fileDigest(tarballPath);
    if (observedSha !== pkg.sha256) {
      throw new Error(
        `Tarball checksum mismatch for ${pkg.name}. expected=${pkg.sha256} observed=${observedSha} path=${tarballPath}`,
      );
    }
    packageChecks.push({
      name: pkg.name,
      tarball_path: tarballPath,
      sha256: observedSha,
      verified: true,
    });
  }

  const signatureExists = fs.existsSync(manifestSigPath);
  if (!signatureExists && args.signatureMode === "required") {
    throw new Error(`manifest.sig is required but missing at ${manifestSigPath}`);
  }

  let signatureVerified = false;
  if (signatureExists) {
    const signature = (await fsp.readFile(manifestSigPath, "utf8")).trim();
    if (!signature) {
      throw new Error(`manifest.sig is empty at ${manifestSigPath}`);
    }
    const publicKeyPem = await readPublicKeyPem(args.publicKeyPath);
    if (!publicKeyPem) {
      throw new Error(
        "Signature exists but no public key was provided. Set AGENTGIT_RELEASE_SIGNING_PUBLIC_KEY_PEM(_B64) or pass --public-key-path.",
      );
    }
    signatureVerified = verifyManifestSignature(manifestJson, signature, publicKeyPem);
    if (!signatureVerified) {
      throw new Error("Release manifest signature verification failed.");
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        artifacts_dir: args.artifactsDir,
        manifest_path: manifestPath,
        manifest_sha256_verified: true,
        signature_mode: args.signatureMode,
        signature_present: signatureExists,
        signature_verified: signatureVerified,
        packages: packageChecks,
      },
      null,
      2,
    )}\n`,
  );
}

await main();
