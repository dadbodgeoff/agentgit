# Technical Design Document: Productized Agent Runtime Integration

Status date: 2026-04-02 (America/New_York)

Owner: AgentGit core

Document purpose:

- define exactly what must be built to turn the existing local-first authority runtime into a production-ready product layer for self-hosted autonomous agents
- make implementation order, boundaries, contracts, and tests explicit
- preserve the existing runtime truth while adding a much simpler front door

## 1. Executive Summary

AgentGit already has a real local authority daemon, governed action pipeline, timeline, and recovery engine.

What is missing is a product layer that:

- detects a user’s agent runtime
- installs the right integration path safely
- gets the user to a governed action fast
- shows a clear inspect and restore story

This TDD defines that layer.

The productized command surface is:

- `agentgit setup`
- `agentgit run`
- `agentgit demo`
- `agentgit inspect`
- `agentgit restore`

These commands sit on top of the existing operator-grade runtime and CLI primitives.

`setup` also owns reversible install lifecycle operations through flags such as:

- `agentgit setup --remove`
- `agentgit setup --repair`

## 2. Product Requirements

### 2.1 Product law

Seatbelt, not a framework.

Requirements derived from that law:

- no user-facing mode selection
- no required daemon/socket/config jargon during setup
- no early requirement to rewrite the user’s agent architecture
- no expansion into a new orchestration platform

### 2.2 External promise

Make your self-hosted agent safer in 60 seconds.

Internal engineering budget:

- 60 seconds on the happy path
- 3 minutes max when fallback prompts are needed

### 2.3 First holy-shit moment

The user must be able to experience this quickly:

1. an agent attempts a dangerous repo mutation
2. AgentGit captures or blocks it
3. the user sees the exact action and why it happened
4. the user restores the affected file or boundary

### 2.4 Day-one support

Required:

- OpenClaw deep integration
- generic command-based fallback

Deferred:

- best-in-class Claude Code install automation
- best-in-class Codex install automation
- broad framework matrix

These later integrations must not change the agent-agnostic positioning.

## 3. Goals

- Provide one smart `agentgit setup` entrypoint that hides wrapper/gateway/adapter internals.
- Reuse existing authority daemon, action submission, timeline, and recovery primitives.
- Add a safe integration layer that can discover, plan, apply, verify, and reverse runtime attachment.
- Ship a deterministic `demo` flow that proves value before the user trusts a real repo.
- Make `inspect` and `restore` simple enough for daily use.
- Build the architecture so additional agent adapters can be added without redesigning the product surface.

## 4. Non-Goals

- passive monitoring of arbitrary closed agent apps
- whole-OS interception of every file/process mutation
- replacing the existing operator CLI surface
- shipping every possible agent integration on day one
- introducing a hosted control plane requirement
- redefining the current daemon IPC contract

## 5. Current-State Reality

The TDD is intentionally constrained by what is already real in the repo.

### 5.1 Existing backend primitives to reuse

Current code already provides:

- local profile setup via `runSetupCommand`
- daemon bootstrap via `runDaemonStartCommand`
- governed submission for filesystem, shell, and MCP actions
- timeline queries
- recovery planning and execution

Primary implementation files:

- [/Users/geoffreyfernald/Documents/agentgit/packages/authority-cli/src/main.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-cli/src/main.ts)
- [/Users/geoffreyfernald/Documents/agentgit/packages/authority-cli/src/cli-config.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-cli/src/cli-config.ts)
- [/Users/geoffreyfernald/Documents/agentgit/packages/authority-daemon/src/runtime.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-daemon/src/runtime.ts)
- [/Users/geoffreyfernald/Documents/agentgit/packages/authority-daemon/src/server.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-daemon/src/server.ts)
- [/Users/geoffreyfernald/Documents/agentgit/packages/integration-state/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/integration-state/src/index.ts)

### 5.2 Consequence

The new work should mostly be:

- integration detection
- config mutation
- setup orchestration
- demo orchestration
- product-grade inspect and restore UX

It should not be a rewrite of the daemon or execution pipeline.

## 6. Proposed Architecture

## 6.1 Layer model

### Layer A: Product CLI

New top-level product verbs:

- `setup`
- `run`
- `demo`
- `inspect`
- `restore`

Responsibilities:

- user-facing command UX
- orchestration over existing low-level commands and daemon APIs
- output phrased in plain language

### Layer B: Integration engine

New package recommendation:

- `packages/agent-runtime-integration`

Responsibilities:

- detect candidate runtimes
- plan the best integration path
- apply config changes or wrapper generation
- verify the installed path
- store integration metadata
- reverse or update prior integrations safely
- migrate persisted integration metadata across product versions

### Layer C: Runtime adapter registry

Responsibilities:

- register runtime-specific detectors and installers
- isolate OpenClaw-specific logic
- support generic command fallback
- later host MCP-install adapters for Claude Code and Codex

### Layer D: Product inspect and restore service

Responsibilities:

- translate timeline and recovery APIs into a human-first experience
- map dangerous actions to suggested restore targets
- provide restore previews
- generate clear next-step recommendations

### Layer E: Demo harness

Responsibilities:

- create a safe throwaway repo or worktree
- simulate or drive a governed dangerous action path
- ensure inspect and restore always have something concrete to show

## 6.2 Internal mode selection

The system may select among these internal implementation paths:

- wrapper/orchestration path
- MCP install/gateway path
- native adapter path

This decision is internal.

The user should not be prompted to choose a mode unless diagnosis or fallback truly requires it.

## 7. User Flows

## 7.1 Happy-path setup

```bash
agentgit setup
```

Initial branch point:

- Recommended
- Advanced

Recommended behavior:

- default path
- selected by pressing enter or taking no extra action
- preserves the existing happy-path setup feel and 60-second budget
- asks no extra questions beyond the existing happy-path setup flow

Advanced behavior:

- uses the same underlying setup engine as Recommended
- exposes a small number of advanced choices without creating a second product surface
- should feel like a recommended-vs-custom installer split, not lite-vs-full mode selection

Expected sequence:

1. offer Recommended vs Advanced, defaulting to Recommended
2. resolve repo root
3. detect installed runtime candidates
4. choose best adapter
5. apply or generate integration
6. verify daemon readiness and integration health
7. print concise success summary
8. offer `agentgit demo` or `agentgit run`

Expected happy-path prompts:

- zero prompts when one strong candidate is found and install scope is obvious
- at most one confirmation when a user-visible mutation is about to occur

Advanced launch options must stay intentionally narrow:

- containment backend, only if the platform supports one
- policy strictness
- scope selection
- assurance level targeting

Constraint:

- internally, Recommended is Advanced with defaults pre-filled
- there must be one code path, not two setup implementations

## 7.2 Generic fallback setup

If no known adapter is detected:

```bash
agentgit setup
```

Fallback prompt:

- “What command starts your agent?”

Optional second prompt only if needed:

- “Use this repo as the governed workspace?”

Outcome:

- AgentGit stores a generic launch profile
- `agentgit run` launches the command through AgentGit governance

## 7.3 Setup removal flow

```bash
agentgit setup --remove
```

Required behavior:

- resolve the active integration profile for the workspace or selected scope
- show what config files, generated wrappers, and product metadata will be removed or restored
- restore backed-up runtime config exactly where possible
- delete only AgentGit-owned generated assets
- preserve unrelated user changes

Success condition:

- the user’s target runtime behaves as though AgentGit had never been installed for that scope
- AgentGit-owned persisted install records are removed or tombstoned clearly

## 7.4 Demo flow

```bash
agentgit demo
```

Required behavior:

- create or reuse a safe throwaway workspace
- register a governed run
- perform known file mutations
- attempt a dangerous deletion
- surface inspectable results
- support restore immediately

Success condition:

- the user can restore the deleted file from the terminal flow without knowing a run ID or snapshot ID
- the full flow completes in under 15 seconds on a healthy local machine

## 7.5 Inspect flow

```bash
agentgit inspect
```

Default behavior:

- show the latest dangerous or notable governed run in the active workspace

Output must answer:

- what happened
- which action mattered
- which files changed
- whether a restore path exists
- what exact restore command to run next

## 7.6 Restore flow

```bash
agentgit restore
```

Default behavior:

- restore the most recent recoverable dangerous action in the active workspace

Supported targets:

- single file path
- directory path
- full boundary restore
- explicit action or snapshot ID for advanced use

Restore must support:

- preview before execution
- clear warnings for broad changes
- downgrade to review-only when guarantees are degraded

## 8. Adapter Strategy

## 8.1 Adapter interface

Each runtime adapter should implement:

- `detect(context): DetectionResult`
- `plan(context, detection): InstallPlan`
- `apply(plan): ApplyResult`
- `verify(plan): VerifyResult`
- `rollback(plan): RollbackResult`

### DetectionResult

Required fields:

- `runtime_id`
- `confidence`
- `workspace_root`
- `install_scope_candidates`
- `evidence`
- `assurance_ceiling`

### InstallPlan

Required fields:

- `runtime_id`
- `integration_method`
- `files_to_create`
- `files_to_modify`
- `env_to_inject`
- `commands_to_run`
- `backup_targets`
- `user_confirmation_required`

### VerifyResult

Required fields:

- `ready`
- `health_checks`
- `recommended_next_command`
- `assurance_ceiling`
- `degraded_reasons`

## 8.2 OpenClaw adapter

Day-one required depth:

- detect OpenClaw install and config reliably
- identify the current repo/workspace boundary
- install the best available integration path with minimal prompts
- verify health in a way that feels productized

Allowed implementation choices:

- config file mutation
- wrapper generation
- MCP registration
- launch profile generation

Decision rule:

- choose the smallest change that yields a governed launch path with a great first-run experience

## 8.3 Generic command adapter

Day-one requirement:

- must be polished enough to support users who do not run OpenClaw

Required capabilities:

- accept one launch command
- persist the command safely
- run that command under AgentGit governance
- associate runs and restore paths with the active workspace

## 8.4 MCP compatibility adapters

Later but architecturally important:

- Claude Code adapter
- Codex adapter

Expected uses:

- write config files
- register AgentGit as a local or HTTP MCP server
- verify that the target runtime sees the server

Important constraint:

- MCP compatibility is a broad install surface
- it is not automatically the strongest governance claim unless execution truly runs through AgentGit

## 9. Setup Detection and Planning

## 9.1 Detection hierarchy

Required precedence:

1. current repo and cwd signals
2. known runtime binaries on PATH
3. known config files in standard locations
4. existing AgentGit integration profile
5. fallback user-supplied command

## 9.2 Scope control

Day-one detection should be intentionally narrow:

- OpenClaw deep detection
- generic command fallback

Do not attempt wide agent detection on launch.

## 9.3 Safety rules for config mutation

Every adapter that writes config must:

- backup the original content
- record the backup location in integration state
- be able to reverse the exact mutation
- avoid overwriting unrelated user config silently

If a config drift or merge conflict is detected:

- stop
- explain the conflict briefly
- require explicit user re-run with a force or repair path later

## 10. Persistence Model

Recommended new integration-state collections:

- `runtime_profiles`
- `runtime_installs`
- `config_backups`
- `demo_runs`
- `restore_shortcuts`

Every document in these collections must include:

- `schema_version`
- `created_at`
- `updated_at`

## 10.1 Migration strategy

The integration layer must ship with a forward migration story from day one.

Requirements:

- each persisted document includes an explicit `schema_version`
- collection parsers support migrate-on-read into the current in-memory shape
- writes always persist the latest schema version
- backward-incompatible changes must include deterministic migration tests using stored fixture documents from prior versions
- unknown future schema versions fail closed with a targeted repair message rather than silent coercion

Recommended approach:

- keep migrations at the document level rather than introducing a second heavy migration framework
- version parsers per collection
- persist migration telemetry in install logs or debug output for supportability

This avoids locking the product into the first shipped schema while keeping the persistence layer simple enough for launch.

## 10.2 `runtime_profiles`

Purpose:

- persist the active product-level integration for a workspace or user scope

Fields:

- `profile_id`
- `workspace_root`
- `runtime_id`
- `launch_command`
- `integration_method`
- `install_scope`
- `assurance_level`
- `governed_surfaces`
- `schema_version`
- `created_at`
- `updated_at`

## 10.3 `runtime_installs`

Purpose:

- record applied setup plans for verification and rollback

Required fields:

- `install_id`
- `runtime_id`
- `workspace_root`
- `install_scope`
- `plan_digest`
- `applied_mutations`
- `status`
- `schema_version`
- `created_at`
- `updated_at`

## 10.4 `config_backups`

Purpose:

- preserve reversible originals for any touched runtime config

Required fields:

- `backup_id`
- `target_path`
- `target_digest_before`
- `backup_path`
- `schema_version`
- `created_at`
- `updated_at`

## 10.5 `demo_runs`

Purpose:

- remember the last successful demo run for inspect/restore walkthroughs

Required fields:

- `demo_run_id`
- `workspace_root`
- `run_id`
- `dangerous_action_id`
- `restore_boundary_id`
- `schema_version`
- `created_at`
- `updated_at`

## 10.6 `restore_shortcuts`

Purpose:

- map recent dangerous actions to user-friendly restore shortcuts

Required fields:

- `shortcut_id`
- `workspace_root`
- `action_id`
- `preferred_restore_target`
- `restore_boundary_id`
- `schema_version`
- `created_at`
- `updated_at`

## 11. Product Command Contracts

## 11.1 `agentgit setup`

Success output must include:

- detected runtime
- workspace root
- governed surfaces
- assurance level in plain language
- honest assurance language tied to the active assurance level
- whether setup changed anything
- next command to run

It must not print:

- raw socket path unless explicitly in verbose/debug mode
- transport jargon
- internal profile schema

Language rules:

- `attached` should be phrased as “governing supported launch surfaces”
- `contained` should be phrased as “governing the runtime boundary”
- do not use contained language until a real contained backend exists
- never say “fully governed” unless assurance level is `contained` or `integrated`

## 11.2 `agentgit run`

Responsibilities:

- load active runtime profile
- start or verify daemon readiness
- launch the governed runtime command
- preserve exit semantics where possible

Day-one decision:

- `run` should wrap the real process directly

Why:

- strongest governance guarantee
- clearest first-run story
- simplest mapping between launched process, governed run, and user-visible outcome

Implications:

- AgentGit owns signal handling, subprocess lifecycle, and exit-code forwarding
- these behaviors must be covered in integration tests

Deferred escape hatch:

- generated stable launcher scripts may be added later for runtimes or shells where direct wrapping is unreliable

## 11.3 `agentgit demo`

Responsibilities:

- create deterministic proof of value
- avoid user data risk
- seed inspect and restore with meaningful artifacts

Required output:

- what AgentGit did
- what dangerous action occurred
- how to inspect it
- how to restore it

## 11.4 `agentgit inspect`

Responsibilities:

- resolve a sensible default target
- summarize the last dangerous or policy-relevant run
- recommend the next restore or review action
- report the active assurance level in plain language
- report degraded reasons when they materially limit the governance claim

## 11.4.1 Assurance levels and product language

The product must persist and surface an assurance level for each active runtime profile.

Required launch levels:

- `observed`
- `attached`
- `contained`
- `integrated`

Definitions:

- `observed`
  - AgentGit can see evidence or import state, but does not own a governed execution boundary
- `attached`
  - AgentGit governs supported launch surfaces for the runtime, but not the full runtime boundary
- `contained`
  - AgentGit governs the runtime boundary through a contained execution path
- `integrated`
  - AgentGit has a native or equivalent deep integration that supports the strongest product claim available for that runtime

Product language rules:

- `attached` = “governing supported launch surfaces”
- `contained` = “governing the runtime boundary”
- never inflate `attached` to `contained`
- never say “fully governed” unless the active assurance level is `contained` or `integrated`
- if capability is degraded, setup and inspect output must say so briefly rather than hiding the limitation

## 11.5 `agentgit restore`

Responsibilities:

- resolve a sensible default restore target
- show a preview
- execute the safest applicable restore
- explain any downgrade or limitation clearly

## 12. Restore Experience Design

Restore is the crown jewel of the product and must feel dramatically simpler than the underlying recovery primitives.

### 12.1 Restore target resolution

Given a recent dangerous action, the restore flow should attempt to resolve:

1. exact file target
2. path subset target
3. action boundary target
4. snapshot boundary target

The narrowest safe target should win.

### 12.2 Restore preview

Before execution, restore should show:

- target being restored
- number of files affected
- whether any files will be deleted
- boundary/source of truth
- whether the restore is exact or review-only

### 12.3 Partial restore support

Required launch support:

- restore a single file when the recovery engine can express that safely
- restore a path subset when supported by the boundary
- fall back to broader boundary restore only with explicit warning

### 12.4 Failure or downgrade behavior

If exact restore is unavailable:

- explain why
- say whether review-only planning is available
- show the advanced operator command when needed

If exact restore is available but would overwrite user changes made after the dangerous action:

- detect the conflict before execution
- show the conflicting path or paths
- present a diff or equivalent preview when available
- require an explicit user choice before overwriting post-incident work
- default to non-destructive behavior

## 13. Adversarial Agent Behavior

The system must assume the agent is persistent, not obedient.

Required design principles:

- gate actions, not prompts
- treat retries like first attempts
- journal repeated blocked attempts as meaningful evidence
- make evasion attempts visible in inspect output
- fail closed when action classification or safe execution guarantees are missing

Implications:

- setup cannot rely on prompt conventions or agent cooperation
- enforcement must happen at the tool or execution boundary
- product claims must map to the actual governed surfaces, not to marketing language

## 14. Demo Design

## 14.1 Demo requirements

The demo must:

- run locally
- avoid touching the user’s real repo
- produce a recoverable dangerous action
- work on clean machines
- not require OpenClaw to be installed
- complete in under 15 seconds end to end on a healthy local machine

## 14.2 Demo implementation recommendation

Use a throwaway Git repo or worktree under `.agentgit/demo` or a temporary directory.

Suggested path:

1. initialize a small demo repo
2. register a run
3. write a critical file
4. perform a governed delete
5. run inspect summary
6. run restore
7. confirm file content is back

## 14.3 Demo success metric

The demo is successful when a first-time user can say:

- “I saw the bad action.”
- “I saw where it came from.”
- “I got the file back.”

## 15. Testing Strategy

This feature set must be built test-first or at least test-alongside, because the integration layer is mostly correctness, compatibility, and UX orchestration risk.

## 15.1 Unit tests

Required:

- detector selection logic
- install planning logic
- config backup and rollback logic
- restore target resolution logic
- inspect default-target resolution logic
- command output formatting helpers

## 15.2 Fixture-based adapter tests

Required:

- OpenClaw config detection fixtures
- OpenClaw config mutation fixtures
- generic command profile persistence fixtures

These should be snapshot-like and versioned.

## 15.3 Integration tests

Required:

- `setup` on a clean workspace
- `setup` with existing conflicting config
- `setup` fallback to generic command mode
- `demo` end-to-end
- `inspect` after demo
- `restore` after demo
- daemon restart between action and restore

## 15.4 End-to-end tests

Required production bar:

- OpenClaw happy-path attachment
- generic-command happy-path attachment
- dangerous file delete inspect/restore journey
- repeated blocked-action journaling
- degraded restore path with clear warning
- conflicting post-incident file restore with non-destructive prompt

## 15.5 Compatibility tests

For any config-writing adapter:

- verify it leaves unrelated config intact
- verify rollback restores the original file
- verify re-running setup is idempotent

## 16. Production Readiness Gates

This subsystem should not be called launch-ready until all of the following pass:

- OpenClaw setup works on supported installs
- generic fallback setup works with one supplied command
- demo works offline and repeatedly on clean machines
- demo completes within the target latency budget on supported machines
- inspect works without requiring the user to know IDs
- restore can recover the demo deletion end to end
- config backup and rollback are proven in tests
- `setup --remove` cleanly reverses installation on supported adapters
- daemon restart does not lose inspectability
- blocked retries are visible and journaled
- product commands degrade safely when exact restore is unavailable

## 17. Milestones

## M1: Foundation

- create `packages/agent-runtime-integration`
- define adapter interfaces
- add integration-state collections
- add CLI plumbing for new product verbs

## M2: OpenClaw + generic setup

- ship OpenClaw detector and installer
- ship generic command adapter
- persist runtime profiles
- verify health and readiness

## M3: Demo / inspect / restore

- deterministic demo harness
- inspect summary flow
- restore preview and execution flow
- restore shortcut mapping

## M4: Hardening

- rollback and backup validation
- adversarial retry coverage
- restart resilience coverage
- install idempotency and compatibility fixtures
- uninstall and config-restore coverage

## M5: Broader compatibility

- MCP install automation for additional runtimes
- adapter authoring guide for future community integrations

## 18. Open Questions

- Should demo operate through low-level CLI primitives first or through the new product verbs only?
- Should OpenClaw integration prefer config mutation, MCP registration, or launch wrapping for v1?
- Where should product-facing integration state live relative to existing CLI config for the cleanest UX and migration path?

These questions are implementation-sequencing questions, not product-definition blockers.

## 19. Immediate Implementation Recommendation

Build in this order:

1. adapter package and profile persistence
2. OpenClaw detector and generic command fallback
3. `setup`
4. `demo`
5. `inspect`
6. `restore`
7. compatibility expansion

This order is the shortest path to a real, production-worthy product layer over the runtime that already exists.
