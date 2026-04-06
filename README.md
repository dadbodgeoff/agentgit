# agentgit

**Local-first execution authority for autonomous agents.**

agentgit sits between your agent runtime and the outside world. Every action an agent wants to take — write a file, run a shell command, call an MCP tool — passes through a governance layer that normalizes the intent, evaluates it against policy, optionally captures a recovery boundary, executes it in a governed adapter, and records the full causal history in an append-only journal.

The result: agents can operate with real autonomy while operators keep control, maintain reversibility, and have the evidence they need when something goes wrong.

---

[![npm](https://img.shields.io/npm/v/@agentgit/authority-cli?label=%40agentgit%2Fauthority-cli)](https://www.npmjs.com/package/@agentgit/authority-cli)
[![npm](https://img.shields.io/npm/v/@agentgit/agent-runtime-integration?label=%40agentgit%2Fagent-runtime-integration)](https://www.npmjs.com/package/@agentgit/agent-runtime-integration)
[![npm](https://img.shields.io/npm/v/@agentgit/authority-sdk?label=%40agentgit%2Fauthority-sdk)](https://www.npmjs.com/package/@agentgit/authority-sdk)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24.14.0-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/dadbodgeoff/agentgit/actions/workflows/ci.yml/badge.svg)](https://github.com/dadbodgeoff/agentgit/actions/workflows/ci.yml)

---

**Jump to:**
[Why agentgit?](#why-agentgit) •
[Quickstart](#quickstart) •
[How it works](#how-it-works) •
[TypeScript SDK](#typescript-sdk) •
[Python SDK](#python-sdk) •
[CLI Reference](#cli-reference) •
[Repo Structure](#repo-structure) •
[Contributing](#contributing) •
[Wiki →](https://github.com/dadbodgeoff/agentgit/wiki)

---
## Why agentgit?

Autonomous agents need to act. But "just let the agent do it" breaks down fast:

- **No audit trail.** What did the agent actually do? Which file did it write? What did the shell command output?
- **No reversibility.** When an agent goes wrong mid-run, how do you roll back?
- **No operator control.** How do you enforce "always ask before deleting" or "never write outside this workspace"?
- **No trust model for external tools.** How do you let an agent call an MCP server without giving it unchecked credential access?
agentgit solves all of this with a single local daemon that agents call through instead of calling the OS directly.

---

## Quickstart

### Operator CLI + daemon

```bash
# Run from your project directory — data lives in ./.agentgit/
cd /your/project
npm install -g @agentgit/authority-cli
agentgit-authority setup
agentgit-authority daemon start
```

In a second terminal:

```bash
agentgit-authority doctor
agentgit-authority ping

# Register a run (returns a run_id)
agentgit-authority register-run my-first-run

# Submit a governed filesystem write
agentgit-authority submit-filesystem-write <run-id> /tmp/hello.txt "hello from agentgit"

# Submit a governed shell command
agentgit-authority submit-shell <run-id> echo "hello"

# Inspect what happened
agentgit-authority timeline <run-id>
agentgit-authority helper <run-id> what_happened
agentgit-authority run-summary <run-id>
```

### Product CLI

```bash
cd /your/project
npm install -g @agentgit/agent-runtime-integration

agentgit setup --yes --command 'node -e "console.log(\"hello from agentgit\")"'
agentgit run
agentgit inspect
```

> **Python agent?** See the [Python SDK quickstart](#python-sdk) below.

---

## How It Works

An agent action flows through eight subsystems in sequence:

```
Agent submits action attempt
         │
         ▼
┌─────────────────────┐
│  1. Action          │  Normalize to a canonical Action record
│     Normalizer      │  (provenance, scope, risk hints, workspace validation)
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  2. Policy          │  Evaluate against layered rules
│     Engine          │  → allow | deny | ask | simulate | allow_with_snapshot
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  3. Snapshot        │  If allow_with_snapshot: capture rollback boundary
│     Engine          │  (cheapest class satisfying recovery promise)
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  4. Execution       │  Execute side effect in governed adapter
│     Adapters        │  (filesystem / shell / MCP proxy / owned function)
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  5. Run Journal     │  Append atomic RunEvent to durable SQLite history
│     (spine)         │  (action + policy + snapshot + result, all linked)
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  6. Recovery        │  Pre-compute restore/compensate/remediate plan
│     Engine          │  (snapshot boundary, compensation, or review-only)
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  7. Timeline &      │  Project raw history into readable steps
│     Helper          │  (what happened? what changed? what's safe next?)
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  8. Operator        │  CLI, TypeScript SDK, Python SDK, Inspector UI
│     Surfaces        │  (inspect, approve, recover, audit, export)
└─────────────────────┘
```

Everything is **local-first** — your data never leaves your machine unless you explicitly export an audit bundle.

---

## Governed Execution Domains

| Surface | What it covers |
|---------|---------------|
| **Filesystem** | Read/write with workspace path validation and scope enforcement |
| **Shell** | Command execution with arg/env inspection |
| **MCP (stdio)** | Sandboxed local tool servers in digest-pinned OCI containers |
| **MCP (streamable_http)** | Remote tool endpoints with explicit host allowlists and OS-backed secret injection |
| **Owned Functions** | Drafts, notes, tickets — create/update/close with compensation support |

Unsupported surfaces (browser/computer control, generic HTTP, arbitrary remote MCP) **fail closed** — they return an explicit `PRECONDITION_FAILED` error rather than silently proceeding or simulating.

---

## Key Features

### Deterministic Policy
Rules are explicit, layered, and operator-controlled. Outcomes are one of: `allow`, `deny`, `ask` (requires human approval), `simulate` (dry-run), or `allow_with_snapshot` (execute with a rollback boundary). No opaque ML scoring.

### Recovery-Ready
Every recoverable action gets a recovery plan pre-computed at execution time:
- **Reversible**: restore from snapshot (e.g., a file write)
- **Compensatable**: inverse operation (e.g., delete a created ticket)
- **Review-only**: explain the outcome, no automatic action
- **Irreversible**: document and prevent escalation

### Durable Audit Journal
SQLite append-only history ties every action to its policy outcome, snapshot, execution result, and approvals. Export a full evidence bundle with `run-audit-export`, verify its integrity with `run-audit-verify`, and share a redacted version with `run-audit-share`.

### MCP with Real Trust Controls
- OS-backed secret storage (macOS Keychain / Linux Secret Service)
- Digest-pinned OCI container isolation for stdio servers
- Cosign-based signature verification with SLSA provenance enforcement
- Explicit public HTTPS host allowlists with DNS/IP scope validation
- Per-server tool allowlists with approval-mode overrides

### Policy Calibration Loop
After a run, use `policy calibration-report` to see approval patterns and confidence quality, `policy recommend-thresholds` to get data-driven threshold guidance, and `policy replay-thresholds` to test candidate thresholds against real journaled actions before rolling them out. Threshold changes are always operator-reviewed — nothing mutates live policy automatically.

---

## Install

### TypeScript / JavaScript

```bash
# Operator CLI + daemon (recommended)
npm install -g @agentgit/authority-cli

# Product CLI
npm install -g @agentgit/agent-runtime-integration

# SDK only (embed in your agent)
npm install @agentgit/authority-sdk @agentgit/schemas
```

### Python SDK

```bash
# Source-only alpha for the MVP launch contract; PyPI publishing is not wired yet.
# Install from source:
PYTHONPATH=packages/authority-sdk-py python3 your_agent.py

# Optional packaging check:
pnpm py:build
```

---

## TypeScript SDK

```ts
import { AuthorityClient } from "@agentgit/authority-sdk";

const client = new AuthorityClient({
  socketPath: "/absolute/path/to/.agentgit/authority.sock",
});

// Register a run
const run = await client.registerRun({
  display_name: "my-agent-run",
  workspace_roots: ["/path/to/workspace"],
});

// Submit a governed action — the daemon handles policy, snapshots, execution, journaling
const result = await client.submitActionAttempt({
  run_id: run.run_id,
  tool_name: "write_file",
  execution_domain: "filesystem",
  raw_inputs: { path: "/path/to/file.txt", content: "hello" },
  workspace_roots: ["/path/to/workspace"],
});

// Inspect the timeline
const timeline = await client.queryTimeline(run.run_id);
console.log(timeline.steps);

// Plan and execute recovery if needed
const plan = await client.planRecovery(result.action_id);
await client.executeRecovery(plan.plan_id);
```

→ Full reference: [TypeScript SDK](packages/authority-sdk-ts/README.md)

---

## Python SDK

```python
from agentgit_authority import AuthorityClient, build_register_run_payload

client = AuthorityClient()  # auto-discovers socket via AGENTGIT_ROOT or cwd

run = client.register_run(build_register_run_payload("my-run", ["/path/to/workspace"]))

client.submit_filesystem_write(run["run_id"], "/path/file.txt", "content",
                               workspace_roots=["/path/to/workspace"])

timeline = client.query_timeline(run["run_id"])
pending = client.list_approvals(run_id=run["run_id"])
```

→ Full reference: [Python SDK](packages/authority-sdk-py/README.md)

---

## CLI Reference

```bash
# Health
agentgit-authority doctor
agentgit-authority ping

# Run lifecycle
agentgit-authority register-run <name>
agentgit-authority run-summary <run-id>
agentgit-authority timeline <run-id>
agentgit-authority helper <run-id> what_happened
agentgit-authority helper <run-id> likely_cause

# Governance
agentgit-authority submit-filesystem-write <run-id> <path> <content>
agentgit-authority submit-shell <run-id> <command>
agentgit-authority submit-mcp-tool <run-id> <server-id> <tool-name> <json-args>
agentgit-authority list-approvals <run-id>
agentgit-authority approve <approval-id>
agentgit-authority deny <approval-id> "outside expected scope"

# Policy
agentgit-authority policy show
agentgit-authority policy validate <policy.toml>
agentgit-authority policy explain <attempt.json>
agentgit-authority policy calibration-report
agentgit-authority policy recommend-thresholds <run-id>
agentgit-authority policy replay-thresholds <run-id>
agentgit-authority policy diff <policy.toml>

# Recovery
agentgit-authority plan-recovery <target-id>
agentgit-authority execute-recovery <plan-id>

# Audit
agentgit-authority run-audit-export <run-id> <bundle-path>
agentgit-authority run-audit-verify <bundle-path>
agentgit-authority run-audit-report <bundle-path>
agentgit-authority run-audit-share <bundle-path> <share-path>

# MCP
agentgit-authority onboard-mcp <plan.json>
agentgit-authority trust-review-mcp <plan.json>
agentgit-authority list-mcp-servers
agentgit-authority list-mcp-secrets
agentgit-authority list-mcp-host-policies
```

Add `--json` before any subcommand for machine-readable output.

→ Full reference: [CLI README](packages/authority-cli/README.md)

---

## Repo Structure

```
packages/
  authority-cli/         # Operator CLI  (public: @agentgit/authority-cli)
  authority-daemon/      # Local daemon runtime  (public: @agentgit/authority-daemon)
  authority-sdk-ts/      # TypeScript client SDK  (public: @agentgit/authority-sdk)
  authority-sdk-py/      # Python client SDK
  schemas/               # Canonical types + Zod schemas  (public: @agentgit/schemas)
  action-normalizer/     # Action normalization engine  (internal)
  policy-engine/         # Deterministic policy evaluation  (internal)
  snapshot-engine/       # Recovery boundary capture  (internal)
  execution-adapters/    # Governed side-effecting adapters  (internal)
  run-journal/           # Append-only SQLite history spine  (internal)
  recovery-engine/       # Recovery planning + execution  (internal)
  timeline-helper/       # Timeline projection + helper Q&A  (internal)
  credential-broker/     # OS-backed secret key protection  (internal)
  mcp-registry/          # MCP server registry state  (internal)
  integration-state/     # Owned integration state (drafts/notes/tickets)  (internal)
  workspace-index/       # Workspace snapshot metadata  (internal)
  hosted-mcp-worker/     # Hosted MCP worker (future work)  (internal)
  test-fixtures/         # Shared test utilities  (internal)

apps/
  inspector-ui/          # Local operator timeline + recovery UI
```

---

## Developing

### Prerequisites

- Node.js 24.14.0+
- pnpm 10.33.0+
- Python 3.11+ (for Python SDK tests)

### Build and test

```bash
pnpm install
pnpm build
pnpm test

# Start the daemon (foreground)
pnpm daemon:start

# In a second terminal — try a governed run
pnpm cli register-run dev-test
pnpm cli submit-filesystem-write <run-id> /tmp/test.txt "hello"
pnpm cli timeline <run-id>
```

### Release flow

```bash
pnpm release:pack          # Pack publishable tarballs
pnpm smoke:cli-install     # End-to-end install smoke test
pnpm smoke:agent-runtime   # Product demo + generic + contained runtime smoke test
pnpm release:verify        # Verify artifact signatures
```

Releases are driven by [Changesets](https://github.com/changesets/changesets). Add a changeset with `pnpm changeset`, then the GitHub Actions release workflow handles versioning and npm publish with provenance.

---

## Documentation

| Resource | Description |
|----------|-------------|
| [Wiki: Getting Started](wiki/Getting-Started.md) | Install, first run, beginner walkthrough |
| [Wiki: Architecture](wiki/Architecture.md) | System design, subsystem responsibilities, data flow |
| [Wiki: Core Concepts](wiki/Core-Concepts.md) | Actions, policy, snapshots, recovery, journal explained |
| [Wiki: CLI Reference](wiki/CLI-Reference.md) | Every command with examples |
| [Wiki: TypeScript SDK](wiki/TypeScript-SDK.md) | Full SDK API reference |
| [Wiki: Python SDK](wiki/Python-SDK.md) | Python SDK reference |
| [Wiki: Policy Engine](wiki/Policy-Engine.md) | Writing policies, calibration loop |
| [Wiki: Recovery & Snapshots](wiki/Recovery-and-Snapshots.md) | Recovery types, execution, drills |
| [Wiki: MCP Integration](wiki/MCP-Integration.md) | Onboarding MCP servers, secrets, trust review |
| [Wiki: Audit & Evidence](wiki/Audit-and-Evidence.md) | Audit bundles, export, verify, share |
| [Wiki: Configuration](wiki/Configuration.md) | Environment variables, profiles, policy files |
| [Wiki: Contributing](wiki/Contributing.md) | Development setup, conventions, PR process |
| [Wiki: FAQ](wiki/FAQ.md) | Common questions |
| [engineering-docs/](engineering-docs/) | Architecture specs, subsystem design docs, runbooks |

---

## What's Not Supported (Yet)

These surfaces are explicitly out of scope for the current release and fail closed:

- **Browser / computer control** — not governed today
- **Generic HTTP adapter** — use the owned ticket adapter for specific integrations
- **Arbitrary remote MCP** — agents cannot register MCP servers; only operators can
- **Durable queued workers** — maintenance is inline and at startup reconciliation

See `agentgit-authority cloud-roadmap` for the explicit roadmap of deferred cloud/hosted phases.

---

## Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the quick-start and [wiki/Contributing](https://github.com/dadbodgeoff/agentgit/wiki/Contributing) for the full guide including coding conventions, commit message format, and release process.

---

## License

MIT
