# 08. Timeline and Helper

## Working Thesis

The Timeline and Helper should turn the immutable journal into an action-first narrative of what happened, why it happened, and what can be safely done next.

It should not be:

- a raw log viewer
- a trace waterfall copy
- a chat summary detached from source evidence

It should be:

- action-centered
- causality-aware
- reversibility-aware
- evidence-backed

The helper layer should answer questions about the run by grounding those answers in journaled actions, policy outcomes, snapshots, executions, and recovery data.

## Why This Matters

The product promise is not only control.
It is understandable autonomy.

If the timeline is just a list of events:

- users will not know what mattered
- debugging will be slow
- rollback will feel risky

If the helper is only free-form LLM narration:

- it will hallucinate causality
- it will overclaim reversibility
- it will weaken trust in the system

So this subsystem should optimize for:

**evidence-backed narration on top of an action-first replay model**

## Research-Driven Design Constraints

### Traces are useful for structure, but not sufficient for product explanation

OpenTelemetry’s observability docs emphasize parent-child spans, waterfall views, and causal links.

Design implication:

- trace structure is useful for drill-down and timing
- but the user-facing unit should still be the action boundary, not raw spans

### Agent tracing already groups work into meaningful operations

OpenAI Agents tracing groups runs, agents, generations, tool calls, guardrails, and handoffs into nested traces/spans.

Design implication:

- the timeline should consume traces as supporting evidence
- but present a higher-level run/action narrative
- if supporting evidence capture degrades after execution, the timeline should say that explicitly instead of silently flattening the action to a clean success

### Local history and causation are different things

Git reflog records local state movement, while `git bisect` helps identify the likely change that introduced a problem.

Design implication:

- the timeline should distinguish:
  - what happened in order
  - what likely caused the problem

Those are related, but not identical.

### History simplification matters

Git’s history simplification options such as `--first-parent` and simplified history exist because raw history is often too noisy.

Design implication:

- the timeline should support multiple views:
  - full event detail
  - action summary
  - branch-point / checkpoint summary

### Sensitive data must be filtered by visibility

OpenAI tracing docs explicitly call out that tracing may include sensitive inputs and outputs and that this needs configurable inclusion.

Design implication:

- helper responses and timeline views must respect journal visibility levels
- model-visible summaries should not blindly include sensitive internal data

## Product Role

This subsystem takes:

- journal events
- projections
- artifacts
- snapshot/recovery metadata
- recovery boundary type and manual-review guidance when no exact restore exists

and turns them into:

- replayable run views
- impact explanations
- root-cause hints
- revert previews
- plain-English summaries

## Non-Goals

- Replace the journal as the source of truth
- Infer root cause with certainty when evidence is weak
- Surface all internal events to end users by default
- Depend on an LLM for basic deterministic summaries

## Timeline Model

The primary user-facing timeline unit should be the `ActionStep`.

## ActionStep

An `ActionStep` is a projection over one action lineage.

It should combine:

- `Action`
- latest policy outcome
- latest snapshot record
- latest execution result
- latest recovery status
- key artifacts

Recommended shape:

```json
{
  "action_id": "act_01H...",
  "run_id": "run_01H...",
  "title": "Run shell command",
  "summary": "Deleted build output after creating a recoverable checkpoint.",
  "status": "completed",
  "provenance": "governed",
  "decision": "allow_with_snapshot",
  "recovery_label": "exact_restore_available",
  "started_at": "2026-03-30T10:10:00Z",
  "completed_at": "2026-03-30T10:10:03Z",
  "artifacts": [
    {
      "type": "stdout",
      "ref": "blob_01H..."
    }
  ],
  "warnings": [],
  "links": {
    "snapshot_id": "snap_01H...",
    "execution_result_id": "exec_01H..."
  }
}
```

## Timeline Views

The same underlying journal should support multiple views.

### 1. Run view

Default view for:

- what happened in this run?

Shows:

- action steps in order
- major boundaries
- approvals
- failures
- recoverability markers

### 2. Boundary view

Default view for:

- where can I revert?
- what happened after step 4?

Shows:

- snapshots
- branch points
- recovery boundaries
- impact previews
- first-class recovery downgrade reasons when a boundary is `review_only`

### 3. Diagnostic view

Default view for:

- which step likely caused this problem?

Shows:

- suspicious actions
- failures
- overlapping later changes
- external side effects
- root-cause confidence hints

### 4. Full event drill-down

Power-user view for:

- exact low-level sequence
- causality links
- raw event envelopes

## Summarization Layers

The helper should not use one summary mode for everything.

### Deterministic summaries first

These should be computed without an LLM where possible:

- action count
- approvals triggered
- snapshots taken
- failures
- external side effects
- recovery points available

### LLM narration second

Use LLM help for:

- plain-English run summary
- “what changed after step 4?”
- “what would I lose if I revert here?”
- “which step likely caused the problem?”

But the LLM should be constrained to evidence retrieved from the journal and projections.

## Helper Question Model

The helper should support a defined set of question types first.

### Launch question types

- `summarize_run`
- `summarize_after_boundary`
- `identify_external_effects`
- `explain_policy_decision`
- `preview_revert_loss`
- `suggest_likely_cause`
- `list_actions_touching_scope`

Launch note:

- helper answers that focus on a single blocked, approval-gated, or policy-evaluated step should carry the dominant recorded reason as a structured `primary_reason`
- timeline approval steps should preserve the same structured `primary_reason` from the approval-request boundary instead of reducing it to summary prose

### Why this matters

If we define question classes up front:

- retrieval can be deterministic
- prompts can be evidence-scoped
- answer quality improves

## Root-Cause Hints

The helper should never claim certainty without enough evidence.

### Suggested confidence bands

- `high`
  - direct failure at action
  - strong overlap with broken scope
- `medium`
  - temporal correlation plus overlapping paths or external object IDs
- `low`
  - plausible but weak evidence

### Root-cause signals

- first failure after a successful baseline
- first action touching later-broken scope
- actions with destructive or irreversible side effects
- untrusted or observed-only actions
- recovery attempts that fixed the issue

This is where the `git bisect` mental model is useful:

- identify likely introduction points
- do not overclaim certainty

## Revert Preview Answers

Before a user restores a boundary, the helper should answer:

- which later actions would be affected?
- which protected paths would change?
- which external effects remain live?
- whether the boundary has exact restore or only compensation

This is one of the highest-value helper interactions in the product.

## Provenance And Trust Surfacing

The timeline should visually distinguish:

- `governed`
- `observed`
- `imported`
- `unknown`

and it should explain why that matters.

For example:

- governed: we saw and controlled this before execution
- observed: we saw evidence after the fact
- imported: brought in from external audit history
- unknown: insufficient trustworthy evidence

Launch operator surfaces should make this hard to miss:

- run-level timeline summaries should count non-governed steps
- step detail views should include a plain-English trust advisory
- helper answers should mention when important evidence comes from weaker provenance

## Visibility And Redaction

The timeline/helper must respect journal visibility:

- `user_visible`
- `model_visible`
- `internal`
- `sensitive_internal`

### Launch rule

Never let helper narration include `sensitive_internal` data unless the caller is explicitly authorized for that level.

For the local daemon contract, this should be request-scoped and explicit:

- timeline/helper queries default to `user`
- callers may explicitly request `model`, `internal`, or `sensitive_internal`
- responses should report when redactions were applied at the chosen scope
- responses should also report when inline preview budget truncated or omitted artifact previews

## Replay Semantics

Replay should be action-first, with event drill-down available.

### Default replay

- one row per action step
- expandable details
- key artifacts inline or by preview
- inline previews should be clipped and budgeted, not dumped without limit
- retrievable artifacts should expose durable `artifact_id`s when the caller has enough visibility to fetch them
- artifact references and fetch responses should expose explicit integrity attestation metadata (`artifact-integrity.v1`, algorithm, digest) so operators can reason about what was verified
- if a durable artifact blob later disappears, the timeline should keep the reference but mark it as missing so evidence loss is explicit
- if a configured retention window expires, the timeline should mark the artifact as expired rather than missing so operators can distinguish policy-driven unavailability from corruption or loss
- if artifact storage becomes unreadable or structurally invalid, the timeline should mark the artifact as corrupted rather than hiding it under the generic missing bucket
- if artifact bytes remain readable but no longer match the recorded digest, the timeline should mark the artifact as tampered so integrity failures are distinct from storage failures

### Diagnostic replay

- action step plus underlying events
- trace links
- policy and snapshot details
- recovery overlap markers
- on-demand artifact fetch by `artifact_id`
- helper uncertainty should increase when supporting artifacts are no longer available in durable storage

### Timing view

When useful, show relative durations and nested execution timing inspired by trace waterfall models, but subordinate timing to action clarity.

## Data Pipeline

The helper should use a layered pipeline:

1. retrieve relevant actions/boundaries/events
2. compute deterministic facts
3. compute impact or overlap sets
4. only then generate optional narrative text

This keeps the helper grounded.

## Main Risks

### 1. Too much raw detail

Mitigation:

- default to action-level view
- provide drill-down instead of flooding the main view

### 2. Hallucinated helper answers

Mitigation:

- fixed question classes
- evidence retrieval first
- answer confidence bands

### 3. Hiding uncertainty

Mitigation:

- explicit provenance
- explicit confidence
- explicit recovery labels

### 4. Sensitive data leakage

Mitigation:

- visibility-aware retrieval
- redaction-aware summaries
- no blind artifact dumping into prompts

## Build Order

1. Define `ActionStep` projection model
2. Build run view and boundary view projections
3. Build deterministic run summary generation
4. Add revert preview and external-effects queries
5. Add diagnostic view and likely-cause hints
6. Add visibility-aware helper retrieval
7. Add constrained LLM narration for launch question types
8. Add richer replay/timing views

## Concrete Recommendation

For v1, the timeline and helper should optimize for one thing:

**make every important action understandable enough that a user can decide whether to trust it, inspect it, or roll it back without reading raw logs**

That is the user-facing completion of the rest of the architecture.

## Research Inputs

- OpenAI Agents tracing overview: <https://openai.github.io/openai-agents-python/tracing/>
- OpenAI Agents tracing reference: <https://openai.github.io/openai-agents-python/ref/tracing/traces/>
- OpenAI Agents run config / trace IDs: <https://openai.github.io/openai-agents-python/ref/run/>
- OpenTelemetry observability primer: <https://opentelemetry.io/docs/concepts/observability-primer/>
- OpenTelemetry traces concept: <https://opentelemetry.io/docs/concepts/signals/traces/>
- Git reflog: <https://git-scm.com/docs/git-reflog.html>
- Git bisect: <https://git-scm.com/docs/git-bisect.html>
- Git log history simplification: <https://git-scm.com/docs/git-log>
