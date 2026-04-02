# Confidence Replay And Calibration Architecture

## Goal

Add production-grade tooling for tuning low-confidence automation thresholds from real run history without introducing opaque runtime behavior.

The operator workflow must answer four questions:

1. how well does the current confidence score align with observed approval outcomes?
2. what threshold changes does the evidence support?
3. what would those threshold changes have done to real journaled actions?
4. what exact policy patch should the operator review and merge?

## Online Research Summary

Primary sources reviewed:

- scikit-learn User Guide: probability calibration and reliability diagrams
  - https://scikit-learn.org/stable/modules/calibration.html
- scikit-learn `CalibratedClassifierCV` reference for sigmoid and isotonic calibration
  - https://scikit-learn.org/stable/modules/generated/sklearn.calibration.CalibratedClassifierCV.html
- Guo et al., *On Calibration of Modern Neural Networks* (PMLR)
  - https://proceedings.mlr.press/v70/guo17a.html
- IETF RFC 6902: JSON Patch
  - https://www.rfc-editor.org/rfc/rfc6902
- IETF RFC 7386: JSON Merge Patch
  - https://www.rfc-editor.org/rfc/rfc7386
- TOML v1.0.0 specification
  - https://toml.io/en/v1.0.0

## Option Comparison

### Option A: learned post-hoc calibration at runtime

Examples:

- temperature scaling
- Platt/sigmoid scaling
- isotonic regression

Pros:

- standard methods for calibrating model probabilities
- well understood in ML literature
- isotonic preserves monotonic ordering

Cons:

- our score is not a raw classifier probability; it is a deterministic heuristic/action-risk score with operator-visible feature contributions
- runtime learned calibrators would introduce a second decision surface that is harder to audit during incident review
- scikit-learn explicitly warns that isotonic calibration can overfit with too few calibration samples, which is likely for action-family-scoped approval datasets
- temperature scaling from Guo et al. is strong for neural network confidence calibration, but it assumes a model-logit setting that does not match this repo's handcrafted score path

Decision:

- rejected for runtime enforcement
- retained as background research only

### Option B: empirical reliability reporting plus exact replay

Mechanics:

- compute calibration quality from real approval outcomes using reliability-style bins and summary metrics
- generate threshold recommendations from observed approvals/denials
- replay candidate thresholds against exact journaled `ActionRecord`s using the same deterministic policy evaluator used in production

Pros:

- fully auditable and deterministic
- uses the production evaluator directly instead of an offline approximation
- works with sparse per-family sample sets
- makes blast radius visible before rollout

Cons:

- more engineering work than a simple recommendation report
- requires durable storage of normalized actions and policy threshold evidence

Decision:

- chosen

### Option C: machine-generated JSON patch output for policy changes

Alternatives considered:

- RFC 6902 JSON Patch
- RFC 7386 JSON Merge Patch

Why not chosen:

- this repo's operator-facing policy workflow is file-review oriented and already centers on TOML/JSON policy documents
- JSON Patch is index-sensitive for arrays, which is brittle for ordered threshold lists
- JSON Merge Patch can replace whole subtrees, which is less explicit for human-reviewed threshold edits
- a TOML snippet is easier for operators to inspect and merge into owned policy sources

Decision:

- keep report-only TOML threshold snippets for operator review
- replay summary is attached to the patch workflow instead of attempting automatic mutation

## Chosen Design

### Product decisions

- enforcement remains deterministic and policy-driven
- calibration is descriptive and advisory, not a hidden runtime transform
- replay uses real journaled normalized actions, not reconstructed samples
- threshold relaxation remains report-only and human-reviewed
- patch generation stays report-only

### Calibration metrics now produced

For totals and each action family:

- resolved sample count
- pending sample count
- approved count
- denied count
- mean confidence
- mean observed approval rate
- Brier score
- expected calibration error (ECE)
- max calibration gap
- reliability bins with Wilson interval bounds

### Replay semantics

For each replayable action:

- evaluate current effective policy using the stored normalized `ActionRecord`
- evaluate candidate threshold overlay using the same deterministic evaluator
- compare current decision, candidate decision, and recorded historical decision
- classify decision shifts such as:
  - approval removed
  - approval added
  - unsafe auto-allow after historical denial
  - historically automatic action newly gated
  - generic decision change

## Infra Map

### Journal layer

Files:

- `packages/run-journal/src/index.ts`
- `packages/run-journal/src/index.test.ts`

Responsibilities:

- persist full normalized actions in `action.normalized`
- persist threshold evidence in `policy.evaluated`
- compute calibration quality from approval history
- expose replay-ready records keyed by `run_id + action_id`

### Policy engine

Files:

- `packages/policy-engine/src/index.ts`
- `packages/policy-engine/src/index.test.ts`

Responsibilities:

- keep threshold resolution deterministic
- recommend thresholds from calibration history
- replay candidate threshold overlays against stored `ActionRecord`s
- classify blast-radius changes and summarize them by family

### Daemon API

Files:

- `packages/authority-daemon/src/server.ts`
- `packages/authority-daemon/src/server.integration.test.ts`

Responsibilities:

- surface `replay_policy_thresholds`
- return calibration reports with quality metrics
- return recommendation reports
- orchestrate replay on top of journal evidence and compiled policy

### SDK contracts

Files:

- `packages/authority-sdk-ts/src/index.ts`
- `packages/authority-sdk-ts/src/index.test.ts`
- `packages/authority-sdk-py/agentgit_authority/client.py`
- `packages/authority-sdk-py/agentgit_authority/types.py`
- `packages/schemas/src/index.ts`

Responsibilities:

- expose replay request/response types
- keep CLI and downstream clients on the same contract

### CLI/operator workflow

Files:

- `packages/authority-cli/src/main.ts`
- `packages/authority-cli/src/main.test.ts`
- `packages/authority-cli/README.md`
- `engineering-docs/CLI-OPERATOR-RUNBOOK.md`

Responsibilities:

- show calibration quality and bins
- recommend thresholds
- replay recommendation-derived or candidate-file thresholds
- render a report-only TOML patch with replay summary

## Implemented Operator Workflow

### 1. inspect calibration quality

```bash
agentgit-authority --json policy calibration-report --run-id <run-id> --include-samples --sample-limit 20
```

### 2. derive threshold recommendations

```bash
agentgit-authority --json policy recommend-thresholds --run-id <run-id> --min-samples 5
```

### 3. replay recommendation-derived thresholds

```bash
agentgit-authority --json policy replay-thresholds --run-id <run-id> --min-samples 5 --direction all --include-changed-samples --sample-limit 20
```

### 4. replay a candidate policy file directly

```bash
agentgit-authority --json policy replay-thresholds --run-id <run-id> --candidate-policy ./policy.toml --include-changed-samples --sample-limit 20
```

### 5. generate the report-only patch

```bash
agentgit-authority --json policy render-threshold-patch --run-id <run-id> --min-samples 5 --direction all
```

## Why This Is The Right Fit For This Repo

This repo already treats policy as governed configuration, not as an opaque learned model. The chosen design preserves that contract:

- score generation stays explainable
- enforcement stays deterministic
- tuning happens through reviewable evidence
- rollout remains an explicit policy change
- every recommendation can be replayed against real historical actions before adoption

That combination is closer to a production control system than a generic ML calibration pipeline, which is the right bar for the authority boundary this project is building.
