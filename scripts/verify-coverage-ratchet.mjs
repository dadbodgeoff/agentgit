#!/usr/bin/env node

import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.join(repoRoot, "package.json");
const baselinePath = path.join(repoRoot, "engineering-docs", "coverage-threshold-baseline.json");

const thresholdKeys = ["lines", "functions", "statements", "branches"];

function extractThresholds(command) {
  const thresholds = {};
  for (const key of thresholdKeys) {
    const matcher = new RegExp(`--coverage\\.thresholds\\.${key}=([0-9]+(?:\\.[0-9]+)?)`, "u");
    const match = command.match(matcher);
    if (!match) {
      throw new Error(`Could not find --coverage.thresholds.${key}=... in test:coverage script.`);
    }
    thresholds[key] = Number.parseFloat(match[1]);
  }
  return thresholds;
}

async function main() {
  const [packageJsonRaw, baselineRaw] = await Promise.all([
    fsp.readFile(packageJsonPath, "utf8"),
    fsp.readFile(baselinePath, "utf8"),
  ]);

  const packageJson = JSON.parse(packageJsonRaw);
  const baseline = JSON.parse(baselineRaw);
  const coverageCommand = packageJson?.scripts?.["test:coverage"];
  if (typeof coverageCommand !== "string" || coverageCommand.length === 0) {
    throw new Error("package.json is missing scripts.test:coverage.");
  }

  const current = extractThresholds(coverageCommand);
  const violations = [];

  for (const key of thresholdKeys) {
    const baselineValue = baseline?.thresholds?.[key];
    if (typeof baselineValue !== "number") {
      throw new Error(`Coverage baseline is missing numeric thresholds.${key}.`);
    }
    if (current[key] < baselineValue) {
      violations.push({
        metric: key,
        baseline: baselineValue,
        current: current[key],
      });
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `Coverage ratchet failed: one or more thresholds fell below baseline.\n${JSON.stringify(violations, null, 2)}`,
    );
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        baseline_path: baselinePath,
        thresholds: current,
      },
      null,
      2,
    )}\n`,
  );
}

await main();
