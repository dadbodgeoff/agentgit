import "server-only";

type Labels = Record<string, string>;

type CounterSample = {
  name: string;
  help: string;
  labels: Labels;
  value: number;
};

const counters = new Map<string, CounterSample>();

function labelKey(labels: Labels): string {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

function counterKey(name: string, labels: Labels): string {
  return `${name}{${labelKey(labels)}}`;
}

function incrementCounter(name: string, help: string, labels: Labels, value = 1): void {
  const key = counterKey(name, labels);
  const existing = counters.get(key);
  if (existing) {
    existing.value += value;
    return;
  }

  counters.set(key, {
    name,
    help,
    labels,
    value,
  });
}

function statusFamily(statusCode: number): string {
  if (statusCode >= 100 && statusCode < 600) {
    return `${Math.floor(statusCode / 100)}xx`;
  }
  return "unknown";
}

export function recordCloudApiResponse(statusCode: number): void {
  incrementCounter(
    "agentgit_cloud_api_responses_total",
    "Total AgentGit cloud API responses emitted by route helpers.",
    {
      status_code: String(statusCode),
      status_family: statusFamily(statusCode),
    },
  );
}

export function recordCloudRouteError(route: string): void {
  incrementCounter("agentgit_cloud_route_errors_total", "Total AgentGit cloud route errors captured.", {
    route,
  });
}

function escapeLabelValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function formatLabels(labels: Labels): string {
  const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return "";
  }
  return `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(",")}}`;
}

export function renderPrometheusMetrics(): string {
  const byMetric = new Map<string, CounterSample[]>();
  for (const sample of counters.values()) {
    const list = byMetric.get(sample.name) ?? [];
    list.push(sample);
    byMetric.set(sample.name, list);
  }

  const lines: string[] = [];
  for (const [metricName, samples] of [...byMetric.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`# HELP ${metricName} ${samples[0]?.help ?? metricName}`);
    lines.push(`# TYPE ${metricName} counter`);
    for (const sample of samples.sort((left, right) => labelKey(left.labels).localeCompare(labelKey(right.labels)))) {
      lines.push(`${sample.name}${formatLabels(sample.labels)} ${sample.value}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function resetMetricsForTest(): void {
  counters.clear();
}
