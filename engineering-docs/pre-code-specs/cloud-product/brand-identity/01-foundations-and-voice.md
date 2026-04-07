# 01. Foundations And Voice

## Executive Summary

AgentGit is a developer-first DevOps platform that embeds autonomous AI agents into the software development lifecycle. The brand must communicate three things simultaneously:

- technical precision
- operational trust
- forward-looking automation with human oversight

This document establishes the visual language that expresses those qualities. It covers logo, color, typography, motion, iconography, data visualization, accessibility, and component-level guidance. Every rule here is implementation-ready: a designer can use it to produce Figma files and an engineer can use it to tokenize a frontend codebase.

Scope:

- brand identity
- product visual language

Not in scope:

- component library spec
- interaction pattern library
- UX research

## Brand Overview

AgentGit occupies the intersection of DevOps tooling and AI-powered automation. Users are software engineers, platform engineers, SREs, and engineering managers who need to ship code reliably while delegating repetitive operational work to AI agents.

The brand should feel like infrastructure:

- invisible when things work
- unmistakable when you inspect it
- never playful
- never consumer-oriented
- never visually noisy

It should feel like a tool built by engineers who respect other engineers' time and attention.

## Brand Attributes

| Attribute | Meaning | How it shows up |
| --- | --- | --- |
| Precise | Intentional decisions at every level. | Tight type scale, consistent spacing, no decorative elements. |
| Trustworthy | Reliability you can bet production on. | High contrast, predictable layouts, no visual ambiguity. |
| Technical | Built for people who read docs. | Monospace in data contexts, terminal-native color semantics, information-dense UI. |
| Autonomous | AI acts; humans approve. | Lime accent reserved for agent-initiated actions. Clear visual separation between human and agent activity. |

## Voice Principles

- Direct: lead with the outcome and avoid preambles.
- Concise: cut anything that does not add meaning.
- Technical: use precise terms like `merge conflict`, `pipeline`, and `RBAC`.
- Calm: errors are events, not emergencies.

## Writing Rules

| Context | Rule | Example |
| --- | --- | --- |
| Button labels | Verb + object. Max 3 words. Sentence case. | Deploy to prod |
| Error messages | What happened + what to do. No blame. | Merge failed. Resolve conflicts in `src/auth.ts`. |
| Empty states | What this area shows + one action. | No deployments yet. Push to `main` to trigger your first build. |
| Tooltips | One sentence. No period if single sentence. | Shows the last 30 days of deployment activity |
| Confirmations | State the consequence. Use the destructive verb. | Delete branch `feature/auth`? This cannot be undone. |
| Success toasts | Past tense. What succeeded. | Branch merged successfully. |
| Page titles | Noun or noun phrase. No verbs. | Deployments |

## Capitalization

- Sentence case everywhere in the UI
- Proper nouns only: `AgentGit`, `GitHub`, `Kubernetes`
- Acronyms are all caps with no periods: `CI`, `CD`, `SRE`, `RBAC`

## Date, Time, And Number Formatting

| Type | Format | Example |
| --- | --- | --- |
| Relative time | `<60s: just now`; `<60m: 3m ago`; `<24h: 2h ago`; else date | 3m ago |
| Absolute date | `MMM D, YYYY` | Apr 6, 2026 |
| Absolute time | `HH:MM:SS` in 24h UTC unless user preference exists | 14:32:07 UTC |
| Duration | `Xm Ys` for under 1h; `Xh Ym` for over 1h | 2m 34s |
| Large numbers | Abbreviated with suffix at `>9,999` | 12.4k |
| Percentages | No decimal unless `<1%` or `>99%` | 47%, 0.3%, 99.8% |
