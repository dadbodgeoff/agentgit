# Generic Containment Spec

Status date: 2026-04-02 (America/New_York)

Owner: AgentGit core

Follow-on execution and release plan:

- implementation plan: [/Users/geoffreyfernald/Documents/agentgit/engineering-docs/09-agent-runtime-integration/contained-ga-plan.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/09-agent-runtime-integration/contained-ga-plan.md)
- release checklist: [/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/contained-ga-signoff-checklist.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/contained-ga-signoff-checklist.md)

## Purpose

Define the next implementation phase for the generic runtime path so AgentGit can keep the current fast fallback while adding a materially stronger onboarding lane for teams that want enterprise-grade protection.

This spec is intentionally grounded in the current repo shape:

- one local authority daemon
- one product CLI surface
- existing `packages/agent-runtime-integration`
- no parallel backend

## Ship now vs defer

Ship now:

- add `assurance_level` to adapter and profile plumbing
- add `assurance_ceiling` to adapter detection and verification contracts
- surface assurance truth in setup and inspect output
- add Recommended vs Advanced setup, with one shared implementation path
- ship Docker-backed contained execution with projection + governed publish-back
- ship `--contained` as a direct entry into the contained Docker lane
- ship explicit contained network and credential policy fields
- ship brokered contained secret refs backed by AgentGit's encrypted secret store
- ship brokered contained secret file mounts backed by AgentGit's encrypted secret store
- make direct host env credential passthrough explicit-only through a saved allowlist instead of ambient host env discovery
- persist `governance_mode` and explicit `guarantees` alongside `assurance_level`
- surface Docker capability truth in setup and inspect, including projection enforcement, read-only rootfs, network restriction state, credential brokering state, and host/runtime mode hints
- extract a shared contained-backend interface and normalize backend capability snapshots so future backends do not require product-surface redesign
- re-verify contained backend availability during inspect and repair so Docker disappearing later is reported as a degraded contained state instead of stale healthy metadata
- preflight saved runtime integrations at launch time so contained backend outages and native-adapter drift fail before a new run is registered
- re-validate brokered contained secret bindings during launch preflight so removed or expired secrets fail before run registration
- surface missing brokered contained secrets in inspect degradation output instead of relying on setup-time truth alone
- avoid persisting `last_run_id` or orphaned contained projection state when process startup fails before the runtime actually begins executing
- ship proxy-based contained HTTP(S) allowlist egress for proxy-aware clients with explicit degraded language instead of pretending to govern arbitrary raw sockets

Defer:

- richer credential brokering beyond direct env passthrough and encrypted secret-ref injection for contained runs
- richer egress policy beyond `inherit` vs `none`
- non-Docker platform-specific containment backends before the product layer proves out with real users

Docker-specific R&D conclusion:

- Docker is the strongest first contained-backend candidate once containment moves out of defer
- Docker should be treated as a containment substrate, not a second AgentGit control plane
- AgentGit must still own run registration, projection lifecycle, publication into the real workspace, inspect, restore, and remove/repair

## Decision Summary

Generic runtime support should become a two-lane product behind one command:

1. `attached` lane
   Current behavior.
   Fast setup, direct launch, partial governance through known shim/plugin surfaces.

2. `contained` lane
   New behavior.
   Launch the foreign runtime inside an AgentGit-owned execution boundary with a projected writable workspace, contained credential controls, and optional egress controls.

The product surface stays:

- `agentgit setup`
- `agentgit run`
- `agentgit demo`
- `agentgit inspect`
- `agentgit restore`

The current shipped product now supports both:

- Recommended vs Advanced setup as the main guided entry
- `agentgit setup --contained` as a direct fast-path into the Docker-contained lane

Advanced setup remains the door through which future contained backends and stricter policy choices can be selected later.

## Critical Product Truth

For unsupported foreign runtimes, containment does not magically create native tool interception.

So the contained generic guarantee must be:

- no ungoverned writes land in the user’s real workspace
- no broad durable credentials are handed directly to the runtime when AgentGit can broker them
- runtime egress can be constrained or explicitly marked degraded

It must not claim:

- complete semantic interception of every internal tool call
- full per-action policy gating equal to a native adapter

For the current Docker-backed contained path, the honest product guarantee is:

- the runtime works inside an AgentGit-owned contained workspace boundary
- ungoverned writes do not land directly in the user’s real workspace
- publication back to the real workspace is mediated by AgentGit
- contained secrets can be injected from AgentGit's encrypted secret store by explicit env binding, without reusing host env passthrough

It is not:

- a claim that Docker alone semantically governs every foreign internal tool call
- a claim that contained credentials are universally brokered for every downstream tool or secret source
- a claim that network egress is governed beyond `--network none` when the profile uses inherited networking

That distinction should be persisted and surfaced in UX.

## Trust Model

Add two user-meaningful fields to runtime profiles and installs:

- `assurance_level`
- `governance_mode`

Recommended values:

- `assurance_level`
  - `observed`
  - `attached`
  - `contained`
  - `integrated`

- `governance_mode`
  - `attached_live`
  - `contained_projection`
  - `native_integrated`

Also persist:

- `guarantees: string[]`
- `degraded_reasons: string[]`

Example generic contained guarantees:

- `real_workspace_protected`
- `publish_path_governed`
- `brokered_credentials_only`
- `egress_policy_applied`

Example generic attached guarantees:

- `known_shell_entrypoints_governed`
- `known_plugin_surfaces_governed`

## Repo-Specific Schema Changes

Update [types.ts](/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/types.ts):

- `RuntimeProfileDocument`
  - add `assurance_level`
  - add `governance_mode`
  - add `guarantees`
  - add `degraded_reasons`
  - add `containment_backend?: "none" | "linux-bwrap" | "macos-vm"`
  - add `projection_strategy?: "none" | "overlay" | "shadow_copy"`

- `RuntimeInstallDocument`
  - add `assurance_level`
  - add `governance_mode`
  - add `containment_backend?: "none" | "linux-bwrap" | "macos-vm"`
  - add `capability_snapshot?: Record<string, unknown>`

Migration rule:

- migrate missing fields on read
- default existing generic profiles to:
  - `assurance_level = "attached"`
  - `governance_mode = "attached_live"`
  - `guarantees = ["known_shell_entrypoints_governed"]`
  - `degraded_reasons = []`
  - `containment_backend = "none"`
  - `projection_strategy = "none"`

No new collection is required for the first contained pass if transient run projection state can live under generated assets plus existing runtime profile metadata.

If durable multi-run projection history becomes necessary later, add a new `contained_workspaces` collection instead of overloading installs.

## Product UX

### `agentgit setup`

Required behavior:

- begin with a Recommended vs Advanced branch
- Recommended is the default and preserves the existing TDD happy path
- Advanced uses the same code path with defaults made explicit
- Advanced should expose no more than 2-3 choices at launch

Ship-now Advanced inputs:

- policy strictness
- scope selection
- assurance level targeting

Deferred Advanced input:

- containment backend, once a real contained backend exists

### `agentgit inspect`

Inspect output should add:

- `Assurance level`
- `Governance mode`
- `Guarantees`
- `Degraded reasons`

### `agentgit restore`

Contained generic restore should prefer:

1. projection rollback
2. narrow publish-target restore
3. existing recovery-engine boundary restore

This keeps restore simpler and safer than live-host mutation recovery.

## Core Architectural Decision

Contained generic should be implemented as `contained_projection`, not as “better PATH shims.”

That means the foreign runtime writes to a projected writable workspace inside the boundary, not directly to the user’s real repo.

Publication back to the real workspace must go through AgentGit-owned governed application logic.

This is the smallest path that closes the current generic gaps:

- absolute-path binaries
- in-process native file writes
- foreign tools that ignore PATH
- unsafe direct secret reuse

It also fits the wrapper docs because trusted side effects on the user’s real workspace do not occur outside an AgentGit-owned path.

## First contained backend candidate: Docker

When containment moves from deferred to implementation, the first production candidate should be a Docker-backed contained launcher.

Why Docker is the leading candidate:

- widely installed already
- familiar to enterprise buyers and operators
- available on Linux directly through Docker Engine
- available on macOS through Docker Desktop’s Linux VM model
- lets AgentGit prove the contained product loop before investing in more specialized backends

This should not replace future native backends.

It should instead become:

- the first contained backend to prove the product model
- one backend implementation behind a shared containment interface

## Docker-backed containment rules

These rules should be locked in before implementation:

1. Never mount the user’s real workspace read-write into the container.

2. Mount the projected workspace read-write and nothing broader.

3. Prefer `--mount` over `-v` so missing source paths fail explicitly instead of being auto-created by Docker.

4. Do not mount the Docker socket into the container.

5. Do not mount arbitrary host credential paths into the container by default.

6. Prefer a read-only container root filesystem plus explicit writable mounts where practical.

7. Treat network policy as a separate capability.

8. If network isolation or credential brokering is not enabled, report that as degraded rather than inflating the governance claim.

## Docker-backed contained run shape

Contained generic with Docker should work like this:

1. AgentGit registers the run with the existing authority daemon.
2. AgentGit creates a projected writable workspace on the host.
3. AgentGit launches the runtime command in a container with the projection mounted into the container workdir.
4. The container never receives a writable mount of the user’s real workspace.
5. On exit, AgentGit diffs the projection against the baseline.
6. AgentGit publishes approved changes back to the real workspace through governed daemon-backed actions.

This keeps Docker in the role of isolation substrate while AgentGit remains the control plane.

## Docker-specific capability truth

Contained capability reporting should distinguish:

- `docker_available`
- `docker_desktop_vm`
- `rootless_docker`
- `read_only_rootfs_enabled`
- `network_restricted`
- `credential_brokering_enabled`

Examples:

- Docker available + projection enforced + no network restriction
  - `assurance_level = contained`
  - degraded reason: `network_egress_not_restricted`

- Docker available but projected publication path unavailable
  - do not upgrade to contained
  - remain `attached`

- Docker unavailable
  - remain `attached`

## Docker-specific engineering constraints

### Filesystem

Docker bind mounts have write access by default.

That means the plan must rely on:

- mounting only the projection as writable
- optionally mounting selected reference inputs as read-only
- never using a writable bind mount of the real repo as the contained execution surface

### Desktop and macOS

Docker Desktop runs containers inside a Linux VM and transparently handles host bind mounts.

That is acceptable for the first contained backend because AgentGit’s product truth is about the protected runtime boundary and governed publication path, not about implementing its own VM stack first.

### Hardening layers

For Linux hosts, rootless Docker and user-namespace hardening should be treated as additive hardening, not as a prerequisite for the first contained ship.

For Docker Desktop, enhanced container isolation and related features are additive hardening, not part of the minimum contained product truth.

### Network

Docker can run containers with `--network none`, which is useful for a future stricter policy tier.

This should not be required for the first contained milestone, but the capability model should reserve room for it.

### Root filesystem

Docker supports `--read-only`, which should be considered the default target shape for the container root filesystem once the runtime command’s write requirements are understood.

Writable state should be provided via explicit mounts, not by leaving the container root writable by default.

## Service Abstractions

Add a containment layer inside `packages/agent-runtime-integration`.

Recommended new files:

- `src/containment.ts`
- `src/containment-linux.ts`
- `src/containment-macos.ts`
- `src/projection.ts`
- `src/capabilities.ts`

Recommended interfaces:

```ts
export interface HostCapabilitySummary {
  containment_supported: boolean;
  containment_backend: "none" | "linux-bwrap" | "macos-vm";
  network_policy_supported: boolean;
  projection_strategies: Array<"overlay" | "shadow_copy">;
  degraded_reasons: string[];
}

export interface ContainmentBackend {
  readonly id: "linux-bwrap" | "macos-vm";
  detect(env: NodeJS.ProcessEnv): HostCapabilitySummary;
  prepare(workspaceRoot: string, runtimeRoot: string): PreparedContainment;
  launch(request: ContainedLaunchRequest): Promise<ContainedLaunchResult>;
}

export interface WorkspaceProjectionDriver {
  create(request: ProjectionRequest): ProjectionHandle;
  diff(handle: ProjectionHandle): ProjectionDiff;
  reset(handle: ProjectionHandle): void;
  dispose(handle: ProjectionHandle): void;
}
```

## Contained Run Model

For contained generic:

1. `agentgit run` registers the run as it does today.
2. AgentGit creates a projected workspace.
3. AgentGit launches the runtime inside the contained backend.
4. The runtime sees the projected workspace as its writable working directory.
5. On exit, AgentGit computes a diff between the projection and the real workspace baseline.
6. Publication to the real workspace occurs only through AgentGit-governed application logic.

First contained milestone decision:

- publication may be end-of-run and batch-oriented
- do not attempt to fabricate per-tool semantic interception for arbitrary runtimes

## Real Workspace Publication

Contained publication is the safety-critical boundary.

Implement it as:

- diff projection against baseline
- classify file operations into create/update/delete
- apply them to the real workspace through governed daemon-backed filesystem actions
- snapshot before destructive publication when required by current daemon policy

If publication would overwrite newer user changes:

- fail closed into preview
- show the conflicting paths
- default to non-destructive behavior

This reuses the existing authority daemon instead of bypassing it.

## Platform Strategy

### Linux

Primary backend candidates, when containment ships:

- Docker first
- `bubblewrap` later as a lighter native backend if justified

Hardening when available:

- Landlock

Rationale:

- unprivileged namespace-based containment is practical
- filesystem layout can be tightly controlled
- capability detection can degrade honestly when parts are missing

### macOS

Primary backend candidates, when containment ships:

- Docker Desktop first
- later, a more native virtualization-backed runner if Docker proves too limiting

Do not make deprecated host sandboxing the strategic path.

Rationale:

- host shell sandboxing on macOS is not the long-term supported base
- virtualization gives a clearer and more honest boundary for enterprise claims

### Fallback

If containment is unavailable:

- retain current attached lane
- persist degraded capability truthfully

## Adapter Changes

Update [adapters.ts](/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/adapters.ts):

- generic adapter should plan either:
  - attached launch assets
  - contained launch assets

- OpenClaw should remain `integrated`, but may optionally use the contained backend later for stricter workspace protection

`IntegrationMethod` should expand to include:

- `generic_attached_launch`
- `generic_contained_docker_launch`
- `generic_contained_launch`
- `openclaw_config_launch_wrapper`

## Service Changes

Update [service.ts](/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/service.ts):

- `setup()`
  - detect host containment capability
  - honor `--contained`
  - persist assurance and capability fields

- `run()`
  - dispatch by `governance_mode`
  - existing path becomes `attached_live`
  - new contained path creates projection, launches backend, computes diff, then publishes through governed actions

- `inspect()`
  - report assurance truth
  - for contained runs, summarize:
    - projected changes
    - publication status
    - degraded reasons

- `restore()`
  - prefer projection rollback when available
  - otherwise reuse current recovery engine path

## CLI Changes

Update [main.ts](/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/main.ts):

- add Recommended vs Advanced setup selection
- surface assurance information in setup, inspect, and run summaries
- keep default output plain-English

Do not add `--contained` in the ship-now phase.

## Asset Layout

Extend current generated assets under:

- `.agentgit/runtime-integration/`

Recommended subpaths:

- `bin/`
- `openclaw-plugin/`
- `contained/metadata.json`
- `contained/projections/<run-id>/`
- `contained/logs/`

This keeps cleanup reversible under `setup --remove`.

## Testing Requirements

Add unit coverage for:

- capability detection
- assurance migration
- advanced setup option normalization
- recommended and advanced path equivalence under defaults

When Docker containment is implemented, add:

- Docker capability detection
- Docker launch plan validation
- projection mount validation
- publication conflict classification

Deferred until contained backends ship:

- projection diff classification
- contained publication conflict resolution
- contained setup planning

Add integration coverage for:

- setup Recommended happy path
- setup Advanced with default-equivalent selections
- inspect and setup assurance language

Deferred until contained backends ship:

- Docker-backed contained setup happy path
- Docker-backed contained run against projection only
- absolute-path binary mutation staying inside projection
- Docker unavailable fallback to attached
- contained generic run with absolute-path binary writes hitting projection, not real workspace
- contained restore from projection rollback
- contained publication conflict fail-closed behavior
- degraded containment fallback to attached mode
- remove/repair of contained installs

## Milestones

### M1: Truth and capability layer

- add assurance/governance schema fields
- add advanced setup plumbing and option normalization
- add CLI output for assurance truth

### M2: Product hardening on attached lane

- refine setup language and inspect truthfulness
- gather real user feedback on where attached hits the ceiling

### M3: Demo, inspect, and restore polish

- preserve the existing milestone order from the main TDD
- do not pull platform containment work forward ahead of product validation

### M4+: Contained backends, if justified by real user need

- Docker-backed contained generic first
- Linux-native `bubblewrap` backend later if it earns its keep
- macOS-native virtualization-backed launcher later if Docker proves too limiting
- preserve the same projection/publication semantics

### M5+: Credential and egress hardening

- broker contained-run credentials through AgentGit
- optional egress allowlist/proxy
- richer degraded capability reporting

## Explicit Non-Goals

- claiming full arbitrary in-process tool interception for runtimes that expose no hook point
- inventing a separate orchestration platform
- rewriting the authority daemon contract
- requiring containment for the first-run happy path
- shipping platform-specific containment code before the product layer is proven end to end

## Implementation Start Point

The first build pass after this spec should touch:

- [packages/agent-runtime-integration/src/types.ts](/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/types.ts)
- [packages/agent-runtime-integration/src/state.ts](/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/state.ts)
- [packages/agent-runtime-integration/src/main.ts](/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/main.ts)
- [packages/agent-runtime-integration/src/service.ts](/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/service.ts)
- [packages/agent-runtime-integration/src/adapters.ts](/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/adapters.ts)

Then add the new containment modules and test files.
