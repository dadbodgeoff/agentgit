# Production-Beta Overnight Qualification Plan

Status date: 2026-04-23

This is the operating contract for an autonomous overnight production-beta qualification run. The goal is not to collect a few green checks. The goal is to prove, with local packaged artifacts and browser-visible evidence, that the core product path is ready for real beta users except for explicitly deferred hosted deployment and npm publication.

## Release Question

Answer this by morning:

> Can this branch support a weekend production-beta release to real users, assuming hosting and npm publication are handled afterward through their own deploy/publish gates?

Valid final answers are:

- `ready for production-beta, with listed external deploy/publish caveats`
- `not ready, blocked by P0/P1 issues`
- `partially ready, with explicit skipped/untested surfaces and risk owner`

No final report may say `production ready` unless hosted deployment, deployed browser smoke, npm publication, and real release credentials were also tested.

## Scope

In scope:

- fresh-clone or clean-worktree setup
- dependency install and production builds
- packed local tarball artifacts
- installed CLI/runtime smoke
- authority daemon startup, restart, and compatibility paths
- snapshot creation, inspection, restore, and audit export
- cloud connector bootstrap, heartbeat, command pull, command ack, command retry, and event sync
- cloud UI production server clickthrough with populated data
- frontend screenshots/traces for every critical route
- RBAC, CSRF, secret redaction, path-denial, and fail-closed checks
- Docker/container containment when cleanly available
- Docker-unavailable fail-closed behavior when Docker is not cleanly available
- migration and upgrade simulation from previous persisted state
- recovery drills for bad actions and process restarts
- final release signoff report and evidence bundle

Out of scope unless explicitly provided before the run:

- real hosted deployment
- real deployed URL smoke
- real npm publish
- paid Stripe production actions
- real customer OAuth tenant changes
- destructive operations outside generated temporary workspaces
- modifying user files outside the repo or generated test roots

## Non-Stop Autonomy Rules

The agent should not stop overnight for ordinary failures. It should keep moving and preserve evidence.

Allowed autonomous actions:

- fix product bugs discovered by the qualification run
- fix test harness bugs when the harness is clearly wrong
- add missing E2E coverage for critical paths
- add deterministic seed data or fixtures
- rerun failed stages after a fix
- quarantine generated artifacts under an evidence directory
- skip a blocked lane only after recording the exact reason and continuing to the next lane

Hard stop conditions:

- a command would require real external credentials not already configured
- a command would spend money or mutate a real paid production account
- a command would delete or overwrite user data outside the repo or generated temp roots
- disk is too low to continue safely after generated-artifact cleanup
- the repo is in a merge conflict that cannot be resolved without choosing between unrelated user changes
- a required secret appears in logs, screenshots, traces, or generated evidence

Loop control:

- retry a failing command at most once before changing code or moving on
- retry a flaky browser assertion at most twice, then preserve trace and continue
- do not spend more than 45 minutes on one failing lane before recording it and moving to the next independent lane
- do not rerun the entire release gate repeatedly when a narrower failing stage can prove the fix first
- always end with one full `pnpm release:verify` after fixes, if time and disk allow

## Drift Controls

Before starting:

- record branch, commit, dirty status, Node version, pnpm version, Docker probe result, disk free space, and timestamp
- create a single evidence root:

```bash
mkdir -p .release-artifacts/overnight/$(date +%Y-%m-%d)
```

During the run:

- use generated temp workspaces for destructive tests
- keep all run logs, Playwright traces, screenshots, audit bundles, manifests, and final JSON summaries under the evidence root
- do not rely on existing local cloud DB/state unless the lane explicitly tests migration from old state
- prefer packed tarballs for installed-release lanes, not workspace imports
- use production Next build and `next start` for browser qualification
- do not silently update baselines unless the test measurement itself was broken; if a baseline changes, document the exact reason

Before final reporting:

- run `git status --short --branch`
- list every changed source/doc/test file
- list generated evidence directories
- verify no known generated evidence contains obvious secret-like values
- verify no critical process is left running unless intentionally reported
- state exactly which checks passed, failed, skipped, or were not attempted

## Test Matrix

### 1. Clean Setup

- [ ] create clean worktree or fresh clone
- [ ] run `pnpm install --frozen-lockfile`
- [ ] verify Node and pnpm satisfy repo baseline
- [ ] verify disk free space is sufficient
- [ ] record Docker clean probe result
- [ ] record initial git status

Pass criteria:

- install succeeds
- environment versions are recorded
- no hidden dependency on existing local build output

### 2. Repository Release Gate

- [ ] `pnpm lint`
- [ ] `pnpm format:check`
- [ ] `pnpm typecheck`
- [ ] `pnpm release:verify:claims`
- [ ] `pnpm security:audit`
- [ ] `pnpm test:coverage`
- [ ] `pnpm release:verify:coverage-ratchet`
- [ ] `pnpm py:test`
- [ ] `pnpm py:build`
- [ ] `pnpm release:pack`
- [ ] `pnpm release:verify:artifacts`
- [ ] `pnpm smoke:public-packages`
- [ ] `pnpm smoke:cli-install`
- [ ] `pnpm smoke:agent-runtime-install`
- [ ] `pnpm smoke:cli-compat`
- [ ] `pnpm smoke:cloud-hosted`

Pass criteria:

- full `pnpm release:verify` exits 0 after all fixes
- any moderate audit findings are listed but high/critical gates must remain green
- package artifacts verify by hash

### 3. Snapshot And Recovery Core

Use a generated temp workspace with known files.

- [ ] start authority daemon against generated config root
- [ ] register run
- [ ] submit safe read/list action
- [ ] submit governed mutating filesystem action
- [ ] create checkpoint/snapshot before mutation
- [ ] inspect timeline and confirm action appears
- [ ] mutate file contents through governed path
- [ ] restore snapshot
- [ ] verify file contents roll back exactly
- [ ] export audit bundle
- [ ] verify audit bundle
- [ ] restart daemon and confirm run/snapshot/audit state survives
- [ ] attempt restore over newer dirty work and verify non-destructive preview/fail-closed behavior
- [ ] attempt missing snapshot restore and verify useful error
- [ ] attempt outside-workspace path and verify denial
- [ ] attempt protected AgentGit config mutation and verify denial

Pass criteria:

- file rollback is proven by filesystem reads
- timeline and audit evidence match the actions taken
- denied paths do not mutate target files
- restart does not erase durable state

### 4. Runtime And Containment

Always test non-container runtime behavior. Test container runtime only when Docker passes the clean bounded probe.

- [ ] run generic attached runtime flow
- [ ] verify governed shell step is captured
- [ ] verify mutating shell subprocess pauses for approval
- [ ] verify failed launch does not persist a fake latest run
- [ ] if Docker available, run contained profile
- [ ] if Docker available, verify no host credential leakage by default
- [ ] if Docker available, verify brokered env/file secrets work
- [ ] if Docker available, verify blocked network policy
- [ ] if Docker available, verify allowlisted proxy egress
- [ ] if Docker unavailable, verify contained launch preflight fails closed and does not hang

Pass criteria:

- container availability is truthful
- no silent fallback from contained to host execution
- credentials are withheld unless explicitly brokered or allowlisted

### 5. Cloud Connector Sync

Use generated connector state and seeded cloud state.

- [ ] bootstrap connector
- [ ] register connector
- [ ] heartbeat connector
- [ ] publish event batch
- [ ] connect repository to workspace
- [ ] queue command from cloud
- [ ] pull command locally
- [ ] ack command locally
- [ ] retry failed command
- [ ] revoke connector and verify UI/API reflects stale/offline state

Pass criteria:

- connector state is durable
- commands have visible queued/running/completed/failed state
- stale connector state blocks unsafe approval/restore actions with specific recovery guidance

### 6. Production Frontend Clickthrough

Run against `pnpm --filter @agentgit/cloud-ui build` plus production server, not dev server.

For each route, capture screenshot after data is populated:

- [ ] public landing
- [ ] pricing
- [ ] docs
- [ ] sign-in
- [ ] onboarding
- [ ] dashboard
- [ ] repositories list
- [ ] repository detail
- [ ] run list
- [ ] run detail
- [ ] action detail
- [ ] approvals queue
- [ ] approval decision flow
- [ ] snapshots list
- [ ] snapshot restore modal/command flow
- [ ] connectors/fleet page
- [ ] integrations settings
- [ ] billing settings
- [ ] team settings
- [ ] workspace settings
- [ ] activity
- [ ] audit
- [ ] calibration/replay

Pass criteria:

- page loads without uncaught browser console errors
- page shows seeded real data, not empty placeholders unless the test intentionally verifies empty state
- primary buttons open, submit, disable, or fail closed correctly
- route-level loading states settle
- no serious or critical accessibility violations on core public and app routes
- screenshots and traces exist for failures

### 7. Error-State Clickthrough

- [ ] connector offline
- [ ] Docker unavailable
- [ ] restore denied
- [ ] unauthorized member attempting admin settings
- [ ] malformed connector command payload
- [ ] expired or invalid bootstrap token
- [ ] server restart during polling
- [ ] authority daemon unavailable
- [ ] workspace without persisted repository scope
- [ ] rate limit exceeded

Pass criteria:

- UI gives specific recovery reason
- API returns structured error
- no infinite spinner
- no silent success
- no cross-workspace data leak

### 8. Upgrade And Migration

Seed a previous-version-like state, then start current code.

- [ ] previous daemon config
- [ ] previous connector config/state
- [ ] previous cloud workspace settings
- [ ] previous audit bundle
- [ ] previous snapshot manifest
- [ ] previous run journal
- [ ] current code reads or migrates state
- [ ] unsupported state produces explicit compatibility error

Pass criteria:

- supported old state is not lost
- migrations are idempotent
- compatibility failures are explicit and recoverable

### 9. Observability And Security

- [ ] logs are structured enough to trace failed critical actions
- [ ] generated logs do not expose secrets
- [ ] frontend responses do not expose enterprise SSO client secret
- [ ] CSRF protection blocks write routes without token where applicable
- [ ] RBAC denial works at UI and API layers
- [ ] outside-workspace paths denied
- [ ] protected config paths denied
- [ ] audit trail exists for failed and denied critical operations
- [ ] security headers and CORS behavior match production expectation

Pass criteria:

- no secret leakage in API responses, screenshots, traces, or logs
- denied actions are auditable
- browser and API authorization agree

### 10. Performance Floor

This is not load testing. It is a sanity floor.

- [ ] production app starts within recorded threshold
- [ ] dashboard with seeded data loads within recorded threshold
- [ ] repo detail with runs loads within recorded threshold
- [ ] run detail loads within recorded threshold
- [ ] no runaway polling storm visible in browser/network trace
- [ ] no obvious orphaned daemon/Next processes after test cleanup

Pass criteria:

- timings are recorded
- no obvious user-blocking latency or process leak remains unreported

## Reporting Format

Create a final report at:

```text
engineering-docs/release-signoff/overnight/YYYY-MM-DD/REPORT.md
```

Required sections:

```markdown
# Production-Beta Overnight Qualification Report

Status: ready | not-ready | partial
Branch:
Commit:
Started:
Finished:
Runner:

## Executive Decision

One paragraph. No vague language.

## Passed

- ...

## Failed

- [P0/P1/P2] exact issue, evidence path, current status

## Skipped Or Not Tested

- exact lane
- reason
- release impact
- required follow-up

## Fixes Made During Run

- file paths
- behavior changed
- verification command

## Evidence

- release gate log
- Playwright report
- screenshots
- traces
- audit bundle
- artifact manifest
- git status

## Release Recommendation

ready | not-ready | partial

## Weekend Release Caveats

- hosted deployment status
- deployed smoke status
- npm publish status
- Docker/container status
- known moderate advisories
```

## Severity Rules

P0 blocks release:

- data loss in snapshot/restore
- restore mutates outside intended workspace
- secret leakage
- cross-workspace data exposure
- auth/RBAC bypass
- critical path cannot complete from UI
- release gate fails
- package install smoke fails
- audit trail missing for dangerous action

P1 should block weekend release unless explicitly accepted:

- connector command state wrong or invisible
- recovery path requires shell intervention for normal beta workflows
- Docker/containment silently falls back to host execution
- deployed smoke cannot run once a deployed URL exists
- migration loses non-critical state
- frontend core route has serious accessibility or interaction failures

P2 can ship with explicit note:

- copy polish
- non-critical empty state issue
- slow but usable page
- moderate audit advisory accepted by current high/critical gate
- optional route lacks screenshot evidence

## Conflict Handling

If local changes conflict with the qualification work:

- inspect the diff before editing
- do not revert user changes
- keep edits scoped to qualification, test, docs, and directly discovered bugs
- if a conflict is isolated and obvious, resolve it in favor of preserving user intent plus the production-readiness fix
- if a conflict requires product judgment, record it as blocked and move to the next independent lane
- never use `git reset --hard` or destructive checkout commands

If generated artifacts cause noise:

- keep source files untouched
- remove only ignored/generated directories such as `.next`, `coverage`, `test-results`, `playwright-report`, `.turbo`, and temporary evidence roots when cleanup is safe
- preserve evidence artifacts that are referenced by the final report

## No Premature Check-In Rule

Do not provide a final user-facing signoff until:

- every test matrix lane is passed, failed, skipped, or explicitly not attempted
- the final report exists
- git status is recorded
- evidence paths are recorded
- full `pnpm release:verify` has been run after the last code fix, unless time/disk failure is recorded as a blocker
- no required long-running test process is still active

Progress updates during the run should be sparse and factual. No early victory language.

## Open Decisions To Set Before Launch

These do not stop the overnight local qualification unless the user provides values:

- real hosted deployment target and URL
- npm publish timing and package access mode
- signing mode for real release artifacts
- Sentry project and alert ownership
- uptime monitor provider and monitor URL
- real OAuth app credentials
- Stripe beta mode versus real billing mode
- Docker Desktop or alternate OCI runtime requirement for beta users
- accepted moderate npm advisory risk owner

## Morning Acceptance Bar

The morning report is acceptable only if it tells the truth in this shape:

- `ready`: local packaged product and production frontend passed end to end; only explicitly external deploy/publish items remain
- `not-ready`: one or more P0/P1 items remain unresolved
- `partial`: core local product is usable, but named release risks require owner acceptance before real users

