# Production Beta Qualification Report

Generated: 2026-04-27T00:06:48.100Z
Gate status: passed
Artifact root: /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-perf-isolated-2026-04-26

## Suite Results

| Suite | Required | Status | Duration | Production implication |
| --- | --- | --- | --- | --- |
| perf-capacity-benchmarks | yes | passed | 10.0s | Measured latency percentiles, throughput, cold-start time, and resource samples must be available for SRE review. |

## Performance And Capacity Benchmarks

- Suite id: `perf-capacity-benchmarks`
- Status: `passed`
- Required: yes
- Duration: 10.0s
- Command: `node scripts/production-readiness-benchmarks.mjs --output-dir /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-perf-isolated-2026-04-26/perf-capacity-benchmarks/evidence --iterations 8`
- Summary: action_p99_ms=209.28, snapshot_p99_ms=202.74, restore_p99_ms=199.16, audit_p99_ms=180.48, actions_per_second=5.03, snapshots_per_minute=105.57, budget_failures=0
- Production implication: Measured latency percentiles, throughput, cold-start time, and resource samples must be available for SRE review.
- Evidence ceiling: Local single-machine benchmark evidence is a beta floor; CI/staging should add controlled hardware and baseline-regression comparison.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-perf-isolated-2026-04-26/perf-capacity-benchmarks/command.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-perf-isolated-2026-04-26/perf-capacity-benchmarks/evidence/summary.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-perf-isolated-2026-04-26/perf-capacity-benchmarks/evidence/REPORT.md`
