# @agentgit/mcp-registry

> **Internal package** — used by the agentgit daemon. Not published to npm.

Durable registry for operator-managed MCP (Model Context Protocol) servers. Stores server definitions, tool allowlists, network scope policies, and authentication references so the daemon can consistently govern MCP tool calls across sessions.

---

## What It Does

When an operator registers an MCP server (via `agentgit-authority upsert-mcp-server` or `onboard-mcp`), that definition is persisted in the registry. Every subsequent MCP tool call goes through this registry to:

- Verify the server exists and is active
- Check the tool is in the allowlist
- Retrieve the authentication reference (secret ID, not the plaintext secret)
- Apply per-server execution limits and approval-mode overrides

---

## Server Types

| Transport | How it runs |
|-----------|------------|
| `stdio` | Local process, launched in a digest-pinned OCI container |
| `streamable_http` | Remote HTTP endpoint, requires explicit host allowlist entry |

### Network scopes (for streamable_http)

| Scope | What it means |
|-------|--------------|
| `loopback` | `127.0.0.1` / `::1` only |
| `private` | RFC-1918 addresses only |
| `public_https` | Any HTTPS endpoint; requires host allowlist entry |

---

## Key Exports

```ts
import { McpRegistry } from "@agentgit/mcp-registry";

const registry = new McpRegistry({ dbPath: "/path/to/journal.db" });

// Register a server
await registry.upsertServer({
  server_id: "notion_public",
  display_name: "Notion MCP",
  transport: "streamable_http",
  url: "https://api.notion.com/mcp",
  network_scope: "public_https",
  auth: { type: "bearer_secret_ref", secret_id: "notion_secret" },
  tools: [
    { tool_name: "search_pages", side_effect_level: "read_only", approval_mode: "allow" },
    { tool_name: "create_page", side_effect_level: "write", approval_mode: "ask" },
  ],
  concurrency_limit: 3,
  active: true,
});

// Look up a server (called by execution adapter before running a tool)
const server = await registry.getServer("notion_public");

// List all active servers
const servers = await registry.listServers({ active_only: true });

// Deactivate a server (stops new calls; existing runs finish)
await registry.deactivateServer("notion_public");
```

---

## Tool Allowlist

Each server definition includes an explicit list of allowed tools. Calls to tools not in the allowlist are rejected at the policy evaluation stage before the adapter is invoked.

```ts
// Tool definition shape
{
  tool_name: string;                // exact name from MCP tools/list
  side_effect_level: "read_only" | "write" | "delete";
  approval_mode: "allow" | "ask" | "deny";
  description?: string;            // for operator review surfaces
}
```

---

## Host Policy Integration

For `public_https` servers, the daemon cross-checks the server's URL against the `mcp_host_policies` table before making any connection. The registry and host policy tables share the same SQLite database.

---

## Related Packages

- [`@agentgit/execution-adapters`](../execution-adapters/README.md) — looks up server definitions before executing tool calls
- [`@agentgit/credential-broker`](../credential-broker/README.md) — handles the actual secret lookup; registry stores the reference only
- [`@agentgit/policy-engine`](../policy-engine/README.md) — reads tool definitions to apply approval-mode rules
- [`@agentgit/authority-cli`](../authority-cli/README.md) — `list-mcp-servers`, `upsert-mcp-server`, `onboard-mcp` commands
