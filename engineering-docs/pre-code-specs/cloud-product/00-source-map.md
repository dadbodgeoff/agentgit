# 00. Source Map

## Scope

This document records the source artifacts for the cloud product/frontend spec set and defines how those sources should be translated into repo-native Markdown.

## Source Documents

- Brand identity source:
  - `/Users/geoffreyfernald/Downloads/AgentGit_Brand_Identity_v2.docx`
- Product design system source:
  - `/Users/geoffreyfernald/Downloads/AgentGit_Product_Design_System.docx`
- Cloud implementation source:
  - `/Users/geoffreyfernald/Downloads/AgentGit_Cloud_Implementation_Spec.docx`

## Translation Rule

- The Markdown docs in this folder are the repo-native working copies.
- The DOCX files are treated as the source authoring artifacts from which these Markdown docs were derived.
- Once a decision is captured in Markdown and committed, implementation should prefer the Markdown version because it is versioned with the codebase.

## Mapping

### `01-brand-identity-spec.md`

Derived from the brand identity source and captures:

- brand attributes and voice rules
- logo rules relevant to product surfaces
- color, typography, token, icon, and motion systems
- accessibility targets
- component visual guidance
- engineering handoff rules for tokens, theming, and styling

### `02-product-design-system-spec.md`

Derived from the product design system source and captures:

- application shell and layout contracts
- responsive behavior and breakpoint rules
- component interaction behavior
- form patterns
- screen templates
- content rules
- frontend data/state contracts

### `03-cloud-implementation-spec.md`

Derived from the cloud implementation source and captures:

- route map
- priority user journeys
- REST and WebSocket contracts
- page-specific loading, empty, error, and stale states
- frontend stack and architecture choices
- testing, performance, and phased delivery requirements

## Update Policy

- If the DOCX source changes materially, update the matching Markdown file in the same commit as any code that depends on the new decision.
- If implementation discovers a missing decision, record it in `04-build-decision-process.md` before normalizing it into `01`, `02`, or `03`.
- Avoid keeping important product decisions only in Figma comments, chat threads, or temporary planning notes.
