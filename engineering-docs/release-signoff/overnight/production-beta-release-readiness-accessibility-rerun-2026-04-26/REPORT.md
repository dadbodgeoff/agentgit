# Production Beta Qualification Report

Generated: 2026-04-26T22:08:07.564Z
Gate status: passed
Artifact root: /Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-accessibility-rerun-2026-04-26

## Suite Results

| Suite | Required | Status | Duration | Production implication |
| --- | --- | --- | --- | --- |
| accessibility | yes | passed | 37.2s | Cloud UI accessibility scan must pass with the configured violations budget. |

## Accessibility

- Suite id: `accessibility`
- Status: `passed`
- Required: yes
- Duration: 37.2s
- Command: `pnpm --filter @agentgit/cloud-ui build && pnpm --filter @agentgit/cloud-ui exec -- playwright test --config=playwright.config.ts accessibility.spec.ts`
- Summary: All commands completed successfully.
- Production implication: Cloud UI accessibility scan must pass with the configured violations budget.
- Artifacts:
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-accessibility-rerun-2026-04-26/accessibility/command-1.json`
  - `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/release-signoff/overnight/production-beta-release-readiness-accessibility-rerun-2026-04-26/accessibility/command-2.json`

