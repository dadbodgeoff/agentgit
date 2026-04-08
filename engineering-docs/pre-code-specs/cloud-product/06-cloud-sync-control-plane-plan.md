# Cloud Sync Control Plane Plan

This document turns the local-first cloud scaffold into a production-oriented control plane design. It defines the first implementation batch now present in the repo and the next slices that should follow it.

## Purpose

AgentGit Cloud should not depend on direct filesystem access to the same machine as the governed workspace. The production shape is:

- a local connector near the real workspace, git checkout, credentials, and authority daemon
- a cloud control plane that owns workspaces, identity, policy, approvals, audit, and orchestration
- a durable sync protocol for repo state, run events, snapshot manifests, health, and command dispatch

## Source Of Truth

- Git provider state remains the source of truth for repository history and canonical branch state.
- Local workspace state remains the source of truth for uncommitted changes, snapshots, journals, credentials, and governed execution.
- Cloud state remains the source of truth for workspace membership, approvals, policy distribution, audit, and connector fleet health.

## First Batch In Repo

The first sync/control-plane batch now exists in code:

- `@agentgit/cloud-sync-protocol`
  Shared schemas for connector registration, repo state snapshots, heartbeats, event batches, and command envelopes.
- `@agentgit/control-plane-state`
  Durable connector, bootstrap token, heartbeat, event, and command storage.
- `@agentgit/cloud-connector`
  Local registration state, outbox storage, repo and journal event producers, command execution, and a bootstrap or sync CLI.
- `agentgit-cloud /api/v1/sync/*`
  Cloud routes for:
  - connector registration
  - bootstrap token issuance
  - connector heartbeat
  - event ingestion
  - pending command pull
  - command acknowledgement
  - workspace connector inventory
  - admin command queueing

## Contracts

### Registration

Cloud issues:

- connector id
- workspace binding
- short-lived connector access token

Registration records:

- connector capabilities
- machine identity
- connector version
- initial repository state snapshot

### Heartbeats

Connector heartbeats publish:

- repo branch and head SHA
- dirty state and ahead/behind counts
- workspace root reference
- local daemon reachability
- local journal and snapshot root paths

### Event Ingestion

Initial event families:

- `repo_state.snapshot`
- `run.lifecycle`
- `run.event`
- `snapshot.manifest`
- `approval.resolution`
- `policy.state`

All events are:

- connector-scoped
- workspace-scoped
- repo-scoped
- sequence-bearing
- schema-versioned
- idempotent by event id

### Commands

Initial operational command families:

- `refresh_repo_state`
- `sync_run_history`
- `execute_restore`
- `create_commit`
- `push_branch`
- `open_pull_request`

The first executable local write-back path is now live for:

- `create_commit`
- `push_branch`
- `open_pull_request`

Connector-backed recovery is now live for:

- `execute_restore`

The control plane now claims work with expiring execution leases so `acked` commands can be reclaimed if a connector stops mid-flight.

Operator-facing connector diagnostics are now live in the cloud UI, including:

- recent command history
- recent synced event history
- retryable command visibility
- leased command visibility
- connector revocation controls

The runtime activity layer is now live for:

- workspace activity feed
- audit log
- action detail

Live workspace refresh is now present through an authenticated server-sent events stream that invalidates query state for approvals, dashboard, calibration, activity, audit, and connector inventory when workspace runtime signatures change.

## Security Model

- Connector access is bearer-token based for the current batch.
- Tokens are hashed before storage in control-plane state.
- Registration is admin-gated through the authenticated cloud app or a short-lived admin-issued bootstrap token.
- Connector routes are workspace-scoped and reject mismatched connector ids or workspace ids.

## Next Slices

1. Provider-backed repo identity
   Reconcile local repo state with GitHub/Git provider metadata instead of treating local git alone as the cloud-facing repo contract.

2. Connector fleet health UI
   Expand the initial integrations-based operator surface into a fuller fleet-management view with revocation, health drift, longer history, and deeper event diagnostics.

3. Restore workflow expansion
   Extend the first queued restore execution path with richer recovery UX, command audit detail, and post-restore operator feedback.

4. Live update hardening
   Add stronger reconnect and backoff behavior, broader topic coverage, and a path to event-driven delivery beyond the current polling-backed SSE stream.

5. Provider-side governance expansion
   Extend hosted provider actions beyond PR creation into deeper metadata reconciliation and future provider-aware workflow automation.

## Non-Goals For This Batch

- full filesystem sync to cloud
- snapshot blob upload
- hosted execution replacing the local connector
- provider-side repository reconciliation beyond the first PR path
- automatic retry policy beyond reclaiming or manually retrying expired or failed leased work yet
