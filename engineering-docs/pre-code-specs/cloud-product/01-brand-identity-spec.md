# 01. Brand Identity Spec

## Scope

This document defines the normative visual and written identity for the AgentGit Cloud product UI.

Primary source:

- `/Users/geoffreyfernald/Downloads/AgentGit_Brand_Identity_v2.docx`

## Brand Attributes

The product presentation should consistently feel:

- precise
- trustworthy
- technical
- autonomous

Implementation should favor clarity, density, and deliberate structure over decorative or consumer-style patterns.

## Voice And Writing

- UI copy uses sentence case.
- Button labels use verb plus object where possible.
- Error copy follows:
  - what happened
  - what to do next
- Empty states say what the area is for and provide one clear next action.
- Page titles are nouns or noun phrases, not marketing sentences.

## Color And Semantics

- Primary brand color: teal
- Agent-only accent color: lime
- Lime is reserved for agent-initiated or agent-recommended actions and must not be reused as generic success.
- Success, warning, error, and info each have separate semantic colors and backgrounds.
- Dark mode is the product default.
- Light mode is supported through token mapping and theme switching.

## Surface Hierarchy

Dark surface order:

- base: Void
- elevated: Charcoal
- card/overlay: Slate
- nested/hover: Steel

Do not reverse elevation by placing darker cards on lighter dark surfaces.

## Typography

- Sans family: IBM Plex Sans
- Monospace family: IBM Plex Mono
- Monospace is limited to code, data, timestamps, SHAs, diffs, and log output.
- Product headings should use weight 600.
- Product body copy should use weight 400 by default.
- Avoid using display-marketing typography rules inside the application shell.

## Tokens

All frontend styling must resolve through `--ag-*` custom properties or the Tailwind token mapping derived from them.

Required token families:

- color
- background
- text
- border
- spacing
- radius
- shadow
- z-index
- duration
- easing
- font

Rules:

- no arbitrary z-index values
- no arbitrary spacing values where a token exists
- theme switching uses `[data-theme]`
- dark mode remains the default baseline

## Iconography

- Icon set baseline: `lucide-react`
- Default size: 20px
- Default stroke: 1.5
- Larger sizes are reserved for headers and empty-state illustrations

## Motion

- Motion should be minimal and informative
- Allowed motion: fades, subtle scale, slide, panel transitions, skeleton pulse
- Disallowed motion: bounce, elastic, spring-heavy effects
- All animation must respect `prefers-reduced-motion`

## Accessibility

- Minimum target: WCAG 2.1 AA
- Target AAA contrast for text where practical
- Focus styling uses `:focus-visible`, not `:focus`
- Default focus ring: 2px teal with 2px offset
- Touch targets: minimum 44x44px
- Skip-to-content link is required on every page

## Core Component Visual Rules

### Buttons

- One primary button per visible section
- Accent/lime button variant is only for agent approvals or agent-recommended actions
- Destructive actions use error styling and require confirmation

### Inputs

- Inputs use product surface colors and tokenized borders
- Focus state is teal border plus focus ring
- Error state uses semantic error token and inline error text

### Cards And Tables

- Cards use tokenized surface, border, radius, and padding values
- Tables prioritize readability and dense technical scanning
- Numeric and code-like data should use the mono family

### Modals, Toasts, Code Blocks

- Modal surfaces follow tokenized overlay rules and internal scrolling
- Toasts stack predictably and use semantic accent borders
- Code/log viewers use the mono family and never wrap long lines by default

## Engineering Handoff Rules

- Token prefix is `--ag-`
- Tailwind config should reference the token system rather than duplicating raw color literals
- Fonts should be centrally configured, not imported ad hoc per component
- All focus, motion, and theming behavior should be implemented once in shared primitives

## Remaining Work That Should Still Exist Elsewhere

This brand spec intentionally does not define:

- route-level structure
- interaction state machines
- component prop APIs
- page data contracts

Those belong in the companion product and cloud implementation specs.
