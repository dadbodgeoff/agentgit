# @agentgit/policy-engine

> **Internal package** — used by the agentgit daemon. Not published to npm.

Deterministic layered policy evaluation for agent actions. Takes a normalized `Action` and returns one of five outcomes: `allow`, `deny`, `ask`, `simulate`, or `allow_with_snapshot`. Rules are explicit and operator-configured — no opaque ML scoring.

---

## What It Does

Every action an agent submits passes through the policy engine before execution. The engine evaluates the action against a stack of layered policy rules and returns a `PolicyOutcome` that the daemon uses to decide what to do next:

| Outcome | Meaning |
|---------|---------|
| `allow` | Execute immediately |
| `deny` | Reject; surface reason to agent |
| `ask` | Block on operator approval before proceeding |
| `simulate` | Dry-run; describe what would happen but don't execute |
| `allow_with_snapshot` | Execute, but capture a rollback boundary first |

---

## Rule Types

### Trust rules
Confidence-based thresholds for each execution domain and side-effect level. Actions below the configured confidence threshold are escalated to `ask`.

```toml
[trust.filesystem.write]
min_confidence = 0.7
below_threshold = "ask"

[trust.shell.execute]
min_confidence = 0.8
below_threshold = "deny"
```

### Safe modes
Global overrides that apply regardless of per-domain rules:

```toml
[safe_mode]
enabled = true
mode = "simulate_all"   # or "ask_all", "allow_readonly"
```

### Budgets
Limits on operation counts or cumulative resource usage within a run:

```toml
[budgets.filesystem]
max_writes_per_run = 50
max_file_size_bytes = 10_000_000

[budgets.shell]
max_executions_per_run = 20
```

### Approval gates
Required approvals for specific action signatures:

```toml
[[approval_gates]]
domain = "mcp"
tool_name = "send_email"
require_approval = true
reason = "email sends are irreversible"
```

---

## Key Exports

```ts
import { PolicyEngine, PolicyPack } from "@agentgit/policy-engine";

const engine = new PolicyEngine({ configPath: "/path/to/policy.toml" });

// Evaluate a normalized action
const outcome = await engine.evaluate(action);
// → { outcome: "allow_with_snapshot", reason: "filesystem.write above threshold", confidence_used: 0.82 }

// Explain without executing (for CLI dry-run and calibration)
const explanation = await engine.explain(action);

// Load a policy pack (layered override)
const pack = PolicyPack.fromFile("/path/to/policy-override.toml");
const outcomeWithOverride = await engine.evaluate(action, { overlay: pack });

// Generate threshold recommendations from calibration history
const recommendations = await engine.getThresholdRecommendations({
  run_id: "run_abc",
  min_samples: 5,
  direction: "all",
});

// Replay candidate thresholds against journaled actions
const replay = await engine.replayThresholds({
  run_id: "run_abc",
  candidate_thresholds: { "filesystem.write": 0.75 },
});
```

---

## Policy Calibration Loop

The policy engine supports an evidence-based calibration loop for dialing in thresholds after real agent runs:

1. **`policy calibration-report`** — observe approval patterns and confidence quality for a run
2. **`policy recommend-thresholds`** — data-driven guidance on which thresholds to tighten or relax
3. **`policy replay-thresholds`** — test candidate thresholds against real journaled actions before rollout
4. **`policy diff`** — compare a candidate policy file against the current effective policy
5. **Manual edit** — operator reviews recommendations and edits `policy.toml`

**Important safety boundary:** recommendation, replay, and patch-render commands never mutate live policy. Threshold changes always require an explicit operator file edit.

---

## Configuration

Policy is loaded from `~/.agentgit/policy.toml` (or the path set by `AGENTGIT_POLICY_PATH`). The daemon merges multiple policy sources in layer order — later layers override earlier ones for the same rule keys.

---

## Related Packages

- [`@agentgit/action-normalizer`](../action-normalizer/README.md) — produces the `Action` records that the policy engine evaluates
- [`@agentgit/snapshot-engine`](../snapshot-engine/README.md) — called when outcome is `allow_with_snapshot`
- [`@agentgit/run-journal`](../run-journal/README.md) — policy outcomes are persisted here for calibration history
- [`@agentgit/schemas`](../schemas/README.md) — `PolicyOutcome` type definition
- [`@agentgit/authority-cli`](../authority-cli/README.md) — `policy show`, `policy explain`, `policy calibration-report`, `policy recommend-thresholds`, `policy replay-thresholds`, `policy diff`
