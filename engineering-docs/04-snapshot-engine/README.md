# 04. Snapshot Engine

## Working Thesis

The Snapshot Engine should optimize for rollback value per byte, not for backup-style completeness per checkpoint.

That means:

- most checkpoints should be journals or manifests, not full copies
- exact anchors should exist, but be relatively rare
- native copy-on-write primitives should be used whenever available
- content-defined chunking and dedupe should be used selectively, not blindly on every hot-path snapshot
- retention and compaction are part of the product, not post-launch cleanup work

The practical goal is:

**take snapshots often enough to preserve autonomy, while keeping the hot local cache small enough that local-first still feels lightweight**

## Product Role

The Snapshot Engine sits between policy and execution.

Its job is to create a recoverable checkpoint boundary when the policy engine says:

- `allow_with_snapshot`
- `ask` but prepare previewable rollback state
- `simulate` but capture baseline state for comparison

It should output a `SnapshotRecord` and any supporting storage artifacts, not just a raw copy of files.

## What Success Looks Like

A good snapshot engine should make these all true at once:

- checkpoints are cheap enough to take frequently
- restore is fast enough to feel usable
- storage growth is bounded and explainable
- memory usage does not scale linearly with historical raw bytes
- the system is honest about exact versus partial reversibility

## Research-Driven Design Constraints

### Native filesystem copy-on-write is the best anchor path when available

Across modern filesystems and platforms, the strongest low-latency checkpoint primitives are native CoW features:

- APFS file clones via `clonefile()` and directory copy helpers via `copyfile()`
- Btrfs subvolume snapshots and reflinks
- ReFS block cloning
- ZFS snapshots and diffs
- VSS copy-on-write / redirect-on-write shadow copies at the volume layer

Design implication:

- use platform-native CoW anchors first
- only fall back to user-space copying or chunk stores when native primitives are unavailable or too coarse
- do not rely on filesystem-native dedupe features as a default launch strategy just because the filesystem offers them

### CoW is fast up front, but can become expensive under heavy churn

VSS and ZFS docs both reinforce the same tradeoff:

- snapshots can be created extremely quickly and initially consume little or no extra space
- as active data changes, retained snapshots consume more space
- diff-area or CoW tracking can get expensive if many writes accumulate

Design implication:

- anchors should be sparse and deliberate
- journals and compaction should prevent long chains of churn against many retained anchors

### Dedupe systems teach an important warning: chunk count is a hidden tax

Borg’s docs are very explicit:

- finer chunking improves dedupe
- but more chunks increase RAM and disk usage for indexes and caches

Kopia shows the upside:

- rolling-hash splitting allows efficient incremental snapshots for large changing files
- content-addressable storage plus packing and compaction works well for long-term retention

Design implication:

- do not run aggressive fine-grained CDC on every hot-path checkpoint
- use chunked dedupe strategically, mainly for large files and colder retention tiers

### Maintenance and compaction are essential, not optional

Kopia’s docs and Borg’s docs both show the same operational truth:

- unreachable content needs GC
- packed storage needs compaction
- append-only or soft-delete modes delay reclamation until maintenance runs

Design implication:

- the local snapshot engine needs explicit GC, compaction, and rebasing rules from the start

### Diffs are useful, but only within honest boundaries

ZFS `diff`, Btrfs incremental send, and Git packfiles all reinforce the value of change-oriented representation.

Design implication:

- change manifests and reverse deltas are the right hot path for many coding-agent workloads
- but delta chains should not grow unbounded

## Non-Goals

- Become a general-purpose machine backup product
- Guarantee exact reversal for all external side effects
- Store every checkpoint as a complete restorable copy
- Optimize only for raw bytes while ignoring restore latency or index overhead

## Core Design

The snapshot engine should support multiple snapshot classes.

## Snapshot Classes

### 1. `metadata_only`

Stores:

- action boundary
- manifest delta
- file metadata
- target/scope summary

Use when:

- action is observed or review-only
- no exact rollback is promised
- we only need comparison and explanation

### 2. `journal_only`

Stores:

- reverse patches for text
- preimage blobs for small touched files
- rename/delete/create metadata
- target manifest delta

Use when:

- scope is narrow and predictable
- files are mostly text/code/config
- rollback can be reconstructed without a full anchor

This should be the dominant launch path for coding-agent workflows.

### 3. `journal_plus_anchor`

Stores:

- a sparse exact anchor for a selected boundary
- journals for actions after the anchor

Use when:

- mutations are broad or partially uncertain
- large files are involved
- shell behavior is difficult to predict precisely

This should be the default “safe but efficient” path for risky local work.

### 4. `exact_anchor`

Stores:

- a directly restorable point-in-time filesystem anchor

Use when:

- precision matters more than storage efficiency
- platform-native CoW makes it cheap enough
- the action boundary is a major branch point

This should be rarer than `journal_only` and `journal_plus_anchor`.

## Core Principle

`allow_with_snapshot` does not mean “always create a full copy”.

It means:

**create the minimum recoverable boundary that satisfies the rollback promise for this action**

## Storage Model

The engine should use a three-tier storage design:

### Tier A. Hot manifest store

Stores:

- workspace trees
- file metadata
- content IDs
- action-to-snapshot mappings

Properties:

- cheap to update
- query-friendly
- low memory footprint

Recommended implementation:

- SQLite or embedded KV store

### Tier B. Hot rollback journal

Stores:

- reverse text patches
- small-file preimages
- rename/delete metadata
- browser/API checkpoint metadata later

Properties:

- very fast to write
- local and short-lived
- compact enough to retain across many actions

### Tier C. Cold content-addressed blob store

Stores:

- compressed blobs
- large-file preimages
- anchor support data
- rebased synthetic anchors

Properties:

- deduplicated
- packed
- compacted in the background

Recommended characteristics:

- content-addressed IDs
- zstd compression
- packed blobs rather than one-file-per-object

## Manifest-First Design

Every snapshot boundary should begin with a manifest.

The manifest should describe:

- root/workspace identity
- path set in scope
- metadata for each tracked path
- content ID if known
- exclusion classification
- parent snapshot link

This gives us:

- fast diffing
- restore planning
- impact previews
- the ability to rebase journals into new anchors later

## Journaling Strategy

### Text-first rollback

For source code and other text-like content, store:

- reverse patch if patch size is small and reliable
- otherwise full preimage if file is below a threshold

Recommended launch heuristic:

- if text file <= `256KB`, store preimage
- if text file > `256KB`, store reverse patch when stable, otherwise chunked preimage

Why:

- reverse patches are usually tiny for code edits
- small-file preimages are often simpler and safer than patch application chains

### Structured filesystem operations

For explicit governed file operations, journal:

- create
- delete
- move
- chmod/chown if relevant
- overwrite

This is usually smaller and safer than inferring everything from later diffs.

### Shell-induced mutations

For shell operations:

- if predicted scope is narrow, pre-journal likely targets
- if predicted scope is broad or unknown, create an anchor first

This is one of the most important storage-saving decisions in the product.

## Anchor Strategy

Anchors should use the cheapest exact platform primitive available.

### Preferred anchor backends

#### macOS

- file clones via `clonefile()`
- recursive copy via `copyfile()` with clone flags when appropriate

Key caveat:

- Apple explicitly discourages using `clonefile()` to clone directory hierarchies directly; use directory copy helpers instead.

#### Linux on Btrfs

- subvolume snapshots for workspace-level anchors
- reflinks for file-level anchors

Key caveat:

- snapshotting is not recursive across nested subvolumes, so workspace layout has to be understood before promising whole-tree rollback

#### Linux on ZFS

- dataset snapshots for strong exact anchors
- `zfs diff` for efficient changed-path discovery

Key caveat:

- ZFS deduplication can be memory-expensive enough to cause performance and import problems on poorly designed systems, so we should not depend on native dedupe as part of the default local-first design

#### Windows on ReFS

- block cloning for file-range copies where available

#### Windows volume-level fallback

- VSS only when we truly need volume-coherent snapshots

VSS is powerful, but it is heavy and should not be our default for small local coding checkpoints.

### Anchor frequency

Do not anchor every action.

Instead:

- anchor at branch points
- anchor before broad or unknown-scope mutation
- anchor after too many journal-only actions
- anchor before large binary churn

## Exclusion Engine

The fastest storage win is usually excluding deterministic junk.

By default, the snapshot engine should classify paths as:

- `protected`
- `derivable`
- `ephemeral`
- `ignored`

### `protected`

Must be considered for rollback:

- source files
- configs
- prompts
- migrations
- documents
- local databases when supported

### `derivable`

Should usually be excluded from exact snapshotting:

- build outputs
- transpiled bundles
- package caches
- dependency installs when reproducible
- test coverage
- logs

### `ephemeral`

Can be omitted aggressively:

- temp files
- browser caches
- editor swap files
- lockfiles that are safe to regenerate depending on policy

### `ignored`

Admin or user-defined exclusions.

This path classifier is one of the highest-leverage storage controls in the system.

## Dedupe Strategy

### Hot path

Prefer:

- file-level content IDs
- coarse chunking only for large files
- no fine-grained CDC for small text files

### Cold path

Use:

- content-addressed packed blobs
- optional rolling-hash chunking for large changing files
- background compaction

### Why not universal CDC?

Because backup-system experience shows the metadata cost can dominate.

Borg explicitly documents that finer chunking increases chunk count and therefore resource usage.

## Adaptive Chunking Policy

Use content-aware rules instead of one chunker for everything.

### Suggested launch heuristics

- files `< 256KB`
  - whole-file storage or reverse patch
- files `256KB - 8MB`
  - whole-file or coarse chunking depending on file type
- files `> 8MB`
  - rolling-hash chunking or platform-native reflink
- known binary/image/archive/database files
  - coarse chunking or exact anchor, not text deltas

### Future optimization

If we add content-defined chunking, prefer a fast modern approach such as FastCDC-class chunking rather than byte-by-byte classic CDC.

But:

- reserve it for the right tier
- do not let chunk indexes dominate RAM

## Compaction And Rebase

This is where we avoid the “20GB cache for 24 hours” trap.

### Journal chain limit

If a snapshot lineage accumulates too many journal-only steps:

- synthesize a new compact anchor
- rewrite the lineage to point at the new anchor
- garbage-collect obsolete journal segments when safe

### Pack compaction

For the cold blob store:

- mark unreachable blobs
- compact sparse packs
- run heavy maintenance only in background/idle windows

### Snapshot value scoring

When pressure is high, evict by rollback value per byte:

- duplicate anchors first
- metadata-only snapshots next
- low-value derivable-path artifacts before protected-path journals

## Retention Model

Retention should not be “keep everything for N hours” in a naive way.

Instead use two dimensions:

- time
- structural importance

### Launch policy idea

- keep all snapshots for recent active runs while under budget
- keep only branch anchors plus minimal journals once a run becomes inactive
- collapse redundant journals into synthetic anchors when cheaper
- prune unreachable blob data after grace period

## Memory Efficiency

Memory pressure usually comes from:

- chunk indexes
- manifest caches
- open file maps
- unbounded diff working sets

### Design rules

- keep hot manifests in an embedded DB, not in-memory only
- cache only recent lineages and content lookups
- use coarse chunks to control index growth
- avoid CDC for small files
- stream hashing/compression instead of buffering whole files

## Speed Strategy

Snapshot speed should prefer:

1. manifest-only update
2. reverse patch or preimage write
3. native reflink/clone
4. chunked CAS write
5. full copy as last resort

This ordering is what keeps frequent snapshotting fast enough for agent workflows.

## Integrity And Verification

The engine should verify that a snapshot is restorable before over-trusting it.

Recommended checks:

- manifest consistency
- blob existence
- patch applicability for text journals
- anchor existence and backend availability
- periodic restore drills on sampled snapshots

Future enhancement:

- Merkle-root verification for immutable stored blobs
- filesystem-native verification hooks where available

## Novel Directions Worth Exploring

These are not launch requirements, but they are high-upside research paths.

### 1. Shadow-execution workspaces

On platforms that support it well, run risky shell actions in a writable overlay or clone-based shadow workspace first, then commit or discard.

Examples:

- Linux OverlayFS upperdir/workdir model
- APFS clone-backed worktree copies
- ZFS clone workflows

Key caveat:

- OverlayFS volatile mounts explicitly trade crash durability for speed and are only appropriate when upper-layer data can be recreated without significant effort

This could make certain classes of snapshot almost free at execution time.

### 2. Semantic rebuild instead of byte retention

For derivable directories, store:

- manifest identity
- build recipe fingerprint
- toolchain fingerprint

and regenerate rather than snapshotting raw bytes.

### 3. Hybrid journal packing inspired by Git packfiles

Pack many reverse deltas and preimages together by similarity and age, then compact in the background.

This could cut metadata and syscall overhead dramatically compared with one-object-per-file storage.

### 4. Risk-adaptive snapshot strength

Use policy risk plus path class to choose snapshot class automatically:

- low-risk text edit => journal only
- medium-risk refactor => journal plus anchor
- high-risk unknown shell op => exact anchor

This is a core product advantage if we do it well.

## Snapshot Record

The snapshot engine should emit a `SnapshotRecord` separate from the `Action` and `PolicyOutcome`.

Recommended fields:

```json
{
  "snapshot_id": "snap_01H...",
  "action_id": "act_01H...",
  "snapshot_class": "journal_plus_anchor",
  "fidelity": "exact_for_protected_paths",
  "scope": {
    "breadth": "workspace",
    "path_count": 184
  },
  "artifacts": {
    "manifest_id": "man_01H...",
    "journal_ids": ["jrnl_01H..."],
    "anchor_ref": "anchor_01H..."
  },
  "storage_cost": {
    "logical_bytes": 1284932,
    "physical_bytes": 231442,
    "index_entries": 412
  },
  "created_at": "2026-03-29T16:20:00Z"
}
```

## Build Order

1. Implement manifest store and path classification
2. Implement `journal_only` for governed filesystem edits
3. Implement text reverse patches and small-file preimages
4. Implement native anchor backends:
   - APFS clone/copy helpers
   - Btrfs reflink/snapshot
   - ReFS block clone where available
5. Add content-addressed blob storage for large preimages
6. Add compaction, GC, and synthetic-anchor rebasing
7. Add snapshot budgeting and eviction policies
8. Add advanced large-file chunking only where it pays

## Concrete Recommendation

For launch, the snapshot engine should optimize for one thing:

**default to journals, escalate to anchors, dedupe only where it pays, and aggressively exclude anything we can deterministically rebuild**

That is the best path to frequent checkpoints without runaway local storage.

## Research Inputs

- Apple `clonefile(2)`: <https://keith.github.io/xcode-man-pages/clonefile.2.html>
- Apple `copyfile(3)`: <https://keith.github.io/xcode-man-pages/copyfile.3.html>
- Btrfs subvolumes: <https://btrfs.readthedocs.io/en/latest/Subvolumes.html>
- Btrfs send/receive: <https://btrfs.readthedocs.io/en/latest/btrfs-send.html>
- Btrfs reflink: <https://btrfs.readthedocs.io/en/latest/Reflink.html>
- Linux Btrfs overview: <https://docs.kernel.org/6.11/filesystems/btrfs.html>
- OpenZFS snapshots: <https://openzfs.github.io/openzfs-docs/man/v0.8/8/zfs.8.html>
- OpenZFS diff: <https://openzfs.github.io/openzfs-docs/man/v2.0/8/zfs-diff.8.html>
- Microsoft VSS: <https://learn.microsoft.com/en-us/windows-server/storage/file-server/volume-shadow-copy-service>
- Microsoft ReFS block cloning: <https://learn.microsoft.com/en-us/windows-server/storage/refs/block-cloning>
- Microsoft Win32 block cloning API: <https://learn.microsoft.com/en-us/windows/win32/fileio/block-cloning>
- ReFS integrity streams: <https://learn.microsoft.com/en-us/windows-server/storage/refs/integrity-streams>
- Kopia features: <https://kopia.io/docs/features/>
- Kopia compression: <https://kopia.io/docs/advanced/compression/>
- Kopia maintenance: <https://kopia.io/docs/advanced/maintenance/>
- Kopia architecture: <https://kopia.io/docs/advanced/architecture/>
- Borg chunker notes: <https://borgbackup.readthedocs.io/en/1.4-maint/usage/notes.html>
- Borg compaction/prune notes: <https://borgbackup.readthedocs.io/en/2.0.0b18/usage/prune.html>
- restic repository dedupe notes: <https://restic.readthedocs.io/en/v0.16.2/045_working_with_repos.html>
- FastCDC paper: <https://www.usenix.org/conference/atc16/technical-sessions/presentation/xia>
- OverlayFS docs: <https://docs.kernel.org/filesystems/overlayfs.html>
