#!/usr/bin/env node

import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.join(repoRoot, "package.json");
const baselinePath = path.join(repoRoot, "engineering-docs", "coverage-threshold-baseline.json");
const coverageRoots = ["packages", "apps"];

const thresholdKeys = ["lines", "functions", "statements", "branches"];

function parseArgs(argv) {
  const parsed = {
    writeBaseline: false,
    reason: null,
    statusDate: new Date().toISOString().slice(0, 10),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--") {
      continue;
    }

    if (current === "--write-baseline") {
      parsed.writeBaseline = true;
      continue;
    }

    if (current === "--reason") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--reason expects a value.");
      }
      parsed.reason = value.trim();
      index += 1;
      continue;
    }

    if (current === "--status-date") {
      const value = argv[index + 1];
      if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
        throw new Error("--status-date expects YYYY-MM-DD.");
      }
      parsed.statusDate = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${current}`);
  }

  return parsed;
}

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

async function discoverCoverageSummaryFiles() {
  const coverageSummaryFiles = [];

  for (const root of coverageRoots) {
    const rootPath = path.join(repoRoot, root);
    let entries = [];
    try {
      entries = await fsp.readdir(rootPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const candidate = path.join(rootPath, entry.name, "coverage", "coverage-summary.json");
      try {
        await fsp.access(candidate);
        coverageSummaryFiles.push(candidate);
      } catch {
        // ignore missing coverage files
      }
    }
  }

  coverageSummaryFiles.sort((left, right) => left.localeCompare(right));
  return coverageSummaryFiles;
}

function parseCoverageMetric(metricSummary) {
  if (!metricSummary || typeof metricSummary !== "object") {
    throw new Error(`Coverage metric summary is invalid: ${JSON.stringify(metricSummary)}`);
  }
  if (
    typeof metricSummary.covered !== "number" ||
    typeof metricSummary.total !== "number" ||
    typeof metricSummary.pct !== "number"
  ) {
    throw new Error(`Coverage metric summary is missing covered/total/pct numbers: ${JSON.stringify(metricSummary)}`);
  }
  return {
    covered: metricSummary.covered,
    total: metricSummary.total,
    pct: Number(metricSummary.pct.toFixed(2)),
  };
}

async function loadMeasuredCoverage() {
  const files = await discoverCoverageSummaryFiles();
  if (files.length === 0) {
    throw new Error(
      "No coverage summary files were found. Run `pnpm test:coverage` before verifying the coverage ratchet.",
    );
  }

  const aggregate = Object.fromEntries(
    thresholdKeys.map((metric) => [
      metric,
      {
        covered: 0,
        total: 0,
        pct: 0,
      },
    ]),
  );
  const filesByPath = {};

  for (const file of files) {
    const relativePath = path.relative(repoRoot, file);
    const summary = JSON.parse(await fsp.readFile(file, "utf8"));
    if (!summary?.total || typeof summary.total !== "object") {
      throw new Error(`Coverage summary ${relativePath} is missing a total section.`);
    }

    filesByPath[relativePath] = {};
    for (const metric of thresholdKeys) {
      const parsed = parseCoverageMetric(summary.total[metric]);
      filesByPath[relativePath][metric] = parsed.pct;
      aggregate[metric].covered += parsed.covered;
      aggregate[metric].total += parsed.total;
    }
  }

  for (const metric of thresholdKeys) {
    if (aggregate[metric].total === 0) {
      throw new Error(`Aggregate coverage metric ${metric} has a total of 0.`);
    }
    aggregate[metric].pct = Number(((aggregate[metric].covered / aggregate[metric].total) * 100).toFixed(2));
  }

  return {
    aggregate,
    files: filesByPath,
  };
}

function buildBaselineDocument({ statusDate, reason, thresholds, measuredCoverage }) {
  const baseline = {
    status_date: statusDate,
    thresholds,
    aggregate: Object.fromEntries(thresholdKeys.map((metric) => [metric, measuredCoverage.aggregate[metric].pct])),
    files: Object.fromEntries(
      Object.entries(measuredCoverage.files).sort(([left], [right]) => left.localeCompare(right)),
    ),
  };

  if (reason && reason.length > 0) {
    baseline.status_note = reason;
  }

  return baseline;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const packageJsonRaw = await fsp.readFile(packageJsonPath, "utf8");

  const packageJson = JSON.parse(packageJsonRaw);
  const coverageCommand = packageJson?.scripts?.["test:coverage"];
  if (typeof coverageCommand !== "string" || coverageCommand.length === 0) {
    throw new Error("package.json is missing scripts.test:coverage.");
  }

  const current = extractThresholds(coverageCommand);
  const measuredCoverage = await loadMeasuredCoverage();

  if (args.writeBaseline) {
    const baseline = buildBaselineDocument({
      statusDate: args.statusDate,
      reason: args.reason,
      thresholds: current,
      measuredCoverage,
    });
    await fsp.writeFile(`${baselinePath}.tmp`, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
    await fsp.rename(`${baselinePath}.tmp`, baselinePath);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          updated: true,
          baseline_path: baselinePath,
          status_date: baseline.status_date,
          status_note: baseline.status_note ?? null,
          thresholds: baseline.thresholds,
          aggregate: baseline.aggregate,
          files_written: Object.keys(baseline.files),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const baselineRaw = await fsp.readFile(baselinePath, "utf8");
  const baseline = JSON.parse(baselineRaw);
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

  for (const key of thresholdKeys) {
    const baselineValue = baseline?.aggregate?.[key];
    if (typeof baselineValue !== "number") {
      throw new Error(`Coverage baseline is missing numeric aggregate.${key}.`);
    }
    if (measuredCoverage.aggregate[key].pct < baselineValue) {
      violations.push({
        type: "aggregate_measurement",
        metric: key,
        baseline: baselineValue,
        current: measuredCoverage.aggregate[key].pct,
      });
    }
  }

  const baselineFiles = baseline?.files;
  if (!baselineFiles || typeof baselineFiles !== "object") {
    throw new Error("Coverage baseline is missing a files object.");
  }

  const currentFilePaths = Object.keys(measuredCoverage.files).sort();
  const baselineFilePaths = Object.keys(baselineFiles).sort();

  for (const filePath of currentFilePaths) {
    if (!(filePath in baselineFiles)) {
      violations.push({
        type: "missing_file_baseline",
        file: filePath,
      });
      continue;
    }

    for (const key of thresholdKeys) {
      const baselineValue = baselineFiles[filePath]?.[key];
      if (typeof baselineValue !== "number") {
        throw new Error(`Coverage baseline is missing numeric files.${filePath}.${key}.`);
      }
      if (measuredCoverage.files[filePath][key] < baselineValue) {
        violations.push({
          type: "file_measurement",
          file: filePath,
          metric: key,
          baseline: baselineValue,
          current: measuredCoverage.files[filePath][key],
        });
      }
    }
  }

  for (const filePath of baselineFilePaths) {
    if (!(filePath in measuredCoverage.files)) {
      violations.push({
        type: "stale_file_baseline",
        file: filePath,
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
        aggregate: Object.fromEntries(thresholdKeys.map((metric) => [metric, measuredCoverage.aggregate[metric].pct])),
        files_verified: currentFilePaths,
      },
      null,
      2,
    )}\n`,
  );
}

await main();
