# Current Implementation State

Status date: 2026-03-31

This document is the audited source of truth for what the repo actually implements today.

Historical planning and subsystem docs remain useful for intent and rationale, but this file is the cleanest statement of shipped runtime reality.

## Verification Basis

This audit is grounded in the current codebase and current green verification:

- `pnpm test`
- `pnpm py:test`

## What Is Real Today

### Local control plane

The repo has a real local authority runtime with:

- local IPC daemon
- TypeScript SDK
- Python SDK
- operator CLI
- local inspector UI
- schema-backed request/response contracts

Core runtime entrypoints are real in:

- `/Users/geoffreyfernald/Documents/agentgit/packages/authority-daemon/src/server.ts`
- `/Users/geoffreyfernald/Documents/agentgit/packages/authority-sdk-ts/src/index.ts`
- `/Users/geoffreyfernald/Documents/agentgit/packages/authority-sdk-py/agentgit_authority/client.py`
- `/Users/geoffreyfernald/Documents/agentgit/packages/authority-cli/src/main.ts`
- `/Users/geoffreyfernald/Documents/agentgit/apps/inspector-ui/src/server.ts`

### Durable runtime spine

The repo has real durable local state, not an in-memory demo:

- SQLite-backed run journal
- durable artifact storage and artifact integrity state
- SQLite-backed owned integration state
- SQLite-backed MCP registry state
- SQLite-backed MCP public host policy state
- durable local encrypted MCP secret state with rotation metadata
- persisted workspace snapshot metadata
- daemon restart reconciliation
- request idempotency for mutating daemon methods

Primary files:

- `/Users/geoffreyfernald/Documents/agentgit/packages/run-journal/src/index.ts`
- `/Users/geoffreyfernald/Documents/agentgit/packages/integration-state/src/index.ts`
- `/Users/geoffreyfernald/Documents/agentgit/packages/workspace-index/src/index.ts`
- `/Users/geoffreyfernald/Documents/agentgit/packages/snapshot-engine/src/index.ts`

### Governed action pipeline

The launch-owned governed pipeline is real for these execution domains:

- `filesystem`
- `shell`
- `mcp`
- owned `function` integrations

The real execution adapters live in:

- `/Users/geoffreyfernald/Documents/agentgit/packages/execution-adapters/src/index.ts`

### Owned integrations that are real

The owned integration surface is materially real and end-to-end tested for:

- drafts
- notes
- tickets

That includes:

- create/update/archive/unarchive/delete/restore flows where implemented
- membership-style mutations like labels and assignees
- brokered credential handling for tickets
- compensating recovery or preimage restore where supported

### Recovery and inspection

The repo has real recovery planning and execution for:

- snapshot boundary recovery
- action boundary recovery
- external object recovery targets
- run checkpoint recovery targets
- branch point recovery targets
- path subset recovery targets

It also has real operator-facing:

- timeline projection
- helper queries
- structured downgrade reasons
- artifact fetch by durable reference
- diagnostics
- maintenance execution

### Inline maintenance that is real

The launch-owned inline maintenance jobs are real today:

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

## Production-Real Scope We Can Honestly Claim

If we describe the repo conservatively and truthfully, the following surface is ready to describe as real:

- local-first daemon-based governance
- governed filesystem mutations
- governed shell mutations
- governed MCP proxy execution for operator-managed servers and configured tools over `stdio` and `streamable_http` with explicit `loopback`, `private`, or `public_https` network scope
- daemon/CLI/SDK management of MCP servers, MCP bearer secrets, and MCP public host policies
- first-class CLI submission of governed MCP tool calls through the daemon
- owned function integrations for drafts, notes, and tickets
- snapshot-backed local recovery
- compensating recovery for owned integrations
- journaled approvals, diagnostics, helper, and timeline views
- inline maintenance and startup reconciliation
- TypeScript/Python SDK access to the daemon, including MCP server/secret/host-policy management

## Explicitly Unsupported Or De-Scoped Launch Surfaces

The repo now fails closed instead of pretending these surfaces are live:

### Browser/computer governance

Governed browser/computer execution is not part of the supported launch/runtime surface.

What is true today:

- browser/computer requests fail closed with a structured `PRECONDITION_FAILED` error
- there is no governed browser adapter in `/Users/geoffreyfernald/Documents/agentgit/packages/execution-adapters/src/index.ts`
- launch/runtime docs and runtime-facing schema no longer describe governed browser execution as shipped

### Generic governed HTTP adapter

There is a real brokered tickets integration, but there is no reusable generic governed HTTP/API adapter in the launch/runtime surface.

What is true today:

- owned ticket mutations are real and brokered
- generic governed HTTP remains explicitly out of launch scope until a real adapter exists
- launch/runtime docs no longer describe a generic HTTP adapter as runtime-real

### Durable queued worker architecture

The runtime executes maintenance inline and at startup reconciliation boundaries. It does not claim a durable queued worker.

What is true today:

- `run_maintenance` executes the launch-owned jobs inline
- diagnostics/reporting describe inline maintenance truthfully
- worker-specific launch claims have been removed from runtime-facing surfaces

## Clean Launch Scope Recommendation

If the goal is a strict day-one production claim, define the supported surface as:

- local IPC daemon
- TS/Python SDKs
- CLI and inspector UI
- filesystem governance
- shell governance
- governed MCP proxy execution for operator-managed servers and configured tools over `stdio` and `streamable_http` with explicit `loopback`, `private`, or `public_https` network scope
- first-class CLI invocation of governed MCP tools once operators have registered the server/secret/policy surface
- owned draft/note/ticket integrations
- snapshot-backed and compensating recovery
- timeline/helper/diagnostics/maintenance

And explicitly exclude from the production claim until built:

- governed browser/computer execution
- generic governed HTTP adapter
- hosted MCP execution
- arbitrary remote MCP server registration from agent or user input
- durable queued worker architecture

## Supporting Reality Checks

- there is no live simulated execution fallback in the daemon path
- unsupported non-MCP governed surfaces fail closed with structured errors
- `/Users/geoffreyfernald/Documents/agentgit/packages/test-fixtures` is now a real reusable internal fixture package used by live tests

## Bottom Line

The repo is no longer a scaffold. It is a substantial, working local-first authority runtime.

For the current launch scope, the code and docs now line up cleanly:

- supported governed execution is real for filesystem, shell, owned function integrations, and operator-managed MCP tools over `stdio` and `streamable_http`
- unsupported governed surfaces fail closed instead of simulating
- browser/computer, generic HTTP, hosted MCP, arbitrary remote agent/user registration, and durable workers are excluded from launch truth until they are actually built

The current MCP claim is still intentionally controlled: operator-owned durable registry state, durable local encrypted bearer-secret storage with rotation metadata, daemon/CLI/SDK management of servers/secrets/public-host policies, `tools/list`, `tools/call`, direct-credential denial, approval-first mutation policy, and per-server concurrency limits are real today. `streamable_http` is supported for explicit operator-managed `loopback`, `private`, and `public_https` targets alongside `stdio`, with public HTTPS requiring `https`, an explicit host allowlist policy, and governed bearer auth via either durable `bearer_secret_ref` or legacy `bearer_env`, with secret refs now the production path and env auth remaining a degraded compatibility path. Hosted MCP execution and arbitrary remote registration from agent or user input remain future work.
