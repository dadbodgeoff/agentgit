# agentgit-authority

Thin Python SDK for the local AgentGit authority daemon.

## Usage

```python
from agentgit_authority import AuthorityClient, build_register_run_payload

client = AuthorityClient()
hello = client.hello()
run = client.register_run(
    build_register_run_payload(
        "demo",
        ["/path/to/workspace"],
    )
)
timeline = client.query_timeline(run["run_id"])
```

For governed attempts, you can either use convenience submitters:

```python
client.submit_filesystem_write(
    run["run_id"],
    "/path/to/workspace/README.md",
    "hello\n",
    workspace_roots=["/path/to/workspace"],
)
```

Or build a custom attempt for other tool kinds:

```python
from agentgit_authority import build_action_attempt

attempt = build_action_attempt(
    run["run_id"],
    tool_name="crm_update",
    tool_kind="mcp",
    raw_call={"operation": "update_contact", "contact_id": "123"},
    workspace_roots=["/path/to/workspace"],
)
client.submit_action_attempt(attempt)
```

The SDK intentionally stays thin:

- it speaks newline-delimited JSON over the local authority socket
- it mirrors the TypeScript SDK method surface
- it does not reimplement policy, snapshot, journal, or recovery logic
- it now includes MCP server/secret/host-policy management wrappers like `list_mcp_servers`, `list_mcp_secrets`, `list_mcp_host_policies`, `upsert_mcp_server`, `upsert_mcp_secret`, and `upsert_mcp_host_policy`

There are also thin workflow helpers for common operations:

```python
pending = client.list_pending_approvals(run["run_id"])
cause = client.likely_cause(run["run_id"])
summary = client.summarize_run(run["run_id"])
client.approve("apr_123", "looks safe")
client.submit_draft_create(
    run["run_id"],
    "Launch plan",
    "Ship the compensator carefully.",
    workspace_roots=["/path/to/workspace"],
)
client.submit_ticket_create(
    run["run_id"],
    "Launch blocker",
    "Credentialed adapters must use brokered auth.",
    workspace_roots=["/path/to/workspace"],
)
client.submit_ticket_update(
    run["run_id"],
    "ticket_existing",
    title="Updated blocker",
    body="Recovered ticket flow needs preimage restore.",
    workspace_roots=["/path/to/workspace"],
)
client.submit_ticket_close(
    run["run_id"],
    "ticket_existing",
    workspace_roots=["/path/to/workspace"],
)
client.submit_ticket_add_label(
    run["run_id"],
    "ticket_existing",
    "priority/high",
    workspace_roots=["/path/to/workspace"],
)
client.plan_recovery("act_123")
```

Recovery helpers accept either a snapshot id like `snap_123` or an action boundary id like `act_123`.

## Development

```bash
PYTHONPATH=packages/authority-sdk-py python3 -m unittest discover -s packages/authority-sdk-py/tests -v
```

## Example

Start the daemon in one terminal:

```bash
pnpm daemon:start
```

Then run the Python SDK example in another:

```bash
PYTHONPATH=packages/authority-sdk-py \
python3 packages/authority-sdk-py/examples/governed_run.py \
  --workspace-root /path/to/workspace
```

If the package is installed, the same demo is available as:

```bash
agentgit-authority-demo --workspace-root /path/to/workspace
```

The example will:

- open a daemon session
- register a governed run
- submit a filesystem write
- print the run summary and projected timeline
