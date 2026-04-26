# Production Readiness Benchmarks

- Status: PASS
- Generated: 2026-04-26T22:05:18.320Z
- Iterations: 8

## Latency Percentiles

| Operation | Count | p50 ms | p95 ms | p99 ms | Max ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| action_submission_decision_ms | 8 | 202.24 | 225.64 | 225.64 | 225.64 |
| snapshot_creation_ms | 8 | 193.83 | 211.84 | 211.84 | 211.84 |
| snapshot_restore_ms | 8 | 180.65 | 185.92 | 185.92 | 185.92 |
| audit_query_ms | 8 | 174.13 | 191.04 | 191.04 | 191.04 |

## Throughput

- Actions per second: 4.75
- Snapshots per minute: 99.92

## Cold Start

- Daemon boot ms: 1174.4
- First action after boot ms: 222.8
- First action after restart ms: 220.65

## Page Response

- Status: skipped
- Page response ms: n/a
- Note: No --base-url was supplied; browser/page render latency needs a hosted local or deployed cloud URL.

## Budget Results

| Metric | Budget | Threshold ms | Actual ms | Status |
| --- | --- | ---: | ---: | --- |
| action_submission_decision_ms | p99_ms | 2500 | 225.64 | PASS |
| snapshot_creation_ms | p99_ms | 2500 | 211.84 | PASS |
| snapshot_restore_ms | p99_ms | 3000 | 185.92 | PASS |
| audit_query_ms | p99_ms | 2000 | 191.04 | PASS |
| daemon_boot_ms | max_ms | 10000 | 1174.4 | PASS |
| cold_first_action_after_restart_ms | max_ms | 3000 | 220.65 | PASS |

## Resource Samples

| Label | RSS MB | CPU % |
| --- | ---: | ---: |
| after_boot | 137.95 | 3.4 |
| after_actions | 149.95 | 3.4 |
| after_snapshots_and_restores | 177.98 | 5 |
| after_audit_queries | 178.48 | 1.9 |
| after_restart_first_action | 147.86 | 23.6 |

