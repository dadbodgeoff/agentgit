# agentgit

Local-first execution control for autonomous agents.

The repo is past the initial scaffold phase and now contains a real local authority runtime, SDKs, CLI, recovery engine, maintenance surface, and inspector UI.

Day-one launch/runtime truth is intentionally conservative:

- supported governed execution: `filesystem`, `shell`, owned `function` integrations (`drafts`, `notes`, `tickets`), and operator-registered `mcp` stdio tools
- unsupported governed surfaces fail closed instead of simulating execution
- current MCP launch claim is narrow: operator-registered stdio servers, `tools/list`, `tools/call`, and approval-first mutation policy
- browser/computer governance, generic governed HTTP, Streamable HTTP MCP transport, hosted MCP, and durable queued workers are not part of the launch/runtime claim today
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
pnpm cli register-run first-run
pnpm cli submit-filesystem-write <run-id> README.md "hello"
pnpm cli submit-shell <run-id> ls
pnpm cli run-summary <run-id>
```

The CLI now defaults to human-readable summaries for inspection-style commands like `run-summary`, `timeline`, `helper`, approvals, and recovery. For scripting, use `--json` before the command, for example:

```bash
pnpm cli -- --json timeline <run-id>
```

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
