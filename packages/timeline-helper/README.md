# @agentgit/timeline-helper

> **Internal package** — used by the agentgit daemon. Not published to npm.

Projects raw journal history into readable timeline steps and answers natural-language questions about what happened in a run. The "helper" surface gives operators a fast way to understand a run without reading raw database records.

---

## What It Does

The run journal stores raw, normalized records — actions, policy outcomes, execution results, approvals. The timeline helper turns those records into two human-facing surfaces:

### Timeline projection
An ordered list of steps describing what the agent did:

```
Step 1  filesystem.write  /workspace/src/index.ts  ✓ allowed_with_snapshot
Step 2  shell.execute     echo "hello"              ✓ allowed
Step 3  mcp.tool_call     notion/create_page        ⏳ waiting for approval
Step 4  filesystem.write  /workspace/README.md      ✓ allowed_with_snapshot
```

### Helper Q&A
Grounded answers to natural-language questions about the run:

- "What files did the agent write?"
- "Were any actions denied?"
- "What's pending approval right now?"
- "Did recovery succeed?"
- "What's the most likely cause of the failure in step 3?"

Answers are derived purely from journal records — no LLM is involved. The "helper" surface is deterministic and grounded in the durable history.

---

## Key Exports

```ts
import { TimelineProjector, HelperQuery } from "@agentgit/timeline-helper";

const projector = new TimelineProjector({ journal: myRunJournal });

// Project a full timeline for a run
const projection = await projector.project("run_abc");
// → {
//     run_id: "run_abc",
//     steps: [
//       { step: 1, action_id: "act_1", domain: "filesystem", summary: "Wrote src/index.ts", outcome: "allowed_with_snapshot", ... },
//       ...
//     ],
//     summary: { total_steps: 4, pending_approvals: 1, denied: 0, recovered: 0 },
//   }

// Answer a helper question
const helper = new HelperQuery({ journal: myRunJournal, projector });

const answer = await helper.ask("run_abc", "what files did the agent write?");
// → { answer: "The agent wrote 2 files: src/index.ts and README.md", facts: [...] }

const cause = await helper.likelyCause("run_abc");
// → { cause: "Step 3 is blocked on operator approval for notion/create_page", ... }

// Warm the helper fact cache (run at daemon startup for active runs)
await helper.warmFactCache("run_abc");

// Rebuild a stale projection (run during maintenance)
await projector.rebuild("run_abc");
```

---

## Projection Caching

Timeline projections are expensive to compute from scratch on large runs. The helper maintains a projection cache in the journal database (`projections` table). Projections are:

- Built lazily on first access
- Rebuilt when new events are appended to the run
- Forcibly rebuilt during inline maintenance or after daemon restart reconciliation

---

## Helper Facts

The helper pre-computes a set of "facts" for each run that power fast Q&A responses:

- Files written/read/deleted
- Shell commands executed
- MCP tools called and their outcomes
- Pending approvals and their age
- Denied actions and their reasons
- Recovery operations and their outcomes

Facts are stored in a lightweight cache and refreshed incrementally as new journal events arrive.

---

## Related Packages

- [`@agentgit/run-journal`](../run-journal/README.md) — source of all raw records
- [`@agentgit/schemas`](../schemas/README.md) — `TimelineStep`, `TimelineProjection` type definitions
- [`@agentgit/authority-cli`](../authority-cli/README.md) — `timeline`, `helper`, `run-summary` commands
- [`apps/inspector-ui`](../../apps/inspector-ui/README.md) — visual timeline and helper interface
