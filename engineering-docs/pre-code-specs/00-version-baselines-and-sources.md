# 00. Version Baselines And Sources

## Scope

This document pins the launch-time version baselines and normative standards references that the rest of the pre-code spec set depends on.

Verification date: **2026-03-29**

## Tooling Baselines

### Node.js

- Launch runtime line: **Node.js 24.x Active LTS**
- Validated current patch: **24.14.0**
- Why this line:
  - current LTS branch appropriate for production use
  - modern enough for a new npm-first daemon
  - no need to chase the Node 25 Current line at launch
- Source:
  - release schedule: <https://nodejs.org/en/about/previous-releases>
  - v24 archive: <https://nodejs.org/en/download/archive/v24>

### pnpm

- Package manager baseline: **pnpm 10.33.0**
- Why:
  - current stable major
  - strong workspace ergonomics
  - good fit for an OSS monorepo shipped through npm
- Source:
  - <https://github.com/pnpm/pnpm/releases>

### Turborepo

- Monorepo orchestrator baseline: **Turborepo 2.8.21**
- Why:
  - current stable release on the official release page
  - mature caching/task graph support for a multi-package repo
- Source:
  - <https://github.com/vercel/turborepo/releases>

### TypeScript

- Compiler baseline: **TypeScript 6.0.2**
- Why:
  - current stable release
  - new repo, so we should start from the current stable compiler line unless a dependency forces rollback
- Rollback rule:
  - if ecosystem tooling breaks materially on 6.0.x, the first compatibility fallback is the latest 5.8.x stable line, but that is not the default launch choice
- Source:
  - <https://github.com/microsoft/TypeScript/releases>

### SQLite

- Embedded database baseline: **SQLite 3.51.3**
- Why:
  - current stable release
  - the newer `3.52.0` release was withdrawn, so `3.51.3` is the safe/stable choice
- Source:
  - <https://www.sqlite.org/changes.html>

## Normative Standards Baselines

### JSON Schema

- Dialect: **Draft 2020-12**
- Why:
  - widely implemented
  - stable enough for schema-pack contracts and cross-language validation
- Source:
  - <https://json-schema.org/draft/2020-12>

### UUIDs

- ID standard: **RFC 9562**
- Chosen variant: **UUIDv7**
- Why:
  - time-sortable IDs with a current IETF standards-track definition
- Source:
  - <https://www.rfc-editor.org/rfc/rfc9562.html>

### TOML

- Config format: **TOML v1.0.0**
- Why:
  - stable, readable, and mature for local-first user-editable config
- Source:
  - <https://toml.io/en/v1.0.0>

## Adoption Policy

- Docs pin the exact validated versions above so design discussions stay concrete.
- CI and dev containers should pin the exact patch versions.
- Package manifests may use a compatible range within the chosen major/minor line when that improves install ergonomics, but the tested baseline remains the source of truth.
- Version upgrades should be deliberate:
  - verify upstream stability
  - run schema/IPC/journal smoke tests
  - update this document and the foundations doc together
