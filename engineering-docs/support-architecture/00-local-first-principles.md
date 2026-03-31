# 00. Local-First Principles

## Core Rule

The local runtime is the canonical source of truth for launch.

Cloud or hosted services are optional coordination layers that consume selected local facts and may send back shared approvals or policy bundles, but they do not make the local system “real.”

## Design Principles

### 1. Local truth first

The following must work without cloud dependency:

- governed execution
- journal writes
- snapshots
- artifacts
- recovery planning and execution
- timeline and helper queries
- local approvals

### 2. Cloud is derivative, not foundational

Hosted systems may:

- mirror selected records
- coordinate approvals
- distribute shared policy
- extend retention

But they should not be required for the action path to function.

### 3. No critical-path network dependency

No core governed action should require a cloud round trip in v1.

If the network is down:

- local runs still work
- local recovery still works
- local history remains authoritative
- sync backlog waits and retries later

### 4. Sync append-only facts, not mutable internals

The best cloud boundary is:

- append-only local facts going up
- append-only hosted decisions coming down

Not:

- remote mutation of local databases
- cloud ownership of snapshots
- cloud ownership of journal truth

### 5. Cloud support should feel like an additive layer

Going from local-only to hosted should feel like:

- turning on sync
- sharing approvals
- sharing policies
- sharing team visibility

not re-platforming the product.

## Architectural Consequence

When choosing between:

- a local canonical design that can later sync
- and a cloud-first design with local caching

choose the first one by default.

That will make the OSS launch stronger and make hosted support feel like a seamless extension rather than a rewrite.
