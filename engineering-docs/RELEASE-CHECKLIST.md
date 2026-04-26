# Release Checklist

Status date: 2026-04-25

Use this checklist before releasing public CLI/SDK packages.

## Automated Assertions (Must Be Green)

- [x] `pnpm release:verify`
- [x] signed artifact pack in required mode rehearsed with local throwaway keys
  Evidence: `.release-artifacts/live-prod-closure-2026-04-25/pack-required.json`
- [x] signed artifact verification in required mode rehearsed with local throwaway keys
  Evidence: `.release-artifacts/live-prod-closure-2026-04-25/verify-required-after-private-key-removal.json`
- [x] npm publish dry-run for all public package tarballs
  Evidence: `.release-artifacts/live-prod-closure-2026-04-25/npm-publish-dry-run-summary.tsv`
- [x] scope lock assertion on release notes/changesets (`pnpm release:verify:claims`)
- [x] production-beta overnight qualification report completed when preparing a real-user beta weekend release.
  Plan: [Production-Beta Overnight Qualification Plan](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/production-beta-overnight-qualification-plan.md)
  Report: [Production-Beta Overnight Qualification Report](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/2026-04-23/REPORT.md)
- [x] live production gap closure pass completed for non-mutating local gates.
  Report: [Live Production Gap Closure](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/live-production-gap-closure-2026-04-25.md)

## Manual Checks

- [x] Release notes do not claim hosted/cloud/browser/generic HTTP as shipped MVP features.
- [x] Recovery drill evidence artifact is attached to signoff.
  Evidence: [Recovery Drill Report](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/recovery-drills/2026-04-02-mvp-recovery-drill/REPORT.md)
- [x] Operator tabletop signoff evidence is attached.
  Evidence: [Operator Tabletop Report](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/operator-tabletop/2026-04-02-tamper-and-triage/REPORT.md)
- [ ] Production signing secrets configured for release workflow.
  Required secrets: `AGENTGIT_RELEASE_SIGNING_PRIVATE_KEY_PEM_B64`, `AGENTGIT_RELEASE_SIGNING_PUBLIC_KEY_PEM_B64`
- [ ] Real deployed-browser smoke passed against a live hosted origin.
  Required command: `AGENTGIT_CLOUD_E2E_BASE_URL=<deployed origin> pnpm smoke:cloud-deployed`
- [ ] Real npm publish and clean registry install passed.
- [ ] Real Docker-contained runtime smoke passed on a healthy Docker or OCI host.
- [ ] Production cloud readiness passed with real auth, database, telemetry, uptime, metrics, and workspace-root configuration.
- [ ] Stripe checkout, portal, webhook, and invoice sync passed with the intended account mode, or billing remains beta-gated.
- [ ] Customer OAuth or enterprise SSO tenant-backed sign-in acceptance passed.

## Signoff Record

- Release readiness owner: `release-engineering`
- Security owner: `security-owner`
- Operations owner: `operations-owner`
- Signoff date: `2026-04-25`
- Status: `Approved for local-first production-beta candidate; public hosted production signoff still blocked by unchecked manual gates`
