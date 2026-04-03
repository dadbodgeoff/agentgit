# Python SDK

`agentgit-authority` is the Python client for the local agentgit authority daemon. Thin, synchronous, mirrors the TypeScript SDK surface exactly.

---

## Requirements

- Python 3.11+
- agentgit daemon running (`agentgit-authority daemon start`)

---

## Install

```bash
pip install agentgit-authority   # coming soon

# From source (monorepo):
export PYTHONPATH=/path/to/agentgit/packages/authority-sdk-py
```

---

## Socket Path Resolution

The client resolves the socket path automatically from environment or cwd:

```python
# Resolution order:
# 1. socket_path argument (if given)
# 2. <AGENTGIT_ROOT>/.agentgit/authority.sock
# 3. <INIT_CWD>/.agentgit/authority.sock
# 4. <os.getcwd()>/.agentgit/authority.sock
```

```python
from agentgit_authority import AuthorityClient

client = AuthorityClient()                    # auto-discovers from env/cwd
client = AuthorityClient(                     # explicit
    socket_path="/my/project/.agentgit/authority.sock",
    connect_timeout_s=1.0,
    response_timeout_s=5.0,
    max_connect_retries=1,
    connect_retry_delay_s=0.05,
)

hello = client.hello()
print(hello["accepted_api_version"])  # "authority.v1"
```

---

## Run Lifecycle

```python
from agentgit_authority import build_register_run_payload

run = client.register_run(
    build_register_run_payload("my-agent-session", ["/absolute/path/to/workspace"])
)
run_id = run["run_id"]

summary = client.get_run_summary(run_id)
caps = client.get_capabilities("/path/to/workspace")
```

---

## Submitting Actions

### Filesystem

```python
result = client.submit_filesystem_write(
    run_id,
    "/workspace/output.txt",
    "content here",
    workspace_roots=["/workspace"],
)

result = client.submit_filesystem_delete(
    run_id,
    "/workspace/tmp/stale.txt",
    workspace_roots=["/workspace"],
)
```

### Shell

```python
result = client.submit_shell(run_id, "git status", workspace_roots=["/workspace"])
```

### MCP tool call

```python
from agentgit_authority import build_action_attempt

# By server ID
attempt = build_action_attempt(
    run_id,
    tool_name="search_pages",
    tool_kind="mcp",
    raw_call={
        "server_id": "notion_public",
        "arguments": {"query": "launch plan"},
    },
    workspace_roots=["/workspace"],
)
result = client.submit_action_attempt(attempt)

# Or submit via Python helper
result = client.submit_mcp_tool(
    run_id, "notion_public", "search_pages", {"query": "launch"},
    workspace_roots=["/workspace"],
)
```

### Owned functions

```python
# Drafts
client.submit_draft_create(run_id, "Launch plan", "content", workspace_roots=[...])
client.submit_draft_update(run_id, "draft_123", title="Updated", workspace_roots=[...])
client.submit_draft_archive(run_id, "draft_123", workspace_roots=[...])
client.submit_draft_delete(run_id, "draft_123", workspace_roots=[...])

# Notes
client.submit_note_create(run_id, "Meeting notes", "content", workspace_roots=[...])
client.submit_note_update(run_id, "note_123", body="updated", workspace_roots=[...])

# Tickets
client.submit_ticket_create(run_id, "Fix auth bug", "description", workspace_roots=[...])
client.submit_ticket_update(run_id, "ticket_123", title="Updated", workspace_roots=[...])
client.submit_ticket_close(run_id, "ticket_123", workspace_roots=[...])
client.submit_ticket_reopen(run_id, "ticket_123", workspace_roots=[...])
client.submit_ticket_add_label(run_id, "ticket_123", "priority/high", workspace_roots=[...])
client.submit_ticket_remove_label(run_id, "ticket_123", "priority/high", workspace_roots=[...])
client.submit_ticket_assign_user(run_id, "ticket_123", "user_alice", workspace_roots=[...])
client.submit_ticket_unassign_user(run_id, "ticket_123", "user_alice", workspace_roots=[...])
```

---

## Approvals

```python
# List (filters: run_id, status, limit)
approvals = client.list_approvals(run_id=run_id, status="pending")

# Paginated inbox
inbox = client.query_approval_inbox(run_id=run_id, status="pending")

# Approve or deny (decision: "approve" or "deny" — not "reject")
client.resolve_approval("apr_123", "approve", "reviewed, looks safe")
client.resolve_approval("apr_123", "deny", "outside expected workspace scope")
```

---

## Inspection

### Timeline

```python
# Visibility: "user" | "model" | "internal" | "sensitive_internal"
timeline = client.query_timeline(run_id, visibility="internal")
for step in timeline["steps"]:
    print(f"Step {step['step_number']}: {step['summary']} [{step['outcome']}]")
```

### Helper Q&A

```python
# Query type is an enum value — not a free-form string
# Types: run_summary | what_happened | summarize_after_boundary
#        step_details | explain_policy_decision | reversible_steps
#        why_blocked | likely_cause | suggest_likely_cause
#        what_changed_after_step | revert_impact | preview_revert_loss
#        what_would_i_lose_if_i_revert_here | external_side_effects
#        identify_external_effects | list_actions_touching_scope | compare_steps

answer = client.query_helper(run_id, "what_happened")
cause = client.query_helper(run_id, "likely_cause")

# With focus step
details = client.query_helper(run_id, "step_details", focus_step_id="step_01")

# Compare two steps
comparison = client.query_helper(run_id, "compare_steps",
                                  focus_step_id="step_01",
                                  compare_step_id="step_05")

# With visibility
effects = client.query_helper(run_id, "external_side_effects", visibility="internal")
```

### Artifacts

```python
artifact = client.query_artifact("art_abc", visibility="internal")
print(artifact["body"])  # truncated at 8192 chars inline
```

---

## Recovery

```python
# Plan recovery for an action or snapshot
plan = client.plan_recovery("act_xyz")
print(plan["strategy"])    # e.g. "restore_from_snapshot"
print(plan["confidence"])  # 0.0-1.0
print(plan["steps"])

# Preview only (no executable plan created)
preview = client.plan_recovery("act_xyz", preview_only=True)

# Execute
result = client.execute_recovery("act_xyz")
print(result["success"])
```

---

## Policy

```python
policy = client.get_effective_policy()
validation = client.validate_policy_config(my_policy_doc)
outcome = client.explain_policy_action(attempt)

report = client.get_policy_calibration_report(run_id=run_id, include_samples=True)
recs = client.get_policy_threshold_recommendations(run_id=run_id, min_samples=5)
replay = client.replay_policy_thresholds(
    candidate_thresholds={"filesystem.write": 0.75},
    run_id=run_id,
    include_changed_samples=True,
)
```

---

## MCP Management

```python
# Simple registry
servers = client.list_mcp_servers()
client.upsert_mcp_server({
    "server_id": "my_server",
    "transport": "streamable_http",
    "url": "https://api.example.com/mcp",
    "network_scope": "public_https",
    "auth": {"type": "bearer_secret_ref", "secret_id": "my_key"},
    "tools": [{"tool_name": "search", "side_effect_level": "read_only", "approval_mode": "allow"}],
})
client.remove_mcp_server("my_server")

# Trust review workflow
client.submit_mcp_server_candidate({"source_kind": "user_input", "raw_endpoint": "https://..."})
candidates = client.list_mcp_server_candidates()
client.resolve_mcp_server_candidate({"candidate_id": "cand_abc", "display_name": "My Server"})
profiles = client.list_mcp_server_profiles()
client.approve_mcp_server_profile({
    "server_profile_id": "prof_abc",
    "decision": "allow_policy_managed",
    "trust_tier": "operator_approved_public",
    "allowed_execution_modes": ["local_proxy"],
    "reason_codes": ["INITIAL_REVIEW_COMPLETE"],
})
client.bind_mcp_server_credentials({
    "server_profile_id": "prof_abc",
    "binding_mode": "bearer_secret_ref",
    "broker_profile_id": "my_key",
})
client.activate_mcp_server_profile("prof_abc")

# Secrets
client.upsert_mcp_secret({"secret_id": "my_key", "display_name": "My Key", "bearer_token": "sk-..."})
secrets = client.list_mcp_secrets()  # metadata only
client.remove_mcp_secret("my_key")

# Host policies
client.upsert_mcp_host_policy({"host": "api.example.com", "allowed_ports": [443]})
policies = client.list_mcp_host_policies()
client.remove_mcp_host_policy("api.example.com")
```

---

## Diagnostics & Maintenance

```python
diag = client.diagnostics(components=["daemon_health", "journal_health"])

result = client.run_maintenance([
    "sqlite_wal_checkpoint",
    "snapshot_gc",
    "artifact_expiry",
])
```

---

## Idempotency

All mutation methods accept `idempotency_key`:

```python
run = client.register_run(payload, idempotency_key="run-session-2026-04-03")
client.resolve_approval("apr_123", "approve", "ok", idempotency_key="approve-apr-123")
```

---

## Running Tests

```bash
# From repo root
pnpm py:test

# Or directly
PYTHONPATH=packages/authority-sdk-py \
python3 -m unittest discover -s packages/authority-sdk-py/tests -v
```

---

## Running the Example

With the daemon running:

```bash
# From repo root
pnpm smoke:py

# Or directly
PYTHONPATH=packages/authority-sdk-py \
python3 packages/authority-sdk-py/examples/governed_run.py \
  --workspace-root "$(pwd)"
```

---

## Related

- [TypeScript SDK](TypeScript-SDK.md) — TypeScript equivalent
- [CLI Reference](CLI-Reference.md) — operator-side management
- [Getting Started](Getting-Started.md)
