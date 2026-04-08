export interface LatencyMetricSummary {
  count: number;
  sample_window: number;
  p50_ms: number | null;
  p95_ms: number | null;
  max_ms: number | null;
  target_ms: number;
  within_target: boolean | null;
}

export interface PolicyLatencyMetricsSnapshot {
  policy_eval_ms: LatencyMetricSummary;
  fast_action_ms: LatencyMetricSummary;
}

type LatencyMetricKey = keyof PolicyLatencyMetricsSnapshot;

interface LatencyMetricState {
  readonly targetMs: number;
  readonly samples: number[];
  count: number;
}

const MAX_SAMPLES_PER_METRIC = 512;

function createMetricState(targetMs: number): LatencyMetricState {
  return {
    targetMs,
    samples: [],
    count: 0,
  };
}

function percentile(sortedValues: number[], ratio: number): number | null {
  if (sortedValues.length === 0) {
    return null;
  }

  const index = Math.max(0, Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * ratio) - 1));
  return sortedValues[index] ?? null;
}

function summarizeMetric(state: LatencyMetricState): LatencyMetricSummary {
  const sortedSamples = [...state.samples].sort((left, right) => left - right);
  const p95 = percentile(sortedSamples, 0.95);

  return {
    count: state.count,
    sample_window: state.samples.length,
    p50_ms: percentile(sortedSamples, 0.5),
    p95_ms: p95,
    max_ms: sortedSamples.length > 0 ? sortedSamples[sortedSamples.length - 1] : null,
    target_ms: state.targetMs,
    within_target: p95 === null ? null : p95 <= state.targetMs,
  };
}

export class LatencyMetricsStore {
  private readonly metrics: Record<LatencyMetricKey, LatencyMetricState> = {
    policy_eval_ms: createMetricState(50),
    fast_action_ms: createMetricState(500),
  };

  private record(key: LatencyMetricKey, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      return;
    }

    const metric = this.metrics[key];
    metric.count += 1;
    metric.samples.push(Number(durationMs.toFixed(3)));
    if (metric.samples.length > MAX_SAMPLES_PER_METRIC) {
      metric.samples.shift();
    }
  }

  recordPolicyEvaluation(durationMs: number): void {
    this.record("policy_eval_ms", durationMs);
  }

  recordFastAction(durationMs: number): void {
    this.record("fast_action_ms", durationMs);
  }

  snapshot(): PolicyLatencyMetricsSnapshot {
    return {
      policy_eval_ms: summarizeMetric(this.metrics.policy_eval_ms),
      fast_action_ms: summarizeMetric(this.metrics.fast_action_ms),
    };
  }

  reset(): void {
    for (const metric of Object.values(this.metrics)) {
      metric.count = 0;
      metric.samples.length = 0;
    }
  }
}
