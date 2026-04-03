# 03. Policy Engine

## Working Thesis

The Policy Engine should be a deterministic decision system that evaluates a normalized `Action` and returns one of five outcomes:

- `allow`
- `deny`
- `ask`
- `simulate`
- `allow_with_snapshot`

Its job is not to be a vague “danger classifier.”
Its job is to turn product intent into enforceable runtime decisions that are:

- explainable
- composable
- durable across runs
- conservative when trust is low

## Why This Matters

If policy is mostly opaque scoring:

- users will not trust the system
- developers will not know why actions were blocked
- approvals will become noisy and inconsistent
- safe modes will feel fake

If policy is too rigid:

- the product becomes an approval wall
- autonomy stalls
- users bypass the system

So the policy engine should optimize for:

**deterministic control with explicit preconditions, and escalation only when needed**

## Research-Driven Design Constraints

### MCP puts consent and host control in the client/host layer

MCP’s architecture and tools specs are clear that:

- the host controls client permissions and lifecycle
- the host enforces security policies and consent requirements
- applications should keep a human in the loop for sensitive operations

Design implication:

- our policy engine belongs in the host-side authority layer
- consent is an explicit output of policy, not an afterthought

### Existing agent SDK guardrails are partial and surface-specific

OpenAI Agents SDK guardrails are useful, but official docs explicitly note that built-in execution tools and hosted tools do not all flow through the same guardrail pipeline as function tools.

Design implication:

- policy must operate on our canonical normalized action model
- it cannot depend on framework-native guardrails alone

### Approval needs to be durable

OpenAI HITL docs show that approvals can pause execution, serialize state, and resume later. Sticky allow/reject decisions can persist within a run.

Design implication:

- `ask` is not a UI state, it is a durable policy outcome
- policy outputs need stable IDs, reason codes, and resumable context

### Mature permission systems use ordered rules and hard precedence

Claude Code’s permission rules are straightforward:

- `deny`, `ask`, and `allow` rules exist
- rules are evaluated in order with deny first
- pre-tool hooks can still escalate or block before execution

Design implication:

- our engine should prefer explicit rule ordering and precedence over fuzzy conflict resolution

### Credential handling belongs in policy, not just execution

MCP elicitation guidance is explicit that third-party credentials should not transit through the client and that servers must manage them directly. OpenTelemetry guidance also warns against leaking secrets through propagated metadata.

Design implication:

- policy should be able to require brokered credentials
- direct-credential use on governed paths should be detectable and optionally forbidden

## Product Role

The Policy Engine translates:

- user intent
- safe mode presets
- workspace or org rules
- budget ceilings
- trust boundaries
- action hints

into a concrete execution decision and explanation.

## Non-Goals

- Replace snapshots, execution, or recovery
- Infer all risk with a single model score
- Hide uncertainty instead of surfacing it
- Make policy authoring resemble a full enterprise authorization language in v1

## Core Decision Model

### Decision enum

- `allow`
  - execution may proceed immediately
- `deny`
  - execution must not proceed
- `ask`
  - execution pauses pending a human or delegated approval decision
- `simulate`
  - run the safest available non-side-effecting or dry-run path
- `allow_with_snapshot`
  - execution may proceed only after the snapshot engine records a checkpoint

### Why `allow_with_snapshot` is first-class

This is the product’s differentiator.

Without it, policy degenerates into:

- allow
- deny
- annoy the user

`allow_with_snapshot` lets us preserve flow while still tightening blast radius.

## Decision Output Shape

The policy engine should emit a `PolicyOutcome` record separate from the `Action`.

Recommended fields:

```json
{
  "policy_outcome_id": "pol_01H...",
  "action_id": "act_01H...",
  "decision": "allow_with_snapshot",
  "reasons": [
    {
      "code": "FS_DESTRUCTIVE_WORKSPACE_MUTATION",
      "severity": "high",
      "message": "Workspace-destructive shell command requires a recoverable checkpoint."
    }
  ],
  "trust_requirements": {
    "wrapped_path_required": true,
    "brokered_credentials_required": false,
    "direct_credentials_forbidden": true
  },
  "preconditions": {
    "snapshot_required": true,
    "approval_required": false,
    "simulation_supported": false
  },
  "approval": null,
  "budget_effects": {
    "budget_check": "passed",
    "estimated_cost": null
  },
  "policy_context": {
    "matched_rules": [
      "safe-mode:filesystem.safe",
      "rule:workspace-destructive-needs-snapshot"
    ],
    "sticky_decision_applied": false
  },
  "evaluated_at": "2026-03-29T15:45:00Z"
}
```

## Inputs

The policy engine should consume:

- canonical `Action`
- run context
- workspace config
- user policy
- environment policy
- safe mode presets
- active budgets and usage counters
- trust metadata
- prior run decisions if they are validly reusable

## Policy Layers

The cleanest launch architecture is a layered evaluator with hard precedence.

### Layer 1. Boundary and trust checks

Questions:

- Is the action on a governed path?
- Is the provenance trustworthy enough for pre-execution control?
- Is the credential mode acceptable?
- Is the source integration trusted?

Typical outcomes:

- `deny` if the execution path violates a hard rule
- `ask` if trust is insufficient but user override is allowed
- continue otherwise

Examples:

- deny direct credentials on governed API adapter
- ask on untrusted MCP server with mutating tool call
- deny action marked `unknown` on a path that claims to be governed

### Layer 2. Hard ceilings

Questions:

- Would this exceed spend, runtime, token, or action ceilings?
- Has the run already exhausted a relevant quota?

Typical outcomes:

- `deny` when a hard ceiling is exceeded
- `ask` when a soft ceiling is crossed and escalation is allowed

Examples:

- deny if run exceeds maximum write operations
- ask if model-token ceiling is crossed but user policy allows override

### Layer 3. Explicit deny rules

These are the sharpest user or admin rules.

Examples:

- deny reading `.env`
- deny shell commands matching dangerous network egress
- deny payment actions in local mode
- deny browser actions outside approved origins

This layer should take precedence over lower-priority allow rules.

### Layer 4. Safe mode presets

Safe modes should translate product language into structured policy behavior.

Examples:

- `filesystem.safe`
  - allow reads
  - allow small writes
  - snapshot before destructive or recursive operations
  - ask for broad deletes

- `shell.safe`
  - allow read-only inspection commands
  - snapshot before likely workspace mutations
  - ask on commands with external effects or unknown scope

- `browser.safe`
  - allow navigation within approved origins
  - ask before form submit or download
  - deny or ask for credential entry depending on environment

### Layer 5. Domain-specific rules

This is where the policy uses:

- action `domain`
- `kind`
- target scope
- reversibility hints
- external effect hints
- sensitivity hints

Examples:

- `filesystem.delete` on `scope.breadth = workspace` => `allow_with_snapshot` or `ask`
- `email.send` => `ask`
- `mcp.tool_call` with `trusted_server = false` and mutating hints => `ask`
- `browser.submit` on payment origin => `deny` or `ask`

### Layer 6. Snapshot requirement synthesis

This layer determines when the action should become `allow_with_snapshot`.

This should generally win over plain `allow` when:

- the action is mutating
- it is likely recoverable
- scope is meaningful
- interruption is avoidable

### Layer 7. Approval synthesis

This layer determines when `ask` is necessary.

Use `ask` mainly for:

- irreversible actions
- external communications
- financial actions
- identity and security-sensitive actions
- low-trust or ambiguous actions where user intent matters more than automation

### Layer 8. Default allow or simulate

If no stronger layer applies:

- use `allow` for clearly safe governed actions
- use `simulate` when a dry-run path exists and the active safe mode prefers it

## Precedence Rules

The engine should use strict precedence:

1. `deny`
2. `ask`
3. `allow_with_snapshot`
4. `simulate`
5. `allow`

Why:

- hard blocks must dominate
- genuine consent requirements beat convenience
- recoverable autonomy should beat plain allow for risky-but-restorable actions
- simulation is useful, but only when a more direct safer path is not already required

## Rules Model

For v1, use a simple ordered rules model with structured predicates.

Recommended rule shape:

```json
{
  "id": "workspace-destructive-needs-snapshot",
  "priority": 300,
  "match": {
    "operation.domain": "shell",
    "risk_hints.side_effect_level": "destructive",
    "target.scope.breadth": ["workspace", "repository"]
  },
  "decision": "allow_with_snapshot",
  "reason_code": "FS_DESTRUCTIVE_WORKSPACE_MUTATION"
}
```

### Rule sources

- system defaults
- safe mode presets
- workspace policy
- user policy
- hosted org policy later

### Conflict strategy

- evaluate by source precedence, then numeric priority
- first terminal rule wins inside a given phase
- some phases only accumulate facts instead of deciding

## Safe Mode Presets

Presets are the product surface.
Internally they should compile to rules.

### Launch presets

- `filesystem.safe`
- `shell.safe`
- `browser.safe`
- `mcp.safe`

### Recommended v1 behavior

#### `filesystem.safe`

- allow reads
- allow small file writes in approved roots
- `allow_with_snapshot` on deletes, moves, recursive edits, broad refactors, and low-confidence recoverable local mutations
- ask on degraded capability or truly unrecoverable destructive operations

#### `shell.safe`

- allow common read-only commands
- `allow_with_snapshot` on likely workspace mutation commands, package manager/build/interpreter execution, and opaque local shell when AgentGit can establish recovery first
- ask on consent or irreversibility boundaries, degraded capability, and untrusted external effects
- deny commands matching explicit deny patterns

#### `browser.safe`

- allow navigation and inspection on approved origins
- ask on submit, download, upload, or auth-sensitive interactions
- deny clearly disallowed origins or payment submissions if policy forbids them

#### `mcp.safe`

- allow trusted read-only servers
- ask on untrusted mutating tools
- require brokered credentials where applicable

## Budget And Ceiling Model

The engine should treat ceilings as first-class policy inputs, not bolt-ons.

### Launch budget categories

- runtime duration
- model tokens
- estimated spend
- number of side-effecting actions
- number of approval escalations

### Ceiling types

- `hard`
  - causes `deny`
- `soft`
  - causes `ask`
- `informational`
  - logs only for now

### Decision examples

- hard token limit exceeded => `deny`
- spend nearing monthly threshold => `ask`
- too many side-effecting actions in one run => `ask` or `deny` depending on config

## Approval Model

`ask` should produce a durable approval task with enough information to resume later.

Recommended approval record:

- `approval_id`
- `policy_outcome_id`
- `action_id`
- `reason_codes`
- `approval_kind`
- `display_payload`
- `expires_at` optional
- `sticky_scope`

### Approval kinds

- `one_time`
- `run_sticky`
- `session_sticky`
- `policy_update_suggested`

The OpenAI HITL model is a strong reference here:

- paused runs serialize durable state
- approvals can be resumed later
- sticky decisions can persist within a run

Our system should support the same pattern even if the host framework does not provide it for us automatically.

## Simulation Model

`simulate` should only be returned when a meaningful non-side-effecting path exists.

Examples:

- shell command rewritten to `git diff --name-only` or dry-run mode if explicitly supported
- API adapter supports preview or validation mode
- filesystem plan can be produced without writing

Do not fake simulation when it is only a guess.

## Explainability

Every decision should be explainable from structured data.

Required explanation fields:

- `reason_code`
- human-readable message
- matched rule IDs
- trust/budget/snapshot/approval preconditions

This is what lets the timeline helper answer:

- why was this asked?
- why was this denied?
- why did this get a snapshot instead of a prompt?

## Reason Codes

Reason codes should be stable and enumerable.

### Launch examples

- `PATH_NOT_GOVERNED`
- `DIRECT_CREDENTIALS_FORBIDDEN`
- `BUDGET_HARD_LIMIT_EXCEEDED`
- `BUDGET_SOFT_LIMIT_REQUIRES_APPROVAL`
- `UNKNOWN_SCOPE_REQUIRES_APPROVAL`
- `UNTRUSTED_SERVER_MUTATION`
- `FS_DESTRUCTIVE_WORKSPACE_MUTATION`
- `IRREVERSIBLE_EXTERNAL_COMMUNICATION`
- `PAYMENT_ACTION_REQUIRES_APPROVAL`
- `TRUSTED_READONLY_ALLOWED`

## Interaction With Other Subsystems

### Action Normalizer

Consumes:

- provenance
- execution path
- credential mode
- scope
- risk hints

### Snapshot Engine

Receives:

- `snapshot_required`
- snapshot reason codes
- optional snapshot boundary hints

### Execution Adapters

Receives:

- final decision
- trust requirements
- brokered-credential requirements

### Run Journal

Receives:

- full `PolicyOutcome`
- rule matches
- approval task creation

## Main Risks

### 1. Overfitting to known tools

If rules only work for shell and filesystem, the engine becomes brittle.

Mitigation:

- base policy on canonical action fields first
- use domain facets only for additional refinement

### 2. Too much policy magic

If we hide too much in a score, debugging becomes impossible.

Mitigation:

- deterministic phases
- stable reason codes
- explicit rule matches

### 3. Approval sprawl

If too many actions become `ask`, the product loses its point.

Mitigation:

- bias toward `allow_with_snapshot` for recoverable risks
- reserve `ask` for true consent or irreversibility boundaries

### 4. Unsafe reuse of previous decisions

Sticky approvals can accidentally over-authorize.

Mitigation:

- scope sticky approvals carefully
- tie them to tool, action kind, and run/session boundaries

## Proposed Build Order

1. Define `PolicyOutcome` schema and reason-code registry
2. Implement the layered evaluation pipeline
3. Implement trust-path checks, including governed-path and credential-mode rules
4. Implement hard and soft ceilings
5. Implement launch safe mode presets
6. Add snapshot synthesis rules
7. Add approval task creation and sticky-decision support
8. Add simulation support where adapters can honor it

## Concrete Recommendation

For v1, the policy engine should optimize for one thing:

**be boring in the best way possible: deterministic, explainable, and biased toward recoverable autonomy instead of constant interruption**

That is the policy behavior that best matches the product you actually want to build.

## Research Inputs

- MCP architecture: <https://modelcontextprotocol.io/specification/2025-06-18/architecture>
- MCP tools: <https://modelcontextprotocol.io/specification/2025-03-26/server/tools>
- MCP elicitation: <https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation>
- OpenAI Agents guardrails (Python): <https://openai.github.io/openai-agents-python/guardrails/>
- OpenAI Agents HITL (Python): <https://openai.github.io/openai-agents-python/human_in_the_loop/>
- OpenAI Agents guardrails (JS): <https://openai.github.io/openai-agents-js/guides/guardrails/>
- Claude Code settings: <https://code.claude.com/docs/en/settings>
- Claude Code hooks: <https://code.claude.com/docs/en/hooks>
- Claude Code authentication and credential handling: <https://code.claude.com/docs/en/team>
