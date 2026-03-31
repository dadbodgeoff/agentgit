# 13. Examples And Validation Spec

## Scope

This document defines the required example-record and validation work that must happen before implementation gets too far ahead of the contracts.

## Schema Example Requirements

For each canonical schema:

- `Action`
- `PolicyOutcome`
- `SnapshotRecord`
- `ExecutionResult`
- `RunEvent`
- `RecoveryPlan`
- `TimelineStep`

create:

- 3 valid examples:
  - happy path
  - edge case
  - minimal valid
- 3 invalid examples:
  - missing required field
  - wrong type
  - invalid enum/reference

## Validation Rules

- All examples must validate against the JSON schemas in CI
- Linked example bundles must preserve referential integrity across IDs
- The canonical fixture location is [schema-pack/examples/README.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/schema-pack/examples/README.md)
- The canonical validation entrypoint is:
  - `python3 engineering-docs/schema-pack/examples/validate_examples.py`

## Implemented Fixture Set

The required fixture set now exists as grouped JSON example files:

- `engineering-docs/schema-pack/examples/valid/*.examples.json`
- `engineering-docs/schema-pack/examples/invalid/*.examples.json`
- `engineering-docs/schema-pack/examples/traces/*.json`

The validator currently checks:

- every valid grouped case must pass its schema
- every invalid grouped case must fail its schema
- every trace record must pass its corresponding schema
- cross-record IDs in each trace must resolve consistently

## End-To-End Trace Examples

Required trace bundles:

- simple file write (`allow`)
- destructive shell command (`allow_with_snapshot`)
- untrusted MCP tool call (`ask -> approve -> execute`)
- denied action
- failed execution with recovery
- simulated action
- imported/observed action

## Why This Matters

These traces are the fastest way to test whether:

- the schema pack is usable
- the daemon API shape is coherent
- the journal/timeline model is understandable
- recovery and provenance semantics hold together
