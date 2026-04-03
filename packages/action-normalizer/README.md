# @agentgit/action-normalizer

> **Internal package** — used by the agentgit daemon. Not published to npm.

Converts raw agent action attempts into canonical `Action` records. Every action that enters the agentgit system — regardless of which agent, SDK, or execution domain it came from — gets normalized to a single stable shape before policy evaluation, execution, and journaling.

---

## What It Does

When an agent submits an action (e.g., "write this file", "run this shell command", "call this MCP tool"), the normalizer:

1. **Validates inputs** — checks required fields, domain-specific constraints, workspace path scope
2. **Records provenance** — captures where the attempt came from (run ID, agent ID, tool name, submission timestamp)
3. **Identifies execution path** — resolves which adapter will handle this action
4. **Assesses risk** — produces initial risk hints (side-effect level, recovery class, confidence estimate)
5. **Produces a canonical `Action`** — a stable, schema-validated record that the rest of the system (policy, snapshot, journal) operates on

---

## Execution Domains

The normalizer handles four execution domains:

| Domain | Example action | Adapter |
|--------|---------------|---------|
| `filesystem` | Write/read a file in the workspace | FilesystemAdapter |
| `shell` | Execute a shell command | ShellAdapter |
| `mcp` | Call a tool on a registered MCP server | McpProxyAdapter |
| `owned_function` | Create a draft, note, or ticket | OwnedFunctionAdapter |

---

## Key Exports

```ts
import { normalizeAction } from "@agentgit/action-normalizer";

// Raw attempt from SDK or CLI
const attempt = {
  run_id: "run_abc",
  tool_name: "write_file",
  execution_domain: "filesystem",
  raw_inputs: { path: "/workspace/src/index.ts", content: "export const x = 1;" },
  workspace_roots: ["/workspace"],
};

const action = await normalizeAction(attempt);
// → {
//     action_id: "act_xyz",
//     run_id: "run_abc",
//     domain: "filesystem",
//     tool_name: "write_file",
//     normalized_inputs: { path: "/workspace/src/index.ts", content: "..." },
//     execution_path: "filesystem_adapter",
//     side_effect_level: "write",
//     recovery_class: "reversible",
//     confidence_estimate: 0.85,
//     workspace_path_validated: true,
//     provenance: { submitted_at: "...", agent_id: "...", sdk_version: "..." },
//   }
```

---

## Confidence Assessment

The normalizer produces an initial confidence estimate for each action based on:

- How well-formed the inputs are (all required fields present, paths within workspace bounds)
- Historical accuracy for this execution domain and tool name
- Whether the action has been seen before in this run

This estimate feeds into the policy engine's threshold evaluation — low-confidence actions are more likely to trigger the `ask` outcome.

---

## Workspace Path Validation

For `filesystem` actions, the normalizer enforces that the target path is inside a declared workspace root. Actions targeting paths outside workspace bounds are rejected before reaching policy evaluation.

---

## Related Packages

- [`@agentgit/schemas`](../schemas/README.md) — the `Action` type that this package produces
- [`@agentgit/policy-engine`](../policy-engine/README.md) — consumes `Action` records
- [`@agentgit/run-journal`](../run-journal/README.md) — persists `Action` records
- [`@agentgit/authority-daemon`](../authority-daemon/README.md) — the daemon calls the normalizer for every submitted attempt
