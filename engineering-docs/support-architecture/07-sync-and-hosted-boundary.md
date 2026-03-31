# 07. Sync And Hosted Boundary

## Working Thesis

The hosted control plane should be an optional coordination layer over selected local facts, not the place where the local-first system becomes “real.”

That means:

- local execution remains authoritative for local runs
- hosted sync receives selected records, not the entire local machine state by default
- the sync boundary should be explicit, minimal, and provenance-aware
- offline operation must remain first-class

The local product should still work completely on its own.

## Non-Negotiable Rule

Cloud support must layer on top of local canonical state.

It must not require:

- cloud-owned journal truth
- cloud-owned snapshots
- cloud-owned recovery state
- cloud round trips on the governed action path

## Why This Matters

If hosted sync is treated as the hidden source of truth:

- local-first becomes fake
- offline behavior gets brittle
- privacy expectations get muddled

If sync is too narrow:

- the paid coordination layer has weak value

So the right design is:

**local truth, selective sync, hosted coordination**

## Local Vs Hosted Roles

### Local authority

Owns:

- governed execution
- local snapshots
- local artifacts
- local journal truth for that machine/run
- local recovery execution
- canonical v1 storage

### Hosted control plane

Owns:

- team-visible history views
- shared approval inbox
- shared policy distribution
- cross-user coordination
- longer retention for selected synced records

That is the monetization layer without breaking the local-first promise.

## Syncable Data Classes

The system should classify data for sync.

## 1. Sync by default for hosted mode

Examples:

- run metadata
- normalized actions
- policy outcomes
- approval records
- recovery-plan metadata
- timeline-step projections

These records are high-value for coordination and usually compact enough to sync.

## 2. Sync optionally

Examples:

- selected artifacts
- structured output summaries
- changed-path summaries
- external object summaries

These are valuable, but may contain more sensitive or bulkier data.

## 3. Local by default

Examples:

- exact snapshot blobs
- large artifacts
- raw screenshots
- raw stdout/stderr for large runs
- local secret metadata beyond safe audit fields

These are either too heavy, too sensitive, or too machine-specific to sync by default.

## 4. Never sync in raw form

Examples:

- secrets
- raw tokens
- private keys
- full local secret broker state

This should be a hard rule.

## Sync Unit

The cleanest sync unit is:

- append-only exported records derived from local truth

That suggests syncing:

- immutable events
- or stable projections with source references

not mutable local database copies.

## Recommended Launch Sync Shape

For the first hosted layer, sync:

- run envelope metadata
- `Action`
- `PolicyOutcome`
- compact `RunEvent` exports
- `RecoveryPlan` metadata
- `TimelineStep`

Optional later:

- selected artifact previews
- approval discussion context
- helper summaries

This is intentionally a selective export model, not a “replace local storage with remote storage” model.

## Provenance Rules

Synced records must preserve provenance:

- `governed`
- `observed`
- `imported`
- `unknown`

The hosted layer must not flatten that away or team users will over-trust what they see.

## Sync Timing

The local-first system should support:

### Immediate best-effort sync

For:

- active team approvals
- current run visibility

### Deferred sync

For:

- background export of completed runs
- compact event batches
- artifact summaries

### Offline backlog

When offline:

- queue sync exports locally
- preserve order
- retry later

The local run remains valid and usable while unsynced.

## Identity And Idempotency

All synced records should carry stable IDs from the local system.

Examples:

- `run_id`
- `action_id`
- `policy_outcome_id`
- `event_id`
- `recovery_plan_id`
- `step_id`

Hosted ingest should be idempotent on these IDs.

This matters because append-only sync will naturally retry and replay.

## Conflict Model

The local and hosted layers should avoid two-way mutation of the same factual records.

### Good sync candidates

- append-only records
- projections that can be regenerated
- approvals that are separate records with stable IDs

### Risky sync candidates

- mutable local config rewritten by cloud
- opaque blob-level state
- local snapshot internals

### Launch recommendation

Prefer:

- local facts flowing upward
- shared policy and approval decisions flowing downward as new durable records

not arbitrary cross-editing of the same document.

## Hosted Approval Model

Hosted value gets real when approvals can be coordinated across people and devices.

Recommended model:

- local policy emits approval task
- approval task syncs to hosted inbox
- hosted approver decision syncs back as a new durable approval resolution record
- local authority consumes that record and continues execution

This preserves append-only truth on both sides.

## Shared Policy Distribution

Hosted policy should be distributable to local runtimes, but the boundary should stay explicit.

Recommended model:

- hosted publishes versioned shared policy bundles
- local runtime fetches and caches them
- local runtime records which bundle version was active for a decision

This keeps policy attribution clear in the journal and timeline.

## Artifact Strategy

Artifacts need a stricter boundary than metadata.

### Default rule

Sync summaries before syncing raw payloads.

Examples:

- sync “14 files changed” before syncing the full diff blob
- sync “browser action touched checkout.example.com” before syncing screenshots

### Optional paid upgrades later

- longer artifact retention
- selective screenshot upload
- shared run replays

But these should be explicit product choices, not silent defaults.

## Privacy And Data Minimization

The sync layer should assume:

- local runs may include proprietary code
- local artifacts may include secrets or PII
- team visibility is valuable, but not at the cost of surprise exfiltration

So the boundary should minimize:

- raw local content
- full snapshots
- unredacted request/response bodies

## Hosted Failure Modes

### Hosted unavailable

Local behavior:

- continue operating locally
- queue sync backlog

### Partial sync failure

Local behavior:

- preserve unsynced export state
- retry idempotently

### Policy fetch failure

Local behavior:

- use last known good hosted bundle if allowed
- otherwise degrade to local policy only

### Approval delivery lag

Local behavior:

- show approval as pending
- keep run paused safely

## Launch Recommendation

For launch, the sync and hosted boundary should be:

- optional
- append-only
- metadata-first
- provenance-preserving
- offline-tolerant

And for later cloud support, the design goal should be:

- seamless additive sync
- no re-platforming of local truth
- no rewrite of the governed action pipeline

That creates a clean path from local-first OSS adoption to hosted team coordination without rewriting the local product around the cloud.
