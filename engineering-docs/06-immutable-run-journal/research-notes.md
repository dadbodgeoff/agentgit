# Research Notes

## Scope

This note captures the external research used to shape the first plan for the Immutable Run Journal subsystem.

Research date:

- March 30, 2026

## Key Findings

### 1. Tracing is a correlation layer, not a durable ledger

OpenTelemetry makes spans and events excellent for correlation, but the SDK explicitly allows limits on stored attributes, links, and events.

Design implication:

- use trace IDs and span links for causality
- do not rely on OTel alone for complete product history

### 2. Standard event envelopes improve future interoperability

CloudEvents exists because common envelope attributes improve event portability and tooling interoperability.

Design implication:

- borrow envelope fields like `id`, `source`, `type`, `subject`, and `time`
- avoid painting the journal into a proprietary export corner

### 3. SQLite WAL is a good match for one-writer, many-reader local journaling

SQLite WAL offers:

- fast writes
- concurrent readers
- application-controlled checkpointing

But the docs are also explicit that:

- WAL only works on the same host
- checkpoint starvation from long readers can cause unbounded WAL growth

Design implication:

- SQLite WAL is a strong local substrate
- the application must manage checkpoints and read transaction duration deliberately

### 4. JSON is workable if key fields are pulled out for indexing

SQLite stores JSON as text or JSONB-processed blobs and supports generated columns and indexed expressions.

Design implication:

- store flexible event data as JSON
- pull important selectors into typed columns or generated columns

### 5. Meaningful barriers matter

SQLite’s session and undo/redo materials show that grouping changes into meaningful undo/replay steps is essential.

Design implication:

- explicitly journal action, approval, snapshot, and recovery boundaries
- do not attempt to reconstruct everything later from timestamps alone

## Source Notes

### OpenTelemetry

- Trace API
  - Spans, events, links, and status form a strong causality model.
  - <https://opentelemetry.io/docs/specs/otel/trace/api/>

- Trace SDK
  - Event/link/attribute limits mean the tracing layer may discard data.
  - <https://opentelemetry.io/docs/specs/otel/trace/sdk/>

### CloudEvents

- Spec repository
  - Confirms the stable core envelope model and ongoing ecosystem adoption.
  - <https://github.com/cloudevents/spec>

### SQLite

- WAL
  - Fast concurrent local writes/reads, but checkpoint starvation must be managed.
  - <https://sqlite.org/wal.html>

- JSON functions
  - JSON can be queried, but storage is still ordinary SQLite types.
  - <https://sqlite.org/json1.html>

- JSONB
  - SQLite JSONB is smaller and faster for internal processing than text JSON in many cases.
  - <https://sqlite.org/jsonb.html>

- Generated columns
  - Generated columns can participate in indexes, which is useful for event projection/query paths.
  - <https://sqlite.org/gencol.html>

- Indexes on expressions
  - Expression indexes work, but queries must match indexed expressions exactly.
  - <https://sqlite.org/expridx.html>

- WITHOUT ROWID
  - Useful in some table shapes, but not automatically better for every journal table.
  - <https://sqlite.org/withoutrowid.html>

- Session extension
  - Changesets, patchsets, and invert/rebase patterns reinforce the value of explicit durable change boundaries.
  - <https://sqlite.org/sessionintro.html>
  - <https://sqlite.org/session.html>

- Undo/redo demo
  - Demonstrates how explicit barriers define meaningful undo units.
  - <https://sqlite.org/undoredo.html>

## Resulting Recommendation

The run journal should be:

- append-only
- event-first
- projection-backed
- SQLite WAL-based locally
- trace-correlated but not trace-dependent
- careful about query design and checkpointing
