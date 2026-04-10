# @agentgit/run-journal

The append-only SQLite-backed memory of the entire agentgit runtime. Every action, policy decision, snapshot, execution result, approval, and recovery event is written here as an atomic `RunEvent`. All other subsystems project from this canonical history — nothing is thrown away.

---

## What It Does

The run journal is the **single source of truth** for everything that happens in agentgit. When you ask "what did the agent do?" or "was this action approved?" or "did recovery succeed?", the answer comes from the journal.

Key properties:

- **Append-only**: records are never updated or deleted during normal operation
- **Causally linked**: each record references the action, run, and event that produced it
- **Tamper-detectable**: audit export bundles include integrity checks over journal records
- **Projection-friendly**: the timeline helper and recovery engine derive their views from raw journal records

---

## Schema Overview

~15 tables, all in one SQLite database:

| Table | What's in it |
|-------|-------------|
| `runs` | Run identity, display name, workspace roots, status |
| `actions` | Normalized action records (output of action-normalizer) |
| `policy_outcomes` | Policy evaluation results, linked to actions |
| `snapshots` | Recovery boundary metadata, linked to actions |
| `execution_results` | Adapter output and status, linked to actions |
| `artifacts` | Captured output bodies with visibility and truncation metadata |
| `approvals` | Operator approval requests, decisions, and reasons |
| `run_events` | Atomic causal log entries tying all of the above together |
| `owned_integrations` | Created draft/note/ticket object identity |
| `integration_mutations` | Field-level mutation log for owned objects |
| `mcp_servers` | Registered MCP server definitions |
| `mcp_secrets` | Encrypted MCP secret metadata (not plaintext) |
| `mcp_host_policies` | Public HTTPS host allowlist entries |
| `projections` | Cached timeline projections (rebuilt on demand) |
| `maintenance_log` | Startup reconciliation and inline maintenance records |

---

## Key Exports

```ts
import { RunJournal } from "@agentgit/run-journal";

const journal = new RunJournal({ dbPath: "/path/to/.agentgit/journal.db" });

// Open or create the database (runs migrations)
await journal.open();

// Write a run event (atomic — all linked records in one transaction)
const event = await journal.appendRunEvent({
  run_id: "run_abc",
  action_id: "act_xyz",
  policy_outcome_id: "po_123",
  snapshot_id: "snap_456",      // optional
  execution_result_id: "er_789",
  event_type: "action_completed",
});

// Query a run's full event history
const events = await journal.getRunEvents("run_abc");

// Get all pending approvals
const pending = await journal.getPendingApprovals({ run_id: "run_abc" });

// Record an approval decision
await journal.recordApprovalDecision({
  approval_id: "apr_111",
  decision: "approve",
  operator_reason: "looks correct",
  decided_at: new Date().toISOString(),
});

// Verify journal integrity (for audit export)
const check = await journal.verifyIntegrity("run_abc");
// → { valid: true, record_count: 42, hash: "sha256:..." }
```

---

## Startup Reconciliation

At daemon startup, the journal runs reconciliation to:

1. Find any runs that were `in_progress` when the daemon last stopped
2. Check whether their pending actions have recoverable state
3. Mark stale runs with an appropriate terminal status
4. Rebuild any stale timeline projections

This keeps the journal consistent even across unclean daemon shutdowns.

---

## WAL Checkpointing

The journal uses SQLite's WAL (Write-Ahead Log) mode for concurrent read access. The daemon runs a WAL checkpoint during inline maintenance to prevent unbounded WAL growth.

---

## Related Packages

- [`@agentgit/schemas`](../schemas/README.md) — canonical TypeScript types for all record shapes
- [`@agentgit/timeline-helper`](../timeline-helper/README.md) — projects journal records into readable timeline steps
- [`@agentgit/recovery-engine`](../recovery-engine/README.md) — reads snapshots and execution results to build recovery plans
- [`@agentgit/integration-state`](../integration-state/README.md) — owned-integration tables share this database
