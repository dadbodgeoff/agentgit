# 12. Cross-Cutting Spec

## Scope

This document resolves shared error, observability, performance, testing, schema evolution, and security rules.

## Errors

- API-level problems use daemon error envelope
- Domain failures use typed results
- Partial failure:
  - side effects happened + success absent => `partial`

## Observability

- Structured logs:
  - JSON
  - level
  - timestamp
  - component
  - request/run/action IDs
- Trace propagation:
  - OpenTelemetry-compatible `trace_id` + `span_id`
- Key metrics:
  - policy eval latency
  - snapshot latency by class
  - journal write latency
  - projection lag
  - helper latency
  - end-to-end action latency
  - storage usage by store/class

## Performance Targets

- Policy eval p95: **< 50ms**
- Snapshot creation:
  - `metadata_only` p95: **< 20ms**
  - `journal_only` p95: **< 100ms**
  - `journal_plus_anchor` p95: **< 500ms**
  - `exact_anchor` p95: **< 1500ms** on supported local paths
- Journal write p95: **< 10ms**
- Timeline summary query p95: **< 100ms**
- Fast local action budget p95: **< 500ms**, excluding the tool’s own long-running work

## Testing

- Unit tests per subsystem
- Integration tests across subsystem seams
- End-to-end scenarios:
  - allow
  - allow_with_snapshot
  - ask/approve
  - deny
  - partial execution
  - recovery success/failure
  - imported event flow

## Schema Evolution

- Breaking change -> new schema version
- Write latest; read latest plus supported older versions
- Validate at write time and external/import boundaries

## Security

Threat model includes:

- curious/misbehaving model
- untrusted remote tools/servers
- accidental local misuse
- partial workstation compromise

Hard rules:

- no raw secrets in logs/journal/helper
- approval resolution only via valid local session
- sticky approvals scoped tightly
- canonical durable roots user-readable only where possible
