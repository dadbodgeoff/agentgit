# 05. Snapshot Engine Spec

## Scope

This document resolves snapshot class semantics, manifest structure, patch strategy, anchor strategy, classification, compaction, and integrity rules.

## Snapshot Classes

- `metadata_only`
  - comparison and explanation only
- `journal_only`
  - reverse patches, preimages, structural ops, manifest delta
- `journal_plus_anchor`
  - sparse exact anchor + journals
- `exact_anchor`
  - strongest exact local restore boundary

## Fidelity Enum

- `metadata_only`
- `review_only`
- `partial_for_protected_paths`
- `exact_for_protected_paths`
- `exact_boundary`

## Manifest

- Storage:
  - SQLite-backed metadata + optional compact JSON export
- Entry fields:
  - `path`
  - `content_id`
  - `size`
  - `mtime`
  - `mode`
  - `file_type`
  - `classification`
  - `hash_algorithm`

## Reverse Patch Strategy

- Threshold:
  - **256 KB** preimage vs reverse patch cutoff
- Patch stability:
  - text only
  - exact pre-change hash known
  - patch size <= 80% of preimage
- Binary:
  - preimage or blob reference

## Anchors

- Rebase/synthetic anchor triggers:
  - > **50** journal actions
  - > **128 MB** protected bytes changed
  - broad/unknown-scope destructive action
- Branch points:
  - explicit checkpoint
  - approval boundary
  - major destructive shell op
  - recovery branch

## Path Classification

- `protected`
- `derivable`
- `ephemeral`
- `ignored`

`.gitignore` is a hint, not authority.

## Compaction And GC

- Compaction triggers:
  - chain length > 50
  - fragmentation > 30%
  - storage > 80% of budget
- GC safety:
  - no chain removal while referenced by active recovery/run/rebuild

## Integrity

- Checksums for blobs and manifests
- Periodic sampled restore drills
- Failure:
  - quarantine lineage
  - degrade restore confidence
