import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { GET } from "./route";
import { recordCloudApiResponse, resetMetricsForTest } from "@/lib/observability/metrics";

describe("GET /api/v1/metrics", () => {
  it("requires the configured bearer token before returning metrics", async () => {
    vi.stubEnv("AGENTGIT_METRICS_BEARER_TOKEN", "metrics-token");
    resetMetricsForTest();

    const response = await GET(new Request("http://localhost/api/v1/metrics"));

    expect(response.status).toBe(401);
    vi.unstubAllEnvs();
  });

  it("returns Prometheus metrics with non-zero samples for authorized requests", async () => {
    vi.stubEnv("AGENTGIT_METRICS_BEARER_TOKEN", "metrics-token");
    resetMetricsForTest();
    recordCloudApiResponse(200);

    const response = await GET(
      new Request("http://localhost/api/v1/metrics", {
        headers: {
          authorization: "Bearer metrics-token",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    await expect(response.text()).resolves.toContain("agentgit_cloud_api_responses_total");
    vi.unstubAllEnvs();
  });
});
