# @agentgit/hosted-mcp-worker

> **Internal package — future work.** This package is a placeholder for the hosted MCP worker surface that is explicitly deferred from the v1 launch scope.

---

## Status

**Not part of the current release.** The local-first MVP ships with:

- Operator-owned **stdio** MCP servers (sandboxed OCI containers, local)
- Operator-owned **streamable_http** MCP servers (public HTTPS with host allowlist)

Hosted/cloud MCP worker infrastructure — where agentgit manages the server lifecycle in a remote environment — is a deferred phase. See `agentgit-authority cloud-roadmap` for the explicit roadmap.

---

## When This Ships

This package will handle:

- Durable worker queue for hosted MCP tool invocations
- Remote execution environment lifecycle management
- Cloud-to-local result streaming back to the daemon journal

---

## Related

- [`@agentgit/mcp-registry`](../mcp-registry/README.md) — server registration state
- [`@agentgit/execution-adapters`](../execution-adapters/README.md) — current local MCP proxy adapter
- [`@agentgit/authority-cli`](../authority-cli/README.md) — `cloud-roadmap` command shows deferred phases
