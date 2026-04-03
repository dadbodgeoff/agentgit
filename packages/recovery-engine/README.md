# @agentgit/recovery-engine

> **Internal package** — used by the agentgit daemon. Not published to npm.

Plans and executes recovery operations for agent actions. Produces restore, compensation, and remediation plans — with explicit confidence scores and impact previews — so operators know exactly what recovery will do before it runs.

---

## What It Does

Recovery is not one-size-fits-all. The recovery engine produces different plan types depending on what happened and what's recoverable:

| Recovery type | When used | What happens |
|--------------|-----------|-------------|
| `reversible` | Filesystem action with a snapshot boundary | Restore files from snapshot manifest |
| `compensatable` | Owned-function action (draft/note/ticket) | Execute inverse operation (delete, reopen, restore field) |
| `review_only` | Shell command or action without a recovery boundary | Describe outcome, surface impact, no automatic action |
| `irreversible` | Confirmed external side effect (e.g., email sent) | Document, prevent escalation, operator review only |

---

## Key Exports

```ts
import { RecoveryPlanner, executeRecovery } from "@agentgit/recovery-engine";

const planner = new RecoveryPlanner({
  journal: myRunJournal,
  snapshotEngine: mySnapshotEngine,
  integrationState: myIntegrationState,
});

// Plan recovery for an action (or a snapshot boundary)
const plan = await planner.plan("act_xyz");
// → {
//     plan_id: "rp_abc",
//     target_id: "act_xyz",
//     recovery_type: "reversible",
//     confidence: 0.92,
//     impact: { files_to_restore: 3, estimated_data_loss: "none" },
//     steps: [...],
//     expires_at: "2026-04-09T00:00:00Z",
//   }

// Execute a recovery plan (after operator review)
const result = await executeRecovery("rp_abc", { journal, snapshotEngine, integrationState });
// → { success: true, steps_completed: 3, restored_paths: [...] }

// Plan from a snapshot boundary directly
const snapPlan = await planner.planFromSnapshot("snap_123");
```

---

## Recovery Plan Anatomy

```ts
{
  plan_id: "rp_abc",
  target_id: "act_xyz",        // action or snapshot ID
  recovery_type: "reversible",
  confidence: 0.92,            // 0-1, how confident the engine is this will succeed
  impact: {
    files_to_restore: 3,
    estimated_data_loss: "none",
    affected_integrations: [],
    notes: "will overwrite any manual edits made after the action",
  },
  steps: [
    { step: 1, op: "restore_file", path: "/workspace/src/index.ts", source: "snap_123" },
    { step: 2, op: "restore_file", path: "/workspace/src/utils.ts", source: "snap_123" },
  ],
  created_at: "...",
  expires_at: "...",
}
```

---

## Compensation Plans

For owned-function integrations, recovery uses compensation operations rather than snapshot restore:

```ts
// Created a ticket → compensation plan is "close the ticket"
// Updated a field → compensation plan is "restore the preimage value"
// Closed a ticket → compensation plan is "reopen + restore fields"
```

Compensation data comes from the `integration-state` package, which records preimage values at mutation time.

---

## Safety

- Plans are always computed and surfaced to the operator before execution
- Execution is a separate call from planning — `plan_recovery` then `execute_recovery`
- Plans include explicit confidence scores; low-confidence plans require operator acknowledgment
- Plans expire after a configurable TTL — stale plans cannot be executed
- `review_only` and `irreversible` plans never attempt automatic changes

---

## Related Packages

- [`@agentgit/snapshot-engine`](../snapshot-engine/README.md) — provides snapshot data for reversible plans
- [`@agentgit/integration-state`](../integration-state/README.md) — provides preimage data for compensatable plans
- [`@agentgit/run-journal`](../run-journal/README.md) — recovery plans and execution results are persisted here
- [`@agentgit/schemas`](../schemas/README.md) — `RecoveryPlan` type definition
- [`@agentgit/authority-cli`](../authority-cli/README.md) — `plan-recovery`, `execute-recovery` commands
