# @agentgit/inspector-ui

Local operator UI for browsing agent runs, inspecting timeline steps, asking the timeline helper questions, and planning recovery — all without leaving your machine.

---

## What It Does

The inspector UI is a local web server that connects to the agentgit authority daemon and gives you a visual interface for things the CLI does via text output:

- **Run browser** — see all registered runs, their status, and at-a-glance summaries
- **Timeline viewer** — step through every governed action in a run, with policy outcomes, approval status, and execution results
- **Helper Q&A** — ask natural-language questions about a run ("what files did the agent write?", "were any actions denied?")
- **Recovery planner** — inspect a recovery plan before executing it, with confidence scores and impact preview
- **Artifact inspector** — view captured artifact bodies with visibility controls

---

## Start

With the daemon running:

```bash
# From repo root
pnpm --filter @agentgit/inspector-ui dev

# Or build and run
pnpm --filter @agentgit/inspector-ui build
pnpm --filter @agentgit/inspector-ui start
```

Then open `http://localhost:4000` (or whichever port is configured).

---

## Configuration

The UI connects to the daemon via the same Unix socket as the CLI and SDK:

```bash
AGENTGIT_SOCKET_PATH=/path/to/.agentgit/authority.sock  # default: ~/.agentgit/authority.sock
INSPECTOR_PORT=4000
```

---

## Architecture

The inspector UI is a thin TypeScript server that:

1. Accepts connections from your browser
2. Forwards queries to the authority daemon via `@agentgit/authority-sdk`
3. Renders timeline projections, helper responses, and recovery plans from the daemon's responses

It has no database of its own — all data comes from the daemon, which reads from the durable run journal.

---

## Related

- [`@agentgit/authority-sdk`](../packages/authority-sdk-ts/README.md) — the SDK used to talk to the daemon
- [`@agentgit/authority-cli`](../packages/authority-cli/README.md) — CLI alternative for the same inspection operations
- [`@agentgit/timeline-helper`](../packages/timeline-helper/README.md) — the daemon subsystem that answers helper questions
