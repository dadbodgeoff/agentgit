# Agent Runtime Integration Research Notes

Status date: 2026-04-02 (America/New_York)

This document records the code-grounded and source-grounded research behind the productized AgentGit integration layer.

## Research Question

How do we make AgentGit dumb easy to attach to decentralized, self-hosted autonomous agents while preserving the real governance guarantees that already exist in the repo?

## Bottom-Line Answer

The correct shape is:

- `setup` as the product entrypoint
- OpenClaw as the first deep integration
- bring-your-own-command fallback on day one
- MCP compatibility for broad interoperability
- native runtime adapters for the strongest enforcement paths

The user should experience this as one smart command, not as three exposed integration modes.

## Repo Audit: What Already Exists

### 1. Beginner setup exists, but only for the CLI profile and daemon directories

Current `setup` behavior lives in [/Users/geoffreyfernald/Documents/agentgit/packages/authority-cli/src/main.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-cli/src/main.ts).

What it does today:

- writes or updates a CLI profile
- marks it active
- creates required local directories
- prints next-step daemon and doctor commands

This means the product does not need a brand-new bootstrap story. It needs a richer setup orchestrator.

### 2. The authority daemon and governed pipeline are real

Current authority runtime lives in:

- [/Users/geoffreyfernald/Documents/agentgit/packages/authority-daemon/src/runtime.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-daemon/src/runtime.ts)
- [/Users/geoffreyfernald/Documents/agentgit/packages/authority-daemon/src/server.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-daemon/src/server.ts)

The daemon already governs these execution domains:

- filesystem
- shell
- MCP
- owned function integrations

That means the fundamental control plane exists already.

### 3. Low-level product verbs already exist as operator commands

Current operator commands already support:

- `submit-filesystem-write`
- `submit-filesystem-delete`
- `submit-shell`
- `submit-mcp-tool`
- `run-summary`
- `timeline`
- `plan-recovery`
- `execute-recovery`

All of these live in [/Users/geoffreyfernald/Documents/agentgit/packages/authority-cli/src/main.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-cli/src/main.ts).

So the product work is primarily:

- orchestration
- abstraction
- integration detection
- config management
- first-run experience

### 4. The repo already has thin-wrapper architectural intent

These existing docs align strongly with the desired product direction:

- [/Users/geoffreyfernald/Documents/agentgit/engineering-docs/01-agent-wrapper-sdk/README.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/01-agent-wrapper-sdk/README.md)
- [/Users/geoffreyfernald/Documents/agentgit/engineering-docs/support-architecture/01-runtime-architecture.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/support-architecture/01-runtime-architecture.md)
- [/Users/geoffreyfernald/Documents/agentgit/engineering-docs/support-architecture/08-authority-daemon-api.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/support-architecture/08-authority-daemon-api.md)

The strongest existing theme is:

- SDKs and wrappers stay thin
- the daemon remains the canonical control plane
- governance must happen before side effects

### 5. There is already a generic local persistence seam for new integration metadata

The repo already ships a reusable SQLite-backed document store in:

- [/Users/geoffreyfernald/Documents/agentgit/packages/integration-state/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/integration-state/src/index.ts)

That makes it a strong candidate for:

- integration profiles
- adapter installation records
- config backup records
- demo completion state
- migration/version markers for the new product layer

## Product Research Synthesis

### The first 90 seconds are make-or-break

The product cannot ask users to:

- learn 160+ commands
- understand daemon transport details
- manually edit runtime configs before anything works
- trust a new governance layer on a real repo before seeing it succeed

The setup hierarchy must be:

1. detect
2. confirm
3. fallback

### The real product starts after setup

Setup is not the conversion event.

The conversion event is the first rescue moment:

- the agent attempts a dangerous action
- AgentGit catches or records it
- the user understands what happened immediately
- restore is simple and credible

That means:

- `demo`
- `inspect`
- `restore`

are first-class launch features, not follow-ons.

### Modes are implementation details

Internally, the product will likely use:

- wrapper/setup orchestration
- MCP gateway compatibility
- native runtime adapters

But users should not be asked to choose between those.

They should run:

```bash
agentgit setup
```

and let the system choose the best compatible path.

## External Research: OpenClaw

Official sources:

- [OpenClaw onboarding wizard](https://docs.openclaw.ai/start/wizard)
- [OpenClaw MCP CLI docs](https://docs.openclaw.ai/cli/mcp)
- [OpenClaw ACP CLI docs](https://docs.openclaw.ai/cli/acp)
- [OpenClaw ACP agents docs](https://docs.openclaw.ai/tools/acp-agents)
- [OpenClaw GitHub repository](https://github.com/openclaw/openclaw)

Key takeaways:

- OpenClaw already expects a guided setup/onboarding flow
- OpenClaw already has MCP and ACP concepts that map naturally to AgentGit attachment points
- OpenClaw can route work to external coding harnesses and MCP surfaces, which makes it a strong first deep integration target

Why OpenClaw is the right wedge:

- open source and inspectable
- self-hosted mental model fits AgentGit
- current hype increases adoption leverage
- ideal for building one excellent reference integration before broadening outward

## External Research: Claude Code

Official source:

- [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)

Key takeaways:

- Claude Code supports MCP installation through CLI commands
- it supports project-scoped `.mcp.json` config
- it supports user-scoped config in `~/.claude.json`
- it supports remote HTTP and local stdio MCP servers

Implication:

- Claude Code is a viable compatibility target through MCP install automation
- but MCP is an extension point, not proof of full governance over all native execution paths

That makes Claude Code a good compatibility surface, but not the best launch claim for strongest enforcement.

## External Research: Codex / OpenAI MCP

Official sources:

- [OpenAI docs MCP quickstart](https://developers.openai.com/learn/docs-mcp)
- [OpenAI developer mode guide](https://developers.openai.com/api/docs/guides/developer-mode)

Key takeaways:

- OpenAI tooling now has official MCP-oriented integration surfaces
- this makes MCP a credible interoperability layer for Codex-style usage

Implication:

- Codex-style runtimes are good MCP install targets
- they are not automatically governed unless their actual tool execution path runs through AgentGit

## External Research: MCP Specification

Official source:

- [Model Context Protocol transports specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

Key takeaways:

- the official standard transports are `stdio` and Streamable HTTP
- a universal AgentGit MCP layer should support both

Implication:

- if AgentGit exposes itself as an MCP surface later, both transports should be first-class
- `stdio` is the best local install path
- Streamable HTTP is the best compatibility path for remote or managed environments

## Key Product Conclusions

### 1. OpenClaw should be the first deep integration

Not because AgentGit is an OpenClaw plugin.

Because OpenClaw is the best launch reference integration for:

- self-hosted users
- local-first setup
- governed tool routing
- shareable launch demos

### 2. Generic command fallback must be day-one quality

If someone sees AgentGit on HN or Reddit and does not use OpenClaw, the product still needs to work.

That means the fallback experience cannot be an afterthought.

Day-one universal support should be:

- “What command starts your agent?”

If that path is polished, AgentGit becomes universal enough to matter immediately.

### 3. The product moat is agent-agnostic governance

The moat is not:

- OpenClaw integration
- one CLI wrapper
- one MCP install path

The moat is:

- agent-agnostic local governance
- inspectable action history
- credible restore and recovery
- simple enough product UX that people actually adopt it

### 4. Restore is the crown jewel

The most important user interaction is not detection.

It is:

- show me the dangerous action
- show me what changed
- let me restore the right thing quickly

That is where trust is either earned or lost.

### 5. The system must assume persistent agents, not obedient agents

The product philosophy should be:

- gate actions, not prompts
- treat retries and rephrasings as equally governed
- journal repeated attempts as meaningful signal
- fail closed when classification or safe execution guarantees are missing

## Research-Driven Build Order

The recommended build order is:

1. OpenClaw detector and installer
2. generic command fallback
3. built-in demo flow
4. human-first inspect flow
5. targeted restore UX
6. broader MCP install automation

That order protects:

- first-run adoption
- launch narrative
- product clarity
- long-term universality

## Output Documents

This research feeds:

- subsystem vision in [/Users/geoffreyfernald/Documents/agentgit/engineering-docs/09-agent-runtime-integration/README.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/09-agent-runtime-integration/README.md)
- implementation TDD in [/Users/geoffreyfernald/Documents/agentgit/engineering-docs/09-agent-runtime-integration/TDD.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/09-agent-runtime-integration/TDD.md)
