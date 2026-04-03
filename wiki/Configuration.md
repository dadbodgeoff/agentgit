# Configuration

agentgit is configured through environment variables, a TOML CLI config file, named profiles, and a TOML policy file.

---

## Default Paths

All daemon paths are relative to `AGENTGIT_ROOT`, which defaults to the current working directory (i.e., your project root).

```
<project-root>/
  .agentgit/
    authority.sock                      # Unix socket (created at daemon start)
    state/
      authority.db                      # Main SQLite journal database
      snapshots/                        # Snapshot content storage
      mcp/
        registry.db                     # MCP server registry
        secret-store.db                 # Encrypted secret store metadata
        secret-store.key                # Secret encryption key
        host-policies.db                # Host allowlist policies
        concurrency-leases.db           # Per-server concurrency leases
        hosted-worker.sock              # Hosted worker Unix socket
    policy.toml                         # Workspace-level policy overrides
    policy.calibration.generated.json   # Auto-generated calibration output

~/.config/agentgit/
  authority-cli.toml                    # CLI configuration (profiles, defaults)
  authority-policy.toml                 # Global policy (applies to all workspaces)
```

---

## Environment Variables

### Core Paths

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENTGIT_ROOT` | `process.cwd()` | Project root; all relative defaults resolve from here |
| `AGENTGIT_INIT_CWD` | — | Alternative to `AGENTGIT_ROOT` |
| `AGENTGIT_SOCKET_PATH` | `<root>/.agentgit/authority.sock` | Unix socket path |
| `AGENTGIT_JOURNAL_PATH` | `<root>/.agentgit/state/authority.db` | SQLite journal |
| `AGENTGIT_SNAPSHOT_ROOT` | `<root>/.agentgit/state/snapshots` | Snapshot storage |

### MCP Paths

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENTGIT_MCP_REGISTRY_PATH` | `<root>/.agentgit/state/mcp/registry.db` | MCP server registry |
| `AGENTGIT_MCP_SECRET_STORE_PATH` | `<root>/.agentgit/state/mcp/secret-store.db` | Encrypted secret store |
| `AGENTGIT_MCP_SECRET_KEY_PATH` | `<root>/.agentgit/state/mcp/secret-store.key` | Secret encryption key |
| `AGENTGIT_MCP_HOST_POLICY_PATH` | `<root>/.agentgit/state/mcp/host-policies.db` | Host allowlist |
| `AGENTGIT_MCP_CONCURRENCY_LEASE_PATH` | `<root>/.agentgit/state/mcp/concurrency-leases.db` | Concurrency leases |

### MCP Hosted Worker

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENTGIT_MCP_HOSTED_WORKER_ENDPOINT` | `unix:<root>/.agentgit/state/mcp/hosted-worker.sock` | Worker endpoint |
| `AGENTGIT_MCP_HOSTED_WORKER_AUTOSTART` | `"true"` | Auto-start hosted worker |
| `AGENTGIT_MCP_HOSTED_WORKER_CONTROL_TOKEN` | — | Optional control token |
| `AGENTGIT_MCP_HOSTED_WORKER_ATTESTATION_KEY_PATH` | — | Attestation key path |
| `AGENTGIT_MCP_HOSTED_WORKER_COMMAND` | — | Custom worker command |
| `AGENTGIT_MCP_HOSTED_WORKER_ARGS` | — | Newline-separated args |

### Policy Paths

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENTGIT_POLICY_GLOBAL_CONFIG_PATH` | `~/.config/agentgit/authority-policy.toml` | Global policy (all workspaces) |
| `AGENTGIT_POLICY_WORKSPACE_CONFIG_PATH` | `<root>/.agentgit/policy.toml` | Workspace policy override |
| `AGENTGIT_POLICY_CALIBRATION_CONFIG_PATH` | `<root>/.agentgit/policy.calibration.generated.json` | Calibration output |
| `AGENTGIT_POLICY_CONFIG_PATH` | — | Single-file override for all policy sources |

### Runtime Behaviour

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENTGIT_ARTIFACT_RETENTION_MS` | `null` (keep forever) | Artifact retention in milliseconds |
| `AGENTGIT_SQLITE_JOURNAL_MODE` | `"WAL"` | SQLite journal mode: `"WAL"` or `"DELETE"` |
| `AGENTGIT_CAPABILITY_REFRESH_STALE_MS` | `300000` (5 min) | Capability cache TTL |

### Integration

| Variable | Description |
|----------|-------------|
| `AGENTGIT_TICKETS_BASE_URL` | Base URL for the tickets integration |
| `AGENTGIT_TICKETS_BEARER_TOKEN` | API token for the tickets integration |
| `AGENTGIT_MCP_SERVERS_JSON` | JSON array of MCP server definitions to pre-load |

### Release Verification

| Variable | Description |
|----------|-------------|
| `AGENTGIT_RELEASE_SIGNING_PUBLIC_KEY_PEM` | RSA public key PEM for artifact verification |
| `AGENTGIT_RELEASE_SIGNING_PUBLIC_KEY_PEM_B64` | Same, base64-encoded |

---

## CLI Configuration File (TOML)

Location: `~/.config/agentgit/authority-cli.toml` (or `$XDG_CONFIG_HOME/agentgit/authority-cli.toml`).
Workspace override: `<workspace-root>/.agentgit/authority-cli.toml`.

```toml
schema_version = "agentgit.cli.config.v1"
active_profile = "default"

[defaults]
workspace_root = "/path/to/my-agent-project"
socket_path = "/path/to/my-agent-project/.agentgit/authority.sock"
connect_timeout_ms = 1000
response_timeout_ms = 5000
max_connect_retries = 1
connect_retry_delay_ms = 50

[profiles.dev]
workspace_root = "/home/user/projects/my-agent"

[profiles.prod]
workspace_root = "/srv/agent"
socket_path = "/var/run/agentgit/authority.sock"
response_timeout_ms = 10000
max_connect_retries = 3
connect_retry_delay_ms = 200
```

**Profile name rules:** `^[a-zA-Z0-9._-]+$` (normalized to lowercase)

### Managing profiles via CLI

```bash
agentgit-authority setup                              # writes default profile
agentgit-authority profile upsert prod \
  --workspace-root /srv/agent \
  --response-timeout-ms 10000
agentgit-authority profile use prod
agentgit-authority config show
```

---

## Policy Configuration File (TOML)

Two locations, merged in order (workspace overrides global):
- **Global:** `~/.config/agentgit/authority-policy.toml`
- **Workspace:** `<project-root>/.agentgit/policy.toml`

### Format

```toml
schema_version = "policy-config.v1"
profile_name = "my-workspace"

# Rules are evaluated in order; first match wins
[[rules]]
match = { action_type = "filesystem.write" }
decision = "allow_with_snapshot"

[[rules]]
match = { action_type = "filesystem.delete" }
decision = "ask"

[[rules]]
match = { operation_domain = "shell" }
decision = "ask"

[[rules]]
match = { operation_domain = "mcp", server_id = "trusted-local-server" }
decision = "allow"

[[rules]]
match = { operation_domain = "mcp" }
decision = "ask"

# Low-confidence thresholds (actions below these trigger their rule's decision)
[thresholds.low_confidence]
"filesystem.write" = 0.75
"filesystem.delete" = 0.90
"shell.execute" = 0.85
"mcp.call_tool" = 0.70
```

### Validate your policy file

```bash
agentgit-authority policy validate ~/.config/agentgit/authority-policy.toml
```

### View the merged effective policy

```bash
agentgit-authority policy show
```

---

## Inspector UI

The inspector UI reads from two environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENTGIT_INSPECTOR_PORT` | `4317` | HTTP port |
| `AGENTGIT_INSPECTOR_HOST` | `127.0.0.1` | Bind address |

---

## Node.js Requirement

Node.js 24.14.0 or newer. Verify:

```bash
node --version
```

---

## SQLite Native Build

`better-sqlite3` compiles a native addon. If you see build errors:

```bash
# macOS
xcode-select --install

# Ubuntu/Debian
apt-get install -y python3 build-essential
```

The monorepo `.npmrc` pins `better-sqlite3` as an approved native build dependency.
