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
| `AUTH_BOOTSTRAP_USER_EMAIL` | Optional | Matches a bootstrap email identity | Useful for first-admin setup |
| `AUTH_BOOTSTRAP_GITHUB_LOGIN` | Optional | Matches a bootstrap GitHub login identity | Alternative to bootstrap email |
| `AUTH_WORKSPACE_ID` | Recommended | Default workspace id used by fallback auth paths | Should match the real workspace id |
| `AUTH_WORKSPACE_NAME` | Recommended | Default workspace display name | Used when workspace state has not been persisted yet |
| `AUTH_WORKSPACE_SLUG` | Recommended | Default workspace slug | Used when workspace state has not been persisted yet |

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

### Hosting Environment

| Variable | Required in production | Purpose | Notes |
| --- | --- | --- | --- |
| `VERCEL` or `VERCEL_ENV` | Required for the built-in analytics readiness check to pass | Indicates a Vercel deployment environment | If you do not deploy on Vercel, the readiness endpoint will remain in warning/failure state for analytics |

## Build And Deployment

Run the local verification chain before any production release:

```bash
pnpm install
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

The endpoint reports a status of `ok`, `warn`, or `fail` and includes checks for:

- auth secret availability
- GitHub provider configuration
- development credentials being disabled in production
- workspace root configuration
- Sentry runtime configuration
- Sentry source map upload configuration
- Vercel analytics environment readiness
- authority daemon readiness for the active workspace

Production expectations:

- `auth_secret` should be `ok`
- `github_provider` should be `ok`
- `dev_credentials` should be `ok` because production must not allow them
- `workspace_roots` should be `ok`
- `sentry_dsn` should be `ok`
- `sentry_source_maps` should be `ok`
- `vercel_analytics` should be `ok` if the deployment is on Vercel
- `authority_daemon` should be `ok` or, at minimum, investigated before launch if it warns

If any check is `fail`, do not treat the deployment as production-ready.

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
2. Build the cloud app and verify the build completes cleanly.
3. Start the app in a production-like mode.
4. Sign in as the initial admin or owner.
5. Check `GET /api/v1/health` and confirm the checks are either `ok` or known and accepted for the target environment.
6. Generate a connector bootstrap token.
7. Bootstrap one connector against one real workspace root.
8. Confirm the connector appears on the fleet page with an active heartbeat.
9. Confirm repository inventory and dashboard data load from real workspace state.
10. Exercise one safe governed action, such as a snapshot restore dry run or a harmless writeback command, and verify the action appears in activity and audit.
11. Confirm live updates refresh the relevant view without a manual reload.

## Do Not Ship If

- development credentials are enabled in production
- no real auth secret is configured
- GitHub OAuth is missing
- workspace roots are unspecified
- the authority daemon cannot respond for the active workspace
- Sentry runtime or source map configuration is missing
- the first connector cannot bootstrap and heartbeats do not appear in the fleet view

## Operator Notes

- Bootstrap tokens should be treated as one-time secrets.
- Connector tokens can be revoked from the fleet or integrations surface.
- If the active workspace changes, update the persisted workspace connection state before expecting repository and dashboard data to line up.
- If provider identity verification is unavailable, the cloud app can still run, but repo/provider drift warnings should be treated as a deployment signal, not ignored.
