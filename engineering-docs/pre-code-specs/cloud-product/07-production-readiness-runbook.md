# 07. Production Readiness Runbook

## Scope

This runbook describes how to deploy AgentGit Cloud, validate the deployment, bootstrap the first connector, and confirm the first production run.

AgentGit Cloud is a hosted control plane over a local-first governance system. It is not a Git replacement. Git remains the durable source-control backbone, while AgentGit owns approvals, snapshots, audit, recovery, connector orchestration, and governed writeback.

## Deployment Model

The cloud app expects four things before it should be considered production-ready:

- a real OAuth provider, currently GitHub
- a real session secret
- workspace roots the control plane is allowed to inspect
- a reachable authority daemon for the active workspace

The app is built from a Next.js production build and then started with `next start` or the equivalent hosting platform runtime.

## Required Environment

### Authentication

| Variable | Required in production | Purpose | Notes |
| --- | --- | --- | --- |
| `AUTH_SECRET` or `NEXTAUTH_SECRET` | Yes | Signs NextAuth sessions | Must be strong and unique |
| `AUTH_GITHUB_ID` | Yes | GitHub OAuth client id | Enables production sign-in |
| `AUTH_GITHUB_SECRET` | Yes | GitHub OAuth client secret | Enables production sign-in |
| `AUTH_ENABLE_DEV_CREDENTIALS` | No, should be `false` | Enables local-only credential sign-in | Must not be enabled in production |
| `AUTH_ALLOW_DEV_CREDENTIALS_IN_PRODUCTION` | No, must be absent or `false` | Emergency override for test-only environments | Do not use in real production |
| `AUTH_DEFAULT_WORKSPACE_ROLE` | Recommended | Default role for local or bootstrap paths | `member` is the safe baseline |
| `AUTH_BOOTSTRAP_WORKSPACE_ROLE` | Recommended | Role used when bootstrap identities are created | Usually `owner` |
| `AUTH_BOOTSTRAP_USER_EMAIL` | Optional but recommended for first launch | Matches a bootstrap email identity | Seeds the first persisted owner if no workspace membership exists yet |
| `AUTH_BOOTSTRAP_GITHUB_LOGIN` | Optional | Matches a bootstrap GitHub login identity | Alternative to bootstrap email |
| `AUTH_WORKSPACE_ID` | Recommended for first launch | Bootstrap workspace id | Used only to seed the first persisted workspace when auth bootstrap is needed |
| `AUTH_WORKSPACE_NAME` | Recommended for first launch | Bootstrap workspace display name | Used only during initial bootstrap |
| `AUTH_WORKSPACE_SLUG` | Recommended for first launch | Bootstrap workspace slug | Used only during initial bootstrap |

### Cloud Database

| Variable | Required in production | Purpose | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection string for cloud-owned persistence | Required for durable users, workspaces, memberships, invites, settings, billing, and integrations |

### Billing Mode

Until Stripe is implemented, production should run the hosted beta gate rather than a fake payment flow:

- the billing UI may collect owner contacts and plan intent, but it must not imply that a real card processor is active
- plan enforcement must happen on seat and repository growth paths
- approval usage should be visible in billing so operators can spot overages before widening access

### Workspace And Runtime

| Variable | Required in production | Purpose | Notes |
| --- | --- | --- | --- |
| `AGENTGIT_ROOT` | Yes | Base path for cloud state storage and workspace discovery | Must point at the AgentGit workspace root |
| `AGENTGIT_CLOUD_WORKSPACE_ROOTS` | Yes when more than one root is managed | Explicit list of workspace roots the cloud app is allowed to inspect | Comma-separated absolute paths |
| `AGENTGIT_CLOUD_LOG_LEVEL` | Recommended | Controls cloud app logging verbosity | `info` is a safe default |
| `AGENTGIT_GITHUB_TOKEN` or `GITHUB_TOKEN` | Optional but recommended | Verifies GitHub repository identity from the provider API | Not required for app startup, but useful for drift detection |

### Telemetry

| Variable | Required in production | Purpose | Notes |
| --- | --- | --- | --- |
| `SENTRY_DSN` | Yes | Runtime error reporting | The app should not ship without this in production |
| `NEXT_PUBLIC_SENTRY_DSN` | Yes | Client-side telemetry | Usually the same DSN as `SENTRY_DSN` |
| `SENTRY_AUTH_TOKEN` | Yes for source map uploads | Uploads source maps during build | Needed for production release hygiene |
| `SENTRY_ORG` | Yes for source map uploads | Sentry organization | Must match the release project |
| `SENTRY_PROJECT` | Yes for source map uploads | Sentry project name | Should be the cloud UI project |
| `SENTRY_TRACES_SAMPLE_RATE` | Recommended | Server-side Sentry tracing sample rate | `0.1` is a safe production default |
| `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` | Recommended | Client-side trace sample rate | Keep aligned with server intent |
| `NEXT_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE` | Optional | Browser replay capture for error sessions | Higher values increase cost |
| `NEXT_PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE` | Optional | Baseline browser replay capture | Usually `0` or a small percentage |
| `AGENTGIT_SENTRY_ALERTS_CONFIGURED` | Yes | Explicit release gate confirming Sentry alert rules are live | Set only after real alert rules are created in Sentry |
| `AGENTGIT_REQUEST_METRICS_PROVIDER` | Yes | Declares request-metrics ownership | Supported values: `vercel`, `datadog` |
| `DD_API_KEY` or `DATADOG_API_KEY` | Required when using Datadog metrics | Datadog ingestion credential | Not needed when provider is `vercel` |
| `AGENTGIT_UPTIME_MONITOR_URL` | Yes | Dashboard or monitor URL for the external uptime check | Point the monitor itself at `GET /api/v1/healthz` |

### Hosting Environment

| Variable | Required in production | Purpose | Notes |
| --- | --- | --- | --- |
| `VERCEL` or `VERCEL_ENV` | Required for the built-in analytics readiness check to pass | Indicates a Vercel deployment environment | If you do not deploy on Vercel, the readiness endpoint will remain in warning/failure state for analytics |
| `AGENTGIT_CLOUD_ALLOWED_ORIGINS` | Recommended when browsers outside the primary app origin must call API routes | Comma-separated CORS allowlist for API routes | Same-origin requests are always allowed; do not use `*` in production |

## Build And Deployment

Run the local verification chain before any production release:

```bash
pnpm install
pnpm --filter @agentgit/cloud-ui db:migrate
pnpm --filter @agentgit/cloud-ui typecheck
pnpm --filter @agentgit/cloud-ui test
pnpm --filter @agentgit/cloud-ui build
pnpm --filter @agentgit/cloud-ui test:smoke
```

For a local production-like start:

```bash
pnpm --filter @agentgit/cloud-ui build
pnpm --filter @agentgit/cloud-ui start
```

## Health And Readiness

The production readiness check lives at `GET /api/v1/health` and requires an admin session.
The public uptime probe lives at `GET /api/v1/healthz` and is intended for Better Stack, Checkly, or an equivalent external monitor.

The endpoint reports a status of `ok`, `warn`, or `fail` and includes checks for:

- auth secret availability
- GitHub provider configuration
- development credentials being disabled in production
- workspace root configuration
- Sentry runtime configuration
- Sentry source map upload configuration
- Vercel analytics environment readiness
- uptime monitoring readiness
- request-metrics ownership
- Sentry alerting acknowledgement
- authority daemon readiness for the active workspace

Production expectations:

- `auth_secret` should be `ok`
- `github_provider` should be `ok`
- `dev_credentials` should be `ok` because production must not allow them
- `workspace_roots` should be `ok`
- `sentry_dsn` should be `ok`
- `sentry_source_maps` should be `ok`
- `vercel_analytics` should be `ok` if the deployment is on Vercel
- `uptime_monitoring` should be `ok`
- `request_metrics` should be `ok`
- `sentry_alerts` should be `ok`
- `authority_daemon` should be `ok` or, at minimum, investigated before launch if it warns

If any check is `fail`, do not treat the deployment as production-ready.

Before launch, also validate abuse controls directly against production or a production-like environment:

- authenticated API requests should return `429` with retry headers once per-IP or per-workspace quotas are exceeded
- connector registration should throttle repeated attempts from one source and from one workspace
- connector sync traffic should be budgeted tightly enough to block abuse without delaying normal heartbeat, event ingest, or command pull loops
- browser responses should include the expected CSP and security headers, and CORS preflight requests should only succeed for intended origins
- the external uptime monitor should alert on a `503` from `/api/v1/healthz`
- onboarding and repository-connect screens should not show repositories already claimed by another workspace
- tenant-scoped routes should return empty or `404` responses, not host-wide data, when the active workspace has no persisted repository scope
- authority-backed workspace routes should warn or fail closed when no workspace-scoped repository roots can be derived instead of silently falling back to process-wide roots

## Connector Bootstrap

The first connector is bootstrapped from an admin session in the cloud UI.

### Cloud Side

1. Sign in as an admin or owner.
2. Open the integrations or connector management surface.
3. Generate a bootstrap token from `POST /api/v1/sync/bootstrap-token`.
4. Treat the returned bootstrap token as a short-lived secret.

### Local Side

Use the connector CLI from the workspace root or from a machine that can access the workspace:

```bash
agentgit-cloud-connector bootstrap \
  --cloud-url https://cloud.example.com \
  --workspace-id ws_acme_01 \
  --workspace-root /Users/me/code/agentgit \
  --bootstrap-token agcbt_...
```

The connector stores its state database by default at:

```text
.agentgit/state/cloud/connector.db
```

After bootstrap, the connector should be able to:

- register its repository and workspace state
- send heartbeats
- publish event batches
- pull queued commands
- acknowledge command execution

## First Production Run

Use this checklist for the first real workspace:

1. Confirm the production environment variables are set.
2. Run the cloud database migration against the production database.
3. Build the cloud app and verify the build completes cleanly.
4. Start the app in a production-like mode.
5. Sign in as the initial admin or owner.
6. Check `GET /api/v1/health` and confirm the checks are either `ok` or known and accepted for the target environment.
7. Generate a connector bootstrap token.
8. Bootstrap one connector against one real workspace root.
9. Confirm the connector appears on the fleet page with an active heartbeat.
10. Confirm repository inventory and dashboard data load from real workspace state.
11. Exercise one safe governed action, such as a snapshot restore dry run or a harmless writeback command, and verify the action appears in activity and audit.
12. Confirm live updates refresh the relevant view without a manual reload.
13. Confirm approval or sync-heavy workflows still complete inside the expected latency budget after rate limiting is enabled.
14. Confirm seat and repository growth paths return clear `409` responses when the selected hosted beta plan would be exceeded.
15. Confirm the external uptime monitor succeeds against `/api/v1/healthz` and that Sentry alert rules and request-metrics dashboards are live.

## Do Not Ship If

- development credentials are enabled in production
- no real auth secret is configured
- no real PostgreSQL database is configured
- GitHub OAuth is missing
- workspace roots are unspecified
- the authority daemon cannot respond for the active workspace
- Sentry runtime or source map configuration is missing
- API and connector abuse controls are disabled or unverified
- billing still shows fake processor state instead of an explicit Stripe integration or hosted beta gate
- uptime monitoring, request metrics, or Sentry alerting are unconfigured
- the first connector cannot bootstrap and heartbeats do not appear in the fleet view

## Operator Notes

- Bootstrap tokens should be treated as one-time secrets.
- Connector tokens can be revoked from the fleet or integrations surface.
- If the active workspace changes, update the persisted workspace connection state before expecting repository and dashboard data to line up.
- If provider identity verification is unavailable, the cloud app can still run, but repo/provider drift warnings should be treated as a deployment signal, not ignored.
