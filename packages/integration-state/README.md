# @agentgit/integration-state

> **Internal package** — used by the agentgit daemon. Not published to npm.

SQLite-backed state store for owned function integrations. Tracks the full lifecycle of objects that agents create and mutate through governed adapters — drafts, notes, tickets — so the recovery engine can plan precise compensating operations.

---

## What It Does

When an agent creates a note or opens a ticket through an owned-function adapter, agentgit needs to remember:

- The object's identity (ID, type, owner)
- Its **preimage** (state before any mutation) so it can be restored
- Every mutation applied (field changes, status transitions) so compensation plans are accurate
- Whether the object has been deleted/closed (for recovery eligibility checks)

`integration-state` is the durable source of truth for all of this. It is written to by execution adapters and read by the recovery engine when planning compensating operations.

---

## Supported Integration Types

| Type | Operations | Recovery |
|------|-----------|---------|
| `draft` | create | delete (compensation) |
| `note` | create | delete (compensation) |
| `ticket` | create, update, close, label, set-assignee | restore preimage fields, reopen, unlabel |

---

## Key Exports

```ts
import { IntegrationStateStore } from "@agentgit/integration-state";

const store = new IntegrationStateStore({ dbPath: "/path/to/journal.db" });

// Record creation (called by execution adapter after successful create)
await store.recordCreation({
  integration_id: "int_abc123",
  run_id: "run_xyz",
  action_id: "act_abc",
  type: "ticket",
  external_id: "TICKET-42",
  initial_state: { title: "Fix bug", status: "open", assignee: null },
});

// Record a mutation (field update, status change, etc.)
await store.recordMutation({
  integration_id: "int_abc123",
  mutation_type: "update_field",
  field: "assignee",
  preimage_value: null,
  postimage_value: "alice",
});

// Query for recovery planning
const state = await store.getIntegrationState("int_abc123");
// → { type, external_id, created_at, mutations[], preimage, current_state }

// Mark as compensated (after recovery execution)
await store.markCompensated("int_abc123", { reason: "operator recovery" });
```

---

## Recovery Integration

The recovery engine queries `IntegrationStateStore` to build compensation plans:

- For a newly created object: plan is `delete` (undo the creation entirely)
- For a mutated field: plan is `restore_field` using the recorded preimage value
- For a closed ticket: plan is `reopen` + restore fields to preimage

All preimage values are captured at mutation time, so recovery plans are accurate even after multiple mutations.

---

## Database Schema

Integration state is stored in the same SQLite database as the run journal (separate tables):

- `owned_integrations` — object identity, type, run/action linkage
- `integration_mutations` — ordered mutation log with preimage/postimage values
- `integration_compensation_log` — recovery execution records

---

## Related Packages

- [`@agentgit/execution-adapters`](../execution-adapters/README.md) — writes to this store after each owned-function operation
- [`@agentgit/recovery-engine`](../recovery-engine/README.md) — reads this store to build compensation plans
- [`@agentgit/run-journal`](../run-journal/README.md) — shares the SQLite database; integration state is part of the durable journal
