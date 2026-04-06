# AgentGit — Comprehensive System Map

> **Local-first execution authority for autonomous agents.**
> A governance layer between agent runtimes and the operating system that intercepts, evaluates, and controls every action an AI agent attempts.

Generated from deep-dive analysis of all 20 packages in the monorepo.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Technology Stack](#technology-stack)
3. [8-Subsystem Pipeline Architecture](#8-subsystem-pipeline-architecture)
4. [End-to-End Action Flow](#end-to-end-action-flow)
5. [Package Dependency Graph](#package-dependency-graph)
6. [Per-Package Deep Dives](#per-package-deep-dives)
7. [Product Binaries](#product-binaries)
8. [Data Storage Layout](#data-storage-layout)
9. [Security Model](#security-model)
10. [Recovery & Durability](#recovery--durability)
11. [MCP Governance](#mcp-governance)
12. [Calibration System](#calibration-system)
13. [Inspector UI](#inspector-ui)
14. [Cross-Cutting Concerns](#cross-cutting-concerns)

---

## System Overview

AgentGit is a **local-first execution authority** — a governance layer that sits between AI agent runtimes (Claude Code, OpenClaw, custom agents) and the operating system. Every action an agent attempts — file writes, shell commands, MCP tool calls, function invocations — is intercepted, normalized, evaluated against policy, optionally snapshotted, executed in a controlled environment, and journaled for audit.

### Core Premise

Agents should not have unmediated access to the OS. AgentGit provides:

- **Policy enforcement**: Deterministic rules decide allow/deny/ask/simulate/snapshot for every action
- **Recovery boundaries**: Snapshots capture state before risky operations, enabling rollback
- **Audit trail**: Every action is journaled with cryptographic integrity (SHA256 content digests)
- **Credential isolation**: Secrets are encrypted at rest (AES-256-GCM) and brokered per-session
- **MCP supply-chain security**: OCI digest pinning, cosign signature verification, SLSA provenance

### Monorepo Structure

```
agentgit/
├── packages/           # 19 packages
│   ├── schemas/                    # Type system (single source of truth)
│   ├── action-normalizer/          # Pipeline stage 1: normalize raw actions
│   ├── policy-engine/              # Pipeline stage 2: evaluate policy
│   ├── snapshot-engine/            # Pipeline stage 3: capture recovery boundaries
│   ├── execution-adapters/         # Pipeline stage 4: execute in controlled env
│   ├── run-journal/                # Pipeline stage 5: audit logging
│   ├── recovery-engine/            # Pipeline stage 6: plan & execute rollbacks
│   ├── timeline-helper/            # Pipeline stage 7: event projection & queries
│   ├── authority-daemon/           # Central orchestrator (Unix socket server)
│   ├── authority-cli/              # CLI: `agentgit-authority` (100+ commands)
│   ├── authority-sdk-ts/           # TypeScript SDK client
│   ├── authority-sdk-py/           # Python SDK client (zero deps)
│   ├── credential-broker/          # Encrypted credential management
│   ├── mcp-registry/               # MCP server registry & governance
│   ├── integration-state/          # Generic SQLite document store
│   ├── workspace-index/            # File-level change tracking
│   ├── hosted-mcp-worker/          # Future: hosted MCP execution with attestation
│   ├── agent-runtime-integration/  # Product CLI: `agentgit`
│   └── test-fixtures/              # Shared test utilities
├── apps/
│   └── inspector-ui/               # Local web dashboard (port 4317)
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

---

## Technology Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Language | TypeScript | 6.0 |
| Runtime | Node.js | 24.14.0+ |
| Package Manager | pnpm | 10.33.0 |
| Build Orchestration | Turborepo | — |
| Bundler | esbuild | — |
| Test Framework | Vitest | 4.1 |
| Schema Validation | Zod | 4.3.6 |
| Database | better-sqlite3 (WAL mode) | — |
| Python SDK | Python | 3.11+ (zero external deps) |
| IPC Protocol | Unix domain socket, newline-delimited JSON | — |
| API Version | `authority.v1` | — |

---

## 8-Subsystem Pipeline Architecture

Every agent action flows through an 8-stage pipeline:

```
┌─────────────────────────────────────────────────────────────────────┐
│                     AUTHORITY DAEMON (orchestrator)                  │
│                                                                     │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────────────┐ │
│  │ Action   │──▶│ Policy   │──▶│ Snapshot │──▶│ Execution        │ │
│  │Normalizer│   │ Engine   │   │ Engine   │   │ Adapters         │ │
│  └──────────┘   └──────────┘   └──────────┘   └──────────────────┘ │
│       ▲                                              │              │
│       │                                              ▼              │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────────────┐ │
│  │ Timeline │◀──│ Recovery │◀──│ Run      │◀──│ Operator         │ │
│  │ Helper   │   │ Engine   │   │ Journal  │   │ Surfaces         │ │
│  └──────────┘   └──────────┘   └──────────┘   └──────────────────┘ │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Stage Responsibilities

| Stage | Package | Role |
|-------|---------|------|
| 1 | `action-normalizer` | Parse raw agent action into canonical form; classify domain, risk, confidence |
| 2 | `policy-engine` | Evaluate action against policy rules; produce outcome (allow/deny/ask/simulate/snapshot) |
| 3 | `snapshot-engine` | If needed, select snapshot class and capture recovery boundary before execution |
| 4 | `execution-adapters` | Execute the action in a controlled environment (filesystem containment, shell timeout, MCP container) |
| 5 | `run-journal` | Record the action, outcome, artifacts, and metadata in append-only SQLite log |
| 6 | `recovery-engine` | If rollback requested, plan and execute recovery from snapshots |
| 7 | `timeline-helper` | Project journal events into human-readable timeline; answer 19 deterministic query types |
| 8 | Operator Surfaces | CLI, SDK, Inspector UI — human-facing tools for oversight |

---

## End-to-End Action Flow

Here is the complete lifecycle of a single agent action:

### 1. Action Submission
An agent runtime (via SDK or direct socket) sends a `submit_action` request to the daemon containing the raw action attempt (e.g., `{ "type": "filesystem", "operation": "write", "path": "/foo/bar.txt", "content": "..." }`).

### 2. Normalization (action-normalizer)
The `normalizeActionAttempt()` function:
- Identifies the **domain**: `filesystem`, `shell`, `mcp`, or `function`
- Routes to the appropriate domain normalizer
- Computes a **multi-factor confidence score** (13+ factors)
- Classifies risk level and operation type
- Produces a `NormalizedAction` with canonical fields

**Confidence scoring** is central — it determines how the policy engine responds:
- Shell commands: `read_only` → 0.96, `write` → 0.68, `network` → 0.50, `destructive` → 0.38, `interpreter` → 0.29
- Each factor (path safety, command recognition, argument analysis, etc.) contributes to the composite score

### 3. Policy Evaluation (policy-engine)
The `evaluatePolicy()` function:
- Loads the active policy pack (default + user-defined rules)
- Evaluates all matching rules against the normalized action
- Applies **decision strength ordering**: `deny`(4) > `ask`(3) > `snapshot`(2) > `simulate`(1) > `allow`(0)
- The strongest applicable outcome wins

**Five possible outcomes:**

| Outcome | Meaning |
|---------|---------|
| `allow` | Execute immediately |
| `deny` | Block the action |
| `ask` | Pause; require human approval |
| `simulate` | Dry-run only (no side effects) |
| `allow_with_snapshot` | Execute, but capture snapshot first |

**Default thresholds:**
- `filesystem/*`: confidence < 0.3 → ask
- `shell/*`: confidence < 0.3 → ask
- `function/*`: confidence < 0.5 → ask

**Hardened default rules** (always active):
- `platform.secret-paths.deny`: Blocks access to `.env`, credentials, key files
- `platform.agent-config-mutation.deny`: Blocks agents from modifying their own governance config

### 4. Snapshot Capture (snapshot-engine)
If the outcome is `allow_with_snapshot`, the `selectSnapshotClass()` function runs a **14-phase decision tree** to pick the cheapest adequate snapshot class:

| Class | What It Captures | Cost |
|-------|-----------------|------|
| `metadata_only` | File metadata (mtime, size, mode) | Cheapest |
| `journal_only` | Journal chain reference | Low |
| `journal_plus_anchor` | Journal chain + file content anchor | Medium |
| `exact_anchor` | Full file content snapshot | Most expensive |

**Key thresholds:**
- Confidence < 0.45 → `exact_anchor`
- Journal chain depth ≥ 25 → `exact_anchor` (chain too long to replay)
- High confidence + short chain → `metadata_only` or `journal_only`

### 5. Execution (execution-adapters)
Four domain-specific adapters execute the action:

#### Filesystem Adapter
- **Workspace containment**: All paths resolved within workspace boundary
- Symlink traversal protection
- Atomic writes where possible

#### Shell Adapter
- **30-second timeout** (configurable)
- **64KB output capture** limit
- Process isolation

#### MCP Adapter
- **stdio MCP servers**: Run in OCI containers with `--cap-drop=ALL`
- **HTTP MCP servers**: Governed by host allowlists and credential brokering
- **Concurrency leases**: SQLite-backed lease store prevents overloading servers
- Container lifecycle management (pull, start, health check, execute, cleanup)

#### Function Adapter
- Handles drafts, notes, tickets, and other structured operations
- Each function type has a **compensation strategy** for rollback
- State tracked via `integration-state` SQLite store

### 6. Journaling (run-journal)
The `RunJournal` class writes to an **append-only SQLite database** (WAL mode):

**Tables:**
- `runs`: One row per agent session (run_id, runtime, start/end times)
- `run_events`: Immutable event log (action, outcome, timing, artifacts)
- `approval_requests`: Human approval requests and responses
- `artifacts`: Binary/text artifacts with SHA256 integrity

**Integrity guarantees:**
- SHA256 content digests on all artifacts
- 2-level directory sharding for artifact storage (`ab/cd/abcdef...`)
- Append-only: events cannot be modified or deleted
- WAL mode for crash-safe writes

### 7. Recovery (recovery-engine)
When rollback is requested, `planSnapshotRecovery()` creates a recovery plan:

**Four recovery classes** (with graceful degradation):

| Class | Strategy | Fallback |
|-------|----------|----------|
| `reversible` | Restore from snapshot | → compensatable |
| `compensatable` | Execute inverse operation | → review_only |
| `review_only` | Flag for manual review | — |
| `irreversible` | Document only | — |

The system always attempts the strongest recovery class available, falling back through the chain if needed.

### 8. Timeline Projection (timeline-helper)
The `answerHelperQuery()` function provides **19 deterministic query types** over journal data:

- Run summaries, action listings, approval history
- File change tracking, artifact retrieval
- Policy decision explanations
- All answers are **fully deterministic** (no LLM involved)
- **Content budgeting**: 160 chars/preview, 1,200 chars total per response

---

## Package Dependency Graph

```
                            ┌──────────┐
                            │ schemas  │  (depended on by ALL packages)
                            └────┬─────┘
                                 │
                 ┌───────────────┼───────────────────┐
                 │               │                   │
          ┌──────▼─────┐  ┌─────▼──────┐    ┌───────▼──────────┐
          │  action-   │  │  policy-   │    │  integration-    │
          │ normalizer │  │  engine    │    │  state           │
          └──────┬─────┘  └─────┬──────┘    └───────┬──────────┘
                 │              │                    │
          ┌──────▼─────┐       │              ┌─────▼──────────┐
          │ snapshot-  │       │              │ workspace-     │
          │ engine     │       │              │ index          │
          └──────┬─────┘       │              └───────┬────────┘
                 │              │                      │
          ┌──────▼──────────────▼──────────────────────▼───────┐
          │              execution-adapters                     │
          └──────────────────────┬──────────────────────────────┘
                                 │
                          ┌──────▼──────┐
                          │ run-journal │
                          └──────┬──────┘
                                 │
                 ┌───────────────┼───────────────┐
                 │               │               │
          ┌──────▼──────┐ ┌─────▼──────┐ ┌──────▼──────────┐
          │  recovery-  │ │ timeline-  │ │ credential-     │
          │  engine     │ │ helper     │ │ broker          │
          └─────────────┘ └────────────┘ └─────────────────┘
                                                 │
                                          ┌──────▼──────┐
                                          │ mcp-registry│
                                          └─────────────┘

     ┌───────────────────────────────────────────────────────────┐
     │              authority-daemon (orchestrates all above)     │
     └────────────┬─────────────────┬────────────────┬───────────┘
                  │                 │                │
           ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────────────┐
           │ authority-  │  │ authority-  │  │ agent-runtime-      │
           │ cli         │  │ sdk-ts      │  │ integration         │
           └─────────────┘  └─────────────┘  │ (product CLI)       │
                                             └──────────────────────┘
                            ┌──────────────┐
                            │ authority-   │  (standalone, same IPC)
                            │ sdk-py       │
                            └──────────────┘

     ┌──────────────┐      ┌──────────────┐
     │ inspector-ui │      │ hosted-mcp-  │  (future work)
     │ (app)        │      │ worker       │
     └──────────────┘      └──────────────┘

     ┌──────────────┐
     │ test-fixtures│  (dev dependency only)
     └──────────────┘
```

---

## Per-Package Deep Dives

### 1. `packages/schemas` — Type System (Single Source of Truth)

**File:** `src/index.ts` — **3,186 lines**

The foundational package. Every other package depends on it. Contains:

- **57 daemon methods** defined as Zod schemas for request/response
- **40+ record types** (actions, events, policies, snapshots, artifacts, etc.)
- **50+ enums** (action domains, operation types, outcomes, recovery classes, etc.)
- **API_VERSION**: `"authority.v1"` — stamped on every IPC envelope
- **Error classes**: Typed error hierarchy for all subsystems
- **Request/Response envelope types**: Standardized IPC message format

Key exports:
- All Zod schemas (runtime validation at system boundaries)
- TypeScript types (inferred from Zod for compile-time safety)
- Enum constants, error constructors, version strings

### 2. `packages/action-normalizer` — Pipeline Stage 1

**File:** `src/index.ts` — **~1,900 lines**

**Primary export:** `normalizeActionAttempt()`

Takes raw agent actions and produces canonical `NormalizedAction` objects with:
- Domain classification (`filesystem` | `shell` | `mcp` | `function`)
- Operation type (read, write, delete, execute, etc.)
- Multi-factor confidence score (0.0–1.0)
- Risk classification

**Four domain normalizers:**
1. **Filesystem**: Path analysis, operation mapping, sensitivity detection
2. **Shell**: Command parsing, argument analysis, pipe chain decomposition, risk classification
3. **MCP**: Tool name resolution, server validation, parameter analysis
4. **Function**: Draft/note/ticket type classification

**Confidence scoring** — 13+ contributing factors:
- Command recognition and classification
- Path safety analysis (workspace-relative vs absolute)
- Argument pattern matching
- Pipe chain complexity
- Known-safe command lists
- Interpreter detection (python, node, etc. → low confidence)

**Shell command risk tiers:**

| Classification | Base Confidence |
|---------------|----------------|
| `read_only` | 0.96 |
| `write` | 0.68 |
| `network` | 0.50 |
| `destructive` | 0.38 |
| `interpreter` | 0.29 |

### 3. `packages/policy-engine` — Pipeline Stage 2

**Files:**
- `src/index.ts` — **1,976 lines**
- `src/default-policy-pack.ts` — **172 lines**

**Primary export:** `evaluatePolicy()`

Deterministic policy evaluation engine. No LLM involvement — pure rule matching.

**Decision strength ordering:** `deny`(4) > `ask`(3) > `snapshot/allow_with_snapshot`(2) > `simulate`(1) > `allow`(0)

When multiple rules match, the **strongest outcome wins**.

**Default policy pack** contains two hardened rules:
1. **`platform.secret-paths.deny`**: Blocks access to `.env`, `.credentials`, key files, token stores
2. **`platform.agent-config-mutation.deny`**: Prevents agents from modifying their own governance configuration

**Default confidence thresholds:**
```
filesystem/*  → confidence < 0.3 → ask
shell/*       → confidence < 0.3 → ask
function/*    → confidence < 0.5 → ask
```

**Policy rule anatomy:**
- Matcher: domain, operation, path patterns, command patterns
- Outcome: one of the 5 outcomes
- Priority: numeric (higher = evaluated first)
- Conditions: confidence thresholds, time-of-day, cumulative limits

### 4. `packages/snapshot-engine` — Pipeline Stage 3

**File:** `src/index.ts` — **1,110 lines**

**Primary export:** `selectSnapshotClass()`

Runs a **14-phase decision tree** to select the cheapest adequate snapshot class:

**Snapshot classes (cheapest → most expensive):**
1. `metadata_only` — file mtime, size, mode only
2. `journal_only` — reference to journal chain
3. `journal_plus_anchor` — journal chain + file content anchor hash
4. `exact_anchor` — full file content capture

**Key decision thresholds:**
- Confidence < 0.45 → always `exact_anchor`
- Journal chain depth ≥ 25 → `exact_anchor` (too long to replay)
- First write to a file → `exact_anchor` (no prior state)
- High confidence + recent anchor → `metadata_only`
- Moderate confidence + short chain → `journal_only`

The 14-phase tree considers: confidence score, journal chain depth, file existence, prior snapshot availability, operation type, file size, and cumulative session risk.

### 5. `packages/execution-adapters` — Pipeline Stage 4

**File:** `src/index.ts` — **4,397 lines** (largest core subsystem)

Four domain-specific adapters:

#### Filesystem Adapter
- Resolves all paths within workspace boundary (containment)
- Symlink traversal protection
- Atomic write support
- Directory creation with recursive mkdir

#### Shell Adapter
- 30-second default timeout (configurable)
- 64KB stdout/stderr capture limit
- Process group management for cleanup
- Exit code capture and classification

#### MCP Adapter (most complex)
- **stdio servers**: OCI container execution with `--cap-drop=ALL`
- **HTTP servers**: Direct invocation with host allowlist enforcement
- **Concurrency leases**: SQLite-backed lease store
  - Configurable per-server concurrency limits
  - Lease acquisition with timeout
  - Automatic cleanup of expired leases
- Container lifecycle: image pull → create → start → health check → execute → capture output → cleanup
- Credential injection from credential broker

#### Function Adapter
- Handles drafts, notes, tickets, and structured data operations
- Each type has a registered **compensation strategy** for rollback
- State persisted in `integration-state` SQLite store
- CRUD operations with revision tracking

### 6. `packages/run-journal` — Pipeline Stage 5

**File:** `src/index.ts` — **2,933 lines**

**Append-only SQLite audit log** (WAL mode for crash safety).

**Database tables:**

| Table | Purpose | Mutability |
|-------|---------|-----------|
| `runs` | Agent session records | Insert + update end time |
| `run_events` | Action event log | **Insert only (immutable)** |
| `approval_requests` | Human approval tracking | Insert + update response |
| `artifacts` | Binary/text artifact storage | Insert only |

**Integrity guarantees:**
- **SHA256 content digests** on all artifacts
- **2-level directory sharding**: `ab/cd/abcdef...` for artifact file storage
- Events reference artifacts by digest, enabling deduplication
- WAL mode ensures crash-safe writes

**Policy calibration support:**
- Stores prediction/outcome pairs for Brier score calculation
- Enables the calibration loop (see [Calibration System](#calibration-system))
- ECE (Expected Calibration Error) computation

### 7. `packages/recovery-engine` — Pipeline Stage 6

**File:** `src/index.ts` — **839 lines**

**Primary exports:** `planSnapshotRecovery()`, `executeSnapshotRecovery()`

**Recovery class hierarchy** (with graceful degradation):

```
reversible → compensatable → review_only → irreversible
     │              │              │              │
  Snapshot       Inverse        Manual        Document
  restore       operation       review         only
```

The engine always attempts the strongest available class:
1. If snapshot exists → `reversible` (restore file from snapshot)
2. If compensation strategy registered → `compensatable` (run inverse op)
3. If human can review → `review_only` (flag for manual inspection)
4. Otherwise → `irreversible` (document what happened, no automated recovery)

**Compensation strategy registry**: Adapters register inverse operations (e.g., "file write" → "restore from backup", "ticket create" → "ticket delete").

### 8. `packages/timeline-helper` — Pipeline Stage 7

**File:** `src/index.ts` — **~2,368 lines**

**Primary export:** `answerHelperQuery()`

Projects raw journal events into human-readable timeline steps. **Three-phase pipeline:**

1. **Event loading**: Query journal for relevant events
2. **Projection**: Transform events into timeline steps with summaries
3. **Formatting**: Apply content budgets and output constraints

**19 deterministic query types** including:
- Run summaries and listings
- Action detail views
- Approval history
- File change tracking
- Artifact retrieval
- Policy decision explanations
- Error and failure analysis

**Content budgeting:**
- 160 characters per preview
- 1,200 characters total per response
- All answers are **fully deterministic** — no LLM involved

### 9. `packages/authority-daemon` — Central Orchestrator

**File:** `src/server.ts` — **6,970 lines**

The **heart of the system**. A Unix domain socket server that:

- Exposes **48 daemon methods** over newline-delimited JSON IPC
- Orchestrates all 8 pipeline subsystems
- Manages session lifecycle (create, attach, detach, destroy)
- Handles state rehydration on startup
- Implements crash recovery for interrupted actions
- Coordinates human approval workflows

**IPC protocol:**
```json
{
  "api_version": "authority.v1",
  "method": "submit_action",
  "params": { ... },
  "request_id": "uuid"
}
```

**Key daemon methods include:**
- `submit_action` — Main pipeline entry point
- `create_session` / `end_session` — Session management
- `approve_action` / `deny_action` — Human approval
- `get_run_timeline` — Timeline queries
- `restore_snapshot` — Recovery operations
- `register_mcp_server` — MCP management
- `get_policy` / `update_policy` — Policy CRUD
- `get_calibration_report` — Calibration metrics

### 10. `packages/authority-cli` — Authority CLI

**File:** `src/main.ts` — **366 lines** (router), commands spread across modules

**Binary:** `agentgit-authority`

**100+ commands** organized into command groups:

```
agentgit-authority
├── setup          # Initial configuration wizard
├── daemon
│   ├── start/stop/status/logs
│   └── health/pid
├── doctor         # System health checks
├── policy
│   ├── show/edit/validate/reset
│   ├── add-rule/remove-rule
│   └── calibration-report/recommend-thresholds/replay-thresholds
├── mcp
│   ├── register/unregister/list/inspect
│   ├── verify/pin/update
│   └── host-policy (add/remove/list)
├── runtime
│   ├── register/unregister/list
│   └── attach/detach
├── session
│   ├── create/end/list/inspect
│   └── approve/deny
├── audit
│   ├── timeline/events/artifacts
│   └── export/search
├── credential
│   ├── store/retrieve/delete/list
│   └── bind/unbind
├── snapshot
│   ├── list/inspect/restore
│   └── prune
└── workspace
    ├── index/status/diff
    └── ignore
```

**Exit codes:** 0–78 following BSD sysexits convention.

### 11. `packages/authority-sdk-ts` — TypeScript SDK

**File:** `src/index.ts` — **1,260 lines**

**Primary export:** `AuthorityClient` class

- **52 public methods** mirroring daemon capabilities
- Unix domain socket JSON-RPC transport
- Lazy session initialization (connects on first call)
- Configurable retries with exponential backoff
- Idempotency keys on mutating operations
- Connection pooling and keepalive

```typescript
const client = new AuthorityClient({ socketPath: '/tmp/agentgit.sock' });
const session = await client.createSession({ runtime: 'claude-code' });
const result = await client.submitAction(session.id, {
  type: 'filesystem',
  operation: 'write',
  path: 'src/index.ts',
  content: '...'
});
```

### 12. `packages/authority-sdk-py` — Python SDK

**File:** `agentgit_authority/client.py` — **~1,400 lines**

- **Zero external dependencies** (stdlib only)
- **70+ methods** mirroring the TypeScript SDK
- `snake_case` naming conventions (Pythonic API)
- Unix socket transport with `socket` module
- Session bootstrapping via `_ensure_session()`
- Async support via `asyncio`

```python
from agentgit_authority import AuthorityClient

client = AuthorityClient(socket_path='/tmp/agentgit.sock')
session = client.create_session(runtime='custom-agent')
result = client.submit_action(session.id, {
    'type': 'shell',
    'command': 'ls -la'
})
```

### 13. `packages/credential-broker` — Credential Management

**File:** `src/index.ts` — **903 lines**

Encrypted credential storage and session-scoped brokering:

**Encryption:** AES-256-GCM with OS-backed key storage:
- **macOS**: `MacOsKeychainSecretKeyProvider` — keys in Keychain
- **Linux**: `LinuxSecretServiceKeyProvider` — keys in Secret Service (D-Bus)

**Credential binding types:**

| Type | How Credentials Are Delivered |
|------|-------------------------------|
| `env` | Injected as environment variable |
| `file` | Written to temporary file, path provided |
| `header_template` | HTTP header with template substitution |
| `runtime_ticket` | One-time-use ticket exchanged at runtime |
| `tool_scoped_ref` | Bound to specific MCP tool invocations |

**Session-scoped bearer profiles** ensure credentials are:
- Only accessible during the active session
- Automatically revoked when session ends
- Never exposed to agent code directly (brokered through daemon)

### 14. `packages/mcp-registry` — MCP Server Registry

**File:** `src/index.ts` — main registry class

`McpServerRegistry` with **8 SQLite collections** managing:

- **Server registrations**: Name, transport type (stdio/http), configuration
- **OCI digest pinning**: Container images pinned to specific SHA256 digests
- **Cosign signature verification**: Cryptographic verification of image signatures
- **SLSA provenance**: Supply-chain attestation checking
- **Host allowlists**: `McpPublicHostPolicyRegistry` for HTTP endpoint governance
- **Container registry validation**: Verify images come from trusted registries
- **Network scope classification**: Categorize servers by network access requirements

### 15. `packages/integration-state` — Generic Document Store

**File:** `src/index.ts` — **310 lines**

Minimal SQLite document store used by execution-adapters for tracking drafts, notes, and tickets:

**API:**
- `put(collection, key, value)` — Upsert document
- `putIfAbsent(collection, key, value)` — Insert if not exists
- `get(collection, key)` — Retrieve document
- `list(collection, prefix?)` — List documents
- `delete(collection, key)` — Remove document

**Features:**
- WAL mode for durability
- Low-disk pressure detection (warns when disk is nearly full)
- JSON serialization for values
- Collection-based namespacing

### 16. `packages/workspace-index` — File Change Tracking

**File:** `src/index.ts` — **1,623 lines**

**Primary export:** `WorkspaceIndex` class

Tracks every file in the workspace for snapshot and recovery:

**Fast-path scanning**: Skip SHA256 hash computation if `mtime + size + mode` haven't changed (significant performance optimization).

**Layered snapshot chains**: Multiple snapshots share unchanged file references via anchor deduplication. Only changed files get new content captures.

**Conflict detection**: `baseline_revision` counter detects concurrent modifications to the same file.

### 17. `packages/hosted-mcp-worker` — Future Work

**File:** `src/index.ts` — **858 lines**

**Status: Prototype / future work**

Designed for hosted MCP execution with cryptographic attestation:

- **Ed25519 attestation**: Execution results signed with Ed25519 keys for verification
- **Network scope enforcement**: Restrict outbound network access
- **Protocol**: `hello`, `execute_hosted_mcp`, `cancel_execution` over Unix/TCP sockets
- Intent: Allow running MCP servers in isolated, attested environments

### 18. `packages/agent-runtime-integration` — Product CLI

**Binary:** `agentgit` (the main user-facing product)

**Components:**
- Service class — **2,400+ lines**: Core product logic, setup wizard, governed run orchestration
- Adapters — **1,500+ lines**: OpenClaw adapter, generic-command adapter for different agent runtimes
- State management — **1,000+ lines**: Session state, runtime registration, configuration
- Containment — **515 lines**: Docker containment with workspace projection
- Egress proxy — **150+ lines**: Network egress filtering for contained environments

**Key features:**
- **Setup wizard**: Interactive first-run configuration
- **Governed run**: `agentgit run <command>` — wraps any agent command with full governance
- **Docker containment**:
  - Workspace projection (mount workspace into container)
  - Egress proxy (filter outbound network traffic)
  - Credential injection (broker credentials into container env)
  - `--cap-drop=ALL` security baseline
- **Inspect**: View run history, timelines, artifacts
- **Restore**: Rollback to previous snapshots
- **Demo mode**: Guided demonstration of capabilities

### 19. `packages/test-fixtures` — Test Utilities

**File:** `src/index.ts` — **36 lines**

Single export: `createTempDirTracker()` — creates and tracks temporary directories for tests, ensuring cleanup after test completion.

Used by: `snapshot-engine`, `execution-adapters`, `mcp-registry` test suites.

### 20. `apps/inspector-ui` — Web Dashboard

**File:** `src/server.ts` — **1,733 lines**

Local web dashboard for monitoring agent activity:

- **Runs on port 4317** (local only, not exposed to network)
- **WebSocket streaming**: 2-second polling interval for real-time updates
- **SHA256 dedup**: Prevents duplicate event delivery over WebSocket
- **Dark warm design system**: Custom CSS, no frontend framework
- **Pure vanilla JS**: No React/Vue/Angular — minimal dependency footprint
- **Views**: Run list, run detail, action timeline, artifact viewer, policy inspector

---

## Product Binaries

AgentGit ships **three product binaries:**

| Binary | Package | Purpose |
|--------|---------|---------|
| `agentgit` | `agent-runtime-integration` | User-facing product CLI — setup, governed run, inspect, restore, demo |
| `agentgit-authority` | `authority-cli` | Low-level authority management — 100+ commands for daemon, policy, MCP, credentials |
| `agentgit-authorityd` | `authority-daemon` | Background daemon process — Unix socket server orchestrating all subsystems |

**Typical usage flow:**
```bash
# First-time setup
agentgit setup

# Run an agent with governance
agentgit run "claude-code --task 'refactor auth module'"

# Inspect what happened
agentgit inspect --run latest

# Rollback if needed
agentgit restore --snapshot <id>

# Advanced: manage policies
agentgit-authority policy show
agentgit-authority policy add-rule --domain shell --confidence-below 0.5 --outcome ask
```

---

## Data Storage Layout

All AgentGit data lives under `.agentgit/` in the workspace root:

```
.agentgit/
├── authority.sock              # Unix domain socket (IPC)
├── daemon.pid                  # Daemon PID file
├── config.json                 # Workspace configuration
├── policy.json                 # Active policy pack
│
├── journal/
│   ├── journal.db              # SQLite WAL — run_events, runs, approvals
│   ├── journal.db-wal          # WAL file
│   └── artifacts/
│       ├── ab/
│       │   └── cd/
│       │       └── abcdef...   # SHA256-addressed artifact storage
│       └── ...                 # 2-level directory sharding
│
├── snapshots/
│   ├── <snapshot-id>/
│   │   ├── manifest.json       # Snapshot metadata and file list
│   │   └── files/              # Captured file contents
│   └── ...
│
├── workspace-index/
│   └── index.db                # SQLite — file metadata, revision tracking
│
├── mcp-registry/
│   └── registry.db             # SQLite — server registrations, pins, policies
│
├── integration-state/
│   └── state.db                # SQLite — draft/note/ticket state
│
├── credentials/
│   └── vault.db                # SQLite — AES-256-GCM encrypted credentials
│
└── logs/
    └── daemon.log              # Daemon log output
```

---

## Security Model

### Defense in Depth

AgentGit implements multiple layers of security:

1. **Action-level governance**: Every action is normalized, classified, and evaluated against policy before execution
2. **Workspace containment**: Filesystem operations are confined to the workspace directory
3. **Shell isolation**: Timeouts, output capture limits, process group management
4. **MCP container security**: `--cap-drop=ALL`, OCI digest pinning, cosign verification
5. **Credential encryption**: AES-256-GCM with OS keychain-backed keys
6. **Network egress filtering**: Proxy-based outbound traffic control in contained environments
7. **Cryptographic audit trail**: SHA256 content digests, append-only journal

### Secret Path Protection

Hardened default rule blocks agent access to:
- `.env`, `.env.*` files
- `credentials.json`, `secrets.json`, `*.pem`, `*.key`
- `.aws/credentials`, `.ssh/*`, `.gnupg/*`
- Token stores, OAuth caches

### Agent Self-Modification Prevention

Agents cannot modify their own governance configuration:
- `.agentgit/policy.json` — protected
- `.agentgit/config.json` — protected
- Daemon socket and PID files — protected

---

## Recovery & Durability

### Snapshot-Based Recovery

The snapshot engine captures state before risky operations. If something goes wrong:

1. **Identify** the problematic action in the timeline
2. **Plan recovery** — the recovery engine selects the best strategy
3. **Execute recovery** — restore from snapshot, run compensation, or flag for review

### Crash Recovery

The daemon implements crash recovery for interrupted actions:
- On startup, rehydrates state from SQLite journal
- Detects incomplete actions (started but no outcome recorded)
- Can resume or rollback interrupted operations

### WAL Mode Durability

All SQLite databases use WAL (Write-Ahead Logging) mode:
- Crash-safe writes (no data loss on process crash)
- Concurrent read access during writes
- Automatic checkpointing

---

## MCP Governance

### Supply Chain Security

MCP servers are verified before execution:

1. **OCI Digest Pinning**: Container images pinned to exact SHA256 digests
2. **Cosign Verification**: Image signatures verified with cosign
3. **SLSA Provenance**: Supply-chain attestation checking
4. **Registry Validation**: Only images from trusted registries

### Runtime Governance

During execution:
- **stdio servers**: Run in containers with `--cap-drop=ALL`
- **HTTP servers**: Governed by host allowlists
- **Concurrency leases**: Prevent overloading servers
- **Credential brokering**: Secrets injected, never exposed directly

### Network Classification

MCP servers are classified by network scope:
- `local` — no network access needed
- `egress` — outbound access required (filtered by proxy)
- `ingress` — inbound access needed (rare, additional controls)

---

## Calibration System

AgentGit includes a **calibration loop** for tuning policy thresholds:

### The Calibration Pipeline

```
Journal Data → calibration-report → recommend-thresholds → replay-thresholds → manual edit
```

1. **`calibration-report`**: Analyzes journal prediction/outcome pairs, computes Brier score and ECE
2. **`recommend-thresholds`**: Suggests threshold adjustments based on calibration metrics
3. **`replay-thresholds`**: Simulates new thresholds against historical data to preview impact
4. **Manual edit**: Operator reviews and applies threshold changes

**Critical design principle**: The calibration system **never auto-mutates policy**. All changes require human review and explicit application.

### Calibration Metrics

- **Brier Score**: Measures prediction accuracy (lower = better)
- **ECE (Expected Calibration Error)**: Measures calibration quality
- **Confidence bands**: high (≥0.85), guarded (≥0.65), low (<0.65)

---

## Inspector UI

**Local web dashboard** at `http://localhost:4317`

### Architecture
- **Backend**: Node.js HTTP server + WebSocket server
- **Frontend**: Pure vanilla JS (no framework)
- **Design**: Dark warm color scheme, custom CSS
- **Real-time**: WebSocket streaming with 2s polling, SHA256 dedup

### Views
- **Run List**: All agent sessions with status, timing, action counts
- **Run Detail**: Full timeline of actions within a run
- **Action Detail**: Normalized action, policy decision, execution result, artifacts
- **Policy Inspector**: Current policy rules and thresholds
- **Artifact Viewer**: View captured artifacts (files, outputs)

---

## Cross-Cutting Concerns

### IPC Protocol
- **Transport**: Unix domain socket (fast, local-only, no TCP overhead)
- **Format**: Newline-delimited JSON envelopes
- **Version**: `authority.v1` stamped on every message
- **Pattern**: Request/response with `request_id` correlation
- **Methods**: 48 daemon methods covering full API surface

### Error Handling
- Typed error hierarchy defined in `schemas`
- BSD sysexits convention for CLI exit codes (0–78)
- Graceful degradation (recovery classes, fallback strategies)
- Crash recovery with journal-based state rehydration

### Testing Strategy
- **Vitest 4.1** test framework
- Shared `test-fixtures` package for temp directory management
- Integration tests against real SQLite databases
- Unit tests for pure functions (normalizer, policy engine, snapshot selection)

### Configuration
- Workspace-level config in `.agentgit/config.json`
- Policy rules in `.agentgit/policy.json`
- MCP server registrations in SQLite registry
- Credentials in encrypted SQLite vault
- All configuration is workspace-scoped (local-first)

---

*This document was generated from comprehensive deep-dive analysis of all 20 packages in the agentgit monorepo.*
