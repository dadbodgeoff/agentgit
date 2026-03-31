# 05. Platform Capabilities

## Working Thesis

The runtime should explicitly detect and model platform capabilities because snapshot cost, isolation strength, and credential quality all depend on the host environment.

That means:

- feature support should be discovered, not assumed
- degraded mode should be represented explicitly
- policy and snapshot decisions should consume capability state
- the product should only promise guarantees the platform can actually support

## Why This Matters

If the runtime assumes too much:

- rollback claims become dishonest
- brokering and storage may fail unpredictably
- execution behavior varies silently across machines

If it assumes too little:

- the product leaves major performance and safety wins on the table

So the right design is:

**detect capabilities once, cache them, and use them everywhere**

## Capability Categories

The runtime should classify capabilities into several groups.

## 1. Filesystem and snapshot capabilities

Examples:

- APFS clone support
- Btrfs reflink and subvolume snapshot support
- ZFS snapshot/diff support
- ReFS block cloning support
- local filesystem suitability for SQLite WAL

These drive snapshot-class selection and fidelity.

## 2. Runtime coordination capabilities

Examples:

- Unix domain socket support
- named pipes
- reliable local lock files
- file watching support

These drive IPC and observation paths.

## 3. Credential and secret-storage capabilities

Examples:

- macOS Keychain availability
- Windows Credential Manager availability
- DPAPI availability
- Secret Service availability on Linux

These drive credential broker strength and degraded modes.

## 4. Execution environment capabilities

Examples:

- shell availability
- browser harness support
- process tree introspection
- resource-limiting primitives

These drive adapter behavior and isolation.

## Capability Quality Levels

Each capability should be rated, not just marked yes/no.

Recommended levels:

- `strong`
- `usable`
- `degraded`
- `unsupported`
- `unknown`

This is especially useful for snapshot and credential support.

## Launch Capability Matrix

### macOS

Likely strengths:

- strong local durable app-data conventions
- APFS clone-oriented paths often available
- Keychain available
- Unix domain sockets available

Likely caveats:

- directory-tree snapshot behavior depends on how we implement clone-backed anchors
- full sandboxing is not a launch assumption

### Linux

Likely strengths:

- strong XDG layout
- Unix domain sockets
- flexible process model
- OverlayFS/Btrfs/ZFS depending on distro and filesystem

Likely caveats:

- secret storage quality varies a lot
- snapshot capabilities vary dramatically by filesystem
- desktop/keyring availability is inconsistent

### Windows

Likely strengths:

- good local app-data conventions
- Credential Manager and DPAPI
- named-pipe model later

Likely caveats:

- snapshot backends differ significantly by volume/filesystem
- VSS is heavier than we want for hot-path checkpoints
- local path and shell behavior differ from Unix-like assumptions

## Capability Detection Timing

The runtime should detect:

### At startup

- storage roots
- socket/pipe feasibility
- secret store availability
- filesystem type and major snapshot features
- SQLite-local-disk suitability

### On workspace registration

- workspace filesystem type
- writable roots
- snapshot backend suitability for that workspace

### On demand

- browser harness availability
- optional external tool helpers
- capability changes after system updates or remounts

## Capability Cache

The runtime should persist a capability summary in state so that:

- startup is faster after first detection
- diagnostics can show what was detected
- policy can consume stable capability labels

But:

- capability caches must be invalidatable
- mount points and external drives may change

## Suggested Capability Object

Each capability record should include:

- `capability_name`
- `status`
- `scope`
- `detected_at`
- `source`
- `details`

Example scopes:

- `host`
- `workspace`
- `adapter`

## Policy Integration

Policy should consume capabilities explicitly.

Examples:

- if strong snapshot backend unavailable, use stricter `ask` on broad destructive shell actions
- if broker-grade secret storage unavailable, degrade integration trust and require session credentials
- if cached owned-adapter capability state is stale or unavailable, stop automatic brokered execution and require refresh or explicit approval
- if cached workspace access or runtime snapshot storage state is stale or degraded, stop automatic governed filesystem and snapshot-backed shell execution and require refresh or explicit approval
- if cached workspace access or runtime snapshot storage state is stale, unavailable, or incomplete, degrade automatic snapshot restore and path-subset recovery to `review_only`
- if browser harness unavailable, deny governed browser execution but still allow observed mode where appropriate

## Snapshot Integration

Snapshot selection should consult capability state.

Examples:

- APFS clone support => stronger anchor path
- Btrfs subvolume support => exact-anchor candidate for workspace
- no strong local snapshot primitive => bias toward journal-only and narrower protected scopes

## Runtime Diagnostics

The CLI and UI should surface capability summaries like:

- snapshot backend: `strong`
- secret store: `usable`
- governed browser support: `unsupported`
- local journal storage: `strong`

## Launch Reality

At launch, `get_capabilities` should stay narrow and honest.

The daemon currently reports:

- host runtime storage readiness for socket, journal, and snapshot roots
- credential broker mode as `degraded` when only session-environment profiles are available
- owned adapter credential readiness such as brokered ticket credentials
- optional workspace-root read/write access when a workspace path is supplied

Anything beyond that should wait until the runtime can actually detect and maintain it durably.

Launch follow-through:

- `capability_refresh` should durably cache the latest capability snapshot
- diagnostics should surface cached degraded or stale capability state without requiring a fresh interactive probe
- the stale threshold should be explicit and configurable so operators can tune how aggressively capability drift is flagged
- diagnostics and approval-gated flows should expose the dominant cached capability problem as a structured
  primary reason instead of relying only on freeform warning text

This is one of the best ways to keep the product honest.

## Degraded Mode Rules

When a capability is degraded:

- record it
- expose it
- let policy adapt
- avoid pretending feature parity

Examples:

- no secret store => session-only broker mode
- weak snapshot backend => narrower restore guarantees
- no local runtime dir => use fallback directory and warn

## Launch Recommendation

For launch, the platform-capability layer should be:

- explicit
- cached
- consumed by policy and snapshot logic
- visible in diagnostics

That will let the same product behave honestly across machines with very different underlying support.

## Source Inputs

- Apple file system and APFS guidance: <https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/FileSystemOverview/FileSystemOverview.html>
- XDG Base Directory Specification: <https://specifications.freedesktop.org/basedir/latest/>
- Windows KNOWNFOLDERID and local path guidance: <https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid>
- Apple keychain guidance: <https://developer.apple.com/library/archive/documentation/Security/Conceptual/cryptoservices/KeyManagementAPIs/KeyManagementAPIs.html>
- Windows Credentials and DPAPI: <https://learn.microsoft.com/en-us/windows/win32/secauthn/credentials-management>
- <https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata>
- Secret Service API draft: <https://specifications.freedesktop.org/secret-service/latest/>
