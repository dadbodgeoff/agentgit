# Canonical Schema Pack

This folder contains the canonical Draft 2020-12 JSON Schemas for the core records described across the engineering docs.

## Included Schemas

- `action.schema.json`
- `policy-outcome.schema.json`
- `snapshot-record.schema.json`
- `execution-result.schema.json`
- `run-event.schema.json`
- `recovery-plan.schema.json`
- `timeline-step.schema.json`
- `common.schema.json`

## Example Fixtures

The schema pack now includes a worked fixture set under [examples/README.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/schema-pack/examples/README.md).

That fixture set contains:

- grouped valid examples for every core schema
- grouped invalid examples for every core schema
- linked end-to-end trace bundles
- a validation script that checks both schema compliance and trace referential integrity

Run it with:

```bash
python3 engineering-docs/schema-pack/examples/validate_examples.py
```

The same fixture set is also enforced by the normal repo test pipeline via `pnpm test` through `@agentgit/schemas`, so schema/example drift fails fast during everyday development.

## Design Rules

- These schemas define the stable cross-subsystem contracts.
- Large payloads should be stored by reference, not embedded.
- The schemas are intentionally strict on top-level shape and intentionally flexible in a few payload areas where domain-specific growth is expected.
- All schemas use JSON Schema Draft 2020-12.

## Versioning

- Current schema pack version: `v1`
- Schema IDs use `https://agentgit.local/schemas/...` as canonical identifiers for documentation and tooling purposes.
- Breaking changes should create a new schema version rather than silently widening existing semantics.
