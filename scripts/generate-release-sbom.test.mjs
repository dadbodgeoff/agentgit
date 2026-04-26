import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildReleaseSbom, hashFile } from "./generate-release-sbom.mjs";

test("buildReleaseSbom includes workspace manifests and packed artifacts", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "agentgit-sbom-test-"));
  const artifactsDir = path.join(tempRoot, "artifacts");
  await fsp.mkdir(path.join(tempRoot, "packages", "example"), { recursive: true });
  await fsp.mkdir(artifactsDir, { recursive: true });
  await fsp.writeFile(
    path.join(tempRoot, "package.json"),
    JSON.stringify({ name: "root-product", version: "1.0.0", private: true, license: "Apache-2.0" }),
    "utf8",
  );
  await fsp.writeFile(
    path.join(tempRoot, "packages", "example", "package.json"),
    JSON.stringify({ name: "@agentgit/example", version: "0.2.0", license: "Apache-2.0" }),
    "utf8",
  );
  await fsp.writeFile(path.join(artifactsDir, "agentgit-example-0.2.0.tgz"), "artifact", "utf8");

  const sbom = await buildReleaseSbom({ workspaceRoot: tempRoot, artifactsDir });

  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.ok(sbom.components.some((component) => component.name === "@agentgit/example"));
  assert.ok(sbom.components.some((component) => component.type === "file"));
});

test("hashFile emits stable sha256 content hashes", async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "agentgit-hash-test-"));
  const target = path.join(tempRoot, "artifact.txt");
  await fsp.writeFile(target, "artifact", "utf8");
  const first = await hashFile(target);
  const second = await hashFile(target);

  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/u);
});
