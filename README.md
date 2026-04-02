# agentgit

Local-first execution control for autonomous agents.

The repo is past the initial scaffold phase and now contains a real local authority runtime, SDKs, CLI, recovery engine, maintenance surface, and inspector UI.

Day-one launch/runtime truth is intentionally conservative:

- supported governed execution: `filesystem`, `shell`, owned `function` integrations (`drafts`, `notes`, `tickets`), and operator-managed `mcp` tools over `stdio` and `streamable_http`
- unsupported governed surfaces fail closed instead of simulating execution
- current MCP launch claim: durable operator-owned local registry, durable local encrypted MCP secret storage backed by OS keychain or Secret Service protection with expiry enforcement and rotation metadata, sandboxed `stdio` MCP execution with digest-pinned OCI container isolation as the required production path, explicit `allowed_registries` policy, cosign-based signature verification with SLSA provenance enforcement for remote images, and `oci_container.build` support for local development on the same boundary, explicit public HTTPS host allowlist policy with connect-time DNS/IP scope validation and redirect-chain revalidation, CLI/SDK/daemon management APIs for servers/secrets/host policies, first-class CLI MCP tool submission, `tools/list`, `tools/call`, direct-credential denial, approval-first mutation policy, and per-server `streamable_http` concurrency limits enforced either in-process or through shared SQLite leases with heartbeat renewal
- browser/computer governance, generic governed HTTP, hosted MCP, arbitrary remote MCP registration from agent or user input, and durable queued workers are not part of the launch/runtime claim today
- maintenance is inline plus startup reconciliation, not a durable worker queue
- the public npm release surface is now `@agentgit/authority-daemon`, `@agentgit/schemas`, `@agentgit/authority-sdk`, and `@agentgit/authority-cli`, with Changesets-driven versioning, GitHub Actions release automation, and installed-binary smoke verification; that release path is built even if a given version has not been published yet

For the audited answer to "what is actually built today," use:

- [engineering-docs/CURRENT-IMPLEMENTATION-STATE.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/CURRENT-IMPLEMENTATION-STATE.md)

For the explicit local-first MVP boundary and deferred cloud/hosted phases, use:

- `agentgit-authority --json cloud-roadmap`
- [engineering-docs/PHASE-1-TO-5-EXECUTION-AUDIT.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/PHASE-1-TO-5-EXECUTION-AUDIT.md)

Historical design docs remain important, but they include planned future surfaces that are not all runtime-real yet.

## Current Local Loop

```bash
pnpm install
pnpm build
pnpm daemon:start
pnpm cli ping
pnpm cli list-mcp-servers
pnpm cli list-mcp-secrets
pnpm cli list-mcp-host-policies
pnpm cli upsert-mcp-server '{"server_id":"notes_stdio","transport":"stdio","command":"node","args":["/absolute/path/to/mcp-test-server.mjs"],"tools":[{"tool_name":"echo_note","side_effect_level":"read_only","approval_mode":"allow"}]}'
pnpm cli register-run first-run
pnpm cli submit-mcp-tool <run-id> notes_stdio echo_note '{"note":"hello from cli"}'
pnpm cli submit-filesystem-write <run-id> README.md "hello"
pnpm cli submit-shell <run-id> ls
pnpm cli artifact <artifact-id> internal
pnpm cli artifact-export <artifact-id> ./exports/stdout.txt internal
pnpm cli run-audit-export <run-id> ./audit-bundle internal
pnpm cli run-audit-verify ./audit-bundle
pnpm cli run-audit-report ./audit-bundle
pnpm cli run-audit-share ./audit-bundle ./audit-share
pnpm cli run-audit-compare ./audit-bundle ./audit-bundle-2
pnpm cli run-summary <run-id>
```

The CLI now defaults to human-readable summaries for inspection-style commands like `run-summary`, `timeline`, `helper`, approvals, and recovery. For scripting, use `--json` before the command, for example:

```bash
pnpm cli -- --json timeline <run-id>
```

The operator policy loop is also real now: `policy show`, `policy explain`, `policy calibration-report`, `policy recommend-thresholds`, `policy diff`, and `policy render-threshold-patch` are all available through the CLI. The recommendation and patch-render flows are explicitly report-only and do not mutate live policy automatically.

For operator evidence handling, `artifact` remains the inline inspection path, `artifact-export` writes one full stored artifact body to disk without truncation, `run-audit-export` emits a complete run bundle with summary, timeline, approvals, diagnostics, and exported visible artifact bodies, `run-audit-verify` checks that exported bundle for missing or tampered evidence, `run-audit-report` summarizes a verified bundle for incident review, `run-audit-share` emits a redaction-aware share package that withholds artifact bodies by default, and `run-audit-compare` highlights evidence drift between two bundles. These flows fail closed on visibility, truncation, verification, or overwrite violations.

## Python SDK Loop

The repo also includes a thin Python client in [packages/authority-sdk-py](/Users/geoffreyfernald/Documents/agentgit/packages/authority-sdk-py).

With the daemon running, you can exercise the same governed flow from Python:

```bash
PYTHONPATH=packages/authority-sdk-py \
python3 packages/authority-sdk-py/examples/governed_run.py \
  --workspace-root "$(pwd)"
```

Or run the Python SDK tests directly:

```bash
PYTHONPATH=packages/authority-sdk-py \
python3 -m unittest discover -s packages/authority-sdk-py/tests -v
```

With the daemon already running, the same Python demo is also exposed as a root shortcut:

```bash
pnpm smoke:py
```

The repo pins `better-sqlite3` as an approved native build dependency in `.npmrc` so the local journal can compile consistently.

## Beginner Quickstart

For MVP users, the shortest supported path is now:

```bash
npm install -g @agentgit/authority-cli
agentgit-authority setup
agentgit-authority daemon start
```

In a second terminal:

```bash
agentgit-authority doctor
agentgit-authority ping
```

## Release And Install Story

The repo now has a real npm release path for the public TypeScript surface:

- `@agentgit/authority-daemon`
- `@agentgit/schemas`
- `@agentgit/authority-sdk`
- `@agentgit/authority-cli`

What is true today:

- package metadata is publish-ready
- `.changeset/` is active for versioning
- GitHub Actions CI runs `pnpm test`, `pnpm py:test`, and an installed-binary CLI smoke test
- GitHub Actions release automation is wired for Changesets plus npm provenance/trusted-publishing setup
- the installed-binary smoke path packs the publishable tarballs, installs them outside the monorepo, runs `setup`, starts the packaged daemon through the installed CLI, and proves the installed CLI can run `version`, `ping`, `doctor`, `register-run`, and a governed filesystem write end to end

Useful commands:

```bash
pnpm release:pack
pnpm smoke:cli-install
pnpm smoke:cli-compat
pnpm release:verify
```

Once the npm trusted publisher is configured for the GitHub repo, the release workflow can publish the public packages without local ad hoc npm credentials.

For day-one operator procedures (bring-up, profile/config flows, secure secret handling, audit workflow, upgrade/rollback checks), use:

- [engineering-docs/CLI-OPERATOR-RUNBOOK.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/CLI-OPERATOR-RUNBOOK.md)

Relevant docs:

- [engineering-docs/system-architecture.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/system-architecture.md)
- [engineering-docs/v1-repo-package-module-plan.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/v1-repo-package-module-plan.md)
- [engineering-docs/CURRENT-IMPLEMENTATION-STATE.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/CURRENT-IMPLEMENTATION-STATE.md)
- [engineering-docs/MVP-PRODUCTION-READINESS-PLAN.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/MVP-PRODUCTION-READINESS-PLAN.md)
- [engineering-docs/MVP-PRODUCTION-READINESS-AUDIT.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/MVP-PRODUCTION-READINESS-AUDIT.md)
- [engineering-docs/CLI-RELEASE-AND-INSTALL.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/CLI-RELEASE-AND-INSTALL.md)
- [engineering-docs/CLI-OPERATOR-RUNBOOK.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/CLI-OPERATOR-RUNBOOK.md)
- [.github/workflows/security-hardening.yml](/Users/geoffreyfernald/Documents/agentgit/.github/workflows/security-hardening.yml)
- [engineering-docs/support-architecture/09-hosted-mcp-and-remote-trust.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/support-architecture/09-hosted-mcp-and-remote-trust.md)
- [engineering-docs/pre-code-specs/14-hosted-mcp-and-remote-trust-spec.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/pre-code-specs/14-hosted-mcp-and-remote-trust-spec.md)
