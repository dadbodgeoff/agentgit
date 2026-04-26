# Production-Beta Overnight Qualification Report

Status: ready
Branch: `codex/cloud-surface-prod-readiness`
Commit: `6974f009d8d96600c05295fa9f06d449b689e6be` plus uncommitted qualification hardening changes
Started: `2026-04-24T03:29:58Z`
Finished: `2026-04-24T04:35:30Z`
Runner: local macOS workstation, `/Users/geoffreyfernald/Documents/agentgit`

## Executive Decision

This branch is ready for production-beta qualification of the local packaged candidate, assuming hosted deployment and npm publication are handled afterward through their own gates. It is not a final public production signoff because no hosted origin, real npm registry publish, production signing credentials, paid Stripe actions, or real customer OAuth tenant were exercised.

## Passed

- Clean candidate setup passed in generated worktree `/Users/geoffreyfernald/Documents/agentgit-overnight-clean-20260423`: `pnpm install --frozen-lockfile` and full `pnpm release:verify` both exited 0 after applying the candidate diff. Evidence: `.release-artifacts/overnight/2026-04-23/logs/36-clean-worktree-install.log`, `.release-artifacts/overnight/2026-04-23/logs/38-clean-worktree-release-verify-after-turbo-fix.log`.
- Final primary-workspace release gate passed after the last infrastructure fix. Evidence: `.release-artifacts/overnight/2026-04-23/logs/39-final-primary-release-verify-after-turbo-fix.log`.
- Repository release gate passed: lint, format, typecheck, release claims, audit high/critical gate, coverage, coverage ratchet, Python tests/build, release pack, artifact verification, public package smoke, CLI install smoke, runtime install smoke, CLI compatibility, and hosted cloud smoke.
- Snapshot and recovery core passed through direct runtime integration: 27 integration tests covering checkpoints, restore, preview/fail-closed restore, governed shell capture, mutating shell approval pause, daemon restart survival, Docker-unavailable preflight, drift handling, and generic setup/run/demo/inspect/restore. Evidence: `.release-artifacts/overnight/2026-04-23/logs/03-runtime-snapshot-integration.log`.
- Cloud connector sync passed: bootstrap, register, heartbeat, event publish, command pull, command ack, retry, approvals, replay, durable outbox restart, and capability refusal paths. Evidence: `.release-artifacts/overnight/2026-04-23/logs/04-cloud-connector-sync.log`.
- Security and error-state regressions passed: RBAC fail-closed, CSRF, structured request-body errors, connector compatibility, migration state, workspace scope, malformed payloads, and error-state UI/API behavior. Evidence: `.release-artifacts/overnight/2026-04-23/logs/17-security-error-state-tests.log`, `.release-artifacts/overnight/2026-04-23/logs/18-runtime-migration-state-tests.log`, `.release-artifacts/overnight/2026-04-23/logs/19-connector-compatibility-tests.log`.
- Production frontend route matrix passed with populated seeded data: 24 screenshots, 0 browser console errors, 0 page errors, and no matrix failures. Evidence: `.release-artifacts/overnight/2026-04-23/reports/full-route-matrix.json`, `.release-artifacts/overnight/2026-04-23/screenshots/full-route-matrix/`.
- Authenticated Playwright smoke passed with traces for admin, owner, and member RBAC flows. Evidence: `.release-artifacts/overnight/2026-04-23/logs/16-authenticated-browser-evidence.log`, `.release-artifacts/overnight/2026-04-23/evidence/authenticated-smoke-output/`.
- Desktop and mobile browser evidence passed. Evidence: `.release-artifacts/overnight/2026-04-23/reports/ui-evidence.json`, `.release-artifacts/overnight/2026-04-23/reports/mobile-smoke.json`.
- Performance floor passed locally in production mode: `/sign-in` 200 in 30ms, `/api/v1/healthz` 200 in 5ms, `/` 200 in 10ms. Evidence: `.release-artifacts/overnight/2026-04-23/reports/performance-floor.json`.
- Evidence secret scan passed after removing a temporary patch artifact containing token-shaped test placeholders. Evidence: `.release-artifacts/overnight/2026-04-23/reports/secret-scan.txt`.

## Failed

- None. No unresolved P0 or P1 findings remain in the local production-beta qualification scope.

## Skipped Or Not Tested

- Real hosted deployment: no deployed origin exists. Release impact: public hosted launch still needs deploy gate. Required follow-up: deploy and run `AGENTGIT_CLOUD_E2E_BASE_URL=<deployed origin> pnpm smoke:cloud-deployed`.
- Real deployed-browser smoke: blocked by missing deployed origin. Release impact: cannot claim deployed cloud is production ready. Required follow-up: run deployed smoke against the live URL after hosting is up.
- Real npm publish and registry install: package artifacts were packed and installed locally, not published. Release impact: cannot claim registry distribution is proven. Required follow-up: npm dry-run or real publish plus install from registry.
- Required release signing mode: artifact verification ran with `--signature-mode allow-unsigned`; real signing credentials were not used. Release impact: public release should not ship unsigned unless owner accepts that mode. Required follow-up: configure release signing secrets and rerun artifact verification in required signed mode.
- Paid Stripe production actions: not run. Release impact: billing UI/API is beta-smoked, but real paid checkout/portal behavior needs Stripe-mode approval. Required follow-up: run Stripe production or test-mode billing acceptance with real configured account.
- Real customer OAuth tenant changes: not run. Release impact: dev credentials and mocked/provider-backed auth flows passed, but customer tenant onboarding needs its own acceptance. Required follow-up: tenant-backed auth smoke with production OAuth app credentials.
- Real Docker-contained execution on this PC: Docker CLI exists, but daemon probe returned `Server: null`, `EOF`, and `docker info` timed out. Release impact: contained mode correctly fails closed when Docker is unavailable, but a real-Docker user promise needs a healthy Docker host. Required follow-up: rerun contained install smoke on a healthy Docker Desktop or OCI runtime target.

## Fixes Made During Run

- `apps/agentgit-cloud/src/app/layout.tsx`: gated Vercel Analytics to deployed/explicitly-enabled environments and added favicon metadata. Verification: `pnpm --filter @agentgit/cloud-ui build`, route matrix, and final `pnpm release:verify`.
- `apps/agentgit-cloud/public/favicon.svg`: added favicon to remove missing icon browser noise. Verification: route matrix showed zero console/page errors.
- `.release-artifacts/overnight/2026-04-23/temp/capture-full-route-matrix.mjs`: added deterministic route-matrix harness for public, app, approval, snapshot, connector, settings, audit, activity, calibration, and RBAC surfaces. Verification: `.release-artifacts/overnight/2026-04-23/logs/34-full-route-matrix-rerun.log`.
- `turbo.json`: declared `test` task output `coverage/**` so cached clean release runs restore coverage summaries before the coverage ratchet. Verification: the first clean worktree gate failed in `.release-artifacts/overnight/2026-04-23/logs/37-clean-worktree-release-verify.log`; after the fix, clean and primary release gates passed in logs `38` and `39`.
- `engineering-docs/release-signoff/overnight/2026-04-23/REPORT.md`: replaced the earlier loose report with this required signoff format.

## Evidence

- Release gate, primary final: `.release-artifacts/overnight/2026-04-23/logs/39-final-primary-release-verify-after-turbo-fix.log`.
- Release gate, clean candidate worktree: `.release-artifacts/overnight/2026-04-23/logs/38-clean-worktree-release-verify-after-turbo-fix.log`.
- Clean install: `.release-artifacts/overnight/2026-04-23/logs/36-clean-worktree-install.log`.
- Earlier full release gate before late route-matrix/Turbo fixes: `.release-artifacts/overnight/2026-04-23/logs/02-release-verify.log`.
- Playwright authenticated traces: `.release-artifacts/overnight/2026-04-23/evidence/authenticated-smoke-output/`.
- Full route screenshots: `.release-artifacts/overnight/2026-04-23/screenshots/full-route-matrix/`.
- Desktop/mobile screenshots: `.release-artifacts/overnight/2026-04-23/screenshots/`.
- Route matrix JSON: `.release-artifacts/overnight/2026-04-23/reports/full-route-matrix.json`.
- Docker probe: `.release-artifacts/overnight/2026-04-23/reports/docker-probe.json`.
- Secret scan: `.release-artifacts/overnight/2026-04-23/reports/secret-scan.txt`.
- Artifact inventory: `.release-artifacts/overnight/2026-04-23/reports/artifact-inventory.txt`.
- Git status captured at run start: `.release-artifacts/overnight/2026-04-23/reports/environment.md`.

## Release Recommendation

ready

## Weekend Release Caveats

- Hosted deployment status: not deployed in this run.
- Deployed smoke status: not run because no live URL exists.
- npm publish status: not published; local tarball pack/install smokes passed.
- Docker/container status: Docker daemon on this PC is unhealthy; fail-closed behavior passed, but real-Docker contained execution should be proven on a healthy Docker host before promising arbitrary local shell containment to beta users.
- Known moderate advisories: `pnpm audit --audit-level=high --prod` passed with 9 moderate npm advisories still reported.
- Signing status: local artifact verification allowed unsigned artifacts; real public release should use required signing mode.

## Follow-Up Closure

The non-mutating local follow-up gates were revisited on 2026-04-25. Required-mode signing rehearsal, required-mode signature verification, signed-artifact install smoke, and npm publish dry-runs passed; deployed smoke, real npm publish, production signing credentials, healthy Docker-contained execution, Stripe, and tenant-backed OAuth remain blocked by missing external prerequisites.

Follow-up report: [Live Production Gap Closure](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/live-production-gap-closure-2026-04-25.md)
