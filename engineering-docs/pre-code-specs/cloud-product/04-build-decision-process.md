# 04. Build Decision Process

## Purpose

This document defines how implementation decisions should be made and recorded so the cloud/frontend build stays aligned with the committed product specs.

## Decision Order

When making a frontend or cloud product decision, use this order of authority:

1. `03-cloud-implementation-spec.md`
2. `02-product-design-system-spec.md`
3. `01-brand-identity-spec.md`
4. the detailed reference files in `cloud-implementation/`, `product-design-system/`, and `brand-identity/`
5. existing shipped code
6. temporary implementation preference

If two documents appear to conflict:

- the more specific document wins
- if specificity is equal, update both in the same change rather than guessing

## Working Rule For Engineers And Agents

Before implementing a cloud/frontend feature:

- identify the relevant route or journey
- check whether the needed behavior is already defined in `02` or `03`
- check the detailed reference folder when exact tables, examples, or edge-case rules matter
- use primitives/composites that preserve the shared contract
- avoid ad hoc visual or behavioral one-offs

Before introducing a new pattern:

- confirm the current specs do not already cover it
- record the new decision in this file under `Pending normalizations`
- then update the relevant spec file once the decision is accepted

## Required Build Artifacts

Implementation should create and maintain:

- a token-backed theme layer
- a shared primitives library
- route-level features that map cleanly to the route map
- tests for the five priority journeys
- visual regression coverage for key screens

## When To Update Which Spec

Update `01-brand-identity-spec.md` when changing:

- tokens
- colors
- typography
- iconography
- motion
- visual component styling rules

Update `02-product-design-system-spec.md` when changing:

- layout
- responsive behavior
- interaction rules
- form patterns
- screen templates
- content conventions
- frontend state and permissions behavior

Update `03-cloud-implementation-spec.md` when changing:

- routes
- user journeys
- API contracts
- page-state requirements
- stack choices
- testing or performance requirements
- phased delivery plan

## Definition Of Spec-Aligned

A change is spec-aligned when:

- it matches the route, behavior, and visual contract already documented
- it does not introduce a conflicting one-off pattern
- it includes any required spec update when a real decision changed
- it preserves accessibility, responsiveness, and page-state requirements

## Pending Normalizations

Use this section as a short-term holding area for implementation decisions discovered during buildout. Each item should be resolved by updating `01`, `02`, or `03` and then removing the entry here.

- None yet.
