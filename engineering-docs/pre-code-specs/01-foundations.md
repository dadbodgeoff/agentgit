# 01. Foundations

## Scope

This document resolves the foundational build and platform choices that every downstream implementation decision depends on.

Normative baseline source:

- [00-version-baselines-and-sources.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/pre-code-specs/00-version-baselines-and-sources.md)

## Runtime And Language

- Primary daemon runtime: **TypeScript on Node.js 24.x Active LTS**
- Validated runtime patch baseline: **24.14.0**
- SDK strategy: **thin first-party TypeScript SDK and Python SDK**
- Control-plane logic stays daemon-side so SDKs do not drift

## Monorepo And Build

- Package manager baseline: **pnpm 10.33.0**
- Monorepo orchestrator baseline: **Turborepo 2.8.21**
- Compiler/type system baseline: **TypeScript 6.0.2**
- Monorepo layout target:
  - `packages/authority-daemon`
  - `packages/authority-sdk-ts`
  - `packages/authority-sdk-py`
  - `packages/schemas`
  - `packages/policy-engine`
  - `packages/snapshot-engine`
  - `packages/execution-adapters`
  - `packages/run-journal`
  - `packages/recovery-engine`
  - `packages/timeline-helper`

## Platform Support

- macOS: **14+**
- Linux: **Ubuntu 22.04+, Debian 12+, or equivalent modern distro**
- Windows: **deferred/experimental after launch**
- Production launch assumption:
  - the daemon is built and tested first on macOS and Linux
  - Windows support should not distort the launch architecture

## Dependency Philosophy

- Lean but pragmatic
- Prefer battle-tested libraries for:
  - SQLite access
  - JSON Schema validation
  - TOML parsing
  - tracing
- Avoid heavyweight framework lock-in on the daemon hot path

## Wire Format

- IPC transport: **local IPC only**
- IPC serialization: **framed JSON**
- Interaction model: **request/response with explicit streaming for long-running work**

## ID Strategy

- ID algorithm: **UUIDv7**
- IDs use typed prefixes:
  - `run_`, `sess_`, `req_`, `act_`, `pol_`, `snap_`, `exec_`, `evt_`, `approval_`, `rcvplan_`, `rcv_`, `step_`, `job_`, `stream_`, `artifact_`
- Sequence numbers remain authoritative for intra-run ordering

## Versioned Choices

- Node.js runtime line: **24.x Active LTS**
- Node.js validated patch baseline: **24.14.0**
- pnpm: **10.33.0**
- Turborepo: **2.8.21**
- TypeScript: **6.0.2**
- SQLite minimum baseline: **3.51.3+**
- JSON Schema dialect: **Draft 2020-12**
- UUID strategy: **UUIDv7 per RFC 9562**
- Config syntax: **TOML v1.0.0**

## Versioning Policy

- Exact validated versions are pinned in the baseline doc and should be used in CI and dev containers.
- Documentation may refer to the chosen runtime line when that is clearer than a single patch number, but the tested patch baseline remains authoritative.
- We do not adopt brand-new Current-channel runtimes just because they are newer.
- For launch, "safe/stable" means:
  - official stable/LTS release
  - no withdrawn release line
  - ecosystem support good enough for an npm OSS toolchain

## Source References

- Node.js releases: <https://nodejs.org/en/about/previous-releases>
- Node.js v24 archive: <https://nodejs.org/en/download/archive/v24>
- pnpm releases: <https://github.com/pnpm/pnpm/releases>
- Turborepo releases: <https://github.com/vercel/turborepo/releases>
- TypeScript releases: <https://github.com/microsoft/TypeScript/releases>
- SQLite release history: <https://www.sqlite.org/changes.html>
- JSON Schema Draft 2020-12: <https://json-schema.org/draft/2020-12>
- RFC 9562: <https://www.rfc-editor.org/rfc/rfc9562.html>
- TOML v1.0.0: <https://toml.io/en/v1.0.0>
