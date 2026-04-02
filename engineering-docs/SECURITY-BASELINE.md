# Security Baseline

Status date: 2026-04-02 (America/New_York)

## Purpose

Define the minimum security controls required for MVP production readiness.

## Scope

Applies to:

- local authority daemon
- CLI and SDK release path
- local MCP execution trust controls
- release and CI verification workflows

## Baseline Controls

### Secrets And Credential Handling

Required:

- secrets stored using OS-backed secure providers (macOS Keychain / Linux Secret Service)
- encrypted at rest with expiry metadata
- direct credential execution paths denied for governed actions where policy requires brokered flows

Primary implementation references:

- [packages/credential-broker/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/credential-broker/src/index.ts)
- [packages/execution-adapters/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/execution-adapters/src/index.ts)

### MCP OCI Supply-Chain Controls

Required for remote OCI stdio MCP execution:

- digest pinning
- `allowed_registries` allowlist
- `signature_verification` policy (cosign keyless + issuer/identity checks)
- SLSA provenance enforcement unless explicitly in local-development build mode

Primary implementation references:

- [packages/mcp-registry/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/mcp-registry/src/index.ts)
- [packages/execution-adapters/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/execution-adapters/src/index.ts)

### Runtime Fail-Closed Behavior

Required:

- unsupported governed surfaces fail closed
- malformed or unsafe execution requests return structured errors
- no silent downgrade to ungoverned execution

Primary implementation references:

- [packages/authority-daemon/src/server.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-daemon/src/server.ts)
- [packages/authority-daemon/src/server.integration.test.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-daemon/src/server.integration.test.ts)

### Evidence Integrity

Required:

- audit export/verify/report/share/compare flows remain stable
- verify failures are treated as hard stop for trust
- artifact access and visibility scope controls are enforced

Primary implementation references:

- [packages/authority-cli/src/main.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-cli/src/main.ts)
- [engineering-docs/CLI-OPERATOR-RUNBOOK.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/CLI-OPERATOR-RUNBOOK.md)

## CI Security Requirements

Required in CI/release path:

1. dependency vulnerability scanning for:
- Node dependencies
- Python dependencies

2. hardened runtime test coverage:
- OCI sandbox adversarial path tests
- Linux Secret Service tests

3. baseline toolchain alignment:
- security workflow Node/pnpm versions match repo baseline (`.node-version`, root `packageManager`)

Current implementation status:

- `pnpm security:audit` is active in CI and release verification path.
- `.github/workflows/security-hardening.yml` now matches `.node-version` and pnpm baseline.

## Severity And SLA

- `Critical`: active exploit path or evidence-integrity compromise
  SLA: acknowledge immediately, containment within 4 hours, remediation start same day.
- `High`: high-confidence vulnerability with meaningful production risk
  SLA: acknowledge within 1 business day, remediation plan within 2 business days.
- `Medium`: moderate risk with compensating controls available
  SLA: remediation plan within 5 business days.
- `Low`: low exploitability or low impact
  SLA: triage in normal patch cycle.

## Ownership

- Runtime security controls: daemon/execution maintainers
- Release and CI security gates: release engineering owner
- Incident response and operator procedures: operations owner

Each release candidate must identify named owners for all three roles.

## Launch Exit Criteria

Security baseline is complete for MVP when:

1. baseline approved,
2. dependency scanning gates active in CI,
3. security workflow toolchain aligned to repo baseline,
4. operator runbook includes SEV escalation and tamper response,
5. release verification is green end-to-end.

Current status: `Complete`.
