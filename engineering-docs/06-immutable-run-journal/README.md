# 06. Immutable Run Journal

## Working Thesis

The Immutable Run Journal should be the durable, append-only product ledger for everything that matters in an agent run.

It is not:

- just tracing
- just logs
- just analytics

It is the canonical history that lets the system:

- replay what happened
- explain why it happened
- locate rollback boundaries
- reconstruct approvals and policy decisions
- distinguish governed actions from observed ones

The journal should therefore be:

- append-only
- queryable
- correlation-friendly
- compact enough for local-first use

## Why This Matters

If the journal is only raw logs:

- timeline UX becomes brittle
- restore lookups become slow
- explanations require guesswork

If the journal is only projections:

- we lose fidelity
- reindexing or new views become dangerous
- auditing becomes weak

So the correct model is:

**immutable event ledger first, derived projections second**

## Research-Driven Design Constraints

### Traces are useful, but they are not a durable product ledger

OpenTelemetry spans and events are an excellent correlation model, but the SDK spec allows limits on attributes, links, and events, and tracing systems may sample or discard data.

Design implication:

- use trace semantics for correlation
- do not make OTel spans the system of record

### Event envelopes benefit from standard attributes

CloudEvents exists because common event metadata like:

- `id`
- `source`
- `type`
- `subject`
- `time`

improves interoperability across systems.

Design implication:

- the internal journal should use a CloudEvents-like envelope even if it is not a strict CloudEvents implementation
- exporting or syncing later becomes much easier

### SQLite WAL is a strong fit for local-first durable journaling

SQLite’s WAL mode has a very attractive shape for our use case:

- fast writes
- readers do not block writers
- one writer with many readers works well
- checkpointing can be controlled by the application

It also has clear operational caveats:

- all processes must be on the same host
- long-lived readers can starve checkpoints and cause WAL growth

Design implication:

- SQLite WAL is a good local journal substrate
- but the app must manage reader gaps and checkpoint strategy deliberately

### JSON storage is fine, but queryability must be designed

SQLite stores JSON as text or JSONB-like blobs processed through JSON functions, and generated columns can be indexed.

Design implication:

- event payloads can live as JSON
- but important query keys should be extracted into typed columns or generated columns

### Undo and changeset systems reinforce the value of explicit barriers

SQLite’s undo/redo demo and session/changeset APIs both show that grouping changes into meaningful barriers is critical.

Design implication:

- the journal needs explicit run, action, approval, snapshot, and recovery boundaries
- replay should not rely on naive timestamp grouping alone

## Product Role

The journal is where the system records:

- what happened
- in what order
- under which run/action IDs
- with which policy and snapshot decisions
- with which outputs and recovery consequences

This is the substrate for:

- timeline UI
- helper answers
- restore planning
- hosted sync later

## Non-Goals

- Replace artifact storage
- Replace analytics warehouse needs
- Store all large blobs inline
- Depend on trace collectors for completeness

## Event Model

The journal should use an immutable event model.

## Core envelope

Recommended envelope fields:

```json
{
  "event_id": "evt_01H...",
  "global_seq": 4812,
  "run_id": "run_01H...",
  "action_id": "act_01H...",
  "event_type": "policy.decided",
  "source": "policy-engine",
  "subject": "action/act_01H...",
  "occurred_at": "2026-03-30T09:20:14Z",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id": "00f067aa0ba902b7",
  "parent_event_id": "evt_01H...",
  "links": [
    {
      "kind": "caused_by",
      "event_id": "evt_01H..."
    }
  ],
  "visibility": "internal",
  "data": {
    "decision": "allow_with_snapshot",
    "reason_codes": ["FS_DESTRUCTIVE_WORKSPACE_MUTATION"]
  }
}
```

## Core event types

### Run lifecycle

- `run.started`
- `run.updated`
- `run.completed`
- `run.failed`
- `run.cancelled`

### Action lifecycle

- `action.normalized`
- `action.refined`
- `action.observed`

### Policy lifecycle

- `policy.decided`
- `policy.blocked`
- `policy.approval_requested`
- `policy.approval_resolved`

### Snapshot lifecycle

- `snapshot.created`
- `snapshot.failed`
- `snapshot.rebased`
- `snapshot.evicted`

### Execution lifecycle

- `execution.started`
- `execution.completed`
- `execution.failed`
- `execution.partial`
- `artifact.captured`

### Recovery lifecycle

- `recovery.planned`
- `recovery.started`
- `recovery.completed`
- `recovery.failed`

### Journal/system lifecycle

- `journal.compacted`
- `journal.checkpointed`
- `projection.rebuilt`
- `sync.exported`

## Immutability Rules

The journal should be append-only.

That means:

- existing events are never edited in place
- corrections are represented as later events
- annotations are represented as new events or separate append-only tables

Do not mutate old rows just to make current views easier.

Artifact storage failures should also stay truthful. If durable artifact capture fails
because local storage is unavailable, the runtime should surface a retryable
`STORAGE_UNAVAILABLE` error with low-disk details rather than flattening that into a
generic internal failure.

That same journal truth should also feed daemon diagnostics. Aggregate artifact
health, degraded evidence-capture counts, and low-disk-pressure signals should come
from stored event and artifact metadata, not a separate best-effort cache.

The same principle applies to approvals. If the daemon projects approval inbox items
or approval records from stored policy outcomes, it should preserve a structured
primary reason derived from the first stored policy reason so operators can see the
dominant gate cause without reparsing the full policy blob.

## Ordering Model

The journal needs more than timestamps.

Recommended ordering keys:

- `global_seq`
  - total order across the local journal
- `run_seq`
  - monotonic sequence within a run
- `action_seq`
  - optional monotonic sequence within an action lineage
- `occurred_at`
  - event time

Why:

- timestamps alone are not enough under concurrency
- global sequence supports replay
- run/action sequence supports scoped UI and restore views

## Causality Model

Use multiple causality hooks:

- `parent_event_id`
- `action_id`
- `run_id`
- `trace_id`
- `span_id`
- `links`

This lets us represent:

- one action causing many later artifacts
- approval decisions linked to paused execution
- observed events attached to a governed action later
- multi-action recovery operations

## Visibility Model

Every event should have a visibility level:

- `user_visible`
- `model_visible`
- `internal`
- `sensitive_internal`

This is important because:

- some artifacts should appear in the timeline
- some fields are needed for debugging but not for model context
- some data should stay internal due to security or privacy

## Data Placement

The journal should store small structured facts inline and reference heavy payloads externally.

### Inline

- IDs
- reason codes
- small summaries
- status values
- counters
- small structured outputs

### By reference

- stdout/stderr bodies
- screenshots
- diffs
- large structured payloads
- full HTTP payloads

This keeps the journal queryable without bloating local storage.

## Storage Layout

Use SQLite as the local journal database.

### Recommended tables

- `events`
  - append-only canonical ledger
- `artifacts`
  - metadata and blob refs
- `runs`
  - projection table
- `actions`
  - projection table
- `approvals`
  - projection table
- `snapshots`
  - projection table

### `events` columns

Recommended typed columns:

- `event_id`
- `global_seq`
- `run_id`
- `action_id`
- `event_type`
- `source`
- `subject`
- `occurred_at`
- `trace_id`
- `span_id`
- `parent_event_id`
- `visibility`
- `data_json`

### Query acceleration

Use:

- ordinary indexes on typed columns
- generated columns for common JSON fields
- selective indexing, not indexing every nested JSON path

## Why SQLite WAL Fits

The local authority daemon is naturally:

- a single main writer
- with one or more readers:
  - CLI
  - local UI
  - helper queries
  - background compactor

SQLite WAL is a strong fit for that shape.

### Required operational rules

- keep read transactions short
- checkpoint during idle windows or controlled moments
- monitor WAL growth explicitly
- avoid UI queries that pin readers indefinitely

This is not optional.
SQLite’s WAL docs are clear that long-lived readers can prevent checkpoints from completing and cause WAL files to grow without bound.

## Projection Model

The journal itself should be immutable.
Views should come from projections.

### Projection examples

- current run status
- current action status
- current approval state
- latest snapshot for action
- latest recovery state

### Projection rules

- projections may be rebuilt from the event log
- projection rebuild should be idempotent
- projection lag is acceptable if bounded and visible

This gives us speed without sacrificing history.

## Replay Model

Replay should read from the journal, not from ad-hoc logs.

### Replay needs

- total order
- causality links
- event summaries
- artifact references
- durable artifact metadata plus blob lookup by `artifact_id`
- artifact metadata should include explicit integrity attestation fields (`schema_version`, digest algorithm, digest) rather than a one-off hash field so the contract can evolve safely
- if artifact capture fails after an execution succeeded, the journal should still record the execution as completed but mark evidence capture as degraded rather than silently pretending no artifact was expected
- missing blob files should not erase artifact metadata; callers need to distinguish missing durable evidence from an unknown artifact id
- configured artifact retention should expire blobs without erasing their metadata, so callers can distinguish expired evidence from corrupted or missing storage
- unreadable or structurally invalid artifact storage should surface as corrupted evidence rather than being flattened into missing
- readable artifact bytes that fail the recorded digest should surface as tampered evidence rather than being flattened into corruption or missing storage
- snapshot boundaries
- policy outcomes

Launch-time operator health can aggregate directly from the journal:

- artifact availability counts by state
- degraded artifact-capture counts
- low-disk-pressure signals captured during evidence storage

### Replay unit

The default replay unit should be the action, not the raw event.

The timeline UI can expand an action into its underlying events when needed.

## Journal Compaction

Immutability does not mean infinite bloat.

### Keep immutable facts

- event rows
- IDs
- references
- summaries

### Compactable pieces

- projection tables
- redundant indexes
- artifact storage packs
- exported sync batches

### Journal-specific maintenance events

When compaction or rebuild occurs, emit journal events such as:

- `journal.compacted`
- `projection.rebuilt`
- `journal.checkpointed`

This keeps maintenance visible in history.

At launch, explicit daemon maintenance can already drive two real journal-adjacent
operations without a separate worker queue:

- artifact expiry against retained blobs
- SQLite WAL checkpointing for owned local stores

## Hosted Sync And Export

The internal envelope should be easy to export later.

### Export design goals

- deterministic ordering
- stable IDs
- resumable sync cursor
- minimal dependency on local rowids

This is where CloudEvents-like fields help a lot, even if the internal store is not a strict CloudEvents implementation.

## Failure Handling

The journal must record failures explicitly.

Examples:

- `execution.failed`
- `snapshot.failed`
- `journal.checkpointed` with warning metadata
- `projection.rebuilt` after corruption recovery

The journal should also be able to record:

- missing artifact refs
- integrity check failures
- partial writes recovered on restart

## Main Risks

### 1. Treating tracing as the source of truth

This will create gaps due to limits, sampling, and exporter behavior.

Mitigation:

- trace for correlation
- journal for durable truth

### 2. Turning SQLite JSON into an unindexable blob pile

Mitigation:

- typed columns for primary access paths
- generated columns for high-value JSON fields
- disciplined projection design

### 3. WAL growth due to long readers

Mitigation:

- short read transactions
- checkpoint policy
- reader gap design in UI/helper queries

### 4. Overeager inline storage

Mitigation:

- keep large artifacts external
- store only summaries inline

## Build Order

1. Define canonical event envelope and event-type registry
2. Implement SQLite schema in WAL mode
3. Implement append-only `events` table writes from the authority daemon
4. Add typed artifact metadata table
5. Add run/action/approval/snapshot projection tables
6. Add replay queries and projection rebuild flow
7. Add maintenance: checkpoints, vacuum/compaction policy, integrity checks
8. Add export cursor model for later hosted sync

## Concrete Recommendation

For v1, the run journal should optimize for one thing:

**be the durable product ledger that every explanation, replay, approval, and restore lookup can trust, without requiring us to scan raw logs or rely on lossy tracing systems**

That is the journal shape that will make the rest of the product feel coherent.

## Research Inputs

- OpenTelemetry Trace API: <https://opentelemetry.io/docs/specs/otel/trace/api/>
- OpenTelemetry Trace SDK: <https://opentelemetry.io/docs/specs/otel/trace/sdk/>
- CloudEvents spec repo / releases: <https://github.com/cloudevents/spec>
- SQLite WAL: <https://sqlite.org/wal.html>
- SQLite JSON functions: <https://sqlite.org/json1.html>
- SQLite JSONB: <https://sqlite.org/jsonb.html>
- SQLite generated columns: <https://sqlite.org/gencol.html>
- SQLite indexes on expressions: <https://sqlite.org/expridx.html>
- SQLite WITHOUT ROWID: <https://sqlite.org/withoutrowid.html>
- SQLite Session extension intro: <https://sqlite.org/sessionintro.html>
- SQLite session API: <https://sqlite.org/session.html>
- SQLite undo/redo demo: <https://sqlite.org/undoredo.html>
