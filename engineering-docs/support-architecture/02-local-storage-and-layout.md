# 02. Local Storage And Layout

## Working Thesis

The local-first system should use a small number of clearly separated storage roots, each with an explicit durability class and cleanup policy.

That means:

- runtime coordination files should be separated from durable history
- durable history should be separated from rebuildable caches
- secrets should be separated from general app data
- workspace-specific state should be separated from user-global state

The layout should make it obvious which data:

- must survive restart
- may be compacted
- may be deleted and rebuilt
- should never be synced by default

## Why This Matters

If the local layout is muddled:

- retention will be hard to reason about
- support and debugging will be painful
- cleanup will accidentally destroy important state
- future hosted sync will be harder to define

If it is too fragmented:

- the product becomes operationally noisy
- migrations get harder

So the right design is:

**few roots, strong data classes, clear ownership**

## Platform Placement Rules

The product should respect platform-native user data conventions.

### macOS

Prefer:

- durable app data under `~/Library/Application Support/<app-id>/`
- caches under `~/Library/Caches/<app-id>/`

Apple’s file system guidance explicitly recommends user-specific app data under `Application Support` and regenerated data under `Caches`.

### Linux and other Unix-like desktops

Prefer XDG base directories:

- durable app data under `$XDG_DATA_HOME/<app-id>` or `~/.local/share/<app-id>`
- config under `$XDG_CONFIG_HOME/<app-id>` or `~/.config/<app-id>`
- state under `$XDG_STATE_HOME/<app-id>` or `~/.local/state/<app-id>`
- cache under `$XDG_CACHE_HOME/<app-id>` or `~/.cache/<app-id>`
- runtime sockets/locks under `$XDG_RUNTIME_DIR/<app-id>` when available

The XDG spec is especially useful here because it distinguishes:

- config
- data
- state
- cache
- runtime

which maps very well to this product.

### Windows

Prefer:

- durable machine-local state under `%LOCALAPPDATA%\<Vendor>\<App>`
- roaming-friendly config only if truly portable under `%APPDATA%\<Vendor>\<App>`

For this product, most active runtime state should be local, not roaming.

Reasons:

- journals, blobs, sockets, and snapshots are machine-local
- snapshot fidelity depends on local filesystem behavior
- active execution history should not silently roam across machines

## Launch Recommendation

For launch, optimize for:

- one user-local authority root
- one user-local cache root
- one OS-native secret store when available
- optional workspace-local marker files only for discoverability, not durable truth

## Top-Level Logical Layout

Use the following logical roots:

- `config_root`
- `data_root`
- `state_root`
- `cache_root`
- `runtime_root`
- `secret_root` only if OS-native secret storage is unavailable

## Recommended App ID

Use a stable app ID such as:

- `dev.agentgit.authority`

That keeps paths and future migrations consistent.

## Proposed Directory Layout

Within the logical roots, use a consistent substructure.

### `config_root`

Purpose:

- durable user and workspace configuration
- policy presets
- environment profiles

Suggested contents:

- `config.toml`
- `policies/`
- `profiles/`
- `migrations/`

### `data_root`

Purpose:

- durable user-global data that should survive restarts and upgrades

Suggested contents:

- `journal/`
- `snapshots/`
- `artifacts/`
- `workspaces/`
- `schema-pack-version`

### `state_root`

Purpose:

- durable but non-portable operational state

Suggested contents:

- `runs/`
- `approvals/`
- `maintenance/`
- `capabilities.json`
- `projection-state/`

This is a good home for data that persists across restarts but is not the canonical long-term history store.

### `cache_root`

Purpose:

- rebuildable caches
- compaction scratch space
- helper fact caches
- imported preview artifacts

Suggested contents:

- `projection-cache/`
- `helper-cache/`
- `compaction/`
- `temp-artifacts/`

### `runtime_root`

Purpose:

- socket or named-pipe endpoints
- PID files
- single-instance lockfiles
- short-lived work queues

Suggested contents:

- `authority.sock` or equivalent
- `authority.pid`
- `locks/`
- `runtime-tmp/`

On Linux, this should prefer `$XDG_RUNTIME_DIR` when available because the XDG spec explicitly treats it as the right place for sockets and local coordination files.

## Durable Substores

## 1. Journal store

Suggested path:

- `data_root/journal/authority.sqlite3`

Related files:

- SQLite WAL and SHM files
- projection metadata

Rules:

- local disk only
- not in cache
- not on network filesystems

## 2. Snapshot store

Suggested path:

- `data_root/snapshots/`

Suggested substructure:

- `manifests/`
- `journals/`
- `anchors/`
- `packs/`
- `gc/`

Rules:

- this is durable user data
- compactable, but not disposable

## 3. Artifact store

Suggested path:

- `data_root/artifacts/`

Suggested substructure:

- `by-hash/`
- `indexes/`
- `preview/`

Rules:

- large blobs live here, not in the journal DB
- retention may expire some artifacts earlier than journal metadata

## 4. Workspace index

Suggested path:

- `data_root/workspaces/`

Purpose:

- per-workspace identity
- mapping from workspace roots to stored state
- workspace capability memoization

This should not be the canonical event history. It is an index over workspace-scoped state.

## Per-Workspace State Model

Use a hybrid model:

### User-global canonical state

Keep canonical truth in the user-local authority roots.

Reasons:

- a user may govern multiple workspaces
- the authority daemon owns the truth
- central maintenance is easier

### Workspace-local discoverability marker

Optionally place a lightweight workspace marker in the repo such as:

- `.agentgit/authority.json`

Purpose:

- workspace ID
- authority metadata pointer
- optional opt-in config pointer

Rules:

- should never be required for truth
- should not contain secrets
- should remain small and hand-inspectable

## Data Classes

Every stored object should belong to one of these classes:

### `canonical_durable`

Examples:

- run journal
- snapshot manifests
- snapshot journals
- recovery plans

Deletion:

- only through explicit retention or archival policy

### `durable_operational`

Examples:

- approval queue state
- maintenance checkpoints
- capability cache

Deletion:

- allowed if rebuildable or reconcilable

### `rebuildable_cache`

Examples:

- helper fact caches
- projection caches
- compaction scratch files

Deletion:

- safe at any time

### `ephemeral_runtime`

Examples:

- sockets
- locks
- transient work files

Deletion:

- expected at shutdown or crash recovery

## Retention Boundaries

Retention policy should align with directory boundaries.

Examples:

- `cache_root` may be aggressively pruned
- artifact previews may expire before durable blobs
- snapshot packs may compact but not disappear without policy
- journal events should outlive projections and derived caches

This is much easier if the directories mirror data class boundaries.

## File Naming And Sharding

To avoid giant flat directories:

- shard content-addressed blobs by prefix
- keep metadata indexes separate from large blob payloads
- use stable IDs for run and workspace folders where direct partitioning is needed

Example:

- `artifacts/by-hash/ab/cd/<hash>`
- `snapshots/packs/01/<pack-id>.pack`

## Local Locking And Single-Instance State

The runtime should own a single local authority root per user profile.

Needed files:

- single-instance lock
- daemon PID or equivalent
- runtime endpoint file

Rules:

- lock and runtime files belong in `runtime_root`
- canonical state should not rely on PID files for integrity

## Migration Model

Every major root should carry versioned metadata.

Suggested files:

- `data_root/VERSION`
- `config_root/VERSION`

Migration rules:

- schema and storage migrations should be explicit
- old state should not be silently rewritten without a version check
- failed migrations should fail closed before action traffic begins

## Backup And User Expectations

The product should be explicit about which local data is valuable to back up.

By default, users should treat as important:

- `config_root`
- `data_root`

Less important:

- `state_root`
- `cache_root`
- `runtime_root`

This distinction should eventually surface in docs and diagnostics.

## Launch Recommendation

For launch, the strongest storage recommendation is:

- canonical history and snapshots live in user-local durable roots
- caches and runtime files are cleanly separated
- secrets use OS-native stores when available
- workspace repos contain only lightweight optional markers

That gives us a local-first layout that is both debuggable and ready for future sync boundaries.

## Source Inputs

- Apple Library directory guidance: <https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/MacOSXDirectories/MacOSXDirectories.html>
- Apple file system basics: <https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/FileSystemOverview/FileSystemOverview.html>
- XDG Base Directory Specification: <https://specifications.freedesktop.org/basedir/latest/>
- Windows KNOWNFOLDERID / AppData paths: <https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid>
