import path from "node:path";

export const releaseNpmPackages = [
  {
    name: "@agentgit/core-ports",
    relativeDir: path.join("packages", "core-ports"),
  },
  {
    name: "@agentgit/integration-state",
    relativeDir: path.join("packages", "integration-state"),
  },
  {
    name: "@agentgit/credential-broker",
    relativeDir: path.join("packages", "credential-broker"),
  },
  {
    name: "@agentgit/authority-daemon",
    relativeDir: path.join("packages", "authority-daemon"),
  },
  {
    name: "@agentgit/schemas",
    relativeDir: path.join("packages", "schemas"),
  },
  {
    name: "@agentgit/authority-sdk",
    relativeDir: path.join("packages", "authority-sdk-ts"),
  },
  {
    name: "@agentgit/authority-cli",
    relativeDir: path.join("packages", "authority-cli"),
  },
  {
    name: "@agentgit/agent-runtime-integration",
    relativeDir: path.join("packages", "agent-runtime-integration"),
  },
];

export const authorityCliCompatibilityPackages = releaseNpmPackages.filter(
  (pkg) => pkg.name !== "@agentgit/agent-runtime-integration",
);

export const authorityCliCompatibilityPackageNames = new Set(authorityCliCompatibilityPackages.map((pkg) => pkg.name));
