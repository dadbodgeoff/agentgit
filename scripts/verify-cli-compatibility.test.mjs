import assert from "node:assert/strict";
import test from "node:test";

import { authorityCliCompatibilityPackageNames } from "./release-package-config.mjs";
import { filterManifestToCompatibilitySurface } from "./cli-compatibility-manifest.mjs";

test("CLI compatibility manifest filtering keeps only authority surface packages", () => {
  const filtered = filterManifestToCompatibilitySurface(
    {
      generated_at: "2026-04-09T00:00:00.000Z",
      packages: [
        { name: "@agentgit/cloud-sync-protocol", tarball_path: "/tmp/cloud-sync.tgz" },
        { name: "@agentgit/authority-cli", tarball_path: "/tmp/authority-cli.tgz" },
        { name: "@agentgit/authority-daemon", tarball_path: "/tmp/authority-daemon.tgz" },
        { name: "@agentgit/authority-sdk", tarball_path: "/tmp/authority-sdk.tgz" },
        { name: "@agentgit/core-ports", tarball_path: "/tmp/core-ports.tgz" },
        { name: "@agentgit/credential-broker", tarball_path: "/tmp/credential-broker.tgz" },
        { name: "@agentgit/integration-state", tarball_path: "/tmp/integration-state.tgz" },
        { name: "@agentgit/schemas", tarball_path: "/tmp/schemas.tgz" },
      ],
    },
    authorityCliCompatibilityPackageNames,
  );

  assert.deepEqual(
    filtered.packages.map((pkg) => pkg.name),
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

test("CLI compatibility manifest filtering fails when a required authority package is missing", () => {
  assert.throws(
    () =>
      filterManifestToCompatibilitySurface(
        {
          generated_at: "2026-04-09T00:00:00.000Z",
          packages: [{ name: "@agentgit/authority-cli", tarball_path: "/tmp/authority-cli.tgz" }],
        },
        authorityCliCompatibilityPackageNames,
      ),
    /missing required packages/u,
  );
});
