# 08. Recovery Engine Spec

## Scope

This document resolves recovery confidence, compensation generation, conflict analysis, approval flow, failure behavior, and external object recovery.

## Recovery Classes

- `reversible`
- `compensatable`
- `review_only`
- `irreversible`

## Confidence

Inputs:

- snapshot fidelity
- intervening actions
- path overlap
- provenance strength
- external divergence risk

Outputs:

- `high`
- `medium`
- `low`

## Compensation

- Hybrid model:
  - explicit per-adapter/integration mappings
  - no LLM-generated critical-path compensators in v1

### Launch defaults

- Filesystem:
  - restore/delete/recreate from snapshots and preimages
- Shell:
  - usually restore-via-snapshot or review-only
- MCP / HTTP/API:
  - trusted integration-specific inverse mappings only
- Browser:
  - mostly remediation unless explicit cancellation flow exists

## Conflict Analysis

- Overlap:
  - exact path match
  - ancestor/descendant containment
  - rename lineage when known
- Severity:
  - `low`
  - `moderate`
  - `high`

## Recovery Approval

- Approve the recovery plan by default, not every step
- Recovery actions still go through policy
- Sensitive compensating actions may trigger asks

## Failure Behavior

- Restore failure:
  - alternate restore strategy if available
  - otherwise compensate/remediate
- Mid-chain compensation failure:
  - stop chain
  - mark partial
  - preserve resumable state

## External Objects

- Identity tuple:
  - integration
  - object_type
  - object_id
  - version/etag optional
- `review_only` must still show:
  - systems touched
  - objects touched
  - likely manual steps
  - evidence and uncertainty
