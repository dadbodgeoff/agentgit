# Contained GA Signoff Checklist

Status date: 2026-04-03 (America/New_York)

Use this checklist before declaring the contained runtime path fully production ready.

## Release Scope

- shipped backends are explicitly listed
- assurance language for each shipped backend is approved
- degraded states for each shipped backend are documented

## Engineering Signoff

- backend interface is stable and used by all shipped contained backends
- `setup`, `run`, `inspect`, `restore`, `remove`, and `repair` all pass on every shipped backend
- launch startup failures do not leave misleading run metadata or orphaned contained state
- backend drift is surfaced through `inspect`, `repair`, and launch preflight
- restore semantics are consistent across shipped backends
- remove and repair preserve unrelated user changes

## Security Signoff

- direct host env passthrough remains explicit-only
- brokered secrets do not leak through:
  - state documents
  - logs
  - inspect output
  - error messages
- expired or missing brokered bindings fail closed before launch
- egress language does not over-claim beyond actual backend enforcement
- degraded containment states are visible and honest

## QA Signoff

- deterministic unit suite is green
- fixture and adapter suite is green
- live backend integration suite is green
- restart resilience scenarios are green
- restore conflict scenarios are green
- uninstall and rollback scenarios are green
- idempotency scenarios are green
- demo latency remains within target

## Product / UX Signoff

- Recommended setup remains low-friction
- Advanced setup remains bounded and understandable
- assurance and governance language are plain-English and accurate
- degraded reasons are comprehensible to a non-operator user
- contained inspect and restore flows still feel coherent

## Commands Verified

- `agentgit setup`
- `agentgit setup --repair`
- `agentgit setup --remove`
- `agentgit setup --contained`
- `agentgit run`
- `agentgit demo`
- `agentgit inspect`
- `agentgit restore`

## Repo Verification

- `pnpm --filter @agentgit/agent-runtime-integration build`
- `pnpm --filter @agentgit/agent-runtime-integration typecheck`
- `pnpm --filter @agentgit/agent-runtime-integration test`
- `pnpm typecheck`
- `pnpm test`

## No-Go Conditions

- any shipped backend can silently downgrade while still appearing healthy
- any secret value appears in logs, inspect output, or persisted state
- restore or remove behavior is backend-dependent without being surfaced
- egress claims exceed actual enforcement
- launch preflight allows a known-invalid contained profile to run

## Signoff Record

- Engineering:
- Security:
- QA:
- Product / UX:
- Release date:
