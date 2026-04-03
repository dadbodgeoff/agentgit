# Architecture Overview

agentgit is built around eight subsystems connected by an append-only SQLite journal. This page explains the overall design, how the subsystems relate, and why the architecture is built the way it is.

---

## The Core Thesis

> **Govern actions before execution. Preserve recovery boundaries during execution. Explain the outcome after execution.**

Every design decision in agentgit follows from these three goals:

- **Before execution**: normalize the intent, evaluate against policy, block or escalate if needed
- **During execution**: capture a rollback boundary for recoverable actions, inject credentials without exposing them to agent code, execute in a governed adapter
- **After execution**: journal the full causal history, pre-compute a recovery plan, project a readable timeline

---

## The Eight Subsystems

```
                    ┌─────────────────────────────────────────┐
                    │         AGENTGIT DAEMON                  │
                    │                                          │
 Agent SDK ─────────┤                                          │
 Python SDK ────────┤  ┌──────────────┐                       │
 CLI ───────────────┤  │  1. Action   │ normalize, validate,  │
                    │  │  Normalizer  │ risk-hint, workspace   │
                    │  └──────┬───────┘ scope check            │
                    │         │                                │
                    │  ┌──────▼───────┐                       │
                    │  │  2. Policy   │ allow / deny / ask /  │
                    │  │  Engine      │ simulate /             │
                    │  └──────┬───────┘ allow_with_snapshot    │
                    │         │                                │
                    │  ┌──────▼───────┐                       │
                    │  │  3. Snapshot │ capture rollback       │
                    │  │  Engine      │ boundary (if needed)   │
                    │  └──────┬───────┘                       │
                    │         │                                │
                    │  ┌──────▼───────┐                       │
                    │  │  4. Execution│ filesystem / shell /  │
                    │  │  Adapters    │ MCP proxy /            │
                    │  └──────┬───────┘ owned functions       │
                    │         │                                │
                    │  ┌──────▼───────┐                       │
                    │  │  5. Run      │ append-only SQLite    │
                    │  │  Journal     │ history spine          │
                    │  └──────┬───────┘                       │
                    │         │                                │
                    │  ┌──────▼───────┐                       │
                    │  │  6. Recovery │ pre-compute            │
                    │  │  Engine      │ restore/compensate     │
                    │  └──────┬───────┘                       │
                    │         │                                │
                    │  ┌──────▼───────┐                       │
                    │  │  7. Timeline │ project readable       │
                    │  │  + Helper    │ steps, answer Q&A      │
                    │  └──────┬───────┘                       │
                    │         │                                │
                    │  ┌──────▼───────┐                       │
                    │  │  8. Operator │ CLI / SDK / UI /       │
                    │  │  Surfaces    │ evidence workflows     │
                    │  └─────────────┘                        │
                    └─────────────────────────────────────────┘
```

---

## Subsystem Responsibilities

### 1. Action Normalizer
Converts raw agent action attempts into canonical `Action` records.

- Validates inputs and workspace path scope
- Records provenance (run ID, tool name, timestamp)
- Produces risk hints: side-effect level, recovery class, initial confidence estimate
- Output: a stable, schema-validated `Action` record

### 2. Policy Engine
Deterministic layered evaluation of normalized actions.

- Evaluates against trust rules, budgets, safe modes, approval gates
- Returns exactly one outcome: `allow`, `deny`, `ask`, `simulate`, `allow_with_snapshot`
- Reasons are explicit — no opaque ML scoring
- Supports policy calibration: recommend thresholds, replay against history, diff candidates

### 3. Snapshot Engine
Captures rollback boundaries before recoverable actions.

- Triggered only when policy outcome is `allow_with_snapshot`
- Chooses the cheapest snapshot class satisfying the recovery promise
- Deduplicates: reuses an existing anchor if the workspace hasn't changed
- Snapshot classes: `journal_anchor`, `manifest_snapshot`, `content_snapshot`

### 4. Execution Adapters
The only place where real side effects happen.

- `FilesystemAdapter` — file writes with workspace scope enforcement
- `ShellAdapter` — command execution with stdout/stderr artifact capture
- `McpProxyAdapter` — governed MCP tool calls with credential injection and sandboxing
- `OwnedFunctionAdapter` — drafts, notes, tickets with preimage recording for compensation

### 5. Run Journal
Append-only SQLite history — the single source of truth.

- Every action, policy outcome, snapshot, execution result, approval, and recovery event is written here
- Records are never updated or deleted during normal operation
- All other subsystems project from this canonical history
- ~15 tables: runs, actions, policy_outcomes, snapshots, execution_results, artifacts, approvals, run_events, integrations, ...

### 6. Recovery Engine
Plans and (optionally) executes recovery operations.

- `reversible`: restore files from snapshot manifest
- `compensatable`: execute inverse operation (delete created ticket, restore preimage field)
- `review_only`: describe outcome, no automatic action
- `irreversible`: document and prevent escalation
- Plans are computed at execution time; execution is a separate operator-approved step

### 7. Timeline Helper
Projects raw journal history into operator-facing surfaces.

- **Timeline**: ordered steps with summaries, outcomes, approval status
- **Helper Q&A**: grounded answers from journal records ("what files did the agent write?")
- Maintains a projection cache; rebuilt incrementally as new events arrive

### 8. Operator Surfaces
The interfaces through which humans interact with the system.

- **CLI** (`agentgit-authority`) — inspection, governance, policy calibration, audit
- **TypeScript SDK** (`@agentgit/authority-sdk`) — embed in TS/JS agents
- **Python SDK** (`agentgit-authority`) — embed in Python agents
- **Inspector UI** — local web interface for visual timeline inspection

---

## Supporting Subsystems

### Credential Broker
OS-backed secret storage for MCP credentials. Credentials live in macOS Keychain or Linux Secret Service — never in plain files or environment variables. Adapters request secrets by ID; plaintext is never exposed to agent code or serialized over IPC.

### MCP Registry
Durable state for operator-registered MCP servers: transport type, tool allowlists, network scope, authentication references, concurrency limits.

### Integration State
Tracks preimage values for owned-function objects (drafts, notes, tickets) so the recovery engine can plan precise compensation operations.

### Workspace Index
Persists path/hash manifests for workspace directories so the snapshot engine can detect changes efficiently without hashing every file on every action.

---

## Data Model

The canonical records that flow through the system:

| Record | Produced by | Consumed by |
|--------|------------|-------------|
| `Action` | Action Normalizer | Policy Engine, Journal |
| `PolicyOutcome` | Policy Engine | Snapshot Engine, Adapters, Journal |
| `SnapshotRecord` | Snapshot Engine | Journal, Recovery Engine |
| `ExecutionResult` | Execution Adapters | Journal, Recovery Engine |
| `RunEvent` | Journal | Timeline Helper |
| `RecoveryPlan` | Recovery Engine | Journal, Operator |
| `TimelineStep` | Timeline Helper | Operator Surfaces |

---

## Key Design Decisions

### Local-first
All state is local SQLite. The daemon never makes network calls on its own initiative — only execution adapters do, and only for explicitly registered MCP servers.

### Append-only journal
Records are never updated after being written. This makes the audit trail tamper-evident and enables projection rebuilding from scratch at any time.

### Fail closed on unsupported surfaces
Browser/computer control, generic HTTP, and arbitrary remote MCP registration return `PRECONDITION_FAILED`. The system never silently simulates unsupported surfaces.

### Inline maintenance, not a worker queue
Maintenance (WAL checkpoint, snapshot GC, projection refresh) runs inline during daemon operation and at startup reconciliation. No background worker queue is needed for the local-first scope.

### Deterministic policy, not ML scoring
Policy outcomes are deterministic given the same input and config. This makes them auditable, replayable, and operator-tunable.

### Compensation over rollback for owned integrations
For objects the agent creates (tickets, notes), recovery prefers inverse operations (delete, reopen) over snapshot restore. This is more precise and avoids restoring unrelated workspace state.

---

## Next Steps

- [Core Concepts](Core-Concepts.md) — deeper dive into actions, policy, snapshots, and recovery
- [Policy Engine](Policy-Engine.md) — how to write and tune policy
- [Recovery & Snapshots](Recovery-and-Snapshots.md) — recovery types and execution
