# 02. Page State Requirements

## Dashboard

| State | Treatment |
| --- | --- |
| Loading | 4 skeleton metric cards, 5 skeleton table rows, 2 skeleton timeline items |
| Empty (new workspace) | Full-page onboarding CTA with `Connect your first repository to get started.` |
| Empty (no recent runs) | Metric cards show zeros, table says runs appear after the next push |
| Error (API) | Error banner above metric cards, stale data shown if cached |
| Stale (>60s) | Normal render plus freshness label and refresh icon |

## Run Detail

| State | Treatment |
| --- | --- |
| Loading | Header skeleton plus 6 skeleton timeline items |
| Run not found | Full-page 404 with access/deletion explanation |
| Run in progress | Live timeline updates, spinner on active action, amber pulse badge |
| Run with 100+ actions | Show first 50, `Load more`, sticky jump-to-error link |
| Pending approval | Approval card pinned to top of timeline with Approve/Reject |
| Approval expired | Greyed-out expired approval card |
| Snapshot unavailable | Restore button disabled with tooltip |

## Approval Queue

| State | Treatment |
| --- | --- |
| Loading | 3 skeleton cards |
| Empty | `No pending approvals. The agent will notify you when your input is needed.` |
| Concurrent approval | Card animates out and flashes `Approved by [name]` |
| Expired approvals | Show at bottom, collapsed by default, toggle to reveal |
| Error on approve/reject | Inline card error, action button remains available |

## Policy Editor

| State | Treatment |
| --- | --- |
| Loading | Skeleton form fields |
| No custom rules | Read-only default policy display and `Add custom rule` CTA |
| Invalid rule | Inline validation plus disabled Save |
| Save conflict | Conflict banner naming the user who changed policy, block save |
| Dangerous change | Warning banner explaining over-permissive effect |

## Calibration Dashboard

| State | Treatment |
| --- | --- |
| Loading | Skeleton chart plus skeleton metric cards |
| Insufficient data | Explain minimum 50-action requirement and show progress bar |
| Good calibration | Green `Policy is well-calibrated.` status, no recommendations |
| Recommendations available | Recommendation cards with domain, threshold diff, and impact preview |

## General Rule

Every key page must define and implement:

- loading
- empty
- error
- stale
- important domain-specific special cases

These page states are part of the product contract, not optional polish.
