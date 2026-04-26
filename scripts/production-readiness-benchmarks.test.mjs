import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateBenchmarkBudgets,
  percentile,
  summarizeSamples,
} from "./production-readiness-benchmarks.mjs";

test("percentile uses nearest-rank semantics for latency gates", () => {
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([10, 20, 30, 40], 95), 40);
  assert.equal(percentile([10, 20, 30, 40], 99), 40);
  assert.equal(percentile([], 99), null);
});

test("summarizeSamples emits the percentile fields SREs need", () => {
  assert.deepEqual(summarizeSamples([3.111, 1.111, 2.222]), {
    count: 3,
    min_ms: 1.11,
    p50_ms: 2.22,
    p95_ms: 3.11,
    p99_ms: 3.11,
    max_ms: 3.11,
  });
});

test("evaluateBenchmarkBudgets fails closed when a required metric is absent or over budget", () => {
  const results = evaluateBenchmarkBudgets(
    {
      latency: {
        snapshot_restore_ms: {
          p99_ms: 900,
        },
      },
      cold_start: {
        daemon_boot_ms: 200,
      },
    },
    {
      snapshot_restore_ms: { p99_ms: 800 },
      daemon_boot_ms: { max_ms: 1000 },
      action_submission_decision_ms: { p99_ms: 500 },
    },
  );

  assert.deepEqual(
    results.map((result) => ({ metric: result.metric, ok: result.ok })),
    [
      { metric: "snapshot_restore_ms", ok: false },
      { metric: "daemon_boot_ms", ok: true },
      { metric: "action_submission_decision_ms", ok: false },
    ],
  );
});
