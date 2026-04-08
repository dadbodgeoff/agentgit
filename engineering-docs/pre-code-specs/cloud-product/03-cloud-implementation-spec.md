# 03. Cloud Implementation Spec

## Scope

This document defines the cloud-product-specific implementation contracts that bridge the design system to actual frontend and API delivery.

Primary source:

- `/Users/geoffreyfernald/Downloads/AgentGit_Cloud_Implementation_Spec.docx`

## Product Boundary

AgentGit Cloud is a hosted GitHub-integrated layer on top of the local-first AgentGit governance daemon.

The cloud product adds:

- multi-repository oversight
- team-based approvals
- hosted dashboard and settings surfaces
- cloud relay between users and daemon-managed repos

## Route Map

Public routes:

- `/`
- `/pricing`
- `/docs`
- `/sign-in`
- `/sign-in/callback`

Public-route expectations:

- `/` must explain the hosted control-plane value proposition without implying that execution moved out of the local daemon
- `/pricing` must clearly separate the open-source local runtime from the hosted cloud product and must describe the current billing mode truthfully
- `/docs` must provide a real connector bootstrap and first-run validation quickstart rather than a placeholder documentation landing page

Authenticated routes:

- `/app`
- `/app/repos`
- `/app/repos/:owner/:name`
- `/app/repos/:owner/:name/runs`
- `/app/repos/:owner/:name/runs/:runId`
- `/app/repos/:owner/:name/runs/:runId/actions/:actionId`
- `/app/repos/:owner/:name/policy`
- `/app/repos/:owner/:name/snapshots`
- `/app/approvals`
- `/app/activity`
- `/app/audit`
- `/app/settings`
- `/app/settings/team`
- `/app/settings/billing`
- `/app/settings/integrations`
- `/app/onboarding`
- `/app/calibration`

Each route has a minimum-role requirement and should enforce it in both server-side and client-side UX.

## Priority User Journeys

The initial product loop centers on five journeys:

- review and approve an agent action
- investigate a failed run
- connect a new repository
- tune policy after calibration
- onboard a new team

These journeys are the primary E2E and UX acceptance baseline and should drive implementation ordering.

## API Contracts

### Authentication

- Bearer token via GitHub OAuth
- Session stored with httpOnly cookie handling
- Active workspace scoped by header or route context
- GitHub OAuth sessions must resolve workspace identity and role from persisted workspace membership data or an explicitly configured bootstrap identity; unresolved or ambiguous identities must be denied instead of falling back to a shared workspace
- bootstrap identity environment variables may only seed the first persisted owner and workspace; after bootstrap, hosted auth must resolve from persisted cloud data rather than a shared env-defined workspace
- Production auth must never assign a shared default workspace or elevated role when provider claims are incomplete
- Session TTL: 24 hours with silent refresh when appropriate

### REST API

Core endpoints include:

- dashboard summary
- repository list/detail/connect/disconnect
- run list/detail
- action detail and log access
- approvals list and approve/reject mutations
- policy get/update
- snapshots list/restore
- calibration report
- activity feed
- audit log

Rules:

- list endpoints use a consistent pagination envelope
- request and response shapes should be validated against shared Zod schemas
- invalid payloads return `400` with field-level information
- hosted approval queue reads must come from connector-synced control-plane state rather than direct cloud-to-daemon socket access
- hosted approve/reject mutations must enqueue connector commands that resolve the approval on the local daemon and sync the resulting resolution back into cloud state
- daemon-backed run-detail and readiness endpoints must initialize authority sessions from the active workspace's connected repository roots rather than process-wide roots
- Slack webhook secrets must be stored server-side and must never be echoed back through the integrations settings snapshot API
- `approval_requested` notifications are urgent and should fan out immediately through enabled channels even when digest cadence is set to `daily` or `weekly`
- authenticated workspace APIs must enforce per-IP and per-workspace rate limits, with stricter budgets for write traffic than for reads
- connector registration and sync endpoints must enforce per-IP and per-workspace quotas and return `429` responses with retry metadata when limits are exceeded
- rate-limit storage must prune expired buckets so abuse protection does not create unbounded persistence growth
- the cloud app must ship explicit browser security headers, including CSP and frame/type/referrer protections, through the platform config rather than relying on hosting defaults alone
- API routes must answer CORS preflight requests deterministically and only echo allowed origins; same-origin app traffic should continue working without a wildcard CORS policy
- the platform must expose a public uptime probe endpoint that is safe for external monitors and separate from the admin-only readiness route
- production readiness must fail until uptime monitoring, request-metrics ownership, and Sentry alerting are explicitly configured and acknowledged
- connector install guidance must provide a copy-ready bootstrap command, token-copy affordances, expiry context, and immediate feedback while waiting for the first connector heartbeat
- billing must ship either as a real Stripe-backed subscription flow or as an explicit hosted beta gate; the cloud UI must never present fake card collection or fake invoice history as if it were live billing
- while Stripe is deferred, the hosted beta gate must enforce the selected plan's seat and repository limits on mutating routes and surface approval-volume overages in the billing UI
- if a workspace has no persisted repository scope yet, hosted APIs must fail closed for tenant-bound inventory and dashboard data instead of exposing host-wide discovery results
- onboarding and repository-connect flows must only surface repositories that are either already attached to the active workspace or currently unclaimed by any other workspace
- workspace-team bootstrap and any other workspace fallback state must default to zero connected repositories rather than seeding visibility from host-wide discovery
- workspace-scoped repository detail, policy, snapshot, calibration, run, action-detail, and authority-backed queries must require an active workspace id all the way through the backend adapter boundary rather than accepting an optional scope
- approval queue projections must derive expiry from the workspace approval TTL and mark timed-out requests as `expired` without pretending a reviewer decision was delivered
- approval queue responses must surface connector availability and decision-delivery retry state so operators can distinguish between policy review, connector outage, and failed local delivery
- when the connector is missing, stale, revoked, or the latest heartbeat reports the local daemon offline, approval UX must warn before submission and mutating routes must return the specific recovery reason instead of a generic failure

### WebSocket

Workspace-scoped WebSocket events are used for:

- run start/completion
- action submission
- approval requested/resolved
- snapshot created
- policy updated

Client behavior should invalidate or refresh only the affected queries rather than forcing broad page reloads.

## Screen State Requirements

Every key page must define explicit handling for:

- loading
- empty
- error
- stale
- important special cases specific to the page

Normative examples already defined in the source include:

- dashboard
- run detail
- approval queue
- policy editor
- calibration dashboard

These states are not optional polish. They are part of the implementation contract.

## Frontend Stack

The normative frontend stack is:

- Next.js 15 with App Router
- TypeScript 5.x strict mode
- Tailwind CSS plus CSS custom properties
- custom component library built from the specs
- TanStack Query for server state
- React state for local UI state
- React Hook Form plus Zod for forms
- NextAuth.js with GitHub provider
- PostgreSQL plus Drizzle for cloud-owned state
- local filesystem persistence may remain available only as a development fallback when `DATABASE_URL` is absent; production readiness requires the PostgreSQL path

## Component Architecture

Three-layer structure:

- primitives
- composites
- features

Rules:

- primitives implement the shared visual and interaction contract
- composites encode reusable product patterns
- features own route-level data fetching and orchestration
- page features compose from primitives and composites instead of bypassing them

## State Strategy

- Do not introduce a global client state store by default
- TanStack Query owns server cache and mutation state
- URL owns shareable filter/sort/tab/pagination state
- local React state owns component-local UI state
- WebSocket updates flow into query invalidation and targeted refresh

## Shared Types

- Shared entity schemas come from `@agentgit/schemas`
- TypeScript types should be inferred from Zod where possible
- Cloud-only entities can live in app-local schema files but should follow the same Zod-first pattern

## Testing Requirements

Required test layers:

- unit
- component
- integration with mocked API responses
- E2E for the five priority journeys
- visual regression on key screens
- automated accessibility checks

The implementation is not complete when only the happy path works manually.

## Performance Budgets

Initial delivery should stay within explicit budgets for:

- LCP
- FID
- CLS
- initial bundle size
- time to interactive
- WebSocket reconnect time

Performance is a product requirement, not a post-launch clean-up task.

## Delivery Plan

Phased delivery baseline:

- phase 0: foundations
- phase 1: core loop
- phase 2: governance
- phase 3: onboarding
- phase 4: polish

Implementation work should map tickets and milestones back to these phases unless there is an explicit planning change.

## Operational Readiness And Deployment

The cloud product is not production-ready until the deployment and first-run path is validated end to end:

- production auth is configured with a real `AUTH_SECRET` or `NEXTAUTH_SECRET` and GitHub OAuth credentials
- development credentials are disabled in production
- `AGENTGIT_ROOT` and `AGENTGIT_CLOUD_WORKSPACE_ROOTS` point at the workspace roots the control plane should own
- the health endpoint reports `ok` for auth, provider, workspace roots, Sentry, source maps, Vercel analytics, and authority daemon readiness
- at least one admin or owner can sign in and generate a connector bootstrap token
- the connector CLI can bootstrap against the cloud endpoint and register the first workspace connector
- smoke coverage passes for sign-in, approvals, settings, fleet, snapshots, restore, and writeback flows

The authoritative deployment and first-run checklist lives in:

- `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/pre-code-specs/cloud-product/07-production-readiness-runbook.md`
