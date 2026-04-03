# @agentgit/execution-adapters

> **Internal package** — used by the agentgit daemon. Not published to npm.

Governed side-effecting adapters for every execution domain that agentgit supports. Each adapter enforces preconditions, injects brokered credentials where required, executes the action, captures typed artifacts, and returns a structured `ExecutionResult`.

---

## What It Does

Adapters are the only place in agentgit where real side effects happen. An action reaches an adapter only after passing policy evaluation (and optionally snapshot capture). The adapter then:

1. **Re-validates preconditions** — checks workspace scope, tool allowlist, credential availability
2. **Injects credentials** (MCP only) — requests secrets from the credential broker by ID; never handles plaintext secrets directly
3. **Executes** — writes the file, runs the command, calls the tool, creates the object
4. **Captures artifacts** — collects stdout/stderr, response bodies, mutation diffs
5. **Returns `ExecutionResult`** — structured result that the daemon journals and uses for recovery pre-computation

---

## Adapters

### FilesystemAdapter
```ts
// Governed file write
const result = await filesystemAdapter.write({
  action_id: "act_xyz",
  path: "/workspace/src/index.ts",
  content: "export const x = 1;",
  workspace_root: "/workspace",
});
// → { success: true, artifact_id: "art_abc", bytes_written: 22 }
```

Enforces:
- Path must be within a declared workspace root
- File size within budget limits
- No writes to `.agentgit/` or other system directories

### ShellAdapter
```ts
// Governed shell command
const result = await shellAdapter.execute({
  action_id: "act_xyz",
  command: "git status",
  args: [],
  cwd: "/workspace",
  workspace_root: "/workspace",
});
// → { success: true, artifact_id: "art_def", exit_code: 0 }
```

Captures stdout and stderr as artifacts with configurable truncation limits.

### McpProxyAdapter
```ts
// Governed MCP tool call
const result = await mcpProxyAdapter.callTool({
  action_id: "act_xyz",
  server_id: "notion_public",
  tool_name: "search_pages",
  arguments: { query: "launch plan" },
  run_id: "run_abc",
});
// → { success: true, artifact_id: "art_ghi", tool_response: {...} }
```

For **stdio servers**: launches the registered command in a digest-pinned OCI container (required production path) or local process (development only).

For **streamable_http servers**: validates URL against host allowlist, injects bearer token from credential broker, enforces concurrency limits.

### OwnedFunctionAdapter
```ts
// Governed draft creation
const result = await ownedFunctionAdapter.createDraft({
  action_id: "act_xyz",
  run_id: "run_abc",
  title: "Launch Plan",
  body: "...",
});
// → { success: true, integration_id: "int_abc", external_id: "draft_123" }
```

Supported operations: `create_draft`, `create_note`, `create_ticket`, `update_ticket`, `close_ticket`, `add_ticket_label`, `set_ticket_assignee`.

All operations record preimage state in `integration-state` for compensation-based recovery.

---

## Artifact Capture

Every adapter captures its output as a typed artifact stored in the journal:

```ts
{
  artifact_id: "art_abc",
  action_id: "act_xyz",
  artifact_type: "file_write" | "shell_stdout" | "shell_stderr" | "mcp_response" | "function_result",
  body: "...",             // truncated per visibility rules
  full_body_available: true,
  visibility: "internal" | "external",
  captured_at: "...",
}
```

Use `agentgit-authority artifact <id> internal` to view the full body, or `artifact-export` to write it to disk.

---

## Related Packages

- [`@agentgit/policy-engine`](../policy-engine/README.md) — action must pass policy before reaching adapters
- [`@agentgit/snapshot-engine`](../snapshot-engine/README.md) — snapshot captured before adapter runs (if required)
- [`@agentgit/credential-broker`](../credential-broker/README.md) — provides secrets to McpProxyAdapter
- [`@agentgit/mcp-registry`](../mcp-registry/README.md) — server definitions looked up by McpProxyAdapter
- [`@agentgit/integration-state`](../integration-state/README.md) — OwnedFunctionAdapter writes mutation state here
- [`@agentgit/run-journal`](../run-journal/README.md) — `ExecutionResult` and artifacts persisted here
- [`@agentgit/schemas`](../schemas/README.md) — `ExecutionResult` type definition
