# Approval-Light Automation R&D

Status date: 2026-04-03 (America/New_York)

Owner: AgentGit core

## Purpose

Evaluate whether AgentGit should move away from approval-heavy execution toward an automated monitoring and recovery model, and define the healthiest repo-native path to do that without weakening the real safety boundary.

This note answers one core question:

**Should AgentGit usually auto-run recoverable risky work and involve humans only when recovery or execution confidence breaks down?**

## Executive Summary

Yes, with one important guardrail:

- this is healthier in contained and governed paths
- it is not healthy to become observability-only after the fact on a real mutable workspace

The best design is not:

- approve everything before it runs
- or let everything run first and hope monitoring can save us later

The healthiest design for this repo is:

1. auto-run safe work
2. auto-run recoverable risky work behind automatic recovery boundaries
3. use contained execution to defer publication decisions where possible
4. involve humans only when:
   - recovery is not trustworthy
   - execution capability is degraded
   - side effects are external and not reliably compensatable
   - publication or restore conflicts cannot be resolved safely
   - the runtime itself is failing

That means the product should move toward:

- fewer `ask` outcomes
- more automatic `allow_with_snapshot`
- stronger contained execution defaults for risky runs
- explicit escalation only for genuinely unrecoverable or degraded situations

## Why This Direction Is Healthier

### It removes toil instead of productizing it

Google SRE’s guidance on toil is directly relevant here: if a human needs to touch the system during normal operation, that is a bug in the system design, not a success condition. AgentGit should not normalize frequent approval interruptions as its core operating mode. [Google SRE: Eliminating Toil](https://sre.google/sre-book/eliminating-toil/)

### It matches the repo’s existing recovery-first shape

The repo already has the correct conceptual primitive:

- `allow`
- `allow_with_snapshot`
- `ask`
- `deny`

The architecture is already closer to recovery-first than approval-first:

- the daemon owns snapshots, journaling, recovery planning, and execution dispatch
- the policy engine already distinguishes recoverable work from approval-gated work
- the runtime integration layer already has contained execution and governed publish-back

Relevant repo docs already point in this direction:

- [/Users/geoffreyfernald/Documents/agentgit/engineering-docs/support-architecture/10-policy-hardening-and-defaults.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/support-architecture/10-policy-hardening-and-defaults.md)
- [/Users/geoffreyfernald/Documents/agentgit/engineering-docs/support-architecture/01-runtime-architecture.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/support-architecture/01-runtime-architecture.md)
- [/Users/geoffreyfernald/Documents/agentgit/engineering-docs/01-agent-wrapper-sdk/README.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/01-agent-wrapper-sdk/README.md)

### It aligns with real distributed-systems recovery patterns

When systems cross multiple steps or resources, the healthiest pattern is usually not blocking human input before every step. It is:

- record enough information to compensate
- make compensating steps idempotent
- escalate only when automated compensation fails or cannot be trusted

That is consistent with both compensating transaction guidance and saga orchestration:

- [Microsoft Learn: Compensating Transaction pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction)
- [AWS Prescriptive Guidance: Saga orchestration pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/saga-orchestration.html)

## Current Repo State

The repo is already partially aligned with approval-light automation.

### What is already healthy

- Filesystem deletes already become `allow_with_snapshot`
- Large governed filesystem writes already become `allow_with_snapshot`
- Compensatable owned function mutations already become `allow_with_snapshot`
- Trusted compensatable generic function mutations already become `allow_with_snapshot`
- Contained execution already protects the real workspace and shifts risk to governed publish-back
- Restore and inspect already surface recovery boundaries and degrade honestly

### What is still too approval-heavy

Current policy still uses `ask` by default for several shell and external categories:

- package manager commands
- build tool commands
- interpreter execution
- unclassified shell commands
- mutating MCP tools
- capability-stale but potentially recoverable cases

Files:

- [/Users/geoffreyfernald/Documents/agentgit/packages/policy-engine/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/policy-engine/src/index.ts)
- [/Users/geoffreyfernald/Documents/agentgit/packages/policy-engine/src/default-policy-pack.ts](/Users/geoffreyfernald/Documents/agentgit/packages/policy-engine/src/default-policy-pack.ts)

### Why current approval behavior exists

It is mostly compensating for uncertainty, not expressing a philosophical belief that humans should approve everything.

The current `ask` outcomes are doing several jobs at once:

- low confidence fallback
- capability degradation fallback
- external side-effect consent gate
- shell opacity fallback
- unsupported or weakly compensatable execution fallback

That is the key design smell.

`ask` is overloaded.

## The Healthier Target Model

The cleanest future model is to split runtime outcomes by **recoverability**, not by whether a human is present.

### 1. Allow

Definition:

- safe enough to run immediately
- no extra recovery boundary required

Examples:

- read-only inspection
- narrow trusted local reads
- trusted read-only MCP
- small governed safe writes where the system explicitly chooses to accept low rollback overhead

### 2. Allow With Recovery Boundary

Definition:

- risky, but recoverable with high confidence
- should auto-run
- must create or verify a recovery boundary automatically
- should not pause for human approval

Examples:

- local file delete
- large file write
- refactor touching many files
- broad but contained workspace mutation
- compensatable owned integration mutation
- destructive shell mutation when preimage or containment is available

This should become the dominant path for risky local work.

### 3. Allow In Containment, Decide At Publication Time

Definition:

- let the agent continue without interruption inside a controlled projection
- score the resulting diff or side effects later
- auto-publish safe results
- hold only unsafe publication cases

Examples:

- contained generic shell runs
- broad refactors
- toolchains that are opaque before execution but inspectable after execution in projection

This is the best place to support your “monitor first, then decide” instinct.

### 4. Escalate

Definition:

- human involvement is required only because the system cannot honestly continue automatically

Escalation reasons should be narrow:

- no trustworthy recovery boundary exists
- a required compensator does not exist
- capability is degraded or stale and cannot be refreshed safely
- the action crosses a real user-consent boundary
- the runtime or daemon is failing
- publication conflict would overwrite later user work

## The Critical Guardrail

Your instinct becomes unhealthy if we apply it uniformly to attached direct execution.

### In attached mode

For real workspace destructive actions, AgentGit often must capture recovery state **before** the mutation.

Why:

- if the agent deletes or overwrites a file in the real workspace first, the preimage may be gone
- a snapshot taken after the fact cannot restore what was already lost

So in attached mode, the healthy rule is:

- automate aggressively
- but still capture recovery boundaries before destructive local side effects

### In contained mode

The healthiest rule is different:

- let the agent act freely in projection
- observe the resulting state and diff
- decide whether to publish, checkpoint, or hold

That is the right place for “monitor changes in real time and then act.”

## Repo-Native Design Change

The main design shift should be:

**replace many current approval paths with automatic reversible execution paths**

### Decision semantics should become:

- `allow`
  - safe
- `allow_with_snapshot`
  - risky but recoverable
- `deny`
  - trust violation or unsupported execution
- `escalate`
  - only for genuinely unrecoverable or degraded situations

The repo currently uses `ask` where this memo says `escalate`.

We do not necessarily need to rename the schema immediately.
But conceptually, that is what should happen.

## What Should Trigger Human Escalation

Humans should stay in the loop only when at least one of these is true:

### 1. Recovery is not trustworthy

- metadata-only only, no meaningful reversal
- shell action is too opaque and not contained
- no preimage and no compensator
- restore target is ambiguous

### 2. Capability is degraded

- workspace access unavailable
- brokered credential capability unavailable
- backend stale and not refreshable
- contained backend unavailable

### 3. External effects are not safely compensatable

- public or third-party mutations with no compensator
- side effects that may spend money
- outbound operations crossing clear user-consent boundaries
- mutating MCP where the system cannot guarantee undo

### 4. Runtime failure

- daemon communication failure
- snapshot creation failure
- execution adapter failure before trustworthy state capture
- publication failure with unresolved conflict

## Concrete Policy Direction

### Filesystem

Keep:

- destructive local mutations -> `allow_with_snapshot`
- large writes -> `allow_with_snapshot`

Potential change:

- small governed writes that are currently `allow` could optionally become `allow_with_snapshot` under strict or contained-first policies if we want a stronger default recovery story

### Shell

Current shell policy is the main area to redesign.

#### Previously

- read-only shell -> `allow`
- filesystem primitive / version-control mutating -> `allow_with_snapshot`
- package manager -> `ask`
- build tool -> `ask`
- interpreter -> `ask`
- unclassified shell -> `ask`

#### Better target

- known local mutating shell with strong workspace boundary -> `allow_with_snapshot`
- package manager -> `allow_with_snapshot` when AgentGit can establish recovery first
- build tool -> `allow_with_snapshot` when AgentGit can establish recovery first
- interpreter -> `allow_with_snapshot` when AgentGit can establish recovery first
- unclassified shell in attached mode -> keep cautious, but prefer stronger checkpointing over immediate approval if a reliable boundary exists
- shell that crosses clear consent or irreversibility boundaries -> `ask`

This is where contained execution becomes the unlock.

### Functions

Owned functions with trusted compensators should continue moving toward automatic `allow_with_snapshot`.

Humans should only appear when:

- brokered credentials are unavailable
- compensator is missing
- capability is degraded

### MCP

This is the hardest category.

For MCP, the rule should become:

- read-only trusted MCP -> `allow`
- mutating MCP with strong trusted compensator and governed credential path -> `allow_with_snapshot`
- mutating MCP without strong compensation or trust guarantees -> escalate

That means the repo should stop treating all mutating MCP tools as a single approval bucket.

## Best-Of-Breed Architecture For This Repo

If we were designing this as the best engineer in the world inside this codebase, I would choose:

### A. Keep one local authority daemon

Do not split decision authority.

The daemon should remain the place that:

- classifies actions
- decides boundary strength
- coordinates snapshots and checkpoints
- dispatches execution
- decides publication or recovery

### B. Shift from approval-first to recoverability-first

The policy engine should ask:

1. Is this trusted?
2. If not fully trusted, is it still recoverable?
3. If recoverable, can we establish the boundary automatically?
4. If yes, run automatically.
5. Only escalate when the answer to 3 is no.

### C. Make containment the preferred path for opaque risky work

Contained execution is how we preserve automation without sacrificing reversibility.

This is especially true for:

- package managers
- build tools
- interpreter-launched scripts
- broad shell workflows

### D. Treat publication as the approval replacement

For contained flows, the publication step should become the main safety point, not pre-execution approval.

The decision becomes:

- auto-publish
- auto-checkpoint and publish
- hold because publication is unsafe

That is a much healthier control plane than asking humans to approve speculative actions up front.

### E. Keep escalation sparse and explicit

The product should communicate:

- “AgentGit handled this automatically and kept a restore point”
- “AgentGit held this because recovery or publication was not trustworthy”

Not:

- “Please approve this because it looks scary”

## Recommended Migration Plan

### Phase A: Formalize escalation philosophy

Changes:

- introduce a repo-level principle:
  - humans are for unrecoverable or degraded situations, not routine recoverable risk
- update docs and TDD language to reflect approval-light automation

### Phase B: Split shell policy into attached-safe vs contained-safe

Changes:

- treat package manager, build tool, interpreter, and unclassified shell differently depending on assurance and containment
- downgrade many current shell `ask` cases into:
  - attached `allow_with_snapshot`
  - or contained auto-run

Status:

- the core governed shell policy now auto-snapshots package manager, build tool, interpreter, opaque shell, and low-confidence local shell execution when recovery is trustworthy
- explicit approval is retained for degraded capability and consent/irreversibility boundaries

Primary files:

- [/Users/geoffreyfernald/Documents/agentgit/packages/policy-engine/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/policy-engine/src/index.ts)
- [/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/service.ts](/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/service.ts)

### Phase C: Add explicit “recoverable but opaque” class in policy implementation

This can be done without changing the external decision enum immediately.

Meaning:

- internally distinguish:
  - safe allow
  - recoverable automatic
  - unrecoverable escalate

Implementation options:

- keep `ask` externally but narrow its use sharply
- or add a new decision later if schema churn is justified

### Phase D: Publication gating for contained runs

Changes:

- treat contained publish-back as the main control point for opaque risky work
- score publication conflict, overwrite risk, and reversibility there
- auto-publish by default when safe

### Phase E: Approval inbox becomes exception inbox

Changes:

- approval UI and CLI shift toward:
  - execution degraded
  - recovery unavailable
  - publication conflict
  - external irreversible side effect

That keeps the UX aligned with the actual product value.

## What Must Not Change

- do not become passive observability-only monitoring on a real mutable workspace
- do not lose preimage capture for attached destructive mutations
- do not overclaim contained safety for external irreversible side effects
- do not replace the local daemon with distributed policy components
- do not collapse `deny` and `escalate`

## My Recommendation

This is the healthier end state:

**automate everything that is safely recoverable, contain or checkpoint the rest, and involve humans only when the system cannot honestly preserve recovery or execution trust.**

That is stronger than approval-heavy governance, because it:

- reduces toil
- preserves agent velocity
- keeps recovery central
- makes the product feel like a seatbelt instead of a blocker

It is also a better fit for this repo than pure post-hoc monitoring, because the repo already has a real pre-execution control plane and should keep using it where preimage capture matters.

## Sources

Repo sources:

- [/Users/geoffreyfernald/Documents/agentgit/engineering-docs/support-architecture/10-policy-hardening-and-defaults.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/support-architecture/10-policy-hardening-and-defaults.md)
- [/Users/geoffreyfernald/Documents/agentgit/engineering-docs/support-architecture/01-runtime-architecture.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/support-architecture/01-runtime-architecture.md)
- [/Users/geoffreyfernald/Documents/agentgit/engineering-docs/01-agent-wrapper-sdk/README.md](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/01-agent-wrapper-sdk/README.md)
- [/Users/geoffreyfernald/Documents/agentgit/packages/policy-engine/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/policy-engine/src/index.ts)

External references:

- [Google SRE: Eliminating Toil](https://sre.google/sre-book/eliminating-toil/)
- [Microsoft Learn: Compensating Transaction pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction)
- [AWS Prescriptive Guidance: Saga orchestration pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/saga-orchestration.html)
