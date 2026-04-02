# 10. Policy Hardening And Defaults

## Working Thesis

`agentgit` should harden the policy system it already has before introducing an external policy framework.

That means:

- the in-repo policy engine remains the canonical execution-time authority
- operator-facing policy config becomes explicit, layered, and monotonic
- snapshot selection becomes a first-class decision matrix instead of a small set of inline heuristics
- confidence scoring remains advisory until it is calibrated by real operator feedback

The right near-term goal is:

**turn the current policy engine from deterministic code paths into a deterministic policy product**

## Why This Matters

Right now the repo has real enforcement:

- normalized actions carry confidence and risk hints
- policy returns `allow`, `deny`, `ask`, or `allow_with_snapshot`
- the daemon enforces snapshot preconditions and approval boundaries

What is still missing is the durable, inspectable intent surface around those mechanics:

- a codified default policy pack for the product
- a clean operator configuration and override model
- a snapshot-tier selection contract that matches action reversibility and blast radius
- a confidence-calibration loop that reduces unnecessary approvals without weakening hard boundaries

Without that next layer:

- the code works, but the product stance is still partly implicit
- operator trust is lower than it should be
- it is hard to explain exactly why one action auto-runs and another escalates
- public launch claims stay behind the actual technical capability

## Primary Runtime Context

This repo should optimize policy defaults for:

- local-first coding-agent workflows
- governed MCP execution
- operator-managed and enterprise-controlled autonomous execution

This is not a generic “any agent can do anything” platform.
The correct defaults should reflect a coding and tool-execution runtime where:

- read-only inspection should flow easily
- recoverable local mutations should usually become `allow_with_snapshot`
- external or ambiguous effects should become `ask`
- trust-boundary violations should become `deny`

## Non-Goals

- replacing the in-repo engine with OPA, Cedar, or another external evaluator now
- turning policy authoring into a large general-purpose authorization language in the next slice
- using online exploration logic to relax safety thresholds automatically
- treating local snapshots as if they can reverse irreversible external side effects

## Core Position

### Keep the policy engine local and deterministic

The current policy engine in:

- `/Users/geoffreyfernald/Documents/agentgit/packages/policy-engine/src/index.ts`

should remain the execution-time source of truth.

Why:

- it already understands the normalized action model
- it is already wired into journaling, approvals, recovery, and MCP trust checks
- it is easier to test deterministically than an external policy service
- it avoids split-brain authority between local runtime code and external policy interpretation

External frameworks such as OPA or Cedar may become useful later for:

- enterprise policy administration
- hosted control-plane consistency across multiple products
- delegated policy authoring outside the repo

But that should be a later adapter layer, not the next implementation step.

### Treat `allow_with_snapshot` as a product primitive

This repo already has the right abstraction:

- `allow`
- `deny`
- `ask`
- `allow_with_snapshot`

This should remain the central model.

The missing refinement is not a new decision enum.
The missing refinement is:

- clearer default rule packs
- clearer snapshot class selection under `allow_with_snapshot`
- better operator explanation of why that outcome was chosen

### Separate decision outcome from enforcement mode

The product should keep policy decision and rollout/enforcement mode separate.

Decision answers:

- what should happen for this action?
- `allow`, `deny`, `ask`, `allow_with_snapshot`

Enforcement mode answers:

- how hard should this rule be applied today?
- `audit`
- `warn`
- `require_approval`
- `enforce`
- `disabled`

This gives the repo a clean rollout path for new policies without weakening the underlying decision model.

## Default Policy Direction

### Hard invariants

These should become non-overridable platform rules:

- no direct credentials on governed paths
- no agent mutation of agent config and authority config surfaces
- no secret file reads from known credential locations
- no execution outside governed roots without explicit non-governed handling
- no override of trust-boundary denies for MCP candidate execution, revoked profiles, quarantined profiles, or disallowed execution modes

### Product defaults

The first durable default policy pack should optimize for coding-agent workflows:

- `allow`
  - governed read-only filesystem actions
  - read-only shell inspection
  - trusted read-only MCP tools
- `allow_with_snapshot`
  - recoverable local file mutations
  - compensatable owned integration mutations
  - destructive-but-recoverable local shell mutations
- `ask`
  - package manager commands
  - opaque or low-confidence shell commands
  - public mutating MCP
  - external side effects that cross user consent boundaries
- `deny`
  - hard trust violations
  - secret access
  - config tampering
  - non-governed path mutation
  - impossible or unsupported execution surfaces

## Config Layering

The repo already points toward TOML-based layered config in:

- `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/support-architecture/06-config-and-policy-surface.md`

This policy-hardening slice should refine that into a monotonic hierarchy:

1. platform defaults
2. system/operator policy
3. workspace policy
4. workspace local override
5. runtime/session overrides

Rule:

- lower layers may add restrictions
- lower layers may add allow rules only where no higher-precedence deny blocks them
- lower layers may not weaken higher-precedence deny rules

The effective permission should be:

- intersection of allows
- minus union of denies

## Snapshot Strategy Tailored To This Repo

The snapshot engine already supports:

- `metadata_only`
- `journal_only`
- `journal_plus_anchor`
- `exact_anchor`

The next step is not inventing snapshot tiers.
It is defining when each one is chosen in `agentgit`.

### Product stance

- `metadata_only`
  - read-only or compensatable/non-filesystem actions where full file rollback is unnecessary
- `journal_only`
  - narrow, known-scope text/code changes
- `journal_plus_anchor`
  - the default for risky local workspace mutation
- `exact_anchor`
  - reserved for major branch points, broad uncertainty, or explicit operator checkpoint requests

### Important boundary

External irreversible actions should not rely on local snapshot semantics alone.

For those actions the system should use:

- approval gate
- evidence capture
- compensating plan if available
- explicit operator-facing irreversibility reason

## Confidence Calibration Direction

The repo already has heuristic confidence in the normalizer.

That should evolve through:

1. logging confidence, action kind, policy decision, and final operator outcome
2. offline calibration reports per action family
3. conservative threshold tightening based on observed safety
4. explicit human approval before relaxing any threshold

This repo should not allow automated threshold relaxation in live enforcement.

The right invariant is:

- automation may tighten
- humans must approve relaxation

## Auditability

Policy maturity should improve auditability, not reduce it.

Each durable rule should eventually carry:

- rule ID
- version
- rationale
- scope/binding source
- enforcement mode

Each policy decision event should remain journaled with:

- matched rule IDs
- decision outcome
- snapshot requirement
- approval requirement
- confidence context
- budget effects

## Recommended Implementation Order

1. codify the default policy pack
2. expose layered policy config and binding
3. refine snapshot class selection
4. add enforcement-mode rollout semantics
5. add confidence telemetry and offline calibration tooling
6. add stronger policy invariants and regression tests

## Bottom Line

The repo does not need a new policy philosophy.
It needs to formalize and harden the good structure it already has.

The next milestone should be:

**explicit default rules, monotonic config layering, snapshot-tier selection, and confidence calibration without surrendering deterministic control**
