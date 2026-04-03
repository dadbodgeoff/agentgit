# Snapshot Boundary Audit

Status date: 2026-04-03 (America/New_York)

Owner: AgentGit core

## Purpose

Audit how snapshot selection, recovery planning, and product restore behavior currently work in the repo, then define the most natural fix path from the existing design rather than proposing a parallel architecture.

This note focuses on one question:

**Are recovery boundaries chosen and explained in the healthiest way for the product promise AgentGit is making today?**

## Executive Summary

The repo is directionally correct already.

The current design does **not** blindly copy an entire repo for every risky action. Instead, it chooses the smallest recovery boundary that can still support an honest recovery promise, and it widens to stronger anchors when the action becomes opaque, broad, or low-confidence.

That is the right foundation.

The main gap is not the core engine. The main gap is that the product layer still under-exposes three important ideas that already exist implicitly in the lower layers:

1. boundary strength
2. explicit operator checkpoints
3. clearer restore downgrade reasons

The healthiest repo-native path is:

1. keep minimal targeted snapshots as the default
2. widen more aggressively for ambiguous shell and broad workspace mutations
3. add a first-class product checkpoint verb or setup/run option
4. surface boundary strength and downgrade reasons clearly in `inspect` and `restore`

## What Exists Today

### Snapshot Selection Is Already Risk-Aware

The current selector in [/Users/geoffreyfernald/Documents/agentgit/packages/snapshot-engine/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/snapshot-engine/src/index.ts) starts from a cheap boundary and widens based on actual risk:

- explicit branch point or hard checkpoint -> `exact_anchor`
- low confidence -> `exact_anchor`
- opaque shell package/build tooling -> `exact_anchor`
- broad filesystem scope -> `exact_anchor`
- narrow reversible filesystem mutation -> `journal_only`
- normal filesystem mutation -> `journal_plus_anchor`
- shell mutation with uncertainty -> `exact_anchor`

That means the engine already follows the right basic philosophy:

**use the cheapest boundary that still makes recovery honest**

### Recovery Planning Is Already Honest About Degradation

The recovery engine in [/Users/geoffreyfernald/Documents/agentgit/packages/recovery-engine/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/recovery-engine/src/index.ts) is also making healthy choices:

- metadata-only snapshots degrade to review-only unless a trusted compensator exists
- shell-origin boundaries can force manual review
- capability degradation can force review-only
- path-subset restore remains narrow when it is trustworthy

This is good. It avoids pretending every recorded action is exactly reversible.

### The Product Layer Already Prefers Narrow Safe Restore Targets

The product restore resolution in [/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/service.ts](/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/service.ts) already does several healthy things:

- prefers explicit restore shortcuts when they exist
- prefers path-subset restore when the timeline provides a path subset
- defaults to preview when conflicts exist
- treats contained unpublished projection discard as a separate exact restore class

This means the user-facing layer is not recklessly broad by default.

## Where The Model Is Still Weaker Than Ideal

### 1. Boundary Selection Is More Action-Shaped Than Blast-Radius-Shaped

Today the selector relies mainly on normalized action metadata:

- operation family
- scope breadth
- unknowns
- confidence
- reversibility hints

That is good, but still imperfect for shell-heavy workflows.

Problem:

- a command can look narrow but still have a wider effective blast radius than the normalized action suggests
- the selector does not yet incorporate enough product-level signals like repeated mutating shell runs, risky directory patterns, or escalation after earlier ambiguity in the same run

Natural fix:

- enrich snapshot selection inputs with run-local risk context rather than redesigning the engine
- widen to `exact_anchor` sooner for ambiguous shell sequences and mutating tool chains

Target files:

- [/Users/geoffreyfernald/Documents/agentgit/packages/snapshot-engine/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/snapshot-engine/src/index.ts)
- [/Users/geoffreyfernald/Documents/agentgit/packages/authority-daemon/src/server.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-daemon/src/server.ts)

### 2. Explicit Checkpoints Exist Internally But Not As A First-Class Product Habit

The snapshot engine already understands:

- `explicit_branch_point`
- `explicit_hard_checkpoint`

But the product layer does not yet make this a normal user-facing move.

Problem:

- users cannot naturally say “this next step is risky, give me a stronger checkpoint first”
- the product must infer too much from the action instead of allowing intentional operator boundaries

Natural fix:

- add a first-class checkpoint concept to the product layer without expanding AgentGit into a framework
- this can be:
  - `agentgit checkpoint`
  - or a narrow option on `run`
  - or an advanced setup/run preference for broad-risk work

Recommended direction:

- prefer `agentgit checkpoint` as an explicit user verb only if the team is comfortable adding one more verb
- otherwise add a narrow `--checkpoint` run option that maps directly onto existing daemon snapshot semantics

Current shipped direction:

- keep the five-command surface intact
- use `agentgit run --checkpoint` as the explicit checkpoint entry point
- support stronger operator intent through checkpoint kind and checkpoint reason fields on `run`, instead of expanding the product into another top-level verb

Target files:

- [/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/main.ts](/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/main.ts)
- [/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/service.ts](/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/service.ts)
- [/Users/geoffreyfernald/Documents/agentgit/packages/authority-daemon/src/server.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-daemon/src/server.ts)

### 3. Restore UX Is Honest, But It Still Hides Too Much Boundary Truth

Today `restore` and `inspect` do show restore availability and whether recovery is review-only. That is good.

What is still missing:

- boundary strength in plain language
- why a target is exact vs review-only
- why a broader boundary was chosen
- why a narrower path subset was considered safe

Natural fix:

- add restore-boundary explanation fields to the product formatting layer
- do not expose raw daemon jargon by default
- translate the internal recovery class into plain product language such as:
  - `targeted restore`
  - `checkpoint restore`
  - `review before restore`

Target files:

- [/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/service.ts](/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/service.ts)
- [/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/main.ts](/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/main.ts)

### 4. Attached Mode Still Relies On Weaker Boundaries Than Contained Mode

This is already acknowledged by the assurance model, so it is not a hidden flaw. But it matters for recovery health.

Problem:

- attached runs still depend on governed launch surfaces and action capture
- contained runs protect the real workspace more directly through projection and publish-back

Natural fix:

- keep the current assurance-language honesty
- bias broader-risk generic workflows toward contained mode where the host supports it
- avoid promising the same restore strength in attached mode when the execution boundary is weaker

Target files:

- [/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/service.ts](/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/service.ts)
- [/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/adapters.ts](/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/adapters.ts)

### 5. The Product Does Not Yet Escalate To Broader Boundaries Based On Run History

The current selector uses `journal_chain_depth`, which is a good start, but it is still fairly generic.

Missing behavior:

- repeated ambiguous shell actions in the same run should bias toward stronger checkpoints sooner
- repeated blocked or partially governed attempts should become more visibly checkpoint-oriented
- a run with mounting uncertainty should surface that the safest recovery path is broadening

Natural fix:

- add run-local escalation signals to snapshot selection input
- persist just enough recovery-boundary rationale for the product layer to explain it later

Target files:

- [/Users/geoffreyfernald/Documents/agentgit/packages/authority-daemon/src/server.ts](/Users/geoffreyfernald/Documents/agentgit/packages/snapshot-engine/src/index.ts)
- [/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/service.ts](/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/service.ts)

## Recommended Fix Plan

### Phase 1: Product Truth

Goal:

- make boundary strength visible before changing engine behavior

Changes:

- add boundary-strength explanation in `inspect`
- add exact-vs-review rationale in `restore --preview`
- surface whether the current default target is:
  - targeted path restore
  - snapshot restore
  - contained projection discard
  - manual-review boundary

Why first:

- cheap
- low risk
- improves trust immediately

Status:

- implemented
- `inspect` and `restore --preview` now explain restore boundary strength and preview-only rationale in plain product language

### Phase 2: Explicit Checkpointing

Goal:

- let users ask for a stronger boundary intentionally

Changes:

- add a product checkpoint entry point that reuses existing snapshot semantics
- store checkpoint intent in product state so later inspect/restore can explain it naturally

Guardrail:

- keep this seatbelt-shaped, not workflow-engine-shaped

Status:

- implemented
- `agentgit run --checkpoint` now creates an explicit product-facing recovery boundary that inspect and restore can resolve directly

### Phase 3: Smarter Boundary Widening

Goal:

- make the selector more blast-radius-aware for opaque runs

Changes:

- enrich snapshot selection with run-local ambiguity and repeated-mutation context
- widen earlier for risky shell/tooling sequences
- persist rationale codes the product layer can summarize

Status:

- implemented
- snapshot selection now incorporates run-local counts for:
  - repeated ambiguous shell mutations
  - repeated broad mutation actions
  - repeated reviewed or blocked mutation attempts
  - recent failed mutating executions
- the daemon now feeds those counts into `selectSnapshotClass(...)`
- repeated ambiguous shell history now widens later narrow boundaries earlier, and the rationale is persisted in the journaled snapshot selection basis

### Phase 4: Restore Guidance Hardening

Goal:

- make degraded recovery feel intentional and understandable, not disappointing

Changes:

- map internal recovery strategies to plain language
- show why preview-only happened
- show when forcing restore would overwrite later changes
- show when exact restore is unavailable because the stored boundary is metadata-only or shell-opaque

## What Should Not Change

These are strengths of the current repo design and should be preserved:

- do not switch to full-repo copy by default
- do not replace the daemon recovery model
- do not fork a separate product recovery backend
- do not pretend every governed action deserves exact restore
- do not blur the distinction between attached and contained assurance

## Preferred Product Philosophy

The healthy product rule for this repo is:

**Use the smallest recovery boundary that still makes the restore claim honest, and widen intentionally when ambiguity rises.**

That philosophy already exists in the lower layers.

The next step is to expose it more clearly and drive it more deliberately from the product layer.

## Immediate Next Moves

1. add boundary explanation fields to product `inspect` and `restore` formatting
2. add a first-class product checkpoint entry point or narrow run option
3. enrich snapshot selection with repeated ambiguous shell/run history signals
4. add tests that prove widening behavior and degrade-reason formatting

## Primary Code Seams Reviewed

- [/Users/geoffreyfernald/Documents/agentgit/packages/snapshot-engine/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/snapshot-engine/src/index.ts)
- [/Users/geoffreyfernald/Documents/agentgit/packages/recovery-engine/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/recovery-engine/src/index.ts)
- [/Users/geoffreyfernald/Documents/agentgit/packages/authority-daemon/src/server.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-daemon/src/server.ts)
- [/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/service.ts](/Users/geoffreyfernald/Documents/agentgit/packages/agent-runtime-integration/src/service.ts)
- [/Users/geoffreyfernald/Documents/agentgit/packages/snapshot-engine/README.md](/Users/geoffreyfernald/Documents/agentgit/packages/snapshot-engine/README.md)
- [/Users/geoffreyfernald/Documents/agentgit/wiki/Recovery-and-Snapshots.md](/Users/geoffreyfernald/Documents/agentgit/wiki/Recovery-and-Snapshots.md)
