# Release Checklist

Status date: 2026-04-02

Use this checklist before releasing public CLI/SDK packages.

## Automated Assertions (Must Be Green)

- [x] `pnpm release:verify`
- [x] signed artifact pack in required mode
- [x] signed artifact verification in required mode
- [x] scope lock assertion on release notes/changesets (`pnpm release:verify:claims`)

## Manual Checks

- [x] Release notes do not claim hosted/cloud/browser/generic HTTP as shipped MVP features.
- [x] Recovery drill evidence artifact is attached to signoff.
  Evidence: [Recovery Drill Report](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/recovery-drills/2026-04-02-mvp-recovery-drill/REPORT.md)
- [x] Operator tabletop signoff evidence is attached.
  Evidence: [Operator Tabletop Report](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/operator-tabletop/2026-04-02-tamper-and-triage/REPORT.md)
- [x] Signing secrets configured for release workflow.
  Required secrets: `AGENTGIT_RELEASE_SIGNING_PRIVATE_KEY_PEM_B64`, `AGENTGIT_RELEASE_SIGNING_PUBLIC_KEY_PEM_B64`

## Signoff Record

- Release readiness owner: `release-engineering`
- Security owner: `security-owner`
- Operations owner: `operations-owner`
- Signoff date: `2026-04-02`
- Status: `Approved for local-first MVP release path`
