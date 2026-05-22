# Production Beta Qualification Campaign - 2026-04-26

## Goal

Turn production-beta readiness from ad hoc smoke tests into a repeatable gate that runs suites, writes artifacts, fails closed, and reports exactly what remains unsafe or unproven.

## Runner

```sh
pnpm qualification:production-beta
```

The runner writes:

- `summary.json`
- `REPORT.md`
- per-suite command output
- suite-specific artifacts
- production implication for every pass, failure, or blocker

## Implemented Suites

- [x] `snapshot-regression`
  - Runs workspace-index and snapshot-engine focused tests.
  - Guards exact restore and post-checkpoint drift removal.
- [x] `openclaw-stress`
  - Runs the OpenClaw-style governed local action profile.
  - Covers protected path denials, symlink/outside-root denials, snapshot-backed actions, compensating integration plans, and explicit checkpoint restore.
- [x] `sensitive-redaction`
  - Scans qualification report roots, pointed stress-session roots, and browser test output directories for synthetic tripwires and common token shapes.
  - Evidence limit: heuristic scanner only; this is not a full DLP guarantee.
- [x] `cloud-build`
  - Runs the production cloud build.
- [x] `browser-surface`
  - Uses existing hosted/cloud smoke command surface.
  - Evidence limit: without `--base-url`, this is local hosted browser evidence, not a live deployed-origin smoke.
- [x] `crash-restart`
  - Exercises daemon restart persistence, idempotent run replay, explicit checkpoint restore, and connector durable outbox flush after restart.
- [x] `concurrent-agents`
  - Runs five OpenClaw-style stress sessions concurrently against isolated workspaces and fails on restore mismatch.
  - Evidence limit: this is an isolated-workspace floor; it does not prove 5-10 agents mutating the same workspace.
- [x] `connector-loop`
  - Runs cloud sync protocol, control-plane state, connector runtime, and cloud sync API route tests.
- [x] `scale-soak`
  - Runs a 96-iteration OpenClaw-style stress profile with shell-heavy action mix.
  - Evidence limit: this is a beta-scale burst, not an hours-long soak.
- [x] `snapshot-maintenance`
  - Runs focused compaction, restore-preview, subset restore, WAL checkpoint, snapshot GC, and synthetic anchor rebase tests.
- [x] `migration-compat`
  - Runs CLI compatibility manifest tests and sync schema compatibility route tests.
  - Evidence limit: this is synthetic compatibility coverage; add real historical audit-bundle fixtures when available.
- [x] `audit-export`
  - Runs workspace audit export, audit export route, and auth guard tests for CSV/JSON export coverage.
- [x] `package-install`
  - Packs release artifacts, installs them into clean projects, and runs installed CLI plus installed agent-runtime smoke paths.
- [x] `diff-check`
  - Runs `git diff --check`.
  - Evidence limit: this is whitespace/patch hygiene only; it is not a clean-worktree claim.

## Full Gate Baseline

```sh
pnpm qualification:production-beta -- --timestamp full-production-beta-2026-04-26-r2
```

Result: passed

Artifacts:

- `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/summary.json`
- `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-full-production-beta-2026-04-26-r2/REPORT.md`

Key evidence:

- OpenClaw stress: 36 attempted, 25 denied, 11 snapshot-backed, 0 exact restore mismatches, 0 checkpoint mismatches.
- Concurrent agents: 5 agents, isolated workspaces, 60 combined attempts, 0 restore mismatches.
- Sensitive redaction: 337 artifact files scanned across qualification report roots, stress-session roots, and browser output directories; 0 secret-shaped findings.
- Scale soak: 96 attempted, 65 denied, 31 snapshot-backed, 0 restore mismatches.
- Browser surface: `pnpm smoke:cloud-hosted` passed against the local hosted path.
- Package install: packed artifacts installed into clean projects; public package, installed CLI, and installed agent-runtime smoke paths passed.

## Release Interpretation

The full production-beta qualification gate now passes for the local product surface available in this repo: governed filesystem/integration actions, snapshot-backed recovery, explicit checkpoint restore, restart persistence, connector sync, audit export, local hosted browser smoke, package install smoke, artifact redaction, and patch hygiene.

This does not claim a live deployed origin was tested, because no deployment URL exists yet. It also does not claim npm publish completed; the package gate uses local packed artifacts installed into clean projects.

Before the next cut, compare this gate against the most recent real production incident or near-miss. If no suite here would have caught it, add that failure mode as the next required suite before widening the release.

## Release-Readiness Expansion

Use this stricter opt-in gate when the beta gate is not enough:

```sh
pnpm qualification:release-readiness
```

This expands the local beta suite set with SRE, security, portability, DX, and legal readiness checks. It intentionally fails closed with `blocked` status for evidence that cannot be produced on this Mac alone.

Implemented local release-readiness suites:

- [x] `perf-capacity-benchmarks`
  - Measures daemon boot, first action after restart, action submission, checkpoint creation, restore, audit query, throughput, and resource samples.
  - Evidence limit: local single-machine numbers; controlled hardware and baseline regression comparison belong in CI/staging.
  - Benchmark-use rule: run this suite in isolation for customer/SRE latency claims. The full release-readiness matrix can contend with snapshot-heavy suites and should be treated as gate evidence, not as the canonical latency baseline.
  - Latest isolated baseline: `release-readiness-perf-isolated-2026-04-26` measured action p99 209.28ms, snapshot p99 202.74ms, restore p99 199.16ms, audit p99 180.48ms, 5.03 actions/sec, and 105.57 snapshots/min.
  - Regression check: the isolated snapshot/restore numbers are better than r2's snapshot p99 354.5ms and restore p99 494.46ms; r7's full-matrix snapshot p99 1931.82ms and restore p99 1684.53ms were contention artifacts, not a bisect-worthy product regression.
- [x] `security-dependency-audit`
  - Runs the configured Node and Python dependency audit threshold.
- [x] `security-sbom`
  - Packs release artifacts and writes a CycloneDX JSON SBOM covering workspace manifests and packed files.
  - Evidence limit: local SBOM generation; enterprise release should attach CI-generated CycloneDX/SPDX output.
- [x] `security-static-analysis`
  - Runs Semgrep with repo-owned rules for unsafe dynamic execution, dangerous HTML injection, direct request parsing, shell execution, and hardcoded secret assignments.
  - Evidence limit: local rule pack only; CodeQL or hosted SAST should still be added in CI for deeper dataflow coverage.
- [x] `security-secret-scan`
  - Runs gitleaks against git history and the working tree with repo allowlists and redacted findings.
  - Evidence limit: local repo scan only; scheduled protected-branch scans and packed-artifact scans still belong in CI.
- [x] `security-authz-matrix`
  - Runs focused auth guard, token/session, cross-resource, restore, and team route tests.
- [x] `security-agent-adversarial`
  - Runs the Campaign 0 adversarial containment audit.
- [x] `data-integrity-property`
  - Runs multiple seeded OpenClaw stress sequences and fails on any restore mismatch.
  - Evidence limit: seeded property-style stress; a true property-based generator and shrinker is still needed.
- [x] `data-fuzzing`
  - Mutates audit bundle verifier inputs, cloud sync protocol decoder payloads, and CLI argument inputs.
  - Evidence limit: deterministic corpus mutation only; coverage-guided fuzzing with shrinking remains a deeper GA item.
- [x] `backup-restore-drill`
  - Runs the recovery drill and reports measured RTO/RPO evidence.
- [x] `observability-coverage`
  - Exposes token-gated Prometheus-format cloud metrics and tests non-zero API response and route-error samples.
  - Evidence limit: local cloud route metrics only; daemon/runtime OpenTelemetry export remains a GA hardening item.
- [x] `log-quality`
  - Scans qualification logs and command artifacts for secret-shaped values and obvious SSN-shaped PII.
  - Evidence limit: local artifact scan only; structured correlation-ID completeness belongs in production log validation.
- [x] `accessibility`
  - Runs the existing Playwright accessibility scan.
- [x] `visual-regression`
  - Runs Playwright screenshot diffs against approved local Chromium baselines for `/`, `/pricing`, `/docs`, and `/sign-in`.
  - Evidence limit: local Chromium public-route baseline only; full browser/device visual baselines belong in CI.
- [x] `docs-dx-quickstart`
  - Packs artifacts and runs public-package, installed CLI, and installed agent-runtime smoke paths.
- [x] `public-api-contract`
  - Runs schema and cloud sync protocol contract tests.
- [x] `error-message-audit`
  - Runs representative route/request/auth tests for controlled user-facing failure responses.
- [x] `license-audit`
  - Scans workspace package manifests for publishable packages without licenses and GPL/AGPL/LGPL declarations.
  - Evidence limit: workspace manifests only; transitive dependency license export should come from CI.

External evidence blockers now tracked by the release-readiness gate:

- [ ] `reliability-chaos`: destructive fault injection for kill -9 mid-snapshot, disk-full WAL append, network partition, clock skew, and partial filesystem corruption.
- [ ] `alert-runbook-smoke`: staging alerts and top incident runbook execution.
- [ ] `os-node-matrix`: Linux x64, Linux arm64, macOS arm64, macOS x64, and Windows install matrix across supported Node versions.
- [ ] `network-conditions`: high-latency, lossy, captive-portal, and IPv6-only test environment.
- [ ] `browser-matrix`: Chrome, Firefox, Safari, and mobile browser matrix.
- [ ] `telemetry-privacy-review`: telemetry send-home behavior, documentation, and opt-out validation.
- [ ] `data-residency-review`: deployed cloud storage topology and region/customer data residency claims.
