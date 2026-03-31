# 06. Execution Adapters Spec

## Scope

This document resolves adapter contracts, per-adapter behavior, shell sessions, artifact capture, error taxonomy, and credential injection timing.

## Common Adapter Interface

- `canHandle(action): boolean`
- `prepare(context): PreparedExecution`
- `execute(prepared): ExecutionResult`
- `cleanup(context): void`

## Registration And Selection

- Explicit in-process registry at launch
- Selected by:
  - `action.operation.domain`
  - `execution_path.surface`
  - adapter priority

## Per-Adapter Notes

- Filesystem:
  - write, overwrite, move, delete, mkdir
  - symlink-following restricted by policy
- Shell:
  - ephemeral first
  - persistent optional
  - captures stdout/stderr/exit code/changed paths
- Apply-patch:
  - strict structured patch path
  - conflict -> failed
- Browser/computer:
  - ordered action batches
  - screenshot + DOM/a11y capture where available
- MCP proxy:
  - structured content passthrough
  - protocol-vs-tool error separation
- HTTP/API:
  - sanitized request/response capture
  - no naive unsafe retries

## Shell Sessions

- Ephemeral:
  - one action, isolated process tree
- Persistent:
  - named session
  - explicit session ID
  - idle timeout: **15 minutes**

## Artifact Taxonomy

- `stdout`
- `stderr`
- `file_diff`
- `request_summary`
- `response_summary`
- `screenshot`
- `dom_snapshot`
- `file_preimage_ref`
- `file_postimage_ref`
- `structured_output`
- `error_report`

## Artifact Budgets

- Filesystem: **10 MB**
- Shell: **2 MB stdout + 2 MB stderr** before truncation/reference
- Browser: **5 screenshots max, 25 MB total**
- HTTP/API: **256 KB** structured summary cap

## Errors

- Precondition:
  - missing snapshot
  - approval unresolved
  - credential mismatch
  - capability unavailable
- Execution:
  - timeout
  - nonzero exit
  - upstream failure
  - partial completion
- Adapter:
  - internal failure
  - transport failure
  - artifact capture failure

## Credential Injection

- Lazy per action by default
- Preferred injection order:
  - opaque handle
  - signed/derived token
  - scoped env injection
  - direct secret only when unavoidable and allowed
