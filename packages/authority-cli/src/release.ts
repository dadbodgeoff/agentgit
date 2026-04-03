import { createHash, createPublicKey, createVerify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { inputError, ioError } from "./cli-contract.js";
import { bulletList, lines } from "./formatters/core.js";

export type ReleaseSignatureMode = "required" | "allow-unsigned";

export interface ReleaseArtifactVerifyResult {
  ok: true;
  artifacts_dir: string;
  manifest_path: string;
  manifest_sha256_verified: true;
  signature_mode: ReleaseSignatureMode;
  signature_present: boolean;
  signature_verified: boolean;
  packages: Array<{
    name: string;
    tarball_path: string;
    sha256: string;
    verified: true;
  }>;
}

const RELEASE_SIGNATURE_MODES = new Set<ReleaseSignatureMode>(["required", "allow-unsigned"]);

function readReleaseVerificationPublicKey(publicKeyPath: string | null): string | null {
  if (publicKeyPath) {
    return fs.readFileSync(publicKeyPath, "utf8");
  }
  if (process.env.AGENTGIT_RELEASE_SIGNING_PUBLIC_KEY_PEM_B64) {
    return Buffer.from(process.env.AGENTGIT_RELEASE_SIGNING_PUBLIC_KEY_PEM_B64, "base64").toString("utf8");
  }
  if (process.env.AGENTGIT_RELEASE_SIGNING_PUBLIC_KEY_PEM) {
    return process.env.AGENTGIT_RELEASE_SIGNING_PUBLIC_KEY_PEM;
  }
  return null;
}

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function verifyReleaseManifestSignature(manifestJson: string, signature: string, publicKeyPem: string): boolean {
  const verifier = createVerify("sha256");
  verifier.update(manifestJson);
  verifier.end();
  return verifier.verify(createPublicKey(publicKeyPem), Buffer.from(signature, "base64"));
}

export function parseReleaseVerifyCommandArgs(
  args: string[],
  workspaceRoot: string,
): {
  artifactsDir: string;
  signatureMode: ReleaseSignatureMode;
  publicKeyPath: string | null;
} {
  const rest = [...args];
  let artifactsDir = path.resolve(workspaceRoot, ".release-artifacts", "packed");
  let signatureMode: ReleaseSignatureMode = "required";
  let publicKeyPath: string | null = null;

  if (rest.length > 0 && !rest[0]!.startsWith("--")) {
    const provided = rest.shift()!;
    artifactsDir = path.isAbsolute(provided) ? provided : path.resolve(workspaceRoot, provided);
  }

  while (rest.length > 0) {
    const current = rest.shift()!;
    switch (current) {
      case "--signature-mode": {
        const mode = rest.shift();
        if (!mode || mode.startsWith("--")) {
          throw inputError("--signature-mode requires a value.", {
            flag: "--signature-mode",
          });
        }
        if (!RELEASE_SIGNATURE_MODES.has(mode as ReleaseSignatureMode)) {
          throw inputError("--signature-mode expects one of: required, allow-unsigned.", {
            flag: "--signature-mode",
            value: mode,
          });
        }
        signatureMode = mode as ReleaseSignatureMode;
        break;
      }
      case "--public-key-path": {
        const provided = rest.shift();
        if (!provided || provided.startsWith("--")) {
          throw inputError("--public-key-path requires a value.", {
            flag: "--public-key-path",
          });
        }
        publicKeyPath = path.isAbsolute(provided) ? provided : path.resolve(workspaceRoot, provided);
        break;
      }
      default:
        throw inputError(`Unknown release-verify-artifacts flag: ${current}`, {
          flag: current,
        });
    }
  }

  return {
    artifactsDir,
    signatureMode,
    publicKeyPath,
  };
}

export function verifyReleaseArtifacts(options: {
  artifactsDir: string;
  signatureMode: ReleaseSignatureMode;
  publicKeyPath: string | null;
}): ReleaseArtifactVerifyResult {
  const manifestPath = path.join(options.artifactsDir, "manifest.json");
  const manifestShaPath = path.join(options.artifactsDir, "manifest.sha256");
  const manifestSigPath = path.join(options.artifactsDir, "manifest.sig");

  if (!fs.existsSync(manifestPath)) {
    throw ioError(`manifest.json is missing at ${manifestPath}.`);
  }
  if (!fs.existsSync(manifestShaPath)) {
    throw ioError(`manifest.sha256 is missing at ${manifestShaPath}.`);
  }

  const manifestJson = fs.readFileSync(manifestPath, "utf8");
  let manifest: {
    packages?: Array<{
      name?: unknown;
      tarball_path?: unknown;
      sha256?: unknown;
    }>;
  };
  try {
    manifest = JSON.parse(manifestJson) as {
      packages?: Array<{
        name?: unknown;
        tarball_path?: unknown;
        sha256?: unknown;
      }>;
    };
  } catch (error) {
    throw inputError(`manifest.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(manifest.packages)) {
    throw inputError("manifest.json is missing a packages array.");
  }

  const digestLine = fs.readFileSync(manifestShaPath, "utf8");
  const expectedManifestSha = digestLine.trim().split(/\s+/u)[0];
  const observedManifestSha = sha256Hex(manifestJson);
  if (observedManifestSha !== expectedManifestSha) {
    throw inputError(
      `Manifest checksum mismatch. expected=${expectedManifestSha} observed=${observedManifestSha} path=${manifestPath}`,
    );
  }

  const packageChecks: ReleaseArtifactVerifyResult["packages"] = [];
  for (const pkg of manifest.packages) {
    if (
      !pkg ||
      typeof pkg !== "object" ||
      typeof pkg.name !== "string" ||
      typeof pkg.tarball_path !== "string" ||
      typeof pkg.sha256 !== "string"
    ) {
      throw inputError(`Manifest package entry is invalid: ${JSON.stringify(pkg)}`);
    }

    const resolvedTarballPath = path.isAbsolute(pkg.tarball_path)
      ? pkg.tarball_path
      : path.resolve(options.artifactsDir, pkg.tarball_path);
    if (!fs.existsSync(resolvedTarballPath)) {
      throw ioError(`Tarball file is missing for ${pkg.name}: ${resolvedTarballPath}`);
    }

    const observedSha = sha256Hex(fs.readFileSync(resolvedTarballPath));
    if (observedSha !== pkg.sha256) {
      throw inputError(
        `Tarball checksum mismatch for ${pkg.name}. expected=${pkg.sha256} observed=${observedSha} path=${resolvedTarballPath}`,
      );
    }

    packageChecks.push({
      name: pkg.name,
      tarball_path: resolvedTarballPath,
      sha256: observedSha,
      verified: true,
    });
  }

  const signatureExists = fs.existsSync(manifestSigPath);
  if (!signatureExists && options.signatureMode === "required") {
    throw ioError(`manifest.sig is required but missing at ${manifestSigPath}`);
  }

  let signatureVerified = false;
  if (signatureExists) {
    const signature = fs.readFileSync(manifestSigPath, "utf8").trim();
    if (!signature) {
      throw ioError(`manifest.sig is empty at ${manifestSigPath}`);
    }

    const publicKeyPem = readReleaseVerificationPublicKey(options.publicKeyPath);
    if (!publicKeyPem) {
      throw inputError(
        "Signature exists but no public key was provided. Set AGENTGIT_RELEASE_SIGNING_PUBLIC_KEY_PEM(_B64) or pass --public-key-path.",
      );
    }

    signatureVerified = verifyReleaseManifestSignature(manifestJson, signature, publicKeyPem);
    if (!signatureVerified) {
      throw inputError("Release manifest signature verification failed.");
    }
  }

  return {
    ok: true,
    artifacts_dir: options.artifactsDir,
    manifest_path: manifestPath,
    manifest_sha256_verified: true,
    signature_mode: options.signatureMode,
    signature_present: signatureExists,
    signature_verified: signatureVerified,
    packages: packageChecks,
  };
}

export function formatReleaseArtifactVerifyResult(result: ReleaseArtifactVerifyResult): string {
  const packages =
    result.packages.length === 0
      ? "none"
      : `\n${bulletList(result.packages.map((entry) => `${entry.name} ${entry.sha256} [${entry.tarball_path}]`))}`;
  return lines(
    "Release artifacts verified",
    `Artifacts dir: ${result.artifacts_dir}`,
    `Manifest: ${result.manifest_path}`,
    `Manifest checksum: verified`,
    `Signature mode: ${result.signature_mode}`,
    `Signature present: ${result.signature_present ? "yes" : "no"}`,
    `Signature verified: ${result.signature_verified ? "yes" : "no"}`,
    `Packages verified: ${result.packages.length}`,
    `Package checks:${packages}`,
  );
}
