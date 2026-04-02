# Coverage Ratchet Policy

Status date: 2026-04-02

## Purpose

Prevent coverage threshold regressions in CI while allowing deliberate upward ratchets.

## Baseline Source Of Truth

Baseline thresholds are stored in:

- [coverage-threshold-baseline.json](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/coverage-threshold-baseline.json)

Enforcement is implemented in:

- [verify-coverage-ratchet.mjs](/Users/geoffreyfernald/Documents/agentgit/scripts/verify-coverage-ratchet.mjs)

## Enforcement

`pnpm release:verify:coverage-ratchet` must pass in CI and release verification.

If any threshold in `scripts.test:coverage` in [package.json](/Users/geoffreyfernald/Documents/agentgit/package.json) is below baseline, verification fails.

## Change Rules

- Raising thresholds is allowed and encouraged.
- Lowering thresholds requires explicit approval from release engineering owner and test owner.
- If thresholds are intentionally raised, update baseline JSON in the same PR.

## Current Baseline

- lines: `30`
- functions: `30`
- statements: `30`
- branches: `20`
