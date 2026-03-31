# 07. Run Journal Spec

## Scope

This document resolves event taxonomy, ordering, transactions, projections, SQLite behavior, payload limits, and import/observation rules.

## Event Registry

Run lifecycle:

- `run.created`
- `run.started`
- `run.paused`
- `run.resumed`
- `run.completed`
- `run.failed`
- `run.cancelled`

Action/policy/snapshot/execution/recovery/analysis events follow the v1 enum fixed in the checklist.

## Ordering

- `sequence`: authoritative run-local append order
- `occurred_at`: real-world occurrence time
- `recorded_at`: commit time

Imported events may have older `occurred_at` but newer `sequence`.

## Transactions

- Single event append is atomic
- Small related batches may share one DB transaction before side effects begin
- Side-effectful execution is not fully transactional with journal writes, so reconciliation exists for crash recovery

## Projections

Launch projections:

- run summary
- timeline steps
- approval inbox
- recovery state
- changed-path index
- external-effect index
- helper fact cache

Freshness targets:

- active run timeline: **< 1s**
- approvals: **< 500ms**
- helper cache: **< 3s**

## SQLite

- Minimum version: **3.51.3+**
- WAL mode on local disk only
- WAL checkpoint:
  - size: **64 MB**
  - time: **5 min**
  - idle trigger when no active actions and WAL > 8 MB
- Hard WAL limit: **256 MB**
- One writer: authority daemon journal service

## Payload Limits

- Max inline event payload: **64 KB**
- Larger data stored by artifact reference

## Import And Observation

- Imported and observed events remain distinct
- They still update projections
- Validation required on ingest
