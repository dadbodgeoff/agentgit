# @agentgit/authority-daemon

Local authority daemon runtime for agentgit.

The daemon is the heart of the system. It listens on a Unix socket, manages all eight governance subsystems, and serves every request from the TypeScript SDK, Python SDK, and CLI.

---

## Install

**Recommended:** Install the CLI, which bundles the daemon:

```bash
npm install -g @agentgit/authority-cli
agentgit-authority setup
agentgit-authority daemon start
```

Or install the daemon directly:

```bash
npm install -g @agentgit/authority-daemon
agentgit-authorityd
```

## Compatibility

- Node.js `24.14.0+`
- daemon API `authority.v1`
- runtime version `0.1.0`

---

## Default Paths

All paths resolve relative to `AGENTGIT_ROOT` (defaults to `process.cwd()`):

```
<AGENTGIT_ROOT>/
  .agentgit/
    authority.sock                    # Unix socket
    state/
      authority.db                    # SQLite journal
      snapshots/                      # Snapshot content
      mcp/
        registry.db
        secret-store.db
        secret-store.key
        host-policies.db
        concurrency-leases.db
        hosted-worker.sock

~/.config/agentgit/
  authority-policy.toml               # Global policy (all workspaces)
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENTGIT_ROOT` | `process.cwd()` | Project root |
| `AGENTGIT_INIT_CWD` | — | Alternative to `AGENTGIT_ROOT` |
| `AGENTGIT_SOCKET_PATH` | `<root>/.agentgit/authority.sock` | Unix socket |
| `AGENTGIT_JOURNAL_PATH` | `<root>/.agentgit/state/authority.db` | SQLite journal |
| `AGENTGIT_SNAPSHOT_ROOT` | `<root>/.agentgit/state/snapshots` | Snapshots |
| `AGENTGIT_MCP_REGISTRY_PATH` | `<root>/.agentgit/state/mcp/registry.db` | MCP registry |
| `AGENTGIT_MCP_SECRET_STORE_PATH` | `<root>/.agentgit/state/mcp/secret-store.db` | Secret store |
| `AGENTGIT_MCP_SECRET_KEY_PATH` | `<root>/.agentgit/state/mcp/secret-store.key` | Secret key |
| `AGENTGIT_MCP_HOST_POLICY_PATH` | `<root>/.agentgit/state/mcp/host-policies.db` | Host policies |
| `AGENTGIT_MCP_CONCURRENCY_LEASE_PATH` | `<root>/.agentgit/state/mcp/concurrency-leases.db` | Concurrency leases |
| `AGENTGIT_MCP_HOSTED_WORKER_ENDPOINT` | `unix:<root>/.agentgit/state/mcp/hosted-worker.sock` | Hosted worker |
| `AGENTGIT_MCP_HOSTED_WORKER_AUTOSTART` | `"true"` | Auto-start worker |
| `AGENTGIT_POLICY_GLOBAL_CONFIG_PATH` | `~/.config/agentgit/authority-policy.toml` | Global policy |
| `AGENTGIT_POLICY_WORKSPACE_CONFIG_PATH` | `<root>/.agentgit/policy.toml` | Workspace policy |
| `AGENTGIT_POLICY_CALIBRATION_CONFIG_PATH` | `<root>/.agentgit/policy.calibration.generated.json` | Calibration output |
| `AGENTGIT_POLICY_CONFIG_PATH` | — | Single-file policy override |
| `AGENTGIT_ARTIFACT_RETENTION_MS` | `null` (keep forever) | Artifact retention |
| `AGENTGIT_SQLITE_JOURNAL_MODE` | `"WAL"` | `"WAL"` or `"DELETE"` |
| `AGENTGIT_TICKETS_BASE_URL` | — | Tickets integration URL |
| `AGENTGIT_TICKETS_BEARER_TOKEN` | — | Tickets API token |
| `AGENTGIT_MCP_SERVERS_JSON` | — | JSON array of MCP servers to pre-load |

---

## Daemon Methods (48 total)

### Query methods
`hello`, `get_run_summary`, `get_capabilities`, `get_effective_policy`, `get_policy_calibration_report`, `get_policy_threshold_recommendations`, `list_mcp_servers`, `list_mcp_server_candidates`, `list_mcp_server_profiles`, `list_mcp_server_credential_bindings`, `list_mcp_server_trust_decisions`, `list_mcp_secrets`, `list_mcp_host_policies`, `list_hosted_mcp_jobs`, `get_hosted_mcp_job`, `list_approvals`, `query_approval_inbox`, `query_timeline`, `query_helper`, `query_artifact`, `diagnostics`, `get_mcp_server_review`

### Mutation methods (idempotent)
`register_run`, `submit_mcp_server_candidate`, `resolve_mcp_server_candidate`, `approve_mcp_server_profile`, `activate_mcp_server_profile`, `quarantine_mcp_server_profile`, `revoke_mcp_server_profile`, `bind_mcp_server_credentials`, `revoke_mcp_server_credentials`, `upsert_mcp_server`, `remove_mcp_server`, `upsert_mcp_secret`, `remove_mcp_secret`, `upsert_mcp_host_policy`, `remove_mcp_host_policy`, `requeue_hosted_mcp_job`, `cancel_hosted_mcp_job`, `validate_policy_config`, `explain_policy_action`, `replay_policy_thresholds`, `submit_action_attempt`, `resolve_approval`, `execute_recovery`, `run_maintenance`

---

## IPC Protocol

**Transport:** Unix domain socket (stream)
**Message format:** Custom JSON envelope (not standard JSON-RPC)

```json
// Request
{
  "api_version": "authority.v1",
  "request_id": "<uuid-v7>",
  "session_id": "<session-id>",
  "method": "<DaemonMethod>",
  "idempotency_key": "<optional>",
  "payload": {}
}

// Response
{
  "api_version": "authority.v1",
  "request_id": "<uuid-v7>",
  "ok": true,
  "result": {},
  "error": null
}
```

---

## Startup Sequence

1. Load config from environment variables
2. Open and migrate SQLite journal
3. Bind Unix socket
4. Reconcile in-progress runs from previous session (`startup_reconcile_recoveries`)
5. Warm timeline helper fact caches for active runs
6. Begin accepting IPC connections

---

## Related

- [`@agentgit/authority-cli`](../authority-cli/README.md) — CLI, bundles the daemon
- [`@agentgit/authority-sdk`](../authority-sdk-ts/README.md) — TypeScript client
- [`@agentgit/authority-sdk-py`](../authority-sdk-py/README.md) — Python client
- [`@agentgit/schemas`](../schemas/README.md) — IPC protocol types
