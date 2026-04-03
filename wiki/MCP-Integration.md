# MCP Integration

agentgit supports operator-managed MCP (Model Context Protocol) servers with real trust controls: OS-backed secret storage (macOS Keychain / Linux Secret Service), digest-pinned OCI containers for local stdio servers, explicit host allowlists with DNS/IP validation for remote servers, and a formal trust review workflow for third-party endpoints.

---

## Registration Options

There are three paths for getting an MCP server into agentgit:

| Path | When to use |
|------|------------|
| **Direct registration** (`upsert-mcp-server`) | You fully control the server and have already verified it |
| **Orchestrated onboarding** (`onboard-mcp`) | New server — handles secrets + host policy + registration + smoke test in one plan |
| **Trust review** (`trust-review-mcp`) | Third-party or remote endpoint — formal candidate → profile → approve → bind → activate workflow |

---

## Path 1: Direct Registration

### Register a secret (remote servers)

```bash
agentgit-authority upsert-mcp-secret '{
  "secret_id": "notion_key",
  "display_name": "Notion API Key",
  "bearer_token": "secret_abc123",
  "expires_at": "2027-01-01T00:00:00Z"
}'
```

Or from a file (safer):
```bash
agentgit-authority upsert-mcp-secret \
  --secret-id notion_key \
  --display-name "Notion API Key" \
  --bearer-token-file ./token.txt

# Or interactive prompt:
agentgit-authority upsert-mcp-secret --secret-id notion_key --prompt-bearer-token
```

The bearer token is moved to the OS keychain immediately — it is never stored in the registry database.

### Register a host policy (public_https servers only)

```bash
agentgit-authority upsert-mcp-host-policy '{
  "host": "api.notion.com",
  "display_name": "Notion API",
  "allow_subdomains": false,
  "allowed_ports": [443]
}'
```

Connections to hosts not in the allowlist are rejected. DNS/IP scope validation and redirect-chain revalidation are enforced at connection time.

### Register the server

**Remote (streamable_http):**
```bash
agentgit-authority upsert-mcp-server '{
  "server_id": "notion_public",
  "display_name": "Notion MCP",
  "transport": "streamable_http",
  "url": "https://api.notion.com/mcp",
  "network_scope": "public_https",
  "auth": { "type": "bearer_secret_ref", "secret_id": "notion_key" },
  "tools": [
    { "tool_name": "search_pages", "side_effect_level": "read_only", "approval_mode": "allow" },
    { "tool_name": "create_page", "side_effect_level": "write", "approval_mode": "ask" }
  ],
  "concurrency_limit": 3
}'
```

**Local (stdio) — development mode:**
```bash
agentgit-authority upsert-mcp-server '{
  "server_id": "local_tools",
  "display_name": "Local Tools",
  "transport": "stdio",
  "command": "node",
  "args": ["/absolute/path/to/server.mjs"],
  "tools": [
    { "tool_name": "echo_note", "side_effect_level": "read_only", "approval_mode": "allow" }
  ]
}'
```

**Local (stdio) — production mode (required for production deployments):**

Local stdio servers must run in a digest-pinned OCI container in production. Use the `oci_container` field:

```json
{
  "server_id": "local_tools",
  "transport": "stdio",
  "oci_container": {
    "image": "ghcr.io/myorg/my-mcp-server@sha256:abc123...",
    "digest": "sha256:abc123..."
  },
  "tools": [...]
}
```

The `allowed_registries` policy controls which container registries are trusted. Cosign-based signature verification with SLSA provenance enforcement is supported for container images.

---

## Path 2: Orchestrated Onboarding (`onboard-mcp`)

Run everything in a single plan file:

```bash
agentgit-authority onboard-mcp ./onboard-plan.json
```

**`onboard-plan.json`:**
```json
{
  "secrets": [
    {
      "secret_id": "notion_key",
      "display_name": "Notion API Key",
      "bearer_token": "secret_abc123"
    }
  ],
  "host_policies": [
    {
      "host": "api.notion.com",
      "display_name": "Notion API",
      "allow_subdomains": false,
      "allowed_ports": [443]
    }
  ],
  "server": {
    "server_id": "notion_public",
    "display_name": "Notion MCP",
    "transport": "streamable_http",
    "url": "https://api.notion.com/mcp",
    "network_scope": "public_https",
    "auth": { "type": "bearer_secret_ref", "secret_id": "notion_key" },
    "tools": [
      { "tool_name": "search_pages", "side_effect_level": "read_only", "approval_mode": "allow" }
    ]
  },
  "smoke_test": {
    "server_id": "notion_public",
    "tool_name": "search_pages",
    "arguments": { "query": "test" }
  }
}
```

---

## Path 3: Trust Review (`trust-review-mcp`)

For third-party or remote endpoints. Runs a formal candidate → profile → approve → bind → activate workflow:

```bash
agentgit-authority trust-review-mcp ./trust-review-plan.json
```

**`trust-review-plan.json`:**
```json
{
  "secrets": [
    { "secret_id": "remote_key", "display_name": "Remote bearer", "bearer_token": "..." }
  ],
  "candidate": {
    "source_kind": "user_input",
    "raw_endpoint": "https://api.example.com/mcp",
    "transport_hint": "streamable_http",
    "notes": "Initial operator trust review"
  },
  "resolve": { "display_name": "Remote MCP" },
  "approval": {
    "decision": "allow_policy_managed",
    "trust_tier": "operator_approved_public",
    "allowed_execution_modes": ["local_proxy"],
    "reason_codes": ["INITIAL_REVIEW_COMPLETE"]
  },
  "credential_binding": {
    "binding_mode": "bearer_secret_ref",
    "broker_profile_id": "remote_key"
  },
  "activate": true,
  "smoke_test": { "tool_name": "echo", "arguments": { "note": "launch check" } }
}
```

### Manual trust review steps

```bash
# 1. Submit candidate
agentgit-authority submit-mcp-server-candidate ./candidate.json

# 2. Review candidate list
agentgit-authority list-mcp-server-candidates

# 3. Resolve to a profile
agentgit-authority resolve-mcp-server-candidate ./resolve.json

# 4. Review profiles and trust decisions
agentgit-authority list-mcp-server-profiles
agentgit-authority list-mcp-server-trust-decisions <server-profile-id>
agentgit-authority show-mcp-server-review <server-profile-id>

# 5. Approve the profile
agentgit-authority approve-mcp-server-profile ./approval.json

# 6. Bind credentials
agentgit-authority list-mcp-server-credential-bindings
agentgit-authority bind-mcp-server-credentials ./binding.json

# 7. Activate
agentgit-authority activate-mcp-server-profile <server-profile-id>

# If issues are found later:
agentgit-authority quarantine-mcp-server-profile ./quarantine.json
agentgit-authority revoke-mcp-server-profile ./revoke.json
agentgit-authority revoke-mcp-server-credentials <credential-binding-id>
```

---

## Calling MCP Tools

Once a server is registered, agents call tools through the governed adapter:

```bash
# By server ID (direct registry)
agentgit-authority submit-mcp-tool run_abc notion_public search_pages '{"query":"launch"}'

# By server profile ID (trust-reviewed)
agentgit-authority submit-mcp-profile-tool run_abc prof_abc123 search_pages '{"query":"test"}'
```

```ts
// TypeScript SDK
const result = await client.submitActionAttempt({
  run_id: runId,
  tool_name: "search_pages",
  execution_domain: "mcp",
  raw_inputs: {
    server_id: "notion_public",
    arguments: { query: "launch plan" },
  },
  workspace_roots: ["/workspace"],
});
```

```python
# Python SDK
attempt = build_action_attempt(
    run_id, "search_pages", "mcp",
    {"server_id": "notion_public", "arguments": {"query": "launch"}},
    workspace_roots=["/workspace"],
)
client.submit_action_attempt(attempt)
```

---

## Managing Registered Resources

```bash
agentgit-authority list-mcp-servers
agentgit-authority list-mcp-secrets         # metadata only — no bearer tokens
agentgit-authority list-mcp-host-policies
agentgit-authority list-mcp-server-profiles
agentgit-authority list-mcp-server-candidates
agentgit-authority list-mcp-server-credential-bindings

# Remove
agentgit-authority remove-mcp-server <server-id>
agentgit-authority remove-mcp-secret <secret-id>
agentgit-authority remove-mcp-host-policy <host>
```

---

## Network Scopes

| Scope | What it allows |
|-------|---------------|
| `loopback` | `127.0.0.1` / `::1` only |
| `private` | RFC-1918 addresses only |
| `public_https` | Any HTTPS endpoint; requires a host policy entry |

The scope is inferred from the server URL. Remote connections without a matching host policy entry are rejected. Redirect chains are re-validated against the allowlist at connection time.

---

## Security Model

- **Secrets never stored in plain files** — OS keychain (macOS) or Secret Service (Linux)
- **Direct credential injection from agent code is denied** — only the broker can inject secrets into adapter calls
- **Agents cannot register servers** — only operators can
- **Tool allowlist** — calls to tools not in the registered allowlist are rejected before execution
- **Container isolation** — stdio servers require OCI containers in production
- **Registry allowlist** — `allowed_registries` policy controls which container registries are trusted
- **Signature verification** — cosign + SLSA provenance supported for container images
- **Concurrency limits** — per-server `concurrency_limit` enforced via SQLite leases with heartbeat renewal

---

## Related

- [CLI Reference: MCP commands](CLI-Reference.md#mcp-server-management)
- [`@agentgit/mcp-registry` README](../packages/mcp-registry/README.md)
- [`@agentgit/credential-broker` README](../packages/credential-broker/README.md)
- [`@agentgit/execution-adapters` README](../packages/execution-adapters/README.md)
