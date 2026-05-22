import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  recordCloudApiResponse,
  recordCloudRouteError,
  renderPrometheusMetrics,
  resetMetricsForTest,
} from "@/lib/observability/metrics";

describe("cloud metrics", () => {
  it("renders Prometheus counters with non-zero samples after route activity", () => {
    resetMetricsForTest();

    recordCloudApiResponse(200);
    recordCloudApiResponse(503);
    recordCloudRouteError("health_check");

    const metrics = renderPrometheusMetrics();

    expect(metrics).toContain("agentgit_cloud_api_responses_total");
    expect(metrics).toContain('status_family="2xx"');
    expect(metrics).toContain('status_family="5xx"');
    expect(metrics).toContain('agentgit_cloud_route_errors_total{route="health_check"} 1');
  });
});
