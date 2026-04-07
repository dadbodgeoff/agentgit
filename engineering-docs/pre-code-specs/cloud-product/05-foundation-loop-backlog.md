# Foundation Loop Backlog

This file captures scaffolding issues that surfaced during implementation and the outcome of each pass so the codebase does not silently drift away from the pre-code specs.

## Closed In This Pass

- RBAC guard coverage now protects `/app/settings`, `/app/settings/billing`, `/app/onboarding`, and `/app/calibration`.
- Navigation now consumes role requirements so admin-only surfaces do not appear for lower roles.
- App Router error boundaries now exist at the root app level and the authenticated `/app` segment.
- React Hook Form plus Zod resolver wiring is now validated in-app through the workspace settings form.
- NextAuth now owns session resolution for the cloud app, with middleware redirects on `/app`, protected `/api/v1/*` handlers, and a real sign-in/out flow.
- The owner-only onboarding stepper now validates a five-step flow across workspace setup, repository selection, team invites, policy defaults, and launch.
- The owner-only billing route now validates plan selection, billing contacts, invoice history, and explicit save behavior on the same auth and settings rails.
- The admin-only integrations route now validates GitHub app health, notification channel configuration, and test-delivery mutation states.
- The approval inbox and approval decision routes now source real authority-daemon contracts instead of local fixture responses.
- Run detail now sources the authority timeline contract and maps projected steps into the cloud UI model.
- Repository inventory now sources real git metadata plus journal-backed latest run state instead of fixture rows.
- Dashboard now sources real workspace metrics, recent runs, and recent activity from repository inventory plus journal-backed latest run data.
- Onboarding now persists durable workspace connection state, including workspace naming, repository scope, invite drafts, and policy defaults.
- The authenticated app shell now resolves workspace identity from persisted onboarding state instead of hard-coded fallback copy.
- Repository detail and repository run history now source real backend contracts instead of route scaffolds.
- Production auth hardening now disables development credentials in production by default, validates provider and secret requirements at runtime, and keeps build-time fallbacks isolated to compilation only.
- Core cloud API routes now emit request correlation headers and structured error logs for production diagnostics.
- App and route error boundaries now log digest-aware client error breadcrumbs to support release debugging.
- Workspace settings now persist durably and stay aligned with onboarding-derived workspace identity fields.
- Billing now persists durable plan/contact state while deriving repository and seat usage from live workspace data.
- Integrations now persist durable delivery configuration and validate test notifications against saved workspace state.
- Critical settings and test-notification routes now have contract-level API tests in the cloud app test suite.
- The cloud app now exposes an admin-gated readiness probe at `/api/v1/health` for operator diagnostics.
- Calibration now resolves against repo-scoped authority contracts instead of fixture payloads, while preserving preview-state behavior for non-ready UI states.
- Team settings are now a real admin-managed roster and invite surface backed by durable workspace state instead of a scaffold placeholder.
- The cloud app now ships provider-backed telemetry rails through Sentry and Vercel Analytics, with readiness checks covering DSN, source-map upload credentials, and deployment environment.
- Browser-level authenticated smoke coverage now validates admin, owner, and member role flows against the live Next app using Playwright.
- Server-only SQLite-backed workspace packages now load native `better-sqlite3` bindings safely in the Next runtime, preventing cloud-state and run-journal initialization failures during live route execution.
- Repository policy is now a real admin-only governance surface with repo-scoped read, validate, and save contracts, durable `.agentgit/policy.toml` persistence, local effective-policy resolution, and browser smoke coverage for an end-to-end policy edit.
- Workspace-state fallback behavior now seeds repository scope from live inventory, preventing admin saves like team updates from unintentionally hiding every repository before onboarding has explicitly narrowed scope.
- Repository snapshots are now a real member-visible recovery surface with journal-backed inventory, manifest integrity checks, admin restore-plan and execute contracts, and authenticated smoke coverage against seeded snapshot state.
- Repository snapshot path matching now normalizes real filesystem paths, preventing valid `/var` versus `/private/var` workspace roots from being silently excluded on macOS.

## Next Up

- Replace the remaining placeholder product surfaces such as activity, audit, and action detail with real backend contracts.
- Add authority-daemon-backed live updates and reconnect handling so approvals, dashboard, and calibration data stay fresh without manual reloads.
- Tighten deployment hygiene by resolving the existing Next ESLint plugin configuration warning and the TypeScript project-references build warning.
