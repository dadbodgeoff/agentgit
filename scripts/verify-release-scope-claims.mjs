#!/usr/bin/env node

import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const changesetDir = path.join(repoRoot, ".changeset");

const hostedClaimPatterns = [
  /\bhosted\s+mcp\b/iu,
  /\bbrowser(?:\/| and )computer\s+governance\b/iu,
  /\bgeneric\s+governed\s+http\b/iu,
  /\bgeneric\s+http\s+adapter\b/iu,
  /\bdurable\s+hosted\s+worker(?:s)?\b/iu,
  /\bcloud\s+execution\b/iu,
];

const deferralQualifierPattern =
  /\b(deferred|defer|future|later|planned|not included|not in mvp|out of scope|non-blocking|not part of mvp)\b/iu;

function extractBody(markdown) {
  const parts = markdown.split(/^---\s*$/mu);
  if (parts.length >= 3) {
    return parts.slice(2).join("---").trim();
  }
  return markdown.trim();
}

function findViolations(body) {
  const lines = body.split(/\r?\n/u);
  const violations = [];

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    for (const pattern of hostedClaimPatterns) {
      if (!pattern.test(line)) {
        continue;
      }
      if (deferralQualifierPattern.test(line)) {
        continue;
      }
      violations.push({
        line_number: index + 1,
        line,
        matched_pattern: pattern.source,
      });
    }
  }

  return violations;
}

async function main() {
  const entries = await fsp.readdir(changesetDir, { withFileTypes: true });
  const markdownFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name.toLowerCase() !== "readme.md")
    .map((entry) => path.join(changesetDir, entry.name));

  const findings = [];
  for (const filePath of markdownFiles) {
    const markdown = await fsp.readFile(filePath, "utf8");
    const body = extractBody(markdown);
    const violations = findViolations(body);
    if (violations.length > 0) {
      findings.push({
        file: filePath,
        violations,
      });
    }
  }

  if (findings.length > 0) {
    throw new Error(
      `Release scope verification failed. Hosted/cloud claims in changesets must be explicitly marked deferred.\n${JSON.stringify(
        { findings },
        null,
        2,
      )}`,
    );
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        scanned_changesets: markdownFiles.length,
        findings: 0,
      },
      null,
      2,
    )}\n`,
  );
}

await main();
