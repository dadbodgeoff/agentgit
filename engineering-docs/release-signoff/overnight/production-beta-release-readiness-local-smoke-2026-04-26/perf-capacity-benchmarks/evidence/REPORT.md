# Production Readiness Benchmarks

- Status: PASS
- Generated: 2026-04-26T21:57:34.111Z
- Iterations: 8

## Latency Percentiles

| Operation | Count | p50 ms | p95 ms | p99 ms | Max ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| action_submission_decision_ms | 8 | 250.28 | 324.82 | 324.82 | 324.82 |
| snapshot_creation_ms | 8 | 196.03 | 221.01 | 221.01 | 221.01 |
| snapshot_restore_ms | 8 | 182.15 | 249.66 | 249.66 | 249.66 |
| audit_query_ms | 8 | 176.38 | 210.34 | 210.34 | 210.34 |

## Throughput

- Actions per second: 3.79
- Snapshots per minute: 95.84

## Cold Start

- Daemon boot ms: 1581.6
- First action after boot ms: 241.28
- First action after restart ms: 235.26

## Page Response

- Status: skipped
- Page response ms: n/a
- Note: No --base-url was supplied; browser/page render latency needs a hosted local or deployed cloud URL.

## Budget Results

| Metric | Budget | Threshold ms | Actual ms | Status |
| --- | --- | ---: | ---: | --- |
| action_submission_decision_ms | p99_ms | 2500 | 324.82 | PASS |
| snapshot_creation_ms | p99_ms | 2500 | 221.01 | PASS |
| snapshot_restore_ms | p99_ms | 3000 | 249.66 | PASS |
| audit_query_ms | p99_ms | 2000 | 210.34 | PASS |
| daemon_boot_ms | max_ms | 10000 | 1581.6 | PASS |
| cold_first_action_after_restart_ms | max_ms | 3000 | 235.26 | PASS |

## Resource Samples

| Label | RSS MB | CPU % |
| --- | ---: | ---: |
| after_boot | 138.52 | 1.5 |
| after_actions | 150.52 | 5.3 |
| after_snapshots_and_restores | 164 | 3.5 |
| after_audit_queries | 164.92 | 3.5 |
| after_restart_first_action | 144.33 | 24 |

