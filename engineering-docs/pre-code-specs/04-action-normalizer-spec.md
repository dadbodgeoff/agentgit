# 04. Action Normalizer Spec

## Scope

This document resolves scope inference, redaction, mapper behavior, confidence, and warning semantics.

## Scope Inference

- Shell:
  - static pattern analysis first
  - command/subcommand matchers
  - conservative fallback to `unknown`
- Filesystem:
  - exact path, glob, recursive, or unknown
- Opaque commands like `python script.py` default to `unknown` unless wrapper provides stronger intent

## Estimated Count

- integer when concrete or estimable
- omitted/null when genuinely unknown

## Unknowns

- stored as array of unknown dimensions
- examples:
  - `scope`
  - `target_count`
  - `external_side_effects`

## Redaction

- Detection:
  - known-format regexes
  - header/env key-name heuristics
  - entropy fallback for suspicious long tokens
- Candidates:
  - command args
  - env vars
  - request bodies
  - headers
  - browser form values
- Marker format:
  - `[REDACTED:<kind>]`
- Redacted values are not recoverable from journaled records

## Mapper Model

- In-process registry
- Explicit versions like:
  - `shell/v1`
  - `filesystem/v1`
  - `mcp/v1`
  - `function/v1`
  - `browser/v1`
- Fallback:
  - low-confidence generic action with unknown scope

## Confidence

- Inputs:
  - tool type clarity
  - target extraction success
  - scope certainty
  - mapper parse success
- Thresholds:
  - `>= 0.8` high
  - `0.5 - 0.79` medium
  - `< 0.5` low
  - `< 0.3` effectively unknown for risky policy decisions

## Warnings

Launch taxonomy:

- `unknown_scope`
- `partial_parse`
- `untrusted_metadata`
- `possible_secret_redacted`
- `opaque_execution`
- `capability_assumption`
