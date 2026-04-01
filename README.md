# agentgit

Local-first execution control for autonomous agents.

The repo is past the initial scaffold phase and now contains a real local authority runtime, SDKs, CLI, recovery engine, maintenance surface, and inspector UI.

Day-one launch/runtime truth is intentionally conservative:

- supported governed execution: `filesystem`, `shell`, owned `function` integrations (`drafts`, `notes`, `tickets`), and operator-managed `mcp` tools over `stdio` and `streamable_http`
- unsupported governed surfaces fail closed instead of simulating execution
- current MCP launch claim: durable operator-owned local registry, durable local encrypted MCP secret storage and rotation metadata, explicit public HTTPS host allowlist policy, CLI/SDK/daemon management APIs for servers/secrets/host policies, first-class CLI MCP tool submission, `tools/list`, `tools/call`, direct-credential denial, approval-first mutation policy, per-server concurrency limits for `streamable_http`, and explicit `streamable_http` targets in `loopback`, `private`, or operator-managed `public_https` scope alongside `stdio`
- browser/computer governance, generic governed HTTP, hosted MCP, arbitrary remote MCP registration from agent or user input, and durable queued workers are not part of the launch/runtime claim today
- maintenance is inline plus startup reconciliation, not a durable worker queue

For the audited answer to "what is actually built today," use:

- [engineering-docs/CURRENT-IMPLEMENTATION-STATE.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/CURRENT-IMPLEMENTATION-STATE.md)

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
pnpm cli run-summary <run-id>
```

The CLI now defaults to human-readable summaries for inspection-style commands like `run-summary`, `timeline`, `helper`, approvals, and recovery. For scripting, use `--json` before the command, for example:

```bash
pnpm cli -- --json timeline <run-id>
```

For operator evidence handling, `artifact` remains the inline inspection path, `artifact-export` writes one full stored artifact body to disk without truncation, `run-audit-export` emits a complete run bundle with summary, timeline, approvals, diagnostics, and exported visible artifact bodies, and `run-audit-verify` checks that exported bundle for missing or tampered evidence. These flows fail closed on visibility, truncation, or overwrite violations.

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

Relevant docs:

- [engineering-docs/system-architecture.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/system-architecture.md)
- [engineering-docs/v1-repo-package-module-plan.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/v1-repo-package-module-plan.md)
- [engineering-docs/CURRENT-IMPLEMENTATION-STATE.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/CURRENT-IMPLEMENTATION-STATE.md)
