# CLI Release And Install

## Scope

This document describes the release/install path for the public TypeScript package surface:

- `@agentgit/schemas`
- `@agentgit/authority-sdk`
- `@agentgit/authority-cli`

## Release Model

Versioning is managed through Changesets in [/Users/geoffreyfernald/Documents/agentgit/.changeset](/Users/geoffreyfernald/Documents/agentgit/.changeset).

The GitHub release workflow in [.github/workflows/release.yml](/Users/geoffreyfernald/Documents/agentgit/.github/workflows/release.yml):

- installs with pinned Node/pnpm baselines
- runs `pnpm release:verify`
- packs release artifacts with cryptographic signing in required mode
- verifies signed artifacts before publish
- creates or updates a Changesets release PR when unreleased changesets exist
- publishes through `pnpm release:publish` when version bumps have landed on `main`
- enables npm provenance through `NPM_CONFIG_PROVENANCE=true`

## Verification Gates

`pnpm release:verify` runs:

- `pnpm lint`
- `pnpm format:check`
- `pnpm release:verify:claims`
- `pnpm release:verify:coverage-ratchet`
- `pnpm security:audit`
- `pnpm test:coverage`
- `pnpm py:test`
- `pnpm smoke:cli-install`
- `pnpm smoke:cli-compat`

`release.yml` adds post-verify hard gates:

- `pnpm release:pack --signing-mode required`
- `node scripts/verify-release-artifacts.mjs --signature-mode required`

## Current Status (As Of 2026-04-02)

Release verification is green end-to-end in this workspace:

- `pnpm release:verify` passes
- signed artifact pack+verify rehearsal passes using real cryptographic keys
- install and compatibility smoke gates pass

## Signing Key Inputs

Release signing uses PEM material supplied through CI secrets:

- `AGENTGIT_RELEASE_SIGNING_PRIVATE_KEY_PEM_B64`
- `AGENTGIT_RELEASE_SIGNING_PUBLIC_KEY_PEM_B64`

Release publish should remain blocked until both secrets are configured.

## Installed-Binary Smoke Intent

`pnpm smoke:cli-install` verifies a real install path by:

- packing publishable tarballs
- installing tarballs into a clean temp directory outside the monorepo
- starting a real authority daemon from the repo
- running installed `agentgit-authority` binary operations against that daemon

`pnpm smoke:cli-compat` extends this with compatibility, upgrade, rollback, and audit-bundle behavior checks.

## Local Operator Commands

```bash
pnpm release:verify
pnpm release:pack --signing-mode required
node scripts/verify-release-artifacts.mjs --artifacts-dir .release-artifacts/packed --signature-mode required
```

Day-one operational procedures are in
[engineering-docs/CLI-OPERATOR-RUNBOOK.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/CLI-OPERATOR-RUNBOOK.md).
