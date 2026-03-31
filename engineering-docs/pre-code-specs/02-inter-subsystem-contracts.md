# 02. Inter-Subsystem Contracts

## Scope

This document resolves the handoff contracts between the eight core subsystems.

## Wrapper -> Normalizer

- Wrapper sends a raw tool-call envelope containing:
  - `run_id`
  - `session_id`
  - `workspace_id` optional
  - `tool_registration`
  - `raw_call`
  - `environment_context`
  - `framework_context`
  - `trace`
  - `received_at`
- Wrapper is responsible for raw context.
- Normalizer is responsible for canonicalization, risk hints, warnings, and confidence.
- If wrapper cannot reach daemon:
  - governed actions fail closed
  - default timeout: **2 seconds**

## Normalizer -> Policy

- Policy receives full `Action` by value.
- Policy evaluation timeout:
  - soft target: **50ms**
  - hard timeout: **200ms**
- Low-confidence normalization is visible to policy and can trigger `ask`.

## Policy -> Snapshot

- Snapshot engine receives:
  - `action`
  - `policy_outcome`
  - capability summary
  - storage budget summary
  - lineage metadata
- Snapshot engine chooses final snapshot class.
- Fallback chain:
  - `exact_anchor` -> `journal_plus_anchor`
  - `journal_plus_anchor` -> `journal_only`
  - `journal_only` -> `metadata_only` only when policy permits review-only fallback

## Policy -> Execution

- Execution request includes:
  - `action`
  - `policy_outcome`
  - `snapshot_record` optional
  - `credential_handles`
  - `execution_context`
  - `capabilities`
- Adapters must enforce preconditions before side effects begin.

## Execution -> Journal

- Event submission is synchronous through the daemon-owned journal service.
- `execution.started` must be durably appended before the adapter is considered active.
- If journal fails after side effects:
  - runtime degrades
  - new governed actions stop
  - reconciliation required on restart

## Journal -> Recovery

- Recovery pulls from the journal via indexed queries:
  - run sequence ranges
  - entity-linked chains
  - changed-path indexes
  - artifact indexes

## Journal -> Timeline/Helper

- Timeline/helper consume projections, not raw event streams directly.
- Freshness targets:
  - active timeline: **< 1s**
  - helper fact cache: **< 3s**

## Recovery -> Execution

- Recovery-generated actions are flagged explicitly.
- Recovery actions go through full policy evaluation by default.
- Adapters receive recovery metadata in execution context but still return standard `ExecutionResult`.
