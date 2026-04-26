# Production Readiness Benchmarks

- Status: PASS
- Generated: 2026-04-26T22:14:16.130Z
- Iterations: 8

## Latency Percentiles

| Operation | Count | p50 ms | p95 ms | p99 ms | Max ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| action_submission_decision_ms | 8 | 209.1 | 281.6 | 281.6 | 281.6 |
| snapshot_creation_ms | 8 | 248.47 | 354.5 | 354.5 | 354.5 |
| snapshot_restore_ms | 8 | 242.71 | 494.46 | 494.46 | 494.46 |
| audit_query_ms | 8 | 633.66 | 1208.23 | 1208.23 | 1208.23 |

## Throughput

- Actions per second: 4.59
- Snapshots per minute: 75.31

## Cold Start

- Daemon boot ms: 1328.73
- First action after boot ms: 314.07
- First action after restart ms: 387.81

## Page Response

- Status: skipped
- Page response ms: n/a
- Note: No --base-url was supplied; browser/page render latency needs a hosted local or deployed cloud URL.

## Budget Results

| Metric | Budget | Threshold ms | Actual ms | Status |
| --- | --- | ---: | ---: | --- |
| action_submission_decision_ms | p99_ms | 2500 | 281.6 | PASS |
| snapshot_creation_ms | p99_ms | 2500 | 354.5 | PASS |
| snapshot_restore_ms | p99_ms | 3000 | 494.46 | PASS |
| audit_query_ms | p99_ms | 2000 | 1208.23 | PASS |
| daemon_boot_ms | max_ms | 10000 | 1328.73 | PASS |
| cold_first_action_after_restart_ms | max_ms | 3000 | 387.81 | PASS |

## Resource Samples

| Label | RSS MB | CPU % |
| --- | ---: | ---: |
| after_boot | 136.31 | 4.5 |
| after_actions | 127.95 | 3.6 |
| after_snapshots_and_restores | 154.95 | 3.5 |
| after_audit_queries | 59.63 | 1.6 |
| after_restart_first_action | 148.28 | 12.9 |

