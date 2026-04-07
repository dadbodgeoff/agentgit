# 03. Screens, Content, And Data State

## Screen Templates

### Dashboard

- Row 1: 3-4 metric cards with icon, mono H2 value, label, sparkline
- Row 2: recent pipelines table with repo, branch, status, duration, triggerer, timestamp
- Row 3: 2-column grid
- Left: agent activity timeline
- Right: failing environments summary
- Data refreshes every 30s via polling/WebSocket
- Empty state points to onboarding

### Repository List

- Page title plus primary `Connect repository` button
- Filter bar with search, status, and sort
- Table columns: name, default branch, last pipeline status, last updated, agent status
- Empty state includes illustration and CTA

### Repository Detail

- Header: repo H1, org, status badge, Settings button
- Tabs: Overview, Pipelines, Branches, Agent Activity, Settings
- Overview uses `2fr 1fr` grid
- Pipeline rows can open a detail drawer
- Agent Activity uses a filterable vertical timeline

### Pipeline Detail

- Opens as 480px right drawer or full page via direct URL
- Header includes pipeline ID, status, duration
- Step list includes name, status icon, duration
- Step can expand a monospace log viewer with line numbers
- Retry button is secondary and appears for failed pipelines

### Environment Detail

- Header: environment H1 plus health badge
- Metric cards: uptime %, deploy count 30d, rollback count, last deploy
- Deploy history table
- Approval panel appears as a teal-bordered card
- Actions: Approve (lime) and Reject (destructive)

### Settings

- Two-column layout with left nav and right content panel
- Sections: General, Pipeline, Environments, Notifications, Integrations, Team, Billing
- Save button fixed to bottom bar, disabled until dirty

### Approval Queue

- Card list with action description, repo+branch, agent rationale, diff stats, timestamp
- Actions: Approve (lime), Reject (destructive), View diff (secondary)
- Empty state says the agent will notify when action is needed

### Audit Log

- Read-only table
- Columns: timestamp, actor, action type, target, IP, outcome
- Filter bar: date range, actor, action type, search
- Export CSV button

## Content Rules

### Capitalization

- Sentence case for headings, labels, buttons, tabs, nav items, tooltips, toasts, modals
- Exceptions: `AgentGit`, acronyms like `CI/CD/PR/SHA`, vendor names
- Never use Title Case in the product UI
- Never use ALL CAPS for emphasis

### Button Copy

| Action | Format | Examples | Anti-pattern |
| --- | --- | --- | --- |
| Create | Verb + noun | Create pipeline, Add environment | Submit, OK |
| Update | Save / Save changes | Save settings | Done, Apply |
| Delete | Delete + noun | Delete branch | Yes, Remove |
| Agent approve | Approve + noun | Approve merge | Accept, Confirm |
| Cancel | Cancel | Cancel | Never mind, Go back |

### Error Messages

Rule:

- two-part structure: what happened + what to do
- no exclamation marks
- include API error codes when relevant

| Context | Good | Bad |
| --- | --- | --- |
| Pipeline failure | Pipeline failed at step `test`. Check the build log. | Something went wrong! |
| Auth | Session expired. Sign in again. | Oops! You need to log in. |
| Validation | Branch name must be 3-63 characters. | Invalid branch name. |
| Network | Could not reach the server. Check your connection and retry. | Network error. |
| Permission | You don't have permission to deploy. Ask a workspace admin. | Access denied. |

### Empty State Copy

| Screen | Heading | Explanation | CTA |
| --- | --- | --- | --- |
| Repositories | No repositories connected | Connect a GitHub, GitLab, or Bitbucket repository. | Connect repository |
| Pipelines | No pipelines yet | Pipelines appear after your first commit. | View repositories |
| Approvals | No pending approvals | The agent will notify you when action is needed. | — |
| Search | No results found | Try a different term or adjust filters. | Clear filters |

### Date, Time, And Number Formatting

| Type | Format | Example | Notes |
| --- | --- | --- | --- |
| Date | `MMM DD, YYYY` | Apr 06, 2026 | Absolute after 7 days |
| Relative | `Xm/Xh/Xd ago` | 3m ago | Switch to absolute after 7d |
| Time | `HH:MM:SS` 24h | 14:32:07 | UTC unless user timezone is set |
| Duration | `Xh Ym Zs` | 2m 34s | Omit zero segments |
| Numbers | Comma-separated thousands | 1,234,567 | Mono font for data |
| Percentages | `N.N%` | 99.2% | One decimal max |
| Commit SHA | 7 chars | a3f82b1 | Mono and linked |

### Tooltip And Help Text

- Tooltips max 80 chars
- No formatting in tooltips
- 400ms delay
- Help text max 120 chars
- One sentence only
- Tooltips are never the sole carrier of critical information

## Data And State Contracts

### Entity Model

| Entity | Primary key | Display field | Status field | Parent |
| --- | --- | --- | --- | --- |
| Workspace | `workspace_id` | `name` | — | Organization |
| Repository | `repo_id` | `name (org/repo)` | `active` / `archived` | Workspace |
| Pipeline | `pipeline_id` | `#{id}` | `queued/running/passed/failed/canceled` | Repository |
| Step | `step_id` | `name` | `pending/running/passed/failed/skipped` | Pipeline |
| Environment | `env_id` | `name` | `healthy/degraded/down` | Workspace |
| Deployment | `deploy_id` | `version` | `pending/approved/deployed/rolled_back/rejected` | Environment |
| Agent Action | `action_id` | `action_type` | `pending/completed/failed/escalated` | Repository |
| Approval | `approval_id` | `summary` | `pending/approved/rejected/expired` | Agent Action |
| User | `user_id` | `display_name` | `active/deactivated` | Workspace |
| Audit Event | `event_id` | `action_type` | — | Workspace |

### Status-To-UI Mapping

| Status | Color token | Badge | Icon | Entities |
| --- | --- | --- | --- | --- |
| queued | `--ag-text-secondary` | neutral | Clock | Pipeline, Step |
| pending | `--ag-warning` | warning | Clock | Deployment, Approval |
| running | `--ag-warning` | warning (pulse) | Spinner | Pipeline, Step |
| passed | `--ag-success` | success | Check circle | Pipeline, Step |
| failed | `--ag-error` | error | X circle | Pipeline, Step, Action |
| deployed | `--ag-success` | success | Rocket | Deployment |
| approved | `--ag-success` | success | Check | Approval |
| rejected | `--ag-error` | error | X | Approval |
| escalated | `--ag-brand-lime` | agent | Alert triangle | Agent Action |
| healthy | `--ag-success` | success | Heart | Environment |
| degraded | `--ag-warning` | warning | Alert triangle | Environment |
| down | `--ag-error` | error | X circle | Environment |
| canceled/skipped | `--ag-text-muted` | muted | Minus | Pipeline, Step |
| expired | `--ag-text-muted` | muted | Clock | Approval |
| active | `--ag-success` | success | Check | Repo, User |
| archived | `--ag-text-muted` | muted | Archive | Repo, User |

Critical rule:

- `escalated` is the only status that uses lime

### Loading States

| State | UI treatment | Trigger |
| --- | --- | --- |
| Initial load | Skeleton placeholders matching layout shape | Mount until first response |
| Refresh | Subtle top progress bar with stale data remaining visible | Manual refresh, polling, mutation |
| Empty | Empty state, no skeletons | API returns 0 results |
| Error | Error banner plus retry button | API error |
| Stale | Normal render plus freshness label and refresh icon | Data older than 60s |

Additional rules:

- Skeletons must match expected content shape
- Minimum 3 rows for table skeletons
- Minimum 2 cards for card-grid skeletons
- Never use a full-page spinner

### Error Handling

| Error | HTTP | UI response | Retry |
| --- | --- | --- | --- |
| Auth failure | 401 | Redirect to sign-in, show `Session expired` toast | No |
| Permission | 403 | In-place error banner | No |
| Not found | 404 | Full-page 404 with back link | No |
| Validation | 422 | Field-level errors | Fix input |
| Rate limited | 429 | Toast plus auto-retry with backoff | Auto |
| Server error | 5xx | Error banner plus retry, preserve stale data | Manual |
| Network | timeout/0 | Error banner plus retry | Manual |

### Optimistic Updates

| Action | Optimistic | Rollback |
| --- | --- | --- |
| Toggle favorite | Yes | Revert icon plus toast |
| Delete | No | Wait for server |
| Update label | Yes | Revert text plus inline error |
| Approve deploy | No | Too high risk |
| Reorder items | Yes | Revert position plus toast |
| Create entity | No | Wait for server ID |

### Real-Time Data

- Pipeline status updates via WebSocket
- Agent activity prepends into the timeline
- Approval queue updates and notification dots are live
- Environment health updates live
- Other data may poll every 30s when visible and 120s when hidden
- Tab refocus triggers immediate refresh

### URL And State Sync

| State | Mechanism | Example |
| --- | --- | --- |
| Navigation | Route path | `/repos/acme/api-gateway/pipelines` |
| Tab selection | Query param | `?tab=agent-activity` |
| Filters | Query params | `?status=failed&branch=main` |
| Sort | Query params | `?sort=created_at&dir=desc` |
| Pagination | Query param | `?page=3&per_page=25` |
| Drawer target | Query param | `?detail=pipeline-4821` |
| Modal | Not in URL | Modal is transient |

Rules:

- Use `pushState`, no full reload
- Direct URL access must reconstruct current UI state

### Permissions And RBAC

| Level | UI treatment | Example |
| --- | --- | --- |
| Full access | Fully interactive | Admin sees all settings |
| Read-only | Data visible, actions hidden | Member sees logs but cannot retry |
| Restricted | Nav item disabled with tooltip | Member sees Billing greyed out |
| No access | Completely hidden | Guest cannot see audit log |

Rules:

- Never render a clickable action that will 403
- Restricted pages must show an explicit permission error, not a blank page
