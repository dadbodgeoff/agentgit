# AgentGit — Launch Post Pack

Ready-to-post copy for the launch. Every post is written for a specific audience and channel. Swap headlines before posting to A/B test — alternates live in `01-landing-page-copy.md`.

**Brand rules:** product name is always **AgentGit**. Tagline is **Autonomous DevOps. Human control.** Voice is operator-first, technical, sentence case, proof-over-promise. No hype words ("revolutionary", "magical", "next-gen").

---

## 1. Hacker News — Show HN

**Title (≤80 chars):**
Show HN: AgentGit – governance layer for AI agents in the software lifecycle

**Body:**
Hi HN — I built AgentGit because every time I handed an autonomous agent a real shell, a real codebase, or a real MCP server, I ended up with the same four questions and no good answers: what did it actually do, how do I roll back the bad parts without nuking the good parts, how do I enforce "ask before deleting," and how do I trust an MCP server I did not write.

AgentGit is a local daemon that agents call through instead of calling the OS directly. Every action (filesystem write, shell command, MCP tool call, owned function) flows through eight stages:

1. Action normalizer — canonicalize the intent with provenance and scope
2. Policy engine — deterministic outcome: allow / deny / ask / simulate / allow_with_snapshot
3. Snapshot engine — capture a rollback boundary before the action runs
4. Execution adapter — governed side effect (filesystem, shell, MCP stdio, MCP streamable-http, owned function)
5. Run journal — append-only SQLite history linking action → policy → snapshot → result
6. Recovery engine — pre-computed recovery plan (restore, compensate, review-only, or explicitly irreversible)
7. Timeline & helper — deterministic projection of the journal, no LLM required
8. Operator surfaces — CLI, TypeScript SDK, Python SDK, local Inspector UI

A few design choices that might be interesting:

- Policy is deterministic. No opaque ML scoring. Same inputs, same outcome, every time. Golden-fixture tests are in the repo.
- Unsupported surfaces (browser control, generic HTTP, arbitrary remote MCP registration by agents) fail closed with `PRECONDITION_FAILED` instead of silently pretending to govern them.
- MCP has real trust controls: OS-backed secret storage (Keychain / Secret Service), digest-pinned OCI containers for stdio servers with `--cap-drop`, cosign signature verification with SLSA provenance, HTTPS host allowlists with DNS/IP scope validation, per-server tool allowlists.
- Audit bundles are tamper-detectable. You can export, verify, and share a redacted version. Good for security review and for your own sanity at 2am.
- Local-first. Data never leaves the machine unless you explicitly export a bundle. No telemetry.

A hosted GitHub-integrated surface, **AgentGit Cloud**, is in active build on top of the same governance spine, but the OSS daemon stays MIT and local-first.

Packages live on npm: `@agentgit/authority-cli`, `@agentgit/authority-daemon`, `@agentgit/authority-sdk`, `@agentgit/schemas`. Python SDK is source-only for the alpha.

Quickstart:

```
npm i -g @agentgit/authority-cli
agentgit-authority setup
agentgit-authority daemon start
```

MIT-licensed. Would love feedback, especially from anyone running agents in anger today — what you trust, what you don't, and what you wish your runtime handed you.

Repo: https://github.com/dadbodgeoff/agentgit

---

## 2. Reddit — r/LocalLLaMA

**Title:**
I built AgentGit — a local-first governance layer for AI agents in the software dev lifecycle. Every action is policy-checked, snapshot-backed, and journaled locally.

**Body:**
If you're running local models with tool use — Claude through the Agent SDK, Ollama-backed agents, custom runtimes — you probably already noticed the sharp edge: the agent can touch your filesystem, your shell, and your MCP servers, and you have no control plane, no rollback, and no audit log.

I've been building **AgentGit**, a local daemon that sits between your runtime and the OS. It's not a framework. It's the governance layer frameworks skip.

Quick rundown:
- Deterministic policy (allow / deny / ask / simulate / allow_with_snapshot)
- Snapshot-backed recovery — the rollback boundary is captured *before* the action runs
- Append-only SQLite run journal
- MCP trust controls with OS-backed secrets, digest-pinned OCI containers, cosign + SLSA
- Local-first, no cloud, no telemetry, MIT

Works in your terminal today: `npm i -g @agentgit/authority-cli && agentgit-authority setup`.

Happy to answer questions. I'm especially curious whether folks running long-running autonomous loops would trust this enough to actually let the agent run overnight.

---

## 3. Reddit — r/devops

**Title:**
AgentGit: governance layer for autonomous DevOps agents — deterministic policy, rollback, audit bundles

**Body:**
Cross-posting from LocalLLaMA because the DevOps angle is probably the bigger story.

Teams are deploying autonomous agents into real workflows — code edits, CI pipelines, incident response, internal tooling — and the control plane for "what is the agent allowed to do, what did it do, and how do I undo it" is basically a hand-rolled log file and a prayer.

AgentGit is the governance layer I wanted. Drop a local daemon next to your agent, route actions through it, and you get:

- Deterministic policy evaluation, layered rules, operator-reviewed thresholds
- Snapshots captured *before* risky actions, with pre-computed recovery plans
- Append-only journal with tamper-detectable audit bundles (`run-audit-export`, `run-audit-verify`)
- MCP with real trust controls: keychain-backed secrets, digest-pinned OCI containers, cosign + SLSA provenance, HTTPS allowlists
- Fail-closed on unsupported surfaces — it will not silently pretend to govern what it cannot govern

Not a SaaS. Local daemon. Your data, your machine. CLI + TS SDK + Python SDK. A hosted AgentGit Cloud layer is in build for teams that want managed multi-repo governance on top of the same spine.

`npm i -g @agentgit/authority-cli`. MIT. Repo in comments.

---

## 4. X / Twitter thread (10 tweets)

**Tweet 1**
"just let the agent do it" is how you get a 2am pager and no timeline.

I built AgentGit so autonomous agents can act — and an operator can always roll it back, audit it, or explain it.

Autonomous DevOps. Human control.

local-first. deterministic. MIT.

🧵

**Tweet 2**
the problem: your agent writes files, runs shells, calls MCP servers.

when it goes wrong, you have four questions and no good answers:
- what did it do?
- how do i roll back only the bad parts?
- how do i enforce "ask before deleting"?
- how do i trust an MCP i didn't write?

**Tweet 3**
frameworks (LangGraph, OpenAI Agents SDK, Claude Agent SDK) give agents more power.

AgentGit is the governance layer that makes that power safe to ship.

it's not a framework. it's a local daemon your runtime calls into.

**Tweet 4**
every action flows through 8 subsystems:

normalize → policy → snapshot → execute → journal → recover → timeline → operator surfaces

deterministic. no opaque ML scoring. same inputs, same outcome, verifiable with golden fixtures in the repo.

**Tweet 5**
policy outcomes are explicit:

allow · deny · ask · simulate · allow_with_snapshot

`allow_with_snapshot` is the magic one — capture the rollback boundary *before* the action runs. recovery is not "we'll try." it's "plan is pre-computed, just execute it."

**Tweet 6**
MCP trust controls are real:

• OS keychain-backed secrets
• digest-pinned OCI containers, cap-drop=ALL
• cosign + SLSA provenance enforcement
• HTTPS host allowlists w/ DNS/IP validation
• per-server tool allowlists

no more "oh the agent just calls a server and hopes."

**Tweet 7**
unsupported surfaces fail closed.

browser control, generic HTTP, agent-registered remote MCP → `PRECONDITION_FAILED`.

i'd rather tell you "this does not govern that yet" than pretend.

**Tweet 8**
everything is local-first.

data never leaves the operator's machine unless an audit bundle is explicitly exported.

no telemetry. no cloud handshake. no multi-tenant anything. just a daemon in `./.agentgit/` on your box.

AgentGit Cloud is opt-in and sits on top of the same spine.

**Tweet 9**
install:

```
npm i -g @agentgit/authority-cli
agentgit-authority setup
agentgit-authority daemon start
```

TS SDK + Python SDK both shipping. works with any runtime that can hit a unix socket.

MIT license. reproducible builds. signed releases.

**Tweet 10**
if you run agents against a real codebase, a real shell, or a real MCP server — please try it and tell me what breaks.

repo: github.com/dadbodgeoff/agentgit
docs: the wiki has the architecture, core concepts, recovery, MCP trust review, and calibration loop.

🙏

---

## 5. LinkedIn post (long-form, CTO / dev-lead audience)

**Hook:**
Teams are shipping autonomous agents into real software workflows with a control plane best described as "a log file and a prayer." That is not sustainable, and I've spent the last several months building the thing I wished existed.

**Body:**

Introducing **AgentGit** — the governance layer for AI agents in the software development lifecycle.

**Autonomous DevOps. Human control.**

The gap I kept hitting: every agent runtime — LangGraph, OpenAI Agents SDK, Claude Agent SDK, custom — is very good at orchestrating LLM calls and tool use. None of them answer the operational questions that matter the moment you take an agent past the toy stage:

• What did the agent actually do, in the order it did it, with what inputs and outputs?
• When it goes wrong mid-run, how do you roll back only the bad parts?
• How do you enforce operator rules like "ask before deleting" or "never write outside this workspace"?
• How do you give an agent access to an MCP server without handing it unchecked credentials?

AgentGit is the answer I wrote for myself and am now sharing. It is a local daemon your agent calls into instead of calling the OS directly. Every action — filesystem write, shell command, MCP tool call, owned function — flows through eight subsystems: action normalization, deterministic policy, snapshot capture, governed execution, append-only journaling, recovery planning, timeline projection, and operator surfaces (CLI, TypeScript SDK, Python SDK, local inspector UI).

A few things I made non-negotiable, because this is the kind of tool that only works if you can trust it:

1. **Deterministic policy.** No opaque ML scoring. Given the same action and policy, the outcome is identical every time. Verifiable with golden-fixture tests in the repo.
2. **Snapshots captured before the action runs**, not after the fact. Recovery is pre-computed, operator-reviewed, and drill-tested.
3. **Fail-closed on unsupported surfaces.** Browser control, generic HTTP, agent-initiated remote MCP registration — all explicitly return a precondition failure instead of silently pretending to govern what we cannot govern today.
4. **MCP with a real trust model.** OS-backed secrets via Keychain / Secret Service. Digest-pinned OCI containers for stdio servers with `--cap-drop=ALL`. Cosign signature verification with SLSA provenance. HTTPS host allowlists with DNS and IP scope validation. Per-server tool allowlists.
5. **Local-first.** Data never leaves your machine unless you explicitly export an audit bundle. No telemetry. No cloud handshake. The agent's history belongs to you.

For teams that want managed governance, **AgentGit Cloud** is a hosted GitHub-integrated layer on top of the same governance spine — multi-repo oversight, team approval flows, run dashboards, audit history, with the same deterministic policy contract.

If you are running agents in anger today — or planning to — I would love for you to try AgentGit and tell me where it breaks, what feels heavy, and what operational question you still cannot answer after installing it.

`npm i -g @agentgit/authority-cli`

MIT-licensed. Reproducible builds. The wiki covers the architecture, core concepts, recovery, MCP trust review, and policy calibration loop.

Repo and docs in comments.

---

## 6. Product Hunt launch copy

**Tagline (60 chars max):**
Autonomous DevOps. Human control.

**Description (260 chars max):**
AgentGit is the governance layer for AI agents in the software lifecycle. Every file write, shell command, and MCP call is policy-checked, snapshot-backed, and journaled locally. Deterministic policy. Drill-tested rollback. Tamper-detectable audit. MIT.

**First comment (maker):**
Hi Product Hunt — I built AgentGit because every time I handed an AI agent a real shell or a real codebase, I ended up with the same four questions and no good answers.

It is a local daemon that sits between your agent runtime and the OS. Every action flows through a deterministic policy engine, gets a rollback snapshot if it needs one, runs in a governed adapter, and lands in an append-only journal you can export and verify.

It is not a framework. It composes with LangGraph, OpenAI Agents SDK, Claude Agent SDK, and anything else that can talk to a socket. It is local-first, MIT-licensed, and the packages are already on npm. A hosted AgentGit Cloud layer is in active build for teams that want managed multi-repo governance on top of the same spine.

Would love your feedback — especially if you are running autonomous agents against real files today. What do you trust? What do you not? What would you want the control plane to hand you at 2am?

---

## 7. Cold DM / outreach to design partners

**Subject:** quick question — who owns agent control plane on your team?

**Body:**
Hi [NAME] — saw [SPECIFIC THING THEY SHIPPED / POSTED] and wanted to ask something narrow.

If one of your agents — Claude, custom runtime, whatever — went rogue mid-run tonight and wrote to the wrong file, how would you answer these three questions tomorrow morning:

1. What exactly did it do, in order?
2. How do you roll back the bad parts without losing the good parts?
3. What did it touch that you did not expect?

I've been building AgentGit — a local-first governance layer for AI agents in the software dev lifecycle — because I got tired of not having good answers. It governs every action, captures rollback snapshots before risky writes, and keeps an append-only audit you can export.

It is free, MIT, and works with any runtime. Would you be open to a 20-minute call so I can show you the 60-second "agent writes → policy → snapshot → rollback → audit" demo and hear whether it would actually save your team on a real incident?

— [YOU]

---

## Launch day checklist (posting order)

1. Push final release tag, update README, freeze packages.
2. 7:00 AM PT — Post to Hacker News (Show HN). Do not ask for upvotes; HN hates that.
3. 7:05 AM PT — Post LinkedIn long-form.
4. 7:10 AM PT — Start X / Twitter thread.
5. 8:30 AM PT — Post to r/LocalLLaMA and r/devops (stagger by ~30 min; each subreddit has anti-spam rules).
6. 9:00 AM PT — Post to Product Hunt (if running a PH launch day — this pulls a separate traffic spike and needs its own day ideally).
7. Throughout the day — reply to every comment. Fast, specific, technical, not defensive.
8. EOD — write a short retro: traffic sources, top questions, top objections, top feature requests. Feeds the v0.2 backlog.
