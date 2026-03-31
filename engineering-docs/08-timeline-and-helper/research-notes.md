# Research Notes

## Scope

This note captures the external research used to shape the first plan for the Timeline and Helper subsystem.

Research date:

- March 30, 2026

## Key Findings

### 1. Traces provide good structure, but users need higher-level units

OpenTelemetry and OpenAI Agents tracing both show the value of nested spans and trace IDs.

Design implication:

- traces are excellent supporting structure
- but the user-facing timeline should still group by action boundary first

### 2. History and diagnosis are different tasks

Git’s reflog records local movement through states, while `git bisect` is explicitly about finding the likely change that introduced a problem.

Design implication:

- the timeline should separate chronological replay from root-cause suggestion

### 3. History simplification is necessary

Git’s log/history simplification options exist because raw history can be too noisy to interpret quickly.

Design implication:

- we need multiple projections: run, boundary, diagnostic, and full event drill-down

### 4. Sensitive data handling must be explicit

OpenAI tracing docs note that traces may capture sensitive tool inputs/outputs and offer explicit controls for including them.

Design implication:

- helper retrieval and summarization must respect visibility and redaction boundaries

## Source Notes

### OpenAI

- Tracing overview
  - Traces and spans naturally model runs, generations, tools, and guardrails.
  - <https://openai.github.io/openai-agents-python/tracing/>

- Traces reference
  - Trace exportability and IDs are useful for correlation design.
  - <https://openai.github.io/openai-agents-python/ref/tracing/traces/>

- Run config reference
  - Trace IDs and trace sensitivity settings are directly relevant to visibility-aware helper design.
  - <https://openai.github.io/openai-agents-python/ref/run/>

### OpenTelemetry

- Observability primer
  - Waterfall diagrams and causal nesting are strong inspiration for drill-down views.
  - <https://opentelemetry.io/docs/concepts/observability-primer/>

- Traces concept
  - Spans, span events, status, and links map well onto diagnostic drill-down.
  - <https://opentelemetry.io/docs/concepts/signals/traces/>

### Git

- `git reflog`
  - Local state movement is a useful model for state-boundary history.
  - <https://git-scm.com/docs/git-reflog.html>

- `git bisect`
  - Strong model for likely-cause discovery rather than mere replay.
  - <https://git-scm.com/docs/git-bisect.html>

- `git log`
  - History simplification and first-parent views reinforce the importance of multiple timeline projections.
  - <https://git-scm.com/docs/git-log>

## Resulting Recommendation

The timeline and helper should be:

- action-first
- evidence-backed
- multi-view
- confidence-aware
- visibility-aware
- grounded in deterministic retrieval before narrative generation
