import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  buildFinalReport,
  collectRedactionScanRoots,
  createSuiteRegistry,
  detectSensitiveFindings,
  deriveGateStatus,
  makeOpenclawSessionRoot,
  parseArgs,
  resolveOpenclawSummaryPath,
} from "./production-beta-qualification.mjs";

test("suite registry covers the production-beta hardening categories", () => {
  const suites = createSuiteRegistry();
  const suiteIds = suites.map((suite) => suite.id);

  assert.deepEqual(suiteIds, [
    "snapshot-regression",
    "openclaw-stress",
    "cloud-build",
    "browser-surface",
    "crash-restart",
    "concurrent-agents",
    "connector-loop",
    "sensitive-redaction",
    "scale-soak",
    "snapshot-maintenance",
    "migration-compat",
    "audit-export",
    "package-install",
    "diff-check",
  ]);
});

test("suite registry does not leave local production-beta categories as placeholders", () => {
  const suites = createSuiteRegistry();
  const blockedSuites = suites.filter((suite) => suite.blockedReason);

  assert.deepEqual(
    blockedSuites.map((suite) => suite.id),
    [],
  );
});

test("release-hardening registry expands into measurable and externally blocked suites", () => {
  const suites = createSuiteRegistry({ includeReleaseHardening: true });
  const suiteIds = suites.map((suite) => suite.id);

  assert.ok(suiteIds.includes("perf-capacity-benchmarks"));
  assert.ok(suiteIds.includes("reliability-chaos"));
  assert.ok(suiteIds.includes("security-dependency-audit"));
  assert.ok(suiteIds.includes("security-sbom"));
  assert.ok(suiteIds.includes("security-static-analysis"));
  assert.ok(suiteIds.includes("security-secret-scan"));
  assert.ok(suiteIds.includes("security-authz-matrix"));
  assert.ok(suiteIds.includes("security-agent-adversarial"));
  assert.ok(suiteIds.includes("data-integrity-property"));
  assert.ok(suiteIds.includes("data-fuzzing"));
  assert.ok(suiteIds.includes("backup-restore-drill"));
  assert.ok(suiteIds.includes("observability-coverage"));
  assert.ok(suiteIds.includes("log-quality"));
  assert.ok(suiteIds.includes("alert-runbook-smoke"));
  assert.ok(suiteIds.includes("os-node-matrix"));
  assert.ok(suiteIds.includes("network-conditions"));
  assert.ok(suiteIds.includes("browser-matrix"));
  assert.ok(suiteIds.includes("accessibility"));
  assert.ok(suiteIds.includes("visual-regression"));
  assert.ok(suiteIds.includes("docs-dx-quickstart"));
  assert.ok(suiteIds.includes("public-api-contract"));
  assert.ok(suiteIds.includes("error-message-audit"));
  assert.ok(suiteIds.includes("license-audit"));
  assert.ok(suiteIds.includes("telemetry-privacy-review"));
  assert.ok(suiteIds.includes("data-residency-review"));

  const blocked = suites.filter((suite) => suite.blockedReason).map((suite) => suite.id);
  assert.deepEqual(blocked.sort(), [
    "alert-runbook-smoke",
    "browser-matrix",
    "data-fuzzing",
    "data-residency-review",
    "network-conditions",
    "observability-coverage",
    "os-node-matrix",
    "reliability-chaos",
    "security-secret-scan",
    "security-static-analysis",
    "telemetry-privacy-review",
    "visual-regression",
  ]);
});

test("deriveGateStatus fails closed for failed, blocked, or missing required suites", () => {
  assert.equal(
    deriveGateStatus([
      { id: "one", required: true, status: "passed" },
      { id: "two", required: true, status: "failed" },
    ]),
    "failed",
  );
  assert.equal(
    deriveGateStatus([
      { id: "one", required: true, status: "passed" },
      { id: "two", required: true, status: "blocked" },
    ]),
    "blocked",
  );
  assert.equal(
    deriveGateStatus([
      { id: "one", required: true, status: "passed" },
      { id: "two", required: true, status: "pending" },
    ]),
    "incomplete",
  );
  assert.equal(deriveGateStatus([{ id: "one", required: true, status: "passed" }]), "passed");
});

test("buildFinalReport includes suite commands, artifacts, and production implications", () => {
  const report = buildFinalReport({
    generatedAt: "2026-04-26T12:00:00.000Z",
    gateStatus: "failed",
    artifactRoot: "/tmp/agentgit-qualification/report",
    results: [
      {
        id: "openclaw-stress",
        name: "OpenClaw Stress",
        required: true,
        status: "passed",
        command: "node scripts/stress-autonomous-governance.mjs --profile openclaw",
        durationMs: 1234,
        summary: "stress passed",
        productionImplication: "Governed local actions are covered.",
        evidenceCeiling: "This proves the beta burst profile, not hours-long soak behavior.",
        artifacts: ["/tmp/agentgit-qualification/report/openclaw/summary.json"],
      },
      {
        id: "crash-restart",
        name: "Crash Restart",
        required: true,
        status: "failed",
        command: "node scripts/qualification-crash-restart.mjs",
        durationMs: 456,
        summary: "false success detected",
        productionImplication: "Release is unsafe until crash recovery is fixed.",
        artifacts: [],
      },
    ],
  });

  assert.match(report, /# Production Beta Qualification Report/);
  assert.match(report, /Gate status: failed/);
  assert.match(report, /openclaw-stress/);
  assert.match(report, /node scripts\/stress-autonomous-governance\.mjs --profile openclaw/);
  assert.match(report, /\/tmp\/agentgit-qualification\/report\/openclaw\/summary\.json/);
  assert.match(report, /Evidence ceiling: This proves the beta burst profile, not hours-long soak behavior\./);
  assert.match(report, /Release is unsafe until crash recovery is fixed\./);
});

test("parseArgs supports suite filters and non-destructive dry runs", () => {
  assert.deepEqual(parseArgs(["--suite", "openclaw-stress", "--suite", "cloud-build", "--dry-run"]), {
    suiteIds: ["openclaw-stress", "cloud-build"],
    artifactRoot: null,
    baseUrl: null,
    dryRun: true,
    continueOnFailure: true,
    includeReleaseHardening: false,
    timestamp: null,
  });
});

test("parseArgs ignores the pnpm argument separator", () => {
  assert.deepEqual(parseArgs(["--", "--dry-run", "--timestamp", "dry-run"]), {
    suiteIds: [],
    artifactRoot: null,
    baseUrl: null,
    dryRun: true,
    continueOnFailure: true,
    includeReleaseHardening: false,
    timestamp: "dry-run",
  });
});

test("parseArgs enables release-hardening expansion", () => {
  assert.equal(parseArgs(["--include-release-hardening"]).includeReleaseHardening, true);
});

test("makeOpenclawSessionRoot keeps daemon socket paths outside long report directories", () => {
  const artifactRoot =
    "/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-implemented-core-2026-04-26/openclaw-stress";
  const sessionRoot = makeOpenclawSessionRoot(artifactRoot);

  assert.match(sessionRoot, /^\/tmp\/agq-/);
  assert.ok(path.join(sessionRoot, "workspace", ".agentgit", "authority.sock").length < 100);
  assert.ok(!sessionRoot.startsWith(artifactRoot));
});

test("resolveOpenclawSummaryPath follows the session-root pointer", async () => {
  const tempRoot = await import("node:fs/promises").then(async (fs) => {
    const os = await import("node:os");
    const path = await import("node:path");
    return fs.mkdtemp(path.join(os.tmpdir(), "agentgit-qualification-test-"));
  });
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const sessionRoot = path.join(tempRoot, "session");
  await fs.mkdir(path.join(tempRoot, "openclaw-stress"), { recursive: true });
  await fs.mkdir(path.join(sessionRoot, "report"), { recursive: true });
  await fs.writeFile(path.join(tempRoot, "openclaw-stress", "session-root.txt"), `${sessionRoot}\n`, "utf8");
  await fs.writeFile(path.join(sessionRoot, "report", "summary.json"), "{}\n", "utf8");

  assert.equal(resolveOpenclawSummaryPath(tempRoot), path.join(sessionRoot, "report", "summary.json"));
});

test("collectRedactionScanRoots includes report artifacts, pointed session roots, and browser output dirs", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentgit-redaction-roots-"));
  const sessionRoot = path.join(tempRoot, "session-root");
  const browserOutputRoot = path.join(tempRoot, "browser-output");

  await fs.mkdir(path.join(tempRoot, "openclaw-stress"), { recursive: true });
  await fs.mkdir(sessionRoot, { recursive: true });
  await fs.mkdir(browserOutputRoot, { recursive: true });
  await fs.writeFile(path.join(tempRoot, "openclaw-stress", "session-root.txt"), `${sessionRoot}\n`, "utf8");

  assert.deepEqual(await collectRedactionScanRoots(tempRoot, { browserOutputRoots: [browserOutputRoot] }), [
    tempRoot,
    sessionRoot,
    browserOutputRoot,
  ]);
});

test("detectSensitiveFindings catches synthetic tripwires and common novel token shapes without storing values", () => {
  const findings = detectSensitiveFindings(
    "/tmp/agentgit-redaction/evidence.json",
    [
      "OPENAI_API_KEY=not-a-real-secret",
      "token: sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
      "github: ghp_abcdefghijklmnopqrstuvwxyz1234567890",
      "STRIPE_SECRET_KEY=synthetic-stripe-secret-fixture",
    ].join("\n"),
  );

  assert.equal(findings.length, 4);
  assert.deepEqual(
    findings.map((finding) => finding.pattern),
    ["synthetic-openai-key", "openai-api-key", "github-token", "named-secret-assignment"],
  );
  assert.ok(findings.every((finding) => !JSON.stringify(finding).includes("not-a-real-secret")));
  assert.ok(findings.every((finding) => !JSON.stringify(finding).includes("abcdefghijklmnopqrstuvwxyz")));
});
