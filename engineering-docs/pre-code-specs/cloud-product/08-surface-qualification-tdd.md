# 08. Surface Qualification TDD

Status date: 2026-04-08 (America/New_York)

Owner: AgentGit cloud/control-plane

Implementation status: partially complete in repo, with follow-up status updates recorded on the same branch as surfaces land. This document defines the concrete work needed to qualify six cloud surfaces that are implemented enough to demo, but not yet strong enough to call production-ready end to end.

## 1. Purpose

Define the production-readiness plan, implementation order, and signoff bar for:

- run replay
- snapshot restore UI
- enterprise SSO
- Stripe billing
- Slack webhook save-time validation
- calibration

This is a repo-native execution document.

It does not replace the cloud product specs.

It translates the existing specs into concrete qualification work against the code that exists in the repository on 2026-04-08.

## 2. Audit Summary

| Surface | Repo reality on 2026-04-08 | Qualification verdict |
| --- | --- | --- |
| Run replay | Hosted preview + queue routes exist, the run detail page already has a replay CTA, and the connector already executes `replay_run` locally. | Wiring exists. Qualification is incomplete. |
| Snapshot restore UI | Hosted snapshot inventory, preview, and execute controls exist, and the connector already executes `execute_restore` locally. | Wiring exists. Qualification is incomplete. |
| Enterprise SSO | Workspace settings UI, dynamic provider resolution, write-only secret storage, and membership resolution already exist. | Framework exists. Live qualification is incomplete. |
| Stripe billing | Honest hosted beta gate exists and plan limits are enforced. Env-gated live Stripe checkout, customer portal, webhook sync, and invoice sync now exist, with beta-gate fallback preserved when Stripe is disabled. | Implemented behind environment configuration; still needs full browser qualification in Stripe test mode. |
| Slack webhook test-on-save | URL format validation exists and manual test-notification exists. Save currently persists without live validation. | Partially implemented. |
| Calibration | Repo-scoped calibration report and recommendations exist. Threshold replay preview, patch/apply flow, and usable operator actions do not. | Partially implemented. |

## 3. Corrections To The Initial Gap List

The initial issue list was directionally useful, but some specific claims are now stale:

- Run replay already has a hosted UI button in `apps/agentgit-cloud/src/features/runs/run-detail-page.tsx`.
- Snapshot restore already has a hosted UI flow in `apps/agentgit-cloud/src/features/repos/repository-snapshots-page.tsx`; connector-side execution is correct by design and should remain connector-side.
- Enterprise SSO secrets are stored in `cloud_workspace_sso_secrets`, not `cloud_workspace_integration_secrets`. The integration-secrets table is for Slack webhook secrets.

The remaining work is therefore qualification depth and missing end-to-end behaviors, not first-pass scaffolding.

## 4. Production Law For These Surfaces

- Hosted UI may orchestrate connector work, but it must never imply the cloud executed local replay or restore itself.
- Placeholder operator controls are not production-ready. A CTA is either real, hidden, or explicitly unavailable.
- Secret rotation fails closed. A bad replacement secret must not erase the last known good secret.
- A surface is not qualified until the browser path, API path, persistence path, connector or daemon path, and observability path are all tested together.

## 5. Recommended Work Order

1. Run replay
2. Snapshot restore
3. Enterprise SSO
4. Slack webhook save-time validation
5. Calibration
6. Stripe billing

Rationale:

- Items 1 through 4 are already close enough that a focused qualification pass can finish them.
- Calibration needs new cloud routes and a real operator apply flow.
- Stripe is the only item that is truly absent rather than partial.

## 6. Run Replay

### Current State

- `GET` and `POST /api/v1/repositories/:owner/:name/runs/:runId/replay` already exist.
- The hosted run detail page already renders replay preview data and a queue CTA.
- The local connector already implements `replay_run` and returns replay metadata including `replayRunId`.

### Production Gaps

- Replay results are not surfaced explicitly in cloud activity, audit, and fleet summaries the way restore results are.
- Browser smoke does not click the hosted replay CTA or prove that the resulting replay run appears in the product.
- The happy path is implemented, but operator visibility is weaker than restore once the command leaves the run-detail page.

### Implementation Plan

- Add replay-specific summaries and titles in:
  - `apps/agentgit-cloud/src/lib/backend/workspace/activity-feed.ts`
  - `apps/agentgit-cloud/src/lib/backend/workspace/audit-log.ts`
  - `apps/agentgit-cloud/src/features/settings/connectors-fleet-page.tsx`
- Extend the run-detail replay success state so the operator can deep-link directly to the new replay run when `replayRunId` is available.
- Ensure live invalidation refreshes run detail and run history once replay completion syncs back into cloud state.

### Test Plan

- Unit tests for replay-specific activity and audit mapping.
- Route tests for preview, queue, and replay-result parsing.
- Playwright flow:
  - open run detail
  - review replay preview
  - queue replay from the hosted UI
  - simulate connector acknowledgement and completion
  - confirm the replay appears in fleet, activity, audit, and run history

### Exit Criteria

- Replay can be initiated from the hosted UI without a direct API call.
- The resulting command is visible and understandable in fleet, activity, and audit.
- The operator can navigate from the source run to the new replay run.
- Skipped imported or observed steps remain labeled honestly.

## 7. Snapshot Restore UI

### Current State

- The hosted snapshots page already supports preview and execute.
- Restore execution is correctly queued onto the connector instead of running in the cloud app.
- Restore command status and restored run or action links are partially surfaced on the snapshot detail panel.

### Production Gaps

- Browser smoke still drives restore through a direct API request instead of the hosted UI controls.
- The current qualification bar does not prove queued, running, completed, failed, and expired restore states from the hosted page.
- Post-restore operator feedback is still thinner than the rest of the repo's recovery story.

### Implementation Plan

- Convert smoke coverage from direct API restore execution to:
  - preview restore in the UI
  - execute restore in the UI
  - observe connector command lifecycle in the detail panel
- Enrich the restore detail panel with stronger follow-up guidance for failed or review-required outcomes.
- Ensure restored run and action links appear consistently when the connector returns them.

### Test Plan

- Unit tests for restore-command state mapping.
- Integration tests for restore result parsing and panel refresh.
- Playwright flow:
  - open snapshots page
  - select a verified snapshot
  - preview restore
  - execute restore from the hosted UI
  - simulate connector completion
  - verify updated command state, restored links, activity, and audit

### Exit Criteria

- Snapshot restore is exercised from the hosted page, not just the API.
- Operators can see the connector lifecycle from queued through completion or failure.
- Restored artifacts are navigable from the hosted UI.

## 8. Enterprise SSO

### Current State

- Workspace settings already expose enterprise SSO configuration.
- Dynamic NextAuth enterprise providers already resolve from workspace slug.
- Membership resolution already supports invited members, existing members, and domain-based auto-provision.
- Secrets are already write-only at the settings API boundary.

### Production Gaps

- Save-time validation is still too light; enabling a provider does not yet prove issuer metadata and callback viability.
- Browser qualification does not yet cover owner configuration plus actual SSO sign-in outcomes.
- The current pass has strong unit coverage, but not enough operator-level end-to-end coverage.

### Implementation Plan

- Add save-time issuer validation before allowing a provider to be enabled.
- Add an owner-facing verification affordance after save so the operator can confirm the generated provider id and callback path.
- Add end-to-end coverage for:
  - existing member sign-in
  - invited member sign-in
  - denied-domain sign-in
  - auto-provisioned allowed-domain sign-in

### Test Plan

- Unit tests for issuer validation and provider enablement rules.
- Route tests for settings save behavior with write-only secrets intact.
- Playwright or auth integration flow with a mocked OIDC provider:
  - save configuration
  - start sign-in from `/sign-in`
  - complete callback
  - verify workspace attachment or denial outcome

### Exit Criteria

- A workspace owner can configure SSO without leaking secrets.
- The sign-in flow succeeds for allowed identities and fails closed for disallowed identities.
- The browser path is covered, not just helper functions.

## 9. Slack Webhook Save-Time Validation

### Current State

- Slack webhook URL format is validated.
- Manual `test notification` delivery exists after save.
- Secrets are stored server-side and are not echoed back to the browser.

### Production Gaps

- Saving a new or rotated webhook does not validate deliverability before persistence.
- A bad replacement URL can currently become the stored secret even if delivery would fail.

### Implementation Plan

- Change the integrations save flow so a newly entered or rotated Slack webhook:
  - receives a lightweight validation delivery before persistence
  - only replaces the stored secret on success
  - returns a field-level save error on failure
- Keep the previous webhook active if validation fails.
- Surface the failure directly on the Slack webhook field and in the save rail.

### Test Plan

- Backend tests for:
  - successful rotation
  - failed rotation that preserves the previous secret
  - disable-Slack flow clearing the stored secret intentionally
- Route tests for field-scoped validation errors.
- Playwright flow saving both a valid and invalid webhook.

### Exit Criteria

- Invalid Slack webhook rotations fail closed.
- The previous webhook remains active after a failed rotation.
- Operators do not need a separate test-save dance to discover an invalid URL.

## 10. Calibration

### Current State

- Repo-scoped calibration metrics and recommendations already load from authority-backed contracts.
- The hosted page already shows metrics, bands, recommendations, and insufficient-data states.
- The current `Apply recommended thresholds` control is a disabled placeholder.

### Production Gaps

- No cloud route exists for threshold replay preview.
- No cloud mutation exists to render or apply a threshold patch into repository policy history.
- The page does not yet satisfy the product journey that promises replay preview before threshold changes.

### Implementation Plan

- Add authority-backed cloud endpoints for:
  - threshold replay preview
  - threshold patch rendering
  - policy apply via the existing repository-policy versioning flow
- Update the calibration page to support:
  - previewing recommendation impact
  - reviewing the generated threshold patch
  - applying the change as a new policy-history version
  - linking into policy history or audit after apply
- Remove the placeholder CTA behavior entirely once the real flow exists.

### Test Plan

- Backend tests for calibration replay-preview mapping.
- Integration tests for applying a threshold patch through repository policy versioning.
- Playwright flow:
  - open calibration
  - review recommendation and replay preview
  - apply thresholds
  - confirm policy history and audit entries update

### Exit Criteria

- Calibration supports a real operator loop from recommendation to replay preview to apply.
- Applied changes land in durable policy history.
- The hosted page contains no fake or placeholder actions.

## 11. Stripe Billing

### Current State

- The hosted beta gate is honest and already enforces plan limits.
- Pricing, docs, and billing now switch truthfully between hosted beta-gate copy and live Stripe state depending on environment configuration.
- Env-gated live Stripe checkout, customer portal, webhook ingestion, and invoice sync now exist in the repo.

### A0 Versus GA

For A0 hosted production, the honest beta gate is spec-compliant.

For near-complete hosted self-serve production, Stripe is the remaining missing billing system.

This TDD therefore treats Stripe as the path to remove the last manual sales and billing gap, not as a prerequisite to truthfully launch the current beta-gated product.

### Remaining Qualification Gaps

- Stripe test-mode browser coverage is still needed to exercise checkout, webhook delivery, and portal navigation as one real operator flow.
- Runtime and release checks should explicitly flag missing Stripe environment variables in environments that intend to run live billing.

### Implementation Plan

- Keep workspace billing identifiers and Stripe customer or subscription linkage in durable cloud state.
- Qualify the implemented flow in Stripe test mode from hosted UI through webhook sync.
- Preserve beta-gate fallback behavior whenever Stripe is disabled in the environment.
- Keep the billing page, pricing page, and docs page aligned with the actual runtime mode.

### Test Plan

- Backend tests for Stripe-to-workspace billing state transitions.
- Route tests for checkout, portal, and webhook entry points.
- Playwright flow with Stripe test mode:
  - start checkout
  - complete plan purchase or update
  - receive webhook
  - verify billing page state and invoice history
  - open customer portal

### Exit Criteria

- The workspace billing state is driven by live Stripe events when Stripe mode is enabled.
- Checkout, portal, and invoice history all work together.
- The product still falls back to the honest beta gate when Stripe is disabled.

## 12. Global Signoff Bar

Do not call these six items production-ready until all of the following are true:

- no stale issue statement in docs contradicts current repo reality
- every surface has a browser-covered happy path
- every connector-backed surface has visible queued, running, success, and failure states
- every secret-backed save path is write-only and fail-closed on invalid replacement
- activity, audit, and fleet views tell the same story as the page that initiated the action
- calibration contains no placeholder CTA
- billing is either live Stripe end to end or the hosted beta gate remains explicit everywhere

## 13. Immediate Deliverables

This document should drive the next implementation pass to produce:

- code changes for the six surfaces above
- updated smoke coverage for replay, restore, SSO, Slack validation, and calibration
- updated runbook verification steps
- removal of any remaining placeholder copy that overstates production readiness
