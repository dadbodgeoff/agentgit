# @agentgit/authority-cli

Operator CLI for the local-first `agentgit` authority daemon.

## Install

```bash
npm install -g @agentgit/authority-cli
agentgit-authority version
```

The CLI connects to a local authority daemon over the configured Unix socket. Use explicit flags or the layered CLI config/profile surface to point it at the right workspace and socket.

## Compatibility

- Node.js `24.14.0+`
- local daemon API `authority.v1`

## Examples

```bash
agentgit-authority --json version
agentgit-authority --json ping --socket-path /absolute/path/to/authority.sock --workspace-root /absolute/path/to/workspace
agentgit-authority --json doctor --socket-path /absolute/path/to/authority.sock --workspace-root /absolute/path/to/workspace
agentgit-authority --json policy show
agentgit-authority --json policy explain ./attempt.json
agentgit-authority --json policy calibration-report --run-id run_123 --include-samples
agentgit-authority --json policy recommend-thresholds --run-id run_123 --min-samples 5
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
- `policy calibration-report` summarizes observed policy outcomes, approvals, and recovery linkage
- `policy recommend-thresholds` produces report-only threshold guidance from calibration history
- `policy diff <path>` compares a candidate policy file against the current effective policy as an overlay proposal
- `policy render-threshold-patch` renders a report-only TOML snippet from threshold recommendations

Important safety boundary:

- recommendation and patch-render commands never mutate live policy
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
