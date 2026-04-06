# agentgit-authority (Python SDK)

Thin Python client for the local agentgit authority daemon. Mirrors the TypeScript SDK surface, communicates via newline-delimited JSON over the daemon's Unix socket.

---

## Requirements

- Python 3.11+
- agentgit daemon running (`agentgit-authority daemon start`)

---

## Install

```bash
# Source-only alpha for the MVP launch contract.
# Build/install verification is covered by `pnpm py:build`.

# Or from source (monorepo):
export PYTHONPATH=packages/authority-sdk-py
```

---

## Quickstart

```python
from agentgit_authority import AuthorityClient, build_register_run_payload

# Auto-discovers socket: AGENTGIT_ROOT → INIT_CWD → os.getcwd()
# Resolves to <root>/.agentgit/authority.sock
client = AuthorityClient()

# Verify daemon is reachable
hello = client.hello()
print(hello["accepted_api_version"])  # "authority.v1"

# Register a run
run = client.register_run(
    build_register_run_payload("my-run", ["/path/to/workspace"])
)
run_id = run["run_id"]

# Submit a governed action
client.submit_filesystem_write(
    run_id,
    "/path/to/workspace/output.txt",
    "hello from python agent",
    workspace_roots=["/path/to/workspace"],
)

# Inspect the timeline
timeline = client.query_timeline(run_id)
for step in timeline["steps"]:
    print(step["summary"])
```

---

## Governed Submissions

### Filesystem

```python
client.submit_filesystem_write(run_id, path, content, workspace_roots=[...])
```

### Shell

```python
client.submit_shell(run_id, "git status", workspace_roots=[...])
```

### MCP tool call

```python
from agentgit_authority import build_action_attempt

attempt = build_action_attempt(
    run_id,
    tool_name="search_pages",
    tool_kind="mcp",
    raw_call={"server_id": "notion_public", "arguments": {"query": "launch"}},
    workspace_roots=[...],
)
client.submit_action_attempt(attempt)
```

### Owned functions

```python
# Drafts
client.submit_draft_create(run_id, "My Draft", "content...", workspace_roots=[...])

# Notes
client.submit_note_create(run_id, "My Note", "content...", workspace_roots=[...])

# Tickets
client.submit_ticket_create(run_id, "Bug: auth fails", "description...", workspace_roots=[...])
client.submit_ticket_update(run_id, "ticket_123", title="Updated title", workspace_roots=[...])
client.submit_ticket_close(run_id, "ticket_123", workspace_roots=[...])
client.submit_ticket_add_label(run_id, "ticket_123", "priority/high", workspace_roots=[...])
```

---

## Inspection & Approvals

```python
# Timeline and run summary
timeline = client.query_timeline(run_id)
summary = client.get_run_summary(run_id)

# Ask structured questions (uses HelperQuestionType enum values)
answer = client.query_helper(run_id, "what_happened")
cause  = client.query_helper(run_id, "likely_cause")
# Other valid types: "run_summary", "reversible_steps", "why_blocked",
# "external_side_effects", "compare_steps", etc.

# Approvals
pending = client.list_approvals(run_id=run_id)
client.resolve_approval("apr_123", "approve", "looks safe")
client.resolve_approval("apr_123", "deny",    "risky — needs review")
```

---

## Recovery

```python
# Plan recovery for an action or snapshot
plan = client.plan_recovery("act_123")
print(f"Recovery type: {plan['recovery_type']}, confidence: {plan['confidence']}")

# Execute the plan after reviewing it
result = client.execute_recovery(plan["plan_id"])
```

---

## MCP Management

```python
# List registered servers, secrets, and host policies
servers = client.list_mcp_servers()
secrets = client.list_mcp_secrets()
policies = client.list_mcp_host_policies()

# Register a new server
client.upsert_mcp_server({
    "server_id": "my_server",
    "transport": "streamable_http",
    "url": "https://api.example.com/mcp",
    "network_scope": "public_https",
    "auth": {"type": "bearer_secret_ref", "secret_id": "my_secret"},
    "tools": [{"tool_name": "search", "side_effect_level": "read_only", "approval_mode": "allow"}],
})
```

---

## Running Tests

```bash
PYTHONPATH=packages/authority-sdk-py \
python3 -m unittest discover -s packages/authority-sdk-py/tests -v
```

Or from the repo root:

```bash
pnpm py:test
```

---

## Running the Example

With the daemon running in one terminal:

```bash
pnpm daemon:start
```

Run the example in another:

```bash
PYTHONPATH=packages/authority-sdk-py \
python3 packages/authority-sdk-py/examples/governed_run.py \
  --workspace-root "$(pwd)"

# Or from repo root:
pnpm smoke:py
```

---

## Design Notes

- Speaks newline-delimited JSON over the local authority Unix socket
- Mirrors the TypeScript SDK method surface — same method names, same semantics
- Does not reimplement policy, snapshot, journal, or recovery logic (all in the daemon)
- Intentionally thin — business logic lives in the daemon, not the SDK

---

## Related

- [`@agentgit/authority-sdk`](../authority-sdk-ts/README.md) — TypeScript equivalent
- [`@agentgit/authority-daemon`](../authority-daemon/README.md) — the daemon this SDK connects to
- [`@agentgit/authority-cli`](../authority-cli/README.md) — CLI for operator-side management
