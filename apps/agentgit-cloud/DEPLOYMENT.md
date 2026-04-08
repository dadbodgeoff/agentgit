# AgentGit Cloud Deployment

## Prerequisites

- Node `24.14+` and `pnpm 10.33+` for bare-metal deploys
- Docker if you want the container path
- A managed PostgreSQL database for `DATABASE_URL`
- A GitHub OAuth app for user sign-in
- A persistent filesystem path or mounted volume for the workspace roots and local fallback state
- An external uptime monitor that can probe `GET /api/v1/healthz`

## Environment Setup

1. Copy [`.env.example`](/Users/geoffreyfernald/Documents/agentgit/apps/agentgit-cloud/.env.example) into your secret manager or local env file.
2. Fill the required production values:
   - `AUTH_SECRET`
   - `AUTH_URL`
   - `NEXTAUTH_URL`
   - `AUTH_GITHUB_ID`
   - `AUTH_GITHUB_SECRET`
   - `DATABASE_URL`
   - `AGENTGIT_ROOT`
   - `SENTRY_DSN`
   - `NEXT_PUBLIC_SENTRY_DSN`
3. Keep `AUTH_ENABLE_DEV_CREDENTIALS=false` and `AUTH_ALLOW_DEV_CREDENTIALS_IN_PRODUCTION=false`.
4. If the app must inspect more than one workspace path, set `AGENTGIT_CLOUD_WORKSPACE_ROOTS` to a comma-separated list of mounted absolute paths.

## Database Initialization

Run the cloud schema migration before the first production boot:

```bash
pnpm install
pnpm --filter @agentgit/cloud-ui db:migrate
```

The migration creates the durable cloud tables for users, workspaces, memberships, invites, billing, integrations, policy history, and rate limiting.

## Start The App

Bare metal:

```bash
pnpm install
pnpm --filter @agentgit/cloud-ui build
pnpm --filter @agentgit/cloud-ui start
```

Docker:

```bash
docker build -f apps/agentgit-cloud/Dockerfile -t agentgit-cloud .
docker run --rm -p 3000:3000 \
  -e AUTH_SECRET=replace-me \
  -e AUTH_URL=http://localhost:3000 \
  -e NEXTAUTH_URL=http://localhost:3000 \
  -e AUTH_GITHUB_ID=replace-me \
  -e AUTH_GITHUB_SECRET=replace-me \
  -e DATABASE_URL=postgres://user:password@host:5432/agentgit_cloud?sslmode=require \
  -e AGENTGIT_ROOT=/workspace \
  -e AGENTGIT_CLOUD_WORKSPACE_ROOTS=/workspace \
  -e SENTRY_DSN=https://examplePublicKey@o0.ingest.sentry.io/0 \
  -e NEXT_PUBLIC_SENTRY_DSN=https://examplePublicKey@o0.ingest.sentry.io/0 \
  -v /absolute/path/to/workspace:/workspace \
  agentgit-cloud
```

## First-User Bootstrap

1. Set `AUTH_BOOTSTRAP_USER_EMAIL` or `AUTH_BOOTSTRAP_GITHUB_LOGIN`.
2. Set `AUTH_WORKSPACE_ID`, `AUTH_WORKSPACE_NAME`, and `AUTH_WORKSPACE_SLUG` for the initial workspace.
3. Start the app and sign in with the matching GitHub identity.
4. That first sign-in seeds the persisted workspace and owner membership.
5. After the first owner exists, keep the bootstrap variables only as an emergency recovery mechanism, not as the steady-state identity model.

## Connector Registration Walkthrough

1. Sign in as an admin or owner.
2. Open the connector or integrations surface and generate a bootstrap token.
3. On the workspace machine, run:

```bash
agentgit-cloud-connector bootstrap \
  --cloud-url https://cloud.example.com \
  --workspace-id ws_acme_01 \
  --workspace-root /absolute/path/to/workspace \
  --bootstrap-token agcbt_... && \
agentgit-cloud-connector run \
  --workspace-root /absolute/path/to/workspace
```

4. Confirm the connector appears in the fleet page and that `GET /api/v1/healthz` stays `ok` or `warn`.
5. Validate the first real loop: connector heartbeat, repository sync, approval queue visibility, and command round-trip.

## Verification Checklist

- `pnpm --filter @agentgit/cloud-ui typecheck`
- `pnpm --filter @agentgit/cloud-ui test`
- `pnpm --filter @agentgit/cloud-ui build`
- `pnpm --filter @agentgit/cloud-ui test:smoke`
- `GET /api/v1/healthz` returns `200`
- `GET /api/v1/health` returns only expected `ok` or accepted `warn` checks for the target environment

## Troubleshooting

- `AUTH_SECRET or NEXTAUTH_SECRET must be set in production`
  Set `AUTH_SECRET` to a real random secret and restart the process.

- `At least one production authentication provider must be configured`
  Ensure `AUTH_GITHUB_ID` and `AUTH_GITHUB_SECRET` are both present.

- `DATABASE_URL must be set before running migrations`
  Provision Postgres first; migrations are not supported against the local fallback store.

- Health shows `warn` for `cloud_database`
  Verify `DATABASE_URL` connectivity, SSL requirements, firewall rules, and that the migration completed.

- Health shows `warn` for `authority_daemon`
  Check that the workspace root is mounted correctly and the authority socket is reachable at the expected path.

- Connector bootstrap succeeds but no events appear
  Leave `agentgit-cloud-connector run` running, verify outbound HTTPS access to the cloud URL, and confirm the fleet page shows a recent heartbeat.
