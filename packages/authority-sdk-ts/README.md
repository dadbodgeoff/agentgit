# @agentgit/authority-sdk

TypeScript client SDK for the local-first agentgit authority daemon.

Embed this in your agent to submit governed actions, inspect timelines, manage approvals, and trigger recovery — all via the local daemon's Unix socket IPC.

---

## Install

```bash
npm install @agentgit/authority-sdk @agentgit/schemas
```

## Compatibility

- Node.js `24.14.0+`
- daemon API `authority.v1`

---

## Quickstart

```ts
import { AuthorityClient } from "@agentgit/authority-sdk";

// Auto-discovers socket from AGENTGIT_ROOT env var or process.cwd()
// Resolves to: <root>/.agentgit/authority.sock
const client = new AuthorityClient();

// Or specify options
const client = new AuthorityClient({
  socketPath: "/absolute/path/to/.agentgit/authority.sock",
  connectTimeoutMs: 1000,
  responseTimeoutMs: 5000,
  maxConnectRetries: 1,
  connectRetryDelayMs: 50,
  clientType: "sdk_ts",     // "sdk_ts" | "sdk_py" | "cli" | "ui"
});

// Open a session and verify daemon is running
const hello = await client.hello(["/path/to/workspace"]);
console.log(hello.accepted_api_version); // "authority.v1"

// Register a run
const run = await client.registerRun({
  workflow_name: "my-agent-run",
  agent_framework: "custom",
  agent_name: "demo-agent",
  workspace_roots: ["/path/to/workspace"],
  client_metadata: { purpose: "readme-quickstart" },
});

// Submit a governed action
const result = await client.submitActionAttempt({
  run_id: run.run_id,
  tool_registration: {
    tool_name: "write_file",
    tool_kind: "filesystem",
  },
  raw_call: {
    path: "/path/to/workspace/output.txt",
    content: "hello",
  },
  environment_context: {
    workspace_roots: ["/path/to/workspace"],
  },
  received_at: new Date().toISOString(),
});
console.log(result.decision);

// Inspect the timeline
const timeline = await client.queryTimeline(run.run_id, "internal");
timeline.steps.forEach(step => console.log(step.summary));

// Answer a structured question about the run
const answer = await client.queryHelper(run.run_id, "what_happened");
console.log(answer.answer);
```

---

## Key API Methods

### Session & Runs
```ts
client.hello(workspaceRoots: string[]): Promise<HelloResponsePayload>
client.registerRun(payload, options?: { idempotencyKey? }): Promise<RegisterRunResponsePayload>
client.getRunSummary(runId: string): Promise<GetRunSummaryResponsePayload>
client.getCapabilities(workspaceRoot?: string): Promise<GetCapabilitiesResponsePayload>
```

### Action Submission
```ts
client.submitActionAttempt(attempt, options?: { idempotencyKey? }): Promise<SubmitActionAttemptResponsePayload>
```

### Approvals
```ts
client.listApprovals(options?: { run_id?, status? }): Promise<ListApprovalsResponsePayload>
client.queryApprovalInbox(options?: { run_id?, status? }): Promise<...>
// decision: "approve" | "deny"  (not "reject")
client.resolveApproval(approvalId, decision, note?, options?): Promise<ResolveApprovalResponsePayload>
```

### Inspection
```ts
// visibility: "user" | "model" | "internal" | "sensitive_internal"
client.queryTimeline(runId, visibility?): Promise<QueryTimelineResponsePayload>

// questionType is a HelperQuestionType enum — not a free-form string
// See wiki/TypeScript-SDK.md for the full list of query types
client.queryHelper(runId, questionType, focusStepId?, compareStepId?, visibility?): Promise<QueryHelperResponsePayload>
client.queryArtifact(artifactId, visibility?): Promise<QueryArtifactResponsePayload>
```

### Recovery
```ts
client.planRecovery(target, options?: { preview_only? }): Promise<PlanRecoveryResponsePayload>
client.executeRecovery(target, options?: { idempotency_key? }): Promise<ExecuteRecoveryResponsePayload>
```

### Policy
```ts
client.getEffectivePolicy(): Promise<GetEffectivePolicyResponsePayload>
client.validatePolicyConfig(config: unknown): Promise<ValidatePolicyConfigResponsePayload>
client.explainPolicyAction(attempt): Promise<ExplainPolicyActionResponsePayload>
client.getPolicyCalibrationReport(options?): Promise<...>
client.getPolicyThresholdRecommendations(options?): Promise<...>
client.replayPolicyThresholds(options): Promise<...>
```

### MCP Management
```ts
client.listMcpServers(): Promise<ListMcpServersResponsePayload>
client.upsertMcpServer(input, options?): Promise<...>
client.removeMcpServer(serverId, options?): Promise<...>
client.listMcpServerCandidates(): Promise<...>
client.submitMcpServerCandidate(candidate, options?): Promise<...>
client.resolveMcpServerCandidate(payload, options?): Promise<...>
client.listMcpServerProfiles(): Promise<...>
client.getMcpServerReview(id): Promise<...>
client.approveMcpServerProfile(payload, options?): Promise<...>
client.activateMcpServerProfile(profileId, options?): Promise<...>
client.quarantineMcpServerProfile(payload, options?): Promise<...>
client.revokeMcpServerProfile(payload, options?): Promise<...>
client.listMcpServerCredentialBindings(serverProfileId?): Promise<...>
client.bindMcpServerCredentials(payload, options?): Promise<...>
client.revokeMcpServerCredentials(credentialBindingId, options?): Promise<...>
client.listMcpServerTrustDecisions(serverProfileId?): Promise<...>
client.listMcpSecrets(): Promise<ListMcpSecretsResponsePayload>
client.upsertMcpSecret(input, options?): Promise<...>
client.removeMcpSecret(secretId, options?): Promise<...>
client.listMcpHostPolicies(): Promise<...>
client.upsertMcpHostPolicy(input, options?): Promise<...>
client.removeMcpHostPolicy(host, options?): Promise<...>
```

### Hosted MCP Jobs
```ts
client.getHostedMcpJob(jobId): Promise<...>
client.listHostedMcpJobs(options?): Promise<...>
client.requeueHostedMcpJob(jobId, options?): Promise<...>
client.cancelHostedMcpJob(jobId, options?): Promise<...>
```

### Diagnostics & Maintenance
```ts
client.diagnostics(components?: string[]): Promise<DiagnosticsResponsePayload>
client.runMaintenance(jobTypes: string[], options?): Promise<RunMaintenanceResponsePayload>
```

---

## Error Classes

```ts
import {
  AuthorityClientTransportError,
  AuthorityDaemonResponseError,
} from "@agentgit/authority-sdk";

// Transport errors (socket-level)
// err.code: "SOCKET_CONNECT_FAILED" | "SOCKET_CONNECT_TIMEOUT"
//         | "SOCKET_RESPONSE_TIMEOUT" | "SOCKET_CLOSED" | "INVALID_RESPONSE"

// Daemon errors (application-level)
// err.code: "BAD_REQUEST" | "VALIDATION_FAILED" | "NOT_FOUND" | "CONFLICT"
//         | "TIMEOUT" | "PRECONDITION_FAILED" | "POLICY_BLOCKED"
//         | "UPSTREAM_FAILURE" | "CAPABILITY_UNAVAILABLE"
//         | "BROKER_UNAVAILABLE" | "STORAGE_UNAVAILABLE" | "INTERNAL_ERROR"
```

---

## Idempotency

Mutation methods accept `{ idempotencyKey }` as the last `options` argument. Requests with the same key within a session replay from cache and are safe to retry on timeout.

```ts
await client.registerRun(payload, { idempotencyKey: "my-run-session-id" });
await client.submitActionAttempt(attempt, { idempotencyKey: "write-index-ts" });
```

---

## Related Packages

- [`@agentgit/schemas`](../schemas/README.md) — TypeScript types
- [`@agentgit/authority-daemon`](../authority-daemon/README.md) — the daemon this SDK connects to
- [`@agentgit/authority-cli`](../authority-cli/README.md) — operator CLI
- [`@agentgit/authority-sdk-py`](../authority-sdk-py/README.md) — Python equivalent
