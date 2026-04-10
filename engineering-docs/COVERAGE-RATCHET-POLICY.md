# Coverage Ratchet Policy

Status date: 2026-04-09

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
- Re-baseline measured coverage with `pnpm release:refresh-coverage-baseline -- --reason "<why the measured floor changed>"` after a fresh `pnpm test:coverage` run.

## Current Baseline

- threshold floor: lines `50`, functions `50`, statements `50`, branches `40`
- measured aggregate floor: lines `72.04`, functions `78.91`, statements `71.98`, branches `58.71`

## 2026-04-09 Re-Baseline

This branch carries repo-wide production changes across the SDKs, daemon/runtime surfaces, release verification, and hosted cloud product. The measured baseline was regenerated from a fresh `pnpm test:coverage` run after those changes landed so the ratchet keeps enforcing the current tested surface instead of a stale pre-change denominator.
