import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = path.join(repoRoot, "packages");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function discoverPublicPackages() {
  return fs
    .readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const relativeDir = path.join("packages", entry.name);
      const packageJsonPath = path.join(repoRoot, relativeDir, "package.json");
      if (!fs.existsSync(packageJsonPath)) {
        return null;
      }

      const packageJson = readJson(packageJsonPath);
      if (packageJson.private !== false || typeof packageJson.name !== "string" || packageJson.name.length === 0) {
        return null;
      }

      return {
        name: packageJson.name,
        relativeDir,
      };
    })
    .filter((pkg) => pkg !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export const releaseNpmPackages = discoverPublicPackages();
export const releaseNpmPackageNames = new Set(releaseNpmPackages.map((pkg) => pkg.name));

const authorityCliCompatibilityPackageNameList = [
  "@agentgit/authority-cli",
  "@agentgit/authority-daemon",
  "@agentgit/authority-sdk",
  "@agentgit/core-ports",
  "@agentgit/credential-broker",
  "@agentgit/integration-state",
  "@agentgit/schemas",
];

for (const packageName of authorityCliCompatibilityPackageNameList) {
  if (!releaseNpmPackageNames.has(packageName)) {
    throw new Error(`Authority CLI compatibility package is not publishable: ${packageName}`);
  }
}

export const authorityCliCompatibilityPackages = authorityCliCompatibilityPackageNameList.map((packageName) => {
  const pkg = releaseNpmPackages.find((candidate) => candidate.name === packageName);
  if (!pkg) {
    throw new Error(`Missing release package metadata for ${packageName}`);
  }
  return pkg;
});

export const authorityCliCompatibilityPackageNames = new Set(authorityCliCompatibilityPackageNameList);
