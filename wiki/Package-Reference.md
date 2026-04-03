# Package Reference

Complete reference for all packages in the agentgit monorepo.

---

## Public npm Packages

These packages are published to npm and have stable public APIs.

### `@agentgit/authority-cli`
**Operator CLI for the local agentgit daemon.**

```bash
npm install -g @agentgit/authority-cli
```

The recommended starting point for most users. Bundles the daemon and provides a guided setup flow.

Binary: `agentgit-authority`

→ [Package README](../packages/authority-cli/README.md) | [CLI Reference](CLI-Reference.md)

---

### `@agentgit/authority-daemon`
**Local authority daemon runtime.**

```bash
npm install -g @agentgit/authority-daemon
```

The daemon process. Most users install this via the CLI rather than directly.

Binary: `agentgit-authorityd`

→ [Package README](../packages/authority-daemon/README.md)

---

### `@agentgit/authority-sdk`
**TypeScript client SDK.**

```bash
npm install @agentgit/authority-sdk @agentgit/schemas
```

Embed in your TypeScript/JavaScript agent to submit governed actions and inspect results.

→ [Package README](../packages/authority-sdk-ts/README.md) | [TypeScript SDK guide](TypeScript-SDK.md)

---

### `@agentgit/schemas`
**Canonical types and Zod schemas.**

```bash
npm install @agentgit/schemas
```

Shared type definitions used by the daemon, SDKs, and CLI.

→ [Package README](../packages/schemas/README.md)

---

## Python SDK

### `agentgit-authority` (Python)
**Python client SDK.**

Thin wrapper over the daemon's Unix socket IPC. Mirrors the TypeScript SDK surface.

→ [Package README](../packages/authority-sdk-py/README.md) | [Python SDK guide](Python-SDK.md)

---

## Internal Packages

These packages are workspace-only. They are used by the daemon and are not published to npm.

### Core Subsystems

| Package | Responsibility |
|---------|---------------|
| [`@agentgit/action-normalizer`](../packages/action-normalizer/README.md) | Convert raw action attempts into canonical `Action` records |
| [`@agentgit/policy-engine`](../packages/policy-engine/README.md) | Deterministic layered policy evaluation → allow/deny/ask/simulate/allow_with_snapshot |
| [`@agentgit/snapshot-engine`](../packages/snapshot-engine/README.md) | Capture rollback boundaries before recoverable actions |
| [`@agentgit/execution-adapters`](../packages/execution-adapters/README.md) | Governed side-effecting adapters (filesystem, shell, MCP, owned functions) |
| [`@agentgit/run-journal`](../packages/run-journal/README.md) | Append-only SQLite history spine |
| [`@agentgit/recovery-engine`](../packages/recovery-engine/README.md) | Recovery planning and execution |
| [`@agentgit/timeline-helper`](../packages/timeline-helper/README.md) | Timeline projection and helper Q&A |

### Infrastructure

| Package | Responsibility |
|---------|---------------|
| [`@agentgit/credential-broker`](../packages/credential-broker/README.md) | OS-backed secret key protection (macOS Keychain / Linux Secret Service) |
| [`@agentgit/mcp-registry`](../packages/mcp-registry/README.md) | Durable MCP server registry state |
| [`@agentgit/integration-state`](../packages/integration-state/README.md) | Owned integration state for drafts/notes/tickets |
| [`@agentgit/workspace-index`](../packages/workspace-index/README.md) | Workspace snapshot metadata and manifest diffs |
| [`@agentgit/hosted-mcp-worker`](../packages/hosted-mcp-worker/README.md) | Placeholder for future hosted MCP worker (not in launch scope) |

### Utilities

| Package | Responsibility |
|---------|---------------|
| [`@agentgit/test-fixtures`](../packages/test-fixtures/README.md) | Shared test utilities (temp workspace, temp SQLite DB) |

---

## Apps

### `@agentgit/inspector-ui`
**Local operator UI for timeline inspection and recovery.**

Visual interface for browsing runs, inspecting timeline steps, querying the helper, and planning recovery.

→ [App README](../apps/inspector-ui/README.md)

---

## Dependency Graph

```
@agentgit/schemas
  ↑ used by everything

@agentgit/action-normalizer
  ↑ @agentgit/authority-daemon

@agentgit/policy-engine
  ↑ @agentgit/authority-daemon

@agentgit/snapshot-engine
  ← @agentgit/workspace-index
  ↑ @agentgit/authority-daemon, @agentgit/recovery-engine

@agentgit/execution-adapters
  ← @agentgit/mcp-registry
  ← @agentgit/credential-broker
  ← @agentgit/integration-state
  ↑ @agentgit/authority-daemon

@agentgit/run-journal
  ↑ @agentgit/authority-daemon, @agentgit/recovery-engine, @agentgit/timeline-helper

@agentgit/recovery-engine
  ← @agentgit/snapshot-engine
  ← @agentgit/integration-state
  ↑ @agentgit/authority-daemon

@agentgit/timeline-helper
  ← @agentgit/run-journal
  ↑ @agentgit/authority-daemon

@agentgit/authority-daemon
  ← everything above
  ↑ @agentgit/authority-cli

@agentgit/authority-sdk
  → @agentgit/authority-daemon (via IPC)
  ↑ your agent, @agentgit/inspector-ui
```
