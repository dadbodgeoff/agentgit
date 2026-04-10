import test from "node:test";
import assert from "node:assert/strict";

import { authorityCliCompatibilityPackages, releaseNpmPackages } from "./release-package-config.mjs";

test("release package config discovers every public package", () => {
  assert.deepEqual(
    releaseNpmPackages.map((pkg) => pkg.name),
    [
      "@agentgit/agent-runtime-integration",
      "@agentgit/authority-cli",
      "@agentgit/authority-daemon",
      "@agentgit/authority-sdk",
      "@agentgit/cloud-connector",
      "@agentgit/cloud-sync-protocol",
      "@agentgit/control-plane-state",
      "@agentgit/core-ports",
      "@agentgit/credential-broker",
      "@agentgit/integration-state",
      "@agentgit/run-journal",
      "@agentgit/schemas",
      "@agentgit/snapshot-engine",
      "@agentgit/workspace-index",
    ],
  );
});

test("authority CLI compatibility covers only the authority release surface", () => {
  assert.deepEqual(
    authorityCliCompatibilityPackages.map((pkg) => pkg.name),
    [
      "@agentgit/authority-cli",
      "@agentgit/authority-daemon",
      "@agentgit/authority-sdk",
      "@agentgit/core-ports",
      "@agentgit/credential-broker",
      "@agentgit/integration-state",
      "@agentgit/schemas",
    ],
  );
});
