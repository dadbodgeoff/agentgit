# Production Readiness Benchmarks

- Status: PASS
- Generated: 2026-04-26T23:32:04.292Z
- Iterations: 8

## Latency Percentiles

| Operation | Count | p50 ms | p95 ms | p99 ms | Max ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| action_submission_decision_ms | 8 | 218.26 | 258.59 | 258.59 | 258.59 |
| snapshot_creation_ms | 8 | 265.08 | 1931.82 | 1931.82 | 1931.82 |
| snapshot_restore_ms | 8 | 517.12 | 1684.53 | 1684.53 | 1684.53 |
| audit_query_ms | 8 | 432.45 | 756.65 | 756.65 | 756.65 |

## Throughput

- Actions per second: 4.45
- Snapshots per minute: 33.17

## Cold Start

- Daemon boot ms: 1736.14
- First action after boot ms: 253
- First action after restart ms: 359.14

## Page Response

- Status: skipped
- Page response ms: n/a
- Note: No --base-url was supplied; browser/page render latency needs a hosted local or deployed cloud URL.

## Budget Results

| Metric | Budget | Threshold ms | Actual ms | Status |
| --- | --- | ---: | ---: | --- |
| action_submission_decision_ms | p99_ms | 2500 | 258.59 | PASS |
| snapshot_creation_ms | p99_ms | 2500 | 1931.82 | PASS |
| snapshot_restore_ms | p99_ms | 3000 | 1684.53 | PASS |
| audit_query_ms | p99_ms | 2000 | 756.65 | PASS |
| daemon_boot_ms | max_ms | 10000 | 1736.14 | PASS |
| cold_first_action_after_restart_ms | max_ms | 3000 | 359.14 | PASS |

## Resource Samples

| Label | RSS MB | CPU % |
| --- | ---: | ---: |
| after_boot | 137.88 | 2 |
| after_actions | 149.78 | 5.3 |
| after_snapshots_and_restores | 99 | 2.9 |
| after_audit_queries | 106.8 | 3.8 |
| after_restart_first_action | 148.64 | 14.4 |
