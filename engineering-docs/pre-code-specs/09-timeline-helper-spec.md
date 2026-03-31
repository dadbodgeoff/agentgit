# 09. Timeline And Helper Spec

## Scope

This document resolves step construction, timeline views, grounded helper behavior, provenance display, and summarization rules.

## Step Construction

- One top-level step per:
  - action boundary
  - approval unit
  - recovery unit
  - major system event when user-relevant
- Retried attempts under same `action_id` stay within one step
- Multiple snapshots per action remain one step with detailed refs

## Views

- Default:
  - title, status, provenance, decision, reversibility, summary, recovery affordance
- Change:
  - top roots/counts first, drill-down later
- Risk:
  - ask/deny/allow_with_snapshot/simulate and severe steps
- Recovery:
  - restore points, confidence, impact preview

## Helper Query Pipeline

- journal facts
- projections
- artifacts
- recovery plans
- model synthesis last

Launch query types:

- `what_happened`
- `what_changed_after`
- `likely_cause`
- `revert_impact`
- `external_effects`
- `run_summary`
- `why_blocked`
- `reversible_steps`

## Confidence And Uncertainty

- Helper returns:
  - answer
  - `high` / `medium` / `low`
  - evidence
  - uncertainty
- Helper must say “I don’t know” when evidence is insufficient

## Provenance Display

- governed = highest confidence
- observed = reduced-trust label
- imported = external-source label
- unknown = warning state

## Summaries

- Run purpose:
  - user-supplied first
  - otherwise derived from workflow metadata and early steps
- Major changes ordered by impact, then chronology
- Targets:
  - run summary: 4-8 concise points
  - step summary: 1 sentence
