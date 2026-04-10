# AgentGit MVP-Readiness Test Report

**Date:** 2026-04-08
**Branch:** `claude/objective-germain` (worktree)
**Scope:** Full local→cloud loop, local-only real processes
**Verdict:** **NOT YET ready for MVP testing.** Two release-day regressions in commit `52c5d04` break the cloud's own e2e gate. Underlying loop machinery (daemon, sync API, connector round-trip, audit) **does work** when probed manually. Two additional real defects found.

---

## What Was Tested

| Step | Action | Result |
|---|---|---|
| 1 | `pnpm install` (frozen lockfile) | ✅ pass |
| 2 | `pnpm build` (turbo, all 24 packages) | ❌ → ✅ (one TS error fixed, four lint errors fixed) |
| 3 | `pnpm typecheck` (turbo, all 24 packages) | ✅ pass |
| 4 | `pnpm test` (turbo unit tests, 19/22 packages reached) | ⚠️ 18 pass, 1 real fail (`snapshot-engine`); 3 not run (`schemas`, `agent-runtime-integration`, `authority-daemon`) |
| 5 | `pnpm --filter @agentgit/cloud-ui test:smoke` (Playwright, full daemon→cloud loop) | ❌ all 3 tests fail at sign-in (HTTP 500) |
| 6 | Manual local→cloud loop probe (`next dev` + authority-daemon + curl) | ✅ end-to-end works: bootstrap → register → heartbeat → publish events → queue command → pull command → ack → audit |

---

## P0 Findings (block MVP gate)

### F1. Cloud `test:smoke` is broken in two ways by today's commit `52c5d04 "Harden cloud and runtime prod readiness"`

**This is the headline finding.** The cloud's own canonical e2e harness — the gate that proves the local→cloud loop works — has been broken since 6 hours ago by a single hardening commit.

#### F1a. Dev-credentials escape hatch removed without updating playwright config

`apps/agentgit-cloud/src/lib/auth/provider-config.ts` (current):
```ts
enableDevelopmentCredentials: process.env.AUTH_ENABLE_DEV_CREDENTIALS !== "false" && !isProductionAuth,
```

Previously had `|| process.env.AUTH_ALLOW_DEV_CREDENTIALS_IN_PRODUCTION === "true"`. The commit also added a top-level `throw` if that flag is `true` in production, so the override is no longer reachable at all.

**Why it matters:** `playwright.config.ts` runs `pnpm exec next start --hostname localhost --port 3112`, which forces `NODE_ENV=production`. With the override removed, all 3 smoke tests fail at the dev sign-in:

```
[auth][error] Error: Provider with id "development" not found. Available providers: [github].
Error: Development auth failed with 500
```

`apps/agentgit-cloud/e2e/authenticated-smoke.spec.ts:60` (`signInAs`).

**Fix options:**
- Add a CI-only env (e.g. `AUTH_E2E_ALLOW_DEV_CREDENTIALS=true`) honored in `provider-config.ts` and set in `playwright.config.ts`. Reject it in real production by checking it together with `VERCEL_ENV !== "production"` or similar.
- Or switch the e2e webServer from `next start` to `next dev` and accept the slightly weaker (non-prod-build) coverage. Less ideal because the smoke loses production-build assertions.

#### F1b. Bootstrap token moved from response body to header without updating the smoke test

`apps/agentgit-cloud/src/app/api/v1/sync/bootstrap-token/route.ts:25-33` strips `bootstrapToken` from the response body and returns it only via the `x-agentgit-connector-bootstrap-token` header. **The connector consumes this correctly**, but `e2e/authenticated-smoke.spec.ts:400-408` still reads it from the body:

```ts
const bootstrapPayload = (await bootstrapResponse.json()) as { bootstrapToken?: string; ... };
expect(bootstrapPayload.bootstrapToken).toBeTruthy();
```

So even if F1a were fixed, the admin smoke would fail at the connector-bootstrap step. The smoke needs to read the token from `bootstrapResponse.headers().get("x-agentgit-connector-bootstrap-token")`.

**Both regressions live in the same commit (`52c5d04`).** That commit hardened the production cloud surface but did not update or run the e2e harness.

---

## P1 Findings (real bugs but not smoke-blockers)

### F2. `snapshot-engine` low-disk handling on layered commits is silently ungraded

`packages/snapshot-engine/src/index.test.ts:637-666` "surfaces low-disk layered snapshot commits as retryable storage failures" **fails**:

```
AssertionError: expected Error: expected low-disk workspace snapsh… to be an instance of AgentGitError
```

The metadata-only path correctly wraps `ENOSPC` from `fsPromises.copyFile` into `AgentGitError { code: "STORAGE_UNAVAILABLE", retryable: true }`. The **layered** path leaks a plain `Error`. Production callers in `run-journal` / `recovery-engine` cannot classify it as retryable storage pressure, so under disk pressure layered snapshots fail hard instead of triggering the retry/degradation logic the journal expects.

20/21 snapshot-engine tests pass. This is the only failing test.

### F3. Four ESLint errors blocking `next build` (cloud-ui) — three are real product gaps

`next build` runs ESLint as part of compile and fails on `@typescript-eslint/no-unused-vars`. The unused identifiers reveal three sibling stub helpers that should produce real values but return `null`/`undefined`:

| Location | Function | Current |
|---|---|---|
| `src/lib/backend/control-plane/connectors.ts:369` | `getCommandExternalUrl(command)` | `return null` |
| `src/lib/backend/workspace/activity-feed.ts:143` | `externalUrlForConnectorCommand(command)` | `return undefined` |
| `src/lib/backend/workspace/audit-log.ts:91` | `externalUrlForCommand(command)` | `return null` |

I confirmed the gap in the live audit log: `outcome: "success"`, `details: "Refresh complete via MVP probe."`, `externalUrl: null`. After `open_pull_request` / `push_branch` / `create_commit` succeed and the connector reports a GitHub URL in `result`, the cloud audit log + activity feed + connector fleet view will never surface the link, even though the data is in the connector's ack payload.

The fourth lint error (`sanitizeExternalUrl` unused import in `integrations-settings-page.tsx:22`) is dead-code from a refactor and is safe.

I applied the **minimum** patches to unblock build (cast in SDK, prefix-with-`_` on stubs, drop dead import). All four are noted in the diff section below.

### F4. `@agentgit/authority-sdk` TS error blocking `pnpm build` (fixed)

`packages/authority-sdk-ts/src/index.ts:303` — `validatePolicyConfig(config: unknown)` assigns `unknown` directly into `ValidatePolicyConfigRequestPayload.config: JsonValue`. TS 6.0 rejects this; the daemon Zod-validates downstream so a cast is acceptable but the public SDK signature should ideally be `JsonValue` end-to-end.

I applied a minimal cast at the assignment site (`config: config as ValidatePolicyConfigRequestPayload["config"]`) to unblock the build. **Better fix:** change the parameter type to `JsonValue` so consumers see a typed surface.

### F5. Connector events are accepted but not projected to `/api/v1/activity`

Manual probe: I successfully posted a `run.lifecycle` event via `/api/v1/sync/events` (HTTP 200, `acceptedCount: 1, highestAcceptedSequence: 1`), but `/api/v1/activity` afterwards still returned `items: []`. The activity feed reads from the **local journal at `$AGENTGIT_ROOT/.agentgit/state/authority.db`**, not from connector events. Same gap exists on the dashboard "Connected repositories" metric (still `0` even after a successful registration).

This may be **by design** (the playwright smoke seeds activity by writing to `RunJournal` directly, not via the sync API), but if so it's a hidden two-track architecture: connector events → fleet/audit only; local journal → activity/dashboard. An MVP user running `agentgit-cloud-connector run` would expect their local runs to flow into the cloud activity feed, and they currently won't unless the cloud has direct filesystem access to the same workspace root that the daemon writes.

This is the single most important architectural finding to validate with the design team before MVP.

### F6. Schema validation suite cannot run without Python `jsonschema`

`packages/schemas` test script is `python3 ../../engineering-docs/schema-pack/examples/validate_examples.py` which imports `jsonschema`. That package is not in any pinned Python requirements file in the repo. I installed it with `pip install --user jsonschema` to unblock; the release verify pipeline would fail on a clean machine. Either pin it in `scripts/audit-python-dependencies.mjs` / a `requirements.txt`, or vendor the validator.

### F7. Stale vitest zombie processes from prior CLI sessions held resources for hours

Not a code defect but a **test-harness reliability issue**. I found 9 zombie vitest workers from earlier Claude sessions (some 3+ hours old) — including one targeting `agent-runtime-integration/main.integration.test.ts` and one targeting `authority-daemon/server.integration.test.ts -t "surfaces hosted queue diagnostics..."`. These were holding sockets/temp dirs and made my fresh `pnpm test` run hang on the same integration tests until I killed them.

**Recommendation:** the integration tests should bind to **per-process unique** sockets/temp dirs (some already do) and the test runner / CI should always run with a hard timeout + cleanup hook. A `live:mvp:stop` style cleanup invoked from a vitest `afterAll` would prevent this from poisoning future runs.

---

## What Actually Works (Manual Loop Probe)

To get past F1 I booted the cloud in `next dev` mode and the daemon manually, then drove the full local→cloud loop with `curl`. Everything below was end-to-end exercised against real running processes:

| Step | Endpoint / Command | Result |
|---|---|---|
| Daemon boot | `node packages/authority-daemon/dist/main.js` | `status: listening` on Unix socket, journal + snapshot store opened |
| Daemon control plane | `authority-cli ping` | `session_id: sess_…`, full capability list returned |
| Daemon diagnostics | `authority-cli diagnostics daemon_health` | `status: healthy`, 0 active runs |
| Cloud unauth health | `GET /api/v1/healthz` | HTTP 200, 15 checks; auth/workspace/dev_credentials all `ok` |
| Cloud auth health | `GET /api/v1/health` | HTTP 200, **`authority_daemon` check is `ok`** — cloud↔daemon Unix-socket bridge verified |
| Dev sign-in | `POST /api/auth/callback/development` | HTTP 302 + valid JWT session cookie |
| Mint bootstrap token | `POST /api/v1/sync/bootstrap-token` | HTTP 200, token in `x-agentgit-connector-bootstrap-token` header (single-use) |
| Register connector | `POST /api/v1/sync/register` (Bearer token) | HTTP 200, `conn_…` issued, access token in `x-agentgit-connector-access-token` header, status `active` |
| Reuse bootstrap token | `POST /api/v1/sync/register` again | HTTP 401 "already been used" — single-use enforced ✅ |
| Heartbeat | `POST /api/v1/sync/heartbeat` (Bearer access) | HTTP 200, `pendingCommandCount: 0`, `lastSeenAt` updated |
| Publish events | `POST /api/v1/sync/events` (1×`run.lifecycle`) | HTTP 200, `acceptedCount: 1`, `highestAcceptedSequence: 1` |
| Admin lists connectors | `GET /api/v1/sync/connectors` (session cookie) | HTTP 200, registered connector visible with capabilities + lastSeenAt + provider identity |
| Admin queues command | `POST /api/v1/sync/connectors/{id}/commands` (`refresh_repo_state`) | HTTP 200, `cmd_…` returned, status `pending` |
| Connector pulls command | `POST /api/v1/sync/commands/pull` | HTTP 200, command returned with full payload + expiry |
| Connector acks command | `POST /api/v1/sync/commands/{id}/ack` (`status: completed`) | HTTP 200, status `completed` |
| Audit log reflects round-trip | `GET /api/v1/audit` | Single entry, `actorLabel: "AgentGit cloud connector"`, `outcome: success`, `details: "Refresh complete via MVP probe."` |
| Strict input validation | several intentionally bad payloads | Zod returned 400 with precise field errors — schemas are tight ✅ |

**The plumbing is real and the loop closes.** What's blocking MVP is the test harness regressions in F1 and the projection gaps in F5.

---

## Files I Modified

To unblock the build/lint chain and get to actual signal. All are minimal, isolated, and reversible.

| File | Change | Why |
|---|---|---|
| `packages/authority-sdk-ts/src/index.ts:303` | Cast `config as ValidatePolicyConfigRequestPayload["config"]` | TS 6.0 rejects `unknown → JsonValue`; fix unblocks all downstream builds. See F4 for better long-term fix. |
| `apps/agentgit-cloud/src/features/settings/integrations-settings-page.tsx:22` | Removed unused `sanitizeExternalUrl` import | Dead code from refactor; webhook URL is now Zod-validated on submit. |
| `apps/agentgit-cloud/src/lib/backend/control-plane/connectors.ts:369` | Renamed `command` → `_command` in `getCommandExternalUrl` stub | Suppresses lint while preserving F3 finding. |
| `apps/agentgit-cloud/src/lib/backend/workspace/activity-feed.ts:143` | Same for `externalUrlForConnectorCommand` | Same. |
| `apps/agentgit-cloud/src/lib/backend/workspace/audit-log.ts:91` | Same for `externalUrlForCommand` | Same. |

**I did NOT fix:**
- F1a, F1b — the auth + bootstrap regressions. These need a design call between hardening and test-coverage.
- F2 — the snapshot-engine low-disk wrapping bug. Real product fix; needs review.
- F5 — the activity feed projection gap. Architectural decision needed first.
- F6 — Python `jsonschema` dependency pinning.
- F7 — vitest test-harness cleanup discipline.

---

## Recommended MVP Gate Sequence

1. **Fix F1a + F1b** so the smoke harness comes back to green. This is the single most important step — without it, you have no automated proof the cloud loop works.
2. **Fix F2** before any user runs hit disk pressure. Even better: add a release-ratchet test that asserts every fs error path in `snapshot-engine` and `run-journal` wraps to `AgentGitError` with the correct `retryable` flag.
3. **Decide on F5**: either project connector events into the activity feed/dashboard, OR document loudly that activity reads only from the local journal and require connectors to share `$AGENTGIT_ROOT` with the cloud process.
4. **Pin F6** Python deps so `pnpm release:verify` is reproducible.
5. **Re-run** `pnpm release:verify` (which already chains `lint`, `format:check`, `typecheck`, `release:verify:claims`, `security:audit`, `test:coverage`, `release:verify:coverage-ratchet`, `py:test`, `py:build`, `smoke:cli-install`, `smoke:agent-runtime-install`, `smoke:cli-compat`) on a clean checkout.
6. After release-verify passes, **then** run `pnpm --filter @agentgit/cloud-ui test:smoke` and confirm all 3 specs are green.

Until at least steps 1–2 are done, **do not invite external MVP testers**: they will hit the auth wall on the smoke harness if they try to validate, and a disk-pressure event would corrupt their first impression of the recovery story.

---

## Test Environment

- **Worktree:** `/Users/geoffreyfernald/Documents/agentgit/.claude/worktrees/objective-germain` (branch `claude/objective-germain`)
- **Workspace under test:** `/tmp/agentgit-mvp-test/workspace`
- **Daemon runtime:** `/tmp/agentgit-mvp-test/runtime/{authority.sock,authority.db,snapshots,mcp/...}`
- **Cloud:** `next dev` on `http://localhost:3113`
- **Node:** v25.2.1, **pnpm:** 10.33.0
- **Logs:** `/tmp/agentgit-{daemon,cloud,smoke,typecheck,test,test3}.log`
