# Research Notes

## Scope

This note captures the external research used to shape the first plan for the Recovery Engine subsystem.

Research date:

- March 30, 2026

## Key Findings

### 1. Inversion and restore are related, but not the same

SQLite’s session extension distinguishes between:

- applying a changeset
- inverting a changeset
- rebasing a changeset

Design implication:

- recovery should distinguish exact restore from inverse remediation under drift

### 2. Mature systems separate restore from compensate from investigate

Git exposes multiple recovery tools because recovery is not one thing:

- `restore` recovers content
- `revert` applies a compensating inverse change
- `reflog` helps find old reachable states
- `bisect` helps locate the likely causative change

Design implication:

- our recovery engine should have separate classes for restore, compensate, and review/investigation support

### 3. Snapshot-backed rollback is only as strong as its substrate boundary

ZFS and Btrfs snapshots are strong exact-state tools, but only within the actual dataset/subvolume boundaries and artifacts retained.

Design implication:

- recovery guarantees must be scoped to real anchors and manifests, not hand-wavy workspace notions

### 4. Drift is the central recovery problem

The more later actions accumulate, the less safe raw rollback becomes.

Design implication:

- impact previews and overlap detection are essential
- some recovery paths must downgrade from restore to review-only

## Source Notes

### SQLite

- Session introduction
  - Changesets/patchsets and replay semantics are a strong conceptual fit for drift-aware restore.
  - <https://sqlite.org/sessionintro.html>

- Invert changeset
  - Explicit inversion API.
  - <https://sqlite.org/session/sqlite3changeset_invert.html>

- Rebase changeset
  - Explicit rebase concept when the target state has drifted.
  - <https://sqlite.org/session/sqlite3rebaser_rebase.html>

### Git

- `git revert`
  - Compensation via inverse follow-up commit.
  - <https://git-scm.com/docs/git-revert.html>

- `git restore`
  - Path and tree restoration semantics.
  - <https://git-scm.com/docs/git-restore.html>

- `git reflog`
  - Local history of reference movement, useful model for state-boundary discovery.
  - <https://git-scm.com/docs/git-reflog.html>

- `git bisect`
  - Investigation path for likely causative change discovery.
  - <https://git-scm.com/docs/git-bisect.html>

### Filesystems

- OpenZFS `zfs`
  - Snapshot/rollback/clone semantics define the scope and strength of exact rollback.
  - <https://openzfs.github.io/openzfs-docs/man/v0.8/8/zfs.8.html>

- OpenZFS `zfs-diff`
  - Useful for later-overlap and impact analysis between boundaries.
  - <https://openzfs.github.io/openzfs-docs/man/v2.0/8/zfs-diff.8.html>

- Btrfs subvolumes
  - Snapshot boundaries depend on subvolume structure.
  - <https://btrfs.readthedocs.io/en/latest/Subvolumes.html>

## Resulting Recommendation

The recovery engine should be:

- boundary-based
- drift-aware
- explicit about restore vs compensate
- preview-first
- honest about irrecoverable and review-only cases
