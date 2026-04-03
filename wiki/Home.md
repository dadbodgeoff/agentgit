# agentgit Wiki

**Local-first execution authority for autonomous agents.**

agentgit sits between your agent runtime and the outside world. Every action an agent wants to take passes through a governance layer that normalizes the intent, evaluates it against policy, optionally captures a recovery boundary, executes it in a governed adapter, and records everything in an append-only journal.

---

## Quick Navigation

### Getting Started
- [Getting Started](Getting-Started.md) — Install, first run, 5-minute walkthrough
- [FAQ](FAQ.md) — Common questions

### Understanding agentgit
- [Architecture Overview](Architecture.md) — How the 8 subsystems fit together
- [Core Concepts](Core-Concepts.md) — Actions, policy, snapshots, recovery, journal explained

### Using agentgit
- [TypeScript SDK](TypeScript-SDK.md) — Embedding agentgit in a TypeScript/JavaScript agent
- [Python SDK](Python-SDK.md) — Embedding agentgit in a Python agent
- [CLI Reference](CLI-Reference.md) — Every command with examples and flags

### Configuration & Operations
- [Policy Engine](Policy-Engine.md) — Writing policies, calibration loop, threshold tuning
- [Recovery & Snapshots](Recovery-and-Snapshots.md) — Recovery types, execution, drills
- [MCP Integration](MCP-Integration.md) — Onboarding MCP servers, secrets, trust review
- [Audit & Evidence](Audit-and-Evidence.md) — Audit bundles, export, verify, share
- [Configuration](Configuration.md) — Environment variables, profiles, policy files

### Contributing
- [Contributing](Contributing.md) — Development setup, conventions, PR process

---

## What agentgit Is

Autonomous agents need to act. But "just let the agent do it" breaks down in practice:

- No audit trail
- No reversibility when something goes wrong
- No operator control over what the agent is allowed to do
- No trust model for external tool servers

agentgit solves this with a local daemon that agents call through instead of calling the OS directly. The daemon governs every action, maintains a durable journal, and gives operators the tools to inspect, approve, and recover.

### Governed surfaces (launch-real)
- **Filesystem** — read/write with workspace path enforcement
- **Shell** — command execution with arg/env inspection
- **MCP via stdio** — local tool servers in digest-pinned OCI containers
- **MCP via streamable_http** — remote tool endpoints with explicit host allowlists and OS-backed secret injection
- **Owned functions** — drafts, notes, tickets with compensation-based recovery

### Unsupported surfaces (fail closed)
Browser/computer control, generic HTTP, arbitrary remote MCP, and durable queued workers are not part of the current release. These surfaces return an explicit `PRECONDITION_FAILED` error.

---

## Install in 30 Seconds

```bash
npm install -g @agentgit/authority-cli
agentgit-authority setup
agentgit-authority daemon start
```

In a second terminal:

```bash
agentgit-authority doctor
agentgit-authority register-run my-first-run
agentgit-authority submit-filesystem-write <run-id> /tmp/hello.txt "hello"
agentgit-authority timeline <run-id>
```

→ [Full getting started guide](Getting-Started.md)

---

## Package Overview

| Package | npm | Purpose |
|---------|-----|---------|
| `@agentgit/authority-cli` | ✓ public | Operator CLI |
| `@agentgit/authority-daemon` | ✓ public | Local daemon runtime |
| `@agentgit/authority-sdk` | ✓ public | TypeScript client SDK |
| `@agentgit/schemas` | ✓ public | Canonical types + Zod schemas |
| `agentgit-authority` (Python) | ✓ coming | Python client SDK |
| Internal packages | — | Policy, snapshots, execution, journal, recovery, etc. |

→ [Full package reference](Package-Reference.md)
