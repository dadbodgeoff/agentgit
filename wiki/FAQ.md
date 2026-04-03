# FAQ

Frequently asked questions about agentgit.

---

## General

### What is agentgit?

agentgit is a local-first execution authority layer for autonomous agents. It sits between your agent runtime and the outside world — governing every action the agent wants to take, maintaining a durable audit trail, and giving operators the ability to inspect, approve, and recover.

### Who is agentgit for?

Anyone running autonomous agents that need to interact with real systems — writing files, running shell commands, calling external APIs via MCP. agentgit is especially useful when you need auditability, reversibility, or operator oversight.

### Does agentgit replace my agent runtime?

No. agentgit is a layer that your agent runtime calls through. Your agent still runs wherever it runs (Claude, GPT-4, a custom model, an agentic framework). agentgit governs the actions that agent tries to take.

### Is agentgit cloud-based?

No. agentgit is local-first. All state is stored on your machine in SQLite. The daemon runs locally. Nothing leaves your machine unless you explicitly export an audit bundle.

---

## Setup & Installation

### How do I start?

```bash
npm install -g @agentgit/authority-cli
agentgit-authority setup
agentgit-authority daemon start
```

→ [Getting Started guide](Getting-Started.md)

### What Node.js version do I need?

Node.js 24.14.0 or newer. Check with `node --version`.

### The daemon won't start — socket already exists

If the daemon stopped uncleanly, the socket file may still exist. Remove it:

```bash
rm ~/.agentgit/authority.sock
agentgit-authority daemon start
```

### How do I run multiple agents with separate governance contexts?

Use separate `AGENTGIT_ROOT` directories, each with their own daemon instance and socket:

```bash
AGENTGIT_ROOT=~/.agentgit-agent1 agentgit-authority daemon start
AGENTGIT_ROOT=~/.agentgit-agent2 agentgit-authority daemon start
```

---

## Governance & Policy

### An agent action is stuck waiting for approval. How do I unblock it?

```bash
# See what's pending
agentgit-authority list-approvals <run-id>

# Approve
agentgit-authority approve <approval-id>

# Or deny
agentgit-authority deny <approval-id> "outside expected scope"
```

### How do I make all actions require approval?

Add to your policy file:
```toml
[safe_mode]
mode = "ask_all"
```

Or start the daemon with: `agentgit-authority daemon start --safe-mode ask_all`

### How do I allow all filesystem writes without asking?

```toml
[trust.filesystem.write]
min_confidence = 0.0
below_threshold = "allow"
```

Use caution — this removes the policy gate for all file writes.

### What is "confidence" and how is it calculated?

Confidence is an estimate (0-1) of how well-formed and predictable an action is. It's calculated by the action normalizer based on:
- Whether all required fields are present and valid
- Whether the target path is within workspace bounds
- Whether this tool/domain has been used before in this run

Policy rules compare the action's confidence against your configured `min_confidence` threshold. Actions below threshold get the `below_threshold` outcome (typically `ask`).

### Policy outcomes aren't what I expected. How do I debug?

```bash
agentgit-authority policy explain ./attempt.json
```

This previews how a candidate action would be classified without executing it.

---

## Recovery

### Can I undo what an agent wrote?

Yes, if the action was governed with `allow_with_snapshot`:

```bash
agentgit-authority plan-recovery <action-id>
agentgit-authority execute-recovery <plan-id>
```

→ [Recovery & Snapshots guide](Recovery-and-Snapshots.md)

### What does "irreversible" mean in a recovery plan?

It means agentgit can't automatically undo the action (e.g., an email was sent, an API call had external effects). The recovery type is `irreversible`. You get documentation of what happened but no automatic rollback.

### Can I recover a ticket the agent created?

Yes. Owned-function integrations (tickets, notes, drafts) use compensation-based recovery. Planning recovery will produce a "delete/close" compensation operation:

```bash
agentgit-authority plan-recovery <action-id>
# → recovery_type: compensatable, steps: [close ticket TICKET-42]
agentgit-authority execute-recovery <plan-id>
```

---

## MCP

### Can I let my agent register its own MCP servers?

No. Only operators can register MCP servers. Agents can call tools on already-registered servers (subject to policy), but cannot register new servers. This is an intentional security boundary.

### Where are my MCP secrets stored?

In the OS keychain (macOS Keychain on macOS, Secret Service / GNOME Keyring on Linux). They are never stored in plain files or environment variables. The bearer token you provide during `upsert-mcp-secret` is moved to the OS store immediately.

### Do stdio MCP servers run in containers?

Yes, in production. Digest-pinned OCI containers are the required execution path for stdio servers. During local development, you can also run servers as local processes. The `allowed_registries` policy controls which container registries are trusted.

### I want to call a remote MCP server. What do I need?

1. Add a host policy entry for the server's domain (`upsert-mcp-host-policy`)
2. Add a secret if the server requires auth (`upsert-mcp-secret`)
3. Register the server with `transport: "streamable_http"` (`upsert-mcp-server`)

Or run the whole thing at once with `onboard-mcp <plan.json>`.

→ [MCP Integration guide](MCP-Integration.md)

---

## Audit & Evidence

### How do I export evidence for a run?

```bash
agentgit-authority run-audit-export <run-id> ./audit-bundle internal
agentgit-authority run-audit-verify ./audit-bundle
agentgit-authority run-audit-report ./audit-bundle
```

### How do I share evidence without exposing sensitive output?

```bash
agentgit-authority run-audit-share ./audit-bundle ./audit-share
```

The share package withholds artifact bodies by default. Add `--include-artifacts` to include them.

### Where is the journal stored?

`~/.agentgit/journal.db` (or wherever `AGENTGIT_JOURNAL_PATH` points). It's a SQLite database that you can read directly with any SQLite tool if needed.

---

## Development

### How do I add a new execution domain?

1. Add a new adapter in `packages/execution-adapters/`
2. Add the domain to `packages/action-normalizer/` (normalization logic)
3. Add policy rule types for the domain in `packages/policy-engine/`
4. Add recovery plan support in `packages/recovery-engine/`
5. Register the adapter in `packages/authority-daemon/`

### What's the difference between internal and public packages?

Public packages (`@agentgit/authority-cli`, `@agentgit/authority-daemon`, `@agentgit/authority-sdk`, `@agentgit/schemas`) are published to npm and have stable public APIs.

Internal packages (everything else) are workspace-only packages used by the daemon. They are not published and their APIs can change freely.

### How does the daemon IPC protocol work?

Clients connect to the Unix socket and send newline-delimited JSON messages. Each message is a `{ method, payload }` object. The daemon responds with `{ result }` or `{ error }`. The TypeScript SDK and Python SDK both handle this protocol transparently.

### Where do I look for architecture documentation?

- `wiki/Architecture.md` — high-level overview
- `wiki/Core-Concepts.md` — key concepts
- `engineering-docs/system-architecture.md` — detailed architecture spec
- `engineering-docs/[01-08]/README.md` — per-subsystem design docs
- `engineering-docs/CURRENT-IMPLEMENTATION-STATE.md` — what's actually built
