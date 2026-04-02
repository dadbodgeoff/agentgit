# CLI Operator Runbook

## Scope

This runbook is for operating the day-one local production CLI surface:

- `@agentgit/authority-cli`
- `@agentgit/authority-sdk`
- `@agentgit/schemas`

It covers local daemon-backed operation, not hosted control-plane operation.

## Launch Boundary

This runbook assumes the current audited launch truth:

- supported governed execution: `filesystem`, `shell`, owned `function` integrations (`drafts`, `notes`, `tickets`), and operator-managed `mcp` tools over `stdio` and `streamable_http`
- unsupported governed surfaces fail closed
- browser/computer governance, generic governed HTTP, hosted MCP, and arbitrary remote/user/agent MCP registration are intentionally out of launch scope

## Prerequisites

- Node.js `24.14.0+`
- local authority daemon reachable via Unix socket
- workspace root path known to the operator

## Day-Zero Bring-Up

Start daemon and verify CLI contract:

```bash
pnpm daemon:start
pnpm cli -- --json version
pnpm cli -- --json ping
pnpm cli -- --json doctor
```

Expected healthy baseline:

- `version` returns `supported_api_version = authority.v1`
- `version` returns `json_contract_version = agentgit.cli.output.v1`
- `version` returns `exit_code_registry_version = agentgit.cli.exit-codes.v1`
- `doctor` reports daemon reachability and active checks

## Config And Profile Operations

Use profiles instead of repeating socket/workspace flags:

```bash
pnpm cli -- --json profile upsert local \
  --socket-path /absolute/path/to/authority.sock \
  --workspace-root /absolute/path/to/workspace
pnpm cli -- --json profile use local
pnpm cli -- --json profile show
pnpm cli -- --json config validate
pnpm cli -- --json doctor
```

If `config validate` fails, fix config before proceeding with mutating operations.

## Secure MCP Secret Handling

Do not pass bearer tokens inline in JSON command arguments.

Preferred secure paths:

- `--bearer-token-stdin`
- `--bearer-token-file`
- `--prompt-bearer-token` for interactive use

Example (stdin):

```bash
printf '%s' "$MCP_TOKEN" | pnpm cli -- --json upsert-mcp-secret \
  --secret-id public_api \
  --display-name "Public API" \
  --bearer-token-stdin
```

Example (file):

```bash
pnpm cli -- --json upsert-mcp-secret \
  --secret-id public_api \
  --display-name "Public API" \
  --bearer-token-file /secure/path/token.txt
```

## Public HTTPS MCP Guardrails

For `streamable_http` public endpoints:

1. Define host allowlist policy.
2. Store secret via secret ref.
3. Register MCP server with `public_https` scope.

The daemon fails closed when allowlist policy or required auth posture is missing.

## Evidence And Audit Workflow

Standard incident/evidence flow:

```bash
pnpm cli -- --json run-audit-export <run-id> ./audit-bundle internal
pnpm cli -- --json run-audit-verify ./audit-bundle
pnpm cli -- --json run-audit-report ./audit-bundle
pnpm cli -- --json run-audit-share ./audit-bundle ./audit-share
pnpm cli -- --json run-audit-compare ./audit-bundle ./audit-bundle-2
```

Rules:

- treat failed `run-audit-verify` as a hard stop for evidence trust
- use `run-audit-share` default redaction mode unless artifact-body disclosure is explicitly approved

## Policy Hardening Workflow

The operator policy loop is now:

1. inspect the effective policy
2. explain a candidate action before execution
3. review calibration history
4. review threshold recommendations
5. diff a candidate policy file against the current effective policy
6. render a report-only TOML threshold patch for manual review

Baseline commands:

```bash
pnpm cli -- --json policy show
pnpm cli -- --json policy explain ./attempt.json
pnpm cli -- --json policy calibration-report --run-id <run-id> --include-samples
pnpm cli -- --json policy recommend-thresholds --run-id <run-id> --min-samples 5
pnpm cli -- --json policy diff ./policy.toml
pnpm cli -- --json policy render-threshold-patch --run-id <run-id> --min-samples 5 --direction all
```

Operational rules:

- `policy explain` is preview-only and does not execute or journal the candidate action
- `policy recommend-thresholds` is report-only and never changes live policy
- `policy render-threshold-patch` emits a suggested TOML patch and never applies it automatically
- relaxation recommendations always require explicit human review and a durable policy file change
- threshold tightening should still be reviewed before rollout, even when the report direction is `tighten`

Suggested operator sequence for a real policy change:

1. capture a calibration report for the relevant run or review window
2. inspect the recommendation rationale and confidence ranges
3. render the patch snippet
4. merge the reviewed threshold entries into the owned policy TOML
5. run `policy diff` against the candidate file
6. run `policy validate` on the candidate file before rollout
7. restart or reload the daemon onto the reviewed policy source

## Upgrade And Rollback Operator Checks

Before publishing or rolling out a new CLI build:

```bash
pnpm release:verify
```

This command runs:

- lint and formatting gates (`pnpm lint`, `pnpm format:check`)
- TypeScript tests with coverage thresholds (`pnpm test:coverage`)
- Python SDK tests (`pnpm py:test`)
- installed binary smoke (`pnpm smoke:cli-install`)
- compatibility/upgrade/rollback smoke (`pnpm smoke:cli-compat`)

Post-upgrade checks:

```bash
pnpm cli -- --json version
pnpm cli -- --json doctor
```

Rollback trigger criteria:

- contract-version mismatch
- compatibility smoke regression
- doctor/security posture regression

Rollback action: reinstall last known-good CLI package set and re-run `version` + `doctor`.

## Incident Triage Baseline

Collect the minimum reliable triage set:

```bash
pnpm cli -- --json diagnostics daemon_health
pnpm cli -- --json diagnostics capability_summary
pnpm cli -- --json diagnostics storage_summary
pnpm cli -- --json run-summary <run-id>
pnpm cli -- --json timeline <run-id> internal
```

If diagnostics indicate degraded capability state, prefer explicit approval/manual review paths over forcing mutation retries.

## Failure-Mode Matrix

| Symptom | Immediate checks | Operator action |
| --- | --- | --- |
| daemon unreachable | `pnpm cli -- --json ping`; `pnpm cli -- --json doctor` | restart daemon, then re-run `doctor`; block mutating operations until healthy |
| policy regression or unexpected decision drift | `pnpm cli -- --json policy show`; `pnpm cli -- --json policy explain ./attempt.json` | freeze policy edits, compare candidate vs effective policy, require reviewed rollback or patch |
| audit verify failure or tamper signal | `pnpm cli -- --json run-audit-verify ./audit-bundle`; `pnpm cli -- --json run-audit-report ./audit-bundle` | treat evidence as untrusted, escalate as SEV1/SEV2, preserve artifacts before retry |
| snapshot/recovery failure | `pnpm cli -- --json diagnostics storage_summary`; `pnpm cli -- --json run-summary <run-id>` | switch to manual-review recovery path and capture degraded reason in incident log |
| MCP auth/policy registration failure | `pnpm cli -- --json doctor`; relevant MCP upsert/list commands | confirm secret-ref/host-policy posture, avoid direct credentials, reattempt only after posture is green |

## Incident Severity And Escalation

- `SEV1`: evidence integrity risk, unauthorized execution risk, or broad service outage
  Escalate immediately to on-call owner and security owner, pause mutating operations, start incident channel.
- `SEV2`: major degradation with safe fallback available
  Escalate to on-call owner within 30 minutes, operate in approval/manual-review mode.
- `SEV3`: localized/operator-error issues with minimal blast radius
  Track in normal operations queue, resolve during active shift.

Communication expectations:
- open incident record with timestamp, impacted run IDs, and first failing command.
- record each mitigation step and verification command output.
- close only after post-fix `doctor`, `version`, and relevant workflow checks are green.

## Journal Tamper/Corruption Response

When any audit verification fails:

1. stop trusting the bundle as evidence.
2. preserve original bundle directory as read-only incident evidence.
3. run:
   - `pnpm cli -- --json run-audit-verify ./audit-bundle`
   - `pnpm cli -- --json run-audit-report ./audit-bundle`
   - `pnpm cli -- --json diagnostics storage_summary`
4. if failure indicates corruption/tamper, escalate to at least `SEV2` (or `SEV1` for high-impact runs).
5. regenerate evidence from authoritative local state only after incident lead approval.

## Out Of Scope

This runbook does not claim:

- hosted MCP execution
- arbitrary remote/public MCP registration from agent or user input
- durable queued worker operation

## Tabletop Signoff Record

Date: `2026-04-02`  
Scenario set: evidence tamper detection + incident triage path  
Result: `PASS`

Evidence:

- [Operator Tabletop Report](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/operator-tabletop/2026-04-02-tamper-and-triage/REPORT.md)
- [Operator Tabletop Summary](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/operator-tabletop/2026-04-02-tamper-and-triage/summary.json)
