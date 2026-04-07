# 03. Implementation Plan

## Stack

| Layer | Technology | Rationale |
| --- | --- | --- |
| Framework | Next.js 15 (App Router) | RSC for initial loads, server actions for mutations, native API routes for REST proxy |
| Language | TypeScript 5.x strict mode | Shared types with monorepo schemas |
| Styling | Tailwind CSS + CSS custom properties | Token-backed theming and utility ergonomics |
| Components | Custom component library, no shadcn baseline | Built directly from product specs |
| State management | React Server Components + TanStack Query | Server-first initial data, client cache and mutations |
| Forms | React Hook Form + Zod | Shared validation model |
| Real-time | Native WebSocket + TanStack Query invalidation | Targeted refreshes |
| Auth | NextAuth.js with GitHub provider | OAuth flow, session management, RBAC middleware |
| Database | PostgreSQL (Neon) + Drizzle ORM | Cloud-owned state for workspace, billing, team, connections |
| Testing | Vitest + Playwright + Testing Library | Multi-layer verification |
| CI/CD | GitHub Actions to Vercel | Preview deploys on PRs, production from `main` |
| Monitoring | Sentry + Vercel Analytics | Error and performance visibility |

## Component Architecture

### Primitives

- Direct implementations of the Brand Identity spec
- Examples: `Button`, `Input`, `Select`, `Badge`, `Card`, `Table`, `Tabs`, `Modal`, `Toast`, `CodeBlock`
- Accept `variant`, `size`, and `state` props
- No business logic
- No data fetching
- Intended location: `/src/components/primitives/`

### Composites

- Combine primitives into reusable interaction patterns
- Examples: `ApprovalCard`, `RunTimeline`, `PolicyRuleEditor`, `CalibrationChart`, `ActionLogViewer`
- May own local state
- Do not own server state strategy
- Intended location: `/src/components/composites/`

### Features

- Route-level components that own data fetching, routing, and orchestration
- One feature per route or major page
- Use TanStack Query hooks for data
- Compose primitives and composites
- Intended location: `/src/app/(authenticated)/`

## State Management

| State type | Tool | Location | Example |
| --- | --- | --- | --- |
| Server state (reads) | TanStack Query | Query cache | Run list, approvals, dashboard metrics |
| Server state (mutations) | TanStack Query mutations | Mutation cache | Approve action, update policy, connect repo |
| Form state | React Hook Form | Component-local | Policy editor, settings, onboarding |
| UI state | `useState` / `useReducer` | Component-local | Sidebar collapsed, modal open, selected tab |
| URL state | Next.js `searchParams` | URL | Filters, sort, pagination, active tab |
| Real-time state | WebSocket + query invalidation | Query cache | Live runs, approvals |
| Auth/session | NextAuth.js | Server + httpOnly cookie | User identity, workspace, role |

Rules:

- no Redux
- no Zustand
- no Jotai
- URL owns shareable UI state
- React local state owns component-local UI state

## Shared Types Strategy

- Import Zod schemas from `@agentgit/schemas`
- Infer TypeScript types from Zod schemas
- Define cloud-only entities in app-local schema files using the same Zod-first pattern
- Validate API route inputs with Zod
- Return `422` for invalid payloads with field-level errors

## Testing Strategy

| Layer | Tool | Coverage target | What to test |
| --- | --- | --- | --- |
| Unit | Vitest | `>=80%` of utils/hooks | Validation, formatting, status mapping, permission checks |
| Component | Vitest + Testing Library | All primitives + key composites | Loading/empty/error/data states, keyboard, ARIA |
| Integration | Vitest + MSW | All API hooks | Query hooks, mocked API behavior, optimistic rollback |
| E2E | Playwright | 5 priority journeys | Auth, navigation, mutations, WebSocket events |
| Visual regression | Playwright screenshots | Key screens | Dashboard, run detail, approval queue, policy editor |
| Accessibility | axe-playwright | All pages | Automated WCAG 2.1 AA checks |

## Performance Budgets

| Metric | Target | Tool |
| --- | --- | --- |
| LCP | `<1.5s` | Vercel Analytics |
| FID | `<50ms` | Vercel Analytics |
| CLS | `<0.05` | Vercel Analytics |
| Initial JS bundle | `<150KB gzipped` | Bundlemon in CI |
| Time to interactive | `<2s` on 4G | Playwright + throttling |
| WebSocket reconnect | `<3s` | Custom monitoring |

## Phased Delivery

| Phase | Duration | Deliverables | Ship criteria |
| --- | --- | --- | --- |
| 0: Foundation | 2 weeks | Token CSS file, Tailwind config, primitives, app shell, auth flow | All primitives pass component tests and visual regression baseline |
| 1: Core loop | 3 weeks | Dashboard, repo list/detail, run list/detail, action detail, approval queue, REST proxy, WebSocket integration | Journeys 1 and 2 pass E2E |
| 2: Governance | 2 weeks | Policy editor, snapshot list/restore, calibration dashboard | Journey 4 passes E2E |
| 3: Onboarding | 2 weeks | Onboarding stepper, repo connection flow, team management, notification settings | Journeys 3 and 5 pass E2E |
| 4: Polish | 2 weeks | Audit log, billing, all edge cases, accessibility audit, performance work, documentation | All pages pass axe and budgets are met |

Total estimate:

- 11 weeks from kickoff to production-ready
- does not include backend/infrastructure buildout
