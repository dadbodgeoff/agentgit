# @agentgit/authority-cli

Operator CLI for the local-first `agentgit` authority daemon.

## Install

```bash
npm install -g @agentgit/authority-cli
agentgit-authority setup
agentgit-authority daemon start
```

The CLI now ships with the public `@agentgit/authority-daemon` package as a dependency, so the recommended first-run path is:

1. `agentgit-authority setup`
2. `agentgit-authority daemon start`
3. In a second terminal: `agentgit-authority doctor`

You can still use explicit flags or the layered CLI config/profile surface to point the CLI at a different workspace or socket.

## Compatibility

- Node.js `24.14.0+`
- local daemon API `authority.v1`

## Examples

```bash
agentgit-authority --json version
agentgit-authority --json setup --profile-name local
agentgit-authority --json daemon start
agentgit-authority --json init --production --profile-name prod
agentgit-authority --json trust-report --run-id run_123
agentgit-authority --json onboard-mcp ./onboard-plan.json
agentgit-authority --json trust-review-mcp ./trust-review-plan.json
agentgit-authority --json release-verify-artifacts ./.release-artifacts/packed --signature-mode required --public-key-path ./release-public.pem
agentgit-authority --json cloud-roadmap
agentgit-authority --json ping --socket-path /absolute/path/to/authority.sock --workspace-root /absolute/path/to/workspace
agentgit-authority --json doctor --socket-path /absolute/path/to/authority.sock --workspace-root /absolute/path/to/workspace
agentgit-authority --json policy show
agentgit-authority --json policy explain ./attempt.json
agentgit-authority --json policy calibration-report --run-id run_123 --include-samples
agentgit-authority --json policy recommend-thresholds --run-id run_123 --min-samples 5
agentgit-authority --json policy replay-thresholds --run-id run_123 --min-samples 5 --direction all --include-changed-samples --sample-limit 20
agentgit-authority --json policy diff ./policy.toml
agentgit-authority --json policy render-threshold-patch --run-id run_123 --min-samples 5 --direction all
agentgit-authority --json run-audit-export run_123 ./audit-bundle internal
agentgit-authority --json run-audit-verify ./audit-bundle
agentgit-authority --json run-audit-report ./audit-bundle
agentgit-authority --json run-audit-share ./audit-bundle ./audit-share
agentgit-authority --json run-audit-compare ./audit-bundle ./other-audit-bundle
```

## Policy Operations

The CLI now supports a full operator policy-hardening loop:

- `policy show` displays the merged effective policy, including low-confidence thresholds
- `policy explain <attempt-json-or-path>` previews how a candidate action would be classified without executing it
- `policy calibration-report` summarizes observed policy outcomes, approvals, recovery linkage, and confidence calibration quality
- `policy recommend-thresholds` produces report-only threshold guidance from calibration history
- `policy replay-thresholds` replays candidate thresholds against real journaled actions before rollout
- `policy diff <path>` compares a candidate policy file against the current effective policy as an overlay proposal
- `policy render-threshold-patch` renders a report-only TOML snippet from threshold recommendations and includes replay impact summary

Important safety boundary:

- recommendation, replay, and patch-render commands never mutate live policy
- threshold relaxation still requires an explicit human-reviewed policy file change
- `policy diff` compares the candidate file as an overlay, so omitted rules may still exist from other loaded policy sources

## Enterprise Audit Workflows

The CLI now ships a full run-audit loop for operator evidence handling:

- `run-audit-export` writes a governed bundle with run summary, timeline, approvals, diagnostics, and exported artifact bodies
- `run-audit-verify` checks bundle integrity and tamper state
- `run-audit-report` summarizes a verified bundle for operator review
- `run-audit-share` creates a share package that withholds artifact content by default unless explicitly included
- `run-audit-compare` compares two bundles and exits non-zero when they are not equivalent

These commands are tested against the built CLI binary and a live local daemon.

## Production Bootstrap And Trust

- `setup` writes a beginner-friendly local profile, ensures the required local directories exist, and prints the next daemon/doctor commands.
- `daemon start` starts the packaged local daemon using the active CLI config/profile and keeps it in the foreground.
- `init --production` writes a hardened profile to user config, sets it active, and runs `doctor` immediately.
- `trust-report` produces a current trust posture snapshot (daemon reachability, security posture, MCP trust state, optional run timeline trust summary).

## MCP Onboarding Workflow

`onboard-mcp <plan-json-or-path>` orchestrates real daemon operations for:

- managed secrets (`upsert_mcp_secret`)
- public host allowlists (`upsert_mcp_host_policy`)
- server registration (`upsert_mcp_server`)
- optional smoke-test tool invocation (`submit_action_attempt` with `mcp_call_tool`)

Example plan:

```json
{
  "secrets": [
    {
      "secret_id": "notion_secret",
      "display_name": "Notion bearer",
      "bearer_token": "replace-me"
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
    "display_name": "Notion public MCP",
    "transport": "streamable_http",
    "url": "https://api.notion.com/mcp",
    "network_scope": "public_https",
    "auth": {
      "type": "bearer_secret_ref",
      "secret_id": "notion_secret"
    },
    "tools": [
      {
        "tool_name": "echo_note",
        "side_effect_level": "read_only",
        "approval_mode": "allow"
      }
    ]
  }
}
```

## MCP Trust Review Workflow

`trust-review-mcp <plan-json-or-path>` executes the governed promotion path for a real MCP endpoint:

- optional managed secret creation (`upsert_mcp_secret`)
- optional public host allowlists (`upsert_mcp_host_policy`)
- candidate submission (`submit_mcp_server_candidate`)
- profile resolution (`resolve_mcp_server_candidate`)
- trust approval (`approve_mcp_server_profile`)
- optional credential binding (`bind_mcp_server_credentials`)
- optional activation (`activate_mcp_server_profile`)
- optional smoke-test tool invocation against the approved profile (`submit_action_attempt` with `mcp_call_tool`)
- final review snapshot (`get_mcp_server_review`)

Example plan:

```json
{
  "secrets": [
    {
      "secret_id": "remote_secret",
      "display_name": "Remote MCP bearer",
      "bearer_token": "replace-me"
    }
  ],
  "candidate": {
    "source_kind": "user_input",
    "raw_endpoint": "http://127.0.0.1:8787/mcp",
    "transport_hint": "streamable_http",
    "notes": "Initial operator trust review"
  },
  "resolve": {
    "display_name": "Remote MCP"
  },
  "approval": {
    "decision": "allow_policy_managed",
    "trust_tier": "operator_approved_public",
    "allowed_execution_modes": ["local_proxy"],
    "reason_codes": ["INITIAL_REVIEW_COMPLETE"]
  },
  "credential_binding": {
    "binding_mode": "bearer_secret_ref",
    "broker_profile_id": "remote_secret",
    "scope_labels": ["remote:mcp"]
  },
  "activate": true,
  "smoke_test": {
    "tool_name": "echo_note",
    "arguments": {
      "note": "launch check"
    }
  }
}
```

## Release Signature Verification

- `release-verify-artifacts` verifies `manifest.json`, `manifest.sha256`, package SHA256 checks, and optional signature validation via `manifest.sig`.
- public keys can be supplied via `--public-key-path`, `AGENTGIT_RELEASE_SIGNING_PUBLIC_KEY_PEM`, or `AGENTGIT_RELEASE_SIGNING_PUBLIC_KEY_PEM_B64`.

## Cloud-Later Contract Clarity

- `cloud-roadmap` prints the explicit deferred hosted/cloud phases and MVP exclusions.
- this command is contract clarity only and does not change daemon/runtime state.
