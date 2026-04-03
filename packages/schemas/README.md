# @agentgit/schemas

Schema pack and TypeScript contract helpers for the agentgit authority runtime.

The canonical record types used by the daemon, CLI, and SDKs — all in one package. Import these types when building integrations against the agentgit daemon API.

---

## Install

```bash
npm install @agentgit/schemas
```

## Compatibility

- Node.js `24.14.0+`
- schema pack `v1`
- daemon API `authority.v1`

---

## What's In Here

### Canonical record types

```ts
import type {
  Action,
  PolicyOutcome,
  SnapshotRecord,
  ExecutionResult,
  RunEvent,
  RecoveryPlan,
  TimelineStep,
  TimelineProjection,
  ApprovalRequest,
  RunSummary,
} from "@agentgit/schemas";
```

### Zod validators

Every type has a corresponding Zod schema for runtime validation:

```ts
import { ActionSchema, PolicyOutcomeSchema, RunEventSchema } from "@agentgit/schemas";

const action = ActionSchema.parse(rawInput);           // throws on invalid
const result = PolicyOutcomeSchema.safeParse(rawInput); // returns { success, data/error }
```

### Constants

```ts
import { API_VERSION, SCHEMA_PACK_VERSION } from "@agentgit/schemas";

console.log(API_VERSION);         // "authority.v1"
console.log(SCHEMA_PACK_VERSION); // "v1"
```

### Daemon method type map

```ts
import type { DaemonMethod, DaemonRequest, DaemonResponse } from "@agentgit/schemas";

// Type-safe method/payload pairs for the IPC protocol
type HelloRequest = DaemonRequest<"hello">;
type HelloResponse = DaemonResponse<"hello">;
```

---

## Record Types Quick Reference

| Type | Description |
|------|-------------|
| `Action` | Normalized governance unit — output of action-normalizer |
| `PolicyOutcome` | Result of policy evaluation (`allow`, `deny`, `ask`, `simulate`, `allow_with_snapshot`) |
| `SnapshotRecord` | Recovery boundary metadata |
| `ExecutionResult` | Adapter output, exit code, artifact references |
| `RunEvent` | Atomic causal journal entry tying action + policy + snapshot + result |
| `RecoveryPlan` | Restore/compensate/remediate plan with confidence and impact |
| `TimelineStep` | Human-readable projection of one action |
| `TimelineProjection` | Full ordered list of steps for a run |
| `ApprovalRequest` | Pending operator approval, linked to an action |
| `RunSummary` | High-level summary of a run's state |

---

## JSON Schema

The JSON Schema definitions for all record types live in [`engineering-docs/schema-pack/`](../../engineering-docs/schema-pack/). These are the canonical definitions — the TypeScript types in this package are generated from them.

---

## Related Packages

- [`@agentgit/authority-sdk`](../authority-sdk-ts/README.md) — TypeScript client SDK, uses these types
- [`@agentgit/authority-cli`](../authority-cli/README.md) — CLI, uses these types for `--json` output
- [`@agentgit/authority-daemon`](../authority-daemon/README.md) — daemon, validates all IPC payloads against these schemas
