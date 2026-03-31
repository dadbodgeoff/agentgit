# 04. Background Jobs

Status note:

- this document still captures the target architecture direction
- the audited launch/runtime truth today is inline maintenance plus startup reconciliation
- the repo does not currently claim a durable queued worker model in production

## Working Thesis

Background jobs should be explicit, durable, priority-aware maintenance and support tasks that protect interactivity rather than compete with it.

That means:

- interactive action handling always wins over maintenance
- expensive jobs are resumable and observable
- jobs are typed and scheduled intentionally
- jobs that affect durability are not hidden “best effort” chores

The product depends on background work for correctness, not just cleanliness.

## Why This Matters

If maintenance is ad hoc:

- caches and journals bloat
- snapshot storage runs away
- projections drift
- crash recovery gets weaker

If everything runs inline:

- interactive action latency degrades
- users feel the product as friction

So the design target is:

**small durable job system with strict priority separation**

## Job Classes

The runtime should support a small number of job classes.

## 1. Critical reconciliation jobs

Purpose:

- repair or reconcile state required for correctness after crash or restart

Examples:

- recover in-flight runs
- reconcile interrupted recoveries
- repair pending maintenance markers

Properties:

- run at startup
- higher priority than normal maintenance
- must be durable and journaled where relevant

## 2. Interactive support jobs

Purpose:

- short async work that directly supports a user-visible workflow

Examples:

- helper fact precomputation for the current run
- artifact post-processing for a just-finished action
- preview diff generation for a restore candidate

Properties:

- latency-sensitive
- bounded runtime
- may run soon after an interactive request finishes

## 3. Maintenance jobs

Purpose:

- keep stores healthy and bounded over time

Examples:

- snapshot compaction
- synthetic-anchor rebasing
- artifact retention cleanup
- journal WAL checkpointing
- projection rebuild catch-up

Properties:

- deferrable
- should yield under load
- often batched

## 4. Administrative jobs

Purpose:

- user or CLI-triggered maintenance and diagnostics

Examples:

- force projection rebuild
- force integrity verification
- export diagnostics bundle

Properties:

- explicit invocation
- may run at elevated resource priority if the user requested it

## Launch Job Inventory

The launch runtime should explicitly support at least these jobs:

- `startup_reconcile_runs`
- `startup_reconcile_recoveries`
- `sqlite_wal_checkpoint`
- `projection_refresh`
- `projection_rebuild`
- `snapshot_gc`
- `snapshot_compaction`
- `snapshot_rebase_anchor`
- `artifact_expiry`
- `artifact_orphan_cleanup`
- `capability_refresh`
- `helper_fact_warm`

Launch implementation note:

- `run_maintenance` may execute small owned jobs inline before a durable queue exists
- currently truthful inline jobs are startup run/session reconciliation, startup interrupted-action reconciliation, WAL checkpointing, snapshot garbage collection, snapshot compaction hooks, synthetic-anchor rebasing, artifact expiry, artifact orphan cleanup, capability refresh, helper-fact warming, and projection refresh/rebuild no-op confirmation
- if future documented jobs remain unowned at launch, they should return explicit `not_supported` results rather than pretending they were queued
- when capability refresh is owned inline, diagnostics should expose both cached capability state and whether that cache has gone stale under the configured threshold

## Future Job Queue Model

The authority runtime should maintain a durable local job queue for nontrivial work once that subsystem is actually built.

Current audited launch truth:

- there is no durable queued worker in the runtime today
- launch-owned maintenance jobs run inline or during startup reconciliation
- docs and diagnostics should describe that inline model exactly, without implying queued durability

Recommended job fields:

- `job_id`
- `job_type`
- `priority`
- `state`
- `workspace_id` optional
- `run_id` optional
- `attempt_count`
- `scheduled_at`
- `started_at`
- `completed_at`
- `payload_ref`
- `last_error`

## Job States

Recommended states:

- `queued`
- `ready`
- `running`
- `succeeded`
- `failed`
- `retry_wait`
- `cancelled`
- `blocked`

## Priority Model

Use a simple priority ladder:

### `critical`

- startup reconciliation
- journal integrity work that blocks safe operation

### `interactive_support`

- restore previews
- projection updates for current run
- helper data for active run

### `maintenance`

- compaction
- expiry
- pruning

### `administrative`

- explicit user-triggered maintenance

Administrative jobs may temporarily outrank maintenance when requested by the user, but they should not starve critical correctness work.

## Scheduling Rules

### Run immediately

- startup reconciliation
- projection update needed for the currently open run

### Run opportunistically

- helper warming for active runs
- short artifact post-processing

### Run during idle or low pressure

- snapshot compaction
- synthetic-anchor rebasing
- WAL checkpointing when size threshold is crossed but not urgent
- orphan cleanup

### Run on explicit thresholds

- snapshot GC when pack growth crosses limit
- projection rebuild when lag exceeds tolerance
- WAL checkpoint when WAL file size exceeds configured bound

## Inline Vs Async Rules

Keep inline:

- action-critical snapshot creation
- action-critical journal append
- action-critical policy evaluation

Move async:

- expensive artifact normalization
- compaction
- projection rebuilds
- helper fact caching
- cleanup

The simplest rule is:

if delaying the work would change correctness of the current action, keep it inline; otherwise queue it.

## Durability Model

Not every job needs the same durability guarantee.

### Durable jobs

Use for:

- reconciliation
- compaction
- retention
- projection rebuild

These must survive daemon restart.

### Ephemeral jobs

Use for:

- helper warming
- preview generation
- low-value cache refresh

These may be dropped and recomputed.

## Retry Model

Use typed retry policies.

### Immediate retry candidates

- transient file lock issue
- temporary upstream unavailability for imported artifacts

### Delayed retry candidates

- credential store temporarily locked
- low disk pressure not yet resolved

At launch, low-disk storage failures should surface as retryable `STORAGE_UNAVAILABLE`
errors with explicit low-disk metadata so callers can stop mutating work, free space,
and retry deliberately instead of treating the failure as an opaque internal fault.

### Non-retry candidates

- schema mismatch
- corrupted job payload
- unsupported capability on current platform

## Resource Controls

Background jobs should honor:

- CPU throttling or cooperative yielding
- disk I/O throttling where possible
- max concurrent maintenance jobs
- priority inversion rules

Launch recommendation:

- one heavy maintenance job at a time
- a few lightweight interactive-support jobs concurrently

## Job Ownership

The authority daemon should own scheduling decisions.

Possible execution models:

- in-process worker loop for lightweight jobs
- supervised worker subprocess for heavy compaction

At launch:

- keep scheduling centralized
- offload only when the work is heavy enough to justify it

## Observability

Each job should expose:

- state
- attempts
- elapsed time
- bytes processed where relevant
- result summary

The runtime should surface:

- maintenance backlog
- oldest pending critical job
- current heavy job
- projection lag
- snapshot compaction debt

At launch, the narrow truthful surface can ride on run summaries:

- projection freshness / lag
- artifact evidence health counts
- degraded artifact-capture count
- low-disk-pressure evidence signals

And the system-level view can ride on a narrow `diagnostics` daemon method:

- daemon health
- journal health
- storage evidence summary
- maintenance backlog fields, with `null` or zero where the launch runtime does not yet own a durable queued worker

## Failure Handling

Background job failure should not automatically mean action-path failure.

### Fail action path only when:

- correctness or durability is endangered
- journal integrity is in question
- capability refresh is required before governed execution

### Degrade noncritical behavior when:

- helper warm job fails
- projection rebuild lags but journal is intact
- compaction is deferred

## Suggested Job Storage

Keep durable job metadata in:

- state store or journal-adjacent metadata DB

Keep large job payloads in:

- referenced blobs or compact local payload rows

Do not put giant serialized work payloads directly into a hot job queue table.

## Launch Recommendation

For launch, the background job system should be:

- small
- local
- durable for important work
- explicit about priority
- biased toward protecting interactivity

That is enough to support correctness without inventing a full distributed scheduler.

## Source Inputs

- SQLite WAL and checkpointing: <https://sqlite.org/wal.html>
- SQLite auto-checkpoint control: <https://sqlite.org/c3ref/wal_autocheckpoint.html>
- XDG runtime and state guidance: <https://specifications.freedesktop.org/basedir/latest/>
