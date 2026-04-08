# AgentGit — Landing Page Copy

> Source of truth for the homepage hero, feature sections, and primary CTAs. Written in the AgentGit voice: technical, proof-over-promise, operator-first. No hype words. Sentence case.

**Brand rules for this page**
- Product name is always **AgentGit** (never "agentgit" or "Agent Git"). In running text, the wordmark is Agent in primary, Git in Agent Teal.
- Primary tagline: **Autonomous DevOps. Human control.**
- Palette: Void `#0B0F14`, Slate `#1A2230`, Steel `#222D3D`, Fog `#F0F2F5`, Agent Teal `#0ACDCF`. Lime accents are reserved for agent-initiated state — do **not** use on marketing hero or CTAs.
- Typography: IBM Plex Sans for UI text, IBM Plex Mono for code and operator chrome.

---

## Hero

### Headline (primary)
**Autonomous DevOps. Human control.**

### Sub-headline
AgentGit is the governance layer for AI agents in the software development lifecycle. Every file write, shell command, and MCP call your agent makes is normalized, policy-checked, snapshot-backed, executed in a governed adapter, and journaled append-only — on the operator's machine, with no telemetry.

### Primary CTA
`npm i -g @agentgit/authority-cli`  →  **Install in 30 seconds**

### Secondary CTA
Read the architecture →

### Trust strip (under the fold)
- Local-first. Data never leaves the machine.
- Deterministic policy. No opaque ML scoring.
- MIT-licensed. Signed releases. Reproducible builds.
- Composes with LangGraph, OpenAI Agents SDK, Claude Agent SDK, and any runtime that can talk to a socket.

---

## Headline alternates (A/B test pool)

1. Autonomous DevOps. Human control.
2. The governance layer autonomous agents were missing.
3. Deterministic policy. Snapshot-backed recovery. Durable evidence.
4. Agents need guardrails — not guidelines.
5. Ship agents to production without shipping your uptime with them.
6. The local daemon that makes agent autonomy survivable.

---

## The problem

### Header
**Agents ship code. Nothing checks them.**

### Body
You gave an AI agent a real repo, a real shell, and real MCP servers. It worked — until it didn't. Then you had four questions and no good answers.

- What did the agent actually do?
- How do I roll back the part that went wrong without losing the part that went right?
- How do I enforce "never touch prod" or "ask before deleting"?
- How do I trust an MCP server I didn't write?

Frameworks give agents more power. AgentGit gives operators the control surface that makes that power safe to ship.

---

## How it works

### Header
**One daemon. Eight governance stages. Every action accounted for.**

### Eight-stage pipeline

1. **Action normalizer** — Canonicalize raw agent intent into a durable record with provenance, scope, and risk hints.
2. **Policy engine** — Deterministic outcomes: `allow` · `deny` · `ask` · `simulate` · `allow_with_snapshot`. Same action plus same policy returns the same result, every time.
3. **Snapshot engine** — Capture a rollback boundary *before* the action runs, using the cheapest class that still honors the recovery promise.
4. **Execution adapters** — Governed side effects: filesystem, shell, MCP (stdio + streamable HTTP), and operator-owned functions. Unsupported surfaces fail closed with `PRECONDITION_FAILED`.
5. **Run journal** — Append-only SQLite journal linking action, policy outcome, snapshot, result, and approvals.
6. **Recovery engine** — Pre-computed recovery plan for every recoverable action: restore, compensate, review-only, or documented irreversible.
7. **Timeline & helper** — Deterministic projection of the journal into a readable story. "What happened," "what changed," "likely cause" — no LLM required.
8. **Operator surfaces** — CLI, TypeScript SDK, Python SDK, local Inspector UI, and AgentGit Cloud for teams who want managed governance.

### Footer under the diagram
> Everything is local-first. Data never leaves the machine unless an operator exports an audit bundle.

---

## Feature grid

### Deterministic policy
Rules are explicit, layered, and operator-owned. No confidence-magic. No hidden LLM tiebreakers. Golden-fixture tests in the repo prove the same inputs produce the same outputs across releases.

### Recovery that actually runs
Snapshots are captured *before* the action, not after. Recovery plans are pre-computed, operator-reviewed, and drill-tested. When something goes wrong, you do not debug — you roll back.

### MCP with a real trust model
- OS-backed secret storage (macOS Keychain / Linux Secret Service)
- Digest-pinned OCI containers for stdio servers, `--cap-drop=ALL`
- Cosign signature verification with SLSA provenance enforcement
- Explicit HTTPS host allowlists with DNS/IP scope validation
- Per-server tool allowlists with approval-mode overrides

### Durable, exportable audit
Every run can be exported to a tamper-detectable evidence bundle. Verify it. Share a redacted version. Hand it to security or compliance. Any reviewer can re-verify without the daemon.

### Policy calibration loop
Run `policy calibration-report` after a week of real traffic. Get data-driven threshold recommendations. Replay candidate thresholds against the actual journaled history. Adopt only what you review. Policy never mutates itself.

### Local-first, by design
No cloud dependency. No telemetry. No auth handshake with a SaaS. The daemon runs on the operator's machine, in the operator's workspace, against the operator's files. Multi-machine inspection is handled by exporting evidence bundles — on operator terms.

### AgentGit Cloud (optional)
For teams that want managed governance, AgentGit Cloud is a hosted GitHub-integrated surface sitting on the same governance spine as the OSS daemon. Multi-repo oversight, team-based approval flows, run dashboards, and audit history — with the same deterministic policy contract.

---

## Installation block

```bash
# Operator CLI + daemon
npm install -g @agentgit/authority-cli
agentgit-authority setup
agentgit-authority daemon start

# In a second terminal
agentgit-authority register-run my-first-run
agentgit-authority submit-filesystem-write <run-id> /tmp/hello.txt "hello"
agentgit-authority timeline <run-id>
```

TypeScript:

```ts
import { AuthorityClient } from "@agentgit/authority-sdk";
const client = new AuthorityClient({ socketPath: "/path/to/.agentgit/authority.sock" });
const run = await client.registerRun({ display_name: "my-run", workspace_roots: ["/ws"] });
await client.submitActionAttempt({ run_id: run.run_id, tool_name: "write_file",
  execution_domain: "filesystem", raw_inputs: { path: "/ws/f.txt", content: "hi" },
  workspace_roots: ["/ws"] });
```

Python:

```python
from agentgit_authority import AuthorityClient, build_register_run_payload
client = AuthorityClient()
run = client.register_run(build_register_run_payload("my-run", ["/ws"]))
client.submit_filesystem_write(run["run_id"], "/ws/f.txt", "content", workspace_roots=["/ws"])
```

---

## Who this is for

**Use AgentGit if:**
- You run agents against a real codebase, a real shell, or real MCP servers.
- You cannot afford "the agent deleted something and we do not know what."
- You need an audit trail you can hand to security, compliance, or your own future self.
- You want operator control without hand-writing a policy enforcement framework.

**You probably don't need AgentGit (yet) if:**
- Your agent is stateless and only writes to a chat UI.
- You only run agents in throwaway sandboxes you are happy to burn.
- You want a hosted SaaS *exclusively* — the OSS daemon is local-first at launch, and AgentGit Cloud is currently in design-partner mode.

---

## Positioning vs. the neighborhood

| Tool category | What it does | Where AgentGit fits |
|---|---|---|
| Agent runtimes (LangGraph, OpenAI Agents SDK, Claude Agent SDK) | Orchestrate LLM calls, tool use, memory | AgentGit sits *below* them as the execution authority |
| Guardrails frameworks (Guardrails AI, NeMo Guardrails) | Validate model outputs | AgentGit governs *actions* pre-execution and adds recovery |
| MCP gateways / proxies | Route tool calls | AgentGit has MCP trust as one of eight subsystems |
| Observability (Langfuse, Helicone, Braintrust) | Log what the model said | AgentGit logs what the agent actually did — with rollback |

AgentGit is **not a replacement** for a runtime or an observability stack. It is the governance layer you compose with them.

---

## Proof strip

- `@agentgit/authority-cli`, `@agentgit/authority-daemon`, `@agentgit/authority-sdk`, `@agentgit/schemas` — all live on npm
- Python SDK shipping source-only for the alpha
- MIT-licensed, reproducible builds, CI-enforced coverage ratchet
- Recovery drills, policy golden-fixture tests, and pre-launch adversarial audit runbooks all in-repo
- AgentGit Cloud implementation spec published and in active build

---

## FAQ

**Is this a framework?**
No. It is a local daemon your agent runtime calls into. It composes with LangGraph, OpenAI Agents SDK, Claude Agent SDK, and any custom runtime.

**Does it slow agents down?**
Governance runs inline, but the heavy lifting (snapshots, journaling) is designed to be cheap. Policy evaluation is deterministic and fast. You trade microseconds for reversibility.

**Is there a hosted version?**
Yes — AgentGit Cloud is a hosted GitHub-integrated layer on top of the same governance spine. The OSS daemon remains local-first and MIT.

**What about browser agents and computer use?**
Out of scope for the alpha. AgentGit fails closed on unsupported surfaces rather than silently pretending to govern them.

**How do I trust the policy engine?**
Read the golden-fixture tests. Run `policy explain` on any attempted action. The outcome is deterministic — any reviewer can verify it.

**What language can my agent be written in?**
Anything that can talk to the TypeScript SDK, the Python SDK, or the CLI. Unix domain socket IPC; bindings are small.

---

## Final CTA

### Header
**Ship the agent. Keep the receipts.**

### Buttons
- `npm i -g @agentgit/authority-cli` → **Install**
- **Read the architecture →**
- **Star on GitHub →**

---

## Footer microcopy

Autonomous DevOps. Human control. Built for operators who believe autonomy and accountability are the same feature.
