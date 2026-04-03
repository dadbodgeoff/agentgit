# TypeScript SDK

`@agentgit/authority-sdk` is the TypeScript client for the local agentgit authority daemon. Embed it in your agent to submit governed actions, inspect timelines, manage approvals, and trigger recovery.

---

## Install

```bash
npm install @agentgit/authority-sdk @agentgit/schemas
```

**Prerequisite:** The agentgit daemon must be running (`agentgit-authority daemon start`).

---

## Connecting

```ts
import { AuthorityClient } from "@agentgit/authority-sdk";

// Auto-discovers socket from AGENTGIT_ROOT env var or cwd
// Resolves to: <root>/.agentgit/authority.sock
const client = new AuthorityClient();

// Or specify explicitly
const client = new AuthorityClient({
  socketPath: "/absolute/path/to/.agentgit/authority.sock",
  connectTimeoutMs: 1000,       // default
  responseTimeoutMs: 5000,      // default
  maxConnectRetries: 1,         // default
  connectRetryDelayMs: 50,      // default
  clientType: "sdk_ts",         // default
});

// Verify connection and open a session
const hello = await client.hello(["/path/to/workspace"]);
console.log(hello.accepted_api_version); // "authority.v1"
```

---

## Run Lifecycle

```ts
// Register a run with optional budget limits
const run = await client.registerRun({
  workflow_name: "my-agent-session",
  workspace_roots: ["/absolute/path/to/workspace"],
  // Optional budget limits:
  // budget_config: { max_mutating_actions: 100, max_destructive_actions: 10 }
});
const runId = run.run_id;

// Get capabilities for a workspace
const caps = await client.getCapabilities("/path/to/workspace");

// Get a summary
const summary = await client.getRunSummary(runId);
```

---

## Submitting Actions

### General submission (covers all domains)

```ts
const result = await client.submitActionAttempt({
  run_id: runId,
  tool_name: "write_file",
  execution_domain: "filesystem",  // filesystem | shell | mcp | function
  raw_inputs: {
    path: "/workspace/src/index.ts",
    content: "export const x = 1;",
  },
  workspace_roots: ["/workspace"],
});
```

### Handling the policy outcome

```ts
const result = await client.submitActionAttempt(attempt);

// result.policy_outcome is one of:
// "allow" | "allow_with_snapshot" | "simulate" | "ask" | "deny"

if (result.policy_outcome === "ask") {
  // Blocked — approval required
  console.log("Approval needed:", result.approval_id);
} else if (result.policy_outcome === "deny") {
  // Rejected by policy
  console.log("Denied");
} else {
  // Executed (allow or allow_with_snapshot)
  console.log("Artifact:", result.execution_result?.artifact_id);
}
```

---

## Approvals

```ts
// List pending approvals (filters: run_id, status, limit)
const approvals = await client.listApprovals({ run_id: runId, status: "pending" });

// Paginated inbox
const inbox = await client.queryApprovalInbox({ run_id: runId, status: "pending" });

// Approve — decision is "approve" or "deny" (not "reject")
await client.resolveApproval(approvals[0].approval_id, "approve", "reviewed, looks safe");
await client.resolveApproval(approvals[0].approval_id, "deny", "outside expected scope");
```

---

## Inspection

### Timeline

```ts
// Visibility: "user" | "model" | "internal" | "sensitive_internal"
const timeline = await client.queryTimeline(runId, "internal");
for (const step of timeline.steps) {
  console.log(`Step ${step.step_number}: ${step.summary} [${step.outcome}]`);
}
```

### Helper Q&A

The helper answers structured questions derived purely from journal records. Pass a `HelperQuestionType` enum value — not a free-form string.

```ts
// Question types:
// "run_summary" | "what_happened" | "summarize_after_boundary"
// "step_details" | "explain_policy_decision" | "reversible_steps"
// "why_blocked" | "likely_cause" | "suggest_likely_cause"
// "what_changed_after_step" | "revert_impact" | "preview_revert_loss"
// "what_would_i_lose_if_i_revert_here" | "external_side_effects"
// "identify_external_effects" | "list_actions_touching_scope" | "compare_steps"

const answer = await client.queryHelper(runId, "what_happened");
const cause = await client.queryHelper(runId, "likely_cause");

// With focus step
const details = await client.queryHelper(runId, "step_details", { focus_step_id: "step_01" });

// Compare two steps
const comparison = await client.queryHelper(runId, "compare_steps", {
  focus_step_id: "step_01",
  compare_step_id: "step_05",
});

// Specific visibility
const effects = await client.queryHelper(runId, "external_side_effects", {
  visibility: "internal",
});
```

### Artifacts

```ts
// Visibility: "user" | "model" | "internal" | "sensitive_internal"
const artifact = await client.queryArtifact(artifactId, "internal");
console.log(artifact.body);  // truncated at 8192 chars inline
```

---

## Recovery

```ts
// Plan recovery for an action ID or snapshot ID
// Returns plan with confidence score and impact preview
const plan = await client.planRecovery("act_xyz");
// Or pass a structured target:
const plan = await client.planRecovery({ type: "action_boundary", id: "act_xyz" });

console.log(plan.strategy);    // e.g. "restore_from_snapshot"
console.log(plan.confidence);  // 0-1
console.log(plan.impact_preview);
console.log(plan.steps);

// Preview only (don't create an executable plan)
const preview = await client.planRecovery("act_xyz", { preview_only: true });

// Execute a recovery
const result = await client.executeRecovery("act_xyz");
```

---

## Policy

```ts
// View current effective policy
const policy = await client.getEffectivePolicy();

// Validate a policy config document before applying
const validation = await client.validatePolicyConfig(myPolicyDoc);

// Preview how an action would be classified
const outcome = await client.explainPolicyAction(attempt);
console.log(outcome.decision, outcome.reasons);

// Calibration report
const report = await client.getPolicyCalibrationReport({
  run_id: runId,
  include_samples: true,
  sample_limit: 20,
});

// Threshold recommendations
const recs = await client.getPolicyThresholdRecommendations({
  run_id: runId,
  min_samples: 5,
});

// Replay candidate thresholds against history
const replay = await client.replayPolicyThresholds({
  run_id: runId,
  candidate_thresholds: { "filesystem.write": 0.75 },
  include_changed_samples: true,
  sample_limit: 20,
});
```

---

## MCP Management

### Simple registry

```ts
const servers = await client.listMcpServers();
await client.upsertMcpServer({ server_id: "my_server", ... });
await client.removeMcpServer("my_server");
```

### Trust review workflow

```ts
// Submit a candidate for review
await client.submitMcpServerCandidate({ source_kind: "user_input", raw_endpoint: "https://..." });

const candidates = await client.listMcpServerCandidates();

// Resolve to a profile
await client.resolveMcpServerCandidate({ candidate_id: "cand_abc", display_name: "My Server" });

const profiles = await client.listMcpServerProfiles();
const review = await client.getMcpServerReview("prof_abc");

// Approve the profile
await client.approveMcpServerProfile({
  server_profile_id: "prof_abc",
  decision: "allow_policy_managed",
  trust_tier: "operator_approved_public",
  allowed_execution_modes: ["local_proxy"],
  reason_codes: ["INITIAL_REVIEW_COMPLETE"],
});

// Bind credentials
await client.bindMcpServerCredentials({
  server_profile_id: "prof_abc",
  binding_mode: "bearer_secret_ref",
  broker_profile_id: "my_secret",
});

// Activate
await client.activateMcpServerProfile("prof_abc");

// If issues found later:
await client.quarantineMcpServerProfile({ server_profile_id: "prof_abc", reason: "suspicious" });
await client.revokeMcpServerProfile({ server_profile_id: "prof_abc", reason: "compromised" });
```

### Secrets

```ts
// Secrets are stored in OS keychain — bearer_token is consumed at upsert time
await client.upsertMcpSecret({
  secret_id: "my_key",
  display_name: "My API Key",
  bearer_token: "sk-...",
  expires_at: "2027-01-01T00:00:00Z",
});
const secrets = await client.listMcpSecrets();  // metadata only, no bearer tokens
await client.removeMcpSecret("my_key");
```

### Host policies

```ts
await client.upsertMcpHostPolicy({
  host: "api.example.com",
  display_name: "Example API",
  allow_subdomains: false,
  allowed_ports: [443],
});
const policies = await client.listMcpHostPolicies();
await client.removeMcpHostPolicy("api.example.com");
```

### Credential bindings

```ts
const bindings = await client.listMcpServerCredentialBindings("prof_abc");
await client.revokeMcpServerCredentials("binding_xyz");
```

### Trust decisions

```ts
const decisions = await client.listMcpServerTrustDecisions("prof_abc");
```

---

## Hosted MCP Jobs

```ts
const job = await client.getHostedMcpJob("job_abc");
const jobs = await client.listHostedMcpJobs({
  server_profile_id: "prof_abc",
  status: "failed",
  limit: 20,
  offset: 0,
});
await client.requeueHostedMcpJob("job_abc", {
  reset_attempts: true,
  max_attempts: 3,
  reason: "retry after fix",
});
await client.cancelHostedMcpJob("job_abc", { reason: "no longer needed" });
```

---

## Diagnostics & Maintenance

```ts
// Diagnostics
const diag = await client.diagnostics([
  "daemon_health", "journal_health", "security_posture"
]);

// Maintenance jobs
const result = await client.runMaintenance([
  "sqlite_wal_checkpoint",
  "snapshot_gc",
  "artifact_expiry",
]);
```

Available maintenance jobs: `startup_reconcile_recoveries`, `sqlite_wal_checkpoint`, `projection_refresh`, `projection_rebuild`, `snapshot_gc`, `snapshot_compaction`, `snapshot_rebase_anchor`, `artifact_expiry`, `artifact_orphan_cleanup`, `capability_refresh`, `helper_fact_warm`, `policy_threshold_calibration`

---

## Error Handling

```ts
import {
  AuthorityClientTransportError,
  AuthorityDaemonResponseError,
} from "@agentgit/authority-sdk";

try {
  await client.submitActionAttempt(attempt);
} catch (err) {
  if (err instanceof AuthorityClientTransportError) {
    // Socket-level error
    // err.code: "SOCKET_CONNECT_FAILED" | "SOCKET_CONNECT_TIMEOUT"
    //         | "SOCKET_RESPONSE_TIMEOUT" | "SOCKET_CLOSED" | "INVALID_RESPONSE"
    console.error("Transport error:", err.code, err.message);
  } else if (err instanceof AuthorityDaemonResponseError) {
    // Daemon returned an error response
    // err.code: "BAD_REQUEST" | "VALIDATION_FAILED" | "NOT_FOUND" | "CONFLICT"
    //         | "PRECONDITION_FAILED" | "POLICY_BLOCKED" | "UPSTREAM_FAILURE"
    //         | "CAPABILITY_UNAVAILABLE" | "BROKER_UNAVAILABLE"
    //         | "STORAGE_UNAVAILABLE" | "INTERNAL_ERROR" | "TIMEOUT"
    console.error("Daemon error:", err.code, err.message);
  }
}
```

---

## TypeScript Types

All response types come from `@agentgit/schemas`:

```ts
import type {
  TimelineProjection,
  TimelineStep,
  RecoveryPlan,
  ApprovalRequest,
  RunSummary,
  PolicyOutcomeRecord,
  ActionRecord,
  SnapshotRecord,
  ExecutionResult,
  RunEvent,
  VisibilityScope,
  HelperQuestionType,
} from "@agentgit/schemas";
```

---

## Idempotency

Mutation methods accept an optional `idempotency_key` for safe retries:

```ts
await client.registerRun(payload, { idempotency_key: "run-my-session-2026-04-03" });
await client.submitActionAttempt(attempt, { idempotency_key: "action-write-index-ts" });
await client.resolveApproval(id, "approve", "ok", { idempotency_key: "approve-apr-123" });
```

Requests with the same `idempotency_key` within a session are replayed from cache — safe to retry on timeout.

---

## Related

- [`@agentgit/schemas`](../packages/schemas/README.md) — type definitions
- [Python SDK](Python-SDK.md) — Python equivalent
- [CLI Reference](CLI-Reference.md) — operator-side management
- [Getting Started](Getting-Started.md)
