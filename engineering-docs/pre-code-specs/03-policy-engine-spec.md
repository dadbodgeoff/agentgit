# 03. Policy Engine Spec

## Scope

This document resolves the concrete policy-engine behavior, rule model, budgets, approvals, simulation, and reason-code policy.

## Predicate Language

- Structured JSON/TOML predicates
- Regex is an operator, not a freeform language
- Supported operators:
  - `eq`, `neq`, `matches`, `contains`, `gt`, `gte`, `lt`, `lte`, `in`, `not_in`, `exists`
- Composition:
  - `all`, `any`, `not`
- Max nesting depth: **5**

## Rule Evaluation

- Deterministic layered evaluator
- Source precedence:
  - system defaults
  - safe-mode compiled rules
  - user config
  - workspace config
  - runtime override
- Decision precedence:
  - `deny`
  - `ask`
  - `allow_with_snapshot`
  - `simulate`
  - `allow`

## Safe Modes

- `filesystem.safe`
  - small write threshold: **256 KB per file**
  - auto-allow up to **20 touched files**
- `shell.safe`
  - read-only commands limited to explicit allowlist
- `browser.safe`
  - allow navigation/inspection on approved origins
  - ask on submit/upload/download/auth entry
- `mcp.safe`
  - allow trusted read-only tools
  - ask on untrusted or mutating tools

## Budgets

- Side-effecting action:
  - any action with `side_effect_level != read_only` or non-`none` external effect
- Granularity:
  - per-run primary
  - optional rolling window for spend/tokens
- Enforcement:
  - `informational`
  - `soft_limit`
  - `hard_limit`

## Approvals

- Sticky scopes:
  - `one_time`
  - `run_sticky`
  - `session_sticky`
  - `pattern_sticky`
- Approval state is canonical in the journal
- Fast lookup lives in projection/state store

## Simulation

- Registered per adapter/action kind
- Unsupported simulation falls back to `ask` or `deny`

## Reason Codes

Key categories:

- trust
- budget
- scope
- reversibility
- safe-mode
- capability
- credential
- externality

Examples:

- `PATH_NOT_GOVERNED`
- `LOW_NORMALIZATION_CONFIDENCE`
- `DIRECT_CREDENTIALS_FORBIDDEN`
- `UNTRUSTED_SERVER_MUTATION`
- `UNKNOWN_SCOPE_REQUIRES_APPROVAL`
- `FS_DESTRUCTIVE_WORKSPACE_MUTATION`
- `IRREVERSIBLE_EXTERNAL_COMMUNICATION`
- `BUDGET_HARD_LIMIT_EXCEEDED`
