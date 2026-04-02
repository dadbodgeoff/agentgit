# 15. Policy Hardening And Calibration Spec

## Scope

This document resolves:

- the default policy pack for `agentgit`
- layered policy configuration and binding semantics
- enforcement-mode rollout behavior
- snapshot-class selection refinement
- confidence telemetry and calibration rules
- implementation ownership by package

This spec is additive to:

- `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/pre-code-specs/03-policy-engine-spec.md`
- `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/pre-code-specs/05-snapshot-engine-spec.md`

## Normative Decisions

### 1. Execution-time authority

The in-repo policy engine remains the canonical execution-time evaluator.

Rules:

- the daemon must not depend on an external policy service for local execution correctness
- external policy frameworks may be added later only as an authoring/import layer, not as a replacement for the local evaluator
- all runtime decisions must still compile down to the current `PolicyOutcome` model

### 2. Decision model

The supported runtime decision set remains:

- `allow`
- `deny`
- `ask`
- `allow_with_snapshot`

`simulate` remains a schema-level concept but is not part of the hardening milestone unless a real adapter-specific simulation path exists.

### 3. Enforcement mode model

Durable rules must support a separate enforcement mode:

- `audit`
- `warn`
- `require_approval`
- `enforce`
- `disabled`

Rules:

- enforcement mode does not replace policy decision
- `enforce` uses the rule’s compiled decision directly
- `require_approval` upgrades `allow` and `allow_with_snapshot` to `ask`
- `warn` records a warning but does not strengthen a `deny`
- `audit` records evaluation only
- `disabled` skips the rule

### 4. Layer precedence

Durable policy configuration precedence:

1. platform defaults
2. operator/system policy
3. workspace policy
4. workspace local override
5. runtime/session overrides

Monotonic restriction rule:

- no lower-precedence layer may weaken a higher-precedence deny

### 5. Config format

Launch config format for durable policy files:

- TOML v1.0.0

Validation:

- JSON Schema Draft 2020-12

### 6. Default policy pack

The first explicit default policy pack must reflect local-first coding-agent workflows.

#### `allow`

- governed read-only filesystem operations
- read-only shell inspection
- trusted read-only MCP tools

#### `allow_with_snapshot`

- recoverable local filesystem mutation
- destructive local file operations within governed roots
- compensatable owned-function mutations
- risky but bounded local shell mutations

#### `ask`

- low-confidence normalization below a configured action-family threshold
- package manager commands
- opaque interpreter execution
- public mutating MCP
- external or user-consent-boundary actions
- broad local destructive operations where reversibility exists but blast radius is high

#### `deny`

- direct credential use on governed paths
- governed path escape
- secret-file reads from protected locations
- agent policy/config tampering surfaces
- MCP trust-boundary violations
- unsupported execution surfaces that claim governed semantics

### 7. Snapshot selection contract

The daemon must stop picking snapshot class with a simple domain-only heuristic.

Snapshot class selection inputs must include:

- policy decision
- action risk hints
- action scope breadth and certainty
- reversibility hint
- operation family
- capability state
- storage pressure
- journal chain depth
- explicit checkpoint/branch-point flags

Final snapshot class outputs:

- `metadata_only`
- `journal_only`
- `journal_plus_anchor`
- `exact_anchor`

### 8. Confidence hardening

Confidence remains advisory unless explicitly compiled into a policy rule.

Rules:

- live runtime may tighten thresholds automatically only if configured to do so and only toward safer outcomes
- live runtime may not relax thresholds automatically
- threshold relaxation requires explicit human review and policy version bump
- confidence calibration must be based on logged operator outcomes, not only on model self-reported certainty

## Durable Policy File Shape

Recommended top-level sections:

- `policy_version`
- `[defaults]`
- `[thresholds]`
- `[bindings]`
- `[[rules]]`
- `[snapshots]`
- `[confidence]`

### `[[rules]]` required fields

- `rule_id`
- `description`
- `rationale`
- `scope`
- `decision`
- `enforcement_mode`
- `priority`
- `match`

Optional:

- `references`
- `reason_code`
- `snapshot_hint`
- `expires_at`

## Snapshot Decision Matrix

### `metadata_only`

Use when:

- action is read-only
- action is non-filesystem and compensatable
- action is an approval-prep boundary without local rollback promise

### `journal_only`

Use when:

- mutation is narrow and known-scope
- touched files are mostly text/code/config
- reverse patch or small preimage is sufficient

### `journal_plus_anchor`

Use when:

- mutation is recoverable but scope is medium-risk
- delete/rename/broad edit affects governed paths
- shell command is mutating and partially uncertain

This should become the standard `allow_with_snapshot` default for risky local coding actions.

### `exact_anchor`

Use when:

- action is a major branch point
- broad uncertainty exists
- package manager or build tooling can mutate many files unpredictably
- operator explicitly requests a hard checkpoint

## Confidence Telemetry Requirements

Each decision event should record:

- action family
- normalization confidence
- matched rule IDs
- final decision
- whether approval was requested
- whether approval was granted or denied
- snapshot class chosen
- whether recovery was later invoked

Suggested storage path:

- journaled event payload plus calibration/export views later

## Testing Requirements

### Policy invariants

Add invariant coverage for:

- deny precedence
- monotonic layering
- total decision coverage
- no weakening of platform denies by workspace or runtime overrides

### Snapshot invariants

Add invariant coverage for:

- `allow_with_snapshot` always creates a snapshot before execution
- selected snapshot class is valid for the action family
- irreversible external actions never pretend to be reversible via local snapshot alone

### Calibration invariants

Add invariant coverage for:

- automatic threshold tightening can only move toward `ask`/`deny`, never toward `allow`
- relaxed thresholds require explicit durable config change

## Implementation Checklist

### Package: `packages/schemas`

Add:

- durable policy rule schema
- enforcement mode schema
- policy binding/config schema
- snapshot selection input/output schema
- confidence calibration record schema

### Package: `packages/policy-engine`

Implement:

- rule-pack loading and deterministic compilation
- layered merge with monotonic restriction
- explicit deny-first precedence by rule priority
- enforcement-mode handling
- durable default coding-agent policy pack

### Package: `packages/action-normalizer`

Refine:

- action-family labeling for calibration buckets
- confidence metadata that is stable enough for reporting
- warnings that map cleanly to policy reason codes

### Package: `packages/snapshot-engine`

Implement:

- formal snapshot selection function
- branch-point and broad-scope triggers
- stronger mapping from action family to snapshot class
- explicit external-irreversibility annotations

### Package: `packages/authority-daemon`

Implement:

- policy file discovery and layering
- diagnostics exposure for active policy sources and overrides
- journal events for matched rule IDs, enforcement mode, and snapshot selection basis
- operator-facing inspection APIs for effective policy and compiled defaults

### Package: `packages/run-journal`

Add:

- structured policy-evaluation exports for calibration
- immutable linkage between approvals and confidence-bearing decisions

### Package: `packages/authority-cli`

Implement:

- `policy show`
- `policy validate`
- `policy explain`
- `policy diff`
- `policy calibration-report`

### Package: `packages/authority-sdk-ts`

Add:

- typed accessors for effective policy, policy explanation, and calibration reports

### Package: `packages/authority-sdk-py`

Add:

- parity accessors for policy explanation and reporting endpoints

## Recommended Delivery Sequence

1. schemas for rule/config/enforcement mode
2. default policy pack and layered merge logic
3. daemon policy loading plus diagnostics visibility
4. snapshot selection refinement
5. CLI inspection/validation tools
6. calibration export/reporting
7. threshold-hardening workflow and invariant tests

## Exit Criteria

This hardening slice is complete when:

- the product has an explicit default policy pack in versioned config
- policy precedence and deny invariants are enforceable and tested
- snapshot class selection is driven by a formal decision matrix
- operators can inspect effective policy and overrides
- confidence data is exportable and calibration-ready
- threshold relaxation is impossible without explicit human-reviewed config changes
