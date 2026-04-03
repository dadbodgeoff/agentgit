# CLI Reference

Complete reference for `agentgit-authority` — the operator CLI for the local agentgit authority daemon.

**Install:**
```bash
npm install -g @agentgit/authority-cli
```

---

## Global Flags

These flags go before the subcommand:

| Flag | Description |
|------|-------------|
| `--json` | Machine-readable JSON output |
| `--profile <name>` | Use a named profile |
| `--config-root <path>` | Override config directory |
| `--workspace-root <path>` | Override workspace root |
| `--socket-path <path>` | Override Unix socket path |
| `--connect-timeout-ms <ms>` | Connection timeout (default: 1000) |
| `--response-timeout-ms <ms>` | Response timeout (default: 5000) |
| `--max-connect-retries <n>` | Retry count (default: 1) |
| `--connect-retry-delay-ms <ms>` | Retry delay (default: 50) |

**JSON flag position:** Always before the subcommand.
```bash
agentgit-authority --json timeline run_abc   ✓
agentgit-authority timeline --json run_abc   ✗
```

---

## Exit Codes

| Code | Constant | Meaning |
|------|----------|---------|
| 0 | `OK` | Success |
| 64 | `USAGE` | Usage error |
| 65 | `INPUT_INVALID` | Invalid input |
| 66 | `NOT_FOUND` | Resource not found |
| 69 | `UNAVAILABLE` | Service unavailable |
| 70 | `INTERNAL` | Internal error |
| 74 | `IO_ERROR` | I/O error |
| 75 | `TEMPORARY_FAILURE` | Temporary failure (retryable) |
| 77 | `PERMISSION_DENIED` | Permission denied |
| 78 | `CONFIG_ERROR` | Configuration error |

---

## System & Setup

### `version`
Show CLI and daemon version.
```bash
agentgit-authority version
agentgit-authority --json version
```

### `setup`
Write a local profile and prepare the `.agentgit/` data directory.
```bash
agentgit-authority setup
agentgit-authority setup --profile-name dev
agentgit-authority setup --force   # overwrite existing profile
```

### `init`
Write a production-hardened profile and immediately run `doctor`.
```bash
agentgit-authority init --production
agentgit-authority init --production --profile-name prod --force
```

### `daemon start`
Start the authority daemon in the foreground.
```bash
agentgit-authority daemon start
```

### `doctor`
Check daemon health, storage, security posture, and MCP trust state.
```bash
agentgit-authority doctor
agentgit-authority --json doctor
```

### `ping`
Quick round-trip daemon health check.
```bash
agentgit-authority ping
agentgit-authority --socket-path /path/to/authority.sock ping
```

---

## Configuration & Profiles

Config file location: `~/.config/agentgit/authority-cli.toml` (or `$XDG_CONFIG_HOME/agentgit/authority-cli.toml`).
Workspace override: `<workspace-root>/.agentgit/authority-cli.toml`.

### `config show`
Show resolved CLI configuration.
```bash
agentgit-authority config show
agentgit-authority --json config show
```

### `config validate`
Validate the CLI configuration file.
```bash
agentgit-authority config validate
```

### `profile list`
List all named profiles.
```bash
agentgit-authority profile list
agentgit-authority --json profile list
```

### `profile show [name]`
Show a profile (defaults to active profile).
```bash
agentgit-authority profile show
agentgit-authority profile show prod
```

### `profile use <name>`
Set the active profile.
```bash
agentgit-authority profile use prod
```

### `profile upsert <name>`
Create or update a named profile.
```bash
agentgit-authority profile upsert dev \
  --workspace-root /path/to/workspace \
  --socket-path /path/to/authority.sock \
  --response-timeout-ms 10000
```

### `profile remove <name>`
Remove a named profile.
```bash
agentgit-authority profile remove old-dev
```

---

## Run Lifecycle

### `register-run [workflow-name] [max-mutating] [max-destructive]`
Register a new run with optional budget limits.
```bash
agentgit-authority register-run
agentgit-authority register-run my-agent-session
agentgit-authority register-run my-agent-session 100 10   # max 100 mutating, 10 destructive actions
agentgit-authority --json register-run my-agent-session
```

### `run-summary <run-id>`
Show a run summary.
```bash
agentgit-authority run-summary run_abc
agentgit-authority --json run-summary run_abc
```

### `capabilities [workspace-root]`
Show daemon capabilities (what adapters and features are available).
```bash
agentgit-authority capabilities
agentgit-authority capabilities /path/to/workspace
agentgit-authority --json capabilities
```

### `trust-report`
Current trust posture snapshot.
```bash
agentgit-authority trust-report
agentgit-authority trust-report --run-id run_abc
agentgit-authority trust-report --visibility internal
agentgit-authority --json trust-report
```

---

## Action Submission

### `submit-filesystem-write <run-id> <path> <content>`
Submit a governed file write.
```bash
agentgit-authority submit-filesystem-write run_abc /workspace/output.txt "hello world"
```

### `submit-filesystem-delete <run-id> <path>`
Submit a governed file or directory deletion.
```bash
agentgit-authority submit-filesystem-delete run_abc /workspace/temp.txt
```

### `submit-shell <run-id> <command...>`
Submit a governed shell command.
```bash
agentgit-authority submit-shell run_abc git status
agentgit-authority submit-shell run_abc echo "hello world"
```

### `submit-mcp-tool <run-id> <server-id> <tool-name> [arguments-json-or-path]`
Submit a governed MCP tool call to a registered server by server ID.
```bash
agentgit-authority submit-mcp-tool run_abc notion_public search_pages '{"query":"launch"}'
agentgit-authority submit-mcp-tool run_abc my_server my_tool ./args.json
```

### `submit-mcp-profile-tool <run-id> <server-profile-id> <tool-name> [arguments-json-or-path]`
Submit a governed MCP tool call by server profile ID (trust-reviewed servers).
```bash
agentgit-authority submit-mcp-profile-tool run_abc prof_abc123 search_pages '{"query":"test"}'
```

### `submit-draft-create <run-id> <title> <body>`
Create a governed draft.
```bash
agentgit-authority submit-draft-create run_abc "Launch plan" "Ship it carefully."
```

Other draft operations: `submit-draft-update`, `submit-draft-archive`, `submit-draft-unarchive`, `submit-draft-delete`, `submit-draft-restore`, `submit-draft-add-label`, `submit-draft-remove-label`

### `submit-note-create <run-id> <title> <body>`
Create a governed note.
```bash
agentgit-authority submit-note-create run_abc "Meeting notes" "Discussed recovery drills."
```

Other note operations: `submit-note-update`, `submit-note-archive`, `submit-note-unarchive`, `submit-note-delete`, `submit-note-restore`

### `submit-ticket-create <run-id> <title> <body>`
Create a governed ticket.
```bash
agentgit-authority submit-ticket-create run_abc "Fix auth bug" "Auth fails on retry."
```

Other ticket operations: `submit-ticket-update`, `submit-ticket-delete`, `submit-ticket-restore`, `submit-ticket-close`, `submit-ticket-reopen`, `submit-ticket-add-label`, `submit-ticket-remove-label`, `submit-ticket-assign-user`, `submit-ticket-unassign-user`

---

## Approvals

### `list-approvals [run-id] [status]`
List approval requests, optionally filtered by run and status.
```bash
agentgit-authority list-approvals
agentgit-authority list-approvals run_abc
agentgit-authority list-approvals run_abc pending    # pending | approved | denied
agentgit-authority --json list-approvals run_abc
```

### `approval-inbox [run-id] [status]`
Query the approval inbox (paginated view).
```bash
agentgit-authority approval-inbox
agentgit-authority approval-inbox run_abc pending
agentgit-authority --json approval-inbox run_abc
```

### `approve <approval-id> [note]`
Approve a pending approval request.
```bash
agentgit-authority approve apr_123
agentgit-authority approve apr_123 "reviewed, looks correct"
```

### `deny <approval-id> [note]`
Deny a pending approval request.
```bash
agentgit-authority deny apr_123
agentgit-authority deny apr_123 "outside expected workspace scope"
```

---

## Timeline & Artifacts

### `timeline <run-id> [visibility]`
Show the ordered timeline of steps for a run.

Visibility: `user` | `model` | `internal` | `sensitive_internal`

```bash
agentgit-authority timeline run_abc
agentgit-authority timeline run_abc internal
agentgit-authority --json timeline run_abc
```

### `helper <run-id> <query-type> [focus-step-id] [compare-step-id] [visibility]`
Answer a structured question about a run.

**Query types:**

| Query type | What it answers |
|------------|----------------|
| `run_summary` | High-level run status |
| `what_happened` | Narrative of what occurred |
| `summarize_after_boundary` | What happened after a specific step |
| `step_details` | Details of a specific step (requires `focus-step-id`) |
| `explain_policy_decision` | Why the policy made a specific decision |
| `reversible_steps` | Which steps can be reversed |
| `why_blocked` | Why a step is blocked |
| `likely_cause` | Most likely cause of a failure or block |
| `suggest_likely_cause` | Suggestions for the likely cause |
| `what_changed_after_step` | Changes after a step (requires `focus-step-id`) |
| `revert_impact` | Impact of reverting to a snapshot |
| `preview_revert_loss` | What would be lost if reverting |
| `what_would_i_lose_if_i_revert_here` | Data loss preview for a revert |
| `external_side_effects` | External effects of the run |
| `identify_external_effects` | Identify specific external effects |
| `list_actions_touching_scope` | Actions touching a path/scope |
| `compare_steps` | Compare two steps (requires `focus-step-id` and `compare-step-id`) |

```bash
agentgit-authority helper run_abc what_happened
agentgit-authority helper run_abc likely_cause
agentgit-authority helper run_abc step_details step_01
agentgit-authority helper run_abc compare_steps step_01 step_05
agentgit-authority helper run_abc reversible_steps internal
agentgit-authority --json helper run_abc what_happened
```

### `artifact <artifact-id> [visibility]`
View an artifact inline (may be truncated at 8192 chars).
```bash
agentgit-authority artifact art_abc
agentgit-authority artifact art_abc internal
agentgit-authority artifact art_abc sensitive_internal
```

### `artifact-export <artifact-id> <destination-path> [visibility]`
Export full artifact body to disk without truncation.
```bash
agentgit-authority artifact-export art_abc ./exports/stdout.txt
agentgit-authority artifact-export art_abc ./exports/stdout.txt internal
```

---

## Audit Bundles

### `run-audit-export <run-id> <output-dir> [visibility]`
Export a complete run evidence bundle.
```bash
agentgit-authority run-audit-export run_abc ./audit-bundle
agentgit-authority run-audit-export run_abc ./audit-bundle internal
agentgit-authority run-audit-export run_abc ./audit-bundle sensitive_internal
```

### `run-audit-verify <bundle-dir>`
Verify bundle integrity. Exit 0 = intact; exit 1 = tampered or missing evidence.
```bash
agentgit-authority run-audit-verify ./audit-bundle
```

### `run-audit-report <bundle-dir>`
Summarize a verified bundle for operator review.
```bash
agentgit-authority run-audit-report ./audit-bundle
```

### `run-audit-share <bundle-dir> <output-dir> [artifact-content-mode]`
Create a share package.

Artifact content mode: `omit-artifact-content` (default) | `include-artifact-content`

```bash
agentgit-authority run-audit-share ./audit-bundle ./audit-share
agentgit-authority run-audit-share ./audit-bundle ./audit-share include-artifact-content
```

### `run-audit-compare <left-bundle-dir> <right-bundle-dir>`
Compare two bundles for evidence drift. Exit 0 = equivalent; exit 1 = drift detected.
```bash
agentgit-authority run-audit-compare ./audit-v1 ./audit-v2
```

---

## Policy

### `policy show`
Show the current merged effective policy.
```bash
agentgit-authority policy show
agentgit-authority --json policy show
```

### `policy validate <path>`
Validate a policy config file.
```bash
agentgit-authority policy validate ./policy.toml
```

### `policy diff <path>`
Compare a candidate policy file against the current effective policy.
```bash
agentgit-authority policy diff ./policy-candidate.toml
agentgit-authority --json policy diff ./policy-candidate.toml
```

### `policy explain <attempt-json-or-path>`
Preview how a candidate action would be classified without executing.
```bash
agentgit-authority policy explain ./attempt.json
agentgit-authority --json policy explain '{"run_id":"run_abc",...}'
```

### `policy calibration-report`
Summarize observed policy outcomes, approval patterns, and confidence quality.
```bash
agentgit-authority policy calibration-report
agentgit-authority policy calibration-report --run-id run_abc
agentgit-authority policy calibration-report --run-id run_abc --include-samples --sample-limit 20
```

### `policy recommend-thresholds`
Data-driven threshold recommendations from calibration history.
```bash
agentgit-authority policy recommend-thresholds
agentgit-authority policy recommend-thresholds --run-id run_abc --min-samples 5
agentgit-authority --json policy recommend-thresholds --run-id run_abc
```

### `policy replay-thresholds`
Test candidate thresholds against real journaled actions before rollout.
```bash
agentgit-authority policy replay-thresholds --run-id run_abc
agentgit-authority policy replay-thresholds \
  --run-id run_abc \
  --candidate-policy ./policy-candidate.toml \
  --min-samples 5 \
  --direction all \
  --include-changed-samples \
  --sample-limit 20
```

### `policy render-threshold-patch`
Output a TOML snippet from threshold recommendations. Never applies automatically.
```bash
agentgit-authority policy render-threshold-patch --run-id run_abc
agentgit-authority policy render-threshold-patch --run-id run_abc --direction tighten
```

---

## Recovery

### `plan-recovery <snapshot-id|action-id>`
Plan recovery for a snapshot or action boundary.
```bash
agentgit-authority plan-recovery act_xyz
agentgit-authority plan-recovery snap_abc
agentgit-authority --json plan-recovery act_xyz
```

### `execute-recovery <snapshot-id|action-id>`
Execute a recovery target.
```bash
agentgit-authority execute-recovery act_xyz
agentgit-authority execute-recovery snap_abc
agentgit-authority --json execute-recovery act_xyz
```

---

## MCP Server Management

### Direct Registry Commands

```bash
# List registered servers
agentgit-authority list-mcp-servers
agentgit-authority --json list-mcp-servers

# Register or update a server
agentgit-authority upsert-mcp-server <definition-json-or-path>

# Remove a server
agentgit-authority remove-mcp-server <server-id>
```

### Trust Review Workflow

For formal approval of new endpoints. Step-by-step:

```bash
# 1. Submit a candidate for review
agentgit-authority submit-mcp-server-candidate <definition-json-or-path>

# 2. List pending candidates
agentgit-authority list-mcp-server-candidates

# 3. Resolve (build a profile from the candidate)
agentgit-authority resolve-mcp-server-candidate <definition-json-or-path>

# 4. List resolved profiles
agentgit-authority list-mcp-server-profiles

# 5. List trust decisions
agentgit-authority list-mcp-server-trust-decisions [server-profile-id]

# 6. Approve a profile
agentgit-authority approve-mcp-server-profile <definition-json-or-path>

# 7. Bind credentials to the approved profile
agentgit-authority list-mcp-server-credential-bindings [server-profile-id]
agentgit-authority bind-mcp-server-credentials <definition-json-or-path>
agentgit-authority revoke-mcp-server-credentials <credential-binding-id>

# 8. Activate the approved profile
agentgit-authority activate-mcp-server-profile <server-profile-id>

# 9. Quarantine or revoke if issues found
agentgit-authority quarantine-mcp-server-profile <definition-json-or-path>
agentgit-authority revoke-mcp-server-profile <definition-json-or-path>

# Review the full trust state
agentgit-authority show-mcp-server-review <candidate-id|server-profile-id>
```

### Orchestrated Workflows

```bash
# All-in-one onboarding (secrets + host policies + server + smoke test)
agentgit-authority onboard-mcp ./onboard-plan.json

# Formal trust review workflow
agentgit-authority trust-review-mcp ./trust-review-plan.json
```

---

## MCP Secrets

```bash
# List secrets (metadata only — no bearer tokens)
agentgit-authority list-mcp-secrets
agentgit-authority --json list-mcp-secrets

# Register or rotate a secret
# Bearer token is moved to OS keychain immediately
agentgit-authority upsert-mcp-secret <definition-json-or-path>
agentgit-authority upsert-mcp-secret \
  --secret-id my_key \
  --display-name "My API Key" \
  --bearer-token-file ./token.txt     # from file
agentgit-authority upsert-mcp-secret \
  --secret-id my_key \
  --bearer-token-stdin                # from stdin
agentgit-authority upsert-mcp-secret \
  --secret-id my_key \
  --prompt-bearer-token               # interactive prompt

# Remove a secret
agentgit-authority remove-mcp-secret <secret-id>
```

---

## MCP Host Policies

```bash
# List host policies
agentgit-authority list-mcp-host-policies
agentgit-authority --json list-mcp-host-policies

# Register or update a host policy
agentgit-authority upsert-mcp-host-policy <definition-json-or-path>

# Remove a host policy
agentgit-authority remove-mcp-host-policy <host>
```

---

## Hosted MCP Jobs

These commands manage jobs routed to the hosted MCP worker (future/configured feature).

```bash
# Show a specific job
agentgit-authority show-hosted-mcp-job <job-id>

# List jobs, optionally filtered by server profile and status
agentgit-authority list-hosted-mcp-jobs
agentgit-authority list-hosted-mcp-jobs <server-profile-id>
agentgit-authority list-hosted-mcp-jobs <server-profile-id> running
# Statuses: queued | running | cancel_requested | succeeded | failed | canceled | dead_letter_retryable | dead_letter_non_retryable

# Requeue a failed job
agentgit-authority requeue-hosted-mcp-job <job-id>
agentgit-authority requeue-hosted-mcp-job <job-id> --reset-attempts --max-attempts 3 --reason "retry after fix"

# Cancel a job
agentgit-authority cancel-hosted-mcp-job <job-id>
agentgit-authority cancel-hosted-mcp-job <job-id> --reason "no longer needed"
```

---

## Diagnostics & Maintenance

### `diagnostics [components...]`
Daemon diagnostics, optionally for specific components.

Components: `daemon_health`, `journal_health`, `maintenance_backlog`, `projection_lag`, `storage_summary`, `capability_summary`, `policy_summary`, `security_posture`, `hosted_worker`, `hosted_queue`

```bash
agentgit-authority diagnostics
agentgit-authority diagnostics daemon_health journal_health
agentgit-authority --json diagnostics
```

### `maintenance <job-type...>`
Trigger specific maintenance jobs.

Job types: `startup_reconcile_recoveries`, `sqlite_wal_checkpoint`, `projection_refresh`, `projection_rebuild`, `snapshot_gc`, `snapshot_compaction`, `snapshot_rebase_anchor`, `artifact_expiry`, `artifact_orphan_cleanup`, `capability_refresh`, `helper_fact_warm`, `policy_threshold_calibration`

```bash
agentgit-authority maintenance sqlite_wal_checkpoint snapshot_gc
agentgit-authority maintenance projection_rebuild
agentgit-authority --json maintenance artifact_expiry artifact_orphan_cleanup
```

---

## Release & Cloud

### `release-verify-artifacts [artifacts-dir]`
Verify release artifact signatures and checksums.
```bash
agentgit-authority release-verify-artifacts ./.release-artifacts/packed
agentgit-authority release-verify-artifacts ./.release-artifacts/packed --signature-mode required
agentgit-authority release-verify-artifacts ./.release-artifacts/packed \
  --signature-mode required \
  --public-key-path ./release-public.pem
```

### `cloud-roadmap`
Print explicit deferred hosted/cloud phases and MVP exclusions.
```bash
agentgit-authority cloud-roadmap
agentgit-authority --json cloud-roadmap
```
