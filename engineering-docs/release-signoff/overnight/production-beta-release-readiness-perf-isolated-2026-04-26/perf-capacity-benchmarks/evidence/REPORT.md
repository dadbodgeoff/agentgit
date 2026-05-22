# Production Readiness Benchmarks

- Status: PASS
- Generated: 2026-04-27T00:06:48.080Z
- Iterations: 8

## Latency Percentiles

| Operation | Count | p50 ms | p95 ms | p99 ms | Max ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| action_submission_decision_ms | 8 | 197.44 | 209.28 | 209.28 | 209.28 |
| snapshot_creation_ms | 8 | 180.42 | 202.74 | 202.74 | 202.74 |
| snapshot_restore_ms | 8 | 171.26 | 199.16 | 199.16 | 199.16 |
| audit_query_ms | 8 | 166.34 | 180.48 | 180.48 | 180.48 |

## Throughput

- Actions per second: 5.03
- Snapshots per minute: 105.57

## Cold Start

- Daemon boot ms: 1123.61
- First action after boot ms: 205.98
- First action after restart ms: 229.21

## Page Response

- Status: skipped
- Page response ms: n/a
- Note: No --base-url was supplied; browser/page render latency needs a hosted local or deployed cloud URL.

## Budget Results

| Metric | Budget | Threshold ms | Actual ms | Status |
| --- | --- | ---: | ---: | --- |
| action_submission_decision_ms | p99_ms | 2500 | 209.28 | PASS |
| snapshot_creation_ms | p99_ms | 2500 | 202.74 | PASS |
| snapshot_restore_ms | p99_ms | 3000 | 199.16 | PASS |
| audit_query_ms | p99_ms | 2000 | 180.48 | PASS |
| daemon_boot_ms | max_ms | 10000 | 1123.61 | PASS |
| cold_first_action_after_restart_ms | max_ms | 3000 | 229.21 | PASS |

## Resource Samples

| Label | RSS MB | CPU % |
| --- | ---: | ---: |
| after_boot | 136.97 | 2.9 |
| after_actions | 148.47 | 3.7 |
| after_snapshots_and_restores | 176.25 | 3.8 |
| after_audit_queries | 177.31 | 3.2 |
| after_restart_first_action | 148.75 | 18.1 |
