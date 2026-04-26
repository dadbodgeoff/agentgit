# Live Production Gap Closure

Date: 2026-04-25
Branch: `codex/cloud-surface-prod-readiness`
Runner: local macOS workstation, `/Users/geoffreyfernald/Documents/agentgit`

## Decision

The local-first production-beta candidate is stronger after this pass, but this is still not a final public production signoff. The repo now proves required signed artifact packaging with local test keys, npm publish dry-runs for every public package, production readiness CLI execution, and fail-closed deployed-smoke behavior when no live origin is configured.

The remaining open items require external prerequisites that are not present on this machine: a live deployed origin, npm authentication for real publish, production release signing secrets, a healthy Docker engine, production cloud environment secrets, Stripe account configuration, and a real OAuth tenant.

## Completed In This Pass

| Item | Status | Evidence |
| --- | --- | --- |
| Required signed artifact pack | Passed with local throwaway signing key | `.release-artifacts/live-prod-closure-2026-04-25/pack-required.json` |
| Required signed artifact verification | Passed after deleting the private test key | `.release-artifacts/live-prod-closure-2026-04-25/verify-required-after-private-key-removal.json` |
| Public package local install smoke from signed artifacts | Passed for 14 public packages | `.release-artifacts/live-prod-closure-2026-04-25/smoke-public-packages-signed.json` |
| npm publish dry-run | Passed for 14 public package tarballs | `.release-artifacts/live-prod-closure-2026-04-25/npm-publish-dry-run-summary.tsv` |
| Cloud production readiness CLI | Fixed so it runs outside Next server-only imports | `pnpm --filter @agentgit/cloud-ui readiness` |
| Production missing-env gate | Fails closed in `NODE_ENV=production` for missing required production controls | `.release-artifacts/live-prod-closure-2026-04-25/cloud-readiness-production-missing-env.txt` |
| Missing deployed-origin guard | Fails closed with a specific `AGENTGIT_CLOUD_E2E_BASE_URL` requirement | `.release-artifacts/live-prod-closure-2026-04-25/deployed-smoke-without-url.txt` |
| Release artifact secret scan | Passed after deleting the private throwaway signing key | local `rg` secret-shaped scan over `.release-artifacts/live-prod-closure-2026-04-25` |

## Code Changes

- `apps/agentgit-cloud/src/lib/release/runtime-config.ts`
  - removed the CLI dependency on `@/lib/db/client`, which imports `server-only`
  - changed production Sentry DSN, Sentry source-map credentials, and Vercel analytics from warning-only to fail-level readiness checks
- `apps/agentgit-cloud/src/lib/release/runtime-config.cli.test.ts`
  - added regression coverage that the runtime summary can be imported from the CLI surface
- `apps/agentgit-cloud/src/lib/release/runtime-config.production.test.ts`
  - added production-mode readiness coverage for missing telemetry and analytics controls

## Still Blocked

| Item | Current result | What is needed |
| --- | --- | --- |
| Real deployed-browser smoke | Not run. No `AGENTGIT_CLOUD_E2E_BASE_URL` is configured. | Deploy AgentGit Cloud, then run `AGENTGIT_CLOUD_E2E_BASE_URL=<deployed origin> pnpm smoke:cloud-deployed`. |
| Real npm publish and registry install | Not run. `npm whoami` returns `E401 Unauthorized`. Dry-run publish passed. | Authenticate npm, publish intentionally, then install from the registry in a clean temp project. |
| Production release signing credentials | Not available in this shell. Local required-mode signing rehearsal passed with throwaway keys. | Configure `AGENTGIT_RELEASE_SIGNING_PRIVATE_KEY_PEM_B64` and `AGENTGIT_RELEASE_SIGNING_PUBLIC_KEY_PEM_B64` in the release environment. |
| Real Docker-contained execution on this PC | Not run. `docker version` reports `Server: null`, `EOF`; `docker info` hangs and times out after Docker Desktop restart attempt. | Repair Docker Desktop or use another healthy OCI host, then rerun `pnpm smoke:agent-runtime` and `pnpm smoke:agent-runtime-install`. |
| Production cloud readiness | Fails closed as expected with missing env. | Provide production `DATABASE_URL`, auth, Sentry, uptime, request metrics, and workspace-root configuration from the runbook. |
| Paid Stripe actions | Not run. No Stripe env is configured. | Configure Stripe test or production account and run checkout, portal, webhook, and invoice sync acceptance together. |
| Real customer OAuth tenant | Not run. No OAuth app or customer tenant credentials are configured. | Configure production GitHub OAuth and customer SSO tenant, then run tenant-backed sign-in and fail-closed admission tests. |
| Arbitrary unmanaged local shell capture | Not claimed. Harness-launched governed shell is qualified; unmanaged shell activity outside AgentGit is outside the current trust boundary. | Build an OS/container-level shell entrypoint or mandatory wrapper if beta scope needs capture of arbitrary shells not launched through AgentGit. |

## Release Stance

Safe claim: production-beta candidate for local-first, harness-launched autonomous agents, with signed-pack rehearsal and npm dry-run added.

Do not claim yet: public hosted production, real npm registry distribution, production Stripe billing, customer OAuth tenant readiness, or guaranteed capture of arbitrary unmanaged local shells.
