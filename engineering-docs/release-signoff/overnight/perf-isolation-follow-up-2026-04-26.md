# Performance Isolation Follow-Up - 2026-04-26

## Decision

The r7 performance spike is contention from the full release-readiness matrix, not a confirmed product regression.

Use the isolated benchmark run as the current local latency evidence for any customer, SRE, or deck copy. Keep the full r7 benchmark numbers in the generated r7 report as full-matrix gate evidence, but do not present them as standalone product latency.

## Evidence

| run | action p99 | snapshot p99 | restore p99 | audit p99 | actions/sec | snapshots/min |
|---|---:|---:|---:|---:|---:|---:|
| r2 full matrix | 281.6ms | 354.5ms | 494.46ms | 1208.23ms | 4.59 | 75.31 |
| r7 full matrix | 258.59ms | 1931.82ms | 1684.53ms | 756.65ms | 4.45 | 33.17 |
| isolated follow-up | 209.28ms | 202.74ms | 199.16ms | 180.48ms | 5.03 | 105.57 |

Command:

```sh
pnpm qualification:release-readiness -- --suite perf-capacity-benchmarks --timestamp release-readiness-perf-isolated-2026-04-26
```

Artifacts:

- [Isolated report](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-perf-isolated-2026-04-26/REPORT.md)
- [Isolated summary](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-perf-isolated-2026-04-26/summary.json)
- [r7 full matrix report](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-full-2026-04-26-r7/REPORT.md)

## Release Notes

- Backup/restore drill RTO moved from 331ms in r2 to 340ms in r7. Treat as noise.
- Adversarial containment remains clean: 10/10 probes passed, 0 content leaks, 0 filesystem changes.
- Correctness held across all restore-mismatch gates: OpenClaw stress 0, scale soak 0, concurrent agents 0, data-integrity property 0.
- Sensitive redaction scanned the same 337 artifact files and slowed to 254ms in r7. Treat as noise unless repeated.
- Secret scanning is now stronger than the original blocked item: git history plus 29 source/config/doc targets, zero findings. The 29 separate gitleaks artifacts are noisy but useful for traceability.

## Operating Rule

Run `perf-capacity-benchmarks` alone when publishing latency numbers. Run the full release-readiness gate for pass/fail coverage. Do not mix those two evidence classes in launch copy.
