# Getting Started

This guide walks you from zero to a working governed agent run in about 5 minutes.

---

## Prerequisites

- Node.js 24.14.0 or newer (`node --version`)
- npm

---

## Step 1: Install the CLI

```bash
npm install -g @agentgit/authority-cli
```

This installs two binaries:
- `agentgit-authority` — the operator CLI
- `agentgit-authorityd` — the daemon (managed by the CLI)

---

## Step 2: Set Up Your Workspace

```bash
cd /your/project/directory
agentgit-authority setup
```

This creates `.agentgit/` in your current directory, writes a default CLI profile, and prints the next steps.

> **Where is data stored?** All state lives in `<your-project>/.agentgit/state/`. The daemon is local to each project directory.

---

## Step 3: Start the Daemon

```bash
agentgit-authority daemon start
```

The daemon starts in the foreground. Open a second terminal for all the following commands.

---

## Step 4: Verify Everything Works

```bash
agentgit-authority doctor
agentgit-authority ping
```

`doctor` checks daemon reachability, storage health, and security posture. `ping` is a quick round-trip check.

---

## Step 5: Run Your First Governed Actions

```bash
# Register a run — logical grouping of agent actions
# Returns a run_id you'll use for everything else
agentgit-authority register-run my-first-run

# Submit a governed filesystem write
agentgit-authority submit-filesystem-write <run-id> /tmp/hello.txt "hello from agentgit"

# Submit a governed shell command
agentgit-authority submit-shell <run-id> echo "hello world"

# View the timeline (what happened, step by step)
agentgit-authority timeline <run-id>

# Get a run summary
agentgit-authority run-summary <run-id>
```

---

## Step 6: Use the Helper

The helper answers structured questions about a run, grounded purely in journal records:

```bash
agentgit-authority helper <run-id> what_happened
agentgit-authority helper <run-id> likely_cause
agentgit-authority helper <run-id> reversible_steps
agentgit-authority helper <run-id> external_side_effects
```

→ See the [CLI Reference](CLI-Reference.md#timeline--artifacts) for all query types.

---

## Step 7: Handle Approvals

If policy is configured to `ask` for an action, it will be blocked until you approve or deny it:

```bash
agentgit-authority list-approvals <run-id>
agentgit-authority approve <approval-id>
agentgit-authority deny <approval-id> "outside expected scope"
```

---

## Step 8: Inspect Artifacts

```bash
# View a captured artifact (stdout, file content, etc.)
agentgit-authority artifact <artifact-id> internal

# Export full body to disk (no truncation)
agentgit-authority artifact-export <artifact-id> ./exports/output.txt internal
```

---

## Step 9: Try Recovery

```bash
# Plan recovery for an action (see what would happen before committing)
agentgit-authority plan-recovery <action-id>

# Execute the plan
agentgit-authority execute-recovery <action-id>
```

---

## Using the TypeScript SDK

Once the daemon is running, embed governance in your TypeScript agent:

```bash
npm install @agentgit/authority-sdk @agentgit/schemas
```

```ts
import { AuthorityClient } from "@agentgit/authority-sdk";

// Auto-discovers socket from AGENTGIT_ROOT or cwd
const client = new AuthorityClient();

const run = await client.registerRun({
  workflow_name: "agent-run",
  workspace_roots: ["/my/project"],
});

// Full governance pipeline in one call:
// normalize → policy → snapshot → execute → journal → recovery pre-compute
const result = await client.submitActionAttempt({
  run_id: run.run_id,
  tool_name: "write_file",
  execution_domain: "filesystem",
  raw_inputs: { path: "/my/project/output.txt", content: "hello" },
  workspace_roots: ["/my/project"],
});

// Inspect
const timeline = await client.queryTimeline(run.run_id);

// Answer a structured question
const answer = await client.queryHelper(run.run_id, "what_happened");
```

→ [TypeScript SDK reference](TypeScript-SDK.md)

---

## Using the Python SDK

```python
from agentgit_authority import AuthorityClient, build_register_run_payload

# Resolves socket from AGENTGIT_ROOT, INIT_CWD, or cwd
client = AuthorityClient()

run = client.register_run(
    build_register_run_payload("agent-run", ["/my/project"])
)
client.submit_filesystem_write(
    run["run_id"], "/my/project/out.txt", "hello",
    workspace_roots=["/my/project"],
)

timeline = client.query_timeline(run["run_id"])
answer = client.query_helper(run["run_id"], "what_happened")
```

→ [Python SDK reference](Python-SDK.md)

---

## Development Setup (From Source)

```bash
git clone https://github.com/agentgit/agentgit
cd agentgit
pnpm install
pnpm build
pnpm daemon:start   # foreground daemon

# Second terminal
pnpm cli register-run dev-test
pnpm cli submit-filesystem-write <run-id> /tmp/test.txt "hello"
pnpm cli timeline <run-id>
```

→ [Contributing guide](Contributing.md)

---

## What's Next

| Topic | Link |
|-------|------|
| How it all works | [Architecture](Architecture.md) |
| Key concepts | [Core Concepts](Core-Concepts.md) |
| All CLI commands | [CLI Reference](CLI-Reference.md) |
| TypeScript SDK | [TypeScript SDK](TypeScript-SDK.md) |
| Python SDK | [Python SDK](Python-SDK.md) |
| Policy tuning | [Policy Engine](Policy-Engine.md) |
| Recovery & undo | [Recovery & Snapshots](Recovery-and-Snapshots.md) |
| MCP servers | [MCP Integration](MCP-Integration.md) |
| Audit bundles | [Audit & Evidence](Audit-and-Evidence.md) |
| Config reference | [Configuration](Configuration.md) |
