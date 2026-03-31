# Research Notes

## Scope

This note captures the external research used to shape the first plan for the Snapshot Engine subsystem.

Research date:

- March 29, 2026

## Key Findings

### 1. Native copy-on-write primitives are the best exact-anchor substrates

Across platforms, the fastest exact checkpoints are provided by filesystem-native or volume-native CoW features:

- APFS file clones share blocks until one side is modified
- Btrfs supports writable snapshots, reflinks, and incremental send/receive
- ZFS snapshots are created extremely quickly and initially consume no additional space
- ReFS block cloning remaps clusters as a metadata operation and preserves isolation with allocate-on-write
- VSS supports complete copy, copy-on-write, and redirect-on-write methods

Design implication:

- prefer native CoW anchors first
- do not emulate full copies in user space when the platform can provide a sparse exact anchor more cheaply

### 2. CoW snapshots are cheap initially but not free over time

Both ZFS and VSS emphasize the same tradeoff:

- snapshots are fast to create
- retained snapshots consume more space as active data diverges
- copy-on-write or diff areas become expensive under heavy churn

Design implication:

- do not anchor too frequently
- pair anchors with journals and rebasing

### 3. Dedupe works, but chunk count drives memory and metadata cost

Borg’s docs are unusually clear that chunking choices materially affect resource usage:

- finer chunks improve dedupe
- but they create more chunks and therefore more index/cache pressure

Kopia shows the other side:

- rolling-hash splitting is excellent for large modified files
- content-addressed packed storage plus compaction supports long-lived incremental snapshots

Design implication:

- use chunked dedupe selectively
- keep small-file hot paths simple
- reserve heavy chunking for large-file and colder storage tiers

### 4. Maintenance is inseparable from storage design

Kopia’s maintenance docs and Borg’s prune/compact behavior both reinforce that reclaiming space requires:

- marking unreachable content
- compacting sparse packs
- running GC and maintenance on a schedule

Design implication:

- snapshot retention and compaction must be first-class design concerns in our local engine

### 5. Diff-oriented representations are ideal for many coding-agent actions

ZFS diff, Btrfs incremental send, and Git’s packed/delta storage model all point the same direction:

- represent changes relative to a stable boundary when possible
- periodically compact or repack to keep chains efficient

Design implication:

- reverse patches and small-file preimages should dominate the launch path
- synthetic anchors should collapse long journal chains

### 6. Exclusion of rebuildable paths is one of the biggest wins

No single source says this outright in agent terms, but the storage systems all rely on policies, sharding, chunk boundaries, and maintenance to avoid wasting resources on low-value data.

Design implication:

- classify paths into protected, derivable, ephemeral, and ignored
- avoid exact snapshotting of deterministic junk by default

### 7. Overlay/clone-backed execution is an intriguing future accelerator

OverlayFS explicitly supports lower/upper/workdir composition, making it a plausible substrate for a future “shadow execution workspace” model on Linux.

Design implication:

- not a launch requirement
- but a high-upside future direction for nearly-free risky-action staging

## Source Notes

### Apple / macOS

- `clonefile(2)`
  - File clone creates copy-on-write clones of files; directories should not be cloned directly this way.
  - <https://keith.github.io/xcode-man-pages/clonefile.2.html>

- `copyfile(3)`
  - Supports clone-oriented copying and exposes whether data was cloned rather than physically copied.
  - <https://keith.github.io/xcode-man-pages/copyfile.3.html>

### Linux / Btrfs / OverlayFS

- Btrfs overview
  - Writable snapshots, reflink, deduplication, send/receive are all first-class features.
  - <https://docs.kernel.org/6.11/filesystems/btrfs.html>

- Btrfs send
  - Incremental send can describe changes between snapshots.
  - <https://btrfs.readthedocs.io/en/latest/btrfs-send.html>

- Btrfs subvolumes
  - Snapshot and receive behavior matters for anchor semantics.
  - <https://btrfs.readthedocs.io/en/latest/Subvolumes.html>

- Btrfs reflink
  - Reflink is a shallow copy that shares blocks and is typically much faster than a deep copy.
  - <https://btrfs.readthedocs.io/en/latest/Reflink.html>

- OverlayFS
  - Lower/upper/workdir model suggests a possible future shadow-execution design.
  - <https://docs.kernel.org/filesystems/overlayfs.html>

### OpenZFS

- ZFS snapshots
  - Snapshots are taken atomically, extremely quickly, and initially consume no additional space.
  - <https://openzfs.github.io/openzfs-docs/man/v0.8/8/zfs.8.html>

- ZFS diff
  - Efficiently lists created/removed/modified/renamed paths between snapshots.
  - <https://openzfs.github.io/openzfs-docs/man/v2.0/8/zfs-diff.8.html>

- ZFS deduplication caveat
  - Deduplication is resource-intensive and can create memory and import problems on poorly designed systems.
  - <https://openzfs.github.io/openzfs-docs/man/v0.7/8/zfs.8.html>

### Windows

- VSS
  - Supports complete copy, copy-on-write, and redirect-on-write; copy-on-write is quick but can become expensive with many changes.
  - <https://learn.microsoft.com/en-us/windows-server/storage/file-server/volume-shadow-copy-service>

- ReFS block cloning
  - Metadata operation using cluster remapping with allocate-on-write isolation.
  - <https://learn.microsoft.com/en-us/windows/win32/fileio/block-cloning>
  - <https://learn.microsoft.com/en-us/windows-server/storage/refs/block-cloning>

- ReFS integrity streams
  - Optional checksumming for file data can support stronger anchor integrity for some deployments.
  - <https://learn.microsoft.com/en-us/windows-server/storage/refs/integrity-streams>

### Backup / Deduplication Systems

- Kopia features
  - Always-incremental snapshots, rolling-hash splitting, deduplication, rename detection.
  - <https://kopia.io/docs/features/>

- Kopia compression
  - Chunk, dedupe, then compress, then encrypt, then pack.
  - <https://kopia.io/docs/advanced/compression/>

- Kopia architecture
  - Strong reference for content-addressed blocks, packs, indices, and manifests.
  - <https://kopia.io/docs/advanced/architecture/>

- Kopia maintenance
  - Snapshot GC and pack compaction are required ongoing tasks.
  - <https://kopia.io/docs/advanced/maintenance/>

- Borg notes
  - Chunker parameters have major impact on RAM and disk usage due to chunk count.
  - <https://borgbackup.readthedocs.io/en/1.4-maint/usage/notes.html>

- Borg prune / compact
  - Deletion and compaction are separate and disk is not freed until compaction.
  - <https://borgbackup.readthedocs.io/en/2.0.0b18/usage/prune.html>

- restic repository notes
  - Dedupe depends on matching chunking parameters; repository layout choices influence dedupe effectiveness.
  - <https://restic.readthedocs.io/en/v0.16.2/045_working_with_repos.html>

### Research Paper

- FastCDC
  - Strong evidence that faster CDC approaches can materially improve chunking throughput.
  - <https://www.usenix.org/conference/atc16/technical-sessions/presentation/xia>

## Resulting Recommendation

The snapshot engine should be:

- manifest-first
- journal-dominant on the hot path
- anchor-capable via native CoW primitives
- content-addressed and compacted for colder storage
- aggressively exclusion-aware
- explicit about fidelity and rollback guarantees
