# Production Beta Deck Evidence Prompt

Use this prompt when refreshing the pitch deck or release-readiness slide copy. Keep the tone precise: the story is that AgentGit measures operational risk honestly, with verified local production-beta evidence. Keep external blockers out of deck copy; use them only as internal claim boundaries.

```text
Update the AgentGit production-beta evidence slide using only verified local evidence from the April 26 release-readiness campaign.

Product brief:
- AgentGit is local-first execution authority for autonomous agents. It sits between an agent runtime and the operating system, shell, files, MCP tools, and owned integrations.
- The product exists because autonomous agents need to keep moving, but normal approve/deny gates turn autonomy into a stop-and-wait workflow.
- AgentGit adds a third path: `allow_with_snapshot`. When an action is risky but recoverable, the system captures a rollback boundary, executes the action through a governed adapter, records the whole causal chain, and keeps the agent flow moving.
- Deny still exists for actions that should never auto-run: secret paths, control surfaces, outside-workspace writes, symlink escapes, and effects the system cannot honestly recover.
- Ask/review still exists for ambiguous or irreversible actions. The point is not to remove control; the point is to reserve human interruption for actions that actually need it.
- The slide story should be: AgentGit turns agent governance from a binary permission checkpoint into a recoverable execution layer. More useful work can happen autonomously because safe rollback, audit evidence, and recovery plans are built into the action path.
- Core flow: normalize action -> evaluate policy -> snapshot when recoverable -> execute through governed adapter -> append to journal -> precompute recovery -> expose timeline/audit/helper views.

Core claim:
- AgentGit now has repeatable production-beta qualification gates for local product readiness.
- The full release-readiness gate has 32 passing suites and 0 failed executable suites.
- Say "local production-beta qualification" or "production-beta hardening", not "fully production-ready."

Performance numbers to use:
- Use isolated benchmark evidence, not the full r7 matrix numbers.
- Isolated benchmark run: release-readiness-perf-isolated-2026-04-26.
- action submission to governance decision p99: 209.28ms.
- snapshot creation p99: 202.74ms.
- snapshot restore p99: 199.16ms.
- audit query p99: 180.48ms.
- throughput: 5.03 actions/sec and 105.57 snapshots/min on this local machine.
- daemon boot: 1123.61ms.
- first action after restart: 229.21ms.

Important honesty note:
- The r7 full-matrix benchmark showed snapshot p99 1931.82ms and restore p99 1684.53ms, but an isolated rerun returned snapshot p99 202.74ms and restore p99 199.16ms. Treat the r7 spike as full-gate contention, not as the canonical latency baseline.
- Say: "Performance numbers are measured in an isolated local benchmark; the full qualification matrix is retained as pass/fail gate evidence."

Correctness evidence to include:
- OpenClaw stress: 36 attempted actions, 25 denials, 11 snapshot-backed actions, 0 exact restore mismatches, 0 checkpoint mismatches.
- Scale soak: 96 attempted actions, 65 denials, 31 snapshot-backed actions, 0 restore mismatches.
- Concurrent agents: 5 agents, 60 attempted actions, 0 restore mismatches.
- Data integrity property suite: 3 seeds, 54 attempted actions, 0 restore mismatches.
- Backup/restore drill: RTO 340ms, RPO target latest valid action boundary, restored true.
- Adversarial containment: 10/10 probes passed, 0 content leaks, 0 filesystem changes.

Security and quality evidence to include:
- Semgrep static analysis: 0 findings.
- gitleaks secret scan: 0 findings across git history and 29 source/config/doc targets.
- SBOM generated in CycloneDX format: 41 workspace components, 16 packed-artifact components.
- Visual regression: public route screenshot diffs pass for /, /pricing, /docs, and /sign-in.
- Observability coverage: token-gated Prometheus-format cloud route metrics emit non-zero API response and route-error samples.

Avoid:
- "Fully production ready."
- "Hosted production tested."
- "No security risk."
- Using the r7 full-matrix p99 numbers as product latency.
- Listing external blockers in deck copy. Keep those in the internal evidence report only.
```
