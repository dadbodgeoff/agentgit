# Pre-Code Specs

This folder expands the resolved checklist into section-by-section specification documents.

Each document is normative for its section and is derived from:

- [PRE-CODE-CHECKLIST.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/PRE-CODE-CHECKLIST.md)
- the core subsystem docs
- the support-architecture docs
- the schema pack
- [v1-repo-package-module-plan.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/v1-repo-package-module-plan.md) for implementation sequencing

Verification date for the versioned baselines in this folder: **2026-03-29**

## Documents

- `00-version-baselines-and-sources.md`
- `01-foundations.md`
- `02-inter-subsystem-contracts.md`
- `03-policy-engine-spec.md`
- `04-action-normalizer-spec.md`
- `05-snapshot-engine-spec.md`
- `06-execution-adapters-spec.md`
- `07-run-journal-spec.md`
- `08-recovery-engine-spec.md`
- `09-timeline-helper-spec.md`
- `10-credential-broker-spec.md`
- `11-support-infrastructure-spec.md`
- `12-cross-cutting-spec.md`
- `13-examples-and-validation-spec.md`

## Verified Version Choices

These are the launch baselines verified from primary sources before updating this doc set:

- Node.js runtime line: **24.x Active LTS**, validated against **24.14.0**
- pnpm: **10.33.0**
- Turborepo (`turbo`): **2.8.21**
- TypeScript: **6.0.2**
- SQLite: **3.51.3**
- JSON Schema dialect: **Draft 2020-12**
- UUID format: **RFC 9562 UUIDv7**
- Config file format: **TOML v1.0.0**

Version source references:

- Node.js releases: <https://nodejs.org/en/about/previous-releases>
- Node.js v24 archive: <https://nodejs.org/en/download/archive/v24>
- pnpm releases: <https://github.com/pnpm/pnpm/releases>
- Turborepo releases: <https://github.com/vercel/turborepo/releases>
- TypeScript releases: <https://github.com/microsoft/TypeScript/releases>
- SQLite release history: <https://www.sqlite.org/changes.html>
- JSON Schema Draft 2020-12: <https://json-schema.org/draft/2020-12>
- RFC 9562: <https://www.rfc-editor.org/rfc/rfc9562.html>
- TOML v1.0.0: <https://toml.io/en/v1.0.0>
