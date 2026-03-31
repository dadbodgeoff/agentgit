# Schema Pack Examples

This folder contains grouped example fixtures and linked trace bundles for the canonical schema pack.

## Layout

- `valid/`
  - grouped valid examples for each schema
- `invalid/`
  - grouped invalid examples for each schema
- `traces/`
  - end-to-end record bundles with cross-schema links
- `validate_examples.py`
  - validates schema compliance and trace referential integrity

## Coverage

Each core schema has:

- `happy_path`
- `edge_case`
- `minimal_valid`

and:

- `missing_required`
- `wrong_type`
- `invalid_enum_or_const`

The trace bundles cover:

- simple file write
- destructive shell command
- untrusted MCP tool call
- denied action
- failed execution with recovery
- imported or observed action

## Run Validation

```bash
python3 engineering-docs/schema-pack/examples/validate_examples.py
```
