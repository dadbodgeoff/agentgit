# Policy Engine

The policy engine is the gatekeeper for every agent action. It evaluates normalized actions against operator-configured rules and returns a deterministic outcome. This page covers how to configure policy, understand outcomes, and use the calibration loop to tune thresholds over time.

---

## The Five Outcomes

| Outcome | What happens |
|---------|-------------|
| `allow` | Execute immediately |
| `deny` | Reject; reason surfaced to agent and logged |
| `ask` | Block on operator approval before proceeding |
| `simulate` | Dry-run; describe what would happen, don't execute |
| `allow_with_snapshot` | Capture a rollback boundary first, then execute |

Outcomes have a strength ranking. When multiple rules match, the strongest wins:
`deny` > `ask` > `allow_with_snapshot` > `simulate` > `allow`

---

## Policy Files

Policy is loaded from two files merged in order (workspace overrides global):

1. **Global:** `~/.config/agentgit/authority-policy.toml` (applies to all workspaces)
2. **Workspace:** `<project-root>/.agentgit/policy.toml` (project-specific overrides)

Override both with `AGENTGIT_POLICY_CONFIG_PATH` for a single merged source.

### Format

```toml
schema_version = "policy-config.v1"
profile_name = "my-workspace"

# Rules are evaluated in order; first match wins
# match fields: action_type, operation_domain, server_id, tool_name, ...
[[rules]]
match = { action_type = "filesystem.write" }
decision = "allow_with_snapshot"

[[rules]]
match = { action_type = "filesystem.delete" }
decision = "ask"

[[rules]]
match = { operation_domain = "shell" }
decision = "ask"

[[rules]]
match = { operation_domain = "mcp", server_id = "my-trusted-local-server" }
decision = "allow"

[[rules]]
match = { operation_domain = "mcp" }
decision = "ask"

[[rules]]
match = { operation_domain = "function" }
decision = "allow_with_snapshot"

# Low-confidence threshold overrides.
# Actions whose confidence score falls below these values get the
# decision from their matched rule (or "ask" if no rule matches).
[thresholds.low_confidence]
"filesystem.write" = 0.75
"filesystem.delete" = 0.90
"shell.execute" = 0.85
"mcp.call_tool" = 0.70
```

---

## Viewing Current Policy

```bash
agentgit-authority policy show
agentgit-authority --json policy show
```

---

## Validating a Policy File

```bash
agentgit-authority policy validate ./policy.toml
```

Returns errors with line numbers. Safe to run before deploying a change.

---

## Previewing Policy Without Executing

Test how a candidate action would be classified before running:

```bash
# Pass inline JSON
agentgit-authority --json policy explain '{
  "run_id": "run_abc",
  "tool_name": "write_file",
  "execution_domain": "filesystem",
  "raw_inputs": { "path": "/workspace/src/index.ts", "content": "..." },
  "workspace_roots": ["/workspace"]
}'

# Or from a file
agentgit-authority policy explain ./attempt.json
```

---

## The Calibration Loop

After real agent runs, you have data on which actions were approved, denied, or escalated. The calibration loop helps you translate that data into better thresholds.

### Step 1: Review the calibration report

```bash
agentgit-authority policy calibration-report
agentgit-authority policy calibration-report --run-id run_abc --include-samples --sample-limit 20
```

Shows approval patterns, confidence calibration quality, recovery linkage, and anomalies.

### Step 2: Get threshold recommendations

```bash
agentgit-authority policy recommend-thresholds --run-id run_abc --min-samples 5
```

Returns domain-level guidance like:
```
filesystem.write: current threshold 0.75
  → consider relaxing to 0.65 (12 of 14 approved; all successful)

shell.execute: current threshold 0.85
  → consider tightening to 0.92 (3 of 8 required recovery; all low-confidence)
```

### Step 3: Replay before rolling out

Test candidate thresholds against real historical actions without committing:

```bash
agentgit-authority policy replay-thresholds \
  --run-id run_abc \
  --candidate-policy ./policy-candidate.toml \
  --min-samples 5 \
  --direction all \
  --include-changed-samples \
  --sample-limit 30
```

Shows which actions would have had different outcomes under candidate thresholds.

### Step 4: Render a TOML patch

```bash
agentgit-authority policy render-threshold-patch --run-id run_abc --direction tighten
```

Outputs a TOML snippet to copy into `policy.toml`. Never applies automatically.

### Step 5: Diff your candidate

```bash
agentgit-authority policy diff ./policy-candidate.toml
```

Shows what changes relative to the current effective policy.

### Step 6: Manual edit and validate

Edit `~/.config/agentgit/authority-policy.toml` or `.agentgit/policy.toml`, then validate:

```bash
agentgit-authority policy validate ~/.config/agentgit/authority-policy.toml
```

**Safety boundary:** None of the recommendation, replay, or patch-render commands mutate live policy. Threshold changes always require a deliberate operator edit.

---

## Approval Workflow

When an action's outcome is `ask`, it creates an `ApprovalRequest` in the journal and blocks execution until resolved.

```bash
# See pending approvals
agentgit-authority list-approvals <run-id>
agentgit-authority approval-inbox <run-id> pending

# Approve
agentgit-authority approve <approval-id>
agentgit-authority approve <approval-id> "reviewed — path is within expected workspace"

# Deny
agentgit-authority deny <approval-id> "this path is outside expected scope"
```

Via TypeScript SDK:
```ts
const approvals = await client.listApprovals({ run_id: runId, status: "pending" });
await client.resolveApproval(approvals[0].approval_id, "approve", "reviewed, safe");
await client.resolveApproval(approvals[0].approval_id, "deny", "out of scope");
```

Via Python SDK:
```python
approvals = client.list_approvals(run_id=run_id, status="pending")
client.resolve_approval("apr_123", "approve", "reviewed")
client.resolve_approval("apr_123", "deny", "out of scope")
```

---

## How Confidence Works

Every action gets a confidence score (0.0–1.0) from the action normalizer. The score reflects how well-formed and predictable the action is, based on ~10 assessment factors including:

- Whether all required fields are present
- Whether the target path is within declared workspace bounds
- The side-effect level (destructive reduces confidence)
- Whether the scope is known and narrow vs. broad/unknown
- Provenance quality (well-identified agent vs. unknown)

The policy engine compares the action's confidence against the `[thresholds.low_confidence]` value for the matched rule's action family. Actions below the threshold still execute the matched decision — but the confidence information appears in the policy outcome and calibration reports.

---

## Related

- [Core Concepts: Policy](Core-Concepts.md#2-policy)
- [CLI Reference: policy commands](CLI-Reference.md#policy)
- [Configuration](Configuration.md) — policy file paths and format
