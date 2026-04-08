#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const packageRoot = process.cwd();
const packageJsonPath = path.join(packageRoot, "package.json");

if (!fs.existsSync(packageJsonPath)) {
  throw new Error(`No package.json found in ${packageRoot}.`);
}

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const expectedPaths = new Set();

for (const field of ["main", "module", "types"]) {
  if (typeof packageJson[field] === "string" && packageJson[field].startsWith("dist/")) {
    expectedPaths.add(packageJson[field]);
  }
}

if (packageJson.bin && typeof packageJson.bin === "object") {
  for (const value of Object.values(packageJson.bin)) {
    if (typeof value === "string" && value.startsWith("dist/")) {
      expectedPaths.add(value);
    }
  }
}

if (expectedPaths.size === 0) {
  const distPath = path.join(packageRoot, "dist");
  if (!fs.existsSync(distPath)) {
    throw new Error(`Expected ${distPath} to exist before packing. Run the build first.`);
  }
} else {
  for (const relativePath of expectedPaths) {
    const absolutePath = path.join(packageRoot, relativePath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Expected ${absolutePath} to exist before packing. Run the build first.`);
    }
  }
}
