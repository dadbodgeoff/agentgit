# 11. Support Infrastructure Spec

## Scope

This document resolves runtime startup/shutdown, local storage, background jobs, platform capabilities, config, and sync support behavior.

## Runtime

- Startup:
  - load config
  - acquire lock
  - open stores
  - verify versions
  - detect capabilities
  - init broker
  - reconcile in-flight state
  - open IPC
  - start scheduler
- Graceful shutdown:
  - stop new actions
  - checkpoint state
  - mark interrupted work
  - close IPC
  - release lock
  - grace period: **10s**

## Local Storage

- Canonical durable roots remain local-first
- `.agentgit/authority.json` is a discoverability marker, not source of truth
- Blob sharding:
  - 2-char prefix, optional second 2-char level
- Migration failures fail closed

## Background Jobs

- Yield under load when:
  - active action queue > 0 and CPU > 70% or memory pressure high
- Retry:
  - exponential backoff with jitter
- Max retries:
  - critical: 10
  - maintenance: 5
  - ephemeral: 2

## Platform Capabilities

- Capability levels:
  - `strong`
  - `usable`
  - `degraded`
  - `unsupported`
- Invalidation:
  - restart
  - mount change
  - explicit refresh
  - major OS/env change

## Config Surface

- Durable format: TOML
- Launch sections:
  - `[runtime]`
  - `[storage]`
  - `[safe_modes]`
  - `[budgets]`
  - `[trust]`
  - `[approvals]`
  - `[snapshots]`
  - `[[rules]]`
- In-flight actions continue under prior config snapshot during reload

## Sync Boundary

- Compact RunEvent export uses append-only JSON batch format
- Local facts flow upward
- Hosted decisions flow downward as new records
- No cloud-owned journal/snapshot truth
