# @agentgit/credential-broker

> **Internal package** — used by the agentgit daemon. Not published to npm.

OS-backed secret key protection for the agentgit authority runtime. Provides brokered credential handling with expiry enforcement so execution adapters can inject secrets into tool calls without ever exposing them in plaintext to agent code.

---

## What It Does

Secrets registered by operators (e.g., API keys for MCP servers) are stored in the OS-native credential store, not in a file or environment variable. When an execution adapter needs a credential, it requests it from the broker by ID. The broker:

1. Looks up the secret in the OS store
2. Checks expiry metadata (stored separately in SQLite)
3. Returns the plaintext only to the adapter's in-process call — never to agent code
4. Emits a `CREDENTIAL_EXPIRED` error if the secret has passed its `expires_at` boundary

### Platform support

| Platform | Backend |
|----------|---------|
| macOS | Keychain Services |
| Linux | Secret Service API (GNOME Keyring / systemd user secrets via D-Bus) |

---

## Key Exports

```ts
import { CredentialBroker } from "@agentgit/credential-broker";

const broker = new CredentialBroker({ metadataDb: "/path/to/journal.db" });

// Store a secret (called by operator during MCP onboarding)
await broker.store("my_api_key", {
  display_name: "My Service API Key",
  bearer_token: "sk-...",
  expires_at: "2027-01-01T00:00:00Z",  // optional
});

// Retrieve for injection into an adapter (never exposed to agent)
const secret = await broker.retrieve("my_api_key");
// → { bearer_token: "sk-...", expires_at: "...", ... }

// Rotate a secret in place
await broker.rotate("my_api_key", { bearer_token: "sk-new-..." });

// Delete
await broker.delete("my_api_key");
```

---

## Security Model

- Secrets are written to the OS keychain/secret store at rest — never to plain files
- Expiry metadata is stored in SQLite alongside the secret ID; plaintext never touches SQLite
- Adapter injection is in-process only — the broker never serializes credentials over the Unix socket or into journal artifacts
- Direct credential injection from agent code is denied by policy — agents cannot call the credential broker directly

---

## Dependencies

- `better-sqlite3` — expiry and rotation metadata storage
- macOS: native Keychain via `node:child_process` / keychain APIs
- Linux: D-Bus Secret Service via `libsecret` bindings

---

## Related Packages

- [`@agentgit/execution-adapters`](../execution-adapters/README.md) — calls the broker to inject secrets before MCP tool calls
- [`@agentgit/mcp-registry`](../mcp-registry/README.md) — stores secret IDs (not values) alongside server definitions
- [`@agentgit/authority-cli`](../authority-cli/README.md) — `upsert-mcp-secret` command triggers broker storage
