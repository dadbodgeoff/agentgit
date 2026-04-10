# CLI Release And Install

## Scope

This document describes the release/install path for the public npm package surface. The authoritative package list is discovered from non-private package manifests in `packages/*/package.json` and is used by artifact packing, artifact verification, and package smoke.

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
- `pnpm typecheck`
- `pnpm release:verify:claims`
- `pnpm release:verify:coverage-ratchet`
- `pnpm security:audit`
- `pnpm test:coverage`
- `pnpm py:test`
- `pnpm py:build`
- `pnpm release:pack`
- `pnpm release:verify:artifacts`
- `pnpm smoke:public-packages`
- `pnpm smoke:cli-install`
- `pnpm smoke:agent-runtime-install`
- `pnpm smoke:cli-compat`
- `pnpm smoke:cloud-hosted`

`release.yml` adds post-verify hard gates:

- `pnpm release:pack --signing-mode required`
- `node scripts/verify-release-artifacts.mjs --signature-mode required`

## Current Status (As Of 2026-04-02)

Release readiness is tracked by the live workspace verification commands below. Treat this document as the intended release contract, and rely on the actual command output for current pass/fail state.

## Signing Key Inputs

Release signing uses PEM material supplied through CI secrets:

- `AGENTGIT_RELEASE_SIGNING_PRIVATE_KEY_PEM_B64`
- `AGENTGIT_RELEASE_SIGNING_PUBLIC_KEY_PEM_B64`

Release publish should remain blocked until both secrets are configured.

## Installed-Binary Smoke Intent

`pnpm smoke:public-packages` verifies that every packed public tarball installs cleanly from the release artifact manifest, exposes its declared entrypoints, and exposes expected binaries before any publish can proceed.

`pnpm smoke:cli-install` verifies a real install path by:

- reusing the packed publishable tarballs from `.release-artifacts/packed`
- installing tarballs into a clean temp directory outside the monorepo
- running `agentgit-authority setup`
- starting the packaged authority daemon through the installed CLI
- running installed `agentgit-authority` binary operations against that daemon

`pnpm smoke:agent-runtime-install` verifies the packaged `agentgit` product CLI install path.

`pnpm smoke:cli-compat` extends the authority CLI path with compatibility, upgrade, rollback, and audit-bundle behavior checks while reusing the packed current-release artifacts.

## Local Operator Commands

```bash
pnpm release:verify
pnpm release:pack --signing-mode required
node scripts/verify-release-artifacts.mjs --artifacts-dir .release-artifacts/packed --signature-mode required
```

Day-one operational procedures are in
[engineering-docs/CLI-OPERATOR-RUNBOOK.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/CLI-OPERATOR-RUNBOOK.md).
