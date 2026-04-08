# Cloud Product Specs

This folder converts the current frontend and product definition work into repo-native Markdown so implementation can treat it as a normative source of truth.

These docs are derived from the following source documents:

- `/Users/geoffreyfernald/Downloads/AgentGit_Brand_Identity_v2.docx`
- `/Users/geoffreyfernald/Downloads/AgentGit_Product_Design_System.docx`
- `/Users/geoffreyfernald/Downloads/AgentGit_Cloud_Implementation_Spec.docx`

## Purpose

The existing pre-code specs in this repository define the local-first authority system and its subsystem contracts.

This folder defines the hosted cloud product and frontend surface that sits on top of that system:

- brand and visual tokens
- application layout and interaction behavior
- cloud routes, journeys, API contracts, and implementation plan
- build-decision rules for engineers and coding agents

## Normative Docs

- `00-source-map.md`
- `01-brand-identity-spec.md`
- `02-product-design-system-spec.md`
- `03-cloud-implementation-spec.md`
- `04-build-decision-process.md`
- `05-foundation-loop-backlog.md`
- `06-cloud-sync-control-plane-plan.md`
- `07-production-readiness-runbook.md`

## Detailed Reference Folders

- `brand-identity/`
- `product-design-system/`
- `cloud-implementation/`

The top-level `01`, `02`, and `03` files are concise normative overviews.

The subfolders hold the fuller section-by-section carryover from the source DOCX documents so implementation can look up exact tables, examples, and edge-case details without ambiguity.

## How To Use These Docs

- Treat `01`, `02`, and `03` as normative for cloud/frontend implementation.
- Use the matching detailed reference folder when you need the full tables or more exact section guidance.
- Use `04-build-decision-process.md` when a new implementation decision is needed that is not already resolved by the specs.
- Do not silently override these docs in code. If implementation needs to diverge, add a decision note first and then update the affected spec.

## Scope Boundary

These docs apply to the hosted AgentGit Cloud product and its future frontend implementation.

They do not replace the subsystem specs under `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/pre-code-specs/` for daemon, journal, policy, recovery, or adapter internals. When the cloud product touches those systems, both doc sets are normative.
