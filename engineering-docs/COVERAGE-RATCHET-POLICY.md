# Coverage Ratchet Policy

Status date: 2026-04-03

## Purpose

Prevent both configured-threshold regressions and measured coverage regressions in CI while allowing deliberate upward ratchets.

## Baseline Source Of Truth

Baseline thresholds and measured coverage baselines are stored in:

- [coverage-threshold-baseline.json](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/coverage-threshold-baseline.json)

Enforcement is implemented in:

- [verify-coverage-ratchet.mjs](/Users/geoffreyfernald/Documents/agentgit/scripts/verify-coverage-ratchet.mjs)

## Enforcement

`pnpm release:verify:coverage-ratchet` must pass after `pnpm test:coverage` in CI and release verification.

Verification fails when either of these is true:

- any threshold in `scripts.test:coverage` in [package.json](/Users/geoffreyfernald/Documents/agentgit/package.json) drops below baseline
- aggregate or per-package measured coverage in generated `coverage-summary.json` files drops below baseline

## Change Rules

- Raising thresholds is allowed and encouraged.
- Lowering thresholds requires explicit approval from release engineering owner and test owner.
- If measured coverage drops intentionally, update the measured baseline JSON in the same PR and explain why.
- If thresholds are intentionally raised, update baseline JSON in the same PR.

## Current Baseline

- threshold floor: lines `50`, functions `50`, statements `50`, branches `40`
- measured aggregate floor: lines `73.99`, functions `82.79`, statements `74.07`, branches `61.12`
