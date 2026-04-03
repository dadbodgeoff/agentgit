# Audit & Evidence

agentgit records every action, policy decision, approval, snapshot, and execution result in an append-only SQLite journal. This page covers how to inspect, export, verify, and share run evidence.

---

## Visibility Scopes

All inspection and export operations accept a **visibility scope** that controls which data is surfaced:

| Scope | What's included |
|-------|----------------|
| `user` | User-visible data only |
| `model` | User + model interaction data |
| `internal` | User + model + internal reasoning and artifacts |
| `sensitive_internal` | All data, including credentials and system internals |

Default for most commands is `user`. Use `internal` for incident review. Use `sensitive_internal` only when debugging daemon internals.

---

## What Gets Recorded

Every run produces a durable, tamper-detectable record of:

- Every action the agent submitted (normalized with full provenance)
- Policy outcome for each action (`allow`, `deny`, `ask`, `simulate`, `allow_with_snapshot`)
- Approval requests and operator decisions with notes
- Snapshot boundaries captured before recoverable actions
- Execution results for each adapter call
- Artifacts (stdout, stderr, file content, API responses) with visibility and truncation metadata
- Recovery plans and execution results

All of this persists in `<project-root>/.agentgit/state/authority.db` (SQLite) until explicitly cleaned up.

---

## Inspecting a Run

### Timeline
```bash
agentgit-authority timeline run_abc
agentgit-authority timeline run_abc internal
agentgit-authority --json timeline run_abc
```

### Run summary
```bash
agentgit-authority run-summary run_abc
agentgit-authority --json run-summary run_abc
```

### Helper Q&A (grounded from journal records — no LLM)
```bash
agentgit-authority helper run_abc what_happened
agentgit-authority helper run_abc likely_cause
agentgit-authority helper run_abc reversible_steps internal
agentgit-authority helper run_abc external_side_effects
```

→ Full query type list: [CLI Reference: helper](CLI-Reference.md#timeline--artifacts)

### Artifacts
```bash
# View inline (truncated at 8192 chars)
agentgit-authority artifact <artifact-id> internal

# Export full body to disk (no truncation)
agentgit-authority artifact-export <artifact-id> ./exports/output.txt internal
```

---

## Audit Bundle Workflow

### 1. Export

```bash
# Internal bundle — for incident review (includes artifact bodies)
agentgit-authority run-audit-export run_abc ./audit-bundle internal

# User-scope bundle — for sharing (no artifact bodies by default)
agentgit-authority run-audit-export run_abc ./audit-bundle-share user
```

The bundle contains:
```
audit-bundle/
  run-summary.json      # High-level run state
  timeline.json         # Full ordered step history
  approvals.json        # All approval requests and decisions
  diagnostics.json      # Daemon state at export time
  artifacts/            # Artifact bodies (internal/sensitive_internal only)
  manifest.json         # SHA256 integrity hashes for all files
  export-metadata.json  # Export timestamp, version, visibility scope
```

### 2. Verify

```bash
agentgit-authority run-audit-verify ./audit-bundle
# Exit code 0: bundle is intact and untampered
# Exit code 1: tamper detected, missing files, or hash mismatch
```

Recomputes SHA256 hashes against `manifest.json`. Fails closed on any discrepancy.

### 3. Report

```bash
agentgit-authority run-audit-report ./audit-bundle
```

Summarizes the verified bundle: action counts, outcome breakdown, approval decisions, recovery status, any anomalies.

### 4. Share

```bash
# Share package — artifact bodies omitted by default
agentgit-authority run-audit-share ./audit-bundle ./audit-share

# Include artifact bodies in the share (explicit)
agentgit-authority run-audit-share ./audit-bundle ./audit-share include-artifact-content
```

The share package strips artifact bodies per the visibility policy so you can share evidence without exposing sensitive output.

### 5. Compare

```bash
# Verify two exports of the same run match (tamper detection across time)
agentgit-authority run-audit-compare ./audit-v1 ./audit-v2
# Exit code 0: equivalent; exit code 1: drift detected
```

---

## Trust Report

```bash
agentgit-authority trust-report
agentgit-authority trust-report --run-id run_abc
agentgit-authority trust-report --visibility internal
agentgit-authority --json trust-report
```

Shows: daemon reachability, storage health, security posture (OS keychain/Secret Service availability), MCP trust state, policy summary.

---

## Tamper Detection

The audit bundle includes SHA256 hashes of every file in `manifest.json`. `run-audit-verify` recomputes hashes and exits non-zero if any discrepancy is found.

The underlying journal is SQLite append-only — records are never updated after being written. Tamper detection is an additional verification layer on top of this structural property.

---

## Diagnostics

```bash
# All components
agentgit-authority diagnostics
agentgit-authority --json diagnostics

# Specific components
agentgit-authority diagnostics daemon_health journal_health security_posture
```

Available components: `daemon_health`, `journal_health`, `maintenance_backlog`, `projection_lag`, `storage_summary`, `capability_summary`, `policy_summary`, `security_posture`, `hosted_worker`, `hosted_queue`

---

## Maintenance & Retention

Trigger maintenance manually:
```bash
agentgit-authority maintenance artifact_expiry artifact_orphan_cleanup
agentgit-authority maintenance sqlite_wal_checkpoint
agentgit-authority --json maintenance snapshot_gc
```

Available jobs: `startup_reconcile_recoveries`, `sqlite_wal_checkpoint`, `projection_refresh`, `projection_rebuild`, `snapshot_gc`, `snapshot_compaction`, `snapshot_rebase_anchor`, `artifact_expiry`, `artifact_orphan_cleanup`, `capability_refresh`, `helper_fact_warm`, `policy_threshold_calibration`

Configure artifact retention via environment variable:
```bash
AGENTGIT_ARTIFACT_RETENTION_MS=7776000000  # 90 days in ms
```

---

## Related

- [Core Concepts: The Run Journal](Core-Concepts.md#4-the-run-journal)
- [CLI Reference: audit commands](CLI-Reference.md#audit-bundles)
- [Architecture](Architecture.md)
