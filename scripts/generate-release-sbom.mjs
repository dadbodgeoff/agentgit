#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return [
    "Usage: node scripts/generate-release-sbom.mjs [options]",
    "",
    "Options:",
    "  --output <path>         Write CycloneDX JSON SBOM to this path",
    "  --artifacts-dir <path>  Include packed release artifact files from this directory",
    "  --help                  Show this help text",
  ].join("\n");
}

function parseArgs(argv) {
  const parsed = {
    output: path.join(repoRoot, ".release-artifacts", "release-sbom.cdx.json"),
    artifactsDir: null,
  };

  const rest = [...argv];
  while (rest.length > 0) {
    const current = rest.shift();
    switch (current) {
      case "--output":
        parsed.output = path.resolve(shiftValue(rest, "--output"));
        break;
      case "--artifacts-dir":
        parsed.artifactsDir = path.resolve(shiftValue(rest, "--artifacts-dir"));
        break;
      case "--help":
      case "-h":
        process.stdout.write(`${usage()}\n`);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${current}`);
    }
  }

  return parsed;
}

function shiftValue(args, flag) {
  const value = args.shift();
  if (!value) {
    throw new Error(`${flag} expects a value.`);
  }
  return value;
}

export async function buildReleaseSbom(options = {}) {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? repoRoot);
  const artifactsDir = options.artifactsDir ? path.resolve(options.artifactsDir) : null;
  const workspaceComponents = await collectWorkspaceComponents(workspaceRoot);
  const artifactComponents = artifactsDir ? await collectArtifactComponents(artifactsDir) : [];

  const rootManifest = JSON.parse(await fsp.readFile(path.join(workspaceRoot, "package.json"), "utf8"));
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: packageComponent(path.join(workspaceRoot, "package.json"), rootManifest, workspaceRoot),
      properties: [
        {
          name: "agentgit:sbom-scope",
          value: artifactsDir
            ? "workspace manifests plus packed release artifacts"
            : "workspace manifests only; packed release artifacts were not supplied",
        },
      ],
    },
    components: [...workspaceComponents, ...artifactComponents],
  };
}

export async function collectWorkspaceComponents(workspaceRoot) {
  const manifestPaths = await listWorkspacePackageManifests(workspaceRoot);
  const components = [];
  for (const manifestPath of manifestPaths) {
    const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
    components.push(packageComponent(manifestPath, manifest, workspaceRoot));
  }
  return components;
}

async function listWorkspacePackageManifests(workspaceRoot) {
  const manifestPaths = [path.join(workspaceRoot, "package.json")];
  for (const rootName of ["apps", "packages"]) {
    const root = path.join(workspaceRoot, rootName);
    if (!fs.existsSync(root)) {
      continue;
    }
    const entries = await fsp.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const manifestPath = path.join(root, entry.name, "package.json");
      if (fs.existsSync(manifestPath)) {
        manifestPaths.push(manifestPath);
      }
    }
  }
  return manifestPaths.sort();
}

function packageComponent(manifestPath, manifest, workspaceRoot) {
  const name = typeof manifest.name === "string" ? manifest.name : path.basename(path.dirname(manifestPath));
  const version = typeof manifest.version === "string" ? manifest.version : "0.0.0";
  const license = typeof manifest.license === "string" ? manifest.license : null;
  const properties = [
    {
      name: "agentgit:path",
      value: path.relative(workspaceRoot, manifestPath).split(path.sep).join("/"),
    },
    {
      name: "agentgit:private",
      value: manifest.private === true ? "true" : "false",
    },
  ];

  return {
    type: "library",
    "bom-ref": `pkg:npm/${encodePackageName(name)}@${encodeURIComponent(version)}`,
    name,
    version,
    purl: `pkg:npm/${encodePackageName(name)}@${encodeURIComponent(version)}`,
    ...(license
      ? {
          licenses: [
            {
              license: {
                id: license,
              },
            },
          ],
        }
      : {}),
    properties,
  };
}

function encodePackageName(name) {
  return name
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function collectArtifactComponents(artifactsDir) {
  if (!fs.existsSync(artifactsDir)) {
    return [];
  }

  const files = await listFiles(artifactsDir);
  const components = [];
  for (const filePath of files) {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      continue;
    }
    const relativePath = path.relative(artifactsDir, filePath).split(path.sep).join("/");
    components.push({
      type: "file",
      "bom-ref": `file:${relativePath}`,
      name: relativePath,
      hashes: [
        {
          alg: "SHA-256",
          content: await hashFile(filePath),
        },
      ],
      properties: [
        {
          name: "agentgit:artifact-path",
          value: relativePath,
        },
        {
          name: "agentgit:artifact-size-bytes",
          value: String(stat.size),
        },
      ],
    });
  }
  return components.sort((left, right) => left.name.localeCompare(right.name));
}

async function listFiles(root) {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(fullPath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

export async function hashFile(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const sbom = await buildReleaseSbom({ artifactsDir: args.artifactsDir });
    await fsp.mkdir(path.dirname(args.output), { recursive: true });
    await fsp.writeFile(args.output, `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
    process.stdout.write(
      `${JSON.stringify(
        {
          output: args.output,
          components: sbom.components.length,
          artifact_components: sbom.components.filter((component) => component.type === "file").length,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
