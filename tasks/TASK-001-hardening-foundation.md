# TASK-001: Harden Foundation Layer Before Next Subsystem

> Status note recorded on 2026-04-08: this task document is historical planning material. Several packages called out below are no longer empty scaffolds in the live tree, so treat this file as a backlog/reference artifact rather than an accurate implementation-status report.

## Context

You are working on **agentgit** — a local-first execution control system for autonomous coding agents. It is a TypeScript monorepo at `/Users/geoffreyfernald/Documents/agentgit` using pnpm workspaces + turborepo.

The core loop is working: SDK → daemon (Unix socket JSON-RPC) → normalize action → evaluate policy → journal event → return decision. But the implementation has gaps that must be closed before building the next layer (execution adapters, snapshot engine, recovery engine). This task closes those gaps.

## Monorepo Structure

```
packages/
  schemas/           → TypeScript types + constants (the shared protocol)
  action-normalizer/ → Canonicalizes raw tool calls into ActionRecord
  policy-engine/     → Evaluates ActionRecord → PolicyOutcomeRecord
  run-journal/       → SQLite append-only event ledger (WAL mode)
  authority-daemon/  → Unix socket server, orchestrates the above
  authority-sdk-ts/  → TypeScript client SDK
  authority-cli/     → CLI test harness
  authority-sdk-py/  → Python SDK (placeholder)
  execution-adapters/ → (empty scaffold)
  snapshot-engine/    → (empty scaffold)
  recovery-engine/    → (empty scaffold)
  timeline-helper/    → (empty scaffold)
  test-fixtures/      → (empty scaffold)
```

## Build and Run

```bash
pnpm install
pnpm build          # turbo-orchestrated tsc across all packages
pnpm typecheck      # strict type checking, no emit
pnpm daemon:start   # starts authority-daemon on Unix socket
pnpm cli ping       # test hello handshake
```

## What You Must Deliver

Complete ALL 6 tasks below IN ORDER. Each task builds on the previous. Do not skip ahead. After each task, verify `pnpm build` and `pnpm typecheck` still pass. After tasks 1-4, verify all tests pass.

---

### TASK 1: Add Zod Runtime Validation to Schemas Package

**Why:** The schemas package is types-only. Nothing validates incoming data at runtime. The daemon currently casts `unknown` to typed interfaces with `as` — if a client sends malformed data, it will silently produce garbage or throw cryptic errors deep in business logic. Every trust boundary needs runtime validation.

**What to do:**

1. Install `zod` as a dependency of `@agentgit/schemas`
2. For every major interface, create a corresponding Zod schema that validates incoming data. At minimum:
   - `RawActionAttemptSchema` — validates the `attempt` payload from `submit_action_attempt`
   - `HelloRequestPayloadSchema` — validates the `payload` from `hello`
   - `RegisterRunRequestPayloadSchema` — validates the `payload` from `register_run`
   - `GetRunSummaryRequestPayloadSchema` — validates the `payload` from `get_run_summary`
   - `RequestEnvelopeSchema` — validates the outer envelope (api_version, request_id, method, payload)
   - `ActionRecordSchema` — validates a complete ActionRecord (used to verify normalizer output)
   - `PolicyOutcomeRecordSchema` — validates a complete PolicyOutcomeRecord
3. Export both the Zod schemas and inferred types. The TypeScript interfaces should be DERIVED from the Zod schemas (`z.infer<typeof Schema>`) — not maintained separately. This means you will need to replace the existing hand-written interfaces with Zod-derived types. Keep the same type names as exports so downstream packages don't break.
4. Export a `validate<T>(schema: ZodSchema<T>, data: unknown): T` helper that throws a structured error on validation failure (include the Zod error path + message).
5. Keep `isResponseEnvelope()` as a lightweight guard for the SDK (it doesn't need full Zod validation).

**Validation rules to encode:**
- `api_version` must be exactly `"authority.v1"`
- `request_id` must be a non-empty string
- `method` must be one of the known DaemonMethod values
- `RawActionAttempt.tool_registration.tool_kind` must be one of: `"filesystem"`, `"shell"`, `"browser"`, `"mcp"`, `"function"`
- `RawActionAttempt.environment_context.workspace_roots` must be a non-empty array of strings
- `ActionRecord.schema_version` must be `"action.v1"`
- `ActionRecord.provenance.confidence` must be between 0 and 1
- `PolicyOutcomeRecord.decision` must be one of: `"allow"`, `"deny"`, `"ask"`, `"simulate"`, `"allow_with_snapshot"`
- All ISO timestamp fields should be validated as non-empty strings (don't parse dates, just ensure they're present)

**Files to modify:**
- `packages/schemas/package.json` — add zod dependency
- `packages/schemas/src/index.ts` — rewrite with Zod schemas, re-export same type names

**Verification:**
- `pnpm build` passes (all downstream packages still compile)
- `pnpm typecheck` passes
- Exported type names are identical to before (no downstream breakage)

---

### TASK 2: Integrate Validation Into the Daemon

**Why:** The daemon currently does `request as RequestEnvelope<HelloRequestPayload>` — an unsafe cast. With Zod schemas available, validate all incoming payloads at the request boundary.

**What to do:**

1. In `packages/authority-daemon/src/server.ts`, import the Zod schemas and `validate` helper from `@agentgit/schemas`
2. In `handleRequest()`, after JSON parsing and before the method switch:
   - Validate the outer envelope with `RequestEnvelopeSchema`
   - If validation fails, return a structured `VALIDATION_FAILED` error response with the Zod error details in `error.details`
3. In each handler function (`handleHello`, `handleRegisterRun`, `handleGetRunSummary`, `handleSubmitActionAttempt`):
   - Validate `request.payload` with the appropriate payload schema
   - If validation fails, return `VALIDATION_FAILED` with details
   - Remove the `as` type casts — the validated data IS the typed data now
4. In `handleSubmitActionAttempt`, after normalization:
   - Validate the ActionRecord output with `ActionRecordSchema` (defense in depth — verify the normalizer produced valid output)
   - If validation fails, return `INTERNAL_ERROR` (this means our own normalizer is buggy)

**Error response format for validation failures:**
```typescript
{
  code: "VALIDATION_FAILED",
  error_class: "validation_error",
  message: "Request payload validation failed.",
  details: {
    issues: [
      { path: "payload.workspace_roots", message: "Expected array, received undefined" }
    ]
  },
  retryable: false
}
```

**Files to modify:**
- `packages/authority-daemon/src/server.ts`

**Verification:**
- `pnpm build` passes
- Sending a malformed request to the daemon returns a clean `VALIDATION_FAILED` error (not a crash)

---

### TASK 3: Add State Rehydration on Daemon Startup

**Why:** `AuthorityState` stores sessions and runs in memory Maps. If the daemon restarts, all session/run state is lost, but the journal still has events for those runs. The daemon should reconstruct its in-memory state from the journal on startup.

**What to do:**

1. Add a `listAllRuns(): RunSummary[]` method to `RunJournal` that returns all runs in the database
2. Add a `rehydrateRun(run: RunSummary): RunRecord` method to `AuthorityState` that creates an in-memory RunRecord from a journal RunSummary (mark it as rehydrated so you can distinguish from fresh runs if needed later)
3. Add a `rehydrateSession(sessionId: string, workspaceRoots: string[]): SessionRecord` method to `AuthorityState` that creates a minimal session record from journal data (client_type and client_version will be "rehydrated" / "0.0.0" since the journal doesn't store those)
4. In `startServer()` in `server.ts`, after creating state and journal, call a rehydration function that:
   - Queries all runs from the journal
   - For each run, rehydrates the session (if not already present) and the run into AuthorityState
   - Logs how many sessions and runs were rehydrated
5. After rehydration, existing `getRunSummary` calls should work for runs created before the restart

**Files to modify:**
- `packages/run-journal/src/index.ts` — add `listAllRuns()`
- `packages/authority-daemon/src/state.ts` — add rehydration methods
- `packages/authority-daemon/src/server.ts` — call rehydration at startup

**Verification:**
- Start daemon, register a run, submit some actions, kill daemon
- Restart daemon, query `run-summary` for the old run_id — it should return the full summary

---

### TASK 4: Write Comprehensive Unit Tests

**Why:** Zero tests currently exist. The normalizer and policy engine are pure functions — perfect for unit testing. The journal is a self-contained SQLite store — perfect for integration testing. Tests are the safety net for everything that follows.

**What to do:**

1. Choose and install a test runner. Use **vitest** — it supports ESM natively, works with TypeScript, and integrates with turborepo. Install it as a root devDependency:
   ```
   pnpm add -Dw vitest
   ```
2. Add a `"test"` task to `turbo.json`:
   ```json
   "test": {
     "dependsOn": ["build"],
     "outputs": []
   }
   ```
3. Add `"test": "vitest run"` to the `scripts` of each package that will have tests.
4. Add `pnpm test` to root `package.json` scripts: `"test": "turbo run test"`

**Test files to create:**

#### `packages/action-normalizer/src/index.test.ts`

Test the `normalizeActionAttempt` function. Create a helper that builds valid `RawActionAttempt` objects with sensible defaults so tests are concise.

**Filesystem normalization tests:**
- `should normalize a simple file write to an ActionRecord with schema_version action.v1`
- `should resolve relative paths against cwd`
- `should resolve absolute paths as-is`
- `should set side_effect_level to "destructive" for delete operations`
- `should set side_effect_level to "mutating" for write operations`
- `should set confidence to 0.99 for paths inside workspace roots`
- `should set confidence lower for paths outside workspace roots`
- `should set sensitivity_hint to "moderate" for files over 256KB`
- `should set sensitivity_hint to "low" for files under 256KB`
- `should populate facets.filesystem with operation, paths, byte_length`
- `should set scope.breadth to "single" for single file operations`
- `should add "unknown_scope" warning when path is outside workspace`

**Shell normalization tests:**
- `should normalize a safe read-only command (ls) with read_only side_effect_level`
- `should normalize git status as read_only`
- `should normalize git diff as read_only`
- `should normalize rm as destructive with high confidence`
- `should normalize mv as mutating`
- `should normalize cp as mutating`
- `should normalize unknown commands with low confidence and warnings`
- `should parse command string into argv when argv is not provided`
- `should use argv array directly when provided`
- `should set batch to true for rm commands`
- `should populate facets.shell with argv, cwd, interpreter`

**Error handling tests:**
- `should throw for unsupported tool_kind`

#### `packages/policy-engine/src/index.test.ts`

Test the `evaluatePolicy` function. Create a helper that builds valid `ActionRecord` objects.

**Filesystem policy tests:**
- `should allow small governed writes (under 256KB)`
- `should require snapshot for large governed writes (over 256KB)`
- `should require snapshot for delete operations`
- `should deny paths outside workspace (scope unknown)`
- `should ask when normalization confidence is below 0.3`
- `should set snapshot_required = true when decision is allow_with_snapshot`
- `should set approval_required = true when decision is ask`
- `should include matched_rules in policy_context`
- `should include reason codes with correct severity levels`

**Shell policy tests:**
- `should allow known read-only commands (ls, pwd, cat, etc.)`
- `should allow git status and git diff`
- `should require snapshot for rm, mv, cp`
- `should ask for unclassified commands`
- `should ask when normalization confidence is below 0.3`

**Edge cases:**
- `should ask for unsupported domains (not filesystem or shell)`
- `should produce valid PolicyOutcomeRecord structure for all decisions`

#### `packages/run-journal/src/index.test.ts`

Test the `RunJournal` class. Use a temporary directory for each test's SQLite database.

**Lifecycle tests:**
- `should create database file on construction`
- `should register a run and create run.created + run.started events`
- `should return null for non-existent run_id`
- `should return correct RunSummary with event_count after registration`
- `should return correct latest_event after registration`

**Event append tests:**
- `should append events with auto-incrementing sequence numbers`
- `should maintain correct event_count after multiple appends`
- `should update latest_event after append`
- `should enforce unique (run_id, sequence) constraint`

**List all runs tests (new method from Task 3):**
- `should return empty array when no runs exist`
- `should return all registered runs`
- `should return correct metadata for each run`

**Close and reopen tests:**
- `should persist data across close and reopen (WAL durability)`

#### `packages/authority-daemon/src/state.test.ts`

Test `AuthorityState` in isolation.

- `should create sessions with unique prefixed IDs`
- `should retrieve sessions by ID`
- `should return null for unknown session IDs`
- `should create runs with unique prefixed IDs`
- `should convert runs to RunHandle correctly`

**Rehydration tests (from Task 3):**
- `should rehydrate a session from journal data`
- `should rehydrate a run from journal data`
- `should not create duplicate sessions on rehydration`

**Verification:**
- `pnpm test` passes with all tests green
- `pnpm build` still passes
- Test output shows test count and pass/fail per package

---

### TASK 5: Stub Execution Adapter and Snapshot Engine Interfaces

**Why:** When the daemon returns `allow` or `allow_with_snapshot`, nothing happens. The next subsystem layer needs clean integration seams. Define the interfaces now so the daemon can call them (as no-ops), and the actual implementations can be built later without refactoring the daemon.

**What to do:**

#### 5A: Execution Adapter Interface

Create `packages/execution-adapters/src/index.ts` with:

```typescript
import type { ActionRecord, PolicyOutcomeRecord } from "@agentgit/schemas";

/**
 * Result of executing an action through an adapter.
 */
export interface ExecutionResult {
  /** Unique ID for this execution attempt */
  execution_id: string;
  /** The action that was executed */
  action_id: string;
  /** Whether execution succeeded */
  success: boolean;
  /** Adapter-specific output (stdout, response body, etc.) */
  output: Record<string, unknown>;
  /** Artifacts captured during execution (diffs, screenshots, etc.) */
  artifacts: ExecutionArtifact[];
  /** Error details if execution failed */
  error?: {
    code: string;
    message: string;
    partial_effects: boolean;
  };
  /** Timestamps */
  started_at: string;
  completed_at: string;
}

export interface ExecutionArtifact {
  artifact_id: string;
  type: "diff" | "stdout" | "stderr" | "screenshot" | "request_response" | "file_content";
  content_ref: string;
  byte_size: number;
  visibility: "user" | "model" | "internal";
}

/**
 * Context provided to an adapter for execution.
 */
export interface ExecutionContext {
  action: ActionRecord;
  policy_outcome: PolicyOutcomeRecord;
  snapshot_record?: { snapshot_id: string } | null;
  workspace_root: string;
}

/**
 * Interface that all execution adapters must implement.
 */
export interface ExecutionAdapter {
  /** Which action domains this adapter handles */
  readonly supported_domains: string[];

  /**
   * Check whether this adapter can handle the given action.
   * Returns true if it can, false if another adapter should try.
   */
  canHandle(action: ActionRecord): boolean;

  /**
   * Verify preconditions before execution (snapshot exists, credentials available, etc.)
   * Throws if preconditions are not met.
   */
  verifyPreconditions(context: ExecutionContext): Promise<void>;

  /**
   * Execute the action and return the result.
   */
  execute(context: ExecutionContext): Promise<ExecutionResult>;
}

/**
 * Registry that selects the appropriate adapter for a given action.
 */
export class AdapterRegistry {
  private adapters: ExecutionAdapter[] = [];

  register(adapter: ExecutionAdapter): void {
    this.adapters.push(adapter);
  }

  findAdapter(action: ActionRecord): ExecutionAdapter | null {
    return this.adapters.find(a => a.canHandle(action)) ?? null;
  }
}

/**
 * No-op adapter that logs what it would do but doesn't execute.
 * Used as the default until real adapters are implemented.
 */
export class DryRunAdapter implements ExecutionAdapter {
  readonly supported_domains = ["filesystem", "shell", "browser", "mcp", "function"];

  canHandle(_action: ActionRecord): boolean {
    return true; // accepts everything as fallback
  }

  async verifyPreconditions(_context: ExecutionContext): Promise<void> {
    // No preconditions for dry run
  }

  async execute(context: ExecutionContext): Promise<ExecutionResult> {
    const now = new Date().toISOString();
    return {
      execution_id: `exec_dry_${Date.now()}`,
      action_id: context.action.action_id,
      success: true,
      output: {
        dry_run: true,
        would_execute: {
          domain: context.action.operation.domain,
          kind: context.action.operation.kind,
          target: context.action.target.primary.locator,
        },
      },
      artifacts: [],
      started_at: now,
      completed_at: now,
    };
  }
}
```

Set up the package properly:
- Create/update `packages/execution-adapters/package.json` with dependencies on `@agentgit/schemas`
- Create `packages/execution-adapters/tsconfig.json` extending the base
- Ensure it builds with `pnpm build`

#### 5B: Snapshot Engine Interface

Create `packages/snapshot-engine/src/index.ts` with:

```typescript
import type { ActionRecord } from "@agentgit/schemas";

export type SnapshotClass =
  | "metadata_only"
  | "journal_only"
  | "journal_plus_anchor"
  | "exact_anchor";

export type SnapshotFidelity =
  | "full"
  | "partial"
  | "metadata_only"
  | "none";

export interface SnapshotRecord {
  snapshot_id: string;
  action_id: string;
  snapshot_class: SnapshotClass;
  fidelity: SnapshotFidelity;
  /** Paths covered by this snapshot */
  scope_paths: string[];
  /** Size in bytes of the snapshot data */
  storage_bytes: number;
  created_at: string;
}

export interface SnapshotRequest {
  action: ActionRecord;
  /** Hint from policy about what class is needed */
  requested_class: SnapshotClass;
  /** Workspace root for path resolution */
  workspace_root: string;
}

/**
 * Interface for the snapshot engine.
 */
export interface SnapshotEngine {
  /**
   * Create a snapshot before an action executes.
   * Returns the snapshot record that can be used for recovery later.
   */
  createSnapshot(request: SnapshotRequest): Promise<SnapshotRecord>;

  /**
   * Verify a snapshot's integrity.
   * Returns true if the snapshot data is intact and restorable.
   */
  verifyIntegrity(snapshotId: string): Promise<boolean>;

  /**
   * Restore from a snapshot. Returns true if restore succeeded.
   */
  restore(snapshotId: string): Promise<boolean>;
}

/**
 * No-op snapshot engine that records metadata but doesn't capture actual state.
 * Used as the default until real snapshot logic is implemented.
 */
export class MetadataOnlySnapshotEngine implements SnapshotEngine {
  async createSnapshot(request: SnapshotRequest): Promise<SnapshotRecord> {
    const paths = request.action.target.primary.locator
      ? [request.action.target.primary.locator]
      : [];

    return {
      snapshot_id: `snap_meta_${Date.now()}`,
      action_id: request.action.action_id,
      snapshot_class: "metadata_only",
      fidelity: "metadata_only",
      scope_paths: paths,
      storage_bytes: 0,
      created_at: new Date().toISOString(),
    };
  }

  async verifyIntegrity(_snapshotId: string): Promise<boolean> {
    return true; // metadata-only snapshots are always "valid"
  }

  async restore(_snapshotId: string): Promise<boolean> {
    return false; // cannot restore from metadata-only
  }
}
```

Set up the package properly:
- Create/update `packages/snapshot-engine/package.json` with dependencies on `@agentgit/schemas`
- Create `packages/snapshot-engine/tsconfig.json` extending the base
- Ensure it builds with `pnpm build`

#### 5C: Wire Stubs Into the Daemon

Modify `packages/authority-daemon/src/server.ts`:

1. Import `AdapterRegistry`, `DryRunAdapter` from `@agentgit/execution-adapters`
2. Import `MetadataOnlySnapshotEngine` from `@agentgit/snapshot-engine`
3. In `startServer()`, create instances:
   ```typescript
   const adapterRegistry = new AdapterRegistry();
   adapterRegistry.register(new DryRunAdapter());
   const snapshotEngine = new MetadataOnlySnapshotEngine();
   ```
4. Pass them into `handleRequest` and down to `handleSubmitActionAttempt`
5. In `handleSubmitActionAttempt`, after policy evaluation:
   - If `policyOutcome.decision === "allow_with_snapshot"`, call `snapshotEngine.createSnapshot()` and journal the snapshot event
   - If `policyOutcome.decision === "allow" || policyOutcome.decision === "allow_with_snapshot"`:
     - Find an adapter via `adapterRegistry.findAdapter(action)`
     - If found, call `adapter.verifyPreconditions()` then `adapter.execute()`
     - Journal the execution result as an `execution.completed` or `execution.failed` event
     - Include the execution result in the response
   - If decision is `"deny"` or `"ask"`, do NOT execute (current behavior)
6. Update the `SubmitActionAttemptResponsePayload` type in schemas to optionally include:
   ```typescript
   execution_result?: ExecutionResult | null;
   snapshot_record?: SnapshotRecord | null;
   ```

**Files to modify:**
- `packages/execution-adapters/src/index.ts` — create
- `packages/execution-adapters/package.json` — create/update
- `packages/execution-adapters/tsconfig.json` — create
- `packages/snapshot-engine/src/index.ts` — create
- `packages/snapshot-engine/package.json` — create/update
- `packages/snapshot-engine/tsconfig.json` — create
- `packages/authority-daemon/package.json` — add new workspace deps
- `packages/authority-daemon/src/server.ts` — wire in stubs
- `packages/schemas/src/index.ts` — extend response payload type

**Verification:**
- `pnpm build` passes (all packages compile including new ones)
- Sending `submit-filesystem-write` to daemon now returns execution_result in response
- Sending a destructive command returns both snapshot_record and execution_result
- All existing tests still pass

---

### TASK 6: Add Structured Error Handling Across All Packages

**Why:** Currently, the normalizer throws raw `Error("Unsupported tool kind")`, the policy engine has no error handling, and the daemon catches some errors but not all. Every subsystem should use a consistent error representation.

**What to do:**

1. In `packages/schemas/src/index.ts`, add a base error class and domain-specific subclasses:

```typescript
export class AgentGitError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorEnvelope["code"],
    public readonly details?: Record<string, unknown>,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "AgentGitError";
  }

  toErrorEnvelope(): ErrorEnvelope {
    return {
      code: this.code,
      error_class: this.name,
      message: this.message,
      details: this.details,
      retryable: this.retryable,
    };
  }
}

export class ValidationError extends AgentGitError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "VALIDATION_FAILED", details, false);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends AgentGitError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "NOT_FOUND", details, false);
    this.name = "NotFoundError";
  }
}

export class PreconditionError extends AgentGitError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "PRECONDITION_FAILED", details, false);
    this.name = "PreconditionError";
  }
}

export class InternalError extends AgentGitError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "INTERNAL_ERROR", details, false);
    this.name = "InternalError";
  }
}
```

2. Update `packages/action-normalizer/src/index.ts`:
   - Import `ValidationError` from `@agentgit/schemas`
   - Replace `throw new Error("Unsupported tool kind: ...")` with `throw new ValidationError("Unsupported tool kind", { tool_kind })`
   - Add try/catch around normalization logic — if an unexpected error occurs, wrap it in `InternalError`

3. Update `packages/policy-engine/src/index.ts`:
   - Import `InternalError` from `@agentgit/schemas`
   - Wrap `evaluatePolicy` in a try/catch — if an unexpected error occurs during evaluation, return a `deny` outcome with reason code `POLICY_EVALUATION_ERROR` instead of throwing

4. Update `packages/authority-daemon/src/server.ts`:
   - In `handleRequest`, add a top-level try/catch around the entire handler
   - If the caught error is an `AgentGitError`, convert it to an error response using `toErrorEnvelope()`
   - If it's an unknown error, convert it to an `INTERNAL_ERROR` response (don't leak stack traces)
   - Remove any redundant inner try/catches that are now handled by the top-level catch

5. Update `packages/run-journal/src/index.ts`:
   - Wrap SQLite operations in try/catch
   - Throw `InternalError` for database errors (with the original error message but not the stack)
   - Throw `NotFoundError` when a run_id doesn't exist (in appendRunEvent)

**Files to modify:**
- `packages/schemas/src/index.ts` — add error classes
- `packages/action-normalizer/src/index.ts` — use structured errors
- `packages/policy-engine/src/index.ts` — defensive error handling
- `packages/run-journal/src/index.ts` — database error wrapping
- `packages/authority-daemon/src/server.ts` — top-level error boundary

**Verification:**
- `pnpm build` passes
- `pnpm test` passes (update tests if error types changed)
- Sending garbage to daemon returns structured error responses, never crashes
- The daemon process stays alive after any single request error

---

## Completion Criteria

All of the following must be true when you're done:

1. `pnpm install` succeeds
2. `pnpm build` compiles all packages with zero errors
3. `pnpm typecheck` passes with zero errors
4. `pnpm test` runs all test suites and all tests pass
5. Starting the daemon, registering a run, and submitting actions works end-to-end
6. Restarting the daemon preserves run state (rehydration works)
7. The `execution-adapters` and `snapshot-engine` packages compile and export their interfaces
8. Submitting an allowed action returns an `execution_result` in the response
9. Submitting a destructive action returns a `snapshot_record` in the response
10. Sending malformed JSON to the daemon returns a structured validation error
11. No `as` type casts remain in `server.ts` for request/payload types (replaced by Zod validation)

## Rules

- Do NOT create new documentation files (no README.md or .md files)
- Do NOT modify engineering-docs/ — those are the source of truth, not the code
- Do NOT install unnecessary dependencies — keep the dep tree minimal
- Do NOT change the Unix socket protocol (JSON-RPC over newline-delimited JSON)
- Do NOT change the monorepo structure (pnpm workspaces + turbo)
- Do NOT skip any task or reorder them
- After EVERY task, run `pnpm build` and `pnpm typecheck` to verify nothing is broken
- After tasks with tests, run `pnpm test` to verify all tests pass
- If a test fails, fix the code (not the test) unless the test expectation is wrong
- Use the existing code style: named exports, explicit return types, no default exports
- Prefer explicit over clever — no metaprogramming, no dynamic imports, no reflection
