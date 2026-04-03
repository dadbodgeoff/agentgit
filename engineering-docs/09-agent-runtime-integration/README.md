# 09. Agent Runtime Integration

Status date: 2026-04-03 (America/New_York)

This subsystem defines the productized integration layer that turns the existing AgentGit authority runtime into a dumb-easy safety and recovery layer for self-hosted autonomous agents.

The core product statement is:

**AgentGit governs agents you launch.**

That means:

- users keep the agent they already like
- AgentGit becomes the local execution governance, audit, and recovery layer underneath it
- the first-run user experience is a tiny product surface, not the current full operator CLI

## Why This Exists

The repo already implements the hard local-first runtime primitives:

- daemon bootstrap and local profile setup in [/Users/geoffreyfernald/Documents/agentgit/packages/authority-cli/src/main.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-cli/src/main.ts)
- local authority runtime in [/Users/geoffreyfernald/Documents/agentgit/packages/authority-daemon/src/runtime.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-daemon/src/runtime.ts)
- governed action submission for filesystem, shell, MCP, and owned functions in [/Users/geoffreyfernald/Documents/agentgit/packages/authority-daemon/src/server.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-daemon/src/server.ts)
- operator inspection and recovery commands in [/Users/geoffreyfernald/Documents/agentgit/packages/authority-cli/src/main.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-cli/src/main.ts)

What the repo does not yet provide is a product layer that:

- detects a user’s agent runtime automatically
- installs or wraps the right integration path
- gets the user to a governed action in under 60 seconds on the happy path
- makes inspect and restore feel like daily-driver verbs instead of operator forensics

That product layer is the job of this subsystem.

Current implementation progress:

- Phase 1 is shipped: product `inspect` and `restore` explain recovery boundary strength and preview-only rationale
- Phase 2 is shipped: `agentgit run --checkpoint` creates an explicit user-facing restore boundary, and `run` now supports deliberate checkpoint kind/reason controls without expanding the five-command surface
- Phase 3 is shipped: snapshot selection now widens earlier based on repeated ambiguous shell and mutation history inside the same run
- approval-light automation R&D is documented: humans should be reserved for degraded or unrecoverable situations, while recoverable risk shifts toward automatic `allow_with_snapshot` and contained publication control

Related R&D:

- [/Users/geoffreyfernald/Documents/agentgit/engineering-docs/09-agent-runtime-integration/approval-light-automation-rd.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/09-agent-runtime-integration/approval-light-automation-rd.md)
- [/Users/geoffreyfernald/Documents/agentgit/engineering-docs/09-agent-runtime-integration/production-readiness-tdd.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/09-agent-runtime-integration/production-readiness-tdd.md)

## Product Law

**Seatbelt, not a framework.**

Every design decision in this subsystem should preserve that law.

If a choice makes AgentGit feel like a new orchestrator, workflow engine, or agent platform, it is probably the wrong choice for the launch product.

## Product Surface

The user-facing product surface should be:

- `agentgit setup`
- `agentgit run`
- `agentgit demo`
- `agentgit inspect`
- `agentgit restore`

Setup should also support reversible lifecycle flags without expanding the top-level verb count:

- `agentgit setup --remove`
- `agentgit setup --repair`

These commands are not replacements for the full operator CLI.

They are the productized navigation layer over the existing detailed command surface. The current operator verbs remain available for:

- deep debugging
- audit workflows
- automation
- policy tuning
- advanced operators

## User Outcome

The emotional promise is the product:

- your agent can make a dangerous mistake
- you will see exactly what happened
- you can stop it, inspect it, and recover from it

The first holy-shit moment should be:

1. the agent deletes or attempts to delete a valuable file
2. AgentGit captures or blocks the action
3. AgentGit shows the exact action in the timeline
4. the user restores the file from the governed boundary

If this sequence is not fast and obvious, the product has not landed.

## Integration Philosophy

The product should feel like one smart command:

- detect first
- confirm second
- ask manually only as fallback

The user should not be asked to understand:

- socket paths
- IPC transport
- daemon lifecycle
- internal action schemas
- wrapper vs gateway vs SDK modes

Those are implementation details.

## Day-One Support

Launch support should be:

1. OpenClaw deep integration
2. generic bring-your-own-command fallback
3. Docker-backed contained generic launch for teams that want a stronger workspace boundary

OpenClaw is the best launch wedge because:

- it is open source and currently gaining adoption
- it already has setup, gateway, MCP, and ACP concepts that map well to AgentGit
- it is a strong reference integration for community follow-ons

But AgentGit must not be positioned as an OpenClaw plugin.

The product category is broader:

- agent-agnostic governance infrastructure for self-hosted agents

## Architecture Shape

The recommended architecture stacks three implementation paths behind one user experience:

1. setup/wrapper orchestration for adoption
2. MCP compatibility for broad interoperability
3. native adapters for runtimes we can govern more deeply

From the user’s perspective, all of that should collapse into:

```bash
agentgit setup
```

## Subsystem Responsibilities

This subsystem owns:

- runtime detection
- integration planning
- safe config mutation and reversal
- product command orchestration
- first-run demo path
- human-friendly inspect and restore flows
- compatibility adapters for target runtimes

This subsystem does not replace the authority daemon.

It sits above the daemon and routes users into the existing local-first control plane.

## Existing Runtime Seams To Reuse

The following seams should be reused instead of reinvented:

- current CLI config/profile persistence in [/Users/geoffreyfernald/Documents/agentgit/packages/authority-cli/src/cli-config.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-cli/src/cli-config.ts)
- current `setup` and `daemon start` orchestration in [/Users/geoffreyfernald/Documents/agentgit/packages/authority-cli/src/main.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-cli/src/main.ts)
- current low-level action submission commands in [/Users/geoffreyfernald/Documents/agentgit/packages/authority-cli/src/main.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-cli/src/main.ts)
- current timeline and recovery APIs in [/Users/geoffreyfernald/Documents/agentgit/packages/authority-daemon/src/server.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-daemon/src/server.ts)
- existing generic durable document storage in [/Users/geoffreyfernald/Documents/agentgit/packages/integration-state/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/integration-state/src/index.ts)

## Launch Success Criteria

This subsystem is successful when all of the following are true:

- a supported OpenClaw install can be connected in one command
- an unknown agent can be governed by providing only its launch command
- an unknown agent can optionally run in a contained Docker workspace with governed publish-back
- that contained Docker path can use brokered secret refs from AgentGit-managed encrypted storage instead of only host env passthrough
- setup and inspect can state the active governance mode and concrete guarantees, not only the assurance tier
- the user reaches a governed action in under 60 seconds on the happy path
- the user can run a safe built-in demo without trusting AgentGit with a real repo first
- inspect and restore work end to end from that demo
- setup is fully reversible and restores touched runtime config cleanly
- the product feels like a seatbelt on top of an existing agent, not a new agent framework

## Related Documents

- research notes: [/Users/geoffreyfernald/Documents/agentgit/engineering-docs/09-agent-runtime-integration/research-notes.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/09-agent-runtime-integration/research-notes.md)
- technical design document: [/Users/geoffreyfernald/Documents/agentgit/engineering-docs/09-agent-runtime-integration/TDD.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/09-agent-runtime-integration/TDD.md)
- production-readiness TDD: [/Users/geoffreyfernald/Documents/agentgit/engineering-docs/09-agent-runtime-integration/production-readiness-tdd.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/09-agent-runtime-integration/production-readiness-tdd.md)
- snapshot boundary audit: [/Users/geoffreyfernald/Documents/agentgit/engineering-docs/09-agent-runtime-integration/snapshot-boundary-audit.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/09-agent-runtime-integration/snapshot-boundary-audit.md)
- generic containment follow-on spec: [/Users/geoffreyfernald/Documents/agentgit/engineering-docs/09-agent-runtime-integration/generic-containment-spec.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/09-agent-runtime-integration/generic-containment-spec.md)
- contained GA implementation plan: [/Users/geoffreyfernald/Documents/agentgit/engineering-docs/09-agent-runtime-integration/contained-ga-plan.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/09-agent-runtime-integration/contained-ga-plan.md)
- contained GA release checklist: [/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/contained-ga-signoff-checklist.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/contained-ga-signoff-checklist.md)
