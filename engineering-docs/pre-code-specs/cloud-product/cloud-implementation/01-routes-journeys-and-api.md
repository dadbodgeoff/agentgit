# 01. Routes, Journeys, And API Contracts

## Product Boundary

AgentGit Cloud is a hosted GitHub-integrated layer on top of the AgentGit governance daemon. The OSS local-first daemon remains the core runtime; the cloud product adds:

- multi-repo oversight
- team-based approvals
- hosted dashboard
- managed governance without requiring users to run the daemon themselves

## Public Routes

| Route | Page | Purpose |
| --- | --- | --- |
| `/` | Landing | Marketing homepage |
| `/pricing` | Pricing | Plan comparison |
| `/docs` | Documentation | Public docs, separate subdomain in production |
| `/sign-in` | Auth | GitHub OAuth sign-in |
| `/sign-in/callback` | Auth callback | OAuth callback handler, no UI |

## Authenticated Routes

| Route | Page | Template | Min role |
| --- | --- | --- | --- |
| `/app` | Dashboard | Dashboard | member |
| `/app/repos` | Repository list | List | member |
| `/app/repos/:owner/:name` | Repo detail | Detail+tabs | member |
| `/app/repos/:owner/:name/runs` | Run list | Table | member |
| `/app/repos/:owner/:name/runs/:runId` | Run detail | Detail+timeline | member |
| `/app/repos/:owner/:name/runs/:runId/actions/:actionId` | Action detail | Detail | member |
| `/app/repos/:owner/:name/policy` | Policy editor | Settings form | admin |
| `/app/repos/:owner/:name/snapshots` | Snapshot list | Table | member |
| `/app/approvals` | Approval queue | Card list | member |
| `/app/activity` | Activity feed | Timeline | member |
| `/app/audit` | Audit log | Table (read-only) | admin |
| `/app/settings` | Workspace settings | Settings | admin |
| `/app/settings/team` | Team management | List+invite | admin |
| `/app/settings/billing` | Billing | Settings | owner |
| `/app/settings/integrations` | Integrations | Settings | admin |
| `/app/onboarding` | Setup wizard | Stepper | owner |
| `/app/calibration` | Calibration dashboard | Dashboard | admin |

## Priority Journeys

### Journey 1: Review And Approve An Agent Action (P0)

1. User receives a notification via email, Slack webhook, or bell icon.
2. User opens `/app/approvals` or the specific action URL.
3. Approval card shows repo, branch, action type, normalized action details, confidence score, policy rule, and diff preview.
4. User clicks `Approve` or `Reject`.
5. System sends the decision through the cloud relay to the daemon.
6. Toast confirms: `Action approved. The agent is continuing.`

Key edge cases:

- approval expires, default TTL 30 minutes
- agent session ends before approval
- concurrent approvals for same run
- user lacks permission to approve

### Journey 2: Investigate A Failed Run (P0)

1. Dashboard shows a failed run in the recent runs table.
2. User opens `/app/repos/:owner/:name/runs/:runId`.
3. Run detail shows full action timeline, failed action, policy decision, and execution output.
4. User expands failed action to read full log.
5. User may restore a snapshot if one exists.
6. User may navigate to policy editor for that repo.

Key edge cases:

- run has 100+ actions
- action log exceeds 64KB
- snapshot is stale or missing
- recovery plan is irreversible

### Journey 3: Connect A New Repository (P0)

1. User opens `/app/repos` and clicks `Connect repository`.
2. GitHub OAuth requests needed repo and webhook scopes if needed.
3. User picks repositories from a searchable multi-select.
4. For each repo, user configures policy pack, runtime binding, and notification channel.
5. AgentGit installs GitHub App webhook(s).
6. Confirmation screen explains when governance begins.

Key edge cases:

- user is not repo admin
- org-level GitHub App approval required
- repo already connected to another workspace
- webhook installation fails

### Journey 4: Tune Policy After Calibration (P1)

1. User opens `/app/calibration`.
2. Calibration dashboard shows Brier score, ECE, confidence bands, and error rates.
3. System proposes threshold adjustments and replay previews.
4. User adjusts sliders by domain.
5. User applies to one repo or all repos.
6. Policy change propagates to daemon instances.

Key edge cases:

- fewer than 50 actions available
- conflicting policies across repos
- change is overly permissive

### Journey 5: Onboard A New Team (P1)

1. New user signs in and opens `/app/onboarding`.
2. Step 1: create workspace.
3. Step 2: connect repositories.
4. Step 3: invite team and assign roles.
5. Step 4: configure default policy pack with preview.
6. Step 5: review and launch.
7. Dashboard loads with connected repos.

## Authentication Contract

- Bearer token via GitHub OAuth
- token stored as `httpOnly` cookie
- requests include `Authorization: Bearer <token>`
- session TTL: 24 hours
- silent refresh when tab is active
- workspace scoping via `X-Workspace-Id` header or URL prefix

## Core Endpoints

| Method | Endpoint | Description | Auth |
| --- | --- | --- | --- |
| GET | `/api/v1/dashboard` | Dashboard summary | member |
| GET | `/api/v1/repos` | List connected repositories | member |
| POST | `/api/v1/repos` | Connect repository | admin |
| GET | `/api/v1/repos/:repoId` | Repository detail plus stats | member |
| DELETE | `/api/v1/repos/:repoId` | Disconnect repository | admin |
| GET | `/api/v1/repos/:repoId/runs` | List runs for repo | member |
| GET | `/api/v1/runs/:runId` | Run detail with timeline | member |
| GET | `/api/v1/runs/:runId/actions/:actionId` | Action detail | member |
| GET | `/api/v1/runs/:runId/actions/:actionId/log` | Full execution log stream | member |
| GET | `/api/v1/approvals` | List pending approvals | member |
| POST | `/api/v1/approvals/:id/approve` | Approve a pending action | member |
| POST | `/api/v1/approvals/:id/reject` | Reject a pending action | member |
| GET | `/api/v1/repos/:repoId/policy` | Get active policy | member |
| PUT | `/api/v1/repos/:repoId/policy` | Update policy | admin |
| GET | `/api/v1/repos/:repoId/snapshots` | List snapshots | member |
| POST | `/api/v1/snapshots/:id/restore` | Restore snapshot | admin |
| GET | `/api/v1/repos/:repoId/calibration` | Calibration report | admin |
| GET | `/api/v1/audit` | Workspace-wide audit log | admin |
| GET | `/api/v1/activity` | Workspace-wide activity feed | member |

## Example Payloads

### `GET /api/v1/runs/:runId`

```json
{
  "id": "run_7f3a2b",
  "repo_id": "repo_abc123",
  "runtime": "claude-code",
  "status": "completed",
  "started_at": "2026-04-06T14:30:00Z",
  "ended_at": "2026-04-06T14:32:34Z",
  "action_count": 12,
  "actions_allowed": 9,
  "actions_denied": 1,
  "actions_asked": 2,
  "snapshots_taken": 3,
  "summary": "Refactored auth module. 12 actions, 2 required approval."
}
```

### `GET /api/v1/runs/:runId/actions/:actionId`

```json
{
  "id": "act_9d4e1f",
  "run_id": "run_7f3a2b",
  "sequence": 5,
  "domain": "filesystem",
  "operation": "write",
  "target": "src/auth/login.ts",
  "confidence": 0.72,
  "policy_outcome": "allow_with_snapshot",
  "matching_rules": ["default.filesystem.snapshot-below-0.8"],
  "snapshot_class": "exact_anchor",
  "snapshot_id": "snap_ab12cd",
  "execution": {
    "status": "success",
    "duration_ms": 45,
    "exit_code": null
  },
  "created_at": "2026-04-06T14:31:12Z"
}
```

### `GET /api/v1/approvals`

```json
{
  "items": [
    {
      "id": "appr_x8k2m",
      "run_id": "run_7f3a2b",
      "action_id": "act_b3f7e2",
      "repo": "acme/api-gateway",
      "branch": "feature/auth-refactor",
      "domain": "shell",
      "command": "rm -rf dist/ && npm run build",
      "confidence": 0.28,
      "matching_rule": "default.shell.ask-below-0.3",
      "requested_at": "2026-04-06T14:31:45Z",
      "expires_at": "2026-04-06T15:01:45Z",
      "status": "pending"
    }
  ],
  "total": 1
}
```

### `POST /api/v1/approvals/:id/approve`

Request:

```json
{
  "comment": "Approved - build step is expected."
}
```

Response:

```json
{
  "id": "appr_x8k2m",
  "status": "approved",
  "approved_by": "user_jsmith",
  "approved_at": "2026-04-06T14:32:01Z"
}
```

### `GET /api/v1/repos/:repoId/calibration`

```json
{
  "repo_id": "repo_abc123",
  "period": "30d",
  "total_actions": 847,
  "brier_score": 0.12,
  "ece": 0.08,
  "bands": {
    "high": {
      "min": 0.85,
      "count": 612,
      "accuracy": 0.97
    },
    "guarded": {
      "min": 0.65,
      "count": 178,
      "accuracy": 0.81
    },
    "low": {
      "min": 0.0,
      "count": 57,
      "accuracy": 0.42
    }
  },
  "recommendations": [
    {
      "domain": "shell",
      "current_ask_threshold": 0.3,
      "recommended": 0.35,
      "impact": "+12 more auto-allowed actions per week"
    }
  ]
}
```

## WebSocket Contract

Endpoint:

- `wss://app.agentgit.dev/ws?workspace={id}`

Events:

| Event type | Payload summary | Triggers UI update on |
| --- | --- | --- |
| `run.started` | `{ run_id, repo, runtime }` | Dashboard, run list |
| `run.completed` | `{ run_id, status, summary }` | Dashboard, run list, run detail |
| `action.submitted` | `{ action_id, run_id, domain, outcome }` | Run detail timeline |
| `approval.requested` | `{ approval_id, repo, action summary }` | Approval queue, notification bell |
| `approval.resolved` | `{ approval_id, status, resolved_by }` | Approval queue, run detail |
| `snapshot.created` | `{ snapshot_id, run_id, class }` | Snapshot list, run detail |
| `policy.updated` | `{ repo_id, changed_by }` | Policy editor, repo detail |

## Pagination Contract

All list endpoints return:

```json
{
  "items": [],
  "total": 312,
  "page": 1,
  "per_page": 25,
  "has_more": true
}
```

Rules:

- default `per_page`: 25
- max `per_page`: 100
- audit log may also support cursor pagination
